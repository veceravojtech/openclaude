export const OPENCLAUDE_QUERY_HARD_MAX_MS_ENV =
  'OPENCLAUDE_QUERY_HARD_MAX_MS'

// setTimeout-compatible upper bound; larger values can overflow timer APIs.
export const MAX_CONFIGURABLE_QUERY_HARD_MAX_MS = 0x7fffffff

type EnvLike = Record<string, string | undefined>
type DebugLogger = (
  message: string,
  options?: { level: 'warn' },
) => void

export type QueryGuardResolvedOptions = {
  /**
   * `undefined` lets QueryGuard use its own default; `null` explicitly
   * disables the hard-max watchdog (see QueryGuard's `hardMaxQueryMs: null`).
   */
  hardMaxQueryMs?: number | null
  /**
   * `undefined` lets QueryGuard use its own default; `null` explicitly
   * disables the idle watchdog (see QueryGuard's `idleTimeoutMs: null`).
   */
  idleTimeoutMs?: number | null
}

/**
 * Options applied for a teammate with no valid explicit hard-max override:
 * both QueryGuard watchdogs disabled, since either one could otherwise
 * force-end a teammate that is still legitimately working.
 */
const DISABLED_TEAMMATE_OPTIONS: QueryGuardResolvedOptions = {
  hardMaxQueryMs: null,
  idleTimeoutMs: null,
}

function warnInvalidQueryHardMax(
  value: string,
  reason: string,
  log: DebugLogger,
): void {
  log(
    `${OPENCLAUDE_QUERY_HARD_MAX_MS_ENV} invalid value "${value}" (${reason}); using default query hard max`,
    { level: 'warn' },
  )
}

function defaultWarnLogger(message: string): void {
  console.warn(`[OpenClaude] ${message}`)
}

/**
 * Resolve QueryGuard options from the environment.
 *
 * A teammate must run until it finishes, errors, or is explicitly stopped —
 * never force-ended by a default wall-clock cap partway through a long
 * turn, regardless of whether it is actively producing activity.
 * `isTeammate` therefore DISABLES BOTH QueryGuard watchdogs by default for
 * teammate processes (out-of-process pane/tmux teammates run the full CLI,
 * including REPL.tsx's QueryGuard): the hard-max lifetime cap, and the idle
 * timeout, which could otherwise force-end a teammate merely waiting on an
 * unleased long-running operation. An explicit, valid
 * OPENCLAUDE_QUERY_HARD_MAX_MS always wins over the disabled hard-max — for
 * teammates and the main session alike — because it is a limit the user
 * asked for, not a default; there is no equivalent idle-timeout override, so
 * setting it does not implicitly re-enable the idle watchdog for teammates.
 */
export function getQueryGuardOptionsFromEnv(
  env: EnvLike = process.env,
  log: DebugLogger = defaultWarnLogger,
  isTeammate = false,
): QueryGuardResolvedOptions {
  const raw = env[OPENCLAUDE_QUERY_HARD_MAX_MS_ENV]
  const value = raw?.trim()
  if (!value) {
    return isTeammate ? DISABLED_TEAMMATE_OPTIONS : {}
  }

  if (!/^\d+$/.test(value)) {
    warnInvalidQueryHardMax(
      value,
      'expected a positive integer in milliseconds',
      log,
    )
    return isTeammate ? DISABLED_TEAMMATE_OPTIONS : {}
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    warnInvalidQueryHardMax(value, 'expected a positive finite integer', log)
    return isTeammate ? DISABLED_TEAMMATE_OPTIONS : {}
  }

  if (parsed > MAX_CONFIGURABLE_QUERY_HARD_MAX_MS) {
    warnInvalidQueryHardMax(
      value,
      `maximum is ${MAX_CONFIGURABLE_QUERY_HARD_MAX_MS}`,
      log,
    )
    return isTeammate ? DISABLED_TEAMMATE_OPTIONS : {}
  }

  return isTeammate
    ? { hardMaxQueryMs: parsed, idleTimeoutMs: null }
    : { hardMaxQueryMs: parsed }
}
