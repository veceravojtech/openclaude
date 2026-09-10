/**
 * Respawning a dead sub-lead from its transcript, then re-attaching its
 * sub-team — the other half of `subTeamRecovery.ts`.
 *
 * It lives in its own module because it has to spawn a teammate, and the
 * runner imports `subTeamRecovery.ts` for its detection: keeping the spawn
 * imports here is what stops an import cycle through `inProcessRunner.ts`.
 *
 * The `resumeAgentBackground` pattern is followed, not the function itself
 * (`src/tools/AgentTool/resumeAgent.ts:46`). That function registers a
 * LocalAgentTask background agent, which carries no `TeammateIdentity`, polls
 * no sub-team inbox and claims from no task list — it could not lead anything.
 * What is reused is its transcript half: read the transcript for the agent id,
 * put it through the same three filters in the same order, and hand it to the
 * new run as prior context. The run itself goes through the real teammate
 * path, so the respawned lead comes back as the same `name@team` it was.
 */

import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getTeammateSpawnCapError } from '../../tools/AgentTool/teammateReplicas.js'
import { toAgentId } from '../../types/ids.js'
import { parseAgentId } from '../agentId.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../messages.js'
import { getAgentTranscript } from '../sessionStorage.js'
import { startInProcessTeammate } from './inProcessRunner.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import {
  getNaturalSubLeadAgentId,
  getParentTeamName,
  readTeamFileAsync,
  reattachSubTeamToLead,
  type SubTeamReattachResult,
  type TeamFile,
} from './teamHelpers.js'

export type RespawnSubLeadResult =
  | {
      ok: true
      subTeamName: string
      /** The respawned lead's id — the same `name@team` as the dead one. */
      leadAgentId: string
      /** AppState task id of the new teammate. */
      taskId: string
      /** False when no transcript could be read: a cold respawn. */
      resumedFromTranscript: boolean
      resumedMessageCount: number
      /** The on-disk transition that ended the respawn. */
      reattach: SubTeamReattachResult
    }
  | { ok: false; subTeamName: string; reason: string }

/**
 * The dead sub-lead's conversation, filtered exactly as a resumed background
 * agent's is (`resumeAgent.ts:73-79`): unresolved tool uses dropped first, so
 * the new run never opens with a `tool_use` that has no result, then orphaned
 * thinking-only and whitespace-only assistant turns.
 *
 * Empty on anything unreadable. A sub-team with live members is worth
 * recovering with or without its history, so a missing transcript downgrades
 * the respawn to cold rather than failing it.
 */
export async function loadSubLeadResumeMessages(
  turnAgentId: string | undefined,
): Promise<Message[]> {
  if (!turnAgentId) return []
  const agentId = toAgentId(turnAgentId)
  if (!agentId) return []
  try {
    const transcript = await getAgentTranscript(agentId)
    if (!transcript) return []
    return filterWhitespaceOnlyAssistantMessages(
      filterOrphanedThinkingOnlyMessages(
        filterUnresolvedToolUses(transcript.messages),
      ),
    )
  } catch (err) {
    logForDebugging(
      `[respawnSubLead] Could not read the transcript ${turnAgentId}: ${errorMessage(err)}`,
    )
    return []
  }
}

/** The prompt a resumed sub-lead opens on when the caller supplies none. */
export function defaultRespawnPrompt(
  subTeamName: string,
  reason: string | undefined,
): string {
  return (
    `You are being resumed: your previous run ended abnormally${reason ? ` (${reason})` : ''}. ` +
    `Your sub-team "${subTeamName}" was kept intact and its members went on working while you were gone. ` +
    `Take stock before doing anything else — read your sub-team's task list and your inbox, work out where ` +
    `each member got to, and carry on coordinating from there.`
  )
}

/**
 * How the dead lead was spawned, read back from the PARENT team's roster.
 *
 * The roster entry survives a crash: the failure path never calls
 * `removeMemberByAgentId` (only the kill and idle-retire paths do), so this is
 * the durable record of the lead's model, colour and mode. A missing entry is
 * not fatal — identity is derived, not looked up, and the entry only feeds
 * discovery — so the respawn falls back to plain defaults.
 */
function readLeadSpawnRecord(
  parentTeamFile: TeamFile | null,
  leadAgentId: string,
): TeamFile['members'][number] | undefined {
  return parentTeamFile?.members.find(m => m.agentId === leadAgentId)
}

/**
 * Respawns the sub-lead of `subTeamName` and re-attaches the sub-team to it.
 *
 * Because agent ids are deterministic (`formatAgentId`), the respawned lead IS
 * the id the sub-team already records: same inbox, same sub-team name, same
 * task list, same pill, same place in the spinner tree. The re-attach is the
 * LAST step, which is what makes the window before it the `respawning` state
 * and what restores `readSubTeamLedBy` — and with it the dual-inbox poll and
 * the kill cascade — in one write.
 */
export async function respawnSubLead(params: {
  subTeamName: string
  toolUseContext: ToolUseContext
  /** First prompt for the resumed lead; a recovery briefing by default. */
  prompt?: string
}): Promise<RespawnSubLeadResult> {
  const { subTeamName, toolUseContext } = params
  const parentTeam = getParentTeamName(subTeamName)
  const leadAgentId = getNaturalSubLeadAgentId(subTeamName)
  if (parentTeam === undefined || leadAgentId === undefined) {
    return { ok: false, subTeamName, reason: `"${subTeamName}" is not a sub-team.` }
  }
  const leadName = parseAgentId(leadAgentId)?.agentName
  if (!leadName) {
    return { ok: false, subTeamName, reason: `Cannot derive a lead name for "${subTeamName}".` }
  }

  const subTeamFile = await readTeamFileAsync(subTeamName)
  if (!subTeamFile || subTeamFile.name !== subTeamName) {
    return {
      ok: false,
      subTeamName,
      reason: `No sub-team "${subTeamName}" on disk (a root team may occupy its directory).`,
    }
  }

  const appState = toolUseContext.getAppState()
  const capError = getTeammateSpawnCapError({
    isTeammateSpawn: true,
    teamName: parentTeam,
    tasks: appState.tasks,
  })
  if (capError) return { ok: false, subTeamName, reason: capError }

  const spawnRecord = readLeadSpawnRecord(
    await readTeamFileAsync(parentTeam),
    leadAgentId,
  )
  const resumedMessages = await loadSubLeadResumeMessages(
    subTeamFile.orphanedLead?.turnAgentId,
  )
  const prompt =
    params.prompt ??
    defaultRespawnPrompt(subTeamName, subTeamFile.orphanedLead?.reason)

  const spawn = await spawnInProcessTeammate(
    {
      name: leadName,
      teamName: parentTeam,
      prompt,
      color: spawnRecord?.color,
      planModeRequired: spawnRecord?.planModeRequired ?? false,
      model: spawnRecord?.model,
    },
    { setAppState: toolUseContext.setAppState },
  )
  if (
    !spawn.success ||
    !spawn.taskId ||
    !spawn.teammateContext ||
    !spawn.abortController
  ) {
    return {
      ok: false,
      subTeamName,
      reason: spawn.error ?? `Failed to respawn ${leadAgentId}.`,
    }
  }

  startInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: leadName,
      teamName: parentTeam,
      color: spawnRecord?.color,
      planModeRequired: spawnRecord?.planModeRequired ?? false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    prompt,
    description: `resumed sub-lead of ${subTeamName}`,
    model: spawnRecord?.model,
    teammateContext: spawn.teammateContext,
    // Same reason the ordinary spawn path strips them: the teammate builds its
    // own history, and the parent's conversation would be pinned for its whole
    // lifetime.
    toolUseContext: { ...toolUseContext, messages: [] },
    abortController: spawn.abortController,
    ...(resumedMessages.length > 0 ? { resumedMessages } : {}),
  })

  const reattach = await reattachSubTeamToLead(subTeamName, leadAgentId)
  logForDebugging(
    `[respawnSubLead] Respawned ${leadAgentId} for ${subTeamName} with ${resumedMessages.length} resumed message(s); re-attach ok=${reattach.ok}`,
  )

  return {
    ok: true,
    subTeamName,
    leadAgentId: spawn.agentId,
    taskId: spawn.taskId,
    resumedFromTranscript: resumedMessages.length > 0,
    resumedMessageCount: resumedMessages.length,
    reattach,
  }
}
