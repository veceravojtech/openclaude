import { afterAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'

import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../../state/AppState.js'
import {
  getRunningTeammatesSorted,
  getSubLeadPath,
} from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { TEAMMATE_GRACE_MS } from '../../utils/task/framework.js'
import { BackgroundTaskStatus } from './BackgroundTaskStatus.js'

/**
 * The pill row shows the same team tree the spinner tree draws: pills come in
 * the shared depth-first order and a sub-team member's label carries the
 * sub-leads above it (`@supervisor/worker-1`), so the row says whose worker a
 * teammate is. The order is not the pill row's own any more — pill.idx,
 * teammateFooterIndex and viewedIdx all index getRunningTeammatesSorted, so a
 * second sort here would make the selected pill and the selected spinner row
 * disagree.
 */

// Wide enough that calculateHorizontalScrollWindow keeps every pill on screen.
const COLUMNS = 200

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

/**
 * The same teammate with `agentId` and `teamName` stripped off its identity.
 * `TeammateIdentity` types both as `string` and every spawn path sets them, so
 * the cast is a deliberate type violation — it is the shape a hand-built or
 * stale AppState can still hold, and a pill without one must keep the bare
 * `@name` label instead of throwing the whole footer out of the render.
 */
function withoutTeam(
  t: InProcessTeammateTaskState,
): InProcessTeammateTaskState {
  const identity = { ...t.identity } as Partial<
    InProcessTeammateTaskState['identity']
  >
  delete identity.teamName
  delete identity.agentId
  return { ...t, identity } as unknown as InProcessTeammateTaskState
}

function stateWith(
  teammates: InProcessTeammateTaskState[],
  overrides: Partial<AppState> = {},
): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
    ...overrides,
  }
}

async function renderPills(
  state: AppState,
  props: Record<string, unknown> = {},
): Promise<string[]> {
  const frame = await renderToString(
    <AppStateProvider initialState={state}>
      <BackgroundTaskStatus tasksSelected={false} {...props} />
    </AppStateProvider>,
    COLUMNS,
  )
  return [...frame.matchAll(/@([\w/-]+)/g)].map(match => match[1]!)
}

async function renderPillsAnsi(
  state: AppState,
  props: Record<string, unknown> = {},
): Promise<string> {
  return await renderToAnsiString(
    <AppStateProvider initialState={state}>
      <BackgroundTaskStatus tasksSelected={false} {...props} />
    </AppStateProvider>,
    COLUMNS,
  )
}

// The bold/dim checks below read SGR codes; pin chalk to truecolor so they are
// emitted at all, exactly as TeammateSpinnerTree's suite does.
const originalChalkLevel = chalk.level
chalk.level = 3
afterAll(() => {
  chalk.level = originalChalkLevel
})

/** ANSI bold — what AgentPill puts on the pill of the teammate being viewed. */
const BOLD = '\u001B[1m'
/** The theme's dim grey — what `dimColor` renders as at truecolor. */
const DIM = '\u001B[38;2;153;153;153m'

/** The line of a frame carrying a given pill (the static render is one per line). */
function lineWith(frame: string, needle: string): string {
  return frame.split('\n').find(line => line.includes(needle))!
}

/** The label the pill row is expected to give a teammate. */
function pillLabel(task: InProcessTeammateTaskState): string {
  return [...getSubLeadPath(task.identity.teamName), task.identity.agentName].join(
    '/',
  )
}

describe('BackgroundTaskStatus teammate pills', () => {
  test('prefixes a sub-team member with its sub-lead and leaves root members bare', async () => {
    expect(await renderPills(stateWith(TWO_LEVEL))).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test('follows the same order the spinner tree and the navigation hook index', async () => {
    const state = stateWith(TWO_LEVEL)
    const shared = getRunningTeammatesSorted(state.tasks).map(pillLabel)
    expect(await renderPills(state)).toEqual(['main', ...shared])
  })

  test('keeps an idle teammate in its tree position instead of sorting it last', async () => {
    // The pill row used to re-sort idle teammates to the end, which moved a
    // pill out from under the sub-lead it belongs to and off the position the
    // spinner tree and the footer selection were using.
    const idleAlice = [
      ...TWO_LEVEL.filter(t => t.identity.agentName !== 'alice'),
      teammate('alice', 'email', { isIdle: true }),
    ]
    expect(await renderPills(stateWith(idleAlice))).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test('labels a three-level member with every sub-lead above it', async () => {
    const pills = await renderPills(
      stateWith([...TWO_LEVEL, teammate('deputy', 'email/supervisor/worker-1')]),
    )
    expect(pills).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-1/deputy',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test('shows an orphaned sub-team member once, still labelled by its sub-lead', async () => {
    const pills = await renderPills(
      stateWith([...TWO_LEVEL, teammate('stray', 'email/ghost')]),
    )
    expect(pills).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
      'ghost/stray',
    ])
    expect(pills.filter(label => label === 'ghost/stray')).toHaveLength(1)
  })

  test('labels a teammate whose identity has no team name with the bare name', async () => {
    // No team name means no sub-lead path: the pill is `@nomad`, at the root,
    // and the complete identities keep the labels and order they already had.
    const pills = await renderPills(
      stateWith([...TWO_LEVEL, withoutTeam(teammate('nomad', 'email'))]),
    )
    expect(pills).toEqual([
      'main',
      'nomad',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test('keeps a teammate inside its grace window at its depth-first position', async () => {
    // A finished teammate keeps its row for TEAMMATE_GRACE_MS — `retain: false`
    // plus an evictAfter that has not passed — and getRunningTeammatesSorted is
    // what holds it there. The pill row reads that same array, so the grace row
    // stays under its sub-lead with the usual `@sub-lead/name` label; a row
    // filtered on `status === 'running'` of its own would drop it and shift
    // every pill after it off the index selection addresses.
    const gracedWorker = [
      ...TWO_LEVEL.filter(t => t.identity.agentName !== 'worker-1'),
      teammate('worker-1', 'email/supervisor', {
        status: 'completed',
        retain: false,
        evictAfter: Date.now() + TEAMMATE_GRACE_MS,
      }),
    ]
    expect(await renderPills(stateWith(gracedWorker))).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test('keeps the order while a teammate is being viewed', async () => {
    const viewed = TWO_LEVEL.find(t => t.identity.agentName === 'worker-1')!
    const pills = await renderPills(
      stateWith(TWO_LEVEL, {
        viewingAgentTaskId: viewed.id,
        viewSelectionMode: 'viewing-agent',
      }),
      { isViewingTeammate: true },
    )
    expect(pills).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })
})

/**
 * F3/B3 and S5: which pill is highlighted, how the pills are keyed, and what a
 * pill looks like once its teammate has finished.
 */
describe('BackgroundTaskStatus — the viewed pill, the pill key and grace pills', () => {
  test('a viewed task that is NOT in the list highlights no pill — never `main`', async () => {
    // viewedIdx used to be findIndex(...) + 1, so a missing task scored
    // -1 + 1 = 0 and lit the leader's own pill as if the leader were being
    // viewed. -1 highlights nothing, which is what "not listed" means.
    const frame = await renderPillsAnsi(
      stateWith(TWO_LEVEL, {
        viewingAgentTaskId: 'task-that-is-gone',
        viewSelectionMode: 'viewing-agent',
      }),
      { isViewingTeammate: true },
    )

    expect(frame).not.toContain(BOLD)
  })

  test('the leader IS the viewed pill when no teammate transcript is open', async () => {
    // The other half of the same rule, so the fix above cannot be "never bold".
    const frame = await renderPillsAnsi(stateWith(TWO_LEVEL))
    expect(lineWith(frame, '@main')).toContain(BOLD)
  })

  test('the viewed teammate gets the bold pill, not the leader', async () => {
    const viewed = TWO_LEVEL.find(t => t.identity.agentName === 'worker-1')!
    const frame = await renderPillsAnsi(
      stateWith(TWO_LEVEL, {
        viewingAgentTaskId: viewed.id,
        viewSelectionMode: 'viewing-agent',
      }),
      { isViewingTeammate: true },
    )

    expect(lineWith(frame, '@supervisor/worker-1')).toContain(BOLD)
    expect(lineWith(frame, '@main')).not.toContain(BOLD)
  })

  test('a teammate literally named `main` does not collide with the leader pill key', async () => {
    // Pills used to be keyed by their LABEL, so this teammate and the leader's
    // own `main` pill shared a React key — a reconciliation hazard React
    // reports as a duplicate-key error. They are keyed by task id now, with a
    // sentinel for the leader. Both pills render either way, so what is
    // asserted is the key collision itself.
    const warnings: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    let pills: string[]
    try {
      pills = await renderPills(
        stateWith([...TWO_LEVEL, teammate('main', 'email')]),
      )
    } finally {
      console.error = originalError
    }

    expect(pills).toEqual([
      'main',
      'alice',
      'main',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
    expect(
      warnings.filter(line => line.includes('same key')),
    ).toEqual([])
  })

  test('the pill row still renders when every teammate is inside its grace window', async () => {
    // S2: allTeammates used to key on runningTasks, and a terminal task is not
    // a background task — so an all-grace team made the whole pill row vanish
    // for 30s even though the rows were still in the shared order.
    const allGrace = TWO_LEVEL.map(t =>
      teammate(t.identity.agentName, t.identity.teamName!, {
        status: 'completed',
        retain: false,
        evictAfter: Date.now() + TEAMMATE_GRACE_MS,
      }),
    )

    expect(await renderPills(stateWith(allGrace))).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })

  test.each(['completed', 'failed', 'killed'] as const)(
    'a %s pill reads its terminal word and is drawn dimmed',
    async status => {
      // S5: exactly what the tree does with a grace row, so the two surfaces
      // say the same thing about the same teammate. Both teammates carry a
      // colour, because a colourless pill is dim whatever its state — the
      // discriminator is that the finished one loses its colour to the dim.
      const coloured = (
        name: string,
        overrides: Partial<InProcessTeammateTaskState> = {},
      ): InProcessTeammateTaskState =>
        teammate(name, 'email/supervisor', {
          identity: {
            ...teammate(name, 'email/supervisor').identity,
            color: 'green',
          },
          ...overrides,
        })
      const frame = await renderPillsAnsi(
        stateWith([
          coloured('worker-1', {
            status,
            retain: false,
            evictAfter: Date.now() + TEAMMATE_GRACE_MS,
          }),
          coloured('worker-2'),
        ]),
      )
      const graceLine = lineWith(frame, '@supervisor/worker-1')

      expect(graceLine).toContain(`@supervisor/worker-1 · ${status}`)
      expect(graceLine).toContain(DIM)
      // The running teammate beside it is untouched: no word, and it keeps its
      // own colour rather than being dimmed.
      const liveLine = lineWith(frame, '@supervisor/worker-2')
      expect(liveLine).not.toContain('·')
      expect(liveLine).not.toContain(DIM)
    },
  )

  test('a running pill carries no terminal word at all', async () => {
    const pills = await renderPills(stateWith(TWO_LEVEL))
    const frame = await renderPillsAnsi(stateWith(TWO_LEVEL))

    expect(pills).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
    for (const name of pills) {
      expect(lineWith(frame, `@${name}`)).not.toContain('·')
    }
  })

  test('a grace pill keeps its depth-first position and its sub-lead prefix', async () => {
    // The label is the same one the running pill had, with the word appended —
    // not a relabelled or re-sorted pill.
    const graced = teammate('worker-1', 'email/supervisor', {
      status: 'completed',
      retain: false,
      evictAfter: Date.now() + TEAMMATE_GRACE_MS,
    })
    const pills = await renderPills(
      stateWith([
        ...TWO_LEVEL.filter(t => t.identity.agentName !== 'worker-1'),
        graced,
      ]),
    )

    expect(pills).toEqual([
      'main',
      'alice',
      'supervisor',
      'supervisor/worker-1',
      'supervisor/worker-2',
      'zoe',
    ])
  })
})
