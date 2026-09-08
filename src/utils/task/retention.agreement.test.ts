import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import { isPanelVisibleAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { applyTaskOffsetsAndEvictions, evictTerminalTask } from './framework.js'
import { isRetainedOrWithinGrace } from './retention.js'

// Agreement suite for the ONE shared retain/grace predicate.
//
// isPanelVisibleAgent (the panel gate) and the two GC paths (the eager
// evictTerminalTask and the lazy applyTaskOffsetsAndEvictions safety net) all
// call isRetainedOrWithinGrace. This suite drives the REAL functions over the
// full (status × retain × evictAfter) matrix and pins the invariant that made
// the predicate shared in the first place:
//
//   THE PANEL NEVER SHOWS A ROW GC CAN DELETE.
//
// framework.evictTerminalTask.test.ts pins the guard's own cases; this file
// pins that the three call sites agree with each other for every input.

const PAST = Date.now() - 60_000
const FUTURE = Date.now() + 60_000

const TERMINAL_STATUSES = ['completed', 'failed', 'killed'] as const
const LIVE_STATUSES = ['running', 'pending'] as const

type Cell = {
  status: TaskState['status']
  retain?: boolean
  /** Absent from the object entirely when the key is omitted. */
  evictAfter?: number
  /** Label for the evictAfter axis, so failures name the cell. */
  deadline: string
  /** False = the `retain` key is not on the object at all. */
  hasRetain: boolean
}

const DEADLINES: { label: string; evictAfter?: number; present: boolean }[] = [
  { label: 'evictAfter=past', evictAfter: PAST, present: true },
  { label: 'evictAfter=future', evictAfter: FUTURE, present: true },
  { label: 'evictAfter=absent', present: false },
  { label: 'evictAfter=0 (dismissed)', evictAfter: 0, present: true },
]

const RETAINS: { label: string; retain?: boolean; hasRetain: boolean }[] = [
  { label: 'retain=true', retain: true, hasRetain: true },
  { label: 'retain=false', retain: false, hasRetain: true },
  { label: 'retain=absent', hasRetain: false },
]

function buildMatrix(): Cell[] {
  const cells: Cell[] = []
  for (const status of [...TERMINAL_STATUSES, ...LIVE_STATUSES]) {
    for (const r of RETAINS) {
      for (const d of DEADLINES) {
        cells.push({
          status,
          ...(r.hasRetain ? { retain: r.retain } : {}),
          ...(d.present ? { evictAfter: d.evictAfter } : {}),
          deadline: d.label,
          hasRetain: r.hasRetain,
        })
      }
    }
  }
  return cells
}

const MATRIX = buildMatrix()

function label(cell: Cell): string {
  const retain = cell.hasRetain ? `retain=${String(cell.retain)}` : 'retain=absent'
  return `${cell.status} / ${retain} / ${cell.deadline}`
}

/**
 * A panel-shaped local_agent task. `notified: true` and a terminal status are
 * the preconditions BOTH GC paths require before the retain guard is even
 * reached — without them the collectors bail earlier and the matrix would
 * prove nothing about the shared predicate.
 */
function panelTask(cell: Cell): TaskState {
  const task: Record<string, unknown> = {
    id: 'task-1',
    type: 'local_agent',
    status: cell.status,
    description: 'panel agent',
    startTime: 0,
    outputFile: '/tmp/task-1.txt',
    outputOffset: 0,
    notified: true,
    agentId: 'agent-1',
    agentType: 'general-purpose',
    prompt: 'do the thing',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    diskLoaded: false,
  }
  if (cell.hasRetain) {
    task.retain = cell.retain
  }
  if ('evictAfter' in cell) {
    task.evictAfter = cell.evictAfter
  }
  return task as unknown as TaskState
}

/** Eager GC path. */
function runEagerEvict(task: TaskState): boolean {
  let state = { tasks: { 'task-1': task } } as unknown as AppState
  evictTerminalTask('task-1', updater => {
    state = updater(state)
  })
  return state.tasks['task-1'] === undefined
}

/** Lazy GC safety net. */
function runLazyEvict(task: TaskState): boolean {
  let state = { tasks: { 'task-1': task } } as unknown as AppState
  applyTaskOffsetsAndEvictions(
    updater => {
      state = updater(state)
    },
    {},
    ['task-1'],
  )
  return state.tasks['task-1'] === undefined
}

describe('retain/grace agreement — the panel never shows a row GC can delete', () => {
  for (const cell of MATRIX) {
    test(label(cell), () => {
      const task = panelTask(cell)
      const visible = isPanelVisibleAgent(task)
      const eager = runEagerEvict(task)
      const lazy = runLazyEvict(task)

      // The invariant: a drawn row must survive BOTH collectors.
      if (visible) {
        expect({ cell: label(cell), eager, lazy }).toEqual({
          cell: label(cell),
          eager: false,
          lazy: false,
        })
      }

      // And the two collectors must never disagree with each other, or the
      // task dies via whichever path happens to run first.
      expect({ cell: label(cell), eager }).toEqual({ cell: label(cell), eager: lazy })
    })
  }
})

describe('isRetainedOrWithinGrace — the shared definition itself', () => {
  const NOW = 1_700_000_000_000

  test('retain=true survives regardless of the deadline', () => {
    expect(isRetainedOrWithinGrace({ retain: true, evictAfter: NOW - 1 }, NOW)).toBe(true)
    expect(isRetainedOrWithinGrace({ retain: true, evictAfter: 0 }, NOW)).toBe(true)
    expect(isRetainedOrWithinGrace({ retain: true }, NOW)).toBe(true)
  })

  test('an unset deadline means "no deadline yet", not "expired"', () => {
    expect(isRetainedOrWithinGrace({ retain: false }, NOW)).toBe(true)
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: undefined }, NOW)).toBe(true)
  })

  test('the grace window is exclusive at the deadline itself', () => {
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: NOW + 1 }, NOW)).toBe(true)
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: NOW }, NOW)).toBe(false)
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: NOW - 1 }, NOW)).toBe(false)
  })

  test('the `retain` presence narrow gates the whole rule', () => {
    // Shapes without the field (shell/monitor/remote/workflow tasks) never get
    // the panel grace period, however their evictAfter reads.
    expect(isRetainedOrWithinGrace({ evictAfter: NOW + 60_000 }, NOW)).toBe(false)
    expect(isRetainedOrWithinGrace({}, NOW)).toBe(false)
    expect(isRetainedOrWithinGrace(undefined, NOW)).toBe(false)
    expect(isRetainedOrWithinGrace(null, NOW)).toBe(false)
    expect(isRetainedOrWithinGrace('not a task', NOW)).toBe(false)
  })

  test('`now` defaults to Date.now()', () => {
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: FUTURE })).toBe(true)
    expect(isRetainedOrWithinGrace({ retain: false, evictAfter: PAST })).toBe(false)
  })
})

describe('isPanelVisibleAgent — composition around the shared predicate', () => {
  const NOW = 1_700_000_000_000

  // The panel gate is `!terminal || isRetainedOrWithinGrace(t, now)`, reached
  // only after isPanelAgentTask and the evictAfter===0 dismissal check. Those
  // three checks are deliberately NOT folded into the predicate: they are the
  // panel's alone, and moving them would change what GC collects.
  test('the dismissal check still short-circuits a retained task', () => {
    const dismissed = panelTask({
      status: 'completed',
      retain: true,
      evictAfter: 0,
      deadline: 'evictAfter=0 (dismissed)',
      hasRetain: true,
    })

    // The shared predicate says "retained" — the panel still hides it.
    expect(isRetainedOrWithinGrace(dismissed, NOW)).toBe(true)
    expect(isPanelVisibleAgent(dismissed, NOW)).toBe(false)
  })

  test('a non-terminal task is visible without consulting the predicate', () => {
    const running = panelTask({
      status: 'running',
      retain: false,
      evictAfter: PAST,
      deadline: 'evictAfter=past',
      hasRetain: true,
    })

    expect(isRetainedOrWithinGrace(running)).toBe(false)
    expect(isPanelVisibleAgent(running)).toBe(true)
  })

  test('a local_agent shape with no `retain` key agrees with GC instead of drawing a doomed row', () => {
    // Unreachable for well-typed state: LocalAgentTaskState declares
    // `retain: boolean` as REQUIRED (tasks/LocalAgentTask/LocalAgentTask.tsx),
    // so every real panel task carries the key and the shared predicate reads
    // exactly like the inline expression it replaced. This cell only exists
    // for hand-built/partial objects, and sharing the predicate closes the
    // hole they used to open: the panel would draw such a row (Infinity > now)
    // while both collectors deleted it (no `'retain' in task` narrow).
    const malformed = panelTask({
      status: 'completed',
      evictAfter: FUTURE,
      deadline: 'evictAfter=future',
      hasRetain: false,
    })

    expect(isRetainedOrWithinGrace(malformed)).toBe(false)
    expect(isPanelVisibleAgent(malformed)).toBe(false)
    expect(runEagerEvict(malformed)).toBe(true)
    expect(runLazyEvict(malformed)).toBe(true)
  })

  test('a main-session agent is never a panel row, however retained', () => {
    const mainSession = {
      ...(panelTask({
        status: 'completed',
        retain: true,
        deadline: 'evictAfter=absent',
        hasRetain: true,
      }) as unknown as Record<string, unknown>),
      agentType: 'main-session',
    } as unknown as TaskState

    expect(isRetainedOrWithinGrace(mainSession)).toBe(true)
    expect(isPanelVisibleAgent(mainSession)).toBe(false)
  })
})
