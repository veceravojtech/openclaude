import { describe, expect, test } from 'bun:test'
import React from 'react'

import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { renderToString } from '../../utils/staticRender.js'
import { TeammateSpinnerTree } from './TeammateSpinnerTree.js'

/**
 * The spinner tree is where the team tree becomes visible: rows come in the
 * shared depth-first order (getRunningTeammatesSorted) and a sub-team member is
 * indented under the teammate that leads it, one level per step down the tree.
 * Asserted on rendered text — TeammateSpinnerTree is hand-maintained
 * react-compiler output, so a wrong cache slot would silently serve a stale
 * node that only the frame can catch.
 */

const COLUMNS = 120

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

/**
 * The shared two-level fixture: root team `email` with alice, supervisor and
 * zoe, plus supervisor's sub-team `email/supervisor` with worker-1 and
 * worker-2. Fed in shuffled so the rendered order can only come from the
 * component's own ordering.
 */
const TWO_LEVEL = [
  teammate('zoe', 'email'),
  teammate('worker-2', 'email/supervisor'),
  teammate('alice', 'email'),
  teammate('worker-1', 'email/supervisor'),
  teammate('supervisor', 'email'),
]

function stateWith(teammates: InProcessTeammateTaskState[]): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
  }
}

async function renderTree(
  teammates: InProcessTeammateTaskState[],
  props: Record<string, unknown> = {},
): Promise<string> {
  return await renderToString(
    <AppStateProvider initialState={stateWith(teammates)}>
      <TeammateSpinnerTree {...props} />
    </AppStateProvider>,
    COLUMNS,
  )
}

/** One entry per teammate row: its @name and the column its tree char sits in. */
function teammateRows(frame: string): Array<{ name: string; indent: number }> {
  const rows: Array<{ name: string; indent: number }> = []
  for (const line of frame.split('\n')) {
    const match = /@([\w-]+)/.exec(line)
    if (!match?.[1]) continue
    rows.push({ name: match[1], indent: line.search(/\S/) })
  }
  return rows
}

describe('TeammateSpinnerTree', () => {
  test('lists the two-level fixture depth-first and indents the sub-team', async () => {
    const frame = await renderTree(TWO_LEVEL)
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])

    // Root-team rows share one indent; the sub-team's rows sit exactly one
    // level (2 columns) further right, under their sub-lead.
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'supervisor')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'zoe')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'worker-1')!.indent).toBe(root + 2)
    expect(rows.find(row => row.name === 'worker-2')!.indent).toBe(root + 2)
  })

  test('still draws the leader row above the team', async () => {
    const frame = await renderTree(TWO_LEVEL)
    expect(frame).toContain('team-lead')
    expect(frame.indexOf('team-lead')).toBeLessThan(frame.indexOf('@alice'))
  })

  test('indents a third level one step further and returns to the sibling after it', async () => {
    const frame = await renderTree([
      ...TWO_LEVEL,
      teammate('deputy', 'email/supervisor/worker-1'),
    ])
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'deputy',
      'worker-2',
      'zoe',
    ])
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'deputy')!.indent).toBe(root + 4)
    expect(rows.find(row => row.name === 'worker-2')!.indent).toBe(root + 2)
  })

  test('draws an orphaned sub-team member once, at its own depth', async () => {
    // Its sub-lead `ghost` is not running: the row must still be there, exactly
    // once, indented as its team name says.
    const frame = await renderTree([...TWO_LEVEL, teammate('stray', 'email/ghost')])
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
      'stray',
    ])
    expect(rows.filter(row => row.name === 'stray')).toHaveLength(1)
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'stray')!.indent).toBe(root + 2)
  })

  test('marks the selected row, which is the row at that index of the shared order', async () => {
    // selectedIndex 2 is worker-1 in depth-first order — the same index
    // useBackgroundTaskNavigation would put in selectedIPAgentIndex.
    const frame = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selectedIndex: 2,
    })
    const selected = frame
      .split('\n')
      .find(line => line.includes('enter to view'))
    expect(selected).toContain('@worker-1')
  })

  test('renders nothing when no teammate is running', async () => {
    const frame = await renderTree([])
    expect(frame).not.toContain('team-lead')
    expect(frame.trim()).toBe('')
  })
})
