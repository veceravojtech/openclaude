import { describe, expect, test } from 'bun:test'

import { isTerminalTaskStatus, type TaskStatus } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  applyTaskOffsetsAndEvictions,
  evictTerminalTask,
  TEAMMATE_GRACE_MS,
} from './framework.js'
import { isRetainedOrWithinGrace } from './retention.js'

/**
 * The 30s grace an in-process teammate's row gets when it finishes, and the ONE
 * eviction funnel that honours it.
 *
 * Before this, a completed or failed teammate was evicted from AppState
 * synchronously and a killed one lingered 3s undrawn, so a row could vanish from
 * under the cursor between two keystrokes. The row now survives for
 * TEAMMATE_GRACE_MS because the task carries the same retain/grace pair the
 * coordinator panel's local agents use — which means the same shared predicate
 * and the same two evictors, with no second rule and no collector of its own.
 */

const NOW = 1_700_000_000_000

function teammate(
  status: TaskStatus,
  extra: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: 'task-worker',
    type: 'in_process_teammate',
    status,
    description: 'worker: working',
    startTime: NOW - 5_000,
    outputFile: '/tmp/worker.log',
    outputOffset: 0,
    notified: true,
    identity: {
      agentId: 'worker@email',
      agentName: 'worker',
      teamName: 'email',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: '',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...extra,
  }
}

/**
 * The pair the three terminal-marking sites write, as they write it, relative to
 * `at`. The evictors take no `now` argument — they are the production path and
 * read the real clock — so their cases pass Date.now() here while the predicate's
 * own cases use the fixed NOW and an explicit `now`.
 */
function inGrace(
  status: TaskStatus,
  at: number = NOW,
): InProcessTeammateTaskState {
  return teammate(status, { retain: false, evictAfter: at + TEAMMATE_GRACE_MS })
}

function stateWith(task: InProcessTeammateTaskState): AppState {
  return { tasks: { [task.id]: task } } as unknown as AppState
}

/** A minimal setAppState that records the result of the updater. */
function recorder(task: InProcessTeammateTaskState): {
  setAppState: (updater: (prev: AppState) => AppState) => void
  tasks: () => AppState['tasks']
} {
  let state = stateWith(task)
  return {
    setAppState: updater => {
      state = updater(state)
    },
    tasks: () => state.tasks,
  }
}

describe('TEAMMATE_GRACE_MS', () => {
  test('is the 30s the coordinator panel already gives a finished agent', () => {
    expect(TEAMMATE_GRACE_MS).toBe(30_000)
  })
})

describe('the shared retain/grace rule takes an in-process teammate', () => {
  test('a teammate with no marker gets no grace at all', () => {
    // The narrow is the PRESENCE of `retain`, so a running teammate — which has
    // never reached a terminal transition — is not retainable and nothing
    // changes for it.
    expect(isRetainedOrWithinGrace(teammate('running'), NOW)).toBe(false)
    expect(isRetainedOrWithinGrace(teammate('completed'), NOW)).toBe(false)
  })

  test.each(['completed', 'failed', 'killed'] as const)(
    'a %s teammate is inside its grace window until the deadline, and not after',
    status => {
      const task = inGrace(status)
      expect(isRetainedOrWithinGrace(task, NOW)).toBe(true)
      expect(isRetainedOrWithinGrace(task, NOW + TEAMMATE_GRACE_MS - 1)).toBe(
        true,
      )
      expect(isRetainedOrWithinGrace(task, NOW + TEAMMATE_GRACE_MS)).toBe(false)
      expect(isRetainedOrWithinGrace(task, NOW + TEAMMATE_GRACE_MS + 1)).toBe(
        false,
      )
    },
  )

  test('a row in grace is still TERMINAL, which is what every liveness and cap helper keys on', () => {
    // This is the load-bearing link for "a grace row must not count as live":
    // countLiveInProcessTeammates / countLiveTeammatesInTeam (status ===
    // 'running'), hasLiveTaskFor and findBusySubTeamChildren
    // (isTerminalTaskStatus) all read the status, and grace does not touch it.
    for (const status of ['completed', 'failed', 'killed'] as const) {
      const task = inGrace(status)
      expect(task.status).toBe(status)
      expect(isTerminalTaskStatus(task.status)).toBe(true)
    }
  })
})

describe('the one eviction funnel honours the teammate grace', () => {
  test('evictTerminalTask refuses a teammate inside its grace window', () => {
    const task = inGrace('killed', Date.now())
    const { setAppState, tasks } = recorder(task)
    evictTerminalTask(task.id, setAppState)
    expect(tasks()[task.id]).toBeDefined()
  })

  test('evictTerminalTask collects it once the deadline has passed', () => {
    // Same task, deadline in the past — nothing else differs.
    const task = teammate('killed', {
      retain: false,
      evictAfter: Date.now() - 1,
    })
    const { setAppState, tasks } = recorder(task)
    evictTerminalTask(task.id, setAppState)
    expect(tasks()[task.id]).toBeUndefined()
  })

  test('the lazy GC refuses it inside the window and collects it after', () => {
    // applyTaskOffsetsAndEvictions is the path the per-turn sweep takes
    // (utils/attachments), and it applies the same predicate as the eager evict.
    const held = inGrace('completed', Date.now())
    const heldRec = recorder(held)
    applyTaskOffsetsAndEvictions(heldRec.setAppState, {}, [held.id])
    expect(heldRec.tasks()[held.id]).toBeDefined()

    const expired = teammate('completed', {
      retain: false,
      evictAfter: Date.now() - 1,
    })
    const expiredRec = recorder(expired)
    applyTaskOffsetsAndEvictions(expiredRec.setAppState, {}, [expired.id])
    expect(expiredRec.tasks()[expired.id]).toBeUndefined()
  })

  test('a running teammate is never collected, marker or not', () => {
    const task = teammate('running')
    const { setAppState, tasks } = recorder(task)
    evictTerminalTask(task.id, setAppState)
    applyTaskOffsetsAndEvictions(setAppState, {}, [task.id])
    expect(tasks()[task.id]).toBeDefined()
  })
})
