import { expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

function createStateHarness(): {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
} {
  let state: AppState = getDefaultAppState()
  return {
    getState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

function getTeammateTask(
  state: AppState,
  taskId: string,
): InProcessTeammateTaskState {
  const task = state.tasks[taskId]
  if (!task || task.type !== 'in_process_teammate') {
    throw new Error(`task ${taskId} is not an in-process teammate task`)
  }
  return task as InProcessTeammateTaskState
}

test('an idle spawn registers an idle task with an idle description and an empty prompt', async () => {
  const { getState, setAppState } = createStateHarness()

  const result = await spawnInProcessTeammate(
    { name: 'idle-worker', teamName: 'idle-team', planModeRequired: false },
    { setAppState, toolUseId: 'toolu_idle' },
  )

  try {
    expect(result.success).toBe(true)
    expect(result.taskId).toBeDefined()
    const task = getTeammateTask(getState(), result.taskId!)
    expect(task.status).toBe('running')
    expect(task.isIdle).toBe(true)
    expect(task.description).toBe('idle-worker: idle (waiting for work)')
    expect(task.prompt).toBe('')
    expect(task.messages).toEqual([])
    expect(task.pendingUserMessages).toEqual([])
    expect(task.identity.agentId).toBe('idle-worker@idle-team')
  } finally {
    getTeammateTask(getState(), result.taskId!).unregisterCleanup?.()
  }
})

test('a prompted spawn still registers a busy task described by its prompt', async () => {
  const { getState, setAppState } = createStateHarness()

  const result = await spawnInProcessTeammate(
    {
      name: 'busy-worker',
      teamName: 'idle-team',
      prompt: 'Summarize the repository layout',
      planModeRequired: false,
    },
    { setAppState },
  )

  try {
    expect(result.success).toBe(true)
    const task = getTeammateTask(getState(), result.taskId!)
    expect(task.isIdle).toBe(false)
    expect(task.description).toBe('busy-worker: Summarize the repository layout')
    expect(task.prompt).toBe('Summarize the repository layout')
  } finally {
    getTeammateTask(getState(), result.taskId!).unregisterCleanup?.()
  }
})
