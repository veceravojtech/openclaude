/**
 * Teammate Initialization Module
 *
 * Handles initialization for Claude Code instances running as teammates in a swarm.
 * Registers a Stop hook to notify the team leader when the teammate becomes idle.
 */

import type { AppState } from '../../state/AppState.js'
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { jsonStringify } from '../slowOperations.js'
import { getTeammateColor } from '../teammate.js'
import {
  createIdleNotification,
  createTeammateStartupNotification,
  getLastPeerDmSummary,
  writeToMailbox,
} from '../teammateMailbox.js'
import { getAPIProvider } from '../model/providers.js'
import { readDelegatedActivity } from './delegatedActivity.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'

// Refreshed by the existing inbox poll. A new turn invalidates an in-flight
// refresh through the roster's self-active state, without owning a timer.
let idleReporter: (() => Promise<void>) | undefined
export async function refreshTeammateDelegatedActivity(): Promise<void> {
  await idleReporter?.()
}

/**
 * Initializes hooks for a teammate running in a swarm.
 * Should be called early in session startup after AppState is available.
 *
 * Registers a Stop hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: { teamName: string; agentId: string; agentName: string },
  getAppState: () => AppState,
): void {
  const { teamName, agentId, agentName } = teamInfo

  // Read team file to get leader ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId

  // Apply team-wide allowed paths if any exist
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    logForDebugging(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // For absolute paths (starting with /), prepend one / to create //path/** pattern
      // For relative paths, just use path/**
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      logForDebugging(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
      )

      setAppState(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdate(
          prev.toolPermissionContext,
          {
            type: 'addRules',
            rules: [
              {
                toolName: allowedPath.toolName,
                ruleContent,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ),
      }))
    }
  }

  // Find the leader's name from the members array
  const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || 'team-lead'

  // Don't register hook if this agent is the leader
  if (agentId === leadAgentId) {
    logForDebugging(
      '[TeammateInit] This agent is the team leader - skipping idle notification hook',
    )
    return
  }

  // Report the resolved child route as soon as the teammate process has
  // applied its provider environment. This is intentionally a small,
  // credential-free protocol message: the leader can distinguish startup from
  // a pane that merely exists, while endpoints, keys, and custom headers never
  // enter the mailbox or task metadata.
  const startupModel =
    process.env.OPENCLAUDE_TEAMMATE_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    process.env.MISTRAL_MODEL?.trim() ||
    getInitialMainLoopModel()?.trim() ||
    'unknown'
  const provider = getAPIProvider()
  const transport =
    provider === 'firstParty'
      ? 'anthropic-messages'
      : provider === 'codex'
        ? 'codex-responses'
        : provider === 'gemini'
          ? 'gemini'
          : provider === 'mistral'
            ? 'mistral'
            : provider === 'bedrock'
              ? 'bedrock'
              : provider === 'vertex'
                ? 'vertex'
                : provider === 'foundry'
                  ? 'foundry'
                  : process.env.OPENAI_API_FORMAT === 'responses'
                    ? 'openai-responses'
                    : process.env.OPENAI_API_FORMAT === 'responses_compat'
                      ? 'openai-responses-compat'
                      : 'openai-chat-completions'
  // The leader records the dispatch decision on this member's entry before
  // the child boots; echo it so the startup record says why this model.
  const ownDispatch = teamFile.members.find(m => m.name === agentName)?.dispatch
  void writeToMailbox(leadAgentName, {
    from: agentName,
    text: jsonStringify(
      createTeammateStartupNotification(agentName, {
        model: startupModel,
        provider,
        transport,
        ...(ownDispatch ? { dispatch: ownDispatch } : {}),
      }),
    ),
    timestamp: new Date().toISOString(),
    color: getTeammateColor(),
  }).catch(error => {
    logForDebugging(
      `[TeammateInit] Failed to report startup route for ${agentName}: ${error instanceof Error ? error.name : 'unknown error'}`,
    )
  })

  logForDebugging(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  let lastDelegated: string | undefined
  let stopped = false
  let idleSummary: string | undefined
  const reportIdle = async () => {
    if (!stopped) return
    const own = readTeamFile(teamName)?.members.find(m => m.agentId === agentId)
    if (!own || own.isActive !== false) return
    const delegatedActivity = readDelegatedActivity(teamInfo, getAppState().tasks)
    const key = JSON.stringify(delegatedActivity)
    if (key === lastDelegated) return
    lastDelegated = key
    await writeToMailbox(leadAgentName, {
      from: agentName,
      text: jsonStringify(createIdleNotification(agentName, {
        idleReason: delegatedActivity.status === 'none' ? 'available' : 'waiting_for_children',
        delegatedActivity,
        summary: idleSummary,
      })),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    }, teamName)
  }

  // Register Stop hook to notify leader when this teammate stops
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // No matcher - applies to all Stop events
    async (messages, _signal) => {
      await setMemberActive(teamName, agentName, false)
      stopped = true
      idleSummary = getLastPeerDmSummary(messages)
      lastDelegated = undefined
      idleReporter = reportIdle
      await reportIdle()
      logForDebugging(
        `[TeammateInit] Sent idle notification to leader ${leadAgentName}`,
      )
      return true // Don't block the Stop
    },
    'Failed to send idle notification to team leader',
    {
      timeout: 10000,
    },
  )
}

/**
 * Report a provider/runtime failure that ended a teammate turn before the
 * normal Stop hook could run. API-error turns intentionally skip Stop hooks
 * to avoid retry loops, so pane tasks need the same failure signal through
 * the mailbox or they remain marked busy until the watchdog deadline.
 *
 * The reason is deliberately selected from a small fixed vocabulary. Raw
 * provider errors can contain credentials, proxy URLs, or request bodies and
 * must never enter mailbox text or task metadata.
 */
export async function reportTeammateTurnFailure(
  teamName: string,
  agentName: string,
  kind: 'provider' | 'runtime' = 'provider',
): Promise<void> {
  idleReporter = undefined
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  const member = teamFile.members.find(m => m.name === agentName)
  if (!member || member.agentId === teamFile.leadAgentId) return

  const leadMember = teamFile.members.find(
    m => m.agentId === teamFile.leadAgentId,
  )
  const leadAgentName = leadMember?.name || 'team-lead'
  const failureReason =
    kind === 'provider'
      ? 'Teammate provider request failed before completion.'
      : 'Teammate runtime failed before completion.'

  await setMemberActive(teamName, agentName, false)
  await writeToMailbox(leadAgentName, {
    from: agentName,
    text: jsonStringify(
      createIdleNotification(agentName, {
        idleReason: 'failed',
        failureReason,
      }),
    ),
    timestamp: new Date().toISOString(),
    color: getTeammateColor(),
  })
  logForDebugging(
    `[TeammateInit] Reported ${kind} failure for ${agentName} to ${leadAgentName}`,
  )
}
