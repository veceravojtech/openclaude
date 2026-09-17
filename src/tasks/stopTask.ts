// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import { isTerminalTaskStatus } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import { resolveStoppableTask } from './resolveStoppableTask.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'not_running'
      | 'unsupported_type'
      | 'ambiguous'
      | 'not_terminated',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * Look up a task by ID, validate it is running, kill it, and mark it as notified.
 *
 * `requestedId` is a task id, a teammate's `name@team` address, or a
 * teammate's bare name when that is unambiguous — see
 * {@link resolveStoppableTask}, which also supplies the failure text.
 *
 * Throws {@link StopTaskError} when the task cannot be stopped (not found,
 * ambiguous, not running, unsupported type, or still running after the kill).
 * Callers can inspect `error.code` to distinguish the failure reason.
 */
export async function stopTask(
  requestedId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()

  const resolved = await resolveStoppableTask(requestedId, appState.tasks)
  if (!resolved.ok) {
    throw new StopTaskError(resolved.message, resolved.code)
  }
  const { task, taskId } = resolved
  // What the caller typed, kept for messages: an address they can recognise is
  // more use to them than the generated id it resolved to.
  const label = taskId === requestedId ? taskId : `${requestedId} (${taskId})`

  if (task.status !== 'running') {
    throw new StopTaskError(
      `Task ${label} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  await taskImpl.kill(taskId, setAppState)

  // Honesty rule, same one terminate() now follows: success is an observed
  // stop, not a request that was sent. Reading the row back is the
  // observation — a task still in a non-terminal state after its kill
  // returned was not stopped, and reporting it as stopped is the same
  // fabricated success that made one teammate refusal permanent.
  const after = getAppState().tasks?.[taskId]
  if (after && !isTerminalTaskStatus(after.status)) {
    throw new StopTaskError(
      `Task ${label} is still running after the stop request — ` +
        `it was not terminated (status: ${after.status}).`,
      'not_terminated',
    )
  }

  // Bash: suppress the "exit code 137" notification (noise). Agent tasks: don't
  // suppress — the AbortError catch sends a notification carrying
  // extractPartialResult(agentMessages), which is the payload not noise.
  if (isLocalShellTask(task)) {
    let suppressed = false
    setAppState(prev => {
      const prevTask = prev.tasks[taskId]
      if (!prevTask || prevTask.notified) {
        return prev
      }
      suppressed = true
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...prevTask, notified: true },
        },
      }
    })
    // Suppressing the XML notification also suppresses print.ts's parsed
    // task_notification SDK event — emit it directly so SDK consumers see
    // the task close.
    if (suppressed) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}
