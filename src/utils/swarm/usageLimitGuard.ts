/**
 * Guard against teammates spinning on an account-wide usage limit.
 *
 * The failure this exists for: an out-of-usage 429 does NOT throw out of a
 * turn. `services/api/claude.ts` yields an assistant API-error message and
 * returns, so the turn reports success, the teammate parks itself idle, tells
 * the lead so, and immediately claims the next task — with no awaited delay on
 * the first poll of a fresh idle period. Each cycle costs one lead-bound
 * message and one wasted task, and the cycle runs at CPU speed because nothing
 * in it sleeps.
 *
 * Two properties matter and they pull in opposite directions:
 *
 * - The lead must be TOLD. Losing the signal is its own bug; the reset time is
 *   the genuinely useful part of the message.
 * - The lead must be told ONCE. The condition is account-wide, so every
 *   teammate hits it at the same moment and each would otherwise report it.
 *
 * Hence a module-level marker rather than per-runner state: in-process
 * teammates share a process, so one module scope covers every teammate without
 * IPC. `markCannotProceed` is what stops the spin; `shouldReportUsageLimit`
 * is what collapses N reports into one.
 *
 * Counting shape follows `query/toolFailureLoopGuard.ts` — a state object with
 * an explicit reset seam so tests drive it directly instead of through a
 * runner.
 */

import { isRateLimitErrorMessage } from '../../services/rateLimitMessages.js'
import type { Message } from '../../types/message.js'

type UsageLimitGuardState = {
  /**
   * The limit notice the account is currently stopped on, or undefined when
   * teammates are free to work. Set by `markCannotProceed`, which is what
   * suppresses further task claims.
   */
  cannotProceedNotice: string | undefined
  /**
   * Notice texts already reported to the lead. Keyed by the notice itself, so
   * a NEW limit (a different reset time, a different limit class) is reported
   * again rather than being swallowed as a duplicate of the old one.
   */
  reportedNotices: Set<string>
}

const state: UsageLimitGuardState = {
  cannotProceedNotice: undefined,
  reportedNotices: new Set(),
}

/**
 * The text of an assistant message, joined across its text blocks.
 */
function assistantMessageText(message: Message): string | undefined {
  if (message.type !== 'assistant') return undefined
  const content = message.message.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
  return text.length > 0 ? text : undefined
}

/**
 * The usage-limit notice a turn ended on, or undefined when the turn hit no
 * limit.
 *
 * Deliberately keyed on `isApiErrorMessage` AND the rate-limit prefix list
 * (`services/rateLimitMessages.ts`) rather than on a substring of our own
 * choosing: the prefixes are the same source of truth the UI uses to decide a
 * message is a rate-limit error, so a new limit phrasing cannot land in one
 * place and be missed here.
 */
export function findUsageLimitNotice(
  messages: readonly Message[],
): string | undefined {
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    if (message.isApiErrorMessage !== true) continue
    const text = assistantMessageText(message)
    if (text && isRateLimitErrorMessage(text)) {
      return text
    }
  }
  return undefined
}

/**
 * Whether a turn ended carrying an API error at all — any class, not just a
 * usage limit.
 *
 * This is the general shape of the bug the guard above handles one instance
 * of: an error that is yielded rather than thrown makes a failed turn look
 * successful, and a turn that fails without a round trip returns here in
 * microseconds. Callers use it to put a floor under the failed-turn path so
 * the next unknown fast-failing error class cannot spin either.
 */
export function endedInApiError(messages: readonly Message[]): boolean {
  return messages.some(
    message => message.type === 'assistant' && message.isApiErrorMessage === true,
  )
}

/**
 * Records that the account cannot currently make progress, so teammates stop
 * claiming work instead of burning through the task list one instant failure
 * at a time.
 */
export function markCannotProceed(notice: string): void {
  state.cannotProceedNotice = notice
}

/**
 * Whether a teammate should decline to claim more work. Consulted at the task
 * claim, which is the point where a spinning teammate would otherwise pick up
 * its next victim.
 */
export function isCannotProceed(): boolean {
  return state.cannotProceedNotice !== undefined
}

/**
 * Clears the stop. Called when a turn genuinely succeeds: usage came back, so
 * whatever limit we were parked on no longer holds.
 *
 * Doubles as the reset seam tests drive between cases — the state is module
 * level by necessity (in-process teammates share a process, so one scope
 * covers every teammate without IPC), which means it outlives any one test.
 *
 * The report ledger is cleared with it. That pairing is deliberate — if the
 * account hits the same limit again after recovering, that is NEW information
 * and the lead should hear about it, rather than having it suppressed by a
 * record of the previous outage.
 */
export function clearCannotProceed(): void {
  state.cannotProceedNotice = undefined
  state.reportedNotices.clear()
}

/**
 * Whether this notice still needs to reach the lead. True exactly once per
 * distinct notice across the whole process, so five teammates hitting one
 * account limit produce one message rather than five.
 *
 * Claims the slot as a side effect: callers that get `true` are responsible
 * for actually sending, and a caller that gets `false` must not send.
 */
export function shouldReportUsageLimit(notice: string): boolean {
  if (state.reportedNotices.has(notice)) {
    return false
  }
  state.reportedNotices.add(notice)
  return true
}
