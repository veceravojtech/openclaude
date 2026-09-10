import { describe, expect, test } from 'bun:test'

import { TEAMMATE_GRACE_MS } from '../../utils/task/framework.js'
import { getRunningTeammatesSorted } from './InProcessTeammateTask.js'
import {
  footerIndexForSelection,
  HIDE_SELECTION,
  LEADER_SELECTION,
  orderSignature,
  resolveSurvivingSelection,
  selectedTeammateTask,
  selectionsEqual,
  stepFooterSelection,
  stepSelection,
  type TeammateSelection,
} from './teammateSelection.js'
import type { InProcessTeammateTaskState } from './types.js'

/**
 * The nearest-survivor rule, on its own.
 *
 * The selection used to be a POSITION into getRunningTeammatesSorted, so a row
 * leaving or arriving above it silently re-pointed the highlight at a different
 * teammate and a leave+join with an unchanged count was invisible entirely.
 * These cases pin the replacement: a selection follows its task by id wherever
 * the task moves, and when the task is gone it lands on the nearest survivor —
 * previous sibling, else the parent sub-lead, else the leader — never on an
 * arbitrary teammate and never dangling.
 */

function teammate(
  name: string,
  teamName: string,
  overrides: Partial<InProcessTeammateTaskState> = {},
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
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

/**
 * The shared two-level fixture in its depth-first order: root team `email` with
 * alice, supervisor and zoe, plus supervisor's sub-team with worker-1 and
 * worker-2. Built in order here because these cases are about the rule, not
 * about the sort — the sort has its own suite.
 */
const alice = teammate('alice', 'email')
const supervisor = teammate('supervisor', 'email')
const worker1 = teammate('worker-1', 'email/supervisor')
const worker2 = teammate('worker-2', 'email/supervisor')
const zoe = teammate('zoe', 'email')
const TWO_LEVEL = [alice, supervisor, worker1, worker2, zoe]

function select(task: InProcessTeammateTaskState): TeammateSelection {
  return { kind: 'teammate', taskId: task.id }
}

function without(
  order: readonly InProcessTeammateTaskState[],
  ...gone: InProcessTeammateTaskState[]
): InProcessTeammateTaskState[] {
  const goneIds = new Set(gone.map(t => t.id))
  return order.filter(t => !goneIds.has(t.id))
}

describe('resolveSurvivingSelection — a selection whose task is still listed', () => {
  test('is returned UNCHANGED when a row is added above it', () => {
    // The B1 mutation probe. Positional keeping would answer nextOrder[1],
    // which is `alice` — a different teammate than the one selected.
    const aaron = teammate('aaron', 'email')
    const next = [aaron, ...TWO_LEVEL]
    const selection = select(supervisor)

    const resolved = resolveSurvivingSelection(selection, TWO_LEVEL, next)

    expect(resolved).toBe(selection)
    expect(next[1]).toBe(alice)
    expect(selectedTeammateTask(resolved, next)).toBe(supervisor)
  })

  test('is returned unchanged when a row LEAVES above it', () => {
    const next = without(TWO_LEVEL, alice)
    const selection = select(supervisor)

    expect(resolveSurvivingSelection(selection, TWO_LEVEL, next)).toBe(selection)
    // Positional keeping would have answered worker-1 here.
    expect(next[1]).toBe(worker1)
  })

  test('survives a leave+join that leaves the COUNT unchanged', () => {
    // The case the old count-keyed clamp could not see at all: alice leaves and
    // `aaron` joins in the same frame, so the list is still five rows long.
    const aaron = teammate('aaron', 'email')
    const next = [aaron, ...without(TWO_LEVEL, alice)]
    const selection = select(worker2)

    expect(next).toHaveLength(TWO_LEVEL.length)
    expect(resolveSurvivingSelection(selection, TWO_LEVEL, next)).toBe(selection)
  })

  test('survives a pure re-order', () => {
    const next = [...TWO_LEVEL].reverse()
    const selection = select(worker1)

    expect(resolveSurvivingSelection(selection, TWO_LEVEL, next)).toBe(selection)
  })
})

describe('resolveSurvivingSelection — the selected row is gone', () => {
  test('moves to the previous sibling in tree order', () => {
    const resolved = resolveSurvivingSelection(
      select(worker2),
      TWO_LEVEL,
      without(TWO_LEVEL, worker2),
    )

    expect(resolved).toEqual(select(worker1))
  })

  test('skips a nested sub-tree to reach the real previous sibling', () => {
    // zoe's previous sibling in team `email` is `supervisor`, NOT worker-2 —
    // the two workers sit between them in depth-first order but belong to a
    // different team.
    const resolved = resolveSurvivingSelection(
      select(zoe),
      TWO_LEVEL,
      without(TWO_LEVEL, zoe),
    )

    expect(resolved).toEqual(select(supervisor))
  })

  test('walks back over siblings that left in the same frame', () => {
    // worker-2 AND worker-1 both go: the nearest surviving previous sibling
    // does not exist, so the rule keeps walking rather than dangling on one.
    const resolved = resolveSurvivingSelection(
      select(worker2),
      TWO_LEVEL,
      without(TWO_LEVEL, worker2, worker1),
    )

    expect(resolved).toEqual(select(supervisor))
  })

  test('falls back to the parent sub-lead when it is the first row of its team', () => {
    // worker-1 is the FIRST member of `email/supervisor`, so there is no
    // previous sibling — the sub-lead row above it inherits the selection.
    const resolved = resolveSurvivingSelection(
      select(worker1),
      TWO_LEVEL,
      without(TWO_LEVEL, worker1),
    )

    expect(resolved).toEqual(select(supervisor))
  })

  test('walks the whole sub-lead chain when a sub-tree vanishes at once', () => {
    const deputy = teammate('deputy', 'email/supervisor/worker-1')
    const threeLevel = [alice, supervisor, worker1, deputy, worker2, zoe]

    // deputy's team AND its lead worker-1 both go; the next lead up the chain
    // is `supervisor`, which is still there.
    const resolved = resolveSurvivingSelection(
      select(deputy),
      threeLevel,
      without(threeLevel, deputy, worker1),
    )

    expect(resolved).toEqual(select(supervisor))
  })

  test('falls back to the leader when nothing in the neighbourhood survived', () => {
    const resolved = resolveSurvivingSelection(
      select(worker1),
      TWO_LEVEL,
      without(TWO_LEVEL, worker1, supervisor, alice),
    )

    expect(resolved).toBe(LEADER_SELECTION)
  })

  test('falls back to the leader when the first root-team row leaves', () => {
    // alice has no previous sibling and no sub-lead above her: her team is the
    // root team, whose lead IS the leader row.
    expect(
      resolveSurvivingSelection(
        select(alice),
        TWO_LEVEL,
        without(TWO_LEVEL, alice),
      ),
    ).toBe(LEADER_SELECTION)
  })

  test('falls back to the leader when the list is emptied', () => {
    expect(resolveSurvivingSelection(select(worker1), TWO_LEVEL, [])).toBe(
      LEADER_SELECTION,
    )
  })

  test('falls back to the leader for a selection that was not in the previous order either', () => {
    const stale: TeammateSelection = { kind: 'teammate', taskId: 'task-ghost' }

    expect(resolveSurvivingSelection(stale, TWO_LEVEL, TWO_LEVEL)).toBe(
      LEADER_SELECTION,
    )
  })

  test('treats a grace row leaving at its deadline like any other removal', () => {
    // Not a hand-built "and now it is gone" list: the row is driven out of the
    // shared order by advancing `now` past its own evictAfter.
    const deadline = 1_700_000_100_000
    const finished = teammate('worker-2', 'email/supervisor', {
      status: 'completed',
      retain: false,
      evictAfter: deadline,
    })
    const tasks = Object.fromEntries(
      [alice, supervisor, worker1, finished, zoe].map(t => [t.id, t]),
    )

    const during = getRunningTeammatesSorted(tasks, deadline - TEAMMATE_GRACE_MS)
    const after = getRunningTeammatesSorted(tasks, deadline + 1)
    expect(during.map(t => t.id)).toContain(finished.id)
    expect(after.map(t => t.id)).not.toContain(finished.id)

    // While it is in grace the selection stays put…
    expect(resolveSurvivingSelection(select(finished), during, during)).toEqual(
      select(finished),
    )
    // …and once the deadline passes it moves to the previous sibling.
    expect(resolveSurvivingSelection(select(finished), during, after)).toEqual(
      select(worker1),
    )
  })
})

describe('resolveSurvivingSelection — the rows that are never orphaned', () => {
  test('leaves the leader, the hide row and "nothing selected" alone', () => {
    expect(resolveSurvivingSelection(LEADER_SELECTION, TWO_LEVEL, [])).toBe(
      LEADER_SELECTION,
    )
    expect(resolveSurvivingSelection(HIDE_SELECTION, TWO_LEVEL, [])).toBe(
      HIDE_SELECTION,
    )
    expect(resolveSurvivingSelection(null, TWO_LEVEL, [])).toBeNull()
  })
})

describe('stepSelection — positions exist only here', () => {
  test('walks leader → teammates in tree order → hide → back to the leader', () => {
    const visited: TeammateSelection[] = []
    let current: TeammateSelection | null = null
    for (let step = 0; step < TWO_LEVEL.length + 2; step++) {
      current = stepSelection(current, TWO_LEVEL, 1)
      visited.push(current)
    }

    expect(visited).toEqual([
      ...TWO_LEVEL.map(select),
      HIDE_SELECTION,
      LEADER_SELECTION,
    ])
  })

  test('walks the same list backwards', () => {
    expect(stepSelection(null, TWO_LEVEL, -1)).toBe(HIDE_SELECTION)
    expect(stepSelection(HIDE_SELECTION, TWO_LEVEL, -1)).toEqual(select(zoe))
  })

  test('stores what it lands on, not where it landed', () => {
    // Two steps from the leader is `supervisor`; that stays true after a row is
    // inserted above, because what was stored is supervisor's id.
    const landed = stepSelection(stepSelection(null, TWO_LEVEL, 1), TWO_LEVEL, 1)
    expect(landed).toEqual(select(supervisor))

    const withNewRow = [teammate('aaron', 'email'), ...TWO_LEVEL]
    expect(selectedTeammateTask(landed, withNewRow)).toBe(supervisor)
  })

  test('offers leader and hide even with no teammates at all', () => {
    expect(stepSelection(null, [], 1)).toBe(HIDE_SELECTION)
    expect(stepSelection(HIDE_SELECTION, [], 1)).toBe(LEADER_SELECTION)
    expect(stepSelection(null, [], -1)).toBe(HIDE_SELECTION)
  })

  test('steps from the leader when the current selection is not listed', () => {
    const stale: TeammateSelection = { kind: 'teammate', taskId: 'task-ghost' }
    expect(stepSelection(stale, TWO_LEVEL, 1)).toEqual(select(alice))
  })
})

describe('stepFooterSelection — the same walk without a hide row', () => {
  test('cycles leader → teammates → leader', () => {
    const visited: TeammateSelection[] = []
    let current: TeammateSelection = LEADER_SELECTION
    for (let step = 0; step < TWO_LEVEL.length + 1; step++) {
      current = stepFooterSelection(current, TWO_LEVEL, 1)
      visited.push(current)
    }

    expect(visited).toEqual([...TWO_LEVEL.map(select), LEADER_SELECTION])
    expect(visited).not.toContain(HIDE_SELECTION)
  })

  test('wraps backwards onto the last teammate, never onto a hide row', () => {
    expect(stepFooterSelection(LEADER_SELECTION, TWO_LEVEL, -1)).toEqual(
      select(zoe),
    )
    expect(stepFooterSelection(LEADER_SELECTION, [], -1)).toBe(LEADER_SELECTION)
  })
})

describe('footerIndexForSelection — the derived prop', () => {
  test('is 0 for the leader and position + 1 for a teammate', () => {
    expect(footerIndexForSelection(LEADER_SELECTION, TWO_LEVEL)).toBe(0)
    expect(footerIndexForSelection(select(alice), TWO_LEVEL)).toBe(1)
    expect(footerIndexForSelection(select(zoe), TWO_LEVEL)).toBe(
      TWO_LEVEL.length,
    )
  })

  test('is -1 — no pill highlighted — for a teammate the footer is not showing', () => {
    expect(footerIndexForSelection(select(worker1), [alice, zoe])).toBe(-1)
    expect(footerIndexForSelection(HIDE_SELECTION, TWO_LEVEL)).toBe(-1)
  })

  test('follows its teammate when a row is inserted above it', () => {
    expect(footerIndexForSelection(select(alice), TWO_LEVEL)).toBe(1)
    expect(
      footerIndexForSelection(select(alice), [
        teammate('aaron', 'email'),
        ...TWO_LEVEL,
      ]),
    ).toBe(2)
  })
})

describe('orderSignature and selectionsEqual', () => {
  test('the signature changes on a leave+join that keeps the count', () => {
    const swapped = [teammate('aaron', 'email'), ...without(TWO_LEVEL, alice)]

    expect(swapped).toHaveLength(TWO_LEVEL.length)
    expect(orderSignature(swapped)).not.toBe(orderSignature(TWO_LEVEL))
  })

  test('the signature changes on a pure re-order', () => {
    expect(orderSignature([...TWO_LEVEL].reverse())).not.toBe(
      orderSignature(TWO_LEVEL),
    )
  })

  test('the signature is stable for the same rows', () => {
    expect(orderSignature([...TWO_LEVEL])).toBe(orderSignature(TWO_LEVEL))
  })

  test('selectionsEqual compares by kind and id, not by identity', () => {
    expect(selectionsEqual(select(alice), { ...select(alice) })).toBe(true)
    expect(selectionsEqual(select(alice), select(zoe))).toBe(false)
    expect(selectionsEqual(LEADER_SELECTION, { kind: 'leader' })).toBe(true)
    expect(selectionsEqual(LEADER_SELECTION, HIDE_SELECTION)).toBe(false)
    expect(selectionsEqual(null, LEADER_SELECTION)).toBe(false)
    expect(selectionsEqual(null, null)).toBe(true)
  })
})

describe('selectedTeammateTask', () => {
  test('finds the task by id and answers undefined for anything else', () => {
    expect(selectedTeammateTask(select(worker2), TWO_LEVEL)).toBe(worker2)
    expect(selectedTeammateTask(LEADER_SELECTION, TWO_LEVEL)).toBeUndefined()
    expect(selectedTeammateTask(HIDE_SELECTION, TWO_LEVEL)).toBeUndefined()
    expect(selectedTeammateTask(null, TWO_LEVEL)).toBeUndefined()
    expect(
      selectedTeammateTask(select(worker2), without(TWO_LEVEL, worker2)),
    ).toBeUndefined()
  })
})
