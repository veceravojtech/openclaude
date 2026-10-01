import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  executeTaskCompletedHooks,
  getTaskCompletedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  blockTask,
  cancelTask,
  deleteTask,
  getTask,
  getTaskListId,
  getTasksDir,
  isTodoV2Enabled,
  listTasks,
  TaskCancelError,
  type TaskStatus,
  TaskStatusSchema,
  TaskTransitionError,
  updateTask,
} from '../../utils/tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../../utils/teammate.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import {
  checkCompletionGatesIn,
  FinalReviewGateError,
} from '../../utils/finalReviewStore.js'
import { VerificationGateError } from '../../utils/verificationVerdictStore.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => {
  // Extended status schema that includes 'deleted' as a special action
  const TaskUpdateStatusSchema = TaskStatusSchema().or(z.literal('deleted'))

  return z.strictObject({
    taskId: z.string().describe('The ID of the task to update'),
    subject: z.string().optional().describe('New subject for the task'),
    description: z.string().optional().describe('New description for the task'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    status: TaskUpdateStatusSchema.optional().describe(
      'New status for the task',
    ),
    supersededBy: z
      .string()
      .optional()
      .describe(
        'Only with status "cancelled": the ID of the task that replaces this one. Tasks waiting on this task will wait on the replacement instead.',
      ),
    addBlocks: z
      .array(z.string())
      .optional()
      .describe('Task IDs that this task blocks'),
    addBlockedBy: z
      .array(z.string())
      .optional()
      .describe('Task IDs that block this task'),
    owner: z.string().optional().describe('New owner for the task'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Metadata keys to merge into the task. Set a key to null to delete it.',
      ),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    taskId: z.string(),
    updatedFields: z.array(z.string()),
    error: z.string().optional(),
    statusChange: z
      .object({
        from: z.string(),
        to: z.string(),
      })
      .optional(),
    verificationNudgeNeeded: z.boolean().optional(),
    /** The update was saved, but the new owner's inbox write failed. */
    ownerNotificationError: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  searchHint: 'update a task',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskUpdate'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    const parts = [input.taskId]
    if (input.status) parts.push(input.status)
    if (input.subject) parts.push(input.subject)
    return parts.join(' ')
  },
  renderToolUseMessage() {
    return null
  },
  async call(
    {
      taskId,
      subject,
      description,
      activeForm,
      status,
      supersededBy,
      owner,
      addBlocks,
      addBlockedBy,
      metadata,
    },
    context,
  ) {
    const taskListId = getTaskListId()

    // Auto-expand task list when updating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    // Check if task exists
    const existingTask = await getTask(taskListId, taskId)
    if (!existingTask) {
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: 'Task not found',
        },
      }
    }

    const fail = (error: string) => ({
      data: {
        success: false,
        taskId,
        updatedFields: [] as string[],
        error,
      },
    })

    if (supersededBy !== undefined && status !== 'cancelled') {
      return fail(
        'supersededBy can only be set together with status "cancelled"',
      )
    }
    if (
      status === 'cancelled' &&
      (owner !== undefined ||
        (addBlocks?.length ?? 0) > 0 ||
        (addBlockedBy?.length ?? 0) > 0)
    ) {
      return fail(
        'A task being cancelled cannot be given an owner or new dependencies in the same update',
      )
    }
    if (
      existingTask.status === 'cancelled' &&
      status !== undefined &&
      status !== 'cancelled' &&
      status !== 'deleted'
    ) {
      return fail(
        `Task #${taskId} is cancelled and cannot be moved to '${status}'. Cancelled is final: create a new task for the work instead.`,
      )
    }

    const updatedFields: string[] = []
    // Set when this call cancelled the task via cancelTask (which writes the
    // status itself, so it is not part of `updates`).
    let cancelledTo: TaskStatus | undefined

    // Update basic fields if provided and different from current value
    const updates: {
      subject?: string
      description?: string
      activeForm?: string
      status?: TaskStatus
      owner?: string
      metadata?: Record<string, unknown>
    } = {}
    if (subject !== undefined && subject !== existingTask.subject) {
      updates.subject = subject
      updatedFields.push('subject')
    }
    if (description !== undefined && description !== existingTask.description) {
      updates.description = description
      updatedFields.push('description')
    }
    if (activeForm !== undefined && activeForm !== existingTask.activeForm) {
      updates.activeForm = activeForm
      updatedFields.push('activeForm')
    }
    if (owner !== undefined && owner !== existingTask.owner) {
      updates.owner = owner
      updatedFields.push('owner')
    }
    // Auto-set owner when a teammate marks a task as in_progress without
    // explicitly providing an owner. This ensures the task list can match
    // todo items to teammates for showing activity status.
    if (
      isAgentSwarmsEnabled() &&
      status === 'in_progress' &&
      owner === undefined &&
      !existingTask.owner
    ) {
      const agentName = getAgentName()
      if (agentName) {
        updates.owner = agentName
        updatedFields.push('owner')
      }
    }
    if (metadata !== undefined) {
      const merged = { ...(existingTask.metadata ?? {}) }
      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }
      updates.metadata = merged
      updatedFields.push('metadata')
    }
    if (status !== undefined) {
      // Handle deletion - delete the task file and return early
      if (status === 'deleted') {
        const deleted = await deleteTask(taskListId, taskId)
        return {
          data: {
            success: deleted,
            taskId,
            updatedFields: deleted ? ['deleted'] : [],
            error: deleted ? undefined : 'Failed to delete task',
            statusChange: deleted
              ? { from: existingTask.status, to: 'deleted' }
              : undefined,
          },
        }
      }

      // Cancel / supersede: a list-level operation that also rewrites the
      // dependencies of other tasks, so it goes through cancelTask rather
      // than a plain status write. It is not a completion, so neither the
      // verification gate nor TaskCompleted hooks apply.
      if (status === 'cancelled') {
        try {
          await cancelTask(taskListId, taskId, { supersededBy })
        } catch (error) {
          if (error instanceof TaskCancelError) {
            return fail(error.message)
          }
          throw error
        }
        cancelledTo = 'cancelled'
        updatedFields.push('status')
        if (supersededBy !== undefined) {
          updatedFields.push('supersededBy')
        }
      } else if (status !== existingTask.status) {
        // For regular status updates, validate and apply if different
        // Completion gates (opt-in): a task flagged requiresVerification can
        // only complete when metadata.verifiedBy names a verifier whose
        // recorded verdict is PASS, and one flagged requiresFinalReview only
        // when metadata.finalReviewedBy names a final reviewer that recorded
        // DONE and no GAP task filed against it is open. This early check
        // gives a fast answer before TaskCompleted hooks run; updateTask
        // re-checks under the task lock and is the authority.
        if (status === 'completed') {
          const gateError = await checkCompletionGatesIn(
            getTasksDir(taskListId),
            existingTask.metadata,
            updates.metadata ?? existingTask.metadata,
          )
          if (gateError) {
            return {
              data: {
                success: false,
                taskId,
                updatedFields: [],
                error: gateError.message,
              },
            }
          }
        }

        // Run TaskCompleted hooks when marking a task as completed
        if (status === 'completed') {
          const blockingErrors: string[] = []

          const generator = executeTaskCompletedHooks(
            taskId,
            existingTask.subject,
            existingTask.description,
            getAgentName(),
            getTeamName(),
            undefined,
            context?.abortController?.signal,
            undefined,
            context,
          )

          for await (const result of generator) {
            if (result.blockingError) {
              blockingErrors.push(
                getTaskCompletedHookMessage(result.blockingError),
              )
            }
          }

          if (blockingErrors.length > 0) {
            return {
              data: {
                success: false,
                taskId,
                updatedFields: [],
                error: blockingErrors.join('\n'),
              },
            }
          }
        }

        updates.status = status
        updatedFields.push('status')
      }
    }

    if (Object.keys(updates).length > 0) {
      try {
        await updateTask(taskListId, taskId, updates)
      } catch (error) {
        // The locked write re-checks the completion gates against the
        // current task, so a flag added since our read still blocks it.
        if (
          error instanceof VerificationGateError ||
          error instanceof FinalReviewGateError ||
          error instanceof TaskTransitionError
        ) {
          return {
            data: {
              success: false,
              taskId,
              updatedFields: [],
              error: error.message,
            },
          }
        }
        throw error
      }
    }

    // Notify new owner via mailbox when ownership changes. The update above is
    // already saved, so a failed notification does not fail the tool; it is
    // reported in the result instead, so the caller can tell the owner itself.
    let ownerNotificationError: string | undefined
    if (updates.owner && isAgentSwarmsEnabled()) {
      const senderName = getAgentName() || 'team-lead'
      const senderColor = getTeammateColor()
      const assignmentMessage = JSON.stringify({
        type: 'task_assignment',
        taskId,
        subject: existingTask.subject,
        description: existingTask.description,
        assignedBy: senderName,
        timestamp: new Date().toISOString(),
      })
      try {
        await writeToMailbox(
          updates.owner,
          {
            from: senderName,
            text: assignmentMessage,
            timestamp: new Date().toISOString(),
            color: senderColor,
          },
          taskListId,
        )
      } catch (error) {
        ownerNotificationError = errorMessage(error)
        logForDebugging(
          `[TaskUpdateTool] Failed to notify ${updates.owner} of task #${taskId}: ${ownerNotificationError}`,
        )
      }
    }

    // Add blocks if provided and not already present
    if (addBlocks && addBlocks.length > 0) {
      const newBlocks = addBlocks.filter(
        id => !existingTask.blocks.includes(id),
      )
      for (const blockId of newBlocks) {
        await blockTask(taskListId, taskId, blockId)
      }
      if (newBlocks.length > 0) {
        updatedFields.push('blocks')
      }
    }

    // Add blockedBy if provided and not already present (reverse: the blocker blocks this task)
    if (addBlockedBy && addBlockedBy.length > 0) {
      const newBlockedBy = addBlockedBy.filter(
        id => !existingTask.blockedBy.includes(id),
      )
      for (const blockerId of newBlockedBy) {
        await blockTask(taskListId, blockerId, taskId)
      }
      if (newBlockedBy.length > 0) {
        updatedFields.push('blockedBy')
      }
    }

    // Structural verification nudge: if the main-thread agent just closed
    // out a 3+ task list and none of those tasks was a verification step,
    // append a reminder to the tool result. Fires at the loop-exit moment
    // where skips happen ("when the last task closed, the loop exited").
    // Mirrors the TodoWriteTool nudge for V1 sessions; this covers V2
    // (interactive CLI). TaskUpdateToolOutput is @internal so this field
    // does not touch the public SDK surface.
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      updates.status === 'completed'
    ) {
      const allTasks = await listTasks(taskListId)
      // Cancelled tasks are closed but were never done: they do not block
      // "all done", yet they neither count toward the 3+ threshold nor
      // stand in for a verification step.
      const completedTasks = allTasks.filter(t => t.status === 'completed')
      const allDone = allTasks.every(
        t => t.status === 'completed' || t.status === 'cancelled',
      )
      if (
        allDone &&
        completedTasks.length >= 3 &&
        !completedTasks.some(t => /verif/i.test(t.subject))
      ) {
        verificationNudgeNeeded = true
      }
    }

    return {
      data: {
        success: true,
        taskId,
        updatedFields,
        statusChange:
          (cancelledTo ?? updates.status) !== undefined
            ? {
                from: existingTask.status,
                to: (cancelledTo ?? updates.status)!,
              }
            : undefined,
        verificationNudgeNeeded,
        ...(ownerNotificationError !== undefined
          ? { ownerNotificationError }
          : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      success,
      taskId,
      updatedFields,
      error,
      statusChange,
      verificationNudgeNeeded,
      ownerNotificationError,
    } = content as Output
    if (!success) {
      // Return as non-error so it doesn't trigger sibling tool cancellation
      // in StreamingToolExecutor. "Task not found" is a benign condition
      // (e.g., task list already cleaned up) that the model can handle.
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error || `Task #${taskId} not found`,
      }
    }

    let resultContent = `Updated task #${taskId} ${updatedFields.join(', ')}`

    // Add reminder for teammates when they complete a task (supports in-process teammates)
    if (
      statusChange?.to === 'completed' &&
      getAgentId() &&
      isAgentSwarmsEnabled()
    ) {
      resultContent +=
        '\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.'
    }

    if (ownerNotificationError !== undefined) {
      resultContent += `\n\nWARNING: the assignment message to the new owner was NOT delivered (${ownerNotificationError}). Tell them with SendMessage.`
    }

    if (verificationNudgeNeeded) {
      resultContent += `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: resultContent,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
