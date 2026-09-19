/**
 * Shared spawn module for teammate creation.
 * Extracted from TeammateTool to allow reuse by AgentTool.
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getSessionId,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  preferOneMillionContext,
} from '../../utils/model/model.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import {
  armPaneTeammateWatchdog,
  type PaneTeammateWatchdogDeps,
  type PaneTeammateWatchdogHandle,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import {
  applyTeammateModelFlag,
  buildInheritedEnvVars,
} from '../../utils/swarm/spawnUtils.js'
import { findUnroutableCodexOAuthProfile } from '../../services/api/agentRouting.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { PROVIDER_PROFILE_IN_PROCESS_ERROR } from '../AgentTool/providerProfileBinding.js'
import {
  getParentTeamName,
  getTeamFilePath,
  readTeamFileAsync,
  registerTeamForSessionCleanup,
  sanitizeAgentName,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured !== undefined && configured !== null) {
    return parseUserSpecifiedModel(configured)
  }
  // Never set, or "Default" picked in /config: a teammate runs the leader's
  // model unless something explicitly says otherwise. The unset case used to
  // take the newest default Opus instead, so a lead on Opus 4.6 spawned Opus 5
  // teammates. The provider table is only a last resort for when there is no
  // leader model to follow.
  return leaderModel ?? getHardcodedTeammateModelFallback()
}

/**
 * The model the leader is actually running, with the same precedence query.ts
 * uses for the leader's own requests: a session-only /model switch, then the
 * model setting (which includes --model), then the default. Reading only
 * `mainLoopModel` missed a session switch and was null on a default model, so
 * a teammate could be handed a model the leader was not using.
 *
 * Exported for testing.
 */
export function getLeaderModel(
  state: Pick<AppState, 'mainLoopModel' | 'mainLoopModelForSession'>,
): string {
  return parseUserSpecifiedModel(
    state.mainLoopModelForSession ??
      state.mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
}

/**
 * Resolve a teammate model value. Handles the 'inherit' alias (from agent
 * frontmatter) by substituting the leader's model. gh-31069: 'inherit' was
 * passed literally to --model, producing "It may not exist or you may not
 * have access". If leader model is null (not yet set), falls through to the
 * default.
 *
 * The selected model gets the same 1M-context preference as the leader
 * (preferOneMillionContext). Without it a teammate on the unset default got
 * plain Opus while the leader ran Opus[1m], and compacted at 150k tokens
 * instead of 950k — on its first call, since the system prompt and tools alone
 * can exceed 150k. This value is also the `--model` a split-pane teammate is
 * launched with, so it must already carry the tag.
 *
 * Exported for testing.
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return preferOneMillionContext(
      leaderModel ?? getDefaultTeammateModel(leaderModel),
    )
  }
  return preferOneMillionContext(
    inputModel ?? getDefaultTeammateModel(leaderModel),
  )
}

/**
 * The model a pane/window teammate is LAUNCHED with, i.e. the value that
 * becomes `--model` on its spawn command. Same as resolveTeammateModel except
 * it can answer "none".
 *
 * A provider-profile binding (AgentTool's `provider_profile`) injects
 * `OPENAI_MODEL` into the child's env, and the documented way to use it is to
 * bind the profile and pass NO model — the profile's model resolves on the
 * bound provider. resolveTeammateModel cannot express that: with no input it
 * falls through to the LEADER's model, so the child was launched with
 * `env OPENAI_MODEL=<profile model> ... --model <leader model>`, the flag beat
 * the env var, and the leader's Anthropic model was sent to Codex — measured
 * as `400 The 'claude-opus-5' model is not supported when using Codex with a
 * ChatGPT account`, with the feature used exactly as its runbook prescribes.
 *
 * So: when the binding supplies a model and the caller asked for a
 * leader-derived one (nothing, or the 'inherit' alias, which literally means
 * "the leader's model"), launch with no model and let the child read
 * OPENAI_MODEL. Substituting the profile's model through resolveTeammateModel
 * would not do: preferOneMillionContext appends the Anthropic-only `[1m]`
 * context tag, which a codex model has no meaning for.
 *
 * An EXPLICIT model is still honoured, binding or not. Refusing it would
 * contradict the spawn guard added in c1bf55c3, whose whole remedy for a codex
 * model with no route is "Bind it explicitly with provider_profile" — that
 * advice only works if profile + model is a supported combination. The env
 * var is a default; an explicit argument overrides a default.
 *
 * Exported for testing.
 */
export function resolveTeammateLaunchModel(
  inputModel: string | undefined,
  leaderModel: string | null,
  providerEnv: Record<string, string> | undefined,
): string | undefined {
  const leaderDerived = inputModel === undefined || inputModel === 'inherit'
  if (providerEnv?.OPENAI_MODEL && leaderDerived) {
    return undefined
  }
  return resolveTeammateModel(inputModel, leaderModel)
}

// ============================================================================
// Types
// ============================================================================

/** Thrown by the pane/window spawn handlers when no prompt is given. */
export const IDLE_SPAWN_UNSUPPORTED_ERROR =
  'idle spawn (no prompt) is only supported for in-process teammates'

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  /** Omit to spawn an idle teammate that waits for work (in-process only). */
  prompt?: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  modelWasToolSpecified?: boolean
  agent_type?: string
  description?: string
  /** Provider-profile env (from AgentTool's provider_profile param) that the
   *  spawned teammate must run under instead of the leader's. Appended AFTER
   *  the inherited env allowlist in the spawn command so it overrides it
   *  (POSIX `env` applies left-to-right). Pane/window spawns only. */
  providerEnv?: Record<string, string>
  /** request_id of the API call whose response contained the tool_use that
   *  spawned this teammate. Threaded through to TeammateAgentContext for
   *  lineage tracing on tengu_api_* events. */
  invokingRequestId?: string
}

// Internal input type matching TeammateTool's spawn parameters.
// Must stay structurally in sync with SpawnTeammateConfig: spawnTeammate
// passes its config straight through to handleSpawn under this input type.
type SpawnInput = {
  name: string
  prompt?: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  modelWasToolSpecified?: boolean
  agent_type?: string
  description?: string
  providerEnv?: Record<string, string>
  invokingRequestId?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if a tmux session exists
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * Creates a new tmux session if it doesn't exist
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * Gets the command to spawn a teammate.
 * For native builds (compiled binaries), use process.execPath.
 * For non-native (node/bun running a script), use process.argv[1].
 */
function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (permissionMode === 'fullAccess') {
    flags.push('--permission-mode fullAccess')
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup (permissionSetup.ts) handles
    // GrowthBook gate checks and setAutoModeActive(true) independently.
    flags.push('--permission-mode auto')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Generates a unique teammate name by checking existing team members.
 * If the name already exists, appends a numeric suffix (e.g., tester-2, tester-3).
 * @internal Exported for testing
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // If the base name doesn't exist, use it as-is
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // Find the next available suffix
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Ensures a team file exists on disk. If it doesn't (e.g. when a non-Claude
 * model skips the TeamCreate step), auto-creates a minimal team file so
 * the spawn can proceed.
 */
async function ensureTeamFileExists(
  teamName: string,
  context: ToolUseContext,
): Promise<import('../../utils/swarm/teamHelpers.js').TeamFile> {
  const existing = await readTeamFileAsync(teamName)
  if (existing) return existing

  // A sub-team (`<parentTeam>/<leader>`) only ever comes from TeamCreate, which
  // records parentTeam/parentAgentId. Auto-creating one here would mint a team
  // that looks like a root team with a slash in its name: no parent, no leader
  // that anything can resolve, and invisible to the team it claims to hang off.
  const parentTeam = getParentTeamName(teamName)
  if (parentTeam !== undefined) {
    throw new Error(
      `Team "${teamName}" does not exist. A sub-team of "${parentTeam}" has to be created by its leader with ${TEAM_CREATE_TOOL_NAME} before anyone can be spawned into it.`,
    )
  }

  // Auto-create the team
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)

  const teamFile: import('../../utils/swarm/teamHelpers.js').TeamFile = {
    name: teamName,
    description: `Auto-created team for ${teamName}`,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: getCwd(),
        subscriptions: [],
      },
    ],
  }

  await writeTeamFileAsync(teamName, teamFile)
  registerTeamForSessionCleanup(teamName)

  // Update AppState so the rest of the session is team-aware
  context.setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId,
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [leadAgentId]: {
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          color: assignTeammateColor(leadAgentId),
          tmuxSessionName: '',
          tmuxPaneId: '',
          cwd: getCwd(),
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  logForDebugging(
    `[spawnMultiAgent] Auto-created team "${teamName}" (team file was missing)`,
  )

  return teamFile
}

// ============================================================================
// Spawn Handlers
// ============================================================================

/**
 * Positive-knowledge refusal for model-only pane/window spawns (see
 * findUnroutableCodexOAuthProfile): a model an OAuth Codex profile lists,
 * with no route anywhere and a first-party session that provably cannot
 * serve it, used to silently degrade to "send it to Anthropic" — the child
 * then 404'd on its first turn and reported nothing (Stop hooks are skipped
 * on API-error turns), leaving a 'running' task row until the watchdog
 * fired 30 minutes later. Refuse instead, loudly, before any pane or task
 * exists. A spawn carrying providerEnv (provider_profile) bypasses this:
 * it has its own env, and its failure modes are handled at binding time.
 */
function assertModelOnlySpawnRoutable(input: SpawnInput): void {
  if (input.providerEnv !== undefined || !input.model) return
  const unroutable = findUnroutableCodexOAuthProfile(
    input.model,
    getInitialSettings(),
  )
  if (unroutable) {
    throw new Error(
      `Model '${input.model.trim()}' is served by provider profile '${unroutable.name}' (OAuth), which model-only routing cannot use — OAuth profiles have no API key to route with. Bind it explicitly with provider_profile, or configure agentModels routing to an API-key provider. On this session's provider the model would 404 on its first request.`,
    )
  }
}

/**
 * Handle spawn operation using split-pane view (default).
 * When inside tmux: Creates teammates in a shared window with leader on left, teammates on right.
 * When outside tmux: Creates a claude-swarm session with all teammates in a tiled layout.
 *
 * Exported for testing.
 */
export async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus.
  // Undefined when a provider-profile binding owns the model (see
  // resolveTeammateLaunchModel) — then no --model is emitted at all.
  const launchModel = resolveTeammateLaunchModel(
    input.model,
    getLeaderModel(getAppState()),
    input.providerEnv,
  )
  // What this teammate will actually run on, for the roster and the tool
  // result. With a binding and no --model that is the profile's model.
  const model = launchModel ?? input.providerEnv?.OPENAI_MODEL

  if (prompt === undefined) {
    throw new Error(IDLE_SPAWN_UNSUPPORTED_ERROR)
  }
  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }
  assertModelOnlySpawnRoutable(input)

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = cwd || getCwd()

  // Detect the appropriate backend and check if setup is needed
  let detectionResult = await detectAndGetBackend()

  // If in iTerm2 but it2 isn't set up, prompt the user
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // Lazy-import React and It2SetupPrompt — only needed for TUI setup prompt.
    // This keeps the SDK bundle free of React static imports.
    const [{ default: React }, { It2SetupPrompt }] = await Promise.all([
      import('react'),
      import('../../utils/swarm/It2SetupPrompt.js'),
    ])

    // Show the setup prompt and wait for user decision
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // Clear the JSX
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('Teammate spawn cancelled - iTerm2 setup required')
    }

    // If they installed it2 or chose tmux, clear cached detection and re-fetch
    // so the local detectionResult matches the backend that will actually
    // spawn the pane.
    // - 'installed': re-detect to pick up the ITermBackend (it2 is now available)
    // - 'use-tmux': re-detect so needsIt2Setup is false (preferTmux is now saved)
    //   and subsequent spawns skip this prompt
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // Check if we're inside tmux to determine session naming
  const insideTmux = await isInsideTmux()

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a pane in the swarm view
  // - Inside tmux: splits current window (leader on left, teammates on right)
  // - In iTerm2 with it2: uses native iTerm2 split panes
  // - Outside both: creates claude-swarm session with tiled teammates
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // Enable pane border status on first teammate when inside tmux
  // (outside tmux, this is handled in createTeammatePaneInSwarmView)
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  const inheritedFlags = applyTeammateModelFlag(
    buildInheritedCliFlags({
      planModeRequired: plan_mode_required,
      permissionMode: appState.toolPermissionContext.mode,
    }),
    { model: launchModel, providerEnv: input.providerEnv },
  )

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  // A provider-profile binding rides after the allowlist so it overrides.
  const envStr = buildInheritedEnvVars(input.providerEnv)
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new pane
  // Use swarm socket when running outside tmux (external swarm session)
  await sendCommandToPane(paneId, spawnCommand, !insideTmux)

  // Determine session/window names for output
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // Track the teammate in AppState's teamContext with color
  // If spawning without spawnTeam, set up the leader as team lead
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so teammates appear in the tasks pill/dialog
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: detectionResult.backend.type,
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      plan_mode_required,
    },
  }
}

/**
 * Handle spawn operation using separate windows (legacy behavior).
 * Creates each teammate in its own tmux window.
 */
// Exported for testing (the spawn-guard suite drives it like the split-pane
// handler, with every boundary mocked).
export async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus.
  // Undefined when a provider-profile binding owns the model (see
  // resolveTeammateLaunchModel) — then no --model is emitted at all.
  const launchModel = resolveTeammateLaunchModel(
    input.model,
    getLeaderModel(getAppState()),
    input.providerEnv,
  )
  // What this teammate will actually run on, for the roster and the tool
  // result. With a binding and no --model that is the profile's model.
  const model = launchModel ?? input.providerEnv?.OPENAI_MODEL

  if (prompt === undefined) {
    throw new Error(IDLE_SPAWN_UNSUPPORTED_ERROR)
  }
  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }
  assertModelOnlySpawnRoutable(input)

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = cwd || getCwd()

  // Ensure the swarm session exists
  await ensureSession(SWARM_SESSION_NAME)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a new window for this teammate
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `Failed to create tmux window: ${createWindowResult.stderr}`,
    )
  }

  const paneId = createWindowResult.stdout.trim()

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  const inheritedFlags = applyTeammateModelFlag(
    buildInheritedCliFlags({
      planModeRequired: plan_mode_required,
      permissionMode: appState.toolPermissionContext.mode,
    }),
    { model: launchModel, providerEnv: input.providerEnv },
  )

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  // A provider-profile binding rides after the allowlist so it overrides.
  const envStr = buildInheritedEnvVars(input.providerEnv)
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new window
  const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    spawnCommand,
    'Enter',
  ])

  if (sendKeysResult.code !== 0) {
    throw new Error(
      `Failed to send command to tmux window: ${sendKeysResult.stderr}`,
    )
  }

  // Track the teammate in AppState's teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so tmux teammates appear in the tasks pill/dialog
  // Separate window spawns are always outside tmux (external swarm session)
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux', // This handler always uses tmux directly
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * Register a background task entry for an out-of-process (tmux/iTerm2) teammate.
 * This makes tmux teammates visible in the background tasks pill and dialog,
 * matching how in-process teammates are tracked.
 *
 * Also arms the pane-teammate watchdog (paneTeammateWatchdog.ts), which is
 * the only thing that ever transitions this task terminal: pane teammates
 * have no runner, so without it the row says 'running' forever — including
 * for a child that died on its first turn and never reported (the Stop-hook
 * skip on API-error turns).
 *
 * Exported for testing (the watchdog tests drive it with every boundary
 * injected). Returns the watchdog handle; production callers ignore it.
 */
export function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
  },
  watchdogDeps?: PaneTeammateWatchdogDeps,
): PaneTeammateWatchdogHandle {
  const taskId = generateTaskId('in_process_teammate')
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  registerTask(taskState, setAppState)

  // Arm the first-contact / absence-of-progress watchdog beside the task
  // registration: pane teammates have no runner to transition this task, and
  // a child that dies on its first turn reports nothing at all (Stop hooks
  // are skipped on API-error turns). The watchdog fails the task when no
  // lifecycle signal arrives, and completes it when the child's idle
  // notification does — with the isPaneAlive probe consulted only to name
  // the failure. Deliberate kills disarm it via the same abort signal that
  // kills the pane below.
  const watchdog = armPaneTeammateWatchdog({
    taskId,
    description,
    teammateName: sanitizedName,
    teamName,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
    setAppState,
    signal: abortController.signal,
    deps: watchdogDeps,
  })

  // When abort is signaled, kill the pane using the backend that created it
  // (tmux kill-pane for tmux panes, it2 session close for iTerm2 native panes).
  // SDK task_notification bookend is emitted by killInProcessTeammate (the
  // sole abort trigger for this controller).
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      }
    },
    { once: true },
  )

  return watchdog
}

/**
 * Handle spawn operation for in-process teammates.
 * In-process teammates run in the same Node.js process using AsyncLocalStorage.
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input

  // An in-process teammate shares the leader's process; there is no child
  // environment to inject a provider profile into. Reject by name instead
  // of silently ignoring the binding — silent fall-through is the original
  // hang this feature exists to prevent.
  if (input.providerEnv !== undefined) {
    throw new Error(PROVIDER_PROFILE_IN_PROCESS_ERROR)
  }

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getLeaderModel(getAppState()))
  const modelWasToolSpecified =
    input.modelWasToolSpecified ?? input.model !== undefined

  // prompt may be omitted (idle spawn: the teammate waits for work) but an
  // empty prompt is still rejected, as it was before idle spawns existed.
  if (!name) {
    throw new Error('name is required for spawn operation')
  }
  if (prompt === '') {
    throw new Error(
      'prompt must not be empty; omit it to spawn an idle teammate',
    )
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Look up custom agent definition if agent_type is provided
  let agentDefinition: CustomAgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    const foundAgent = allAgents.find(a => a.agentType === agent_type)
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn in-process teammate
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
  }

  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to spawn in-process teammate')
  }

  // Debug: log what spawn returned
  logForDebugging(
    `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
  )

  // Start the agent execution loop (fire-and-forget)
  if (result.taskId && result.teammateContext && result.abortController) {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: sanitizedName,
        teamName,
        color: teammateColor,
        planModeRequired: plan_mode_required ?? false,
        parentSessionId: result.teammateContext.parentSessionId,
      },
      taskId: result.taskId,
      prompt,
      description: input.description,
      model,
      modelWasToolSpecified,
      subagentType: agent_type,
      agentDefinition,
      teammateContext: result.teammateContext,
      // Strip messages: the teammate never reads toolUseContext.messages
      // (it builds its own history via allMessages in inProcessRunner).
      // Passing the parent's full conversation here would pin it for the
      // teammate's lifetime, surviving /clear and auto-compact.
      toolUseContext: { ...context, messages: [] },
      abortController: result.abortController,
      invokingRequestId: input.invokingRequestId,
    })
    logForDebugging(
      `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
    )
  }

  // Track the teammate in AppState's teamContext
  // Auto-register leader if spawning without prior spawnTeam call
  setAppState(prev => {
    const needsLeaderSetup = !prev.teamContext?.leadAgentId
    const leadAgentId = needsLeaderSetup
      ? formatAgentId(TEAM_LEAD_NAME, teamName)
      : prev.teamContext!.leadAgentId

    // Build teammates map, including leader if needed for inbox polling
    const existingTeammates = prev.teamContext?.teammates || {}
    const leadEntry = needsLeaderSetup
      ? {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: TEAM_LEAD_NAME,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'leader',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        }
      : {}

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...leadEntry,
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Note: Do NOT send the prompt via mailbox for in-process teammates.
  // In-process teammates receive the prompt directly via startInProcessTeammate().
  // The mailbox is only needed for tmux-based teammates which poll for their initial message.
  // Sending via both paths would cause duplicate welcome messages.

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * Handle spawn operation - creates a new Claude Code instance.
 * Uses in-process mode when enabled, otherwise uses tmux/iTerm2 split-pane view.
 * Falls back to in-process if pane backend detection fails (e.g., iTerm2 without
 * it2 CLI or tmux installed).
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  // Idle spawns (no prompt) only exist in-process: pane/window teammates are
  // separate processes that block on their first mailbox message and cannot
  // be parked idle. Route them in-process regardless of teammate mode so the
  // Agent tool's use_splitpane default never lands them on a pane backend.
  if (input.prompt === undefined) {
    logForDebugging(
      `[handleSpawn] idle spawn (no prompt) for ${input.name}: forcing in-process`,
    )
    return handleSpawnInProcess(input, context)
  }

  // Check if in-process mode is enabled via feature flag
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

  // Pre-flight: ensure a pane backend is available before attempting pane-based spawn.
  // This handles auto-mode cases like iTerm2 without it2 or tmux installed, where
  // isInProcessEnabled() returns false but detectAndGetBackend() has no viable backend.
  // Narrowly scoped so user cancellation and other spawn errors propagate normally.
  try {
    await detectAndGetBackend()
  } catch (error) {
    // Only fall back silently in auto mode. If the user explicitly configured
    // teammateMode: 'tmux', let the error propagate so they see the actionable
    // install instructions from getTmuxInstallInstructions().
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    logForDebugging(
      `[handleSpawn] No pane backend available, falling back to in-process: ${errorMessage(error)}`,
    )
    // Record the fallback so isInProcessEnabled() reflects the actual mode
    // (fixes banner and other UI that would otherwise show tmux attach commands).
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  // Backend is available (and now cached) - proceed with pane spawning.
  // Any errors here (user cancellation, validation, etc.) propagate to the caller.
  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Spawns a new teammate with the given configuration.
 * This is the main entry point for teammate spawning, used by both TeammateTool and AgentTool.
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  return handleSpawn(config, context)
}
