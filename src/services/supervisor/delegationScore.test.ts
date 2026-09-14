import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  __setSupervisionGateForTesting,
  DELEGATION_COMPLETED_POINTS,
  SELF_WORK_POINTS,
  consumeDelegationScoreDelta,
  formatDelegationPoints,
  getDelegationScore,
  recordDelegatedRunFinished,
  recordSupervisorToolUse,
  resetDelegationScore,
  shouldShowDelegationScore,
} from './delegationScore.js'

const SAVED_MODE = process.env.CLAUDE_CODE_COORDINATOR_MODE

beforeEach(() => {
  delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  // isCoordinatorMode() is gated on a build flag `bun test` does not compile
  // in, so pin the gate ON rather than letting every assertion no-op.
  __setSupervisionGateForTesting(() => true)
  resetDelegationScore()
})

afterEach(() => {
  __setSupervisionGateForTesting(undefined)
  if (SAVED_MODE === undefined) {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  } else {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = SAVED_MODE
  }
  resetDelegationScore()
})

test('supervision off records nothing at all', () => {
  __setSupervisionGateForTesting(() => false)

  recordSupervisorToolUse('Edit', undefined)
  recordDelegatedRunFinished({
    taskType: 'local_agent',
    status: 'completed',
    ownedByMainThread: true,
  })

  expect(getDelegationScore()).toMatchObject({ points: 0, selfWork: 0, delegated: 0 })
  expect(shouldShowDelegationScore(undefined)).toBe(false)
})

test('a teammate never spends the supervisor’s score', () => {
  recordSupervisorToolUse('Edit', 'agent-abc')
  recordDelegatedRunFinished({
    taskType: 'local_agent',
    status: 'completed',
    ownedByMainThread: false,
  })

  expect(getDelegationScore().points).toBe(0)
  expect(shouldShowDelegationScore('agent-abc')).toBe(false)
})

test('only mutating tools cost anything', () => {
  for (const readOnly of ['Read', 'Grep', 'Glob', 'Agent', 'SendMessage']) {
    recordSupervisorToolUse(readOnly, undefined)
  }
  expect(getDelegationScore()).toMatchObject({ points: 0, selfWork: 0 })

  recordSupervisorToolUse('Edit', undefined)
  recordSupervisorToolUse('Bash', undefined)

  expect(getDelegationScore()).toMatchObject({
    points: SELF_WORK_POINTS * 2,
    selfWork: 2,
  })
})

test('a completed delegated run pays, a failed one is free', () => {
  recordDelegatedRunFinished({
    taskType: 'in_process_teammate',
    status: 'completed',
    ownedByMainThread: true,
  })
  recordDelegatedRunFinished({
    taskType: 'local_agent',
    status: 'failed',
    ownedByMainThread: true,
  })
  recordDelegatedRunFinished({
    taskType: 'local_agent',
    status: 'killed',
    ownedByMainThread: true,
  })

  expect(getDelegationScore()).toMatchObject({
    points: DELEGATION_COMPLETED_POINTS,
    delegated: 1,
    // Counted so the supervisor can see them, never charged: delegating must
    // not read as risky.
    abandoned: 2,
  })
})

test('non-agent tasks are not delegation', () => {
  recordDelegatedRunFinished({
    taskType: 'local_bash',
    status: 'completed',
    ownedByMainThread: true,
  })

  expect(getDelegationScore()).toMatchObject({ points: 0, delegated: 0 })
})

test('the delta reports once, the total stays', () => {
  recordDelegatedRunFinished({
    taskType: 'in_process_teammate',
    status: 'completed',
    ownedByMainThread: true,
  })
  recordSupervisorToolUse('Write', undefined)

  const first = consumeDelegationScoreDelta()
  expect(first.lastDelta).toBe(DELEGATION_COMPLETED_POINTS + SELF_WORK_POINTS)
  expect(first.points).toBe(DELEGATION_COMPLETED_POINTS + SELF_WORK_POINTS)

  const second = consumeDelegationScoreDelta()
  expect(second.lastDelta).toBe(0)
  expect(second.points).toBe(first.points)
})

test('reset clears the session score', () => {
  recordSupervisorToolUse('Edit', undefined)
  expect(getDelegationScore().points).not.toBe(0)

  resetDelegationScore()

  expect(getDelegationScore()).toMatchObject({
    points: 0,
    delegated: 0,
    abandoned: 0,
    selfWork: 0,
    lastDelta: 0,
  })
})

test('points render with an explicit sign', () => {
  expect(formatDelegationPoints(12)).toBe('+12')
  expect(formatDelegationPoints(-3)).toBe('-3')
  expect(formatDelegationPoints(0)).toBe('0')
})
