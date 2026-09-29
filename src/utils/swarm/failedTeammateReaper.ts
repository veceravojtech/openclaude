import { logForDebugging } from '../debug.js'

/**
 * Delayed auto-kill for a teammate that self-reported a failed turn
 * (idleReason 'failed'). The lead has been told why; the pane and the roster
 * entry would otherwise linger until someone runs `tmux kill-pane` by hand.
 *
 * The delay is a grace window, not a policy: a new message or re-task inside
 * it cancels the reap (see {@link cancelFailedTeammateReap}, called from the
 * mailbox writer), and the reap callback re-checks liveness when it fires.
 * Never throws; every failure is logged at debug level.
 */
export const FAILED_TEAMMATE_REAP_DELAY_MS = 3_000

export type ReaperTimers = {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

const defaultTimers: ReaperTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type Pending = {
  handle: unknown
  timers: ReaperTimers
  run: () => void
}

const pending = new Map<string, Pending>()

function reapKey(teamName: string, teammateName: string): string {
  return `${teamName}\u0000${teammateName}`
}

/**
 * Schedule `reap` after `delayMs`. Idempotent per (team, teammate): a second
 * schedule while one is pending is a no-op. The timer is unref'd. Returns
 * true when a new timer was armed.
 */
export function scheduleFailedTeammateReap(options: {
  teamName: string
  teammateName: string
  reap: () => Promise<void> | void
  delayMs?: number
  timers?: ReaperTimers
}): boolean {
  try {
    const key = reapKey(options.teamName, options.teammateName)
    if (pending.has(key)) return false
    const timers = options.timers ?? defaultTimers
    const run = (): void => {
      pending.delete(key)
      void Promise.resolve()
        .then(options.reap)
        .catch(error => {
          logForDebugging(
            `[FailedTeammateReaper] reap of ${options.teammateName}@${options.teamName} failed: ${String(error)}`,
          )
        })
    }
    const handle = timers.setTimer(
      run,
      options.delayMs ?? FAILED_TEAMMATE_REAP_DELAY_MS,
    )
    ;(handle as { unref?: () => void } | undefined)?.unref?.()
    pending.set(key, { handle, timers, run })
    return true
  } catch (error) {
    logForDebugging(
      `[FailedTeammateReaper] could not schedule reap of ${options.teammateName}@${options.teamName}: ${String(error)}`,
    )
    return false
  }
}

/** Cancel a pending reap (new work arrived, or the teammate is gone). */
export function cancelFailedTeammateReap(
  teamName: string,
  teammateName: string,
): boolean {
  try {
    const key = reapKey(teamName, teammateName)
    const entry = pending.get(key)
    if (!entry) return false
    pending.delete(key)
    entry.timers.clearTimer(entry.handle)
    return true
  } catch (error) {
    logForDebugging(
      `[FailedTeammateReaper] cancel for ${teammateName}@${teamName} failed: ${String(error)}`,
    )
    return false
  }
}

/**
 * Run a pending reap now instead of waiting out the grace window — used when
 * the lead asks a dead teammate to shut down. Returns true when a reap was
 * pending. Never throws.
 */
export function fireFailedTeammateReapNow(
  teamName: string,
  teammateName: string,
): boolean {
  try {
    const entry = pending.get(reapKey(teamName, teammateName))
    if (!entry) return false
    entry.timers.clearTimer(entry.handle)
    entry.run()
    return true
  } catch (error) {
    logForDebugging(
      `[FailedTeammateReaper] immediate reap of ${teammateName}@${teamName} failed: ${String(error)}`,
    )
    return false
  }
}

export function hasPendingFailedTeammateReap(
  teamName: string,
  teammateName: string,
): boolean {
  return pending.has(reapKey(teamName, teammateName))
}

/** Test seam: drop every pending reap. */
export function resetFailedTeammateReapsForTesting(): void {
  for (const entry of pending.values()) entry.timers.clearTimer(entry.handle)
  pending.clear()
}
