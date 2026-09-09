import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { resolveCallerIdentity } from '../../utils/agentIdentity.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateStatuses } from '../../utils/teamDiscovery.js'
import { getTeamName } from '../../utils/teammate.js'
import {
  ADDRESSABLE_AGENT_KINDS,
  ADDRESSABLE_AGENT_STATUSES,
  collectAddressableAgents,
  renderAddressableAgents,
} from './collectAddressableAgents.js'
import { LIST_AGENTS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

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
    const teamName = getTeamName(teamContext)

    // A subagent spawned inside a teammate inherits that teammate's ambient
    // identity, so resolving the caller from the tool-use context is what
    // keeps the spawning teammate in the list instead of excluding it as
    // "self" — and excludes the subagent itself instead.
    const identity = resolveCallerIdentity(context)

    // The lead already sees its team from the outside; everyone else inside a
    // team needs a row to answer upwards on.
    const inTeam = Boolean(teamName || teamContext?.leadAgentId)
    const callerIsLead =
      identity.agentId === undefined ||
      identity.agentId === teamContext?.leadAgentId

    const agents = collectAddressableAgents({
      tasks: appState.tasks,
      agentNameRegistry: appState.agentNameRegistry,
      teamMembers: teamName ? getTeammateStatuses(teamName) : [],
      teamName,
      leadAgentId: teamContext?.leadAgentId,
      selfAgentId: identity.agentId,
      selfAgentName: identity.name,
      includeTeamLead: inTeam && !callerIsLead,
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
