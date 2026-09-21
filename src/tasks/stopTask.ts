// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import { isTerminalTaskStatus, type TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { isPaneBackend } from '../utils/swarm/backends/types.js'
import { readTeamFileAsync } from '../utils/swarm/teamHelpers.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import { isInProcessTeammateTask } from './InProcessTeammateTask/types.js'
import {
  isKillableTerminalPaneTeammate,
  resolveStoppableTask,
} from './resolveStoppableTask.js'

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
    // A failed PANE teammate is the one terminal task still worth stopping:
    // its pane stays alive for resume, so the row reads `failed` while the
    // pane (and roster member) still exist. TaskStop reaches those through
    // the same kill cascade a running teammate takes. Everything else —
    // completed, killed, in-process — has nothing alive left to stop.
    if (!(await isKillableTerminalPaneTeammate(task))) {
      throw new StopTaskError(
        `Task ${label} is not running (status: ${task.status})`,
        'not_running',
      )
    }
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  const killFailed = (await taskImpl.kill(taskId, setAppState)) === false

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

  // A task type that reports a definitive kill verdict can fail even though
  // the row already moved to a terminal status: a failed pane teammate whose
  // pane would not close reads `killed` above while the pane is still alive.
  // The cascade keeps the roster member on purpose in that case so the pane
  // stays visible to the ghost sweep — surface that as a failure, not the
  // fabricated success that hid the original orphan.
  if (killFailed) {
    throw new StopTaskError(await killFailureMessage(task, label), 'not_terminated')
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

/**
 * What to tell the caller when the kill cascade reported a definitive
 * failure. For a teammate this is a pane that would not close: the roster
 * member was kept on purpose so the pane stays visible to the ghost sweep,
 * and naming the pane is what lets a person act on it directly. The message
 * deliberately does not claim the teammate was stopped — the whole point is
 * that it was not.
 */
async function killFailureMessage(
  task: TaskStateBase,
  label: string,
): Promise<string> {
  let pane = ''
  if (isInProcessTeammateTask(task)) {
    const teamFile = await readTeamFileAsync(task.identity.teamName)
    const member = teamFile?.members?.find(
      m => m.agentId === task.identity.agentId,
    )
    if (
      member?.backendType &&
      isPaneBackend(member.backendType) &&
      member.tmuxPaneId &&
      member.tmuxPaneId !== 'in-process'
    ) {
      pane =
        ` Its ${member.backendType} pane ${member.tmuxPaneId} is still running — ` +
        `close it there if it should be gone.`
    }
  }
  return (
    `Teammate ${label} was not stopped. Its roster member was kept deliberately ` +
    `so the still-running pane stays visible to the ghost sweep.` + pane
  )
}
