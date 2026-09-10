import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'

import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { type AppState, AppStateProvider, useAppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getRunningTeammatesSorted } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { TEAMMATE_GRACE_MS } from '../utils/task/framework.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

/**
 * Shift+Up/Down walk the team tree depth-first: a sub-lead is followed by its
 * own sub-team before the next root-team sibling, because selection steps
 * through getRunningTeammatesSorted and selectedIPAgentIndex indexes that same
 * array. Enter opens whatever that index points at.
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
  selectedIPAgentIndex: number
  expandedView: string
  viewingAgentTaskId: string | undefined
}

function stateWith(teammates: InProcessTeammateTaskState[]): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
  }
}

function Harness({
  onReady,
  onState,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onState: (state: Observed) => void
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation()
  const selectedIPAgentIndex = useAppState(s => s.selectedIPAgentIndex)
  const expandedView = useAppState(s => s.expandedView)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () => onState({ selectedIPAgentIndex, expandedView, viewingAgentTaskId }),
    [selectedIPAgentIndex, expandedView, viewingAgentTaskId, onState],
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
  let latest: Observed = {
    selectedIPAgentIndex: -1,
    expandedView: 'none',
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
    expect(rendered.state().selectedIPAgentIndex).toBe(-1)

    const visited: string[] = []
    for (let step = 0; step < DEPTH_FIRST.length; step++) {
      await rendered.press(arrow('down', true))
      const index = rendered.state().selectedIPAgentIndex
      expect(index).toBe(step)
      visited.push(ordered[index]!.identity.agentName)
    }
    expect(visited).toEqual(DEPTH_FIRST)

    // One more lands on the "hide" row, and the next wraps back to the leader.
    await rendered.press(arrow('down', true))
    expect(rendered.state().selectedIPAgentIndex).toBe(DEPTH_FIRST.length)
    await rendered.press(arrow('down', true))
    expect(rendered.state().selectedIPAgentIndex).toBe(-1)
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
    expect(rendered.state().selectedIPAgentIndex).toBe(DEPTH_FIRST.length)

    const visited: string[] = []
    for (let step = 0; step < DEPTH_FIRST.length; step++) {
      await rendered.press(arrow('up', true))
      visited.push(
        ordered[rendered.state().selectedIPAgentIndex]!.identity.agentName,
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
    expect(rendered.state().selectedIPAgentIndex).toBe(2)
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
    expect(rendered.state().selectedIPAgentIndex).toBe(3)
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
    expect(rendered.state().selectedIPAgentIndex).toBe(2)
    expect(ordered[2]!.identity.agentName).toBe('worker-1')

    // And the grace row is counted like any other: the hide row is still one
    // past the last teammate of the depth-first order.
    for (let step = 0; step < DEPTH_FIRST.length - 2; step++) {
      await rendered.press(arrow('down', true))
    }
    expect(rendered.state().selectedIPAgentIndex).toBe(DEPTH_FIRST.length)
  } finally {
    await rendered.cleanup()
  }
})
