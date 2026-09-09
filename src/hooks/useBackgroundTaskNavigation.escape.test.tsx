import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'
import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { AppStateProvider, useAppState, type AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

/**
 * Escape while viewing an in-process teammate: interrupt a busy teammate's
 * current turn, otherwise return to the leader's view. A live teammate keeps
 * status 'running' for its whole life, so the decision must follow isIdle and
 * the presence of a turn to abort, not the status alone; gating on status made
 * Escape a no-op for idle teammates and the view impossible to leave by key.
 */

const ESCAPE = String.fromCharCode(27)

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useBackgroundTaskNavigation.escape.test.tsx')
})

afterEach(() => {
  releaseSharedMutationLock()
})

type ViewState = { viewingAgentTaskId: string | undefined; viewSelectionMode: string }

function Harness({
  onReady,
  onState,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onState: (state: ViewState) => void
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () => onState({ viewingAgentTaskId, viewSelectionMode }),
    [viewingAgentTaskId, viewSelectionMode, onState],
  )
  return null
}

function createTeammateTask(options: {
  isIdle: boolean
  withCurrentWork: boolean
}): {
  task: InProcessTeammateTaskState
  currentWorkAbortController: AbortController | undefined
  lifecycleAbortController: AbortController
} {
  const currentWorkAbortController = options.withCurrentWork
    ? new AbortController()
    : undefined
  const lifecycleAbortController = new AbortController()
  return {
    currentWorkAbortController,
    lifecycleAbortController,
    task: {
      id: 'teammate-task-1',
      type: 'in_process_teammate',
      status: 'running',
      description: 'supervisor: idle (waiting for work)',
      startTime: Date.now(),
      outputFile: '/tmp/test-teammate-output',
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: 'supervisor@test-team',
        agentName: 'supervisor',
        teamName: '',
        planModeRequired: false,
        parentSessionId: 'parent-session',
      },
      prompt: '',
      abortController: lifecycleAbortController,
      currentWorkAbortController,
      awaitingPlanApproval: false,
      permissionMode: 'default',
      isIdle: options.isIdle,
      shutdownRequested: false,
      pendingUserMessages: [],
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    },
  }
}

function viewingState(task: InProcessTeammateTaskState): AppState {
  return {
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    viewingAgentTaskId: task.id,
    viewSelectionMode: 'viewing-agent',
  }
}

async function renderNavigation(initialState: AppState): Promise<{
  pressEscape: () => void
  state: () => ViewState
  cleanup: () => Promise<void>
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let handler: ((event: KeyboardEvent) => void) | undefined
  let latest: ViewState = { viewingAgentTaskId: undefined, viewSelectionMode: 'none' }
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
  }
  try {
    root.render(
      <AppStateProvider initialState={initialState}>
        <Harness
          onReady={value => {
            handler = value
          }}
          onState={value => {
            latest = value
          }}
        />
      </AppStateProvider>,
    )
    for (let attempts = 0; attempts < 100 && !handler; attempts++) {
      await Bun.sleep(10)
    }
    expect(handler).toBeDefined()
    return {
      pressEscape() {
        handler!(
          new KeyboardEvent({
            kind: 'key',
            name: 'escape',
            sequence: ESCAPE,
            raw: ESCAPE,
            ctrl: false,
            shift: false,
            meta: false,
            option: false,
            super: false,
            fn: false,
            isPasted: false,
          }),
        )
      },
      state: () => latest,
      cleanup: teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

async function settle(): Promise<void> {
  await Bun.sleep(30)
}

test('Escape returns to the leader from an idle teammate without touching it', async () => {
  const { task, lifecycleAbortController } = createTeammateTask({
    isIdle: true,
    withCurrentWork: false,
  })
  const rendered = await renderNavigation(viewingState(task))
  try {
    expect(rendered.state().viewingAgentTaskId).toBe(task.id)
    rendered.pressEscape()
    await settle()
    expect(rendered.state()).toEqual({
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
    })
    expect(lifecycleAbortController.signal.aborted).toBe(false)
  } finally {
    await rendered.cleanup()
  }
})

test('Escape interrupts a busy teammate and stays in its view; a second Escape returns once it is idle', async () => {
  const { task, currentWorkAbortController, lifecycleAbortController } =
    createTeammateTask({ isIdle: false, withCurrentWork: true })
  const rendered = await renderNavigation(viewingState(task))
  try {
    rendered.pressEscape()
    await settle()
    expect(currentWorkAbortController!.signal.aborted).toBe(true)
    expect(lifecycleAbortController.signal.aborted).toBe(false)
    expect(rendered.state().viewingAgentTaskId).toBe(task.id)
  } finally {
    await rendered.cleanup()
  }

  // Once the turn has ended the runner flags the task idle; Escape now returns.
  const idle = await renderNavigation(
    viewingState({ ...task, isIdle: true, currentWorkAbortController: undefined }),
  )
  try {
    idle.pressEscape()
    await settle()
    expect(idle.state().viewingAgentTaskId).toBeUndefined()
  } finally {
    await idle.cleanup()
  }
})

test('Escape returns from a running teammate that has no turn to interrupt', async () => {
  const { task } = createTeammateTask({ isIdle: false, withCurrentWork: false })
  const rendered = await renderNavigation(viewingState(task))
  try {
    rendered.pressEscape()
    await settle()
    expect(rendered.state().viewingAgentTaskId).toBeUndefined()
  } finally {
    await rendered.cleanup()
  }
})
