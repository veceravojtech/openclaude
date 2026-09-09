import { describe, expect, test } from 'bun:test'
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
import { renderToString } from '../../utils/staticRender.js'
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
    // pill out from under the sub-lead it belongs to and off the index the
    // spinner tree and selectedIPAgentIndex were using.
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
