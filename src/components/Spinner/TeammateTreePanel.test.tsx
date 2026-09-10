import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useAppState,
} from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { DISABLE_AGENT_TEAMS_ENV } from '../../utils/agentSwarmsEnabled.js'
import { renderToString } from '../../utils/staticRender.js'
import { TeammateTreePanel } from './TeammateTreePanel.js'

/**
 * The teammates tree's own mount.
 *
 * The tree used to hang off the spinner, so it vanished whenever the spinner did
 * — the lead going idle with no running teammate, the last teammate ending, the
 * brief-spinner branch. The panel replaces all of that with one condition: the
 * toggle is on and Agent Teams are enabled. These cases pin that condition, the
 * empty state it draws instead of `null`, the fact that nothing about the lead's
 * own activity can change what it draws, and the single timer that takes a row
 * away once its 30s grace window closes.
 */

const COLUMNS = 120
const EMPTY_STATE = 'no teammates · Agent(name: "…") spawns one'

let savedDisableEnv: string | undefined

beforeEach(() => {
  savedDisableEnv = process.env[DISABLE_AGENT_TEAMS_ENV]
  delete process.env[DISABLE_AGENT_TEAMS_ENV]
})

afterEach(() => {
  if (savedDisableEnv === undefined) {
    delete process.env[DISABLE_AGENT_TEAMS_ENV]
  } else {
    process.env[DISABLE_AGENT_TEAMS_ENV] = savedDisableEnv
  }
})

function teammate(
  name: string,
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: `task-${name}`,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: working`,
    startTime: Date.now() - 5_000,
    outputFile: `/tmp/${name}.log`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@email`,
      agentName: name,
      teamName: 'email',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: '',
    spinnerVerb: 'Working',
    pastTenseVerb: 'Worked',
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
  name: string,
  msLeft = 30_000,
  status: 'completed' | 'failed' | 'killed' = 'killed',
): InProcessTeammateTaskState {
  return teammate(name, {
    status,
    notified: true,
    retain: false,
    evictAfter: Date.now() + msLeft,
  })
}

function stateWith(
  teammates: InProcessTeammateTaskState[],
  overrides: Partial<AppState> = {},
): AppState {
  return {
    ...getDefaultAppState(),
    expandedView: 'teammates',
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
    ...overrides,
  } as AppState
}

async function renderPanel(state: AppState): Promise<string> {
  return await renderToString(
    <AppStateProvider initialState={state}>
      <TeammateTreePanel />
    </AppStateProvider>,
    COLUMNS,
  )
}

describe('TeammateTreePanel — when it draws anything at all', () => {
  test('draws the tree with no teammates at all, instead of nothing', async () => {
    const frame = await renderPanel(stateWith([]))
    expect(frame).toContain('team-lead')
    expect(frame).toContain(EMPTY_STATE)
  })

  test('draws nothing while the toggle is off', async () => {
    for (const expandedView of ['none', 'tasks'] as const) {
      const frame = await renderPanel(stateWith([teammate('alice')], { expandedView }))
      expect(frame.trim()).toBe('')
    }
  })

  test('draws nothing when Agent Teams are turned off, toggle or not', async () => {
    process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
    const frame = await renderPanel(stateWith([teammate('alice')]))
    expect(frame.trim()).toBe('')
  })

  test('draws the running teammates when the toggle is on', async () => {
    const frame = await renderPanel(stateWith([teammate('alice'), teammate('bob')]))
    expect(frame).toContain('@alice')
    expect(frame).toContain('@bob')
    expect(frame).not.toContain(EMPTY_STATE)
  })
})

describe('TeammateTreePanel — the lead row carries no lead activity', () => {
  test('renders identically whichever state the lead itself is in', async () => {
    // Nothing about the lead's turn reaches this panel: it takes no props and
    // subscribes to no loading state, which is precisely why the empty panel
    // cannot look one way while the lead is working and another way when it is
    // idle. Two states that differ in every lead-ish field AppState does carry
    // must therefore produce the same frame.
    const idle = await renderPanel(stateWith([]))
    const loading = await renderPanel(
      stateWith([], {
        spinnerTip: 'some tip the spinner is showing',
        isBriefOnly: true,
      } as Partial<AppState>),
    )
    expect(loading).toBe(idle)
  })

  test('the team-lead row is the handle plus its select hint, with no verb and no token count', async () => {
    const frame = await renderPanel(stateWith([]))
    const leadLine = frame.split('\n').find(line => line.includes('team-lead'))!
    expect(leadLine).toContain('team-lead')
    expect(leadLine).not.toContain('tokens')
    expect(leadLine).not.toContain('…')
    expect(leadLine).not.toContain('Idle')
  })
})

describe('TeammateTreePanel — what it passes down', () => {
  test('passes the selection through, hide row included', async () => {
    const frame = await renderPanel(
      stateWith([teammate('alice'), teammate('bob')], {
        viewSelectionMode: 'selecting-agent',
        selectedIPAgentIndex: 1,
      }),
    )
    const selected = frame.split('\n').find(line => line.includes('enter to view'))
    expect(selected).toContain('@bob')
    expect(frame).toContain('hide')
  })

  test('all-idle is read off the RUNNING teammates, so a finished row cannot hold it back', async () => {
    // `alice` is the only teammate still running and she has parked, so the tree
    // is in its all-idle state and her row reads past tense. A finished row is
    // not a live teammate and must not be counted as "still working" — which is
    // what computing this over every drawn row would do (inGrace rows carry
    // isIdle: false).
    const frame = await renderPanel(
      stateWith([teammate('alice', { isIdle: true }), inGrace('bob')]),
    )
    const aliceLine = frame.split('\n').find(line => line.includes('@alice'))!
    expect(aliceLine).toContain('Worked for')
    expect(frame.split('\n').find(line => line.includes('@bob'))).toContain('killed')
  })
})

/**
 * The grace deadline, on a live root: the panel arms ONE timeout for the earliest
 * deadline among the rows it drew and then calls the shared evictTerminalTask, so
 * the row goes away by itself rather than waiting for the next unrelated render
 * (the tree's compiler memo is keyed on `tasks`, so a repaint that leaves the
 * task map alone would serve the expired row from cache).
 */
describe('TeammateTreePanel — the grace deadline', () => {
  function Probe({ onTasks }: { onTasks: (ids: string[]) => void }): null {
    const tasks = useAppState(s => s.tasks)
    React.useEffect(() => onTasks(Object.keys(tasks)), [tasks, onTasks])
    return null
  }

  async function mount(state: AppState): Promise<{
    taskIds: () => string[]
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
    ;(stdout as unknown as { columns: number }).columns = COLUMNS
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    let ids: string[] = []
    root.render(
      <AppStateProvider initialState={state}>
        <TeammateTreePanel />
        <Probe
          onTasks={next => {
            ids = next
          }}
        />
      </AppStateProvider>,
    )
    await Bun.sleep(30)
    return {
      taskIds: () => ids,
      async cleanup() {
        root.unmount()
        await Bun.sleep(30)
        stdin.end()
        stdout.end()
      },
    }
  }

  test('evicts the row through the shared funnel once its window closes', async () => {
    const expiring = inGrace('bob', 60)
    const mounted = await mount(stateWith([teammate('alice'), expiring]))
    try {
      // Still inside the window: the task is held, not collected.
      expect(mounted.taskIds()).toContain(expiring.id)
      await Bun.sleep(250)
      expect(mounted.taskIds()).not.toContain(expiring.id)
      // The live teammate is untouched — only what the grace rule released goes.
      expect(mounted.taskIds()).toContain('task-alice')
    } finally {
      await mounted.cleanup()
    }
  })

  test('leaves a row alone for the whole window', async () => {
    const held = inGrace('bob', 30_000)
    const mounted = await mount(stateWith([held]))
    try {
      await Bun.sleep(250)
      expect(mounted.taskIds()).toContain(held.id)
    } finally {
      await mounted.cleanup()
    }
  })
})
