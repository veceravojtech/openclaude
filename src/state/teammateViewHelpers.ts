import { logEvent } from '../services/analytics/index.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  requestAbort,
  traceInterruptionEvent,
} from '../utils/interruptionTrace.js'

// Inlined from framework.ts — importing creates a cycle through
// BackgroundTasksDialog. Keep in sync with PANEL_GRACE_MS and
// TEAMMATE_GRACE_MS there. They hold the same number today and are still two
// knobs: one is the coordinator panel's linger, the other the teammates tree's.
const PANEL_GRACE_MS = 30_000
const TEAMMATE_GRACE_MS = 30_000

import type { AppState } from './AppState.js'

// Inline type checks instead of importing isLocalAgentTask /
// isInProcessTeammateTask — breaks the teammateViewHelpers → LocalAgentTask
// runtime edge that creates a cycle through BackgroundTasksDialog.
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

function isInProcessTeammate(
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
 * The two task types this view can hold open: the coordinator panel's
 * background agents and the teammates tree's rows. Both declare the
 * retain/evictAfter pair the shared retain/grace rule (utils/task/retention)
 * reads, which is the only reason either can be pinned while it is being read.
 */
type ViewableTask = LocalAgentTaskState | InProcessTeammateTaskState

function isViewableTask(task: unknown): task is ViewableTask {
  return isLocalAgent(task) || isInProcessTeammate(task)
}

/**
 * Return the task released back to stub form: retain dropped and evictAfter set
 * if terminal, so a row the reader has let go of leaves after one more grace
 * window instead of lingering for the session. Shared by exitTeammateView and
 * the switch-away path in enterTeammateView.
 *
 * A local_agent ALSO drops its transcript back to a stub: its messages are a
 * disk bootstrap that retain: true triggered, so they are re-read on the next
 * open. A teammate's `messages` are the runner's own live UI mirror — there is
 * no disk bootstrap and no stream-append for it — so clearing them here would
 * delete state nothing re-creates. Its grace deadline is the teammates tree's,
 * not the panel's.
 */
function release(task: ViewableTask): ViewableTask {
  const evictAfter = isTerminalTaskStatus(task.status)
    ? Date.now() + (isLocalAgent(task) ? PANEL_GRACE_MS : TEAMMATE_GRACE_MS)
    : undefined
  if (isLocalAgent(task)) {
    return {
      ...task,
      retain: false,
      messages: undefined,
      diskLoaded: false,
      evictAfter,
    }
  }
  return { ...task, retain: false, evictAfter }
}

/**
 * Does opening this task have to pin it in place?
 *
 * A local_agent always does: retain: true is what blocks eviction, enables
 * stream-append and triggers the disk bootstrap.
 *
 * An in_process_teammate only does once it is TERMINAL — a row inside its
 * TEAMMATE_GRACE_MS window. That row is exactly what Enter can now open (T1's
 * D2: terminal rows are selectable) and exactly what the panel's deadline timer
 * used to evict at 30 s, throwing the reader back to the leader mid-transcript
 * through useTeammateViewAutoExit. A RUNNING teammate deliberately stays
 * without the field: nothing can evict it (both evictors require a terminal
 * status) and isRetainedOrWithinGrace narrows on the PRESENCE of `retain`, so
 * writing it early would make a teammate "retainable" before it ever finishes.
 */
function needsRetainWhileViewed(task: unknown): task is ViewableTask {
  if (isLocalAgent(task)) return true
  return isInProcessTeammate(task) && isTerminalTaskStatus(task.status)
}

/**
 * Transitions the UI to view a teammate's transcript.
 * Sets viewingAgentTaskId and, for a local_agent or a teammate row inside its
 * grace window, retain: true (blocks eviction; for a local_agent it also
 * enables stream-append and triggers the disk bootstrap) and clears evictAfter.
 * If switching from another agent, releases the previous one back to stub.
 */
export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_enter', {})
  setAppState(prev => {
    const task = prev.tasks[taskId]
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId !== undefined ? prev.tasks[prevId] : undefined
    const switching =
      prevId !== undefined &&
      prevId !== taskId &&
      isViewableTask(prevTask) &&
      prevTask.retain === true
    const needsRetain =
      needsRetainWhileViewed(task) &&
      (task.retain !== true || task.evictAfter !== undefined)
    const needsView =
      prev.viewingAgentTaskId !== taskId ||
      prev.viewSelectionMode !== 'viewing-agent'
    if (!needsRetain && !needsView && !switching) return prev
    let tasks = prev.tasks
    if (switching || needsRetain) {
      tasks = { ...prev.tasks }
      if (switching) tasks[prevId] = release(prevTask)
      if (needsRetain) {
        tasks[taskId] = { ...task, retain: true, evictAfter: undefined }
      }
    }
    return {
      ...prev,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
      tasks,
    }
  })
}

/**
 * Exit teammate transcript view and return to leader's view.
 * Drops retain (and, for a local_agent, clears messages back to stub form); if
 * terminal, schedules eviction via evictAfter so the row lingers briefly —
 * a teammate row the reader just closed gets one more full grace window rather
 * than whatever was left of the old one.
 */
export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_exit', {})
  setAppState(prev => {
    const id = prev.viewingAgentTaskId
    const cleared = {
      ...prev,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none' as const,
    }
    if (id === undefined) {
      return prev.viewSelectionMode === 'none' ? prev : cleared
    }
    const task = prev.tasks[id]
    if (!isViewableTask(task) || task.retain !== true) return cleared
    return {
      ...cleared,
      tasks: { ...prev.tasks, [id]: release(task) },
    }
  })
}

/**
 * Context-sensitive x: running → abort, terminal → dismiss.
 * Dismiss sets evictAfter=0 so the filter hides immediately.
 * If viewing the dismissed agent, also exits to leader.
 */
export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) return prev
    if (task.status === 'running') {
      const causalEventId = traceInterruptionEvent('input.agent_panel_stop', {
        source: 'agent_panel_stop',
        subsystem: 'local_agent_task',
        subagentId: taskId,
      })
      if (task.abortController) {
        requestAbort(task.abortController, undefined, {
          source: 'agent_panel_stop',
          subsystem: 'local_agent_task',
          controllerRole: 'background-agent',
          subagentId: taskId,
          causalEventId,
        })
      }
      return prev
    }
    if (task.evictAfter === 0) return prev
    const viewingThis = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...release(task), evictAfter: 0 },
      },
      ...(viewingThis && {
        viewingAgentTaskId: undefined,
        viewSelectionMode: 'none',
      }),
    }
  })
}

/**
 * Reverse-lookup an agent's registered name (`/rename`, AgentTool `name`) from
 * agentNameRegistry, which is keyed name -> taskId. Shared by the transcript-view
 * header, the swarm banner and the prompt placeholder so the three never
 * disagree on what a viewed local agent is called.
 *
 * Latest-wins on collision is the registry's own contract, so first match wins
 * here too. The `Pick<AppState, …>` parameter keeps this module free of the
 * LocalAgentTask runtime import that would re-create the cycle noted above.
 */
export function getRegisteredAgentName(
  state: Pick<AppState, 'agentNameRegistry'>,
  taskId: string,
): string | undefined {
  for (const [name, id] of state.agentNameRegistry) {
    if (id === taskId) {
      return name
    }
  }
  return undefined
}
