import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { formatAgentId } from '../../utils/agentId.js'
import {
  type CallerIdentity,
  resolveCallerIdentity,
} from '../../utils/agentIdentity.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { invalidateSubTeamLeadership } from '../../utils/attachments.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getResolvedTeammateMode } from '../../utils/swarm/backends/registry.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import {
  getParentTeamName,
  getSubTeamNameFor,
  getTeamDepth,
  getTeamFilePath,
  readTeamFile,
  readTeamFileAsync,
  registerTeamForSessionCleanup,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import {
  ensureTasksDir,
  resetTaskList,
  setLeaderTeamName,
} from '../../utils/tasks.js'
import { generateWordSlug } from '../../utils/words.js'
import { parsePositiveIntEnv } from '../AgentTool/teammateReplicas.js'
import { TEAM_CREATE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    team_name: z.string().describe('Name for the new team to create.'),
    description: z.string().optional().describe('Team description/purpose.'),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type Input = z.infer<InputSchema>

/**
 * Generates a unique team name by checking if the provided name already exists.
 * If the name already exists, generates a new word slug.
 */
function generateUniqueTeamName(providedName: string): string {
  // If the team doesn't exist, use the provided name
  if (!readTeamFile(providedName)) {
    return providedName
  }

  // Team exists, generate a new unique name
  return generateWordSlug()
}

/** Env knob for the deepest the team tree may go. */
const MAX_TEAM_DEPTH_ENV_VAR = 'CLAUDE_CODE_MAX_TEAM_DEPTH'
/** A root team is depth 1, so the default allows `a/b/c`. */
const DEFAULT_MAX_TEAM_DEPTH = 3

function getMaxTeamDepth(): number {
  return parsePositiveIntEnv(
    process.env[MAX_TEAM_DEPTH_ENV_VAR],
    DEFAULT_MAX_TEAM_DEPTH,
  )
}

/**
 * TeamCreate called by a teammate: it creates the ONE sub-team it may lead,
 * named `<its team>/<its name>` — so teammate `supervisor` of team `email`
 * gets `email/supervisor`, led by `team-lead@email/supervisor`. The roster of
 * each team stays flat; the hierarchy is a tree of teams.
 *
 * One team per agent cannot be keyed the way the lead path keys it: an
 * in-process teammate shares the lead's AppState, so `teamContext.teamName`
 * there is the teammate's PARENT team and would reject every teammate with
 * "Already leading team email". It is keyed on the caller instead — the
 * derived name is a pure function of the caller, and only this function ever
 * writes a team file recorded under a name containing `/` (the lead path
 * refuses such names), so a file already recorded under that exact name IS
 * this caller's earlier create. One recorded under a DIFFERENT name is a
 * directory collision, checked right after. For the same reason the teammate
 * branch does not go through `generateUniqueTeamName`, which silently renames
 * on collision.
 *
 * The lead-only side effects that follow the lead path's write are skipped on
 * purpose: `setAppState` (a no-op inside an in-process teammate, but the real
 * store of a pane teammate's own process), `setLeaderTeamName` and
 * `resetTaskList`/`ensureTasksDir` all repoint process-global state — the
 * task list the lead and its teammates share, and the team context a pane
 * teammate polls its mailbox from — at the sub-team. The teammate stays a
 * member of its parent team; its sub-leadership lives in the team file
 * (`parentTeam`/`parentAgentId`), which is what the Agent tool reads back.
 */
async function createSubTeam(
  input: Input,
  caller: CallerIdentity,
  leadAgentType: string,
  leadModel: string,
): Promise<{ data: Output }> {
  // A pane/tmux teammate reaches this branch too — it is a teammate by every
  // identity check — but it runs in its own process and has no in-process
  // runner, and the in-process runner is what polls a sub-team's `team-lead`
  // inbox and hands its task list out to the sub-team's members. A pane
  // sub-lead would leave its children reporting into an inbox nothing reads
  // and claiming from a list nothing offers, so the team is refused rather
  // than created unleadable.
  if (!isInProcessTeammate()) {
    throw new Error(
      'Only an in-process teammate can lead a sub-team. This teammate runs in its own pane, where nothing would deliver its sub-team\'s messages or hand out its task list. Ask the team lead to create the team and spawn the members instead.',
    )
  }

  const subTeamName = getSubTeamNameFor(caller.agentId, caller.name)
  const parentTeam = subTeamName ? getParentTeamName(subTeamName) : undefined
  if (!subTeamName || !parentTeam || !caller.agentId) {
    throw new Error(
      'Cannot create a sub-team: the calling agent has no "name@team" identity. Only a teammate of an existing team can lead one.',
    )
  }

  const requestedName = input.team_name.trim()
  if (requestedName !== subTeamName) {
    throw new Error(
      `A teammate can only create its own sub-team "${subTeamName}", not "${requestedName}". Retry with team_name: "${subTeamName}".`,
    )
  }

  const maxDepth = getMaxTeamDepth()
  const depth = getTeamDepth(subTeamName)
  if (depth > maxDepth) {
    throw new Error(
      `Team "${subTeamName}" would be ${depth} levels deep, past the limit of ${maxDepth} (${MAX_TEAM_DEPTH_ENV_VAR}). Delegate inside "${parentTeam}" instead, or raise ${MAX_TEAM_DEPTH_ENV_VAR}.`,
    )
  }

  const existing = await readTeamFileAsync(subTeamName)
  if (existing?.name === subTeamName) {
    throw new Error(
      `Already leading team "${subTeamName}". A teammate leads at most one sub-team — spawn members into it with the Agent tool instead of creating another.`,
    )
  }
  if (existing) {
    // Team directories are one sanitized segment, so `email/supervisor` and a
    // root team named `email-supervisor` would share a config.json.
    throw new Error(
      `Cannot create team "${subTeamName}": team "${existing.name}" already occupies its directory ("${sanitizeName(subTeamName)}"). Rename that team, or the calling agent.`,
    )
  }

  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, subTeamName)
  const teamFilePath = getTeamFilePath(subTeamName)
  const teamFile: TeamFile = {
    name: subTeamName,
    description: input.description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: getSessionId(),
    parentTeam,
    parentAgentId: caller.agentId,
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: leadAgentType,
        model: leadModel,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: getCwd(),
        subscriptions: [],
      },
    ],
  }

  await writeTeamFileAsync(subTeamName, teamFile)
  // This caller's mid-turn drain has already answered "I lead no sub-team" on
  // an earlier round of this very turn, and caches that for
  // SUB_TEAM_RECHECK_INTERVAL_MS. Drop it now the file exists, so the rounds
  // that spawn this team's members also drain its `team-lead` inbox.
  invalidateSubTeamLeadership(caller.agentId)
  registerTeamForSessionCleanup(subTeamName)

  logEvent('tengu_team_created', {
    team_name:
      subTeamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    teammate_count: 1,
    lead_agent_type:
      leadAgentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    teammate_mode:
      getResolvedTeammateMode() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    data: {
      team_name: subTeamName,
      team_file_path: teamFilePath,
      lead_agent_id: leadAgentId,
    },
  }
}

export const TeamCreateTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_CREATE_TOOL_NAME,
  searchHint: 'create a multi-agent swarm team',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  toAutoClassifierInput(input) {
    return input.team_name
  },

  async validateInput(input, _context) {
    if (!input.team_name || input.team_name.trim().length === 0) {
      return {
        result: false,
        message: 'team_name is required for TeamCreate',
        errorCode: 9,
      }
    }
    return { result: true }
  },

  async description() {
    return 'Create a new team for coordinating multiple agents'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(input, context) {
    const { setAppState, getAppState } = context
    const { team_name, description: _description, agent_type } = input

    const appState = getAppState()
    const leadAgentType = agent_type || TEAM_LEAD_NAME
    // Get the team lead's current model from AppState (handles session model, settings, CLI override)
    const leadModel = parseUserSpecifiedModel(
      appState.mainLoopModelForSession ??
        appState.mainLoopModel ??
        getDefaultMainLoopModel(),
    )

    // Who is calling decides which team may be created: a lead creates a root
    // team, a teammate the one sub-team it leads. Identity comes from
    // resolveCallerIdentity so a subagent running inside a teammate's turn is
    // not mistaken for the teammate itself.
    const caller = resolveCallerIdentity(context)
    if (caller.isTeammate) {
      return createSubTeam(input, caller, leadAgentType, leadModel)
    }

    // Check if already in a team - restrict to one team per leader
    const existingTeam = appState.teamContext?.teamName

    if (existingTeam) {
      throw new Error(
        `Already leading team "${existingTeam}". A leader can only manage one team at a time. Use TeamDelete to end the current team before creating a new one.`,
      )
    }

    // The caller is not a teammate, so the name it asks for is a ROOT team
    // name — and a `/` in it names a sub-team. Writing one here would record a
    // team under a sub-team's name with no parentTeam/parentAgentId: the
    // teammate that legitimately leads it is then told it is "Already leading"
    // a team it does not lead, and the depth cap (which only createSubTeam
    // applies) never sees the name. This check belongs on the lead branch
    // alone — the teammate path passes `email/supervisor` on purpose.
    if (getParentTeamName(team_name) !== undefined) {
      throw new Error(
        `Cannot create team "${team_name}": a "/" in a team name marks a sub-team, and a sub-team is created by the teammate that leads it — with ${TEAM_CREATE_TOOL_NAME} from that teammate's own turn, under the name "<its team>/<its name>". Choose a name without "/".`,
      )
    }

    // If team already exists, generate a unique name instead of failing
    const finalTeamName = generateUniqueTeamName(team_name)

    // Generate a deterministic agent ID for the team lead
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)

    const teamFilePath = getTeamFilePath(finalTeamName)

    const teamFile: TeamFile = {
      name: finalTeamName,
      description: _description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(), // Store actual session ID for team discovery
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: leadAgentType,
          model: leadModel,
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: getCwd(),
          subscriptions: [],
        },
      ],
    }

    await writeTeamFileAsync(finalTeamName, teamFile)
    // Track for session-end cleanup — teams were left on disk forever
    // unless explicitly TeamDelete'd (gh-32730).
    registerTeamForSessionCleanup(finalTeamName)

    // Reset and create the corresponding task list directory (Team = Project = TaskList)
    // This ensures task numbering starts fresh at 1 for each new swarm
    const taskListId = sanitizeName(finalTeamName)
    await resetTaskList(taskListId)
    await ensureTasksDir(taskListId)

    // Register the team name so getTaskListId() returns it for the leader.
    // Without this, the leader falls through to getSessionId() and writes tasks
    // to a different directory than tmux/iTerm2 teammates expect.
    setLeaderTeamName(sanitizeName(finalTeamName))

    // Update AppState with team context
    setAppState(prev => ({
      ...prev,
      teamContext: {
        teamName: finalTeamName,
        teamFilePath,
        leadAgentId,
        teammates: {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: leadAgentType,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: '',
            tmuxPaneId: '',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }))

    logEvent('tengu_team_created', {
      team_name:
        finalTeamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_count: 1,
      lead_agent_type:
        leadAgentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_mode:
        getResolvedTeammateMode() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // Note: We intentionally don't set CLAUDE_CODE_AGENT_ID for the team lead because:
    // 1. The lead is not a "teammate" - isTeammate() should return false for them
    // 2. Their ID is deterministic (team-lead@teamName) and can be derived when needed
    // 3. Setting it would cause isTeammate() to return true, breaking inbox polling
    // Team name is stored in AppState.teamContext, not process.env

    return {
      data: {
        team_name: finalTeamName,
        team_file_path: teamFilePath,
        lead_agent_id: leadAgentId,
      },
    }
  },

  renderToolUseMessage,
} satisfies ToolDef<InputSchema, Output>)
