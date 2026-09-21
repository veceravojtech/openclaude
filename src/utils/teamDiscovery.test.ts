import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getTeammateStatuses } from './teamDiscovery.js'
import * as realTeamHelpers from './swarm/teamHelpers.js'
import type { TeamFile } from './swarm/teamHelpers.js'

// Snapshot taken before any mock.module() call: mock.module() mutates the live
// namespace object in place, so restoring from a spread of the namespace after
// mocking would re-install the stub. `getTeammateStatuses` reads the team file
// through `readTeamFile`; mock just that one export per-test and hand the real
// module back afterwards, so no other file in this process inherits a stubbed
// `readTeamFile`.
const pristineTeamHelpers = { ...realTeamHelpers }

let currentTeamFile: TeamFile | null = null

beforeEach(() => {
  currentTeamFile = null
  mock.module('./swarm/teamHelpers.js', () => ({
    ...pristineTeamHelpers,
    readTeamFile: () => currentTeamFile,
  }))
})

afterEach(() => {
  mock.restore()
  mock.module('./swarm/teamHelpers.js', () => ({ ...pristineTeamHelpers }))
})

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

test('an active member is never probed for deadness — the dead verdict is no broader than the sweep', async () => {
  const probeCalls: Array<[string, string, string | undefined]> = []
  currentTeamFile = teamFile([
    member({ name: 'busy', backendType: 'tmux', tmuxPaneId: '%2', isActive: true }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async (backendType, paneId, socketName) => {
      probeCalls.push([backendType, paneId, socketName])
      return 'dead'
    },
  })
  // The roster says the teammate is mid-turn, so a pane probe must not be able
  // to paint it as dead/killed — even if the probe would answer dead.
  expect(statuses[0]?.status).toBe('running')
  expect(probeCalls).toEqual([])
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

test('the member’s recorded socket is threaded to the probe', async () => {
  const probeCalls: Array<[string, string, string | undefined]> = []
  currentTeamFile = teamFile([
    member({
      name: 'worker',
      backendType: 'tmux',
      tmuxPaneId: '%5',
      isActive: false,
      tmuxSocket: 'default',
    }),
  ])
  await getTeammateStatuses('team', {
    probePane: async (backendType, paneId, socketName) => {
      probeCalls.push([backendType, paneId, socketName])
      return 'alive'
    },
  })
  expect(probeCalls).toEqual([['tmux', '%5', 'default']])
})

test('an idle member without a recorded socket is never reported dead', async () => {
  // Mirrors the production socket-identity rule at the seam: a foreign socket
  // (no recorded socket) cannot prove death, so it answers unknown.
  currentTeamFile = teamFile([
    member({ name: 'legacy', backendType: 'tmux', tmuxPaneId: '%6', isActive: false }),
  ])
  const statuses = await getTeammateStatuses('team', {
    probePane: async (_backendType, _paneId, socketName) =>
      socketName ? 'dead' : 'unknown',
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
