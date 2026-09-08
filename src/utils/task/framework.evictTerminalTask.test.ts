import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import { isPanelVisibleAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { applyTaskOffsetsAndEvictions, evictTerminalTask } from './framework.js'

// Pins the retain guard in evictTerminalTask. The evictor's grace-period
// predicate must agree with isPanelVisibleAgent: anything the panel still
// draws must survive GC. Before the fix the guard only consulted evictAfter
// and ignored the VALUE of `retain`, so a terminal task with retain:true and
// a past evictAfter was a visible panel row the evictor could delete from
// under the UI. Latent only because enterTeammateView clears evictAfter when
// it sets retain — these tests pin the invariant independently of that.

const PAST = Date.now() - 60_000
const FUTURE = Date.now() + 60_000

type PanelTaskOverrides = {
  status?: TaskState['status']
  notified?: boolean
  retain?: boolean
  evictAfter?: number
}

/**
 * A LocalAgentTaskState-shaped task: carries the `retain` field, so the
 * `'retain' in task` type narrow in the guard matches.
 */
function panelTask(overrides: PanelTaskOverrides = {}): TaskState {
  const { status = 'completed', notified = true, retain = false } = overrides
  const task: Record<string, unknown> = {
    id: 'task-1',
    type: 'local_agent',
    status,
    description: 'panel agent',
    startTime: 0,
    outputFile: '/tmp/task-1.txt',
    outputOffset: 0,
    notified,
    agentId: 'agent-1',
    agentType: 'general-purpose',
    prompt: 'do the thing',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain,
    diskLoaded: false,
  }
  if ('evictAfter' in overrides) {
    task.evictAfter = overrides.evictAfter
  }
  return task as unknown as TaskState
}

/**
 * A task with NO `retain` field at all (shell-shaped). The `'retain' in task`
 * narrow must not match, so the grace period never applies to it.
 */
function shellTask(overrides: { status?: TaskState['status']; notified?: boolean } = {}): TaskState {
  const { status = 'completed', notified = true } = overrides
  return {
    id: 'task-1',
    type: 'local_shell',
    status,
    description: 'ls -la',
    startTime: 0,
    outputFile: '/tmp/task-1.txt',
    outputOffset: 0,
    notified,
    command: 'ls -la',
  } as unknown as TaskState
}

/**
 * Minimal fake store: just enough AppState to drive the updater. Deliberately
 * not a real store — evictTerminalTask only reads `tasks` and returns a new
 * state object.
 */
function runEvict(task: TaskState, taskId = 'task-1'): { evicted: boolean; sameRef: boolean } {
  const initial = { tasks: { 'task-1': task } } as unknown as AppState
  let state = initial
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }

  evictTerminalTask(taskId, setAppState)

  return {
    evicted: state.tasks['task-1'] === undefined,
    sameRef: state === initial,
  }
}

describe('evictTerminalTask — retain guard', () => {
  test('retains a terminal task with retain:true even when evictAfter is in the past', () => {
    const task = panelTask({ retain: true, evictAfter: PAST })

    expect(runEvict(task).evicted).toBe(false)
  })

  test('agrees with isPanelVisibleAgent: a retained past-deadline task is still a panel row', () => {
    const task = panelTask({ retain: true, evictAfter: PAST })

    // The whole point of the guard: the panel still draws this row, so the
    // evictor must not GC it.
    expect(isPanelVisibleAgent(task)).toBe(true)
    expect(runEvict(task).evicted).toBe(false)
  })

  test('evicts a terminal task with retain:false and a past evictAfter', () => {
    const task = panelTask({ retain: false, evictAfter: PAST })

    expect(runEvict(task).evicted).toBe(true)
  })

  test('retains a terminal task with retain:false while evictAfter is in the future', () => {
    const task = panelTask({ retain: false, evictAfter: FUTURE })

    expect(runEvict(task).evicted).toBe(false)
  })

  test('retains a terminal task with retain:false and no evictAfter at all', () => {
    // `?? Infinity` — an unset deadline means "no deadline yet", not "expired".
    const task = panelTask({ retain: false })

    expect(runEvict(task).evicted).toBe(false)
  })

  test('evicts a terminal notified task that has no retain field at all', () => {
    // Proves the `'retain' in task` presence narrow still gates: shell-shaped
    // tasks never get the panel grace period.
    const task = shellTask()

    expect(runEvict(task).evicted).toBe(true)
  })
})

describe('evictTerminalTask — preconditions', () => {
  test('never evicts a non-terminal task, even with an expired evictAfter', () => {
    const task = panelTask({ status: 'running', retain: false, evictAfter: PAST })

    expect(runEvict(task).evicted).toBe(false)
  })

  test('never evicts a task that has not been notified', () => {
    const task = panelTask({ notified: false, retain: false, evictAfter: PAST })

    expect(runEvict(task).evicted).toBe(false)
  })

  test('is a no-op for an unknown task id', () => {
    const task = panelTask({ retain: false, evictAfter: PAST })
    const result = runEvict(task, 'nope-not-a-task')

    expect(result.evicted).toBe(false)
    // Early return keeps the identical state reference — no needless re-render.
    expect(result.sameRef).toBe(true)
  })
})

/**
 * Drive the LAZY GC path. applyTaskOffsetsAndEvictions is the safety net that
 * pollTasks runs with the evictedTaskIds generateTaskAttachments collected: the
 * collector only nominates terminal+notified candidates, and this function is
 * where the actual `delete` decision (and therefore the retain guard) lives.
 * It is synchronous and takes the eviction list directly, so it needs no disk
 * output and no async scaffolding — the same fake setAppState drives it.
 */
function runLazyEvict(task: TaskState): { evicted: boolean; sameRef: boolean } {
  const initial = { tasks: { 'task-1': task } } as unknown as AppState
  let state = initial
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }

  applyTaskOffsetsAndEvictions(setAppState, {}, ['task-1'])

  return {
    evicted: state.tasks['task-1'] === undefined,
    sameRef: state === initial,
  }
}

describe('applyTaskOffsetsAndEvictions — lazy GC retain guard', () => {
  test('does NOT delete a retained task whose evictAfter is in the past', () => {
    // The safety net must not undo what the eager path correctly refused to do.
    const task = panelTask({ retain: true, evictAfter: PAST })

    expect(isPanelVisibleAgent(task)).toBe(true)
    expect(runLazyEvict(task).evicted).toBe(false)
  })

  test('deletes a terminal task with retain:false and a past evictAfter', () => {
    const task = panelTask({ retain: false, evictAfter: PAST })

    expect(runLazyEvict(task).evicted).toBe(true)
  })

  test('does NOT delete a task with retain:false while evictAfter is in the future', () => {
    const task = panelTask({ retain: false, evictAfter: FUTURE })

    expect(runLazyEvict(task).evicted).toBe(false)
  })

  test('deletes a terminal notified task that has no retain field at all', () => {
    const task = shellTask()

    expect(runLazyEvict(task).evicted).toBe(true)
  })

  test('both GC paths agree on every retain/evictAfter combination', () => {
    // The point of the amendment: eager and lazy must never disagree, or a
    // task the panel still draws dies via whichever path runs first.
    const cases: PanelTaskOverrides[] = [
      { retain: true, evictAfter: PAST },
      { retain: true, evictAfter: FUTURE },
      { retain: true },
      { retain: false, evictAfter: PAST },
      { retain: false, evictAfter: FUTURE },
      { retain: false },
    ]

    for (const overrides of cases) {
      const eager = runEvict(panelTask(overrides)).evicted
      const lazy = runLazyEvict(panelTask(overrides)).evicted
      expect({ ...overrides, eager }).toEqual({ ...overrides, eager: lazy })
    }
  })
})
