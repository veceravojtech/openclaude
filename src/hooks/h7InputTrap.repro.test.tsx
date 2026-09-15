/**
 * Input-routing regression suite for the agent-view surface: which states
 * swallow or re-route keys, and which of them have a reachable exit by key.
 *
 * Grown from the H7 reproduction harness (task-60) and kept in the tree because
 * every case below was a live trap a user could not get out of with the keyboard:
 *
 * - S1/S1b/S1c pin that Ctrl+R history search counts as typing: it leaves
 *   REPL's prompt buffer empty, so the only reason
 *   `isPromptTypingSuppressionActive` reads it as typing is REPL passing
 *   `isSearchingHistory` in as its third argument. S1d/S1e are the negative
 *   control: with no search and an idle prompt, 'f'/'k' still work.
 * - S2 pins that Escape leaves selecting-agent without collapsing the tree.
 * - S3/S3b/S3c pin the Escape contract in viewing-agent mode: the first press
 *   aborts the current turn and stays, the second returns to the leader, and a
 *   turn that is already aborted (or already cleared by the runner) returns on
 *   a single press. Before the fix the hook re-aborted an already-aborted
 *   controller and `return`ed, consuming every further press and trapping the
 *   view until the runner happened to clear the controller.
 * - S4 pins ink's child-before-parent `useInput` dispatch order, which is why
 *   PromptInput's onSubmit reads `viewSelectionMode` before this hook clears it.
 */
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
import { isPromptTypingSuppressionActive } from '../screens/replInputSuppression.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings
import { useInput } from '../ink.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/h7InputTrap.repro.test.tsx')
})
afterEach(() => {
  releaseSharedMutationLock()
})

type ViewState = {
  viewingAgentTaskId: string | undefined
  viewSelectionMode: string
  expandedView: string
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
  const expandedView = useAppState(s => s.expandedView)
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () => onState({ viewingAgentTaskId, viewSelectionMode, expandedView }),
    [viewingAgentTaskId, viewSelectionMode, expandedView, onState],
  )
  return null
}

function createTeammateTask(): {
  task: InProcessTeammateTaskState
  lifecycleAbortController: AbortController
  workAbortController: AbortController
} {
  const lifecycleAbortController = new AbortController()
  const workAbortController = new AbortController()
  return {
    lifecycleAbortController,
    workAbortController,
    task: {
      id: 'teammate-task-1',
      type: 'in_process_teammate',
      status: 'running',
      description: 'test teammate',
      startTime: Date.now(),
      outputFile: '/tmp/task-60-h7-output',
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
      currentWorkAbortController: workAbortController,
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

function key(name: string): KeyboardEvent {
  return new KeyboardEvent({
    kind: 'key',
    name,
    sequence: name.length === 1 ? name : '\x1b',
    raw: name.length === 1 ? name : '\x1b',
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    fn: false,
    isPasted: false,
  })
}

function fakeIo(): {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  raw: { stdin: PassThrough; stdout: PassThrough }
} {
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
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    raw: { stdin, stdout },
  }
}

async function renderNavigation(
  initialState: AppState,
  promptTypingSuppressionActive: boolean,
): Promise<{
  press: (event: KeyboardEvent) => Promise<void>
  state: () => ViewState
  cleanup: () => Promise<void>
}> {
  const io = fakeIo()
  const root = await createRoot({
    stdout: io.stdout,
    stdin: io.stdin,
    patchConsole: false,
  })
  let handler: ((event: KeyboardEvent) => void) | undefined
  let latest: ViewState = {
    viewingAgentTaskId: undefined,
    viewSelectionMode: 'none',
    expandedView: 'none',
  }
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    io.raw.stdin.end()
    io.raw.stdout.end()
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

function viewingState(task: InProcessTeammateTaskState): AppState {
  return {
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    expandedView: 'teammates',
    selectedTeammate: { kind: 'teammate', taskId: task.id },
    viewSelectionMode: 'viewing-agent',
    viewingAgentTaskId: task.id,
  }
}

// ---------------------------------------------------------------------------
// S1 — Ctrl+R history search leaves the PROMPT buffer untouched, so the flag
// that keeps 'f'/'k' out of text has to be told about the search explicitly.
// ---------------------------------------------------------------------------
test('S1: k typed into the Ctrl+R search leaves the selected teammate alive', async () => {
  // PromptInput.tsx:2373 unfocuses the prompt TextInput while isSearchingHistory,
  // and HistorySearchInput routes every keystroke to setHistoryQuery (local to
  // useHistorySearch). So REPL's inputValue stays '' and isPromptInputActive
  // stays false for the whole search: the search flag is the only thing that
  // tells the helper this keystroke is text.
  const suppression = isPromptTypingSuppressionActive(false, '', true)
  expect(suppression).toBe(true)

  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), suppression)
  try {
    await mounted.press(key('k')) // user meant: type "k" into "search prompts:"
    expect(lifecycleAbortController.signal.aborted).toBe(false)
    // …and the selection survives, for the Escape or Enter that ends it.
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S1b: f typed into the Ctrl+R search does not open the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', true),
  )
  try {
    await mounted.press(key('f'))
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S1c: a whole search query types through without killing the teammate', async () => {
  // The destructive case, on its own. 'k' aborts the selected teammate
  // outright — one keystroke loses the work — and a realistic query contains
  // both letters, so type the word and assert the teammate outlives it.
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', true),
  )
  try {
    for (const letter of ['f', 'i', 'k']) {
      await mounted.press(key(letter))
    }
    expect(lifecycleAbortController.signal.aborted).toBe(false)
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S1d: k with no search and an idle prompt still kills the teammate', async () => {
  // Negative control, through the same helper: widening it must not disable
  // the shortcuts everywhere. The default third argument keeps them live.
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, ''),
  )
  try {
    await mounted.press(key('k'))
    expect(lifecycleAbortController.signal.aborted).toBe(true)
  } finally {
    await mounted.cleanup()
  }
})

test('S1e: f with no search and an idle prompt still opens the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, ''),
  )
  try {
    await mounted.press(key('f'))
    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S2 — Escape exits selection mode but does NOT collapse the tree.
// ---------------------------------------------------------------------------
test('S2: escape leaves selecting-agent but expandedView stays teammates', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(selectingState(task), false)
  try {
    await mounted.press(key('escape'))
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().expandedView).toBe('teammates')
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S3 — Escape while viewing a BUSY teammate: press 1 aborts the turn and stays,
// press 2 returns to the leader. The teammate itself is never killed.
// ---------------------------------------------------------------------------
test('S3: escape interrupts a busy teammate, and a second escape exits the transcript view', async () => {
  const { task, workAbortController, lifecycleAbortController } =
    createTeammateTask()
  const mounted = await renderNavigation(viewingState(task), false)
  try {
    await mounted.press(key('escape'))
    // Press 1 stops the turn only, and deliberately stays in the view.
    expect(workAbortController.signal.aborted).toBe(true)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')

    await mounted.press(key('escape'))
    // Press 2 finds the turn already aborted, so it falls through to the exit.
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    // The teammate itself is untouched — only the turn was aborted.
    expect(lifecycleAbortController.signal.aborted).toBe(false)
  } finally {
    await mounted.cleanup()
  }
})

test('S3b: escape exits once the runner has cleared currentWorkAbortController', async () => {
  const { task } = createTeammateTask()
  const cleared: InProcessTeammateTaskState = {
    ...task,
    currentWorkAbortController: undefined,
  }
  const mounted = await renderNavigation(viewingState(cleared), false)
  try {
    await mounted.press(key('escape'))
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
  } finally {
    await mounted.cleanup()
  }
})

test('S3c: escape exits on a SINGLE press when the turn is already aborted', async () => {
  const { task, workAbortController, lifecycleAbortController } =
    createTeammateTask()
  // The turn was interrupted but the runner has not cleared the controller yet
  // — the exact state the trap left the user stuck in.
  workAbortController.abort()
  const mounted = await renderNavigation(viewingState(task), false)
  try {
    await mounted.press(key('escape'))
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(lifecycleAbortController.signal.aborted).toBe(false)
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S4 — ink useInput dispatch order: a CHILD subscriber runs before its PARENT.
// This is what makes PromptInput's onSubmit (BaseTextInput, a child of REPL)
// read viewSelectionMode BEFORE useBackgroundTaskNavigation (REPL's own hook)
// clears it, so the Enter that leaves selection mode never submits.
// ---------------------------------------------------------------------------
test('S4: a child useInput subscriber is dispatched before its parent', async () => {
  const order: string[] = []
  function Child(): React.ReactNode {
    useInput(() => {
      order.push('child')
    })
    return null
  }
  function Parent(): React.ReactNode {
    useInput(() => {
      order.push('parent')
    })
    return <Child />
  }
  const io = fakeIo()
  const root = await createRoot({
    stdout: io.stdout,
    stdin: io.stdin,
    patchConsole: false,
  })
  try {
    root.render(<Parent />)
    await Bun.sleep(60)
    io.raw.stdin.write('\r')
    await Bun.sleep(60)
    expect(order.length).toBeGreaterThanOrEqual(2)
    expect(order[0]).toBe('child')
    expect(order[1]).toBe('parent')
  } finally {
    root.unmount()
    await Bun.sleep(30)
    io.raw.stdin.end()
    io.raw.stdout.end()
  }
})
