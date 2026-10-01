import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  ATTENTION_CHOICES,
  ATTENTION_ROOT_CAUSES,
  decideAttentionItem,
} from '../../utils/attentionItems.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isTeammate } from '../../utils/teammate.js'
import { ATTENTION_DECIDE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().min(1).describe('The attention item id'),
    decision: z
      .enum(ATTENTION_CHOICES as unknown as ['retry', 'patch', 'continue', 'abort'])
      .describe('retry (transient only), patch, continue or abort'),
    reason: z
      .string()
      .trim()
      .min(1, 'reason cannot be empty')
      .describe('Why you decided this'),
    root_cause: z
      .enum(
        ATTENTION_ROOT_CAUSES as unknown as [
          'scope',
          'spec',
          'method',
          'environment',
          'unknown',
        ],
      )
      .optional()
      .describe('The earliest wrong input; required for patch'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    decision: z.string(),
    released: z.array(z.string()),
    cancelled: z.array(z.string()),
    cancelErrors: z.array(z.string()),
    refiledGapTasks: z.array(z.string()),
    refileError: z.string().optional(),
    undecidedRemaining: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const LEAD_ONLY_ERROR = `${ATTENTION_DECIDE_TOOL_NAME} is for the root lead only: teammates and subagents report failures, the lead decides them.`

function renderResult(o: Output): string {
  const parts = [`Recorded ${o.decision} for ${o.id}.`]
  if (o.released.length) {
    parts.push(`Released held task(s): ${o.released.map(t => `#${t}`).join(', ')}.`)
  }
  if (o.cancelled.length) {
    parts.push(`Cancelled: ${o.cancelled.map(t => `#${t}`).join(', ')}.`)
  }
  if (o.cancelErrors.length) {
    parts.push(`Could not cancel: ${o.cancelErrors.join('; ')}.`)
  }
  if (o.refiledGapTasks.length) {
    parts.push(`GAP tasks: ${o.refiledGapTasks.map(t => `#${t}`).join(', ')}.`)
  }
  if (o.refileError) parts.push(`GAP tasks could NOT be re-filed: ${o.refileError}.`)
  if (o.decision === 'continue') {
    parts.push('This is an acceptance only: verification and final-review gates still apply.')
  }
  parts.push(
    o.undecidedRemaining === 0
      ? 'No undecided items remain; spawning is unblocked.'
      : `${o.undecidedRemaining} undecided item(s) remain; spawning stays blocked until each is decided.`,
  )
  return parts.join(' ')
}

export const AttentionDecideTool = buildTool({
  name: ATTENTION_DECIDE_TOOL_NAME,
  searchHint: 'decide a failed worker, verdict or review gap (retry, patch, continue, abort)',
  maxResultSizeChars: 20_000,
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
    return 'AttentionDecide'
  },
  // Not deferred: the reminder names this tool and spawning is blocked until
  // it is used, so it must be callable without a ToolSearch round.
  shouldDefer: false,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.decision} ${input.id}`
  },
  renderToolUseMessage(input) {
    return input.id && input.decision ? `${input.decision} ${input.id}` : null
  },
  async validateInput(input) {
    if (input.decision === 'patch' && !input.root_cause) {
      return {
        result: false,
        message:
          'A patch decision needs root_cause (scope, spec, method, environment or unknown): name the earliest wrong input you are fixing.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async call({ id, decision, reason, root_cause }, context) {
    if (context.agentId || isTeammate()) {
      throw new Error(LEAD_ONLY_ERROR)
    }
    const outcome = await decideAttentionItem(id, {
      choice: decision,
      reason,
      ...(root_cause ? { rootCause: root_cause } : {}),
    })
    return {
      data: {
        id,
        decision,
        released: outcome.released,
        cancelled: outcome.cancelled,
        cancelErrors: outcome.cancelErrors,
        refiledGapTasks: outcome.refiledGapTasks,
        ...(outcome.refileError ? { refileError: outcome.refileError } : {}),
        undecidedRemaining: outcome.undecidedRemaining,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: renderResult(content as Output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
