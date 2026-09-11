import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'

import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import {
  type AppState,
  AppStateProvider,
  useAppState,
} from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

/**
 * 'k' and 'f' are ordinary letters, and selection mode does not end when the
 * user starts typing — Escape, Enter and the survivor effect are what leave it.
 * So a prompt being typed into while a teammate row is selected used to have its
 * 'k' kill that teammate and its 'f' throw the screen into the transcript, with
 * the letter landing in the buffer as well: the hook's preventDefault marks a
 * KeyboardEvent it builds itself, which BaseTextInput's own useInput subscriber
 * never sees.
 *
 * REPL passes its existing typing flag (isPromptTypingSuppressionActive) in, and
 * both branches stand down while it is set. With the prompt empty and idle the
 * shortcuts still work, which the second half of each test is here to keep true.
 */

beforeEach(async () => {
  await acquireSharedMutationLock(
    'hooks/useBackgroundTaskNavigation.typingSuppression.test.tsx',
  )
})

afterEach(() => {
  releaseSharedMutationLock()
})

type ViewState = {
  viewingAgentTaskId: string | undefined
  viewSelectionMode: string
}

function Harness({
  onReady,
  onState,
  promptTypingSuppressionActive,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onState: (state: ViewState) => void
  promptTypingSuppressionActive: boolean
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation({
    promptTypingSuppressionActive,
  })
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () => onState({ viewingAgentTaskId, viewSelectionMode }),
    [viewingAgentTaskId, viewSelectionMode, onState],
  )
  return null
}

function createTeammateTask(): {
  task: InProcessTeammateTaskState
  lifecycleAbortController: AbortController
} {
  const lifecycleAbortController = new AbortController()
  return {
    lifecycleAbortController,
    task: {
      id: 'teammate-task-1',
      type: 'in_process_teammate',
      status: 'running',
      description: 'test teammate',
      startTime: Date.now(),
      outputFile: '/tmp/test-teammate-typing-output',
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: 'researcher@test-team',
        agentName: 'researcher',
        teamName: '',
        planModeRequired: false,
        parentSessionId: 'parent-session',
      },
      prompt: 'test',
      abortController: lifecycleAbortController,
      currentWorkAbortController: new AbortController(),
      awaitingPlanApproval: false,
      permissionMode: 'default',
      isIdle: false,
      shutdownRequested: false,
      pendingUserMessages: [],
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    },
  }
}

/** A bare letter, as the terminal reports it: no modifier, sequence is itself. */
function letter(key: 'f' | 'k'): KeyboardEvent {
  return new KeyboardEvent({
    kind: 'key',
    name: key,
    sequence: key,
    raw: key,
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    fn: false,
    isPasted: false,
  })
}

async function renderNavigation(
  initialState: AppState,
  promptTypingSuppressionActive: boolean,
): Promise<{
  press: (event: KeyboardEvent) => Promise<void>
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
  let latest: ViewState = {
    viewingAgentTaskId: undefined,
    viewSelectionMode: 'none',
  }
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
          promptTypingSuppressionActive={promptTypingSuppressionActive}
        />
      </AppStateProvider>,
    )
    for (let attempts = 0; attempts < 100 && !handler; attempts++) {
      await Bun.sleep(10)
    }
    expect(handler).toBeDefined()
    return {
      async press(event) {
        handler!(event)
        await Bun.sleep(30)
      },
      state: () => latest,
      cleanup: teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

function selectingState(task: InProcessTeammateTaskState): AppState {
  return {
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    expandedView: 'teammates',
    selectedTeammate: { kind: 'teammate', taskId: task.id },
    viewSelectionMode: 'selecting-agent',
  }
}

test('k typed into a non-empty prompt leaves the selected teammate alive', async () => {
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), true)

  try {
    await mounted.press(letter('k'))

    expect(lifecycleAbortController.signal.aborted).toBe(false)
    // …and the selection is still there for the Escape or Enter that ends it.
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('k on an idle prompt still kills the selected teammate', async () => {
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), false)

  try {
    await mounted.press(letter('k'))
    expect(lifecycleAbortController.signal.aborted).toBe(true)
  } finally {
    await mounted.cleanup()
  }
})

test('f typed into a non-empty prompt does not open the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), true)

  try {
    await mounted.press(letter('f'))

    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('f on an idle prompt still opens the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), false)

  try {
    await mounted.press(letter('f'))

    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})
