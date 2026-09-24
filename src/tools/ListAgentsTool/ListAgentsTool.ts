import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type CallerIdentity,
  resolveCallerIdentity,
} from '../../utils/agentIdentity.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  readSubTeamLedBy,
  readTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import { readDelegatedActivity } from '../../utils/swarm/delegatedActivity.js'
import { getTeammateStatuses } from '../../utils/teamDiscovery.js'
import { getTeamName } from '../../utils/teammate.js'
import {
  getRootTeamName,
  resolveCallerTeamName,
} from '../SendMessageTool/addressing.js'
import {
  ADDRESSABLE_AGENT_KINDS,
  ADDRESSABLE_AGENT_SOURCES,
  ADDRESSABLE_AGENT_STATUSES,
  collectAddressableAgents,
  renderAddressableAgents,
  type TeamNeighbourhood,
} from './collectAddressableAgents.js'
import { LIST_AGENTS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

/**
 * Where the caller sits in the team tree, read from the team files: the root
 * above its team when its team is a sub-team, who leads its own team, and the
 * sub-team it leads.
 *
 * `ownLeadAgentId` is the id of the caller's own team's lead, which inside a
 * sub-team is the teammate leading it — not the session's lead id.
 */
async function readTeamNeighbourhood(
  identity: CallerIdentity,
  teamName: string | undefined,
): Promise<TeamNeighbourhood & { ownLeadAgentId?: string }> {
  const subTeamFile = await readSubTeamLedBy(identity)
  const subTeam = subTeamFile
    ? {
        teamName: subTeamFile.name,
        members: await getTeammateStatuses(subTeamFile.name),
      }
    : undefined

  if (!teamName) {
    return { subTeam }
  }
  const rootTeamName = getRootTeamName(teamName)
  if (rootTeamName === teamName) {
    return { subTeam }
  }

  const ownTeamFile = await readTeamFileAsync(teamName)
  const rootTeamFile = await readTeamFileAsync(rootTeamName)
  return {
    root: { teamName: rootTeamName, leadAgentId: rootTeamFile?.leadAgentId },
    parentAgentId: ownTeamFile?.parentAgentId,
    subTeam,
    ownLeadAgentId: ownTeamFile?.leadAgentId,
  }
}

const outputSchema = lazySchema(() =>
  z.object({
    agents: z.array(
      z.object({
        name: z.string(),
        agentId: z.string(),
        kind: z.enum(ADDRESSABLE_AGENT_KINDS),
        status: z.enum(ADDRESSABLE_AGENT_STATUSES),
        description: z.string(),
        model: z.string().optional(),
        team: z.string().optional(),
        idleSince: z.string().optional(),
        to: z.string(),
        source: z.enum(ADDRESSABLE_AGENT_SOURCES).optional(),
        delegatedActivity: z.object({
          status: z.enum(['none', 'working', 'unknown']),
          activeDescendants: z.array(z.string()),
          unknownDescendants: z.array(z.string()),
        }).optional(),
        taskId: z.string().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ListAgentsTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  searchHint: 'list agents you can message (teammates, background agents)',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ListAgents'
  },
  // Not deferred: peers must be discoverable without a ToolSearch round.
  isEnabled() {
    return isAgentSwarmsEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call(_input, context) {
    const appState = context.getAppState()
    const teamContext = appState.teamContext

    // A subagent spawned inside a teammate inherits that teammate's ambient
    // identity, so resolving the caller from the tool-use context is what
    // keeps the spawning teammate in the list instead of excluding it as
    // "self" — and excludes the subagent itself instead.
    const identity = resolveCallerIdentity(context)

    // The caller's own team, which for a member of a sub-team is that
    // sub-team — not the lead's team, whose context the whole session shares.
    const teamName = resolveCallerTeamName(identity, getTeamName(teamContext))

    // The lead already sees its team from the outside; everyone else inside a
    // team needs a row to answer upwards on.
    const inTeam = Boolean(teamName || teamContext?.leadAgentId)
    const callerIsLead =
      identity.agentId === undefined ||
      identity.agentId === teamContext?.leadAgentId

    const tree = await readTeamNeighbourhood(identity, teamName)
    const teamMembers = teamName ? await getTeammateStatuses(teamName) : []

    const owners = [
      ...teamMembers.map(member => ({ agentId: member.agentId, agentName: member.name })),
      ...(tree.subTeam?.members ?? []).map(member => ({ agentId: member.agentId, agentName: member.name })),
      ...Object.values(appState.tasks).flatMap(task => task.type === 'in_process_teammate' ? [task.identity] : []),
    ]
    const delegatedByAgentId = new Map(owners.map(owner => [owner.agentId, readDelegatedActivity(owner, appState.tasks)]))
    const agents = collectAddressableAgents({
      delegatedByAgentId,
      tasks: appState.tasks,
      agentNameRegistry: appState.agentNameRegistry,
      teamMembers,
      teamName,
      // Inside a sub-team the session's lead id is the ROOT lead's, so the
      // sub-team's own file says who leads the caller's team.
      leadAgentId: tree.root ? tree.ownLeadAgentId : teamContext?.leadAgentId,
      selfAgentId: identity.agentId,
      selfAgentName: identity.name,
      includeTeamLead: inTeam && !callerIsLead,
      tree,
    })

    return { data: { agents } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { agents } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: renderAddressableAgents(agents),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
