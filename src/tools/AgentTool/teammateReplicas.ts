/**
 * Caps for the Agent tool's `replicas` parameter and for the size of the
 * in-process teammate pool.
 *
 * - `replicas` per call is capped by MAX_TEAMMATE_REPLICAS
 *   (env CLAUDE_CODE_MAX_TEAMMATE_REPLICAS, default 8).
 * - Live in-process teammates (`in_process_teammate` tasks still `running`,
 *   idle or busy) are capped twice: PER TEAM by MAX_LIVE_TEAMMATES
 *   (env CLAUDE_CODE_MAX_TEAMMATES, default 16), counting only teammates in
 *   the team being spawned into, and across ALL teams of the session by
 *   MAX_TEAM_TOTAL (env CLAUDE_CODE_MAX_TEAM_TOTAL, default 24). Single
 *   spawns count as one so neither pool can grow past its cap one call at a
 *   time. Sub-teams have their own per-team pool (their names contain `/`
 *   and are compared as exact strings), but every member of every team
 *   counts against the one total.
 *
 * Env values are parsed like parseIdleMsEnv in utils/swarm/inProcessRunner:
 * a positive integer wins, anything else falls back to the default. They are
 * read on every call (not memoized) so a session can be re-tuned in tests.
 */
import type { AppState } from '../../state/AppStateStore.js'

export const MAX_TEAMMATE_REPLICAS_ENV = 'CLAUDE_CODE_MAX_TEAMMATE_REPLICAS'
export const MAX_LIVE_TEAMMATES_ENV = 'CLAUDE_CODE_MAX_TEAMMATES'
export const MAX_TEAM_TOTAL_ENV = 'CLAUDE_CODE_MAX_TEAM_TOTAL'
export const DEFAULT_MAX_TEAMMATE_REPLICAS = 8
export const DEFAULT_MAX_LIVE_TEAMMATES = 16
export const DEFAULT_MAX_TEAM_TOTAL = 24

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

export function getMaxTeamTotal(): number {
  return parsePositiveIntEnv(
    process.env[MAX_TEAM_TOTAL_ENV],
    DEFAULT_MAX_TEAM_TOTAL,
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

/**
 * Live in-process teammates in one team. Team names are compared as exact
 * strings — a sub-team is named `parent/child` and is its own pool, not a
 * path to split or a prefix to match.
 *
 * A running teammate whose team cannot be read off its task (identity or
 * teamName missing) counts against EVERY team: an unattributable teammate
 * still holds a real slot, and the conservative reading keeps a cap a cap.
 * Without a team to spawn into, this is the whole running pool — the global
 * count this cap used to be.
 */
export function countLiveTeammatesInTeam(
  tasks: AppState['tasks'] | undefined,
  teamName: string | undefined,
): number {
  if (!teamName) return countLiveInProcessTeammates(tasks)
  let count = 0
  for (const task of Object.values(tasks ?? {})) {
    if (task.type !== 'in_process_teammate' || task.status !== 'running') {
      continue
    }
    const identity: { teamName?: string } | undefined = task.identity
    const taskTeam = identity?.teamName?.trim()
    if (!taskTeam || taskTeam === teamName) count++
  }
  return count
}

export type TeammateSpawnCapInput = {
  replicas?: number
  name?: string
  /** True when the call will spawn teammates: `name` given and a team resolved. */
  isTeammateSpawn: boolean
  /**
   * The team the spawn lands in, already substituted to the sub-team by the
   * caller when a teammate leads one. Undefined where no team is resolved
   * yet (validateInput): the per-team cap then counts the whole pool.
   */
  teamName?: string
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
  const { replicas, name, isTeammateSpawn, teamName, tasks } = input
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
  const plural = requested === 1 ? '' : 's'
  const maxLive = getMaxLiveTeammates()
  const maxTotal = getMaxTeamTotal()
  const liveInTeam = countLiveTeammatesInTeam(tasks, teamName)
  if (liveInTeam + requested > maxLive) {
    const where = teamName ? ` in team "${teamName}"` : ''
    return `Spawning ${requested} teammate${plural} with ${liveInTeam} already running${where} would exceed the live teammate cap of ${maxLive} per team (set ${MAX_LIVE_TEAMMATES_ENV} to change it; the cap across all teams is ${maxTotal}, set ${MAX_TEAM_TOTAL_ENV}). Shut down or wait for running teammates first.`
  }
  const liveTotal = countLiveInProcessTeammates(tasks)
  if (liveTotal + requested > maxTotal) {
    return `Spawning ${requested} teammate${plural} with ${liveTotal} already running across all teams would exceed the total teammate cap of ${maxTotal} (set ${MAX_TEAM_TOTAL_ENV} to change it; the per-team cap is ${maxLive}, set ${MAX_LIVE_TEAMMATES_ENV}). Shut down or wait for running teammates first.`
  }
  return undefined
}
