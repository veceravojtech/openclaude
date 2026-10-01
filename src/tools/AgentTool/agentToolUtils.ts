import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import {
  clearFinalReview,
  fileGapTasks,
  type ParsedFinalReview,
  parseFinalReview,
  parseReviewIdentity,
  recordFinalReview,
} from '../../utils/finalReviews.js'
import {
  clearVerdict,
  parseVerdict,
  recordVerdict,
} from '../../utils/verificationVerdicts.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import {
  AGENT_TOOL_NAME,
  FINAL_REVIEW_AGENT_TYPE,
  LEGACY_AGENT_TOOL_NAME,
  VERIFICATION_AGENT_TYPE,
} from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const toolSpec of agentTools) {
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    // Set only for built-in verification runs: the verdict parsed from the
    // final text and recorded for TaskUpdate's requiresVerification gate.
    verificationVerdict: z
      .enum(['PASS', 'FAIL', 'PARTIAL', 'MISSING'])
      .optional(),
    // Whether verificationVerdict was actually persisted. False means the
    // write failed and the gate will see no verdict for this agentId.
    verificationVerdictRecorded: z.boolean().optional(),
    verificationVerdictError: z.string().optional(),
    // Set only for built-in final-reviewer runs: the result parsed from the
    // final text (after the checkout self-check) and recorded for
    // TaskUpdate's requiresFinalReview gate.
    finalReview: z.enum(['DONE', 'GAPS', 'MISSING']).optional(),
    finalReviewRecorded: z.boolean().optional(),
    finalReviewError: z.string().optional(),
    // Why the result is MISSING (format or checkout self-check failure).
    finalReviewReason: z.string().optional(),
    // The resolved sha the reviewer's checkout was at.
    finalReviewCommit: z.string().optional(),
    // Ids of the tasks filed for the GAPs of a GAPS result.
    finalReviewGapTaskIds: z.array(z.string()).optional(),
    finalReviewGapTaskError: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

export function countToolUses(messages: MessageType[]): number {
  const blockedStepLimitToolUseIds = new Set<string>()
  for (const m of messages) {
    if (
      m.type !== 'user' ||
      !m.isAgentStepLimitToolResult ||
      !Array.isArray(m.message.content)
    ) {
      continue
    }
    for (const block of m.message.content) {
      if (block.type === 'tool_result') {
        blockedStepLimitToolUseIds.add(String(block.tool_use_id))
      }
    }
  }

  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (
          block.type === 'tool_use' &&
          !blockedStepLimitToolUseIds.has(block.id)
        ) {
          count++
        }
      }
    }
  }
  return count
}

export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
    // Final-reviewer runs only: the checkout the reviewer was given, used
    // by recordFinalReviewIfApplicable's self-check.
    finalReview?: FinalReviewTarget
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content.
  let content = lastAssistantMessage.message.content.filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  const totalToolUseCount = countToolUses(agentMessages)

  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}

/**
 * True only for the genuine built-in verification agent. Project, user,
 * plugin, or SDK agents can override a built-in by name (loadAgentsDir), so
 * the agentType alone must not be able to mint a verdict.
 */
export function isBuiltInVerificationRun(identity: {
  agentType: string | undefined
  isBuiltInAgent: boolean
}): boolean {
  return (
    identity.agentType === VERIFICATION_AGENT_TYPE && identity.isBuiltInAgent
  )
}

/**
 * Called before a built-in verification run starts (fresh or resumed):
 * deletes any verdict already on file for this agentId, so an old PASS can
 * never outlive a newer run that fails, errors, or cannot record.
 *
 * Throws when the old record exists but cannot be removed; the caller must
 * then refuse to start the run rather than run with a stale verdict on file.
 */
export async function clearVerificationVerdictBeforeRun(
  agentId: string,
  identity: { agentType: string | undefined; isBuiltInAgent: boolean },
): Promise<void> {
  if (!isBuiltInVerificationRun(identity)) return
  try {
    await clearVerdict(agentId)
  } catch (error) {
    throw new Error(
      `Cannot start verification agent ${agentId}: its previous verdict record could not be cleared (${errorMessage(error)}). Refusing to run while a possibly stale verdict is on file.`,
    )
  }
}

/**
 * For a successfully finished run of the built-in verification agent, parse
 * the `VERDICT:` line from its final text and persist it under its agentId so
 * a task flagged `requiresVerification` can cite it via `metadata.verifiedBy`.
 * Call it only on the success path (after finalizeAgentTool): aborted or
 * errored runs record nothing, and since the record was cleared when the run
 * started, the gate then reports "no verdict recorded".
 *
 * Sets `result.verificationVerdict` to the parsed verdict and
 * `result.verificationVerdictRecorded` to whether it was persisted (with
 * `verificationVerdictError` on failure), so the caller is told the truth.
 *
 * Never throws: a failure to record is logged and the Agent tool continues.
 */
export async function recordVerificationVerdictIfApplicable(
  result: AgentToolResult,
  identity: { isBuiltInAgent: boolean },
): Promise<void> {
  if (
    !isBuiltInVerificationRun({
      agentType: result.agentType,
      isBuiltInAgent: identity.isBuiltInAgent,
    })
  ) {
    return
  }
  try {
    const verdict = parseVerdict(extractTextContent(result.content, '\n'))
    result.verificationVerdict = verdict
    await recordVerdict({ agentId: result.agentId, verdict })
    result.verificationVerdictRecorded = true
    logForDebugging(
      `[verificationVerdicts] recorded ${verdict} for verifier ${result.agentId}`,
    )
  } catch (error) {
    result.verificationVerdictRecorded = false
    result.verificationVerdictError = errorMessage(error)
    logForDebugging(
      `[verificationVerdicts] failed to record verdict for ${result.agentId}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // Belt and braces: the record was cleared when the run started, but make
    // sure no older verdict survives a failed write either.
    await clearVerdict(result.agentId).catch(() => {})
  }
}

/**
 * One line describing a verification run's verdict for the caller: whether
 * it was recorded and how to cite it, or that it was NOT recorded and why.
 * Undefined for non-verification runs.
 */
export function formatVerificationVerdictLine(
  result: AgentToolResult,
): string | undefined {
  if (!result.verificationVerdict) return undefined
  if (result.verificationVerdictRecorded) {
    return `verificationVerdict: ${result.verificationVerdict} (recorded for this agentId; to complete a task with requiresVerification, set metadata.verifiedBy: '${result.agentId}' — only PASS allows completion)`
  }
  return `verificationVerdict: ${result.verificationVerdict} (NOT recorded: ${result.verificationVerdictError ?? 'unknown error'}; this agentId cannot satisfy requiresVerification — run the verification again)`
}

/** The detached checkout a final-reviewer run was given. */
export type FinalReviewTarget = {
  /** Resolved full sha of review_commit. */
  commit: string
  /** Real path of the detached worktree (the run's cwd). */
  worktreePath: string
}

/**
 * True only for the genuine built-in final reviewer. Project, user, plugin
 * or SDK agents can override a built-in by name, so the agentType alone must
 * not be able to mint a final-review record.
 */
export function isBuiltInFinalReviewRun(identity: {
  agentType: string | undefined
  isBuiltInAgent: boolean
}): boolean {
  return (
    identity.agentType === FINAL_REVIEW_AGENT_TYPE && identity.isBuiltInAgent
  )
}

/**
 * Called before a built-in final-reviewer run starts (fresh or resumed):
 * deletes any record already on file for this agentId, so an old DONE can
 * never outlive a newer run that finds gaps, errors, or cannot record.
 *
 * Throws when the old record exists but cannot be removed; the caller must
 * then refuse to start the run.
 */
export async function clearFinalReviewBeforeRun(
  agentId: string,
  identity: { agentType: string | undefined; isBuiltInAgent: boolean },
): Promise<void> {
  if (!isBuiltInFinalReviewRun(identity)) return
  try {
    await clearFinalReview(agentId)
  } catch (error) {
    throw new Error(
      `Cannot start final reviewer ${agentId}: its previous record could not be cleared (${errorMessage(error)}). Refusing to run while a possibly stale final review is on file.`,
    )
  }
}

function normalizeReviewPath(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/**
 * The self-check: the report must echo the checkout it was given. Returns
 * why it does not, or undefined when every `REVIEW CWD:` line equals the
 * worktree path and every `REVIEW HEAD:` line equals the resolved sha.
 */
export function checkFinalReviewIdentity(
  text: string,
  target: FinalReviewTarget,
): string | undefined {
  const { cwds, heads } = parseReviewIdentity(text)
  if (heads.length === 0) return 'the report has no "REVIEW HEAD: <sha>" line'
  if (cwds.length === 0) return 'the report has no "REVIEW CWD: <path>" line'
  const wrongHead = heads.find(h => h !== target.commit)
  if (wrongHead !== undefined) {
    return `REVIEW HEAD ${wrongHead} is not the reviewed commit ${target.commit}`
  }
  const expectedCwd = normalizeReviewPath(target.worktreePath)
  const wrongCwd = cwds.find(c => normalizeReviewPath(c) !== expectedCwd)
  if (wrongCwd !== undefined) {
    return `REVIEW CWD ${wrongCwd} is not the review checkout ${target.worktreePath}`
  }
  return undefined
}

/**
 * For a successfully finished run of the built-in final reviewer, parse its
 * report, self-check the checkout it echoed, and persist the result under
 * its agentId so a task flagged `requiresFinalReview` can cite it via
 * `metadata.finalReviewedBy`. A GAPS result also files one task per GAP
 * (idempotent) that blocks every open flagged task. Call it only on the
 * success path (after finalizeAgentTool).
 *
 * The self-check never trusts the model: a report whose `REVIEW HEAD:` is
 * not the resolved sha, or whose `REVIEW CWD:` is not the worktree, is
 * recorded as MISSING with the reason, as is a run with no checkout.
 *
 * Never throws: failures are logged and reported on the result.
 */
export async function recordFinalReviewIfApplicable(
  result: AgentToolResult,
  identity: {
    isBuiltInAgent: boolean
    finalReview?: FinalReviewTarget
    resolvedAgentModel?: string
  },
): Promise<void> {
  if (
    !isBuiltInFinalReviewRun({
      agentType: result.agentType,
      isBuiltInAgent: identity.isBuiltInAgent,
    })
  ) {
    return
  }
  const target = identity.finalReview
  try {
    const text = extractTextContent(result.content, '\n')
    let parsed: ParsedFinalReview = parseFinalReview(text)
    if (!target) {
      parsed = {
        result: 'MISSING',
        reason: 'the run had no review checkout (review_commit)',
      }
    } else if (parsed.result !== 'MISSING') {
      const mismatch = checkFinalReviewIdentity(text, target)
      if (mismatch) parsed = { result: 'MISSING', reason: mismatch }
    }
    result.finalReview = parsed.result
    result.finalReviewCommit = target?.commit
    if (parsed.result === 'MISSING') result.finalReviewReason = parsed.reason
    await recordFinalReview({
      agentId: result.agentId,
      result: parsed.result,
      gaps: parsed.result === 'GAPS' ? parsed.gaps : [],
      commit: target?.commit ?? '',
      ...(identity.resolvedAgentModel
        ? { model: identity.resolvedAgentModel }
        : {}),
      ...(parsed.result === 'MISSING' ? { reason: parsed.reason } : {}),
    })
    result.finalReviewRecorded = true
    logForDebugging(
      `[finalReviews] recorded ${parsed.result} for reviewer ${result.agentId}`,
    )
    if (parsed.result === 'GAPS') {
      try {
        result.finalReviewGapTaskIds = await fileGapTasks(
          result.agentId,
          parsed.gaps,
        )
      } catch (error) {
        result.finalReviewGapTaskError = errorMessage(error)
        logForDebugging(
          `[finalReviews] failed to file GAP tasks for ${result.agentId}: ${errorMessage(error)}`,
          { level: 'error' },
        )
      }
    }
  } catch (error) {
    result.finalReviewRecorded = false
    result.finalReviewError = errorMessage(error)
    logForDebugging(
      `[finalReviews] failed to record final review for ${result.agentId}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    await clearFinalReview(result.agentId).catch(() => {})
  }
}

/**
 * One line describing a final-reviewer run's result for the caller: whether
 * it was recorded, how to cite it, and the GAP tasks it filed. Undefined for
 * other runs.
 */
export function formatFinalReviewLine(
  result: AgentToolResult,
): string | undefined {
  if (!result.finalReview) return undefined
  const at = result.finalReviewCommit
    ? ` at commit ${result.finalReviewCommit}`
    : ''
  if (!result.finalReviewRecorded) {
    return `finalReview: ${result.finalReview} (NOT recorded: ${result.finalReviewError ?? 'unknown error'}; this agentId cannot satisfy requiresFinalReview — run the final reviewer again)`
  }
  if (result.finalReview === 'DONE') {
    return `finalReview: DONE (recorded for this agentId${at}; to complete a task with requiresFinalReview, set metadata.finalReviewedBy: '${result.agentId}' — open GAP tasks from earlier reviews still block it)`
  }
  if (result.finalReview === 'GAPS') {
    const ids = result.finalReviewGapTaskIds ?? []
    const filed = result.finalReviewGapTaskError
      ? `GAP tasks could NOT all be filed: ${result.finalReviewGapTaskError}`
      : `GAP tasks: ${ids.map(id => `#${id}`).join(', ')} (each blocks every open task with requiresFinalReview until it is completed or cancelled)`
    return `finalReview: GAPS (recorded for this agentId${at}; ${filed}. Fix the gaps, commit, and run the final reviewer again on the new commit.)`
  }
  return `finalReview: MISSING (recorded for this agentId${at}: ${result.finalReviewReason ?? 'no valid report'}; this agentId cannot satisfy requiresFinalReview — run the final reviewer again)`
}

/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toolPermissionContext.mode !== 'auto') return null

    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (classifierResult.shouldBlock) {
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null
}

/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()

    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
    // Record before completion is signalled, so a caller woken by the
    // completion can already cite this verifier in metadata.verifiedBy.
    await recordVerificationVerdictIfApplicable(agentResult, metadata)
    await recordFinalReviewIfApplicable(agentResult, metadata)

    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    completeAsyncAgent(agentResult, rootSetAppState)

    let finalMessage = extractTextContent(agentResult.content, '\n')
    const verdictLine = formatVerificationVerdictLine(agentResult)
    if (verdictLine) {
      finalMessage = `${finalMessage}\n\n${verdictLine}`
    }
    const finalReviewLine = formatFinalReviewLine(agentResult)
    if (finalReviewLine) {
      finalMessage = `${finalMessage}\n\n${finalReviewLine}`
    }

    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
    if (error instanceof AbortError) {
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
