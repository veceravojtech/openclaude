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

function mapTeamFileStatus(
  status: TeammateStatus['status'],
): AddressableAgentStatus {
  switch (status) {
    case 'running':
      return 'busy'
    case 'idle':
      return 'idle'
    default:
      return 'unknown'
  }
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

  const memberRow = (
    member: TeammateStatus,
    team: string | undefined,
  ): AddressableAgent => ({
    name: member.name,
    agentId: member.agentId,
    kind: 'teammate',
    status: mapTeamFileStatus(member.status),
    description: member.prompt
      ? `${member.name}: ${summarizePrompt(member.prompt)}`
      : `${member.name}: ${member.agentType ?? 'teammate'}`,
    model: member.model,
    team,
    idleSince: member.idleSince,
    to: formatRecipientAddress(member.name, team),
  })

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
      status: task.isIdle ? 'idle' : 'busy',
      description: task.description,
      model: task.model,
      team: task.identity.teamName,
      to: formatRecipientAddress(
        task.identity.agentName,
        task.identity.teamName,
      ),
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

/** Compact model-facing rendering: one line per agent plus the hint. */
export function renderAddressableAgents(
  agents: readonly AddressableAgent[],
): string {
  if (agents.length === 0) {
    return NO_ADDRESSABLE_AGENTS_MESSAGE
  }
  const lines = agents.map(agent => {
    const line = `${agent.name}  ${agent.kind}  ${agent.status}  to=${agent.to}`
    return agent.description ? `${line}  - ${agent.description}` : line
  })
  return [...lines, '', SEND_MESSAGE_HINT].join('\n')
}
