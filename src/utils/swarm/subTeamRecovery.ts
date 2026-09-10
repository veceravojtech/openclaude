/**
 * Recovery for a sub-team whose lead died abnormally.
 *
 * Every DELIBERATE way for a sub-lead to end already takes its sub-team with
 * it — kill, TaskStop, TeamDelete and idle self-shutdown all funnel into
 * `cleanupTeamTree`. The runner's terminal FAILURE path does not: the task
 * goes terminal and is evicted while the sub-team directory survives with
 * `parentTeam`/`parentAgentId` intact, its members still working and still
 * writing a `team-lead` inbox that nothing will read again.
 *
 * This module is the detection and the two recoveries' on-disk half:
 *
 * - the runner's failure path calls {@link noteSubLeadFailure}, which records
 *   the orphan on the sub-team's own team file and tells the lead that polls
 *   the inbox above it,
 * - {@link adoptOrphanedSubTeam} hands the sub-team to the lead of its parent
 *   team, and {@link resolveUpwardInboxTeam} is what then makes the members'
 *   reports arrive there,
 * - {@link classifySubTeamState} derives the state from disk plus the live
 *   tasks rather than storing one, so a crash cannot leave it stale.
 *
 * The respawn half lives in `respawnSubLead.ts`: it has to spawn a teammate,
 * and keeping that import out of here is what stops an import cycle with the
 * runner, which imports this module.
 */

import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { formatAgentId, parseAgentId } from '../agentId.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { writeToMailbox } from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  collectDescendantTeamNames,
  getNaturalSubLeadAgentId,
  getParentTeamName,
  type OrphanedLeadRecord,
  readTeamFileAsync,
  reattachSubTeamToLead,
  type SubTeamReattachResult,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'

/**
 * What a sub-team is doing right now, derived — never stored.
 *
 * - `led`: its natural lead (`<name>@<parentTeam>`) is recorded and no failure
 *   record stands. The normal state, whether or not the lead is mid-turn.
 * - `orphaned`: a failure record stands and no live task carries the lead's
 *   identity. Its members are working for nobody.
 * - `adopted`: `parentAgentId` names someone other than the natural lead — in
 *   practice `team-lead@<parentTeam>`, which is the caretaker an adopt sets.
 * - `respawning`: a failure record still stands but a task with the lead's
 *   identity is live again — the window inside a respawn, before the
 *   re-attach that clears the record.
 */
export type SubTeamState = 'led' | 'orphaned' | 'adopted' | 'respawning'

/** Everything a lead needs to decide what to do about one sub-team. */
export type SubTeamRecoveryInfo = {
  teamName: string
  state: SubTeamState
  /** `parentAgentId` as recorded, i.e. who the file says leads it. */
  leadAgentId: string | undefined
  /** The only teammate that CAN lead it by name. */
  naturalLeadAgentId: string
  /** Whether a non-terminal teammate task carries the natural lead's id. */
  hasLiveLead: boolean
  /** Names of the sub-team's still-running members. */
  liveMembers: string[]
  /** Why the previous lead's runner ended, when a record stands. */
  failureReason?: string
  /** When the failure was detected, when a record stands. */
  detectedAt?: number
}

/** The one non-terminal teammate task carrying `agentId`, if any. */
function hasLiveTaskFor(tasks: AppState['tasks'], agentId: string): boolean {
  for (const task of Object.values(tasks)) {
    if (task.type !== 'in_process_teammate') continue
    if (task.identity.agentId !== agentId) continue
    if (isTerminalTaskStatus(task.status)) continue
    return true
  }
  return false
}

/** Names of the still-running members of `teamName`. */
function liveMemberNames(
  tasks: AppState['tasks'],
  teamName: string,
): string[] {
  const names: string[] = []
  for (const task of Object.values(tasks)) {
    if (task.type !== 'in_process_teammate') continue
    if (task.identity.teamName !== teamName) continue
    if (isTerminalTaskStatus(task.status)) continue
    names.push(task.identity.agentName)
  }
  return names
}

/**
 * The state of the sub-team `teamFile` describes.
 *
 * A name that is not a sub-team has no lead to lose, so it reports `led`;
 * callers reach this only for teams they already found by `parentTeam`.
 */
export function classifySubTeamState(
  teamFile: Pick<TeamFile, 'name' | 'parentAgentId' | 'orphanedLead'>,
  tasks: AppState['tasks'],
): SubTeamState {
  const naturalLeadAgentId = getNaturalSubLeadAgentId(teamFile.name)
  if (naturalLeadAgentId === undefined) return 'led'
  if (teamFile.parentAgentId !== naturalLeadAgentId) return 'adopted'
  if (teamFile.orphanedLead === undefined) return 'led'
  return hasLiveTaskFor(tasks, naturalLeadAgentId) ? 'respawning' : 'orphaned'
}

/** The {@link SubTeamRecoveryInfo} for one already-read sub-team file. */
function buildRecoveryInfo(
  teamFile: TeamFile,
  tasks: AppState['tasks'],
  naturalLeadAgentId: string,
): SubTeamRecoveryInfo {
  return {
    teamName: teamFile.name,
    state: classifySubTeamState(teamFile, tasks),
    leadAgentId: teamFile.parentAgentId,
    naturalLeadAgentId,
    hasLiveLead: hasLiveTaskFor(tasks, naturalLeadAgentId),
    liveMembers: liveMemberNames(tasks, teamFile.name),
    ...(teamFile.orphanedLead
      ? {
          failureReason: teamFile.orphanedLead.reason,
          detectedAt: teamFile.orphanedLead.detectedAt,
        }
      : {}),
  }
}

/**
 * The recovery state of ONE sub-team, or null when the name does not describe
 * a real sub-team on disk. The `name` check is the squatter guard: team
 * directories are one sanitized segment, so `email/supervisor` and a root team
 * literally named `email-supervisor` share a `config.json`.
 */
export async function readSubTeamRecoveryInfo(
  subTeamName: string,
  tasks: AppState['tasks'],
): Promise<SubTeamRecoveryInfo | null> {
  const naturalLeadAgentId = getNaturalSubLeadAgentId(subTeamName)
  if (naturalLeadAgentId === undefined) return null
  const teamFile = await readTeamFileAsync(subTeamName)
  if (!teamFile || teamFile.name !== subTeamName) return null
  return buildRecoveryInfo(teamFile, tasks, naturalLeadAgentId)
}

/**
 * The recovery state of every sub-team below `teamName`, deepest first.
 *
 * Found by `collectDescendantTeamNames`, which is a roster-BLIND disk scan of
 * recorded `parentTeam` links — the only way to find a sub-team whose lead is
 * on no roster and in no task list, which is precisely what an orphan is.
 */
export async function collectSubTeamRecoveryInfo(
  teamName: string,
  tasks: AppState['tasks'],
): Promise<SubTeamRecoveryInfo[]> {
  const infos: SubTeamRecoveryInfo[] = []
  for (const descendant of await collectDescendantTeamNames(teamName)) {
    const info = await readSubTeamRecoveryInfo(descendant, tasks)
    if (info) infos.push(info)
  }
  return infos
}

/**
 * The team whose `team-lead` inbox a member of `teamName` should report into.
 *
 * `teamName` itself in every state that existed before recovery: a root-team
 * teammate returns immediately without touching the disk, and a sub-team
 * member's own sub-lead is the reader as before. Only an ADOPTED sub-team
 * redirects, to the caretaker's team — so an adopted member's idle, failure
 * and shutdown notifications land in the inbox the lead of the parent team
 * already polls instead of the one its dead sub-lead used to.
 *
 * Conservative by construction: it redirects only when `parentAgentId` names a
 * `team-lead`, which is the only thing an adopt ever writes.
 */
export async function resolveUpwardInboxTeam(
  teamName: string,
): Promise<string> {
  if (getParentTeamName(teamName) === undefined) return teamName
  const naturalLeadAgentId = getNaturalSubLeadAgentId(teamName)
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile || teamFile.name !== teamName) return teamName
  const recordedLead = teamFile.parentAgentId
  if (!recordedLead || recordedLead === naturalLeadAgentId) return teamName
  const parsed = parseAgentId(recordedLead)
  if (!parsed || parsed.agentName !== TEAM_LEAD_NAME) return teamName
  return parsed.teamName
}

/**
 * Records that the teammate leading `subTeamName` died, on the sub-team's own
 * team file. Additive: `parentTeam` and `parentAgentId` are left exactly as
 * they were, so the sub-team stays inside its parent's sub-tree for teardown
 * and its natural lead is still the only agent that could lead it.
 */
async function writeOrphanRecord(
  subTeamName: string,
  record: OrphanedLeadRecord,
): Promise<boolean> {
  const teamFile = await readTeamFileAsync(subTeamName)
  if (!teamFile || teamFile.name !== subTeamName) return false
  await writeTeamFileAsync(subTeamName, { ...teamFile, orphanedLead: record })
  return true
}

/** The message the orphan notification carries into the lead's inbox. */
export function formatOrphanNotification(
  info: Pick<SubTeamRecoveryInfo, 'teamName' | 'liveMembers'>,
  failedLeadAgentId: string,
  reason: string,
): string {
  const members =
    info.liveMembers.length > 0
      ? info.liveMembers.join(', ')
      : 'no running members'
  return (
    `Sub-team "${info.teamName}" is orphaned: its lead ${failedLeadAgentId} ended abnormally (${reason}). ` +
    `Still running: ${members}. Their reports are reaching nobody until you recover the team — ` +
    `RecoverTeam with action "respawn" to resume the sub-lead from its transcript and re-attach the ` +
    `sub-team, or action "adopt" to take its members' reports into this inbox until a new sub-lead exists.`
  )
}

/**
 * Detection, called from the runner's terminal failure path.
 *
 * Confirms with `readSubTeamLedBy`'s contract — the recorded name AND the
 * recorded parent must match, or a root team squatting the same sanitized
 * directory would be mistaken for this teammate's sub-team — then records the
 * orphan and tells the lead of the team the dead teammate belonged to, which
 * is the parent team of the sub-team and therefore the inbox a recovery would
 * redirect to.
 *
 * Best-effort by design: a teammate that led no sub-team does nothing at all,
 * and a failure to write or notify is logged rather than thrown, because this
 * runs on a path that is already handling one error.
 *
 * @returns true when a sub-team was recorded as orphaned.
 */
export async function noteSubLeadFailure(params: {
  identity: { agentId: string; agentName: string; teamName: string }
  /** Per-turn transcript id of the turn that threw, when there was one. */
  turnAgentId?: string
  /** The runner's error message. */
  reason: string
  tasks: AppState['tasks']
}): Promise<boolean> {
  const { identity, turnAgentId, reason, tasks } = params
  try {
    const subTeamName = `${identity.teamName}/${identity.agentName}`
    const teamFile = await readTeamFileAsync(subTeamName)
    if (
      !teamFile ||
      teamFile.name !== subTeamName ||
      teamFile.parentAgentId !== identity.agentId
    ) {
      return false
    }

    const recorded = await writeOrphanRecord(subTeamName, {
      agentId: identity.agentId,
      ...(turnAgentId ? { turnAgentId } : {}),
      reason,
      detectedAt: Date.now(),
    })
    if (!recorded) return false

    const liveMembers = liveMemberNames(tasks, subTeamName)
    logForDebugging(
      `[subTeamRecovery] ${identity.agentId} failed leading ${subTeamName}; ${liveMembers.length} member(s) still running (${liveMembers.join(', ') || 'none'})`,
    )
    await writeToMailbox(
      TEAM_LEAD_NAME,
      {
        from: identity.agentName,
        text: formatOrphanNotification(
          { teamName: subTeamName, liveMembers },
          identity.agentId,
          reason,
        ),
        timestamp: new Date().toISOString(),
      },
      identity.teamName,
    )
    return true
  } catch (err) {
    logForDebugging(
      `[subTeamRecovery] Failed to record the orphaned sub-team of ${identity.agentId}: ${errorMessage(err)}`,
    )
    return false
  }
}

/**
 * Hands an orphaned sub-team to the lead of its parent team: `parentAgentId`
 * becomes `team-lead@<parentTeam>`, which is what
 * {@link resolveUpwardInboxTeam} then reads to send the members' reports
 * there. For a depth-2 sub-team that lead is the root lead; for a deeper one it
 * is the sub-lead above, whose runner polls exactly that inbox — one rule at
 * both depths.
 *
 * The failure record is deliberately KEPT: an adopted sub-team has a caretaker,
 * not a lead, and the record is how a later respawn still finds the transcript.
 */
export async function adoptOrphanedSubTeam(
  subTeamName: string,
): Promise<SubTeamReattachResult> {
  const parentTeam = getParentTeamName(subTeamName)
  if (parentTeam === undefined) {
    return { ok: false, subTeamName, reason: 'not-a-sub-team' }
  }
  return reattachSubTeamToLead(
    subTeamName,
    formatAgentId(TEAM_LEAD_NAME, parentTeam),
  )
}

/**
 * Tells the still-running members of a just-adopted sub-team who reads their
 * reports now. Best-effort: a member that never reads its inbox again loses
 * nothing, and one failed write must not fail the adoption.
 */
export async function notifyAdoptedMembers(
  subTeamName: string,
  adopterAgentId: string,
  tasks: AppState['tasks'],
): Promise<string[]> {
  const members = liveMemberNames(tasks, subTeamName)
  const text =
    `Your sub-lead is gone and "${subTeamName}" has been adopted by ${adopterAgentId}. ` +
    `Keep working from the same task list; your reports now reach ${adopterAgentId} directly.`
  const results = await Promise.allSettled(
    members.map(name =>
      writeToMailbox(
        name,
        {
          from: TEAM_LEAD_NAME,
          text,
          timestamp: new Date().toISOString(),
        },
        subTeamName,
      ),
    ),
  )
  const notified = members.filter((_, i) => results[i]?.status === 'fulfilled')
  if (notified.length !== members.length) {
    logForDebugging(
      `[subTeamRecovery] Notified ${notified.length}/${members.length} member(s) of the adoption of ${subTeamName}`,
    )
  }
  return notified
}
