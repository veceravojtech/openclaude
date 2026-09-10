import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { resolveCallerIdentity } from '../../utils/agentIdentity.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { respawnSubLead } from '../../utils/swarm/respawnSubLead.js'
import {
  adoptOrphanedSubTeam,
  collectSubTeamRecoveryInfo,
  notifyAdoptedMembers,
  readSubTeamRecoveryInfo,
  type SubTeamState,
} from '../../utils/swarm/subTeamRecovery.js'
import {
  getParentTeamName,
  readSubTeamLedBy,
} from '../../utils/swarm/teamHelpers.js'
import { RECOVER_TEAM_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['list', 'adopt', 'respawn'])
      .describe(
        'list to report every sub-team below your own and its state; ' +
          'adopt to take an orphaned sub-team\'s members into your own inbox; ' +
          'respawn to resume its lead from its transcript and re-attach the sub-team.',
      ),
    team_name: z
      .string()
      .optional()
      .describe(
        'Full name of the sub-team to recover, e.g. "email/supervisor". Required for adopt and respawn.',
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        'respawn only: the first prompt for the resumed sub-lead. Defaults to a briefing that tells it to take stock of its sub-team and carry on.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type RecoveredSubTeam = {
  team_name: string
  state: SubTeamState
  /** Who the team file says leads it. */
  lead_agent_id?: string
  /** Whether a teammate carrying that identity is actually running. */
  has_live_lead: boolean
  live_members: string[]
  failure_reason?: string
}

export type Output = {
  action: 'list' | 'adopt' | 'respawn'
  message: string
  /** The team the caller leads, which is the scope of every action. */
  own_team?: string
  /** action:'list' — every sub-team below the caller's own team. */
  sub_teams?: RecoveredSubTeam[]
  /** adopt / respawn — the sub-team acted on. */
  team_name?: string
  state?: SubTeamState
  /** adopt: the caretaker. respawn: the resumed sub-lead. */
  lead_agent_id?: string
  /** adopt: members told their reports moved. */
  notified_members?: string[]
  /** respawn: whether a surviving transcript was resumed from. */
  resumed_from_transcript?: boolean
  resumed_message_count?: number
}

export type Input = z.infer<InputSchema>

/**
 * The team the caller leads, which bounds every action: a lead leads its own
 * team, and a teammate leads the one sub-team recorded for it. Answered only
 * through `resolveCallerIdentity` + `readSubTeamLedBy`, so a subagent running
 * inside a teammate's turn is never mistaken for the teammate.
 */
async function resolveOwnTeam(
  context: Parameters<NonNullable<Tool<InputSchema, Output>['call']>>[1],
): Promise<string | undefined> {
  const caller = resolveCallerIdentity(context)
  if (caller.isTeammate) {
    return (await readSubTeamLedBy(caller))?.name
  }
  return context.getAppState().teamContext?.teamName
}

export const RecoverTeamTool: Tool<InputSchema, Output> = buildTool({
  name: RECOVER_TEAM_TOOL_NAME,
  searchHint: 'adopt or respawn a sub-team whose lead died',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  isReadOnly(input: Input) {
    return input.action === 'list'
  },

  toAutoClassifierInput(input) {
    return `${input.action} ${input.team_name ?? ''}`.trim()
  },

  async description() {
    return 'Recover a sub-team whose lead died: adopt its members or respawn its lead'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(input, context) {
    const { action, team_name: requestedTeam, prompt } = input
    const ownTeam = await resolveOwnTeam(context)
    if (!ownTeam) {
      throw new Error(
        `${RECOVER_TEAM_TOOL_NAME} is called by the agent that leads a team: you lead none. A teammate leads a sub-team only after creating it with TeamCreate.`,
      )
    }

    const tasks = context.getAppState().tasks

    if (action === 'list') {
      const infos = await collectSubTeamRecoveryInfo(ownTeam, tasks)
      const orphaned = infos.filter(i => i.state === 'orphaned')
      return {
        data: {
          action,
          own_team: ownTeam,
          sub_teams: infos.map(info => ({
            team_name: info.teamName,
            state: info.state,
            lead_agent_id: info.leadAgentId,
            has_live_lead: info.hasLiveLead,
            live_members: info.liveMembers,
            failure_reason: info.failureReason,
          })),
          message:
            infos.length === 0
              ? `No sub-team hangs off "${ownTeam}".`
              : `${infos.length} sub-team(s) below "${ownTeam}", ${orphaned.length} orphaned.`,
        },
      }
    }

    const teamName = requestedTeam?.trim()
    if (!teamName) {
      throw new Error(
        `team_name is required for ${action}. Use action "list" to see which sub-teams hang off "${ownTeam}".`,
      )
    }
    // A lead recovers the sub-teams of its OWN team and no others: the
    // caretaker an adopt installs is the lead of the parent team, and a
    // respawned sub-lead is spawned INTO the parent team, so any other
    // caller would be acting on a team it is not part of.
    if (getParentTeamName(teamName) !== ownTeam) {
      throw new Error(
        `"${teamName}" is not a sub-team of "${ownTeam}". You can only recover a sub-team named "${ownTeam}/<teammate name>".`,
      )
    }

    const info = await readSubTeamRecoveryInfo(teamName, tasks)
    if (!info) {
      throw new Error(
        `No sub-team "${teamName}" was found on disk. It may already have been cleaned up, or a root team may occupy its directory.`,
      )
    }
    // Recovering a healthy sub-team would take it away from a lead that is
    // still working. An unled one is recoverable whether or not a failure was
    // recorded — a lead that stopped some other way leaves the same silence.
    if (info.hasLiveLead && info.state !== 'adopted') {
      throw new Error(
        `Sub-team "${teamName}" is still led by ${info.naturalLeadAgentId}, which is running. Nothing to recover.`,
      )
    }

    if (action === 'adopt') {
      const result = await adoptOrphanedSubTeam(teamName)
      if (!result.ok) {
        throw new Error(
          `Could not adopt "${teamName}": ${result.reason}.`,
        )
      }
      const notified = await notifyAdoptedMembers(
        teamName,
        result.newLeadAgentId,
        tasks,
      )
      return {
        data: {
          action,
          own_team: ownTeam,
          team_name: teamName,
          state: 'adopted' as const,
          lead_agent_id: result.newLeadAgentId,
          notified_members: notified,
          message:
            `Adopted "${teamName}". Its ${info.liveMembers.length} running member(s) keep their own task list, ` +
            `and their reports now arrive in your inbox instead of ${result.previousLeadAgentId ?? 'their dead lead'}. ` +
            `Respawn the sub-lead later to hand the team back.`,
        },
      }
    }

    const respawn = await respawnSubLead({
      subTeamName: teamName,
      toolUseContext: context,
      ...(prompt ? { prompt } : {}),
    })
    if (!respawn.ok) {
      throw new Error(`Could not respawn the lead of "${teamName}": ${respawn.reason}`)
    }
    const reattached = respawn.reattach.ok
    return {
      data: {
        action,
        own_team: ownTeam,
        team_name: teamName,
        // The re-attach is what clears the failure record, so a respawn that
        // could not write the team file leaves the sub-team `respawning`: its
        // lead is live again but the team still records the orphan.
        state: reattached ? ('led' as const) : ('respawning' as const),
        lead_agent_id: respawn.leadAgentId,
        resumed_from_transcript: respawn.resumedFromTranscript,
        resumed_message_count: respawn.resumedMessageCount,
        message:
          `Respawned ${respawn.leadAgentId} as the lead of "${teamName}"` +
          (respawn.resumedFromTranscript
            ? `, resumed from ${respawn.resumedMessageCount} message(s) of its previous run`
            : ' with no surviving transcript, so it starts cold') +
          (respawn.reattach.ok
            ? '. The sub-team is re-attached: it reads its own inbox and hands out its own task list again.'
            : `. WARNING: the sub-team could not be re-attached (${respawn.reattach.reason}) — check the team file.`),
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
