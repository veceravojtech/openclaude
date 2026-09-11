import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'

import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { PANEL_GRACE_MS, TEAMMATE_GRACE_MS } from '../utils/task/framework.js'
import { isRetainedOrWithinGrace } from '../utils/task/retention.js'
import type { AppState } from './AppState.js'
import { getDefaultAppState } from './AppStateStore.js'
import { enterTeammateView, exitTeammateView } from './teammateViewHelpers.js'

/**
 * Opening a finished teammate's transcript has to PIN its row.
 *
 * A teammate that ends keeps its row for TEAMMATE_GRACE_MS, and T1 made those
 * rows selectable so Enter opens the transcript — but `enterTeammateView` wrote
 * `retain: true` for a local_agent only. The teammate row therefore kept
 * `retain: false` with its original deadline, TeammateTreePanel's deadline timer
 * evicted it at 30s, and useTeammateViewAutoExit threw the reader back to the
 * leader mid-transcript. The retain mechanism was there — the panel's own test
 * pins 'a retained row … is never collected' — with no writer to set it.
 *
 * The clock is mocked so the deadline arithmetic is asserted exactly rather
 * than within a tolerance.
 */

const NOW = 1_700_000_000_000
let nowSpy: ReturnType<typeof spyOn> | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'state/teammateViewHelpers.teammateRetain.test.ts',
  )
  nowSpy = spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  try {
    nowSpy?.mockRestore()
  } finally {
    releaseSharedMutationLock()
  }
})

function teammate(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: 'task-supervisor',
    type: 'in_process_teammate',
    status: 'running',
    description: 'supervisor: working',
    startTime: NOW - 5_000,
    outputFile: '/tmp/supervisor.log',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'supervisor@email',
      agentName: 'supervisor',
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
    ...overrides,
  }
}

/** A finished teammate as the three terminal-marking sites leave it. */
function inGrace(
  status: 'completed' | 'failed' | 'killed' = 'completed',
  msLeft = TEAMMATE_GRACE_MS,
): InProcessTeammateTaskState {
  return teammate({
    status,
    notified: true,
    retain: false,
    evictAfter: NOW + msLeft,
    messages: [{ type: 'assistant' }] as unknown as
      InProcessTeammateTaskState['messages'],
  })
}

function localAgent(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: 'task-agent',
    type: 'local_agent',
    status: 'completed',
    description: 'a background agent',
    startTime: NOW - 5_000,
    outputFile: '/tmp/agent.log',
    outputOffset: 0,
    notified: true,
    agentId: 'agent-1',
    prompt: 'do a thing',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as unknown as LocalAgentTaskState
}

/** A one-shot AppState the helpers can be driven against, updater and all. */
function store(tasks: AppState['tasks'], overrides: Partial<AppState> = {}) {
  let state: AppState = {
    ...getDefaultAppState(),
    tasks,
    ...overrides,
  } as AppState
  return {
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    get: () => state,
    task: (id: string) => state.tasks[id] as InProcessTeammateTaskState,
  }
}

test('opening a teammate row inside its grace window retains it and drops the deadline', () => {
  const s = store({ 'task-supervisor': inGrace() })

  enterTeammateView('task-supervisor', s.setAppState)

  expect(s.task('task-supervisor').retain).toBe(true)
  expect(s.task('task-supervisor').evictAfter).toBeUndefined()
  expect(s.get().viewingAgentTaskId).toBe('task-supervisor')
  expect(s.get().viewSelectionMode).toBe('viewing-agent')
})

test('the retained row survives the shared retain/grace rule long past TEAMMATE_GRACE_MS', () => {
  // This is what the panel's deadline timer and both evictors consult. Before
  // the fix the row answered false one grace window in and was collected out
  // from under the reader.
  const s = store({ 'task-supervisor': inGrace() })

  enterTeammateView('task-supervisor', s.setAppState)

  const held = s.task('task-supervisor')
  expect(isRetainedOrWithinGrace(held, NOW + TEAMMATE_GRACE_MS + 1)).toBe(true)
  expect(isRetainedOrWithinGrace(held, NOW + TEAMMATE_GRACE_MS * 100)).toBe(
    true,
  )
})

test.each(['completed', 'failed', 'killed'] as const)(
  'a %s row is retained the same way — the marker is the status-independent pair',
  status => {
    const s = store({ 'task-supervisor': inGrace(status) })
    enterTeammateView('task-supervisor', s.setAppState)
    expect(s.task('task-supervisor').retain).toBe(true)
    expect(s.task('task-supervisor').evictAfter).toBeUndefined()
  },
)

test('leaving the view releases the row with a FULL fresh grace window', () => {
  // Not the remainder of the old one: the reader let go at NOW, so the row gets
  // TEAMMATE_GRACE_MS from NOW before anything may collect it.
  const s = store({ 'task-supervisor': inGrace('completed', 10) })
  enterTeammateView('task-supervisor', s.setAppState)

  exitTeammateView(s.setAppState)

  const released = s.task('task-supervisor')
  expect(released.retain).toBe(false)
  expect(released.evictAfter).toBe(NOW + TEAMMATE_GRACE_MS)
  expect(s.get().viewingAgentTaskId).toBeUndefined()
  expect(s.get().viewSelectionMode).toBe('none')
  // …and then it does leave: one grace later the shared rule releases it.
  expect(isRetainedOrWithinGrace(released, NOW + TEAMMATE_GRACE_MS + 1)).toBe(
    false,
  )
})

test('a teammate keeps its messages through the whole enter/exit round trip', () => {
  // A teammate has no disk bootstrap and no stream-append: `messages` is the
  // runner's own live UI mirror, so clearing it on release — which is what a
  // local_agent gets — would delete state nothing re-creates.
  const s = store({ 'task-supervisor': inGrace() })
  const before = s.task('task-supervisor').messages

  enterTeammateView('task-supervisor', s.setAppState)
  expect(s.task('task-supervisor').messages).toBe(before)

  exitTeammateView(s.setAppState)
  expect(s.task('task-supervisor').messages).toBe(before)
})

test('switching away from one grace row to another releases the first', () => {
  const first = inGrace()
  const second = { ...inGrace(), id: 'task-worker' }
  const s = store({ 'task-supervisor': first, 'task-worker': second })

  enterTeammateView('task-supervisor', s.setAppState)
  enterTeammateView('task-worker', s.setAppState)

  expect(s.task('task-supervisor').retain).toBe(false)
  expect(s.task('task-supervisor').evictAfter).toBe(NOW + TEAMMATE_GRACE_MS)
  expect(s.task('task-worker').retain).toBe(true)
  expect(s.task('task-worker').evictAfter).toBeUndefined()
  expect(s.get().viewingAgentTaskId).toBe('task-worker')
})

test('a RUNNING teammate is opened without ever gaining the retain field', () => {
  // isRetainedOrWithinGrace narrows on the PRESENCE of `retain`, so writing it
  // before the teammate finishes would make a live teammate "retainable". It
  // also buys nothing: both evictors require a terminal status first, and the
  // runner's own terminal writers set the pair when the time comes.
  const s = store({ 'task-supervisor': teammate() })

  enterTeammateView('task-supervisor', s.setAppState)

  expect('retain' in s.task('task-supervisor')).toBe(false)
  expect(isRetainedOrWithinGrace(s.task('task-supervisor'), NOW)).toBe(false)
  expect(s.get().viewingAgentTaskId).toBe('task-supervisor')
  expect(s.get().viewSelectionMode).toBe('viewing-agent')

  exitTeammateView(s.setAppState)
  expect('retain' in s.task('task-supervisor')).toBe(false)
})

test('a local_agent is retained and released exactly as before', () => {
  // The other half of the shared code path: still retained on open, still
  // dropped back to a stub (messages cleared, diskLoaded false) on release.
  const s = store({
    'task-agent': localAgent({
      messages: [{ type: 'assistant' }],
      diskLoaded: true,
      evictAfter: NOW + 1_000,
    } as unknown as Partial<LocalAgentTaskState>),
  })

  enterTeammateView('task-agent', s.setAppState)
  const held = s.get().tasks['task-agent'] as LocalAgentTaskState
  expect(held.retain).toBe(true)
  expect(held.evictAfter).toBeUndefined()

  exitTeammateView(s.setAppState)
  const released = s.get().tasks['task-agent'] as LocalAgentTaskState
  expect(released.retain).toBe(false)
  expect(released.messages).toBeUndefined()
  expect(released.diskLoaded).toBe(false)
  // The PANEL's grace, not the tree's: two knobs that hold the same number
  // today, and each task type is released against its own.
  expect(released.evictAfter).toBe(NOW + PANEL_GRACE_MS)
})

test("the local_agent's disk bootstrap still gets the state it keys on", () => {
  // REPL's bootstrap effect fires on isLocalAgentTask && retain && !diskLoaded,
  // and it is the reason a local_agent may be released back to a stub at all.
  // A teammate answers the first conjunct false and carries no diskLoaded, so
  // the effect never runs for it and task.messages is all its view has.
  const s = store({
    'task-agent': localAgent({
      messages: [{ type: 'assistant' }],
      diskLoaded: true,
    } as unknown as Partial<LocalAgentTaskState>),
    'task-supervisor': inGrace(),
  })

  enterTeammateView('task-agent', s.setAppState)
  exitTeammateView(s.setAppState)
  enterTeammateView('task-agent', s.setAppState)

  const reopened = s.get().tasks['task-agent'] as LocalAgentTaskState
  expect(reopened.type).toBe('local_agent')
  expect(reopened.retain).toBe(true)
  expect(reopened.diskLoaded).toBe(false)
  expect(reopened.messages).toBeUndefined()

  enterTeammateView('task-supervisor', s.setAppState)
  expect('diskLoaded' in s.task('task-supervisor')).toBe(false)
  expect(s.task('task-supervisor').messages).toHaveLength(1)
})
