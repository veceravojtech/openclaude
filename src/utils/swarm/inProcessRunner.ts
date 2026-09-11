/**
 * In-process teammate runner
 *
 * Wraps runAgent() for in-process teammates, providing:
 * - AsyncLocalStorage-based context isolation via runWithTeammateContext()
 * - Progress tracking and AppState updates
 * - Idle notification to leader when complete
 * - Plan mode approval flow support
 * - Cleanup on completion or abort
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { getSystemPrompt } from '../../constants/prompts.js'
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { appendTeammateMessage } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { appendCappedMessage } from '../../tasks/InProcessTeammateTask/types.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  type CustomAgentDefinition,
  isCustomAgent,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { getTeammateSpawnCapError } from '../../tools/AgentTool/teammateReplicas.js'
import {
  registerInterruptionController,
} from '../interruptionTrace.js'
import { awaitClassifierAutoApproval } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { HANDOFF_TEAM_TOOL_NAME } from '../../tools/HandoffTeamTool/constants.js'
import { RECOVER_TEAM_TOOL_NAME } from '../../tools/RecoverTeamTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { TEAMMATE_GRACE_MS } from '../../utils/task/framework.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { createAbortController } from '../abortController.js'
import { type AgentContext, runWithAgentContext } from '../agentContext.js'
import { count } from '../array.js'
import { logForDebugging } from '../debug.js'
import { cloneFileStateCache } from '../fileStateCache.js'
import {
  executeTeammateIdleTimeoutHooks,
  getTeammateIdleTimeoutHookMessage,
} from '../hooks.js'
import {
  getMaxActiveMessagesHardCap,
  isAboveMaxActiveMessagesLimit,
  parseMaxActiveMessagesLimit,
  resolveMaxActiveMessagesLimit,
} from '../maxActiveMessages.js'
import {
  getGlobalConfig,
  isValidMaxMessagesCompactionThreshold,
  normalizeMaxMessagesCompactionThreshold,
} from '../config.js'
import {
  dequeueAllMatching,
  extractTextFromValue,
} from '../messageQueueManager.js'
import {
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../messages.js'
import type { ModelAlias } from '../model/aliases.js'
import {
  applyPermissionUpdates,
  filterPermissionRequestHookUpdates,
  persistPermissionUpdates,
} from '../permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import {
  hasPermissionsToUseTool,
  revalidatePlanModePermissionAllowWithRaceGuard,
} from '../permissions/permissions.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  claimTask,
  getSubTeamTaskListId,
  listTasks,
  type Task,
  unassignTeammateTasks,
  updateTask,
} from '../tasks.js'
import type { TeammateContext } from '../teammateContext.js'
import { runWithTeammateContext } from '../teammateContext.js'
import {
  createIdleNotification,
  getLastPeerDmSummary,
  isPermissionResponse,
  isShutdownRequest,
  markMessageAsReadByIndex,
  readMailbox,
  writeToMailbox,
} from '../teammateMailbox.js'
import { unregisterAgent as unregisterPerfettoAgent } from '../telemetry/perfettoTracing.js'
import { createContentReplacementState } from '../toolResultStorage.js'
import { createAgentId } from '../uuid.js'
import { SUB_TEAM_RECHECK_INTERVAL_MS, TEAM_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import {
  createPermissionRequest,
  sendPermissionRequestViaMailbox,
} from './permissionSync.js'
import {
  cascadeSubTeamTeardown,
  spawnInProcessTeammate,
} from './spawnInProcess.js'
import {
  armSubLeadHandoff,
  formatSuccessorHandoffMessage,
  liveSubTeamMemberNames,
  type PendingSubLeadHandoff,
  SUB_LEAD_HANDOFF_SENDER,
  takeSubLeadHandoff,
  writeSubLeadHandoffFile,
} from './subLeadHandoff.js'
import {
  noteSubLeadFailure,
  resolveUpwardInboxTeam,
} from './subTeamRecovery.js'
import {
  getParentTeamName,
  getSubTeamNameFor,
  readSubTeamLedBy,
  readTeamFileAsync,
  reattachSubTeamToLead,
  removeMemberByAgentId,
} from './teamHelpers.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'
import { createInProcessPermissionAbortCompleter } from './inProcessPermissionAbort.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

const PERMISSION_POLL_INTERVAL_MS = 500

/**
 * Creates a canUseTool function for in-process teammates that properly resolves
 * 'ask' permissions via the UI rather than treating them as denials.
 *
 * Always uses the leader's ToolUseConfirm dialog with a worker badge when
 * the bridge is available, giving teammates the same tool-specific UI
 * (BashPermissionRequest, FileEditToolDiff, etc.) as the leader's own tools.
 *
 * Falls back to the mailbox system when the bridge is unavailable:
 * sends a permission request to the leader's inbox, waits for the response
 * in the teammate's own mailbox.
 */
export function createInProcessCanUseTool(
  identity: TeammateIdentity,
  abortController: AbortController,
  onPermissionWaitMs?: (waitMs: number) => void,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const guardExternalApproval = async (
      finalInput: Record<string, unknown>,
      permissionUpdates: PermissionUpdate[],
    ): Promise<
      | { decision: PermissionDecision; permissionUpdates: [] }
      | { decision: null; permissionUpdates: PermissionUpdate[] }
    > => {
      const planModeWasActive =
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
      const decision =
        await revalidatePlanModePermissionAllowWithRaceGuard(
          tool,
          input,
          finalInput,
          toolUseContext,
          planModeWasActive,
        )
      const enforcePlanMode =
        planModeWasActive ||
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
      if (decision) {
        return { decision, permissionUpdates: [] }
      }
      return {
        decision: null,
        permissionUpdates: filterPermissionRequestHookUpdates(
          permissionUpdates,
          enforcePlanMode ||
            toolUseContext.getAppState().toolPermissionContext.mode === 'plan',
        ),
      }
    }

    const shouldBypassForcedAsk =
      forceDecision?.behavior === 'ask' &&
      toolUseContext.getAppState().toolPermissionContext.mode === 'fullAccess'
    const result =
      forceDecision !== undefined && !shouldBypassForcedAsk
        ? forceDecision
        : await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      )

    // Pass through allow/deny decisions directly
    if (result.behavior !== 'ask') {
      return result
    }

    // For bash commands, try classifier auto-approval before showing leader dialog.
    // Agents await the classifier result (rather than racing it against user
    // interaction like the main agent).
    if (
      feature('BASH_CLASSIFIER') &&
      tool.name === BASH_TOOL_NAME &&
      result.pendingClassifierCheck
    ) {
      const classifierDecision = await awaitClassifierAutoApproval(
        result.pendingClassifierCheck,
        abortController.signal,
        toolUseContext.options.isNonInteractiveSession,
      )
      if (classifierDecision) {
        const approval = await guardExternalApproval(
          input as Record<string, unknown>,
          [],
        )
        if (approval.decision) {
          return approval.decision
        }
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
          decisionReason: classifierDecision,
        }
      }
    }

    // Check if aborted before showing UI
    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const appState = toolUseContext.getAppState()

    const description = await (tool as Tool).description(input as never, {
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
    })

    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

    // Standard path: use ToolUseConfirm dialog with worker badge
    if (setToolUseConfirmQueue) {
      return new Promise<PermissionDecision>(resolve => {
        const permissionStartMs = Date.now()

        // Report permission wait time to the caller so it can be
        // subtracted from the displayed elapsed time.
        const reportPermissionWait = () => {
          onPermissionWaitMs?.(Date.now() - permissionStartMs)
        }

        const completion = createInProcessPermissionAbortCompleter(
          abortController.signal,
          () => {
            reportPermissionWait()
            resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== toolUseID),
            )
          },
        )

        if (completion.isSettled()) {
          return
        }

        setToolUseConfirmQueue(queue => [
          ...queue,
          {
            assistantMessage,
            tool: tool as Tool,
            description,
            input,
            toolUseContext,
            toolUseID,
            permissionResult: result,
            permissionPromptStartTimeMs: permissionStartMs,
            workerBadge: identity.color
              ? { name: identity.agentName, color: identity.color }
              : undefined,
            onUserInteraction() {
              // No-op for teammates (no classifier auto-approval)
            },
            onAbort(source, causalEventId) {
              completion.completeAbort(source, causalEventId)
            },
            async onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
              feedback?: string,
              contentBlocks?: ContentBlockParam[],
            ) {
              if (!completion.claim()) return
              reportPermissionWait()
              const approval = await guardExternalApproval(
                updatedInput,
                permissionUpdates,
              )
              if (approval.decision) {
                resolve(approval.decision)
                return
              }
              const updatesToApply = filterPermissionRequestHookUpdates(
                approval.permissionUpdates,
                toolUseContext.getAppState().toolPermissionContext.mode ===
                  'plan',
              )
              persistPermissionUpdates(updatesToApply)
              // Write back permission updates to the leader's shared context
              if (updatesToApply.length > 0) {
                const setToolPermissionContext =
                  getLeaderSetToolPermissionContext()
                if (setToolPermissionContext) {
                  const currentAppState = toolUseContext.getAppState()
                  const updatedContext = applyPermissionUpdates(
                    currentAppState.toolPermissionContext,
                    updatesToApply,
                  )
                  // Preserve the leader's mode to prevent workers'
                  // transformed 'acceptEdits' context from leaking back
                  // to the coordinator
                  setToolPermissionContext(updatedContext, {
                    preserveMode: true,
                  })
                }
              }
              const trimmedFeedback = feedback?.trim()
              resolve({
                behavior: 'allow',
                updatedInput,
                userModified: false,
                acceptFeedback: trimmedFeedback || undefined,
                ...(contentBlocks &&
                  contentBlocks.length > 0 && { contentBlocks }),
              })
            },
            onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
              if (!completion.claim()) return
              reportPermissionWait()
              const message = feedback
                ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
                : SUBAGENT_REJECT_MESSAGE
              resolve({ behavior: 'ask', message, contentBlocks })
            },
            async recheckPermission() {
              if (completion.isSettled()) return
              const freshResult = await hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )
              if (
                freshResult.behavior === 'allow' &&
                completion.claim()
              ) {
                reportPermissionWait()
                setToolUseConfirmQueue(queue =>
                  queue.filter(item => item.toolUseID !== toolUseID),
                )
                resolve({
                  ...freshResult,
                  updatedInput: input,
                  userModified: false,
                })
              }
            },
          },
        ])
      })
    }

    // Fallback: use mailbox system when leader UI queue is unavailable
    return new Promise<PermissionDecision>(resolve => {
      const request = createPermissionRequest({
        toolName: (tool as Tool).name,
        toolUseId: toolUseID,
        input,
        description,
        permissionSuggestions: result.suggestions,
        workerId: identity.agentId,
        workerName: identity.agentName,
        workerColor: identity.color,
        teamName: identity.teamName,
      })
      let pollInterval: ReturnType<typeof setInterval> | undefined

      function cleanup() {
        if (pollInterval !== undefined) {
          clearInterval(pollInterval)
        }
        unregisterPermissionCallback(request.id)
      }

      const completion = createInProcessPermissionAbortCompleter(
        abortController.signal,
        () => {
          cleanup()
          resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
        },
      )

      if (completion.isSettled()) {
        return
      }

      // Register callback to be invoked when the leader responds
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: toolUseID,
        async onAllow(
          updatedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          _feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          if (!completion.claim()) return
          cleanup()
          const finalInput =
            updatedInput && Object.keys(updatedInput).length > 0
              ? updatedInput
              : input
          const approval = await guardExternalApproval(
            finalInput,
            permissionUpdates,
          )
          if (approval.decision) {
            resolve(approval.decision)
            return
          }
          persistPermissionUpdates(
            filterPermissionRequestHookUpdates(
              approval.permissionUpdates,
              toolUseContext.getAppState().toolPermissionContext.mode ===
                'plan',
            ),
          )
          resolve({
            behavior: 'allow',
            updatedInput: finalInput,
            userModified: false,
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
          })
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          if (!completion.claim()) return
          cleanup()
          const message = feedback
            ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
            : SUBAGENT_REJECT_MESSAGE
          resolve({ behavior: 'ask', message, contentBlocks })
        },
      })

      // Send request to leader's mailbox
      void sendPermissionRequestViaMailbox(request)

      // Poll teammate's mailbox for the response
      pollInterval = setInterval(
        async (completion, identity, request) => {
          if (abortController.signal.aborted) {
            completion.completeSignalAbort()
            return
          }

          const allMessages = await readMailbox(
            identity.agentName,
            identity.teamName,
          )
          for (let i = 0; i < allMessages.length; i++) {
            const msg = allMessages[i]
            if (msg && !msg.read) {
              const parsed = isPermissionResponse(msg.text)
              if (parsed && parsed.request_id === request.id) {
                await markMessageAsReadByIndex(
                  identity.agentName,
                  identity.teamName,
                  i,
                )
                if (parsed.subtype === 'success') {
                  processMailboxPermissionResponse({
                    requestId: parsed.request_id,
                    decision: 'approved',
                    updatedInput: parsed.response?.updated_input,
                    permissionUpdates: parsed.response?.permission_updates,
                  })
                } else {
                  processMailboxPermissionResponse({
                    requestId: parsed.request_id,
                    decision: 'rejected',
                    feedback: parsed.error,
                  })
                }
                return // Callback already resolves the promise
              }
            }
          }
        },
        PERMISSION_POLL_INTERVAL_MS,
        completion,
        identity,
        request,
      )
    })
  }
}

/**
 * Formats a message as <teammate-message> XML for injection into the conversation.
 * This ensures the model sees messages in the same format as tmux teammates.
 */
function formatAsTeammateMessage(
  from: string,
  content: string,
  color?: string,
  summary?: string,
): string {
  const colorAttr = color ? ` color="${color}"` : ''
  const summaryAttr = summary ? ` summary="${summary}"` : ''
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${from}"${colorAttr}${summaryAttr}>\n${content}\n</${TEAMMATE_MESSAGE_TAG}>`
}

/**
 * Configuration for running an in-process teammate.
 */
export type InProcessRunnerConfig = {
  /** Teammate identity for context */
  identity: TeammateIdentity
  /** Task ID in AppState */
  taskId: string
  /** Initial prompt for the teammate. Omit to start idle and wait for work. */
  prompt?: string
  /**
   * Skips the eager task-list claim made once at spawn, before the first poll
   * round. Set for a spawn whose first turn is already decided by a message
   * waiting in its own inbox — the handoff successor, which must open on its
   * predecessor's notes rather than on whatever happens to be unclaimed on the
   * parent's list. The idle loop claims from that list on its next round as
   * usual, so this delays a claim, it never skips the work.
   */
  skipInitialClaim?: boolean
  /** Optional agent definition (for specialized agents) */
  agentDefinition?: CustomAgentDefinition
  /** Teammate context for AsyncLocalStorage */
  teammateContext: TeammateContext
  /** Parent's tool use context */
  toolUseContext: ToolUseContext
  /** Abort controller linked to parent */
  abortController: AbortController
  /** Optional model override for this teammate */
  model?: string
  /** True when model came from an explicit Agent tool model argument. */
  modelWasToolSpecified?: boolean
  /** Original subagent_type for provider-routing resolution. The synthetic agent
   *  definition overwrites agentType with the teammate name, so the route key
   *  must be carried separately for runAgent to resolve the configured route. */
  subagentType?: string
  /** Optional system prompt override for this teammate */
  systemPrompt?: string
  /** How to apply the system prompt: 'replace' or 'append' to default */
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** Tool permissions to auto-allow for this teammate */
  allowedTools?: string[]
  /** Whether this teammate can show permission prompts for unlisted tools.
   * When false (default), unlisted tools are auto-denied. */
  allowPermissionPrompts?: boolean
  /** Short description of the task (used as summary for the initial prompt header) */
  description?: string
  /** request_id of the API call that spawned this teammate, for lineage
   *  tracing on tengu_api_* events. */
  invokingRequestId?: string
  /**
   * Prior conversation this run continues, for a teammate resumed from a dead
   * one's transcript (`respawnSubLead`). Seeds the accumulating history the
   * loop turns into `forkContextMessages`, so the first turn already carries
   * it. Absent for every ordinary spawn, which starts with no history.
   */
  resumedMessages?: Message[]
}

/**
 * Result from running an in-process teammate.
 */
export type InProcessRunnerResult = {
  /** Whether the run completed successfully */
  success: boolean
  /** Error message if failed */
  error?: string
  /** Messages produced by the agent */
  messages: Message[]
}

/**
 * Updates task state in AppState.
 */
function updateTaskState(
  taskId: string,
  updater: (task: InProcessTeammateTaskState) => InProcessTeammateTaskState,
  setAppState: SetAppStateFn,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * Sends a message to the leader's file-based mailbox.
 * Uses the same mailbox system as tmux teammates for consistency.
 *
 * The team is resolved rather than used verbatim, because a member of an
 * ADOPTED sub-team has no lead of its own left: `resolveUpwardInboxTeam`
 * returns `teamName` unchanged in every other case — every root-team teammate
 * without touching the disk — and the caretaker's team when the sub-team's
 * `parentAgentId` names one, so the report reaches an inbox somebody polls.
 */
async function sendMessageToLeader(
  from: string,
  text: string,
  color: string | undefined,
  teamName: string,
): Promise<void> {
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      color,
    },
    await resolveUpwardInboxTeam(teamName),
  )
}

/**
 * Sends idle notification to the leader via file-based mailbox.
 * Uses agentName (not agentId) for consistency with process-based teammates.
 */
async function sendIdleNotification(
  agentName: string,
  agentColor: string | undefined,
  teamName: string,
  options?: {
    idleReason?: 'available' | 'interrupted' | 'failed'
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
  },
): Promise<void> {
  const notification = createIdleNotification(agentName, options)

  await sendMessageToLeader(
    agentName,
    jsonStringify(notification),
    agentColor,
    teamName,
  )
}

/**
 * Find an available task from the team's task list.
 * A task is available if it's pending, has no owner, and is not blocked.
 */
function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

/**
 * Format a task as a prompt for the teammate to work on.
 */
function formatTaskAsPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}: \n\n ${task.subject}`

  if (task.description) {
    prompt += `\n\n${task.description}`
  }

  return prompt
}

/**
 * Try to claim an available task from the team's task list.
 * Returns the formatted prompt if a task was claimed, or undefined if none available.
 */
async function tryClaimNextTask(
  taskListId: string,
  agentName: string,
): Promise<string | undefined> {
  try {
    const tasks = await listTasks(taskListId)
    const availableTask = findAvailableTask(tasks)

    if (!availableTask) {
      return undefined
    }

    const result = await claimTask(taskListId, availableTask.id, agentName)

    if (!result.success) {
      logForDebugging(
        `[inProcessRunner] Failed to claim task #${availableTask.id}: ${result.reason}`,
      )
      return undefined
    }

    // Also set status to in_progress so the UI reflects it immediately
    await updateTask(taskListId, availableTask.id, { status: 'in_progress' })

    logForDebugging(
      `[inProcessRunner] Claimed task #${availableTask.id}: ${availableTask.subject}`,
    )

    return formatTaskAsPrompt(availableTask)
  } catch (err) {
    logForDebugging(`[inProcessRunner] Error checking task list: ${err}`)
    return undefined
  }
}

/**
 * The task list this teammate claims work from.
 *
 * A member of a SUB-team claims from the sub-team's own list, keyed by the
 * sub-team name (`getSubTeamTaskListId`); every other teammate keeps the
 * leader's session-keyed list unchanged, because the lead creates tasks under
 * its session id rather than under the team name.
 *
 * A sub-LEAD is itself a member of the parent team — `identity.teamName` is
 * the parent — so it keeps claiming from the parent's list and never claims
 * the work it just delegated into its own sub-team: it hands work downward,
 * it does not take it back.
 */
function resolveTeammateTaskListId(identity: TeammateIdentity): string {
  return getParentTeamName(identity.teamName) !== undefined
    ? getSubTeamTaskListId(identity.teamName)
    : identity.parentSessionId
}

/**
 * Resolves, and caches, the sub-team this teammate leads so the poll loop can
 * read that team's `team-lead` inbox as well as its own.
 *
 * The NAME is pure (`getSubTeamNameFor`) and settled once: a teammate that
 * cannot have a sub-team never touches the disk. Leadership itself has to be
 * re-read, because the sub-team may be created AFTER the teammate started —
 * but not on every 500ms round, which would be a team-file read per poll for
 * the whole idle life of every teammate. A short TTL is enough: the only
 * writer of this teammate's sub-team file is this teammate's own TeamCreate
 * call, which runs inside a turn and therefore cannot run while the poll loop
 * is waiting, so the answer is already settled by the time the loop next asks
 * and the TTL only bounds how stale a concurrently-deleted team may look.
 */
function createSubTeamInboxResolver(identity: TeammateIdentity): {
  resolve(): Promise<string | undefined>
} {
  const subTeamName = getSubTeamNameFor(identity.agentId, identity.agentName)
  let checkedAtMs: number | undefined
  let leads = false

  return {
    async resolve(): Promise<string | undefined> {
      if (!subTeamName) return undefined
      const now = Date.now()
      if (
        checkedAtMs === undefined ||
        now - checkedAtMs >= SUB_TEAM_RECHECK_INTERVAL_MS
      ) {
        checkedAtMs = now
        try {
          leads =
            (await readSubTeamLedBy({
              agentId: identity.agentId,
              name: identity.agentName,
              isTeammate: true,
            })) !== null
        } catch (err) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} could not read its sub-team file: ${err}`,
          )
          leads = false
        }
      }
      return leads ? subTeamName : undefined
    },
  }
}

/**
 * Result of waiting for messages.
 */
type WaitResult =
  | {
      type: 'shutdown_request'
      request: ReturnType<typeof isShutdownRequest>
      originalMessage: string
    }
  | {
      type: 'new_message'
      message: string
      from: string
      color?: string
      summary?: string
    }
  | {
      type: 'aborted'
    }
  | {
      /** The idle policy ended the wait: the runner exits cleanly. */
      type: 'idle_shutdown'
      reason: 'idle_timeout' | 'hook'
      idleMs: number
      detail?: string
      /**
       * Set by the TeammateIdleTimeout hook's `handoff` action: the run ends
       * to be REPLACED, so the sub-team is handed to a successor instead of
       * being torn down. Absent for every ordinary idle shutdown, which is
       * why this stays the same wait result rather than a new one.
       */
      intent?: 'handoff'
    }

const DEFAULT_TEAMMATE_IDLE_TIMEOUT_MS = 300_000
/** Pseudo-sender for prompts a TeammateIdleTimeout hook hands to the teammate. */
const IDLE_TIMEOUT_HOOK_SENDER = 'idle-timeout-hook'
/** Pseudo-sender for a background agent's completion drained off the queue. */
const TASK_NOTIFICATION_SENDER = 'task-notification'

/**
 * Parses a millisecond env var for the idle policy. Unset or blank yields the
 * default (undefined disables); anything but a positive integer disables.
 */
function parseIdleMsEnv(
  raw: string | undefined,
  defaultMs: number | undefined,
): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return defaultMs
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

type IdleTimeoutHookOutcome =
  | { kind: 'wake'; message: string }
  | { kind: 'shutdown'; reason?: string }
  | { kind: 'handoff'; reason?: string }

type IdlePolicy = {
  /** Returns a WaitResult when the policy ends the wait, else undefined. */
  check(idleMs: number): WaitResult | undefined
  /**
   * Called once the wait has ended for any reason: aborts an in-flight hook
   * and persists an undelivered wake message to the teammate's own mailbox.
   */
  dispose(): void
}

/**
 * Idle policy for one idle period of a teammate. Fires TeammateIdleTimeout
 * hooks after CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS of continuous idleness
 * (occurrence 1, 2, ...) without blocking the poll loop and never
 * concurrently with itself; the next occurrence is scheduled one interval
 * after the previous hook FINISHED, so a slow hook cannot re-fire back to
 * back. A blocking hook result wakes the teammate with the text as its next
 * prompt; a JSON action ends the wait — `shutdown` ends the teammate, and
 * `handoff` retires a teammate that leads a sub-team in favour of a
 * same-identity successor started on a handoff file (a teammate that leads no
 * sub-team ignores it and keeps waiting). Once
 * CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS has passed and no in-flight hook
 * could still assign work, the wait ends with an idle shutdown; that check
 * runs before a new occurrence is launched, so an always-running hook cannot
 * starve it. A shutdown request from the lead needs no special handling: the
 * mailbox scan returns it before the policy is consulted, and the sticky
 * task.shutdownRequested flag (never cleared after a rejected request) must
 * not silence the policy for the rest of the teammate's life.
 */
function createIdlePolicy(
  identity: TeammateIdentity,
  permissionMode: string | undefined,
): IdlePolicy {
  const hookIntervalMs = parseIdleMsEnv(
    process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS,
    DEFAULT_TEAMMATE_IDLE_TIMEOUT_MS,
  )
  const shutdownMs = parseIdleMsEnv(
    process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS,
    undefined,
  )
  const hookAbort = new AbortController()
  let occurrence = 0
  let hookInFlight = false
  let pendingOutcome: IdleTimeoutHookOutcome | undefined
  /** Idle time at which the next hook occurrence may fire. */
  let nextHookAtMs = hookIntervalMs
  /** Idle time seen by the most recent check(); anchors rescheduling. */
  let lastIdleMs = 0

  /**
   * A wake message the poll loop will never deliver (the wait ended for
   * another reason first) is written to the teammate's own mailbox so it is
   * picked up on the next idle round instead of being lost: a stateful hook
   * may have recorded the work as assigned.
   */
  function persistWake(message: string): void {
    try {
      void writeToMailbox(
        identity.agentName,
        {
          from: IDLE_TIMEOUT_HOOK_SENDER,
          text: message,
          timestamp: new Date().toISOString(),
        },
        identity.teamName,
      ).catch((err: unknown) => {
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} could not persist TeammateIdleTimeout wake message: ${err}`,
        )
      })
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} could not persist TeammateIdleTimeout wake message: ${err}`,
      )
    }
  }

  async function runHook(idleMs: number): Promise<void> {
    let wakeMessage: string | undefined
    let ending: { kind: 'shutdown' | 'handoff'; reason?: string } | undefined
    try {
      for await (const result of executeTeammateIdleTimeoutHooks({
        teammateName: identity.agentName,
        teamName: identity.teamName,
        agentId: identity.agentId,
        idleMs,
        occurrence,
        permissionMode,
        signal: hookAbort.signal,
      })) {
        if (result.blockingError) {
          wakeMessage = getTeammateIdleTimeoutHookMessage(result.blockingError)
        }
        const action = result.teammateIdleTimeoutAction
        if (action?.action === 'shutdown' || action?.action === 'handoff') {
          ending = { kind: action.action, reason: action.reason }
        }
      }
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} TeammateIdleTimeout hook failed: ${err}`,
      )
    } finally {
      hookInFlight = false
      // Reschedule relative to when this hook finished, not to idle start.
      if (hookIntervalMs !== undefined) {
        nextHookAtMs = lastIdleMs + hookIntervalMs
      }
    }
    if (hookAbort.signal.aborted) {
      // The wait already ended; do not drop work the hook handed over.
      if (wakeMessage !== undefined) persistWake(wakeMessage)
      return
    }
    // Work handed over by one hook beats a shutdown OR a handoff asked by
    // another: both endings are only meant for a teammate nobody has work for.
    if (wakeMessage !== undefined) {
      pendingOutcome = { kind: 'wake', message: wakeMessage }
    } else if (ending) {
      pendingOutcome = { kind: ending.kind, reason: ending.reason }
    }
  }

  return {
    check(idleMs) {
      lastIdleMs = idleMs
      // 1. Deliver what the previous hook decided.
      const outcome = pendingOutcome
      pendingOutcome = undefined
      if (outcome?.kind === 'wake') {
        return {
          type: 'new_message',
          message: outcome.message,
          from: IDLE_TIMEOUT_HOOK_SENDER,
        }
      }
      if (outcome?.kind === 'shutdown' || outcome?.kind === 'handoff') {
        return {
          type: 'idle_shutdown',
          reason: 'hook',
          idleMs,
          detail: outcome.reason,
          ...(outcome.kind === 'handoff' ? { intent: 'handoff' as const } : {}),
        }
      }
      // 2. Idle shutdown, evaluated BEFORE launching another occurrence so a
      //    hook that is always in flight cannot starve it.
      if (shutdownMs !== undefined && !hookInFlight && idleMs >= shutdownMs) {
        return { type: 'idle_shutdown', reason: 'idle_timeout', idleMs }
      }
      // 3. Next hook occurrence.
      if (
        hookIntervalMs !== undefined &&
        nextHookAtMs !== undefined &&
        !hookInFlight &&
        idleMs >= nextHookAtMs
      ) {
        occurrence++
        hookInFlight = true
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} idle for ${idleMs}ms, firing TeammateIdleTimeout hooks (occurrence ${occurrence})`,
        )
        void runHook(idleMs)
      }
      return undefined
    },
    dispose() {
      hookAbort.abort()
      if (pendingOutcome?.kind === 'wake') {
        persistWake(pendingOutcome.message)
      }
      pendingOutcome = undefined
    },
  }
}

/**
 * Waits for new prompts or shutdown request.
 * Polls the teammate's mailbox every 500ms, checking for:
 * - Shutdown request from leader (returned to caller for model decision)
 * - New messages/prompts from leader
 * - Abort signal
 * - The idle policy (TeammateIdleTimeout hooks, idle self-shutdown)
 *
 * This keeps the teammate alive in 'idle' state instead of terminating.
 * Does NOT auto-approve shutdown - the model should make that decision.
 */
async function waitForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  taskListId: string,
): Promise<WaitResult> {
  const task = getAppState().tasks[taskId]
  const idlePolicy = createIdlePolicy(
    identity,
    task?.type === 'in_process_teammate' ? task.permissionMode : undefined,
  )
  try {
    return await pollForNextPromptOrShutdown(
      identity,
      abortController,
      taskId,
      getAppState,
      setAppState,
      taskListId,
      idlePolicy,
    )
  } finally {
    idlePolicy.dispose()
  }
}

async function pollForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  taskListId: string,
  idlePolicy: IdlePolicy,
): Promise<WaitResult> {
  const POLL_INTERVAL_MS = 500
  const subTeamInbox = createSubTeamInboxResolver(identity)

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} starting poll loop (abort=${abortController.signal.aborted})`,
  )

  const idleStartedAt = Date.now()
  let pollCount = 0
  while (!abortController.signal.aborted) {
    // Check for in-memory pending messages on every iteration (from transcript viewing)
    const appState = getAppState()
    const task = appState.tasks[taskId]
    if (
      task &&
      task.type === 'in_process_teammate' &&
      task.pendingUserMessages.length > 0
    ) {
      const message = task.pendingUserMessages[0]! // Safe: checked length > 0
      // Pop the message from the queue
      setAppState(prev => {
        const prevTask = prev.tasks[taskId]
        if (!prevTask || prevTask.type !== 'in_process_teammate') {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...prevTask,
              pendingUserMessages: prevTask.pendingUserMessages.slice(1),
            },
          },
        }
      })
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} found pending user message (poll #${pollCount})`,
      )
      return {
        type: 'new_message',
        message,
        from: 'user',
      }
    }

    // Wait before next poll (skip on first iteration to check immediately)
    if (pollCount > 0) {
      await sleep(POLL_INTERVAL_MS)
    }
    pollCount++

    // Check for abort
    if (abortController.signal.aborted) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} aborted while waiting (poll #${pollCount})`,
      )
      return { type: 'aborted' }
    }

    // Check for messages in mailbox
    logForDebugging(
      `[inProcessRunner] ${identity.agentName} poll #${pollCount}: checking mailbox`,
    )
    try {
      // Read all messages and scan unread for shutdown requests first.
      // Shutdown requests are prioritized over regular messages to prevent
      // starvation when peer-to-peer messages flood the queue.
      const allMessages = await readMailbox(
        identity.agentName,
        identity.teamName,
      )

      // Scan all unread messages for shutdown requests (highest priority).
      // readMailbox() already reads all messages from disk, so this scan
      // adds only ~1-2ms of JSON parsing overhead.
      let shutdownIndex = -1
      let shutdownParsed: ReturnType<typeof isShutdownRequest> = null
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (m && !m.read) {
          const parsed = isShutdownRequest(m.text)
          if (parsed) {
            shutdownIndex = i
            shutdownParsed = parsed
            break
          }
        }
      }

      if (shutdownIndex !== -1) {
        const msg = allMessages[shutdownIndex]!
        const skippedUnread = count(
          allMessages.slice(0, shutdownIndex),
          m => !m.read,
        )
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} received shutdown request from ${shutdownParsed?.from} (prioritized over ${skippedUnread} unread messages)`,
        )
        await markMessageAsReadByIndex(
          identity.agentName,
          identity.teamName,
          shutdownIndex,
        )
        return {
          type: 'shutdown_request',
          request: shutdownParsed,
          originalMessage: msg.text,
        }
      }

      // A background agent this teammate spawned has finished. LocalAgentTask
      // stamps the spawner's agent id on the notification, and nothing else
      // will ever drain it: the coordinator's REPL/print drains take only
      // unaddressed commands, and query.ts's mid-turn gate runs only while a
      // turn is in flight — this teammate is between turns.
      //
      // Priority: after task.pendingUserMessages (checked at the top of the
      // loop) and after the mailbox shutdown scan above, before team-lead and
      // FIFO peer messages. A result this teammate itself asked for outranks
      // unrelated peer chatter, but must never pre-empt a shutdown request or
      // something typed into its own view. Sitting inside the mailbox read
      // also means a round whose readMailbox threw retries in 500ms rather
      // than delivering a notification ahead of a shutdown it failed to see.
      const notifications = dequeueAllMatching(
        cmd =>
          cmd.mode === 'task-notification' && cmd.agentId === identity.agentId,
      )
      if (notifications.length > 0) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} drained ${notifications.length} task notification(s) addressed to it`,
        )
        return {
          type: 'new_message',
          // Concatenated, never dropped: dequeueAllMatching has already taken
          // every one of these off the queue, so a notification left out here
          // would be lost outright.
          message: notifications
            .map(cmd => extractTextFromValue(cmd.value))
            .join('\n\n'),
          from: TASK_NOTIFICATION_SENDER,
        }
      }

      // No shutdown request found. Prioritize team-lead messages over peer
      // messages — the leader represents user intent and coordination, so
      // their messages should not be starved behind peer-to-peer chatter.
      // Fall back to FIFO for peer messages.
      let selectedIndex = -1

      // Check for unread team-lead messages first
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (m && !m.read && m.from === TEAM_LEAD_NAME) {
          selectedIndex = i
          break
        }
      }

      // Fall back to first unread message (any sender)
      if (selectedIndex === -1) {
        selectedIndex = allMessages.findIndex(m => !m.read)
      }

      if (selectedIndex !== -1) {
        const msg = allMessages[selectedIndex]
        if (msg) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} received new message from ${msg.from} (index ${selectedIndex})`,
          )
          await markMessageAsReadByIndex(
            identity.agentName,
            identity.teamName,
            selectedIndex,
          )
          return {
            type: 'new_message',
            message: msg.text,
            from: msg.from,
            color: msg.color,
            summary: msg.summary,
          }
        }
      }

      // A sub-lead's SECOND inbox: `team-lead` of the sub-team this teammate
      // leads, where its children write their idle notifications, shutdown
      // replies and DMs. Nothing else polls that inbox — `team-lead@<sub-team>`
      // is a roster entry with no process behind it.
      //
      // ORDERING (graded, and tested): this read sits deliberately LAST of the
      // message sources — after task.pendingUserMessages, after the own-inbox
      // shutdown scan, after background-agent task notifications and after the
      // own-inbox team-lead-then-FIFO pick, and still before the task-list
      // claim and the idle policy. A sub-lead's obligations UPWARD outrank its
      // coordination duties DOWNWARD: its own lead speaks for user intent, and
      // a shutdown addressed to this teammate must never wait behind a child's
      // report. Inside the sub-team inbox the order is plain FIFO: every child
      // is a peer there and none of them is this teammate's lead.
      //
      // There is deliberately NO isShutdownRequest scan over this inbox, and
      // that is a correctness rule rather than an omission. A child asking for
      // permission to stop writes a shutdown REQUEST into exactly this inbox
      // (sendShutdownRequestToMailbox). The scan on the own inbox means
      // "someone is telling ME to shut down"; running it here would turn a
      // child's request for approval into an order that shuts the sub-lead
      // itself down. It arrives as an ordinary message so the model can
      // approve or reject it.
      const subTeamName = await subTeamInbox.resolve()
      if (subTeamName) {
        const subTeamMessages = await readMailbox(TEAM_LEAD_NAME, subTeamName)
        const unreadIndex = subTeamMessages.findIndex(m => !m.read)
        const subTeamMessage = subTeamMessages[unreadIndex]
        if (subTeamMessage) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} received sub-team message from ${subTeamMessage.from} in ${subTeamName} (index ${unreadIndex})`,
          )
          await markMessageAsReadByIndex(
            TEAM_LEAD_NAME,
            subTeamName,
            unreadIndex,
          )
          return {
            type: 'new_message',
            message: subTeamMessage.text,
            from: subTeamMessage.from,
            color: subTeamMessage.color,
            summary: subTeamMessage.summary,
          }
        }
      }
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} poll error: ${err}`,
      )
      // Continue polling even if one read fails
    }

    // Check the team's task list for unclaimed tasks
    const taskPrompt = await tryClaimNextTask(taskListId, identity.agentName)
    if (taskPrompt) {
      return {
        type: 'new_message',
        message: taskPrompt,
        from: 'task-list',
      }
    }

    // Nothing to do this round: let the idle policy fire TeammateIdleTimeout
    // hooks or end the wait with an idle shutdown.
    const idleResult = idlePolicy.check(Date.now() - idleStartedAt)
    if (idleResult) {
      return idleResult
    }
  }

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} exiting poll loop (abort=${abortController.signal.aborted}, polls=${pollCount})`,
  )
  return { type: 'aborted' }
}

/**
 * The children of `subTeamName` that are still working: an in-process teammate
 * task whose identity names that team and which is neither parked idle nor in
 * a terminal state. Names, not ids, because the list goes into a log line a
 * human reads.
 */
function findBusySubTeamChildren(
  appState: AppState,
  subTeamName: string,
): string[] {
  const busy: string[] = []
  for (const task of Object.values(appState.tasks)) {
    if (task.type !== 'in_process_teammate') continue
    if (task.identity.teamName !== subTeamName) continue
    if (task.isIdle || isTerminalTaskStatus(task.status)) continue
    busy.push(task.identity.agentName)
  }
  return busy
}

/**
 * Cleans up after an idle self-shutdown so the teammate leaves no trace a
 * kill or an approved shutdown would have removed: the team-file member (as
 * killInProcessTeammate does), the teamContext entry, and its unfinished
 * tasks (as the lead does on an approved shutdown), then tells the lead. The
 * runner's completion tail then marks the task completed, evicts it and emits
 * the SDK terminated event exactly as for a normal exit.
 */
async function finalizeIdleShutdown(
  identity: TeammateIdentity,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  taskListId: string,
  result: Extract<WaitResult, { type: 'idle_shutdown' }>,
): Promise<boolean> {
  // A sub-lead does not get to go idle out from under its own team. Its
  // children report INTO its sub-team inbox and claim from its task list, so
  // tearing it down while any of them is still working orphans them: their
  // idle notifications and shutdown requests would land in an inbox nobody
  // polls again. Refuse while any child is busy; allow once they are all
  // parked idle or terminal, and then take the sub-team with it — a refusal
  // returns the teammate to waiting rather than ending its runner.
  const subTeamName = getSubTeamNameFor(identity.agentId, identity.agentName)
  if (subTeamName) {
    let leadsSubTeam = false
    try {
      leadsSubTeam =
        (await readSubTeamLedBy({
          agentId: identity.agentId,
          name: identity.agentName,
          isTeammate: true,
        })) !== null
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} could not read its sub-team file before idle shutdown: ${err}`,
      )
    }
    if (leadsSubTeam) {
      const busy = findBusySubTeamChildren(getAppState(), subTeamName)
      if (busy.length > 0) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} refusing idle shutdown: ${busy.length} member(s) of ${subTeamName} still working (${busy.join(', ')})`,
        )
        return false
      }
      // Allowed to go, so the sub-team goes too. Its members are all parked
      // idle or terminal, and this runner is the only thing that polls their
      // inbox and hands out their task list, so leaving them behind would be
      // the orphan the gate above exists to prevent. Same teardown a kill
      // performs, and it runs BEFORE this teammate leaves its own team file
      // so a failure cannot half-retire it.
      await cascadeSubTeamTeardown(subTeamName, getAppState(), setAppState, {
        source: 'idle_shutdown',
      })
    }
  }

  const idleSeconds = Math.round(result.idleMs / 1000)
  const cause =
    result.reason === 'hook'
      ? `TeammateIdleTimeout hook requested shutdown${result.detail ? `: ${result.detail}` : ''}`
      : `idle for ${idleSeconds}s, over CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS`
  logForDebugging(
    `[inProcessRunner] ${identity.agentId} shutting down after idle timeout (${cause})`,
  )

  try {
    removeMemberByAgentId(identity.teamName, identity.agentId)
  } catch (err) {
    logForDebugging(
      `[inProcessRunner] ${identity.agentId} failed to leave team file: ${err}`,
    )
  }
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev
    if (!(identity.agentId in prev.teamContext.teammates)) return prev
    const { [identity.agentId]: _, ...remainingTeammates } =
      prev.teamContext.teammates
    return {
      ...prev,
      teamContext: { ...prev.teamContext, teammates: remainingTeammates },
    }
  })

  let notificationMessage = `${identity.agentName} has shut down.`
  try {
    notificationMessage = (
      await unassignTeammateTasks(
        taskListId,
        identity.agentId,
        identity.agentName,
        'shutdown',
      )
    ).notificationMessage
  } catch (err) {
    logForDebugging(
      `[inProcessRunner] ${identity.agentId} failed to unassign tasks: ${err}`,
    )
  }
  await sendMessageToLeader(
    identity.agentName,
    `${notificationMessage} Reason: shut down after idle timeout (${cause}).`,
    identity.color,
    identity.teamName,
  )
  return true
}

/**
 * Ends a sub-lead's run so a SUCCESSOR can take its seat — the `handoff`
 * action's half of the retirement.
 *
 * Deliberately not `finalizeIdleShutdown`: a handoff keeps everything that
 * function removes. No `cascadeSubTeamTeardown` (the sub-team is the thing
 * being handed over), no busy-children gate (handing over while children work
 * is the normal case), no `removeMemberByAgentId` and no teamContext eviction
 * (the successor is the same `name@team` and inherits the roster seat, with
 * its model, colour and mode), no `unassignTeammateTasks` (work assigned to
 * this id stays assigned to it). What it does is write the handoff document
 * and arm the request the completion tail reads.
 *
 * Returns false — "keep waiting", exactly like a refused idle shutdown — when
 * the teammate leads no sub-team or the document cannot be written: there is
 * then nothing to hand over, and ending the run instead would be a shutdown
 * the hook never asked for.
 */
async function finalizeSubLeadHandoff(
  identity: TeammateIdentity,
  getAppState: () => AppState,
  result: Extract<WaitResult, { type: 'idle_shutdown' }>,
): Promise<boolean> {
  const subTeamName = getSubTeamNameFor(identity.agentId, identity.agentName)
  let leadsSubTeam = false
  if (subTeamName) {
    try {
      leadsSubTeam =
        (await readSubTeamLedBy({
          agentId: identity.agentId,
          name: identity.agentName,
          isTeammate: true,
        })) !== null
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} could not read its sub-team file before a handoff: ${err}`,
      )
    }
  }
  if (!subTeamName || !leadsSubTeam) {
    logForDebugging(
      `[inProcessRunner] ${identity.agentId} ignoring a TeammateIdleTimeout handoff action: it leads no sub-team`,
    )
    return false
  }

  try {
    const handoffPath = await writeSubLeadHandoffFile({
      subTeamName,
      leadAgentId: identity.agentId,
      source: 'idle-timeout-hook',
      reason: result.detail,
      members: liveSubTeamMemberNames(getAppState().tasks, subTeamName),
      // A handoff deliberately does NOT unassign this lead's own work (see
      // above), and the successor inherits the name it is owned under — so
      // the document has to name it, or the successor never learns of it.
      ownAssignments: {
        taskListId: resolveTeammateTaskListId(identity),
        owner: identity.agentName,
      },
    })
    armSubLeadHandoff({
      subTeamName,
      leadAgentId: identity.agentId,
      handoffPath,
      source: 'idle-timeout-hook',
      ...(result.detail ? { reason: result.detail } : {}),
    })
    logForDebugging(
      `[inProcessRunner] ${identity.agentId} retiring to hand ${subTeamName} over; notes at ${handoffPath}`,
    )
    return true
  } catch (err) {
    logForDebugging(
      `[inProcessRunner] ${identity.agentId} could not write the handoff notes for ${subTeamName}, staying: ${err}`,
    )
    return false
  }
}

/**
 * Puts the successor in the seat the run just left — the other half of a
 * handoff, run from the completion tail.
 *
 * This is the ONLY point at which the seat is provably free: the tail has
 * already written `status: 'completed'` for the outgoing task, and every
 * liveness check in the system filters terminal tasks out
 * (`hasLiveTaskFor`/`findBusySubTeamChildren` on `isTerminalTaskStatus`, the
 * spawn caps on `status === 'running'`). Spawning any earlier would race the
 * outgoing task's own eviction.
 *
 * Mirrors `respawnSubLead` — identity derived from the sub-team's name, the
 * parent roster read for model/colour/mode, the spawn cap honoured, re-attach
 * LAST — with one deliberate difference: no transcript is resumed. A fresh
 * context is the point of a handoff, and the document is the whole
 * inheritance. Best-effort throughout: a handoff that cannot be completed
 * leaves the sub-team unled and SAYS so, because silence is the one outcome a
 * lead cannot act on.
 */
async function completeSubLeadHandoff(
  identity: TeammateIdentity,
  toolUseContext: ToolUseContext,
  pending: PendingSubLeadHandoff,
): Promise<void> {
  const { setAppState } = toolUseContext
  // Set the moment the successor's runner is started. Everything after that
  // point is re-attach and notification, and a failure there must not tell the
  // lead the seat is empty: RecoverTeam would then refuse (a live lead) or, out
  // of the adopted corner, spawn a second runner under the same id.
  let successorStarted = false
  const warn = async (reason: string): Promise<void> => {
    logForDebugging(
      `[inProcessRunner] Handoff of ${pending.subTeamName} could not be completed: ${reason}`,
    )
    // The fallback notifier is the last thing here that can throw, and it runs
    // AFTER the completion tail marked this run terminal and evicted its task:
    // `writeToMailbox` awaits an `ensureInboxDir` mkdir outside its own
    // try/catch, so an escaping rejection would run the runner's FAILURE tail
    // against a task that is already gone — a second, contradictory `failed`
    // bookend, and an `orphanedLead` record written beside a live successor.
    // Warning the lead is best effort; re-entering the failure tail is not.
    try {
      await sendMessageToLeader(
        identity.agentName,
        successorStarted
          ? `${identity.agentName} handed sub-team "${pending.subTeamName}" to a successor that is running with the same identity (${identity.agentId}), but the re-attach or the notification failed (${reason}) — check its team file. The handoff notes are at ${pending.handoffPath}.`
          : `${identity.agentName} retired to hand sub-team "${pending.subTeamName}" over, but no successor could be started (${reason}). Its members are still running and their reports are reaching nobody: recover it with RecoverTeam (action "respawn" to start a lead, "adopt" to take the members yourself). The handoff notes are at ${pending.handoffPath}.`,
        identity.color,
        identity.teamName,
      )
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] Could not tell the lead of ${identity.teamName} that the handoff of ${pending.subTeamName} needed attention: ${err}`,
      )
    }
  }

  try {
    const capError = getTeammateSpawnCapError({
      isTeammateSpawn: true,
      teamName: identity.teamName,
      tasks: toolUseContext.getAppState().tasks,
    })
    if (capError) {
      await warn(capError)
      return
    }

    // The roster entry survives the handoff (nothing removed it), so it is
    // still the durable record of how this seat was spawned.
    const spawnRecord = (
      await readTeamFileAsync(identity.teamName)
    )?.members.find(m => m.agentId === identity.agentId)
    const color = identity.color ?? spawnRecord?.color
    const planModeRequired =
      identity.planModeRequired ?? spawnRecord?.planModeRequired ?? false
    const model = spawnRecord?.model
    // A sub-lead spawned as a custom agent comes back as one. The roster keeps
    // the `agent_type` it was spawned with, and the definition behind that type
    // is resolved from the live set exactly as the ordinary spawn path does
    // (`spawnMultiAgent.ts`). Without it the successor keeps the seat but loses
    // the system prompt, tools and memory that defined the agent in it.
    const subagentType = spawnRecord?.agentType
    let agentDefinition: CustomAgentDefinition | undefined
    if (subagentType) {
      const found = toolUseContext.options.agentDefinitions?.activeAgents.find(
        a => a.agentType === subagentType,
      )
      if (found && isCustomAgent(found)) {
        agentDefinition = found
      }
      logForDebugging(
        `[inProcessRunner] Successor of ${identity.agentId}: agent_type=${subagentType}, definition found=${!!agentDefinition}`,
      )
    }

    // FIRST, before anything is registered. `writeToMailbox` awaits an
    // `ensureInboxDir` mkdir outside its own try/catch, so a read-only or full
    // disk rejects here; writing before the spawn is what keeps that failure
    // clean — the catch below warns the lead and NOTHING is left registered,
    // rather than a never-started `running` task under this id that the caps
    // would count, `RecoverTeam respawn` would refuse as a live lead, and a
    // kill would cascade the sub-team away.
    //
    // The inbox is keyed by `name@team` and the retiring run is already
    // terminal, so nobody else is polling it: the successor inherits this
    // message, and anything else left unread, when it starts below.
    await writeToMailbox(
      identity.agentName,
      {
        from: SUB_LEAD_HANDOFF_SENDER,
        text: formatSuccessorHandoffMessage(pending),
        timestamp: new Date().toISOString(),
        color,
      },
      identity.teamName,
    )

    const spawn = await spawnInProcessTeammate(
      {
        name: identity.agentName,
        teamName: identity.teamName,
        color,
        planModeRequired,
        model,
      },
      { setAppState },
    )
    if (
      !spawn.success ||
      !spawn.taskId ||
      !spawn.teammateContext ||
      !spawn.abortController
    ) {
      await warn(spawn.error ?? `could not spawn ${identity.agentId}`)
      return
    }

    // Idle: no prompt, so the successor registers as waiting for work. Its
    // first turn is the handoff message written above — but only because
    // `skipInitialClaim` drops the eager spawn-time task-list claim. A sub-lead
    // claims from its PARENT's list, so without the flag an unowned pending
    // task there would become the successor's first turn instead, spent on
    // unrelated work with none of the sub-team's context. The poll loop reads
    // this teammate's own inbox before it claims, so the notes win; a pending
    // parent-list task is claimed on the next round as usual.
    startInProcessTeammate({
      identity: {
        agentId: spawn.agentId,
        agentName: identity.agentName,
        teamName: identity.teamName,
        color,
        planModeRequired,
        parentSessionId: spawn.teammateContext.parentSessionId,
      },
      taskId: spawn.taskId,
      description: `successor sub-lead of ${pending.subTeamName}`,
      model,
      agentDefinition,
      subagentType,
      skipInitialClaim: true,
      teammateContext: spawn.teammateContext,
      // Same reason the ordinary spawn path strips them: the teammate builds
      // its own history, and the parent's conversation would otherwise be
      // pinned for its whole lifetime.
      toolUseContext: { ...toolUseContext, messages: [] },
      abortController: spawn.abortController,
    })
    successorStarted = true

    // LAST, and U9's primitive rather than a second writer of the field: it
    // clears any orphan record, takes the sub-team back if it was adopted
    // during the unled window, and refuses on a directory collision.
    const reattach = await reattachSubTeamToLead(
      pending.subTeamName,
      identity.agentId,
    )
    logForDebugging(
      `[inProcessRunner] Handed ${pending.subTeamName} from ${identity.agentId} to a successor; re-attach ok=${reattach.ok}`,
    )
    await sendMessageToLeader(
      identity.agentName,
      `${identity.agentName} handed sub-team "${pending.subTeamName}" to a fresh successor with the same identity (${identity.agentId}) and retired. Its members, task list and inboxes were left untouched. Handoff notes: ${pending.handoffPath}.` +
        (pending.reason?.trim() ? ` Reason: ${pending.reason.trim()}.` : '') +
        (reattach.ok
          ? ''
          : ` WARNING: the sub-team could not be re-attached (${reattach.reason}) — check its team file.`),
      color,
      identity.teamName,
    )
  } catch (err) {
    await warn(`${err}`)
  }
}

/**
 * Turns a wait result into the teammate's next prompt, mirroring it into
 * task.messages for transcript display where needed. Returns undefined when
 * the runner should exit.
 */
function resolveNextPrompt(
  identity: TeammateIdentity,
  taskId: string,
  setAppState: SetAppStateFn,
  waitResult: WaitResult,
): string | undefined {
  switch (waitResult.type) {
    case 'shutdown_request': {
      // Pass shutdown request to model for decision
      // Format as teammate-message for consistency with how tmux teammates receive it
      // The model will use approveShutdown or rejectShutdown tool
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} received shutdown request - passing to model`,
      )
      const nextPrompt = formatAsTeammateMessage(
        waitResult.request?.from || 'team-lead',
        waitResult.originalMessage,
      )
      // Add shutdown request to task.messages for transcript display
      appendTeammateMessage(
        taskId,
        createUserMessage({ content: nextPrompt }),
        setAppState,
      )
      return nextPrompt
    }

    case 'new_message': {
      // New prompt from leader or teammate
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} received new message from ${waitResult.from}`,
      )
      // Messages from the user should be plain text (not wrapped in XML)
      // Messages from other teammates get XML wrapper for identification
      if (waitResult.from === 'user') {
        return waitResult.message
      }
      // A drained task notification is a system message, not peer chatter: it
      // goes to the model verbatim, so the <task-notification> envelope reads
      // exactly as it does on the coordinator. Unlike 'user' messages — which
      // injectUserMessageToTeammate has already mirrored — it still has to be
      // added to the transcript here.
      if (waitResult.from === TASK_NOTIFICATION_SENDER) {
        appendTeammateMessage(
          taskId,
          createUserMessage({ content: waitResult.message }),
          setAppState,
        )
        return waitResult.message
      }
      const nextPrompt = formatAsTeammateMessage(
        waitResult.from,
        waitResult.message,
        waitResult.color,
        waitResult.summary,
      )
      // Add to task.messages for transcript display (only for non-user messages)
      // Messages from 'user' come from pendingUserMessages which are already
      // added by injectUserMessageToTeammate
      appendTeammateMessage(
        taskId,
        createUserMessage({ content: nextPrompt }),
        setAppState,
      )
      return nextPrompt
    }

    case 'aborted':
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} aborted while waiting`,
      )
      return undefined

    case 'idle_shutdown':
      // finalizeIdleShutdown has already cleaned up; the runner exits its
      // loop and completes like any other termination.
      return undefined
  }
}

/**
 * Parks the teammate: flags the task idle, fires onIdleCallbacks, tells the
 * lead once per idle transition, then blocks until the next prompt, shutdown
 * request, or abort. Returns the next prompt to run, or undefined when the
 * runner should exit. Shared by the post-turn path and the idle-spawn path so
 * a teammate spawned without a prompt is parked exactly like one that has
 * just finished a turn.
 */
async function idleUntilNextPrompt(params: {
  identity: TeammateIdentity
  taskId: string
  abortController: AbortController
  toolUseContext: ToolUseContext
  allMessages: Message[]
  workWasAborted: boolean
  /** Notify the lead even if the task is already flagged idle (idle spawn:
   *  the task is registered idle, but the lead has not been told yet). */
  forceIdleNotification?: boolean
}): Promise<string | undefined> {
  const {
    identity,
    taskId,
    abortController,
    toolUseContext,
    allMessages,
    workWasAborted,
    forceIdleNotification = false,
  } = params
  const { setAppState } = toolUseContext

  // Check if already idle before updating (to skip duplicate notification)
  const prevAppState = toolUseContext.getAppState()
  const prevTask = prevAppState.tasks[taskId]
  const wasAlreadyIdle =
    !forceIdleNotification &&
    prevTask?.type === 'in_process_teammate' &&
    prevTask.isIdle

  // Mark task as idle (NOT completed) and notify any waiters
  updateTaskState(
    taskId,
    task => {
      // Call any registered idle callbacks
      task.onIdleCallbacks?.forEach(cb => cb())
      return { ...task, isIdle: true, onIdleCallbacks: [] }
    },
    setAppState,
  )

  // Note: We do NOT automatically send the teammate's response to the leader.
  // Teammates should use the Teammate tool to communicate with the leader.
  // This matches process-based teammates where output is not visible to the leader.

  // Only send idle notification on transition to idle (not if already idle)
  if (!wasAlreadyIdle) {
    await sendIdleNotification(
      identity.agentName,
      identity.color,
      identity.teamName,
      {
        idleReason: workWasAborted ? 'interrupted' : 'available',
        summary: getLastPeerDmSummary(allMessages),
      },
    )
  } else {
    logForDebugging(
      `[inProcessRunner] Skipping duplicate idle notification for ${identity.agentName}`,
    )
  }

  logForDebugging(
    `[inProcessRunner] ${identity.agentId} finished prompt, waiting for next`,
  )

  // Wait for next message or shutdown.
  //
  // A REFUSED idle shutdown is not an exit: finalizeIdleShutdown turns a
  // sub-lead down while its children are still working, and the teammate goes
  // back to waiting instead of ending its runner. Re-entering the wait is what
  // re-arms the idle clock — each call builds a fresh idle policy anchored at a
  // fresh Date.now() — so the policy cannot fire again until another full idle
  // period has passed, rather than spinning on the refusal. An abort ends the
  // wait with `aborted` and leaves the loop as before.
  //
  // The fresh policy also restarts the TeammateIdleTimeout occurrence counter
  // at 1, and that is deliberate: `occurrence` numbers the hook firings within
  // ONE idle period, and the period a refusal starts is a new one by the same
  // clock the hook's `idleMs` is measured against. Carrying the count across
  // refusals while resetting the clock would hand hooks an occurrence that no
  // longer matches the idleMs beside it.
  const taskListId = resolveTeammateTaskListId(identity)
  let waitResult = await waitForNextPromptOrShutdown(
    identity,
    abortController,
    taskId,
    toolUseContext.getAppState,
    setAppState,
    taskListId,
  )
  while (waitResult.type === 'idle_shutdown') {
    // A handoff is a retirement WITH a successor, so it takes the additive
    // path beside the idle shutdown rather than through it: same end of the
    // run, none of the teardown.
    const ended =
      waitResult.intent === 'handoff'
        ? await finalizeSubLeadHandoff(
            identity,
            toolUseContext.getAppState,
            waitResult,
          )
        : await finalizeIdleShutdown(
            identity,
            toolUseContext.getAppState,
            setAppState,
            taskListId,
            waitResult,
          )
    if (ended) break
    waitResult = await waitForNextPromptOrShutdown(
      identity,
      abortController,
      taskId,
      toolUseContext.getAppState,
      setAppState,
      taskListId,
    )
  }

  return resolveNextPrompt(identity, taskId, setAppState, waitResult)
}

/**
 * Runs an in-process teammate with a continuous prompt loop.
 *
 * Executes runAgent() within the teammate's AsyncLocalStorage context,
 * tracks progress, updates task state, sends idle notification on completion,
 * then waits for new prompts or shutdown requests.
 *
 * Unlike background tasks, teammates stay alive and can receive multiple prompts.
 * The loop only exits on abort or after shutdown is approved by the model.
 *
 * @param config - Runner configuration
 * @returns Result with messages and success status
 */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const {
    identity,
    taskId,
    prompt,
    skipInitialClaim,
    description,
    agentDefinition,
    teammateContext,
    toolUseContext,
    abortController,
    model,
    modelWasToolSpecified,
    subagentType,
    systemPrompt,
    systemPromptMode,
    allowedTools,
    allowPermissionPrompts,
    invokingRequestId,
    resumedMessages,
  } = config
  const { setAppState } = toolUseContext

  logForDebugging(
    `[inProcessRunner] Starting agent loop for ${identity.agentId}`,
  )

  // Create AgentContext for analytics attribution
  const agentContext: AgentContext = {
    agentId: identity.agentId,
    parentSessionId: identity.parentSessionId,
    agentName: identity.agentName,
    teamName: identity.teamName,
    agentColor: identity.color,
    planModeRequired: identity.planModeRequired,
    isTeamLead: false,
    agentType: 'teammate',
    invokingRequestId,
    invocationKind: 'spawn',
    invocationEmitted: false,
  }

  // Build system prompt based on systemPromptMode
  let teammateSystemPrompt: string
  if (systemPromptMode === 'replace' && systemPrompt) {
    teammateSystemPrompt = systemPrompt
  } else {
    const fullSystemPromptParts = await getSystemPrompt(
      toolUseContext.options.tools,
      toolUseContext.options.mainLoopModel,
      undefined,
      toolUseContext.options.mcpClients,
    )

    const systemPromptParts = [
      ...fullSystemPromptParts,
      TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
    ]

    // If custom agent definition provided, append its prompt
    if (agentDefinition) {
      const customPrompt = agentDefinition.getSystemPrompt()
      if (customPrompt) {
        systemPromptParts.push(`\n# Custom Agent Instructions\n${customPrompt}`)
      }

      // Log agent memory loaded event for in-process teammates
      if (agentDefinition.memory) {
        logEvent('tengu_agent_memory_loaded', {
          ...(process.env.USER_TYPE === 'ant'
            ? {
                agent_type:
                  agentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          scope:
            agentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source:
            'in-process-teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }
    }

    // Append mode: add provided system prompt after default
    if (systemPromptMode === 'append' && systemPrompt) {
      systemPromptParts.push(systemPrompt)
    }

    teammateSystemPrompt = systemPromptParts.join('\n')
  }

  // Resolve agent definition - use full system prompt with teammate addendum
  // IMPORTANT: Set permissionMode to 'default' so teammates always get full tool
  // access regardless of the leader's permission mode.
  const fallbackModel = agentDefinition?.model ?? model
  const resolvedAgentDefinition: CustomAgentDefinition = {
    agentType: identity.agentName,
    whenToUse: `In-process teammate: ${identity.agentName}`,
    getSystemPrompt: () => teammateSystemPrompt,
    // Inject team-essential tools so teammates can always respond to
    // shutdown requests, send messages, and coordinate via the task list,
    // even with explicit tool lists
    tools: agentDefinition?.tools
      ? [
          ...new Set([
            ...agentDefinition.tools,
            SEND_MESSAGE_TOOL_NAME,
            TEAM_CREATE_TOOL_NAME,
            TEAM_DELETE_TOOL_NAME,
            // A sub-lead is the recovery authority for its OWN sub-teams, so
            // it needs this for the same reason it needs TeamCreate.
            RECOVER_TEAM_TOOL_NAME,
            // Only the sub-lead itself can hand its own sub-team over.
            HANDOFF_TEAM_TOOL_NAME,
            TASK_CREATE_TOOL_NAME,
            TASK_GET_TOOL_NAME,
            TASK_LIST_TOOL_NAME,
            TASK_UPDATE_TOOL_NAME,
          ]),
        ]
      : ['*'],
    source: 'projectSettings',
    permissionMode: 'default',
    // Propagate model from custom agent definition so getAgentModel()
    // can use it as a fallback when no tool-level model is specified. If the
    // spawn layer supplied a default teammate model, keep it as a fallback
    // without treating it like an explicit Agent tool model override.
    ...(fallbackModel ? { model: fallbackModel } : {}),
  }

  // All messages across all prompts. A teammate resumed from a dead one's
  // transcript starts with that conversation already in the buffer, which is
  // all it takes for the first turn to carry it: the loop below hands the
  // buffer to runAgent as `forkContextMessages` on every iteration.
  const allMessages: Message[] = resumedMessages ? [...resumedMessages] : []
  /**
   * The tool-context agent id of the turn currently running, kept for the
   * failure path: a teammate's transcript is one file per turn, keyed on this
   * id, so it is the only key a later resume can reach the conversation with.
   */
  let lastTurnAgentId: string | undefined
  // Wrap initial prompt with XML for proper styling in transcript view.
  // Undefined for an idle spawn: the teammate waits for its first message.
  const wrappedInitialPrompt =
    prompt === undefined
      ? undefined
      : formatAsTeammateMessage('team-lead', prompt, undefined, description)
  let currentPrompt = wrappedInitialPrompt ?? ''
  let shouldExit = false

  // Try to claim an available task immediately so the UI can show activity
  // from the very start. The idle loop handles claiming for subsequent tasks.
  // The list is the leader's session id for a root-team teammate (the leader
  // creates tasks under its session id, not the team name) and the sub-team's
  // own list for a member of a sub-team — see resolveTeammateTaskListId.
  // A prompted spawn is driven by the lead's prompt, so the claimed task's
  // text is not used here; an idle spawn has no other prompt, so the claimed
  // task becomes its first turn (see below) — which is exactly why
  // skipInitialClaim exists: a spawn whose first turn is already waiting in
  // its own inbox must not have it pre-empted here.
  const claimedTaskPrompt = skipInitialClaim
    ? undefined
    : await tryClaimNextTask(
        resolveTeammateTaskListId(identity),
        identity.agentName,
      )

  try {
    // Add initial prompt to task.messages for display (wrapped with XML)
    if (wrappedInitialPrompt !== undefined) {
      updateTaskState(
        taskId,
        task => ({
          ...task,
          messages: appendCappedMessage(
            task.messages,
            createUserMessage({ content: wrappedInitialPrompt }),
          ),
        }),
        setAppState,
      )
    }

    // Per-teammate content replacement state. The while-loop below calls
    // runAgent repeatedly over an accumulating `allMessages` buffer (which
    // carries FULL original tool result content, not previews — query() yields
    // originals, enforcement is non-mutating). Without persisting state across
    // iterations, each call gets a fresh empty state from createSubagentContext
    // and makes holistic replace-globally-largest decisions, diverging from
    // earlier iterations' incremental frozen-first decisions → wire prefix
    // differs → cache miss. Gated on parent to inherit feature-flag-off.
    let teammateReplacementState = toolUseContext.contentReplacementState
      ? createContentReplacementState()
      : undefined

    // Progress tracker spans the whole teammate lifetime (multiple prompts).
    // Resetting per prompt iteration dropped prior prompts' output tokens and
    // tool-use counts from `task.progress`, so the leader's pill + spinner
    // aggregate read zero/low values between turns even after long sessions
    // (#475). The Claude API returns `input_tokens` as cumulative for that
    // request (includes prior history sent via `forkContextMessages`), so
    // `latestInputTokens` already represents the running context cost — we
    // just need `cumulativeOutputTokens` and `toolUseCount` to keep their
    // running totals across iterations.
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )

    // Idle spawn: no initial turn. Queued task-list work claimed above is
    // taken up immediately; otherwise park the teammate exactly as after a
    // turn (idle flag, callbacks, 'available' notification, wait) so the
    // lead learns it is ready and the first message starts the first turn.
    // Mirrors the loop guard below: a teammate killed while the setup above
    // was awaiting must not touch the killed task or tell the lead it is
    // available, exactly as a prompted spawn killed in the same window.
    if (wrappedInitialPrompt === undefined && !abortController.signal.aborted) {
      const firstPrompt =
        claimedTaskPrompt !== undefined
          ? resolveNextPrompt(identity, taskId, setAppState, {
              type: 'new_message',
              message: claimedTaskPrompt,
              from: 'task-list',
            })
          : await idleUntilNextPrompt({
              identity,
              taskId,
              abortController,
              toolUseContext,
              allMessages,
              workWasAborted: false,
              // The task is registered idle at spawn, but the lead has not
              // been told yet.
              forceIdleNotification: true,
            })
      if (firstPrompt === undefined) {
        shouldExit = true
      } else {
        currentPrompt = firstPrompt
      }
    }

    // Main teammate loop - runs until abort or shutdown approved
    while (!abortController.signal.aborted && !shouldExit) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} processing prompt: ${currentPrompt.substring(0, 50)}...`,
      )

      // Create a per-turn abort controller for this iteration.
      // This allows Escape to stop current work without killing the whole teammate.
      // The lifecycle abortController still kills the whole teammate if needed.
      const currentWorkAbortController = createAbortController()
      registerInterruptionController(currentWorkAbortController, {
        subsystem: 'in_process_teammate',
        controllerRole: 'subagent-turn',
        subagentId: identity.agentId,
        querySource: 'agent:custom',
      })

      // Store the work controller in task state so UI can abort it
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController }),
        setAppState,
      )

      // Mint this turn's tool-context agent id here instead of letting runAgent
      // mint it internally, so the teammate's ambient context can publish it
      // (see turnAgentId on TeammateContext). Everything a tool sees is then
      // attributable: context.agentId === turnAgentId is the teammate's own
      // call, anything else is a subagent spawned inside the turn. Minted per
      // turn and label-free, exactly as runAgent's own createAgentId() — so the
      // per-turn transcript, metadata and cleanup paths keyed on it are
      // unchanged.
      const turnAgentId = createAgentId()
      lastTurnAgentId = turnAgentId
      const turnTeammateContext = { ...teammateContext, turnAgentId }

      // Prepare prompt messages for this iteration
      // For the first iteration, start fresh
      // For subsequent iterations, pass accumulated messages as context
      const userMessage = createUserMessage({ content: currentPrompt })
      const promptMessages: Message[] = [userMessage]

      // Check if compaction is needed before building context
      let contextMessages = allMessages
      const tokenCount = tokenCountWithEstimation(allMessages)
      const configuredMessageThreshold =
        getGlobalConfig().maxMessagesCompactionThreshold
      const legacyMessageThreshold = parseMaxActiveMessagesLimit(
        process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES,
      )
      const hasExplicitMessageCountThreshold =
        configuredMessageThreshold !== undefined &&
        isValidMaxMessagesCompactionThreshold(configuredMessageThreshold) &&
        configuredMessageThreshold !== 'off'
      const hasLegacyMessageCountThreshold =
        (configuredMessageThreshold === undefined ||
          configuredMessageThreshold === 'off') &&
        legacyMessageThreshold > 0
      const shouldApplyMessageCountThreshold =
        isAutoCompactEnabled() ||
        hasExplicitMessageCountThreshold ||
        hasLegacyMessageCountThreshold
      const activeMessageLimit = shouldApplyMessageCountThreshold
        ? resolveMaxActiveMessagesLimit(
            configuredMessageThreshold === undefined && legacyMessageThreshold > 0
              ? undefined
              : normalizeMaxMessagesCompactionThreshold(configuredMessageThreshold),
            process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES,
          )
        : getMaxActiveMessagesHardCap()
      const tokenThreshold = getAutoCompactThreshold(
        toolUseContext.options.mainLoopModel,
      )
      const shouldCompactForTokens =
        isAutoCompactEnabled() && tokenCount > tokenThreshold
      const shouldCompactForMessages = isAboveMaxActiveMessagesLimit(
        allMessages.length,
        activeMessageLimit,
      )
      if (shouldCompactForTokens || shouldCompactForMessages) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} compacting history (${tokenCount} tokens, ${allMessages.length} messages)`,
        )
        // Create an isolated copy of toolUseContext so that compaction
        // does not clear the main session's readFileState cache or
        // trigger the main session's UI callbacks.
        const isolatedContext: ToolUseContext = {
          ...toolUseContext,
          readFileState: cloneFileStateCache(toolUseContext.readFileState),
          onCompactProgress: undefined,
          setStreamMode: undefined,
        }
        const compactedSummary = await compactConversation(
          allMessages,
          isolatedContext,
          {
            systemPrompt: asSystemPrompt([]),
            userContext: {},
            systemContext: {},
            toolUseContext: isolatedContext,
            forkContextMessages: [],
          },
          true, // suppressFollowUpQuestions
          undefined, // customInstructions
          true, // isAutoCompact
        )
        contextMessages = buildPostCompactMessages(compactedSummary)
        // Reset microcompact state since full compact replaces all
        // messages — old tool IDs are no longer relevant
        resetMicrocompactState()
        // Reset content replacement state — compact replaces all messages
        // so old tool_use_ids are gone. Stale Map entries are harmless
        // (UUID keys never match) but accumulate memory over long runs.
        if (teammateReplacementState) {
          teammateReplacementState = createContentReplacementState()
        }
        // Update allMessages in place with compacted version
        allMessages.length = 0
        allMessages.push(...contextMessages)

        // Mirror compaction into task.messages — otherwise the AppState
        // mirror grows unbounded (500 turns = 500+ messages, 10-50MB).
        // Replace with the compacted messages, matching allMessages.
        updateTaskState(
          taskId,
          task => ({ ...task, messages: [...contextMessages, userMessage] }),
          setAppState,
        )
      }

      // Pass previous messages as context to preserve conversation history
      // allMessages accumulates all previous messages (user + assistant) from prior iterations
      const forkContextMessages =
        contextMessages.length > 0 ? [...contextMessages] : undefined

      // Add the user message to allMessages so it's included in future context
      // This ensures the full conversation (user + assistant turns) is preserved
      allMessages.push(userMessage)

      const iterationMessages: Message[] = []

      // Read current permission mode from task state (may have been cycled by leader via Shift+Tab)
      const currentAppState = toolUseContext.getAppState()
      const currentTask = currentAppState.tasks[taskId]
      const currentPermissionMode =
        currentTask && currentTask.type === 'in_process_teammate'
          ? currentTask.permissionMode
          : 'default'
      const iterationAgentDefinition = {
        ...resolvedAgentDefinition,
        permissionMode: currentPermissionMode,
      }

      // Track if this iteration was interrupted by work abort (not lifecycle abort)
      let workWasAborted = false

      // Run agent within contexts
      await runWithTeammateContext(turnTeammateContext, async () => {
        return runWithAgentContext(agentContext, async () => {
          // Mark task as running (not idle)
          updateTaskState(
            taskId,
            task => ({ ...task, status: 'running', isIdle: false }),
            setAppState,
          )

          // Run the normal agent loop - same runAgent() used by AgentTool/subagents.
          // This calls query() internally, so we share the core API infrastructure.
          // Pass forkContextMessages to preserve conversation history across prompts.
          // In-process teammates are async but run in the same process as the leader,
          // so they CAN show permission prompts (unlike true background agents).
          // Use currentWorkAbortController so Escape stops this turn only, not the teammate.
          for await (const message of runAgent({
            agentDefinition: iterationAgentDefinition,
            promptMessages,
            toolUseContext,
            canUseTool: createInProcessCanUseTool(
              identity,
              currentWorkAbortController,
              (waitMs: number) => {
                updateTaskState(
                  taskId,
                  task => ({
                    ...task,
                    totalPausedMs: (task.totalPausedMs ?? 0) + waitMs,
                  }),
                  setAppState,
                )
              },
            ),
            isAsync: true,
            canShowPermissionPrompts: allowPermissionPrompts ?? true,
            forkContextMessages,
            querySource: 'agent:custom',
            override: {
              abortController: currentWorkAbortController,
              agentId: turnAgentId,
            },
            model: modelWasToolSpecified
              ? (model as ModelAlias | undefined)
              : undefined,
            agentName: identity.agentName,
            routingSubagentType: subagentType,
            preserveToolUseResults: true,
            availableTools: toolUseContext.options.tools,
            allowedTools,
            contentReplacementState: teammateReplacementState,
          })) {
            // Check lifecycle abort first (kills whole teammate)
            if (abortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} lifecycle aborted`,
              )
              break
            }

            // Check work abort (stops current turn only)
            if (currentWorkAbortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} current work aborted (Escape pressed)`,
              )
              workWasAborted = true
              break
            }

            if (
              message.type === 'system' &&
              'subtype' in message &&
              message.subtype === 'compact_boundary'
            ) {
              allMessages.length = 0
              resetMicrocompactState()
              if (teammateReplacementState) {
                teammateReplacementState = createContentReplacementState()
              }
              updateTaskState(
                taskId,
                task => ({ ...task, messages: [] }),
                setAppState,
              )
            }
            iterationMessages.push(message)
            allMessages.push(message)

            updateProgressFromMessage(
              tracker,
              message,
              resolveActivity,
              toolUseContext.options.tools,
            )
            const progress = getProgressUpdate(tracker)

            updateTaskState(
              taskId,
              task => {
                // Track in-progress tool use IDs for animation in transcript view
                let inProgressToolUseIDs = task.inProgressToolUseIDs
                if (message.type === 'assistant') {
                  for (const block of message.message.content) {
                    if (block.type === 'tool_use') {
                      inProgressToolUseIDs = new Set([
                        ...(inProgressToolUseIDs ?? []),
                        block.id,
                      ])
                    }
                  }
                } else if (message.type === 'user') {
                  const content = message.message.content
                  if (Array.isArray(content)) {
                    for (const block of content) {
                      if (
                        typeof block === 'object' &&
                        'type' in block &&
                        block.type === 'tool_result'
                      ) {
                        if (inProgressToolUseIDs) {
                          inProgressToolUseIDs = new Set(inProgressToolUseIDs)
                          inProgressToolUseIDs.delete(block.tool_use_id)
                        }
                      }
                    }
                  }
                }

                return {
                  ...task,
                  progress,
                  messages: appendCappedMessage(task.messages, message),
                  inProgressToolUseIDs,
                }
              },
              setAppState,
            )
          }

          return { success: true, messages: iterationMessages }
        })
      })

      // Clear the work controller from state (it's no longer valid)
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController: undefined }),
        setAppState,
      )

      // Check if lifecycle aborted during agent run (kills whole teammate)
      if (abortController.signal.aborted) {
        break
      }

      // If work was aborted (Escape), log it and add interrupt message, then continue to idle state
      if (workWasAborted) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} work interrupted, returning to idle`,
        )

        // Add interrupt message to teammate's messages so it appears in their scrollback
        const interruptMessage = createAssistantAPIErrorMessage({
          content: ERROR_MESSAGE_USER_ABORT,
        })
        updateTaskState(
          taskId,
          task => ({
            ...task,
            messages: appendCappedMessage(task.messages, interruptMessage),
          }),
          setAppState,
        )
      }

      // Park the teammate and wait for the next prompt or shutdown
      const nextPrompt = await idleUntilNextPrompt({
        identity,
        taskId,
        abortController,
        toolUseContext,
        allMessages,
        workWasAborted,
      })
      if (nextPrompt === undefined) {
        shouldExit = true
      } else {
        currentPrompt = nextPrompt
      }
    }

    // Mark as completed when exiting the loop
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        // killInProcessTeammate may have already set status:killed +
        // notified:true + cleared fields. Don't overwrite (would flip
        // killed → completed and double-emit the SDK bookend).
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'completed' as const,
          notified: true,
          endTime: Date.now(),
          // Keep the row for TEAMMATE_GRACE_MS instead of evicting here: the
          // retain/grace pair is what isRetainedOrWithinGrace reads, and the one
          // eviction funnel (the lazy GC in utils/task/framework) collects the
          // task once the deadline passes. See types.ts on the pair.
          retain: false,
          evictAfter: Date.now() + TEAMMATE_GRACE_MS,
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
          onIdleCallbacks: [],
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // notified:true pre-set → no XML notification → print.ts won't emit
    // the SDK task_notification. Close the task_started bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'completed', {
        toolUseId,
        summary: identity.agentId,
      })
    }

    unregisterPerfettoAgent(identity.agentId)

    // A handoff ends here rather than where it was decided: the task is
    // terminal now, so the successor can take this seat without racing this
    // run's own eviction. A no-op for every ordinary run — nothing is armed.
    //
    // TAKE first, act second, mirroring the failure tail's discard-then-record
    // below. The request MUST be disarmed whichever way this run ended: the
    // registry is keyed on the stable `name@team` id, so a handoff overtaken
    // by a kill (`alreadyTerminal`, and that path has already cascaded the
    // sub-team away) would otherwise still be armed for the NEXT run under
    // that id — a RecoverTeam respawn, or a fresh teammate of the same name —
    // which would then spawn a successor nobody asked for, point it at a
    // handoff document `cleanupTeamTree` has deleted, and re-attach a
    // sub-team that is no longer there.
    const pendingHandoff = takeSubLeadHandoff(identity.agentId)
    if (pendingHandoff && !alreadyTerminal) {
      // Guarded, and this is the point of the guard: the task is already
      // `completed`, evicted and bookended, so anything escaping here would run
      // the failure tail below against a task that no longer exists —
      // `updateTaskState` returns `prev` for a missing task, so `alreadyTerminal`
      // would stay false and a second, contradictory `failed` bookend would go
      // out, followed by an `orphanedLead` record beside a live successor. A
      // handoff that could not be completed says so through `warn`, not by
      // failing a run that succeeded.
      try {
        await completeSubLeadHandoff(identity, toolUseContext, pendingHandoff)
      } catch (err) {
        logForDebugging(
          `[inProcessRunner] Handoff of ${pendingHandoff.subTeamName} threw after ${identity.agentId} had already completed: ${err}`,
        )
      }
    }

    return { success: true, messages: allMessages }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    logForDebugging(
      `[inProcessRunner] Agent ${identity.agentId} failed: ${errorMessage}`,
    )

    // Mark task as failed and notify any waiters
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'failed' as const,
          notified: true,
          error: errorMessage,
          isIdle: true,
          endTime: Date.now(),
          // Same 30s grace as the completion tail above.
          retain: false,
          evictAfter: Date.now() + TEAMMATE_GRACE_MS,
          onIdleCallbacks: [],
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // notified:true pre-set → no XML notification → close SDK bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'failed', {
        toolUseId,
        summary: identity.agentId,
      })
    }

    // Send idle notification with failure via file-based mailbox
    await sendIdleNotification(
      identity.agentName,
      identity.color,
      identity.teamName,
      {
        idleReason: 'failed',
        completedStatus: 'failed',
        failureReason: errorMessage,
      },
    )

    // This is the one terminal path with no sub-team cascade, and that is
    // deliberate: a crash should be recoverable, not destructive. But the
    // notification above only says THIS teammate failed — if it led a
    // sub-team, that team's members are still working and still writing an
    // inbox nobody will read again. Record the orphan and say so, so the lead
    // can adopt or respawn (RecoverTeam) rather than discover it by silence.
    // A teammate that led nothing does nothing here.
    // A run that crashed mid-handoff is an orphan, not a handoff: drop the
    // armed request so no successor is started behind the failure, and let
    // the detection below record the sub-team as recoverable instead.
    takeSubLeadHandoff(identity.agentId)

    await noteSubLeadFailure({
      identity,
      turnAgentId: lastTurnAgentId,
      reason: errorMessage,
      tasks: toolUseContext.getAppState().tasks,
    })

    unregisterPerfettoAgent(identity.agentId)
    return {
      success: false,
      error: errorMessage,
      messages: allMessages,
    }
  }
}

/**
 * Starts an in-process teammate in the background.
 *
 * This is the main entry point called after spawn. It starts the agent
 * execution loop in a fire-and-forget manner.
 *
 * @param config - Runner configuration
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  // Extract agentId before the closure so the catch handler doesn't retain
  // the full config object (including toolUseContext) while the promise is
  // pending - which can be hours for a long-running teammate.
  const agentId = config.identity.agentId
  void runInProcessTeammate(config).catch(error => {
    logForDebugging(`[inProcessRunner] Unhandled error in ${agentId}: ${error}`)
  })
}
