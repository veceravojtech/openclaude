import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { readSubTeamLedBySync, type TeamFile } from './teamHelpers.js'

export type DelegatedActivity = {
  status: 'none' | 'working' | 'unknown'
  activeDescendants: string[]
  unknownDescendants: string[]
}

/** Self-idle is not availability: descendants may still own unfinished work. */
export function resolveDelegatedActivity(
  agentId: string,
  tasks: AppState['tasks'],
  teams: readonly TeamFile[] = [],
): DelegatedActivity {
  const children = new Map<string, Set<string>>()
  const labels = new Map<string, string>()
  const state = new Map<string, 'working' | 'unknown' | 'none'>()
  const add = (parent: string, child: string) => {
    if (parent === child) return
    const ids = children.get(parent) ?? new Set<string>()
    ids.add(child)
    children.set(parent, ids)
  }
  const validTeams = teams.filter(team => {
    if (!team.parentAgentId || !team.parentTeam) return false
    const parentName = team.parentAgentId.slice(0, team.parentAgentId.lastIndexOf('@'))
    return team.name === `${team.parentTeam}/${parentName}` &&
      team.parentAgentId.endsWith(`@${team.parentTeam}`)
  })
  for (const team of validTeams) {
    if (!team.parentAgentId) continue
    for (const member of team.members) {
      if (member.agentId === team.leadAgentId || member.name === 'team-lead') continue
      // Idle roster members (isActive === false) are resolved, not unknown:
      // task rows evict after the grace period, so without this an idle
      // descendant would otherwise read as 'unknown' forever.
      if (member.isActive === false) continue
      add(team.parentAgentId, member.agentId)
      labels.set(member.agentId, `${member.name}@${team.name}`)
      state.set(member.agentId, 'unknown')
    }
  }
  const live = new Set<string>()
  for (const task of Object.values(tasks)) {
    if (task.type !== 'local_agent' && task.type !== 'in_process_teammate') continue
    const id = task.type === 'local_agent' ? task.agentId : task.identity.agentId
    if (task.type === 'local_agent') {
      if (task.parentAgentId) add(task.parentAgentId, id)
      labels.set(id, id)
    } else {
      labels.set(id, `${task.identity.agentName}@${task.identity.teamName}`)
      const team = validTeams.find(team => team.name === task.identity.teamName)
      if (team?.parentAgentId) add(team.parentAgentId, id)
    }
    const isLive = task.status === 'running' || task.status === 'pending'
    if (live.has(id) && !isLive) continue
    if (isLive) live.add(id)
    state.set(id, isLive && (task.type === 'local_agent' || task.status === 'pending' || !task.isIdle)
      ? 'working' : isLive && task.type === 'in_process_teammate' && task.delegatedActivity
        ? task.delegatedActivity.status : 'none')
  }
  const seen = new Set([agentId])
  const activeDescendants: string[] = []
  const unknownDescendants: string[] = []
  const visit = (parent: string) => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      const activity = state.get(child)
      if (activity === 'working') activeDescendants.push(labels.get(child) ?? child)
      if (activity === 'unknown') unknownDescendants.push(labels.get(child) ?? child)
      visit(child)
    }
  }
  visit(agentId)
  activeDescendants.sort()
  unknownDescendants.sort()
  return {
    status: activeDescendants.length ? 'working' : unknownDescendants.length ? 'unknown' : 'none',
    activeDescendants,
    unknownDescendants,
  }
}

/** Read only validated ownership links, not similarly prefixed team names. */
export function readDelegatedActivity(
  owner: { agentId: string; agentName: string },
  tasks: AppState['tasks'],
): DelegatedActivity {
  const teams: TeamFile[] = []
  const seen = new Set<string>()
  const visit = (agentId: string, name: string) => {
    if (seen.has(agentId)) return
    seen.add(agentId)
    const team = readSubTeamLedBySync({ agentId, name, isTeammate: true })
    const members = new Map<string, string>()
    if (team) {
      teams.push(team)
      for (const member of team.members) {
        if (member.agentId !== team.leadAgentId && member.name !== 'team-lead') {
          members.set(member.agentId, member.name)
        }
      }
    }
    for (const task of Object.values(tasks)) {
      if (task.type === 'in_process_teammate' && team && task.identity.teamName === team.name) {
        members.set(task.identity.agentId, task.identity.agentName)
      }
      if (task.type === 'local_agent' && task.parentAgentId === agentId) {
        members.set(task.agentId, task.agentId)
      }
    }
    for (const [id, memberName] of members) visit(id, memberName)
  }
  visit(owner.agentId, owner.agentName)
  return resolveDelegatedActivity(owner.agentId, tasks, teams)
}

export function teammateDelegatedActivity(task: InProcessTeammateTaskState, tasks: AppState['tasks']): DelegatedActivity {
  return readDelegatedActivity(task.identity, tasks)
}
