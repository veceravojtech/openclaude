/**
 * Waiting out a subscription usage limit instead of surfacing it.
 *
 * When the account-wide limit is reached and there is nothing better to do,
 * the useful behaviour is to wait until the window resets and resume the
 * request that was rejected — not to hand the user an error they can only
 * respond to by trying again later themselves.
 *
 * The decision is kept here, apart from `withRetry.ts`, because it is the part
 * worth testing: every input is a value, so the awkward half (a live API
 * error, the keychain, the clock) stays at the call site and the rules stay
 * exercisable without any of it.
 *
 * Four properties this is shaped around:
 *
 * - **Only the foreground query waits.** Sleeping is only ever right for the
 *   request a user is sitting in front of. A teammate that slept would hold a
 *   claimed task hostage for hours; `swarm/usageLimitGuard.ts` already stops
 *   teammates and hands the task back, and that stays the behaviour for them.
 *   The gate is the query source, so the two mechanisms never both fire.
 * - **A switchable account beats a timer.** If the user has another account
 *   stored, waiting hours is the wrong remedy for a problem `/account` solves
 *   in a second. Report, don't sleep.
 * - **Bounded, or not at all.** A reset in the past, a missing header, or a
 *   weekly limit that resets in three days all fall through to reporting. The
 *   wait is for the five-hour window, which is the case where resuming
 *   unattended is genuinely useful.
 * - **Once per request.** One wait, then retry. If the retry is rejected too,
 *   that is reported rather than slept on again — which is what keeps this
 *   from degenerating into a sleep loop.
 */

import type { QuerySource } from 'src/constants/querySource.js'
import { clearCannotProceed } from '../../utils/swarm/usageLimitGuard.js'

/**
 * Slack added past the reset instant before retrying.
 *
 * Waking at exactly the reset timestamp races the server's own view of the
 * window: a second of clock skew either way and the retry is rejected again,
 * which — because a wait happens only once — would cost the user the whole
 * benefit for the sake of a rounding error.
 */
export const USAGE_LIMIT_WAIT_BUFFER_MS = 5_000

export type UsageLimitWaitSkipReason =
  /** Not a rate-limit rejection at all. */
  | 'not-rate-limited'
  /**
   * Not the first-party Anthropic API. Other providers' 429s are ordinary
   * capacity or per-minute limits, already served well by normal backoff;
   * waiting out a whole reset window would be a regression for them.
   */
  | 'wrong-provider'
  /**
   * A subagent, teammate, classifier, or summariser. Nothing here is worth
   * holding open for hours, and teammates have their own stop-and-release
   * handling.
   */
  | 'background-source'
  /**
   * No abort signal reached this request, so a wait could not be cancelled.
   *
   * This is the one skip that exists to prevent harm rather than to avoid a
   * pointless wait: an uncancellable multi-hour sleep is strictly worse for
   * the user than the error it would have replaced, because the session is
   * simply gone with no way back short of killing the terminal. Reporting the
   * limit costs one error message; getting this wrong costs the session.
   */
  | 'no-cancel-signal'
  /** Already waited once for this request; a second wait would be a loop. */
  | 'already-waited'
  /**
   * Another stored account could unblock immediately — switching beats
   * waiting. Reached only when the auto-switch declined (no session-effects
   * hook registered, e.g. an SDK host), so the user is pointed at the
   * switch rather than parked on a reset clock.
   */
  | 'other-account-available'
  /** No usable reset time: header absent, unparseable, or already in the past. */
  | 'no-reset-time'
  /** Reset is further out than we are willing to sleep. */
  | 'reset-too-far'

export type UsageLimitWaitDecision =
  | {
      type: 'wait'
      /** How long to sleep, including the skew buffer. */
      delayMs: number
      /** Wall-clock instant, in epoch ms, the request resumes at. */
      resumeAtMs: number
    }
  | { type: 'skip'; reason: UsageLimitWaitSkipReason }

/**
 * Whether a query source is a request the user is actively waiting on.
 *
 * Deliberately an allowlist. An unrecognised source is treated as background,
 * so a new call path cannot silently acquire the ability to sleep for hours
 * by being added somewhere else in the codebase.
 */
export function isForegroundUsageLimitSource(
  querySource: QuerySource | undefined,
): boolean {
  if (typeof querySource !== 'string') return false
  return querySource.startsWith('repl_main_thread') || querySource === 'sdk'
}

/**
 * Records that usage is available again, after a wait ended in a request that
 * actually succeeded.
 *
 * The teammate stop-guard (`swarm/usageLimitGuard.ts`) is a module-level
 * marker that makes every teammate decline to claim work. Teammates clear it
 * themselves when one of their own turns succeeds — but a teammate that hit
 * the limit mid-turn has already exited, so after an account-wide limit the
 * surviving teammates are all idle, and an idle teammate never runs a turn to
 * clear it with. The marker would stay set for the rest of the process and
 * every poll would keep refusing: a message flood traded for a permanent
 * silent stall, which is the worse failure.
 *
 * The waiter is the one that learns usage came back, so the waiter is what
 * clears it. Idle teammates then claim the released tasks on their next poll
 * through the path they already use — no dispatcher, no teammate-side polling
 * for recovery, and the reset knowledge stays in exactly one place.
 */
export function noteUsageLimitRecovered(): void {
  clearCannotProceed()
}

export type UsageLimitWaitInput = {
  /** HTTP status of the rejection. */
  status: number | undefined
  /** Whether the request went to the first-party Anthropic API. */
  isFirstParty: boolean
  querySource: QuerySource | undefined
  /**
   * Whether an abort signal is available to cancel the wait with. Without one
   * the wait is uninterruptible, so there is no wait.
   */
  hasCancelSignal: boolean
  /**
   * Milliseconds until the limit resets, from the response headers, or null
   * when the headers carry no usable reset. Already clamped to `resetCapMs`
   * by the caller's parser — which is why a value at the cap is read as
   * "at least this far away" and refused below.
   */
  resetDelayMs: number | null
  /** The ceiling the caller's parser clamps to, and the longest we will sleep. */
  resetCapMs: number
  /**
   * Whether another stored account could be switched to. A thunk, not a
   * value, because answering it reads secure storage: the call site sees an
   * API error on every failed request of any kind, and only a small
   * subset of those ever reach this question.
   */
  otherAccountAvailable: () => boolean
  /** Whether this request has already spent its one wait. */
  alreadyWaited: boolean
  /** Current time in epoch ms. */
  now: number
}

/**
 * Whether to wait out this rejection, and for how long.
 *
 * Checks run cheapest-and-most-decisive first, and the reason is carried on
 * the result so the call site can log why a wait did not happen — a silent
 * false here is indistinguishable from the feature being broken.
 */
export function decideUsageLimitWait(
  input: UsageLimitWaitInput,
): UsageLimitWaitDecision {
  if (input.status !== 429) {
    return { type: 'skip', reason: 'not-rate-limited' }
  }
  if (!input.isFirstParty) {
    return { type: 'skip', reason: 'wrong-provider' }
  }
  if (!isForegroundUsageLimitSource(input.querySource)) {
    return { type: 'skip', reason: 'background-source' }
  }
  if (!input.hasCancelSignal) {
    return { type: 'skip', reason: 'no-cancel-signal' }
  }
  if (input.alreadyWaited) {
    return { type: 'skip', reason: 'already-waited' }
  }
  if (input.otherAccountAvailable()) {
    return { type: 'skip', reason: 'other-account-available' }
  }
  const resetDelayMs = input.resetDelayMs
  if (resetDelayMs === null || !Number.isFinite(resetDelayMs) || resetDelayMs <= 0) {
    return { type: 'skip', reason: 'no-reset-time' }
  }
  // At the cap the true reset is unknown — the parser clamped it, so the real
  // window could be days out (a weekly limit). Sleeping the cap would then
  // wake into the same rejection having spent the one wait for nothing.
  if (resetDelayMs >= input.resetCapMs) {
    return { type: 'skip', reason: 'reset-too-far' }
  }

  const delayMs = resetDelayMs + USAGE_LIMIT_WAIT_BUFFER_MS
  return { type: 'wait', delayMs, resumeAtMs: input.now + delayMs }
}
