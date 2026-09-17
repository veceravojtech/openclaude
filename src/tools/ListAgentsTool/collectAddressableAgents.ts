/**
 * Pure listing logic for the ListAgents tool.
 *
 * Merges every agent the caller can address with SendMessage:
 *   (a) in-process teammates — `in_process_teammate` tasks in AppState
 *   (b) team-file members not already covered by (a) — pane/tmux teammates
 *   (b2) members of the sub-team the caller leads — its children
 *   (c) named background subagents — `local_agent` tasks whose name is in
 *       AppState.agentNameRegistry, including terminal ones still in state
 *   (d) the lead of the caller's own team, for any caller inside a team that
 *       is not that lead — from inside a sub-team this is its sub-lead
 *   (d2) the root lead, when the caller's own team is a sub-team
 *
 * That is the caller's neighbourhood in the team tree: the lead above it, the
 * root above that, its siblings, and its own children. Teammates of teams
 * elsewhere in the tree share the lead's AppState but are not neighbours, so
 * they are left out — they stay addressable by their `name@team`.
 *
 * Every row's `to` is the address SendMessage resolves back to that same
 * agent: `name@team` for anything in a team (`formatRecipientAddress`), the
 * bare name for a registry-named background agent.
 *
 * The caller is excluded. No I/O: the team-file members are passed in so the
 * function is unit-testable with plain state.
 */
import type { AppState } from '../../state/AppState.js'
import type { TaskStatus } from '../../Task.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { TeammateStatus } from '../../utils/teamDiscovery.js'
import { formatRecipientAddress } from '../SendMessageTool/addressing.js'

export const ADDRESSABLE_AGENT_KINDS = [
  'team_lead',
  'teammate',
  'background_agent',
] as const
export type AddressableAgentKind = (typeof ADDRESSABLE_AGENT_KINDS)[number]

export const ADDRESSABLE_AGENT_STATUSES = [
  'idle',
  'busy',
  'running',
  'completed',
  'failed',
  'killed',
  'unknown',
] as const
export type AddressableAgentStatus =
  (typeof ADDRESSABLE_AGENT_STATUSES)[number]

export const ADDRESSABLE_AGENT_SOURCES = ['task', 'team_file'] as const
/**
 * Where a row's liveness comes from.
 * - `task`: a task in this session's AppState — the live, authoritative fact.
 * - `team_file`: the team file on disk and nothing else. The file is written
 *   at spawn and never corrected when a child dies, so such a row proves only
 *   that the member was once written down: it may be dead, or it may belong to
 *   a different session. Its status is reported `unknown`, never busy or idle.
 *
 * Absent on the derived `team_lead` rows, which are addresses rather than
 * observations and carry no liveness either way.
 */
export type AddressableAgentSource = (typeof ADDRESSABLE_AGENT_SOURCES)[number]

export type AddressableAgent = {
  name: string
  agentId: string
  kind: AddressableAgentKind
  status: AddressableAgentStatus
  description: string
  model?: string
  team?: string
  /** ISO timestamp, when the team file recorded it. */
  idleSince?: string
  /** The exact value to pass as SendMessage's `to`. */
  to: string
  /** What `status` is based on; see AddressableAgentSource. */
  source?: AddressableAgentSource
  /** The AppState task id — what TaskStop takes. Only on task-backed rows. */
  taskId?: string
}

/**
 * Where the caller sits in the team tree. Absent for a session with a single
 * flat team, which is every team until a teammate creates a sub-team.
 */
export type TeamNeighbourhood = {
  /** The root team, when the caller's own team is a sub-team of it. */
  root?: { teamName: string; leadAgentId?: string }
  /**
   * The teammate leading the caller's own team (`name@team`), from the team
   * file's `parentAgentId` — names who the sub-lead row actually is.
   */
  parentAgentId?: string
  /** The sub-team the caller leads, with its members (lead excluded). */
  subTeam?: { teamName: string; members: readonly TeammateStatus[] }
}

export type CollectAddressableAgentsInput = {
  tasks: AppState['tasks']
  agentNameRegistry: AppState['agentNameRegistry']
  /** Current team's members as read from the team file (lead excluded). */
  teamMembers: readonly TeammateStatus[]
  /** The caller's own team — exact name, `/`-separated for a sub-team. */
  teamName?: string
  leadAgentId?: string
  selfAgentId?: string
  selfAgentName?: string
  /**
   * Whether to add the lead row: true for every caller inside a team except
   * the lead itself — teammates and the subagents they spawn alike.
   */
  includeTeamLead: boolean
  tree?: TeamNeighbourhood
}

const KIND_ORDER: Record<AddressableAgentKind, number> = {
  team_lead: 0,
  teammate: 1,
  background_agent: 2,
}

function mapTaskStatus(status: TaskStatus): AddressableAgentStatus {
  switch (status) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'killed':
      return status
    default:
      // 'pending': registered but not yet started.
      return 'unknown'
  }
}

/**
 * A teammate's status from its task. A running teammate is reported as busy or
 * idle — the distinction callers pick work by — and a terminal one keeps its
 * terminal word, which is the whole point: a failed teammate must read
 * `failed`, not `busy`.
 *
 * The team file is deliberately not a fallback here. Its status comes from the
 * member's `isActive` flag, which only the teammate itself maintains — via
 * `setMemberActiveState` in `teamHelpers.ts`, as it goes idle and busy again.
 * A teammate that dies never reaches that write, and `getTeammateStatuses`
 * reads a missing or true flag as "running". So the file pins a member live at
 * the last moment it was able to speak for itself, which is how five teammates
 * that died on their first turn went on being advertised as busy and
 * addressable.
 */
function teammateTaskStatus(
  task: InProcessTeammateTaskState,
): AddressableAgentStatus {
  if (task.status === 'running') {
    return task.isIdle ? 'idle' : 'busy'
  }
  return mapTaskStatus(task.status)
}

// Same truncation spawnInProcess applies to a teammate task's description.
function summarizePrompt(prompt: string): string {
  return prompt.length > 50 ? `${prompt.substring(0, 50)}...` : prompt
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return (
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
  )
}

export function collectAddressableAgents(
  input: CollectAddressableAgentsInput,
): AddressableAgent[] {
  const {
    tasks,
    agentNameRegistry,
    teamMembers,
    teamName,
    leadAgentId,
    selfAgentId,
    selfAgentName,
    includeTeamLead,
    tree,
  } = input

  const agents: AddressableAgent[] = []
  const seenAgentIds = new Set<string>()
  const seenAddresses = new Set<string>()

  /**
   * The caller itself. A name match alone no longer settles it: the same name
   * can sit in two teams of one tree, and only the one in the caller's own
   * team is the caller.
   */
  const isSelf = (agent: AddressableAgent): boolean => {
    if (selfAgentId !== undefined && agent.agentId === selfAgentId) return true
    if (!sameName(agent.name, selfAgentName)) return false
    return (
      agent.team === undefined || teamName === undefined || agent.team === teamName
    )
  }

  // First row wins on an agentId or address collision, so sources are visited
  // in the order SendMessage resolves `to`: the name registry first, then the
  // teams. Addresses (not bare names) are the key — a teammate `twin@alpha`
  // and a background agent named `twin` are two reachable agents, and it is
  // the bare `twin` that belongs to the registry one.
  const add = (agent: AddressableAgent): void => {
    if (isSelf(agent)) {
      return
    }
    const addressKey = agent.to.toLowerCase()
    if (seenAgentIds.has(agent.agentId) || seenAddresses.has(addressKey)) {
      return
    }
    seenAgentIds.add(agent.agentId)
    seenAddresses.add(addressKey)
    agents.push(agent)
  }

  // Teammates of teams elsewhere in the tree share the lead's AppState; only
  // the caller's own team and the sub-team it leads are its neighbourhood.
  // With no team known, nothing can be placed, so nothing is filtered.
  const neighbourTeams = new Set(
    [teamName, tree?.subTeam?.teamName].filter(
      (name): name is string => name !== undefined,
    ),
  )
  const isNeighbour = (team: string | undefined): boolean =>
    team === undefined || neighbourTeams.size === 0 || neighbourTeams.has(team)

  // The task behind an agentId, terminal ones included — a member whose task
  // has failed or been killed must report that, not the file's default. A
  // running task wins over a lingering terminal one: a re-spawn reuses the
  // same deterministic agentId, and the live row is the true one.
  const taskByAgentId = new Map<string, InProcessTeammateTaskState>()
  for (const task of Object.values(tasks)) {
    if (task.type !== 'in_process_teammate') {
      continue
    }
    const seen = taskByAgentId.get(task.identity.agentId)
    if (seen && seen.status === 'running') {
      continue
    }
    taskByAgentId.set(task.identity.agentId, task)
  }

  const memberRow = (
    member: TeammateStatus,
    team: string | undefined,
  ): AddressableAgent => {
    // Pane teammates register a task too, so most members have one and the
    // dedupe above has usually already placed them. What lands here without a
    // task is the interesting case: dead, or spawned by another session.
    const task = taskByAgentId.get(member.agentId)
    return {
      name: member.name,
      agentId: member.agentId,
      kind: 'teammate',
      status: task ? teammateTaskStatus(task) : 'unknown',
      description: member.prompt
        ? `${member.name}: ${summarizePrompt(member.prompt)}`
        : `${member.name}: ${member.agentType ?? 'teammate'}`,
      model: member.model,
      team,
      idleSince: member.idleSince,
      to: formatRecipientAddress(member.name, team),
      source: task ? 'task' : 'team_file',
      taskId: task?.id,
    }
  }

  // (c) named background subagents
  for (const [name, agentId] of agentNameRegistry) {
    const task = tasks[agentId]
    if (
      !task ||
      task.type !== 'local_agent' ||
      task.agentType === 'main-session'
    ) {
      continue
    }
    add({
      name,
      agentId,
      kind: 'background_agent',
      status: mapTaskStatus(task.status),
      description: task.description,
      model: task.model,
      to: name,
      source: 'task',
      taskId: task.id,
    })
  }

  // (a) in-process teammates
  for (const task of Object.values(tasks)) {
    // Terminal teammate tasks are evicted within seconds and cannot be
    // messaged (a killed teammate is not resumable), so they are skipped.
    // Otherwise a lingering killed task would shadow a re-spawned teammate
    // with the same name, whose agentId is identical (first add() wins).
    if (task.type !== 'in_process_teammate' || task.status !== 'running') {
      continue
    }
    if (!isNeighbour(task.identity.teamName)) {
      continue
    }
    add({
      name: task.identity.agentName,
      agentId: task.identity.agentId,
      kind: 'teammate',
      status: teammateTaskStatus(task),
      description: task.description,
      model: task.model,
      team: task.identity.teamName,
      to: formatRecipientAddress(
        task.identity.agentName,
        task.identity.teamName,
      ),
      source: 'task',
      taskId: task.id,
    })
  }

  // (b) team-file members not covered by (a): pane/tmux teammates
  for (const member of teamMembers) {
    if (member.name === TEAM_LEAD_NAME) {
      continue
    }
    add(memberRow(member, teamName))
  }

  // (b2) the caller's own children: the members of the sub-team it leads
  if (tree?.subTeam) {
    for (const member of tree.subTeam.members) {
      if (member.name === TEAM_LEAD_NAME) {
        continue
      }
      add(memberRow(member, tree.subTeam.teamName))
    }
  }

  // (d) the lead of the caller's own team, addressable only from inside a
  // team. Inside a sub-team that lead is the teammate leading it, which is
  // what `team-lead` resolves to from down there — the root lead needs the
  // separate row below.
  if (includeTeamLead) {
    const inSubTeam = tree?.root !== undefined
    add({
      name: TEAM_LEAD_NAME,
      agentId: leadAgentId ?? formatRecipientAddress(TEAM_LEAD_NAME, teamName),
      kind: 'team_lead',
      status: 'unknown',
      description: inSubTeam
        ? `Lead of ${teamName ?? 'this team'}${
            tree?.parentAgentId ? ` (${tree.parentAgentId})` : ''
          }`
        : 'Team lead (main session)',
      team: teamName,
      to: formatRecipientAddress(TEAM_LEAD_NAME, teamName),
    })

    // (d2) the root lead, reachable from inside a sub-team by its full address
    if (tree?.root) {
      add({
        name: TEAM_LEAD_NAME,
        agentId:
          tree.root.leadAgentId ??
          formatRecipientAddress(TEAM_LEAD_NAME, tree.root.teamName),
        kind: 'team_lead',
        status: 'unknown',
        description: 'Team lead (main session)',
        team: tree.root.teamName,
        to: formatRecipientAddress(TEAM_LEAD_NAME, tree.root.teamName),
      })
    }
  }

  // Two leads share the name `team-lead`, so the address breaks the tie and
  // the order stays deterministic.
  return agents.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name) ||
      a.to.localeCompare(b.to),
  )
}

export const NO_ADDRESSABLE_AGENTS_MESSAGE =
  'No other agents are addressable right now.'

export const SEND_MESSAGE_HINT =
  'Message any of these with SendMessage(to=...)'

export const TEAM_FILE_ONLY_MARKER = '(team file; no live local task)'

/** Compact model-facing rendering: one line per agent plus the hint. */
export function renderAddressableAgents(
  agents: readonly AddressableAgent[],
): string {
  if (agents.length === 0) {
    return NO_ADDRESSABLE_AGENTS_MESSAGE
  }
  const lines = agents.map(agent => {
    // `to=` stays exactly where and what it was: SendMessage addressing is a
    // separate concern from liveness, and it works.
    const parts = [
      `${agent.name}  ${agent.kind}  ${agent.status}  to=${agent.to}`,
    ]
    if (agent.taskId) {
      parts.push(`task=${agent.taskId}`)
    }
    if (agent.source === 'team_file') {
      parts.push(TEAM_FILE_ONLY_MARKER)
    }
    const line = parts.join('  ')
    return agent.description ? `${line}  - ${agent.description}` : line
  })
  return [...lines, '', SEND_MESSAGE_HINT].join('\n')
}
