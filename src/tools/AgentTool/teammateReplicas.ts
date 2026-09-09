/**
 * Caps for the Agent tool's `replicas` parameter and for the size of the
 * in-process teammate pool.
 *
 * - `replicas` per call is capped by MAX_TEAMMATE_REPLICAS
 *   (env CLAUDE_CODE_MAX_TEAMMATE_REPLICAS, default 8).
 * - Live in-process teammates (`in_process_teammate` tasks still `running`,
 *   idle or busy) are capped by MAX_LIVE_TEAMMATES
 *   (env CLAUDE_CODE_MAX_TEAMMATES, default 16). Single spawns count as one
 *   so the pool cannot grow past the cap one call at a time.
 *
 * Env values are parsed like parseIdleMsEnv in utils/swarm/inProcessRunner:
 * a positive integer wins, anything else falls back to the default. They are
 * read on every call (not memoized) so a session can be re-tuned in tests.
 */
import type { AppState } from '../../state/AppStateStore.js'

export const MAX_TEAMMATE_REPLICAS_ENV = 'CLAUDE_CODE_MAX_TEAMMATE_REPLICAS'
export const MAX_LIVE_TEAMMATES_ENV = 'CLAUDE_CODE_MAX_TEAMMATES'
export const DEFAULT_MAX_TEAMMATE_REPLICAS = 8
export const DEFAULT_MAX_LIVE_TEAMMATES = 16

export const REPLICAS_REQUIRE_NAME_ERROR = 'replicas requires name'
export const REPLICAS_REQUIRE_TEAM_ERROR =
  'replicas > 1 requires a teammate spawn: pass name together with team_name (or spawn from within an existing team) with Agent Teams enabled.'

/** Positive safe integer from an env value, else the default. */
export function parsePositiveIntEnv(
  raw: string | undefined,
  defaultValue: number,
): number {
  const trimmed = raw?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return defaultValue
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

export function getMaxTeammateReplicas(): number {
  return parsePositiveIntEnv(
    process.env[MAX_TEAMMATE_REPLICAS_ENV],
    DEFAULT_MAX_TEAMMATE_REPLICAS,
  )
}

export function getMaxLiveTeammates(): number {
  return parsePositiveIntEnv(
    process.env[MAX_LIVE_TEAMMATES_ENV],
    DEFAULT_MAX_LIVE_TEAMMATES,
  )
}

/**
 * Live in-process teammates: `in_process_teammate` tasks still `running`.
 * Idle teammates count (they hold a slot); terminal ones do not. Same filter
 * ListAgents uses for addressable teammates.
 */
export function countLiveInProcessTeammates(
  tasks: AppState['tasks'] | undefined,
): number {
  let count = 0
  for (const task of Object.values(tasks ?? {})) {
    if (task.type === 'in_process_teammate' && task.status === 'running') {
      count++
    }
  }
  return count
}

export type TeammateSpawnCapInput = {
  replicas?: number
  name?: string
  /** True when the call will spawn teammates: `name` given and a team resolved. */
  isTeammateSpawn: boolean
  tasks: AppState['tasks'] | undefined
}

/**
 * Validation shared by AgentTool.validateInput() and call() so direct call()
 * paths (SDK, tests) get the same error text. Returns undefined when the
 * spawn is within all caps.
 */
export function getTeammateSpawnCapError(
  input: TeammateSpawnCapInput,
): string | undefined {
  const { replicas, name, isTeammateSpawn, tasks } = input
  if (replicas !== undefined && !name) {
    return REPLICAS_REQUIRE_NAME_ERROR
  }
  const maxReplicas = getMaxTeammateReplicas()
  if (replicas !== undefined && replicas > maxReplicas) {
    return `replicas (${replicas}) exceeds the per-call cap of ${maxReplicas} (set ${MAX_TEAMMATE_REPLICAS_ENV} to change it).`
  }
  if (!isTeammateSpawn) {
    // A plain subagent (or a named background subagent) is not a teammate;
    // only a multi-replica request is meaningless there.
    return replicas !== undefined && replicas > 1
      ? REPLICAS_REQUIRE_TEAM_ERROR
      : undefined
  }
  const requested = replicas ?? 1
  const live = countLiveInProcessTeammates(tasks)
  const maxLive = getMaxLiveTeammates()
  if (live + requested > maxLive) {
    return `Spawning ${requested} teammate${requested === 1 ? '' : 's'} with ${live} already running would exceed the live teammate cap of ${maxLive} (set ${MAX_LIVE_TEAMMATES_ENV} to change it). Shut down or wait for running teammates first.`
  }
  return undefined
}
