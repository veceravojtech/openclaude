import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'

import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import {
  type AppState,
  AppStateProvider,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getRunningTeammatesSorted } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { TeammateSelection } from '../tasks/InProcessTeammateTask/teammateSelection.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { TEAMMATE_GRACE_MS } from '../utils/task/framework.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

/**
 * Shift+Up/Down walk the team tree depth-first: a sub-lead is followed by its
 * own sub-team before the next root-team sibling, because the stepper walks
 * getRunningTeammatesSorted. What it STORES is the task id of the row it landed
 * on, not the position, so the cases below read the position back by looking
 * the stored id up in that same order — and the last group pins the difference
 * that makes: a row arriving or leaving cannot move the highlight to a
 * different teammate, and a departed row hands it to the nearest survivor.
 */

beforeEach(async () => {
  await acquireSharedMutationLock(
    'hooks/useBackgroundTaskNavigation.treeOrder.test.tsx',
  )
})

afterEach(() => {
  releaseSharedMutationLock()
})

function teammate(
  name: string,
  teamName: string,
): InProcessTeammateTaskState {
  return {
    id: `task-${teamName}-${name}`,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: working`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${name}.log`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@${teamName}`,
      agentName: name,
      teamName,
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: `prompt of ${name}`,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: true,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

/**
 * The same teammate after its run ended, while its row is still inside the
 * retention grace window: a terminal status, `retain: false` and an evictAfter
 * TEAMMATE_GRACE_MS out. getRunningTeammatesSorted keeps such a row in the
 * order, so selection must be able to walk onto it.
 */
function graced(name: string, teamName: string): InProcessTeammateTaskState {
  return {
    ...teammate(name, teamName),
    status: 'completed',
    retain: false,
    evictAfter: Date.now() + TEAMMATE_GRACE_MS,
  }
}

/**
 * The shared two-level fixture: root team `email` with alice, supervisor and
 * zoe, plus supervisor's sub-team `email/supervisor` with worker-1 and
 * worker-2, fed in shuffled.
 */
const TWO_LEVEL = [
  teammate('zoe', 'email'),
  teammate('worker-2', 'email/supervisor'),
  teammate('alice', 'email'),
  teammate('worker-1', 'email/supervisor'),
  teammate('supervisor', 'email'),
]

const DEPTH_FIRST = ['alice', 'supervisor', 'worker-1', 'worker-2', 'zoe']

type Observed = {
  /**
   * The position the SELECTION currently resolves to in the shared order: -1
   * for the leader, the row's index for a teammate, and order.length for the
   * hide row — the exact mapping the removed selectedIPAgentIndex held — plus
   * the two sentinels {@link indexOfSelection} gives the states that resolve to
   * no row at all. Derived here, never stored, which is the point of the unit.
   */
  selectedIndex: number
  selectedTeammate: TeammateSelection | null
  expandedView: string
  viewSelectionMode: string
  viewingAgentTaskId: string | undefined
}

/**
 * The two states that name no row. They used to read back as -1, which is also
 * the leader, so a `toBe(-1)` could not tell "parked on the leader" from a
 * selection left dangling on a task id the order does not contain, or dropped
 * to null — both of which draw no pointer on the leader row. Giving them their
 * own values leaves -1 meaning the leader and nothing else.
 */
const DANGLING_ROW = -2
const NO_SELECTION = -3

/** The index a selection resolves to, or a sentinel when it names no row. */
function indexOfSelection(state: AppState): number {
  const selection = state.selectedTeammate
  if (selection === null) return NO_SELECTION
  if (selection.kind === 'leader') return -1
  const order = getRunningTeammatesSorted(state.tasks)
  if (selection.kind === 'hide') return order.length
  const index = order.findIndex(task => task.id === selection.taskId)
  return index === -1 ? DANGLING_ROW : index
}

function stateWith(teammates: InProcessTeammateTaskState[]): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
  }
}

function Harness({
  onReady,
  onSetTasks,
  onState,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onSetTasks: (
    setTasks: (teammates: InProcessTeammateTaskState[]) => void,
  ) => void
  onState: (state: Observed) => void
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation()
  const selectedIndex = useAppState(indexOfSelection)
  const selectedTeammate = useAppState(s => s.selectedTeammate)
  const expandedView = useAppState(s => s.expandedView)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () =>
      onSetTasks(teammates =>
        setAppState(prev => ({
          ...prev,
          tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
        })),
      ),
    [onSetTasks, setAppState],
  )
  useEffect(
    () =>
      onState({
        selectedIndex,
        selectedTeammate,
        expandedView,
        viewSelectionMode,
        viewingAgentTaskId,
      }),
    [
      selectedIndex,
      selectedTeammate,
      expandedView,
      viewSelectionMode,
      viewingAgentTaskId,
      onState,
    ],
  )
  return null
}

function arrow(name: 'up' | 'down', shift: boolean): KeyboardEvent {
  const sequence = `\x1b[1;2${name === 'down' ? 'B' : 'A'}`
  return new KeyboardEvent({
    kind: 'key',
    name,
    sequence,
    raw: sequence,
    ctrl: false,
    shift,
    meta: false,
    option: false,
    super: false,
    fn: false,
    isPasted: false,
  })
}

function enter(): KeyboardEvent {
  return new KeyboardEvent({
    kind: 'key',
    name: 'return',
    sequence: '\r',
    raw: '\r',
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    fn: false,
    isPasted: false,
  })
}

async function renderNavigation(initialState: AppState): Promise<{
  press: (event: KeyboardEvent) => Promise<void>
  setTeammates: (teammates: InProcessTeammateTaskState[]) => Promise<void>
  state: () => Observed
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
  let setTasks: ((teammates: InProcessTeammateTaskState[]) => void) | undefined
  let latest: Observed = {
    selectedIndex: NO_SELECTION,
    selectedTeammate: null,
    expandedView: 'none',
    viewSelectionMode: 'none',
    viewingAgentTaskId: undefined,
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
          onSetTasks={value => {
            setTasks = value
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
      async press(event) {
        handler!(event)
        await Bun.sleep(30)
      },
      async setTeammates(teammates) {
        setTasks!(teammates)
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

test('Shift+Down walks the team tree depth-first, sub-team before the next sibling', async () => {
  const ordered = getRunningTeammatesSorted(stateWith(TWO_LEVEL).tasks)
  expect(ordered.map(t => t.identity.agentName)).toEqual(DEPTH_FIRST)

  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    // The first Shift+Down expands the tree and parks on the leader row.
    await rendered.press(arrow('down', true))
    expect(rendered.state().expandedView).toBe('teammates')
    expect(rendered.state().selectedIndex).toBe(-1)
    expect(rendered.state().selectedTeammate).toEqual({ kind: 'leader' })

    const visited: string[] = []
    for (let step = 0; step < DEPTH_FIRST.length; step++) {
      await rendered.press(arrow('down', true))
      const index = rendered.state().selectedIndex
      expect(index).toBe(step)
      visited.push(ordered[index]!.identity.agentName)
    }
    expect(visited).toEqual(DEPTH_FIRST)

    // One more lands on the "hide" row, and the next wraps back to the leader.
    await rendered.press(arrow('down', true))
    expect(rendered.state().selectedIndex).toBe(DEPTH_FIRST.length)
    await rendered.press(arrow('down', true))
    expect(rendered.state().selectedIndex).toBe(-1)
    expect(rendered.state().selectedTeammate).toEqual({ kind: 'leader' })
  } finally {
    await rendered.cleanup()
  }
})

test('Shift+Up walks the same order backwards', async () => {
  const ordered = getRunningTeammatesSorted(stateWith(TWO_LEVEL).tasks)
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    // Expand, then step up from the leader row: hide row first, then the last
    // teammate of the depth-first order and backwards from there.
    await rendered.press(arrow('up', true))
    await rendered.press(arrow('up', true))
    expect(rendered.state().selectedIndex).toBe(DEPTH_FIRST.length)

    const visited: string[] = []
    for (let step = 0; step < DEPTH_FIRST.length; step++) {
      await rendered.press(arrow('up', true))
      visited.push(
        ordered[rendered.state().selectedIndex]!.identity.agentName,
      )
    }
    expect(visited).toEqual([...DEPTH_FIRST].reverse())
  } finally {
    await rendered.cleanup()
  }
})

test('Enter opens the sub-team member the depth-first index points at', async () => {
  const ordered = getRunningTeammatesSorted(stateWith(TWO_LEVEL).tasks)
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    // Expand, then three steps down: leader → alice → supervisor → worker-1,
    // the first member of supervisor's sub-team.
    for (let step = 0; step < 4; step++) {
      await rendered.press(arrow('down', true))
    }
    expect(rendered.state().selectedIndex).toBe(2)
    expect(ordered[2]!.identity.agentName).toBe('worker-1')

    await rendered.press(enter())
    expect(rendered.state().viewingAgentTaskId).toBe(ordered[2]!.id)
  } finally {
    await rendered.cleanup()
  }
})

test('a three-level tree steps into the grandchild before the next sibling', async () => {
  const threeLevel = [
    ...TWO_LEVEL,
    teammate('deputy', 'email/supervisor/worker-1'),
  ]
  const ordered = getRunningTeammatesSorted(stateWith(threeLevel).tasks)
  expect(ordered.map(t => t.identity.agentName)).toEqual([
    'alice',
    'supervisor',
    'worker-1',
    'deputy',
    'worker-2',
    'zoe',
  ])

  const rendered = await renderNavigation(stateWith(threeLevel))
  try {
    for (let step = 0; step < 5; step++) {
      await rendered.press(arrow('down', true))
    }
    expect(rendered.state().selectedIndex).toBe(3)
    expect(ordered[3]!.identity.agentName).toBe('deputy')
  } finally {
    await rendered.cleanup()
  }
})

test('Shift+Down steps onto a teammate still inside its grace window', async () => {
  const withGrace = [
    ...TWO_LEVEL.filter(t => t.identity.agentName !== 'worker-1'),
    graced('worker-1', 'email/supervisor'),
  ]
  const ordered = getRunningTeammatesSorted(stateWith(withGrace).tasks)
  expect(ordered.map(t => t.identity.agentName)).toEqual(DEPTH_FIRST)
  expect(ordered[2]!.status).toBe('completed')

  const rendered = await renderNavigation(stateWith(withGrace))
  try {
    // Expand, then three steps: leader -> alice -> supervisor -> worker-1, the
    // finished row sitting in the middle of the order. An order narrowed back
    // to `status === 'running'` would put worker-2 under this index instead.
    for (let step = 0; step < 4; step++) {
      await rendered.press(arrow('down', true))
    }
    expect(rendered.state().selectedIndex).toBe(2)
    expect(ordered[2]!.identity.agentName).toBe('worker-1')

    // And the grace row is counted like any other: the hide row is still one
    // past the last teammate of the depth-first order.
    for (let step = 0; step < DEPTH_FIRST.length - 2; step++) {
      await rendered.press(arrow('down', true))
    }
    expect(rendered.state().selectedIndex).toBe(DEPTH_FIRST.length)
  } finally {
    await rendered.cleanup()
  }
})

/** The id `teammate()` gives a row, so a case can name the teammate it means. */
function idOf(name: string, teamName: string): string {
  return `task-${teamName}-${name}`
}

/** Expand the tree, then step `steps` rows down from the leader. */
async function selectRow(
  rendered: Awaited<ReturnType<typeof renderNavigation>>,
  steps: number,
): Promise<void> {
  for (let step = 0; step < steps + 1; step++) {
    await rendered.press(arrow('down', true))
  }
}

test('a teammate arriving ABOVE the selection leaves the highlight on the same teammate', async () => {
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    await selectRow(rendered, 2)
    const selected = rendered.state().selectedTeammate
    expect(selected).toEqual({
      kind: 'teammate',
      taskId: idOf('supervisor', 'email'),
    })
    expect(rendered.state().selectedIndex).toBe(1)

    await rendered.setTeammates([teammate('aaron', 'email'), ...TWO_LEVEL])

    // Same teammate, one row further down. A positional selection would have
    // stayed at index 1 and quietly slid onto `alice`.
    expect(rendered.state().selectedTeammate).toEqual(selected)
    expect(rendered.state().selectedIndex).toBe(2)
  } finally {
    await rendered.cleanup()
  }
})

test('a teammate LEAVING above the selection leaves the highlight on the same teammate', async () => {
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    await selectRow(rendered, 4)
    const selected = rendered.state().selectedTeammate
    expect(selected).toEqual({
      kind: 'teammate',
      taskId: idOf('worker-2', 'email/supervisor'),
    })
    expect(rendered.state().selectedIndex).toBe(3)

    await rendered.setTeammates(
      TWO_LEVEL.filter(t => t.identity.agentName !== 'alice'),
    )

    expect(rendered.state().selectedTeammate).toEqual(selected)
    expect(rendered.state().selectedIndex).toBe(2)
  } finally {
    await rendered.cleanup()
  }
})

test('a leave+join that keeps the COUNT unchanged still keeps the selection', async () => {
  // The case the old count-keyed clamp could not see at all.
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    await selectRow(rendered, 4)
    const selected = rendered.state().selectedTeammate
    expect(rendered.state().selectedIndex).toBe(3)

    await rendered.setTeammates([
      teammate('aaron', 'email'),
      ...TWO_LEVEL.filter(t => t.identity.agentName !== 'zoe'),
    ])

    expect(rendered.state().selectedTeammate).toEqual(selected)
    // Still worker-2 — now the LAST row, where positional keeping would have
    // left the highlight on worker-1.
    expect(rendered.state().selectedIndex).toBe(4)
  } finally {
    await rendered.cleanup()
  }
})

test('the selected row leaving hands the highlight to its previous sibling', async () => {
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    await selectRow(rendered, 4)
    expect(rendered.state().selectedIndex).toBe(3)

    await rendered.setTeammates(
      TWO_LEVEL.filter(t => t.identity.agentName !== 'worker-2'),
    )

    expect(rendered.state().selectedTeammate).toEqual({
      kind: 'teammate',
      taskId: idOf('worker-1', 'email/supervisor'),
    })
    expect(rendered.state().selectedIndex).toBe(2)
  } finally {
    await rendered.cleanup()
  }
})

test('the first row of a sub-team leaving hands the highlight to its sub-lead', async () => {
  const rendered = await renderNavigation(stateWith(TWO_LEVEL))
  try {
    await selectRow(rendered, 3)
    expect(rendered.state().selectedTeammate).toEqual({
      kind: 'teammate',
      taskId: idOf('worker-1', 'email/supervisor'),
    })

    await rendered.setTeammates(
      TWO_LEVEL.filter(t => t.identity.agentName !== 'worker-1'),
    )

    expect(rendered.state().selectedTeammate).toEqual({
      kind: 'teammate',
      taskId: idOf('supervisor', 'email'),
    })
  } finally {
    await rendered.cleanup()
  }
})

test('the last teammate leaving takes the selection back to the leader and leaves selection mode', async () => {
  const rendered = await renderNavigation(stateWith([TWO_LEVEL[2]!]))
  try {
    await selectRow(rendered, 1)
    expect(rendered.state().selectedTeammate).toEqual({
      kind: 'teammate',
      taskId: idOf('alice', 'email'),
    })
    expect(rendered.state().viewSelectionMode).toBe('selecting-agent')

    await rendered.setTeammates([])

    expect(rendered.state().selectedTeammate).toEqual({ kind: 'leader' })
    expect(rendered.state().viewSelectionMode).toBe('none')
  } finally {
    await rendered.cleanup()
  }
})

test('the panel showing its empty state can still be entered, hide row included', async () => {
  // S1: Shift+Down used to be a hard no-op with zero rows, so the hide row the
  // tree draws in selection mode was unreachable by key. The panel is expanded
  // here (its shipped default), so the press steps one row down from the leader
  // — which with no teammates at all IS the hide row — and the next wraps back.
  const rendered = await renderNavigation({
    ...getDefaultAppState(),
    expandedView: 'teammates',
  })
  try {
    await rendered.press(arrow('down', true))
    expect(rendered.state().viewSelectionMode).toBe('selecting-agent')
    expect(rendered.state().selectedTeammate).toEqual({ kind: 'hide' })

    await rendered.press(arrow('down', true))
    expect(rendered.state().selectedTeammate).toEqual({ kind: 'leader' })

    // Enter on the hide row still collapses the panel.
    await rendered.press(arrow('down', true))
    await rendered.press(enter())
    expect(rendered.state().expandedView).toBe('none')
    expect(rendered.state().viewSelectionMode).toBe('none')
    expect(rendered.state().selectedTeammate).toBeNull()
  } finally {
    await rendered.cleanup()
  }
})
