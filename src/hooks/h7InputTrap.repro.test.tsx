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
 * - S5 pins that Enter typed into an open Ctrl+R search does NOT resolve the
 *   teammate selection, and S5b/S5c are its two negative controls. S5c is the
 *   load-bearing one: Enter must STILL resolve while the prompt merely holds
 *   text, which is why `historySearchActive` is a separate option from
 *   `promptTypingSuppressionActive` rather than a widening of it.
 * - S6/S6b pin the SHIPPED Ctrl+R surface, which is a different surface from
 *   the one S1 pins: with `HISTORY_PICKER` on, Ctrl+R renders the modal
 *   `HistorySearchDialog`, every input `isPromptTypingSuppressionActive` reads
 *   is false, and the only signal left is the overlay contract. S6c/S6d are
 *   their negative controls.
 */
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'

import {
  useIsModalOverlayActive,
  useRegisterOverlay,
} from '../context/overlayContext.js'
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
  // Whether the overlay contract currently reads "something modal owns the
  // keyboard". S6 asserts on it directly so a run in which the registrar never
  // took effect fails as a missing overlay rather than as a silently weaker
  // version of the behavioural assertion.
  modalOverlayActive: boolean
  // The ids of the teammates still RUNNING, as a primitive so the selector is
  // Object.is-stable. 'k' is the data-loss key: the survival assertion has to
  // be that the task is still there and still running, not that some view flag
  // kept its value.
  runningTeammateIds: string
  // The selection, flattened to a primitive for the same reason. Shift+Up/Down
  // and Escape-in-selecting-agent both MOVE it rather than any view flag, so
  // S7b/S7c/S7e/S7f have to read the selection itself to say anything.
  selectedTeammate: string
}

function Harness({
  onReady,
  onState,
  promptTypingSuppressionActive,
  historySearchActive,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onState: (state: ViewState) => void
  promptTypingSuppressionActive: boolean
  historySearchActive: boolean
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation({
    promptTypingSuppressionActive,
    historySearchActive,
  })
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const expandedView = useAppState(s => s.expandedView)
  const modalOverlayActive = useIsModalOverlayActive()
  const runningTeammateIds = useAppState(s =>
    Object.values(s.tasks)
      .filter(t => t.type === 'in_process_teammate' && t.status === 'running')
      .map(t => t.id)
      .join(','),
  )
  const selectedTeammate = useAppState(s =>
    s.selectedTeammate === null
      ? 'none'
      : s.selectedTeammate.kind === 'teammate'
        ? `teammate:${s.selectedTeammate.taskId}`
        : s.selectedTeammate.kind,
  )
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () =>
      onState({
        viewingAgentTaskId,
        viewSelectionMode,
        expandedView,
        modalOverlayActive,
        runningTeammateIds,
        selectedTeammate,
      }),
    [
      viewingAgentTaskId,
      viewSelectionMode,
      expandedView,
      modalOverlayActive,
      runningTeammateIds,
      selectedTeammate,
      onState,
    ],
  )
  return null
}

// The same call `HistorySearchDialog` makes, mounted as a SIBLING of the hook
// under test. The S6 series is about a signal that has to cross a component
// boundary — the dialog registers, the nav hook reads — so the test crosses it
// too instead of pre-seeding `activeOverlays` into the initial state, which
// would prove only that the predicate can be spoofed.
function OverlayRegistrar({ id }: { id: string }): React.ReactNode {
  useRegisterOverlay(id)
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

// Shift+Up/Down is the only branch in this hook that reads a modifier, so it
// needs its own builder rather than a flag on `key()`: every existing call site
// wants shift FALSE and should keep reading that way.
function shiftKey(name: string): KeyboardEvent {
  return new KeyboardEvent({
    kind: 'key',
    name,
    sequence: '\x1b',
    raw: '\x1b',
    ctrl: false,
    shift: true,
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

// The two flags are passed SEPARATELY on purpose: the whole point of the S5
// series is that an open history search and a prompt that merely holds text are
// different states for Enter, so a test has to be able to set one without the
// other. `historySearchActive` defaults to false so the S1–S4 call sites read
// exactly as they did before.
//
// `overlayId` is the S6 series' equivalent and defaults to NONE for the same
// reason: mount an `OverlayRegistrar` beside the harness and the run has a live
// modal overlay, leave it out and S1–S5c read exactly as they do today. It is a
// registration, not a flag — the helper waits for the registering effect to
// reach `AppState` before handing back `press`, because the whole claim is that
// the hook re-reads the contract after the dialog mounts.
async function renderNavigation(
  initialState: AppState,
  promptTypingSuppressionActive: boolean,
  historySearchActive = false,
  overlayId?: string,
): Promise<{
  press: (event: KeyboardEvent) => Promise<void>
  typeRaw: (text: string, settleMs?: number) => Promise<void>
  setOverlayMounted: (mounted: boolean) => Promise<void>
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
    modalOverlayActive: false,
    runningTeammateIds: '',
    selectedTeammate: 'none',
  }
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    io.raw.stdin.end()
    io.raw.stdout.end()
  }
  // Rendering the whole tree from here, rather than once inline, is what lets a
  // test UNMOUNT the overlay mid-run: `AppStateProvider` creates its store in a
  // `useState` initialiser, so re-rendering the root keeps the same store and
  // only the registrar comes and goes — the same thing `PromptInput` does to
  // the dialog when its `onCancel` runs.
  const renderTree = (overlayMounted: boolean): void => {
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
          historySearchActive={historySearchActive}
        />
        {overlayId === undefined || !overlayMounted ? null : (
          <OverlayRegistrar id={overlayId} />
        )}
      </AppStateProvider>,
    )
  }
  try {
    renderTree(true)
    for (let attempts = 0; attempts < 100 && !handler; attempts++) {
      await Bun.sleep(10)
    }
    expect(handler).toBeDefined()
    // `useRegisterOverlay` registers from an effect, so the overlay lands one
    // commit after the handler does. Settling it here keeps a press from racing
    // the registration; whether it actually landed is asserted in the tests, not
    // swallowed by this loop.
    for (
      let attempts = 0;
      attempts < 100 && overlayId !== undefined && !latest.modalOverlayActive;
      attempts++
    ) {
      await Bun.sleep(10)
    }
    return {
      async press(event) {
        handler!(event)
        await Bun.sleep(30)
      },
      // The OTHER delivery path, and the one the running CLI uses: a real
      // keystroke down ink's stdin pipeline into the hook's own `useInput`
      // bridge, rather than a `handleKeyDown` a parent kept a reference to.
      //
      // `settleMs` exists for one key: a LONE escape is deliberately held by
      // `App`'s incomplete-escape flush timer (`NORMAL_TIMEOUT`, 300ms) so it
      // can be told apart from an escape-prefixed sequence, so an escape case
      // has to outwait that timer. At the 60ms default an escape silently never
      // arrives — which is exactly what the S7i delivery control caught before
      // this parameter existed.
      async typeRaw(text, settleMs = 60) {
        io.raw.stdin.write(text)
        await Bun.sleep(settleMs)
      },
      async setOverlayMounted(mounted) {
        renderTree(mounted)
        await Bun.sleep(60)
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

// ---------------------------------------------------------------------------
// S5 — Enter during an open Ctrl+R search. useHistorySearch owns `enter` (its
// historySearch:execute binding consumes it with stopImmediatePropagation), so
// in the steady listener order this branch is never reached at all. It becomes
// reachable once the search-owning subtree remounts and re-appends its useInput
// BEHIND REPL's, which is the order this harness drives directly: the hook is
// called with no competing subscriber, exactly as if the search's listener had
// already been passed over. The guard is what makes the outcome the same in
// both orders.
//
// S5b and S5c are the negative controls, and they are the point: a fix that
// disables Enter generally is a regression, not a fix.
// ---------------------------------------------------------------------------
test('S5: enter typed into the Ctrl+R search does not resolve the selection', async () => {
  const { task } = createTeammateTask()
  // The real state during a search: the prompt buffer is empty and unfocused,
  // so the suppression flag is true ONLY because of the search (S1's point),
  // and the search flag is true on its own.
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', true),
    true,
  )
  try {
    await mounted.press(key('return')) // user meant: run the highlighted match
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S5b: enter with no search still opens the selected transcript', async () => {
  // Negative control in the S1d/S1e idiom. Enter is the only way to confirm a
  // selection, so gating it too broadly traps the user in selecting-agent.
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, ''),
    false,
  )
  try {
    await mounted.press(key('return'))
    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S5c: enter still resolves the selection while the prompt merely holds text', async () => {
  // THE control that pins the shape of the fix. Do not "tidy" the Enter branch
  // onto promptTypingSuppressionActive: unlike 'f' and 'k', Enter is not a
  // character that would land in the prompt buffer, and PromptInput's onSubmit
  // already returns early while viewSelectionMode is 'selecting-agent'. Gate
  // Enter on the collapsed typing flag and this state has NO Enter behaviour at
  // all — nothing resolves the selection and nothing submits. So: prompt holds
  // a draft, no search running, Enter must still confirm the selection.
  const promptTypingSuppressionActive = isPromptTypingSuppressionActive(
    false,
    'a draft the user has not sent yet',
  )
  expect(promptTypingSuppressionActive).toBe(true)

  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    promptTypingSuppressionActive,
    false,
  )
  try {
    await mounted.press(key('return'))
    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S6 — the Ctrl+R surface the SHIPPED CLI actually opens, which is not the one
// S1 pins. `HISTORY_PICKER` is true in the build config, so `useHistorySearch`'s
// inline search is gated off and Ctrl+R renders the modal `HistorySearchDialog`
// instead. That dialog keeps its query in its own `useState` and never writes
// the prompt, so all three inputs `isPromptTypingSuppressionActive` reads —
// `isPromptInputActive`, `inputValue`, `isSearchingHistory` — are FALSE, the
// helper returns false, and the S1 guard is blind to the surface. Nor does the
// dialog stop the letter from its side: `App` emits `'input'` to every
// `useInput` subscriber — this hook's bridge among them — BEFORE dispatching
// the DOM keydown that `FuzzyPicker`'s stop list runs on, and on a different
// event object. So a query containing 'k' reaches this hook and kills the
// selected teammate. (See the S7 header: the same ordering is why the other
// branches leak too.)
//
// What IS true during that dialog is the overlay contract:
// `HistorySearchDialog` calls `useRegisterOverlay('history-search')` at mount,
// `'history-search'` is not in `NON_MODAL_OVERLAYS`, and so
// `useIsModalOverlayActive` reads true — the same predicate `PromptInput`
// already gates its own Ctrl+R and Ctrl+G bindings on. S6/S6b pin that the two
// destructive letters stand down on THAT question with every legacy input
// false.
//
// S6c/S6d are the negative controls, in the S1d/S1e idiom, and they are the
// point: with no overlay registered the letters must still act. A guard that
// disables them generally is a regression, not a fix. These runs differ from
// S1d/S1e in exactly one variable — whether an overlay is registered — which is
// what makes the overlay predicate, and not some incidental change, the thing
// that moved the outcome.
//
// The overlay is registered by mounting the REAL `useRegisterOverlay` hook in
// the tree rather than by seeding `activeOverlays`, so the executed chain is
// the shipped one: component mounts → effect registers → `AppState` →
// `useIsModalOverlayActive` → the branch stands down. (What a unit test here
// CANNOT execute is the `feature('HISTORY_PICKER')` render branch: `feature()`
// is rewritten to a literal at bundle time and reads FALSE in an unbundled
// `bun test` run. That the dialog is the shipped Ctrl+R surface is a source
// fact about the build config, not something these tests run.)
// ---------------------------------------------------------------------------
test('S6: k typed into the modal history search leaves the selected teammate alive', async () => {
  // The shipped-build reading of REPL's own state during the modal search: the
  // prompt is unfocused, its buffer is empty, and the inline-search flag is
  // false because that surface is the one Ctrl+R does NOT open. The helper is
  // called for real rather than asserted about, so this stays a measurement of
  // the legacy guard and not a claim about it.
  const suppression = isPromptTypingSuppressionActive(false, '', false)
  expect(suppression).toBe(false)

  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    suppression,
    false,
    'history-search',
  )
  try {
    // The ONE variable that differs from S1d, which kills on this same press.
    expect(mounted.state().modalOverlayActive).toBe(true)

    await mounted.press(key('k')) // user meant: type "k" into the search box

    expect(lifecycleAbortController.signal.aborted).toBe(false)
    // Alive, not merely un-aborted: the row is still in the task list and still
    // running, which is what "the work was not lost" means here.
    expect(mounted.state().runningTeammateIds).toBe(task.id)
    // …and the selection survives, for the Escape or Enter that ends it.
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S6b: f typed into the modal history search does not open the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    await mounted.press(key('f'))

    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S6c: k with no overlay and an idle prompt still kills the teammate', async () => {
  // Negative control for S6: same legacy inputs, same press, no overlay.
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.press(key('k'))

    expect(lifecycleAbortController.signal.aborted).toBe(true)
    // The kill is the one that took the row out of the running set.
    expect(mounted.state().runningTeammateIds).toBe('')
  } finally {
    await mounted.cleanup()
  }
})

test('S6d: f with no overlay and an idle prompt still opens the transcript', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.press(key('f'))

    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S6e/S6f — the same guard down the OTHER delivery path. S6–S6d call
// `handleKeyDown` the way every case above does; the running CLI does not. It
// reaches this hook through the `useInput` bridge at the bottom of
// `useBackgroundTaskNavigation`, and that bridge subscribes ONCE on mount while
// the dialog registers its overlay LATER. So "the branch stands down" is only
// true of the real path if the bridge dispatches to the current render's
// closure rather than the one it was mounted with — `useInput` routes through
// `useEventCallback` precisely so it does. These two pin that end-to-end
// instead of trusting it: a raw 'k' arrives, the hook consults an overlay that
// was registered after subscription, and stands down.
//
// S6f is S6e's delivery control and is why S6e cannot pass vacuously: the same
// raw keystroke down the same pipeline, with no overlay, must still kill. If
// the write never reached the bridge, S6f is the test that fails.
// ---------------------------------------------------------------------------
test('S6e: a raw k through the useInput bridge respects an overlay registered after mount', async () => {
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    await mounted.typeRaw('k')

    expect(lifecycleAbortController.signal.aborted).toBe(false)
    expect(mounted.state().runningTeammateIds).toBe(task.id)
  } finally {
    await mounted.cleanup()
  }
})

test('S6f: a raw k through the useInput bridge still kills with no overlay', async () => {
  const { task, lifecycleAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.typeRaw('k')

    expect(lifecycleAbortController.signal.aborted).toBe(true)
    expect(mounted.state().runningTeammateIds).toBe('')
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S7 — the other three branches that a dialog's keystrokes reach.
//
// The reason they reach it is NOT that this hook is late in some propagation
// chain it could be lifted out of. `App`'s input loop emits `'input'` to every
// `useInput` subscriber — this hook's bridge among them — and only THEN calls
// `dispatchKeyboardEvent`, which builds a different event object for the DOM
// `onKeyDown` path. `FuzzyPicker`'s stop list lives on that second path, so it
// runs on the wrong object, after this hook has already acted. Nothing a dialog
// does can stop this hook; the only thing that can is this hook asking whether
// a dialog is up. That makes the overlay term the same answer for all of them:
//
// - S7  Escape in viewing-agent: it aborts the teammate's CURRENT TURN. Same
//       defect class as 'k', smaller blast radius — the key was aimed at the
//       dialog and it destroys in-flight work.
// - S7b Escape in selecting-agent: it drops the selection the user built.
// - S7c Shift+Up/Down: it MOVES the selection while the dialog is on screen,
//       and the drift survives the dialog's dismissal, so the next 'k' lands on
//       a row the user never chose.
//
// S7d/S7e/S7f are the negative controls and they are the load-bearing half
// here: Escape is the exit key, and a gate that disabled it generally would be
// a keyboard trap — strictly worse than the bug. S7g pins that the exit is
// LAYERED rather than lost: the dialog's own Escape dismisses it, and the next
// Escape does what Escape has always done.
// ---------------------------------------------------------------------------
test('S7: escape with an overlay up does not abort the viewed teammate turn', async () => {
  const { task, workAbortController, lifecycleAbortController } =
    createTeammateTask()
  const mounted = await renderNavigation(
    viewingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    await mounted.press(key('escape')) // user meant: close the dialog

    // The turn the teammate is in the middle of is untouched…
    expect(workAbortController.signal.aborted).toBe(false)
    expect(lifecycleAbortController.signal.aborted).toBe(false)
    // …and so is the view, which the dialog was drawn over.
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
    expect(mounted.state().viewingAgentTaskId).toBe(task.id)
  } finally {
    await mounted.cleanup()
  }
})

test('S7b: escape with an overlay up does not drop the teammate selection', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    await mounted.press(key('escape'))

    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
    expect(mounted.state().selectedTeammate).toBe(`teammate:${task.id}`)
  } finally {
    await mounted.cleanup()
  }
})

test('S7c: shift+up with an overlay up does not move the selection', async () => {
  // The compound this one breaks: the landed 'k' guard stops the kill WHILE the
  // dialog is up, but a selection that drifted during the dialog outlives it,
  // so the next 'k' — legitimately typed, no dialog, guard satisfied — lands on
  // a row the user never selected.
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)
    expect(mounted.state().selectedTeammate).toBe(`teammate:${task.id}`)

    await mounted.press(shiftKey('up'))

    expect(mounted.state().selectedTeammate).toBe(`teammate:${task.id}`)
  } finally {
    await mounted.cleanup()
  }
})

test('S7d: escape with no overlay still aborts the viewed teammate turn', async () => {
  // Negative control, and the S3 press-1 contract restated: abort the turn,
  // stay in the view.
  const { task, workAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    viewingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.press(key('escape'))

    expect(workAbortController.signal.aborted).toBe(true)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S7e: escape with no overlay still leaves selecting-agent', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.press(key('escape'))

    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().selectedTeammate).toBe('none')
    // S2's contract: leaving selection mode does not collapse the tree.
    expect(mounted.state().expandedView).toBe('teammates')
  } finally {
    await mounted.cleanup()
  }
})

test('S7f: shift+up with no overlay still moves the selection', async () => {
  const { task } = createTeammateTask()
  const mounted = await renderNavigation(
    selectingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)
    expect(mounted.state().selectedTeammate).toBe(`teammate:${task.id}`)

    await mounted.press(shiftKey('up'))

    // One step up from the only teammate is the leader row.
    expect(mounted.state().selectedTeammate).toBe('leader')
  } finally {
    await mounted.cleanup()
  }
})

test('S7g: the escape exit is LAYERED by the overlay, not lost to it', async () => {
  // THE case that makes the Escape gate safe to ship. Escape is the exit key,
  // so the failure mode of gating it is a keyboard trap — worse than the bug it
  // fixes. The gate is only defensible if every press still lands somewhere and
  // the view is still reachable by keyboard alone.
  //
  // The sequence is the real one: the dialog is up, Escape dismisses THE DIALOG
  // (its own onCancel — modelled here by unmounting the registrar, which is what
  // PromptInput's setShowHistoryPicker(false) does), and from there Escape means
  // what it has always meant. No overlay in the tree can be registered without
  // an Escape that dismisses it: use-select-input registers 'select' only when
  // onCancel exists, and every dialog component has a cancel path.
  const { task, workAbortController, lifecycleAbortController } =
    createTeammateTask()
  const mounted = await renderNavigation(
    viewingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    // Press 1 — belongs to the dialog. The teammate's turn survives it.
    await mounted.press(key('escape'))
    expect(workAbortController.signal.aborted).toBe(false)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')

    // …and the dialog really goes away on that press.
    await mounted.setOverlayMounted(false)
    expect(mounted.state().modalOverlayActive).toBe(false)

    // Press 2 — the ordinary S3 contract resumes: abort the turn, stay.
    await mounted.press(key('escape'))
    expect(workAbortController.signal.aborted).toBe(true)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')

    // Press 3 — the view is still LEAVABLE by keyboard, which is the whole
    // point: one extra press, not a trap.
    await mounted.press(key('escape'))
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().viewingAgentTaskId).toBeUndefined()
    // The teammate itself was never killed by any of the three.
    expect(lifecycleAbortController.signal.aborted).toBe(false)
  } finally {
    await mounted.cleanup()
  }
})

// ---------------------------------------------------------------------------
// S7h/S7i — the Escape gate down the REAL delivery path, in the S6e/S6f idiom.
// This is the branch that aborts in-flight work, so it gets the same treatment
// the kill key got: a raw keystroke through ink's stdin pipeline into the
// hook's own `useInput` bridge, against an overlay registered AFTER that bridge
// subscribed. S7i is the delivery control — same raw byte, no overlay, the turn
// must still abort — so S7h cannot pass on a write that never arrived.
// ---------------------------------------------------------------------------
test('S7h: a raw escape through the useInput bridge respects an overlay registered after mount', async () => {
  const { task, workAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    viewingState(task),
    isPromptTypingSuppressionActive(false, '', false),
    false,
    'history-search',
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(true)

    // Outwaits App's 300ms incomplete-escape flush timer; see `typeRaw`.
    await mounted.typeRaw('\x1b', 400)

    expect(workAbortController.signal.aborted).toBe(false)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})

test('S7i: a raw escape through the useInput bridge still aborts the turn with no overlay', async () => {
  const { task, workAbortController } = createTeammateTask()
  const mounted = await renderNavigation(
    viewingState(task),
    isPromptTypingSuppressionActive(false, '', false),
  )
  try {
    expect(mounted.state().modalOverlayActive).toBe(false)

    await mounted.typeRaw('\x1b', 400)

    expect(workAbortController.signal.aborted).toBe(true)
    expect(mounted.state().viewSelectionMode).toBe('viewing-agent')
  } finally {
    await mounted.cleanup()
  }
})
