import { PassThrough } from 'node:stream'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import React from 'react'
import { createRoot } from '../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../state/AppState.js'
import {
  isPanelVisibleAgent,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as taskFramework from '../utils/task/framework.js'
import {
  CoordinatorTaskPanel,
  getVisibleAgentTasks,
} from './CoordinatorAgentStatus.js'

// Pins rule D — the ONE visibility rule the coordinator panel, the panel task
// count and the background-task pill filter all have to agree on. The first two
// describes are pure functions, so no Ink renderer: `useCoordinatorTaskCount` is
// `getVisibleAgentTasks(tasks).length` memoised on `tasks`, and the length
// assertions below are its unit-testable equivalent. The last describe mounts
// the panel, because the eviction nomination it pins only exists inside the 1s
// tick effect.

const NOW = 1_700_000_000_000

function agent(id: string, overrides: Record<string, unknown> = {}): TaskState {
  return {
    id,
    type: 'local_agent',
    agentType: 'general-purpose',
    status: 'running',
    startTime: 0,
    retain: false,
    ...overrides,
  } as unknown as TaskState
}

function teammate(id: string, status = 'running'): TaskState {
  return {
    id,
    type: 'in_process_teammate',
    status,
    startTime: 0,
  } as unknown as TaskState
}

function tasks(...list: TaskState[]): AppState['tasks'] {
  return Object.fromEntries(
    list.map(t => [t.id, t]),
  ) as unknown as AppState['tasks']
}

describe('getVisibleAgentTasks', () => {
  test('counts running panel agents and ignores main-session and non-local task types', () => {
    const state = tasks(
      agent('a1'),
      agent('a2', { status: 'pending' }),
      agent('main', { agentType: 'main-session' }),
      teammate('t1'),
      { id: 'sh', type: 'local_bash', status: 'running' } as unknown as TaskState,
    )

    const visible = getVisibleAgentTasks(state)

    expect(visible.map(t => t.id)).toEqual(['a1', 'a2'])
    expect(visible.length).toBe(2)
  })

  test('sorts visible agents by startTime', () => {
    const visible = getVisibleAgentTasks(
      tasks(
        agent('late', { startTime: 300 }),
        agent('early', { startTime: 100 }),
        agent('mid', { startTime: 200 }),
      ),
    )

    expect(visible.map(t => t.id)).toEqual(['early', 'mid', 'late'])
  })

  test('drops completed agents whose eviction deadline has passed', () => {
    const state = tasks(
      agent('running'),
      agent('kept', { status: 'completed', evictAfter: Date.now() + 30_000 }),
      agent('expired', { status: 'completed', evictAfter: Date.now() - 1 }),
      agent('dismissed', { evictAfter: 0 }),
    )

    expect(getVisibleAgentTasks(state).map(t => t.id)).toEqual(['running', 'kept'])
  })
})

describe('isPanelVisibleAgent', () => {
  test('keeps a completed agent until now passes its evictAfter deadline', () => {
    const completed = agent('a', { status: 'completed', evictAfter: NOW + 1000 })

    expect(isPanelVisibleAgent(completed, NOW)).toBe(true)
    expect(isPanelVisibleAgent(completed, NOW + 999)).toBe(true)
    expect(isPanelVisibleAgent(completed, NOW + 1000)).toBe(false)
    expect(isPanelVisibleAgent(completed, NOW + 5000)).toBe(false)
  })

  test('keeps a retained completed agent past its deadline', () => {
    const retained = agent('a', {
      status: 'completed',
      retain: true,
      evictAfter: NOW - 5000,
    })

    expect(isPanelVisibleAgent(retained, NOW)).toBe(true)
  })

  test('keeps a deadline-less terminal agent and drops every terminal status at its deadline', () => {
    // No evictAfter yet = no deadline set, so the row survives (Infinity > now).
    expect(isPanelVisibleAgent(agent('a', { status: 'completed' }), NOW)).toBe(true)
    expect(
      isPanelVisibleAgent(agent('a', { status: 'failed', evictAfter: NOW }), NOW),
    ).toBe(false)
    expect(
      isPanelVisibleAgent(agent('a', { status: 'killed', evictAfter: NOW - 1 }), NOW),
    ).toBe(false)
  })

  test('hides an agent dismissed with x (evictAfter === 0) even while running', () => {
    expect(isPanelVisibleAgent(agent('a', { evictAfter: 0 }), NOW)).toBe(false)
    expect(
      isPanelVisibleAgent(agent('a', { evictAfter: 0, retain: true }), NOW),
    ).toBe(false)
  })

  test('shows a running in_process_teammate and hides a terminal one', () => {
    expect(isPanelVisibleAgent(teammate('t', 'running'), NOW)).toBe(true)
    expect(isPanelVisibleAgent(teammate('t', 'pending'), NOW)).toBe(true)
    expect(isPanelVisibleAgent(teammate('t', 'completed'), NOW)).toBe(false)
    expect(isPanelVisibleAgent(teammate('t', 'failed'), NOW)).toBe(false)
    expect(isPanelVisibleAgent(teammate('t', 'killed'), NOW)).toBe(false)
  })

  test('is false for main-session agents, other task types and non-tasks', () => {
    expect(isPanelVisibleAgent(agent('m', { agentType: 'main-session' }), NOW)).toBe(false)
    expect(
      isPanelVisibleAgent(
        { id: 'sh', type: 'local_bash', status: 'running' } as unknown as TaskState,
        NOW,
      ),
    ).toBe(false)
    expect(isPanelVisibleAgent(undefined, NOW)).toBe(false)
    expect(isPanelVisibleAgent(null, NOW)).toBe(false)
  })

  test('defaults now to Date.now()', () => {
    expect(
      isPanelVisibleAgent(agent('a', { status: 'completed', evictAfter: Date.now() + 30_000 })),
    ).toBe(true)
    expect(
      isPanelVisibleAgent(agent('a', { status: 'completed', evictAfter: Date.now() - 1 })),
    ).toBe(false)
  })
})

// The other half of rule D: the panel's 1s tick must NOMINATE for eviction on
// the same retain/grace predicate the evictor enforces — isRetainedOrWithinGrace
// (utils/task/retention) — not on the raw `evictAfter` deadline. Reading the
// deadline alone was safe only because evictTerminalTask re-checks the predicate
// internally, which turned every retained past-deadline task into a no-op
// eviction call once per second, forever. These tests pin the nomination itself,
// so a regression to the raw-deadline form fails here even though the store
// contents would look identical.

const PANEL_TICK_MS = 1000

function panelAgent(
  id: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id,
    type: 'local_agent',
    agentId: id,
    agentType: 'general-purpose',
    status: 'completed',
    description: `task ${id}`,
    prompt: 'prompt',
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: true,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  }
}

/**
 * Mounts CoordinatorTaskPanel over a PassThrough stdin/stdout pair so its 1s
 * tick effect actually runs (prior art: tasks/AsyncAgentDetailDialog.test.tsx).
 * Nothing here reads the frame — the tick's nominations are the observable.
 */
async function mountPanel(initialTasks: AppState['tasks']) {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.resume()

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider
      initialState={{ ...getDefaultAppState(), tasks: initialTasks }}
    >
      <CoordinatorTaskPanel />
    </AppStateProvider>,
  )

  return {
    async cleanup() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

describe('CoordinatorTaskPanel eviction nomination', () => {
  // Both tasks are terminal and past their deadline; `retain` is the only
  // difference between them, which is exactly the bit the old nomination
  // ignored.
  const pastDeadline = () =>
    tasks(
      panelAgent('unretained', { evictAfter: Date.now() - 60_000 }),
      panelAgent('retained', { retain: true, evictAfter: Date.now() - 60_000 }),
    )

  let nominated: string[] = []
  let evictSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(async () => {
    await acquireSharedMutationLock('components/CoordinatorAgentStatus.test.tsx')
    nominated = []
    // Stubbed, not called through: the nomination is what this pins, and the
    // real evictTerminalTask would delete the un-retained task after the first
    // tick, so later ticks would have nothing left to nominate.
    evictSpy = spyOn(taskFramework, 'evictTerminalTask').mockImplementation(
      (taskId: string) => {
        nominated.push(taskId)
      },
    )
  })

  afterEach(() => {
    evictSpy?.mockRestore()
    releaseSharedMutationLock()
  })

  async function waitForTicks(id: string, ticks: number): Promise<void> {
    const timeoutMs = PANEL_TICK_MS * (ticks + 3)
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (nominated.filter(n => n === id).length >= ticks) return
      await Bun.sleep(20)
    }
    throw new Error(
      `Timed out waiting for ${ticks} nomination(s) of "${id}"; saw ${JSON.stringify(nominated)}`,
    )
  }

  test('nominates a past-deadline agent that nothing is retaining', async () => {
    const panel = await mountPanel(pastDeadline())
    try {
      await waitForTicks('unretained', 1)

      expect(nominated).toContain('unretained')
    } finally {
      await panel.cleanup()
    }
  })

  test('never nominates a retained agent, however far past its deadline', async () => {
    const panel = await mountPanel(pastDeadline())
    try {
      // Two nominations of the un-retained task prove the interval fired at
      // least twice, so "retained was never nominated" is not just "no tick ran".
      await waitForTicks('unretained', 2)

      expect(nominated.filter(id => id === 'retained')).toEqual([])
      expect(nominated.filter(id => id === 'unretained').length).toBeGreaterThanOrEqual(2)
    } finally {
      await panel.cleanup()
    }
  })
})
