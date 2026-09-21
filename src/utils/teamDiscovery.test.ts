import { expect, mock, test } from 'bun:test'
import { getTeammateStatuses } from './teamDiscovery.js'
import * as realTeamHelpers from './swarm/teamHelpers.js'
import type { TeamFile } from './swarm/teamHelpers.js'

// `getTeammateStatuses` reads the team file through `readTeamFile`. Mock that
// one export so the tests drive the roster contents and the pane probe directly,
// without touching ~/.claude/teams or a live tmux.
let currentTeamFile: TeamFile | null = null
mock.module('./swarm/teamHelpers.js', () => ({
  ...realTeamHelpers,
  readTeamFile: () => currentTeamFile,
}))

function member(
  overrides: Partial<TeamFile['members'][number]> = {},
): TeamFile['members'][number] {
  return {
    agentId: 'worker@team',
    name: 'worker',
    joinedAt: 0,
    tmuxPaneId: '%1',
    cwd: '/work',
    subscriptions: [],
    ...overrides,
  }
}

function teamFile(members: TeamFile['members']): TeamFile {
  return {
    name: 'team',
    createdAt: 0,
    leadAgentId: 'team-lead@team',
    members,
  }
}

test('a tmux member whose pane probe answers dead is reported dead, not idle', async () => {
  currentTeamFile = teamFile([
    member({ name: 'ghost', backendType: 'tmux', tmuxPaneId: '%2', isActive: false }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async () => 'dead',
  })
  expect(statuses).toHaveLength(1)
  expect(statuses[0]?.status).toBe('dead')
})

test('a dead pane wins over isActive: true (the flag is not authoritative)', async () => {
  currentTeamFile = teamFile([
    member({ name: 'ghost', backendType: 'tmux', tmuxPaneId: '%2', isActive: true }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async () => 'dead',
  })
  expect(statuses[0]?.status).toBe('dead')
})

test('a tmux member with a live pane stays idle', async () => {
  currentTeamFile = teamFile([
    member({ name: 'worker', backendType: 'tmux', tmuxPaneId: '%3', isActive: false }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async () => 'alive',
  })
  expect(statuses[0]?.status).toBe('idle')
})

test('an unknown probe is never reported dead', async () => {
  currentTeamFile = teamFile([
    member({ name: 'worker', backendType: 'tmux', tmuxPaneId: '%4', isActive: false }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async () => 'unknown',
  })
  expect(statuses[0]?.status).toBe('idle')
})

test('in-process members are unchanged and never probed', async () => {
  const probeCalls: string[] = []
  currentTeamFile = teamFile([
    member({ name: 'ip', backendType: 'in-process', tmuxPaneId: '', isActive: false }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async (_backendType, paneId) => {
      probeCalls.push(paneId)
      return 'dead'
    },
  })
  expect(statuses[0]?.status).toBe('idle')
  expect(probeCalls).toEqual([])
})

test('a missing team file yields no statuses', async () => {
  currentTeamFile = null
  const statuses = await getTeammateStatuses('nope')
  expect(statuses).toEqual([])
})
