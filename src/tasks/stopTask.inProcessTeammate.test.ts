import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../state/AppState.js'
import { getTaskByType } from '../tasks.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../utils/envUtils.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import { stopTask, StopTaskError } from './stopTask.js'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tasks/stopTask.inProcessTeammate.test.ts')
  // Keep killInProcessTeammate's team-file cleanup away from the real home.
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-stop-teammate-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function idleTeammate(abortController: AbortController): InProcessTeammateTaskState {
  return {
    id: 't-idle',
    type: 'in_process_teammate',
    status: 'running',
    description: 'idler: idle (waiting for work)',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'idler@alpha',
      agentName: 'idler',
      teamName: 'alpha',
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: '',
    abortController,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: true,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

test('the in-process teammate task impl is registered for kill dispatch', () => {
  expect(getTaskByType('in_process_teammate')?.type).toBe('in_process_teammate')
})

test('stopTask kills an idle in-process teammate', async () => {
  const abortController = new AbortController()
  const task = idleTeammate(abortController)
  let idleCallbacks = 0
  task.onIdleCallbacks = [() => idleCallbacks++]

  let state = {
    tasks: { [task.id]: task },
    teamContext: {
      teamName: 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [task.identity.agentId]: { name: 'idler' } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const result = await stopTask(task.id, context)
  expect(result).toEqual({
    taskId: task.id,
    taskType: 'in_process_teammate',
    command: task.description,
  })
  const stopped = state.tasks[task.id] as InProcessTeammateTaskState | undefined
  expect(stopped?.status).toBe('killed')
  expect(stopped?.notified).toBe(true)
  expect(abortController.signal.aborted).toBe(true)
  expect(idleCallbacks).toBe(1)
  expect(state.teamContext?.teammates).toEqual({})

  // Already stopped: the shared guard rejects a second stop.
  await expect(stopTask(task.id, context)).rejects.toBeInstanceOf(StopTaskError)
})
