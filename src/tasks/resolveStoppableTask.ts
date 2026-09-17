// Turning what a TaskStop caller typed into a task THIS session can stop.
//
// Two identifiers name the same teammate and only one of them used to work.
// `spawnInProcessTeammate` mints a task id (`generateTaskId`) and an agent id
// (`formatAgentId` → `name@team`) side by side, and only the task id becomes
// the key in `AppState.tasks`. Task ids are a one-character type prefix plus 8
// characters of `[0-9a-z]`, so `@` can never occur in one: a raw key lookup
// rejects every `name@team` by construction — while ListAgents advertises
// exactly that form as the way to address an agent.
//
// The second half of the job is the answer given when resolution fails.
// `AppState.tasks` is per-process in-memory state, re-initialised empty at
// every start and never persisted, so a teammate belonging to another session
// has no row here in ANY id format. Reporting that as "No task found with ID"
// blamed the identifier and sent the caller back to re-type an address that
// was never wrong. The team files on disk know better, so they are consulted
// before the caller is told anything.

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { TaskStateBase } from '../Task.js'
import { parseAgentId } from '../utils/agentId.js'
import { logForDebugging } from '../utils/debug.js'
import { getTeamsDir } from '../utils/envUtils.js'
import { errorMessage, getErrnoCode } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'
import { isPaneBackend } from '../utils/swarm/backends/types.js'
import { readTeamFileAsync, type TeamFile } from '../utils/swarm/teamHelpers.js'
import { findTeammateTaskByAgentId } from './InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask } from './InProcessTeammateTask/types.js'

/** How many addressable ids a failure message is willing to list. */
const MAX_SUGGESTIONS = 10

export type StoppableTaskResolution =
  | { ok: true; taskId: string; task: TaskStateBase }
  | { ok: false; code: 'not_found' | 'ambiguous'; message: string }

/**
 * Resolves `id` to a task in `tasks`, accepting a task id, a teammate's
 * `name@team` address, or a teammate's bare name when it is unambiguous.
 *
 * Failure carries a message that says which of the three things went wrong —
 * unknown, ambiguous, or owned by another session — rather than collapsing all
 * of them into a not-found.
 */
export async function resolveStoppableTask(
  id: string,
  tasks: Record<string, TaskStateBase> | undefined,
): Promise<StoppableTaskResolution> {
  const rows = tasks ?? {}

  // A real task id wins outright: resolving addresses must not cost the path
  // that already worked, and a task id can never collide with `name@team`.
  const direct = rows[id]
  if (direct) {
    return { ok: true, taskId: id, task: direct }
  }

  const agentIds = matchingAgentIds(id, rows)
  if (agentIds.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message:
        `"${id}" is ambiguous: ${agentIds.length} teammates in this session ` +
        `are named "${id}" (${agentIds.join(', ')}). ` +
        `Use the full name@team form.`,
    }
  }

  const agentId = agentIds[0]
  if (agentId !== undefined) {
    // Prefers a running row over a stale terminal one with the same address.
    const task = findTeammateTaskByAgentId(agentId, rows)
    if (task) {
      return { ok: true, taskId: task.id, task }
    }
  }

  return { ok: false, code: 'not_found', message: await explainMiss(id, rows) }
}

/**
 * The teammate addresses in this session that `id` could mean: the address
 * itself when it is one, otherwise every team a bare name appears in.
 */
function matchingAgentIds(
  id: string,
  tasks: Record<string, TaskStateBase>,
): string[] {
  const matches = new Set<string>()
  for (const task of Object.values(tasks)) {
    if (!isInProcessTeammateTask(task)) continue
    const { agentId, agentName } = task.identity
    if (id.includes('@') ? agentId === id : agentName === id) {
      matches.add(agentId)
    }
  }
  return [...matches].sort()
}

/**
 * Why `id` resolved to nothing. Checks the team files on disk before
 * concluding the name is unknown: a member recorded there with no row here is
 * a teammate of another session, which is a different problem with a different
 * answer.
 */
async function explainMiss(
  id: string,
  tasks: Record<string, TaskStateBase>,
): Promise<string> {
  const owners = await findTeamMembersNamed(id)

  if (owners.length > 1) {
    return (
      `"${id}" is ambiguous: it names a member of ${owners.length} teams ` +
      `(${owners.map(o => o.agentId).join(', ')}). ` +
      `Use the full name@team form.`
    )
  }

  const owner = owners[0]
  if (owner) {
    return describeForeignTeammate(owner)
  }

  const addressable = listAddressable(tasks)
  return (
    `No task found with ID: ${id}. ` +
    (addressable.length > 0
      ? `Stoppable in this session: ${addressable.join(', ')}.`
      : `No task is running in this session.`)
  )
}

type ForeignTeammate = {
  agentId: string
  teamName: string
  leadSessionId: string | undefined
  member: TeamFile['members'][number]
}

/**
 * The sentence for a teammate that exists, but not here. It names the owning
 * session when the team file records one, because "somewhere else" is not
 * actionable and a session id is.
 */
function describeForeignTeammate(owner: ForeignTeammate): string {
  const whose = owner.leadSessionId
    ? `it belongs to session ${owner.leadSessionId}`
    : `it belongs to another session`
  const backendType = owner.member.backendType
  const paneId = owner.member.tmuxPaneId
  const where =
    backendType && isPaneBackend(backendType) && paneId && paneId !== 'in-process'
      ? ` Stop it from that session, or close its ${backendType} pane ${paneId}.`
      : ` Stop it from the session that owns it.`

  return (
    `${owner.agentId} is not a task in this session — ${whose}. ` +
    `Tasks are per-process state, so it cannot be stopped from here.${where}`
  )
}

/**
 * Every team member on disk that `id` names, by address or by bare name.
 *
 * A qualified id reads only the one team file it names. A bare name has to
 * list the teams directory: team directories are one flat sanitized segment,
 * so a single listing sees the whole forest.
 */
async function findTeamMembersNamed(id: string): Promise<ForeignTeammate[]> {
  const parsed = parseAgentId(id)
  if (parsed) {
    const teamFile = await readTeamFileAsync(parsed.teamName)
    const found = teamFile && memberNamed(teamFile, id, parsed.agentName)
    return found ? [found] : []
  }

  let dirNames: string[]
  try {
    dirNames = await readdir(getTeamsDir())
  } catch (e) {
    if (getErrnoCode(e) !== 'ENOENT') {
      logForDebugging(
        `[TaskStop] Failed to list teams directory: ${errorMessage(e)}`,
      )
    }
    return []
  }

  const owners: ForeignTeammate[] = []
  for (const dirName of dirNames) {
    let teamFile: TeamFile | null = null
    try {
      const content = await readFile(
        join(getTeamsDir(), dirName, 'config.json'),
        'utf-8',
      )
      teamFile = jsonParse(content) as TeamFile
    } catch {
      // Not a team directory, or a team file being written right now.
      continue
    }
    const found = teamFile && memberNamed(teamFile, undefined, id)
    if (found) owners.push(found)
  }
  return owners.sort((a, b) => a.agentId.localeCompare(b.agentId))
}

function memberNamed(
  teamFile: TeamFile,
  agentId: string | undefined,
  name: string,
): ForeignTeammate | undefined {
  const member = teamFile.members?.find(m =>
    agentId !== undefined ? m.agentId === agentId || m.name === name : m.name === name,
  )
  if (!member) return undefined
  return {
    agentId: member.agentId,
    teamName: teamFile.name,
    leadSessionId: teamFile.leadSessionId,
    member,
  }
}

/** What this session can actually be asked to stop, teammates by address. */
function listAddressable(tasks: Record<string, TaskStateBase>): string[] {
  const ids: string[] = []
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.status !== 'running') continue
    ids.push(
      isInProcessTeammateTask(task)
        ? `${task.identity.agentId} (${taskId})`
        : taskId,
    )
  }
  return ids.sort().slice(0, MAX_SUGGESTIONS)
}
