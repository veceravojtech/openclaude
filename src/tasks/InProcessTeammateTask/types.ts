import type { TaskStateBase } from '../../Task.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

/**
 * Teammate identity stored in task state.
 * Same shape as TeammateContext (runtime) but stored as plain data.
 * TeammateContext is for AsyncLocalStorage; this is for AppState persistence.
 */
export type TeammateIdentity = {
  agentId: string // e.g., "researcher@my-team"
  agentName: string // e.g., "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string // Leader's session ID
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // Identity as sub-object (matches TeammateContext shape for consistency)
  // Stored as plain data in AppState, NOT a reference to AsyncLocalStorage
  identity: TeammateIdentity

  // Execution. Empty string for teammates spawned idle (no initial prompt).
  prompt: string
  // Optional model override for this teammate
  model?: string
  // Optional: Only set if teammate uses a specific agent definition
  // Many teammates run as general-purpose agents without a predefined definition
  selectedAgent?: AgentDefinition
  abortController?: AbortController // Runtime only, not serialized to disk - kills WHOLE teammate
  currentWorkAbortController?: AbortController // Runtime only - aborts current turn without killing teammate
  unregisterCleanup?: () => void // Runtime only

  // Plan mode approval tracking (planModeRequired is in identity)
  awaitingPlanApproval: boolean

  // Permission mode for this teammate (cycled independently via Shift+Tab when viewing)
  permissionMode: PermissionMode

  // State
  error?: string
  result?: AgentToolResult // Reuse existing type since teammates run via runAgent()
  progress?: AgentProgress

  // Conversation history for zoomed view (NOT mailbox messages)
  // Mailbox messages are stored separately in teamContext.inProcessMailboxes
  messages?: Message[]

  // Tool use IDs currently being executed (for animation in transcript view)
  inProgressToolUseIDs?: Set<string>

  // Queue of user messages to deliver when viewing teammate transcript
  pendingUserMessages: string[]

  // UI: random spinner verbs (stable across re-renders, shared between components)
  spinnerVerb?: string
  pastTenseVerb?: string

  // Lifecycle
  isIdle: boolean
  /** Last pane report; never changes the owner's own scheduling state. */
  delegatedActivity?: import('../../utils/swarm/delegatedActivity.js').DelegatedActivity
  shutdownRequested: boolean

  /**
   * Set while this teammate is parked on an account-wide usage limit: alive,
   * holding no claimed task, running no turn, waiting for the next prompt.
   *
   * A FIELD and not a `TaskStatus` member on purpose. `status` stays 'running',
   * so every liveness, kill, cascade, spawn-cap and tree predicate keeps
   * working unchanged — of the readers of `status` only one is exhaustive
   * enough for the compiler to have caught a new member, and the silent ones
   * include getRunningTeammatesSorted (InProcessTeammateTask.tsx), which feeds
   * the teammates tree, the footer selector and background-task navigation at
   * once. A parked teammate that vanished from those could never be messaged,
   * and being messaged is exactly how it is resumed. This is the same shape
   * `awaitingPlanApproval` and `shutdownRequested` above already use for
   * "alive, but not working".
   *
   * Holds the notice TEXT and the time it was set, and deliberately NOTHING
   * about the account. The active account can change under a parked teammate
   * with no switchAccount call at all — withAccounts (utils/authAccounts.ts)
   * promotes keys[0] blind when the active key is missing — so any cached
   * account key, email or switch epoch would go stale silently. The lead
   * re-reads the account when it resumes; the teammate caches nothing.
   *
   * Written on the usage-limit park path in the runner and cleared there
   * beside clearCannotProceed() when a later turn succeeds.
   */
  parkedNotice?: string
  parkedAt?: number

  /**
   * Retain/grace pair, written TOGETHER at the terminal transition (the runner's
   * completion and failure tails, and killInProcessTeammate) and never before:
   * `retain: false` plus `evictAfter = Date.now() + TEAMMATE_GRACE_MS`.
   *
   * `retain` is what makes `isRetainedOrWithinGrace` (utils/task/retention) take
   * this task at all — it narrows on the PRESENCE of the field, not on its
   * value — and `evictAfter` is the deadline it compares against. While the
   * deadline stands, the row stays in the teammates tree (drawn dimmed, reading
   * the terminal word) and both evictors in utils/task/framework refuse to
   * collect the task; once it passes, the row leaves the shared order at the
   * next render and the lazy GC deletes the task.
   *
   * Optional because a teammate that has not finished has no deadline yet, and
   * because the 24 hand-built fixtures across the suites must stay valid without
   * declaring a lifecycle field they never reach.
   */
  retain?: boolean
  evictAfter?: number

  // Callbacks to notify when teammate becomes idle (runtime only)
  // Used by leader to efficiently wait without polling
  onIdleCallbacks?: Array<() => void>

  // Progress tracking (for computing deltas in notifications)
  lastReportedToolCount: number
  lastReportedTokenCount: number
}

export function isInProcessTeammateTask(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * Cap on the number of messages kept in task.messages (the AppState UI mirror).
 *
 * task.messages exists purely for the zoomed transcript dialog, which only
 * needs recent context. The full conversation lives in the local allMessages
 * array (inProcessRunner) and on disk at the agent transcript path.
 *
 * BQ analysis (round 9, 2026-03-20) showed ~20MB RSS per agent at 500+ turn
 * sessions and ~125MB per concurrent agent in swarm bursts. Whale session
 * 9a990de8 launched 292 agents in 2 minutes and reached 36.8GB. The dominant
 * cost is this array holding a second full copy of every message.
 *
 * For an in-process teammate (appendCappedTeammateMessage) this counts only
 * the NON-progress entries — the ones the view draws as rows — so a flood of
 * progress can never evict the conversation. Progress has its own ceiling,
 * TEAMMATE_PROGRESS_UI_CAP, which bounds the mirror at
 * task.messages.length <= TEAMMATE_MESSAGES_UI_CAP + TEAMMATE_PROGRESS_UI_CAP.
 * appendCappedMessage still counts every item it is given.
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/**
 * Cap on the number of progress entries kept in an in-process teammate's
 * task.messages, on top of TEAMMATE_MESSAGES_UI_CAP non-progress entries.
 * Progress is never drawn as a row; it only feeds the live display of the
 * tool rows it belongs to, so a small ceiling is enough.
 */
export const TEAMMATE_PROGRESS_UI_CAP = 30

/**
 * How many of a tool call's most recent trail entries (agent_progress,
 * skill_progress, …) an in-process teammate's mirror keeps, in addition to
 * the trail's first entry. AgentTool's live row reads the first entry (the
 * prompt) and its last three assistant entries plus their results.
 */
export const TEAMMATE_PROGRESS_TAIL_PER_TOOL = 10

/**
 * Append an item to a message array, capping the result at
 * TEAMMATE_MESSAGES_UI_CAP entries by dropping the oldest. Always returns
 * a new array (AppState immutability).
 */
export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
