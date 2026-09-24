import { expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { TeamFile } from './teamHelpers.js'
import { resolveDelegatedActivity } from './delegatedActivity.js'

const team = (name: string, parentTeam: string, parentAgentId: string, members: string[]): TeamFile => ({
  name, parentTeam, parentAgentId, leadAgentId: parentAgentId,
  members: members.map(name => ({ name, agentId: `${name}@${name === 'child' ? 'root/owner' : 'root/owner/child'}` })),
} as TeamFile)
const teams = [team('root/owner', 'root', 'owner@root', ['child']), team('root/owner/child', 'root/owner', 'child@root/owner', ['grandchild'])]
const task = (id: string, isIdle = false, status = 'running') => ({
  type: 'in_process_teammate', status, isIdle,
  identity: { agentId: id, agentName: id.split('@')[0], teamName: id.split('@')[1] },
})
const tasks = (rows: Record<string, unknown>) => rows as AppState['tasks']

test('leaf self-idle remains quiet', () => {
  expect(resolveDelegatedActivity('owner@root', tasks({ owner: task('owner@root', true) })).status).toBe('none')
})

test('busy grandchild is included through idle intermediate, siblings excluded', () => {
  const result = resolveDelegatedActivity('owner@root', tasks({ child: task('child@root/owner', true), grand: task('grandchild@root/owner/child'), sibling: task('sibling@root') }), teams)
  expect(result).toEqual({ status: 'working', activeDescendants: ['grandchild@root/owner/child'], unknownDescendants: [] })
})

test('roster-only descendants stay unknown; terminal task overrides stale roster', () => {
  expect(resolveDelegatedActivity('owner@root', {}, teams).status).toBe('unknown')
  expect(resolveDelegatedActivity('owner@root', tasks({ child: task('child@root/owner', true, 'completed'), grand: task('grandchild@root/owner/child', false, 'killed') }), teams).status).toBe('none')
})

test('idle roster member (isActive:false) with no task row resolves to none', () => {
  const idle = team('root/owner', 'root', 'owner@root', ['child'])
  idle.members[0]!.isActive = false
  expect(resolveDelegatedActivity('owner@root', {}, [idle]).status).toBe('none')
})

test('active (isActive:true) or unset roster member with no task row stays unknown', () => {
  const active = team('root/owner', 'root', 'owner@root', ['child'])
  active.members[0]!.isActive = true
  expect(resolveDelegatedActivity('owner@root', {}, [active]).status).toBe('unknown')
  const unset = team('root/owner', 'root', 'owner@root', ['child'])
  expect(resolveDelegatedActivity('owner@root', {}, [unset]).status).toBe('unknown')
})

test('starting tasks count and live respawn wins terminal entries', () => {
  const result = resolveDelegatedActivity('owner@root', tasks({ child: task('child@root/owner', true, 'pending'), old: task('child@root/owner', false, 'killed'), grand: task('grandchild@root/owner/child', true) }), teams)
  expect(result.activeDescendants).toEqual(['child@root/owner'])
})

test('unvalidated team edges cannot include unrelated workers', () => {
  const invalid = { ...teams[0]!, parentTeam: 'other' }
  expect(resolveDelegatedActivity('owner@root', tasks({ child: task('child@root/owner') }), [invalid]).status).toBe('none')
})

test('recursive local-agent forks and cycles are bounded', () => {
  const result = resolveDelegatedActivity('owner', tasks({
    first: { type: 'local_agent', agentId: 'first', parentAgentId: 'owner', status: 'completed' },
    second: { type: 'local_agent', agentId: 'second', parentAgentId: 'first', status: 'running' },
    cycle: { type: 'local_agent', agentId: 'owner', parentAgentId: 'second', status: 'running' },
    sibling: { type: 'local_agent', agentId: 'sibling', parentAgentId: 'another', status: 'running' },
  }))
  expect(result.activeDescendants).toEqual(['second'])
})
