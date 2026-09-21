/**
 * Team Discovery - Utilities for discovering teams and teammate status
 *
 * Scans ~/.claude/teams/ to find teams where the current session is the leader.
 * Used by the Teams UI in the footer to show team status.
 */

import { logForDebugging } from './debug.js'
import {
  isPaneBackend,
  type PaneBackendType,
  type PaneLiveness,
} from './swarm/backends/types.js'
import { readTeamFile } from './swarm/teamHelpers.js'

export type TeamSummary = {
  name: string
  memberCount: number
  runningCount: number
  idleCount: number
}

export type TeammateStatus = {
  name: string
  agentId: string
  agentType?: string
  model?: string
  prompt?: string
  status: 'running' | 'idle' | 'dead' | 'unknown'
  color?: string
  idleSince?: string // ISO timestamp from idle notification
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  isHidden?: boolean // Whether the pane is currently hidden from the swarm view
  backendType?: PaneBackendType // The backend type used for this teammate
  mode?: string // Current permission mode for this teammate
}

/**
 * Pane-liveness probe for one member, injectable for tests.
 *
 * The backend's own `isPaneAlive` is the single authority here, so this type
 * carries exactly its `PaneLiveness` contract: `'alive'`, `'dead'`, or
 * `'unknown'`. Callers must never treat `'unknown'` as death.
 */
export type TeammatePaneProbe = (
  backendType: PaneBackendType,
  paneId: string,
) => Promise<PaneLiveness>

/**
 * The production probe: the pane backend's own `isPaneAlive`.
 *
 * Deliberately not a second implementation of pane liveness — TmuxBackend
 * already knows how to tell a killed pane from an unreachable tmux (the
 * tri-state `alive`/`dead`/`unknown` probe), and every other caller must not
 * diverge from it. The registry/detection imports are dynamic for the same
 * reason teamHelpers does it: they stay out of this module's static dep graph.
 */
async function probePane(
  backendType: PaneBackendType,
  paneId: string,
): Promise<PaneLiveness> {
  try {
    const [
      { ensureBackendsRegistered, getBackendByType },
      { isInsideTmuxSync },
    ] = await Promise.all([
      import('./swarm/backends/registry.js'),
      import('./swarm/backends/detection.js'),
    ])
    await ensureBackendsRegistered()
    const backend = getBackendByType(backendType)
    if (!backend.isPaneAlive) {
      return 'unknown'
    }
    return await backend.isPaneAlive(paneId, !isInsideTmuxSync())
  } catch (error) {
    logForDebugging(
      `[teamDiscovery] pane probe for ${backendType} ${paneId} failed: ${String(error)}`,
    )
    return 'unknown'
  }
}

/**
 * Get detailed teammate statuses for a team.
 *
 * Reads `isActive` from config for the running/idle split, and — for pane
 * (tmux/iTerm2) members — consults the pane probe to distinguish a member
 * whose pane is gone (`dead`) from one that is merely `idle`. Roster
 * `isActive` is not deterministically flipped on failure (a failed teammate
 * can stay `active: true`), so the probe is the authority for deadness. Only
 * `'dead'` changes the word: `'alive'` and `'unknown'` keep the existing
 * running/idle reading so resumability is unchanged and an unreachable tmux
 * never reports a healthy teammate as dead. In-process members (no pane
 * backend) are never probed and are unchanged.
 */
export async function getTeammateStatuses(
  teamName: string,
  opts?: { probePane?: TeammatePaneProbe },
): Promise<TeammateStatus[]> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return []
  }

  const hiddenPaneIds = new Set(teamFile.hiddenPaneIds ?? [])
  const probe = opts?.probePane ?? probePane
  const statuses: TeammateStatus[] = []

  for (const member of teamFile.members) {
    // Exclude team-lead from the list
    if (member.name === 'team-lead') {
      continue
    }

    // Read isActive from config, defaulting to true (active) if undefined
    const isActive = member.isActive !== false
    let status: TeammateStatus['status'] = isActive ? 'running' : 'idle'

    if (
      member.backendType &&
      isPaneBackend(member.backendType) &&
      member.tmuxPaneId
    ) {
      const liveness = await probe(member.backendType, member.tmuxPaneId)
      if (liveness === 'dead') {
        status = 'dead'
      }
    }

    statuses.push({
      name: member.name,
      agentId: member.agentId,
      agentType: member.agentType,
      model: member.model,
      prompt: member.prompt,
      status,
      color: member.color,
      tmuxPaneId: member.tmuxPaneId,
      cwd: member.cwd,
      worktreePath: member.worktreePath,
      isHidden: hiddenPaneIds.has(member.tmuxPaneId),
      backendType:
        member.backendType && isPaneBackend(member.backendType)
          ? member.backendType
          : undefined,
      mode: member.mode,
    })
  }

  return statuses
}

// Note: For time formatting, use formatRelativeTimeAgo from '../utils/format.js'
