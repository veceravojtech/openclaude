import { describe, expect, test } from 'bun:test'

import {
  getRunningTeammatesSorted,
  getSubLeadPath,
  orderTeammatesDepthFirst,
} from './InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from './types.js'

/**
 * The one order every teammate surface indexes into: the spinner tree's rows,
 * the pill row, PromptInput's footer selector and selectedIPAgentIndex in
 * useBackgroundTaskNavigation. It has to be depth-first over the team tree —
 * a sub-lead immediately followed by its own sub-team — or the row a key
 * selects and the row the operator sees stop being the same row.
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
 * The shared two-level fixture (also built, row for row, by the spinner-tree,
 * pill-row and navigation suites): root team `email` with alice, supervisor and
 * zoe, and supervisor's sub-team `email/supervisor` with worker-1 and worker-2.
 * Deliberately fed in shuffled — nothing may depend on insertion order.
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
 * the cast is a deliberate type violation — it is exactly the shape a
 * hand-built or stale AppState can still hold (promptPlaceholderAgentName's
 * fixture held it until this change), and a missing team name must degrade the
 * teammate to a root-team member instead of throwing out of the whole render.
 */
function withoutTeam(
  teammate_0: InProcessTeammateTaskState,
): InProcessTeammateTaskState {
  const identity = {
    ...teammate_0.identity,
  } as Partial<InProcessTeammateTaskState['identity']>
  delete identity.teamName
  delete identity.agentId
  return { ...teammate_0, identity } as unknown as InProcessTeammateTaskState
}

function names(teammates: InProcessTeammateTaskState[]): string[] {
  return teammates.map(t => t.identity.agentName)
}

function tasksOf(
  teammates: InProcessTeammateTaskState[],
): Record<string, InProcessTeammateTaskState> {
  return Object.fromEntries(teammates.map(t => [t.id, t]))
}

describe('getSubLeadPath', () => {
  test('a root team has no sub-leads above it', () => {
    expect(getSubLeadPath('email')).toEqual([])
  })

  test('a sub-team names the teammate that leads it', () => {
    expect(getSubLeadPath('email/supervisor')).toEqual(['supervisor'])
  })

  test('a deeper sub-team names every sub-lead, outermost first', () => {
    expect(getSubLeadPath('email/supervisor/worker-1')).toEqual([
      'supervisor',
      'worker-1',
    ])
  })

  test('an empty team name is treated as a root team, not as a segment', () => {
    expect(getSubLeadPath('')).toEqual([])
  })

  test('an absent team name is a root team rather than a throw', () => {
    // The pill label and the teammate view header path both start here, so an
    // identity without a team name has to come back as a bare name, not as an
    // uncaught TypeError out of getParentTeamName.
    expect(getSubLeadPath(undefined)).toEqual([])
  })
})

describe('orderTeammatesDepthFirst', () => {
  test('puts a sub-team straight under the teammate that leads it', () => {
    expect(names(orderTeammatesDepthFirst(TWO_LEVEL))).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
  })

  test('descends through three levels before returning to the next sibling', () => {
    const threeLevel = [
      ...TWO_LEVEL,
      teammate('deputy', 'email/supervisor/worker-1'),
    ]
    expect(names(orderTeammatesDepthFirst(threeLevel))).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'deputy',
      'worker-2',
      'zoe',
    ])
  })

  test('keeps an orphaned sub-team member exactly once when its sub-lead is gone', () => {
    // `ghost` is not running, so nothing descends into `email/ghost`; its
    // member must still be listed, and listed once.
    const withOrphan = [...TWO_LEVEL, teammate('stray', 'email/ghost')]
    const ordered = names(orderTeammatesDepthFirst(withOrphan))
    expect(ordered).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
      'stray',
    ])
    expect(ordered.filter(name => name === 'stray')).toHaveLength(1)
    expect(ordered).toHaveLength(withOrphan.length)
  })

  test('sorts siblings by plain string order, not by locale', () => {
    const mixedCase = [
      teammate('bravo', 'email'),
      teammate('Alpha', 'email'),
      teammate('alpha', 'email'),
    ]
    expect(names(orderTeammatesDepthFirst(mixedCase))).toEqual([
      'Alpha',
      'alpha',
      'bravo',
    ])
  })

  test('orders sibling sub-teams by team name under their shared parent', () => {
    const twoSubTeams = [
      teammate('bob', 'email'),
      teammate('ann', 'email'),
      teammate('b-worker', 'email/bob'),
      teammate('a-worker', 'email/ann'),
    ]
    expect(names(orderTeammatesDepthFirst(twoSubTeams))).toEqual([
      'ann',
      'a-worker',
      'bob',
      'b-worker',
    ])
  })

  test('returns an empty list for no teammates', () => {
    expect(orderTeammatesDepthFirst([])).toEqual([])
  })

  test('keeps a teammate whose identity has no team name, at the root', () => {
    const withTeamless = [...TWO_LEVEL, withoutTeam(teammate('nomad', 'email'))]
    const ordered = names(orderTeammatesDepthFirst(withTeamless))
    // The unnamed team is the root team '', which sorts before every named
    // team; the complete identities keep exactly the order they had without it.
    expect(ordered).toEqual([
      'nomad',
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
    expect(ordered).toHaveLength(withTeamless.length)
  })

  test('never loops when a sub-team name points back at an ancestor', () => {
    // A teammate named after its own parent team would make `email/supervisor`
    // claim `email/supervisor/supervisor`; each team is emitted at most once,
    // so the walk still terminates with every teammate listed once.
    const looping = [
      teammate('supervisor', 'email'),
      teammate('supervisor', 'email/supervisor'),
      teammate('deep', 'email/supervisor/supervisor'),
    ]
    const ordered = orderTeammatesDepthFirst(looping)
    expect(names(ordered)).toEqual(['supervisor', 'supervisor', 'deep'])
    expect(new Set(ordered.map(t => t.id)).size).toBe(3)
  })
})

describe('getRunningTeammatesSorted', () => {
  test('reads the depth-first order out of AppState', () => {
    expect(names(getRunningTeammatesSorted(tasksOf(TWO_LEVEL)))).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
  })

  test('leaves out teammates that are no longer running', () => {
    const withDead = [
      ...TWO_LEVEL,
      teammate('gone', 'email', { status: 'killed' }),
      teammate('done', 'email/supervisor', { status: 'completed' }),
    ]
    expect(names(getRunningTeammatesSorted(tasksOf(withDead)))).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
  })

  test('ignores tasks that are not in-process teammates', () => {
    const tasks = {
      ...tasksOf(TWO_LEVEL),
      'bash-1': {
        id: 'bash-1',
        type: 'local_bash',
        status: 'running',
        description: 'a shell',
        startTime: 1,
        outputFile: '/tmp/bash-1.log',
        outputOffset: 0,
        notified: false,
      },
    } as unknown as Record<string, InProcessTeammateTaskState>
    expect(getRunningTeammatesSorted(tasks)).toHaveLength(5)
  })
})
