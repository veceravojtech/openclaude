/**
 * Pure listing logic for the ListAgents tool.
 *
 * Merges every agent the caller can address with SendMessage:
 *   (a) in-process teammates — `in_process_teammate` tasks in AppState
 *   (b) team-file members not already covered by (a) — pane/tmux teammates
 *   (c) named background subagents — `local_agent` tasks whose name is in
 *       AppState.agentNameRegistry, including terminal ones still in state
 *   (d) the team lead, for any caller inside a team that is not the lead
 *
 * The caller is excluded. No I/O: the team-file members are passed in so the
 * function is unit-testable with plain state.
 */
import type { AppState } from '../../state/AppState.js'
import type { TaskStatus } from '../../Task.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { TeammateStatus } from '../../utils/teamDiscovery.js'

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

export type CollectAddressableAgentsInput = {
  tasks: AppState['tasks']
  agentNameRegistry: AppState['agentNameRegistry']
  /** Current team's members as read from the team file (lead excluded). */
  teamMembers: readonly TeammateStatus[]
  teamName?: string
  leadAgentId?: string
  selfAgentId?: string
  selfAgentName?: string
  /**
   * Whether to add the lead row: true for every caller inside a team except
   * the lead itself — teammates and the subagents they spawn alike.
   */
  includeTeamLead: boolean
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
  } = input

  const agents: AddressableAgent[] = []
  const seenAgentIds = new Set<string>()
  const seenNames = new Set<string>()

  // First row wins on a name/agentId collision, so sources are visited in the
  // order SendMessage resolves `to`: the name registry first, then the team.
  const add = (agent: AddressableAgent): void => {
    if (agent.agentId === selfAgentId || sameName(agent.name, selfAgentName)) {
      return
    }
    const nameKey = agent.name.toLowerCase()
    if (seenAgentIds.has(agent.agentId) || seenNames.has(nameKey)) {
      return
    }
    seenAgentIds.add(agent.agentId)
    seenNames.add(nameKey)
    agents.push(agent)
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
    add({
      name: task.identity.agentName,
      agentId: task.identity.agentId,
      kind: 'teammate',
      status: task.isIdle ? 'idle' : 'busy',
      description: task.description,
      model: task.model,
      team: task.identity.teamName,
      to: task.identity.agentName,
    })
  }

  // (b) team-file members not covered by (a): pane/tmux teammates
  for (const member of teamMembers) {
    if (member.name === TEAM_LEAD_NAME) {
      continue
    }
    add({
      name: member.name,
      agentId: member.agentId,
      kind: 'teammate',
      status: mapTeamFileStatus(member.status),
      description: member.prompt
        ? `${member.name}: ${summarizePrompt(member.prompt)}`
        : `${member.name}: ${member.agentType ?? 'teammate'}`,
      model: member.model,
      team: teamName,
      idleSince: member.idleSince,
      to: member.name,
    })
  }

  // (d) the team lead, addressable only from inside a team
  if (includeTeamLead) {
    add({
      name: TEAM_LEAD_NAME,
      agentId: leadAgentId ?? TEAM_LEAD_NAME,
      kind: 'team_lead',
      status: 'unknown',
      description: 'Team lead (main session)',
      team: teamName,
      to: TEAM_LEAD_NAME,
    })
  }

  return agents.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
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
