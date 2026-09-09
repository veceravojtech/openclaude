import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type CallerIdentityContext,
  resolveCallerIdentity,
} from '../../utils/agentIdentity.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { readSubTeamLedBy } from '../../utils/swarm/teamHelpers.js'
import {
  createTask,
  deleteTask,
  ensureTasksDir,
  getSubTeamTaskListId,
  getTaskListId,
  isTodoV2Enabled,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

/**
 * The task list this TaskCreate writes into.
 *
 * A teammate that leads a sub-team creates work FOR that sub-team, not for the
 * team it is itself a member of. `getTaskListId()` returns an in-process
 * teammate's own team — the PARENT team, where the sub-lead is an ordinary
 * member — so without this the sub-lead's tasks would land in the list its own
 * peers claim from and its children, which claim from the sub-team's list,
 * would never see them.
 *
 * Resolved through `resolveCallerIdentity` so that a subagent running inside
 * the sub-lead's turn keeps the ordinary list: the teammate leads the sub-team,
 * the subagent does not.
 *
 * TeamCreate's sub-team branch deliberately skips the lead-only
 * `ensureTasksDir`, so the sub-team's directory is created here, on first write.
 */
async function resolveTaskCreateListId(
  context: CallerIdentityContext,
): Promise<string> {
  const subTeam = await readSubTeamLedBy(resolveCallerIdentity(context))
  if (!subTeam) {
    return getTaskListId()
  }
  const taskListId = getSubTeamTaskListId(subTeam.name)
  await ensureTasksDir(taskListId)
  return taskListId
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a task in the task list',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskCreate'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.subject
  },
  renderToolUseMessage() {
    return null
  },
  async call({ subject, description, activeForm, metadata }, context) {
    const taskListId = await resolveTaskCreateListId(context)
    const taskId = await createTask(taskListId, {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    const blockingErrors: string[] = []
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),
      getTeamName(),
      undefined,
      context?.abortController?.signal,
      undefined,
      context,
    )
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    if (blockingErrors.length > 0) {
      await deleteTask(taskListId, taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // Auto-expand task list when creating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
