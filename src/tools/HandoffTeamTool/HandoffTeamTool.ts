import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { resolveCallerIdentity } from '../../utils/agentIdentity.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { requestAbort } from '../../utils/interruptionTrace.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  armSubLeadHandoff,
  liveSubTeamMemberNames,
  writeSubLeadHandoffFile,
} from '../../utils/swarm/subLeadHandoff.js'
import {
  getParentTeamName,
  readSubTeamLedBy,
} from '../../utils/swarm/teamHelpers.js'
import { getSubTeamTaskListId } from '../../utils/tasks.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { HANDOFF_TEAM_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    synthesis: z
      .string()
      .min(1)
      .describe(
        'What you have established so far, written for a successor who has none of your ' +
          'context: what the work is, what is decided and why, what is settled and what is not.',
      ),
    open_items: z
      .array(z.string())
      .optional()
      .describe('The work still outstanding, one line each.'),
    first_instruction: z
      .string()
      .optional()
      .describe(
        'What the successor should do first, beyond reading the handoff notes.',
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'Why you are handing over, e.g. "context nearly full". Reported to your lead.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  message: string
  /** The sub-team handed over. */
  team_name: string
  /** The successor's id — the same as the caller's: a handoff keeps identity. */
  successor_agent_id: string
  /** Absolute path of the handoff notes the successor opens on. */
  handoff_path: string
  /** The sub-team members that keep running through the handoff. */
  members: string[]
}

export type Input = z.infer<InputSchema>

type CallContext = Parameters<NonNullable<Tool<InputSchema, Output>['call']>>[1]

/**
 * The task list the CALLING teammate claims its own work from, mirroring
 * `resolveTeammateTaskListId` in the runner: the sub-team's own list for a
 * member of a sub-team, the lead's session-keyed list for everyone else.
 * Undefined outside an in-process teammate, where there is no such list to
 * read — only an in-process teammate reaches this tool at all.
 */
function ownTaskListId(): string | undefined {
  const teammate = getTeammateContext()
  if (!teammate) return undefined
  return getParentTeamName(teammate.teamName) !== undefined
    ? getSubTeamTaskListId(teammate.teamName)
    : teammate.parentSessionId
}

/**
 * Hands the caller's own sub-team to a fresh successor — the explicit half of
 * U10, beside the `TeammateIdleTimeout` hook's `handoff` action.
 *
 * The authority rule is the absence of an argument: there is no `team_name`,
 * so the sub-team is whatever `resolveCallerIdentity` + `readSubTeamLedBy` say
 * the CALLER leads. A lead, a pane teammate and a background subagent running
 * inside a teammate's turn all lead nothing by that rule and are refused. Only
 * the sub-lead holds the context worth writing down, and only its own runner
 * can retire it as `completed` rather than `killed`.
 *
 * The tool itself never spawns and never tears anything down. It writes the
 * notes, arms the handoff, and aborts its own lifecycle controller — the way
 * an approved shutdown ends an in-process teammate today
 * (`SendMessageTool.ts:390`). The runner's completion tail then retires the
 * task and starts the successor, which is the only point at which the seat is
 * provably free.
 */
export const HandoffTeamTool: Tool<InputSchema, Output> = buildTool({
  name: HANDOFF_TEAM_TOOL_NAME,
  searchHint: 'hand your sub-team to a fresh successor and retire',
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

  isReadOnly() {
    return false
  },

  toAutoClassifierInput(input) {
    return input.reason ?? 'handoff'
  },

  async description() {
    return 'Hand the sub-team you lead to a fresh successor and retire'
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

  async call(input, context: CallContext) {
    const caller = resolveCallerIdentity(context)
    const subTeam = caller.isTeammate ? await readSubTeamLedBy(caller) : null
    if (!subTeam || !caller.agentId || !caller.name) {
      throw new Error(
        `${HANDOFF_TEAM_TOOL_NAME} hands over the sub-team you lead, and you lead none. A teammate leads a sub-team only after creating it with TeamCreate; a team lead cannot hand over on a sub-lead's behalf.`,
      )
    }

    // The runner's own task: its lifecycle controller is how this run ends,
    // and its absence means there is no in-process runner to retire.
    const ownTask = findTeammateTaskByAgentId(
      caller.agentId,
      context.getAppState().tasks,
    )
    if (
      !ownTask?.abortController ||
      isTerminalTaskStatus(ownTask.status)
    ) {
      throw new Error(
        `${HANDOFF_TEAM_TOOL_NAME} could not find the running task for ${caller.agentId}, so it cannot retire you. Only an in-process teammate can hand a sub-team over.`,
      )
    }

    const members = liveSubTeamMemberNames(
      context.getAppState().tasks,
      subTeam.name,
    )
    // The caller's OWN task list, resolved the way the runner's poll loop
    // resolves it: a sub-team member claims from the sub-team's list, everyone
    // else from the lead's session-keyed one. A sub-lead's work on that list
    // survives the handoff under the inherited name, so the notes name it.
    const taskListId = ownTaskListId()
    const handoffPath = await writeSubLeadHandoffFile({
      subTeamName: subTeam.name,
      leadAgentId: caller.agentId,
      source: 'tool',
      members,
      synthesis: input.synthesis,
      ...(input.open_items ? { openItems: input.open_items } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(taskListId
        ? { ownAssignments: { taskListId, owner: caller.name } }
        : {}),
    })
    armSubLeadHandoff({
      subTeamName: subTeam.name,
      leadAgentId: caller.agentId,
      handoffPath,
      source: 'tool',
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.first_instruction
        ? { firstInstruction: input.first_instruction }
        : {}),
    })

    // Ends this run. The successor is started by the completion tail, not
    // here: while this turn is still running, the seat is not free.
    requestAbort(ownTask.abortController, undefined, {
      source: 'sub_lead_handoff',
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-lifecycle',
      subagentId: caller.agentId,
    })

    return {
      data: {
        team_name: subTeam.name,
        successor_agent_id: caller.agentId,
        handoff_path: handoffPath,
        members,
        message:
          `Handing "${subTeam.name}" to a fresh successor with your identity (${caller.agentId}) and retiring now. ` +
          `Your notes are at ${handoffPath}; the successor opens on them. ` +
          `Its ${members.length} running member(s) keep their task list, their inboxes and their work.`,
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
