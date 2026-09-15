import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { USAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import {
  buildUsageReport,
  renderUsageReport,
  type UsageReport,
} from './report.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    provider: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Case-insensitive substring filter on provider id/label (e.g. "anthropic", "codex", "minimax", "zai", or a host)',
      ),
    refresh: z
      .boolean()
      .optional()
      .describe(
        'Fetch live usage for the active provider when it exposes an endpoint (one authenticated GET). Default false: report cached data only.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.strictObject({
    session: z.strictObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUSD: z.number(),
    }),
    providers: z.array(
      z.strictObject({
        provider: z.string(),
        label: z.string(),
        isActive: z.boolean(),
        capability: z.enum([
          'supported',
          'not exposed by provider',
          'unknown',
        ]),
        rows: z
          .array(
            z.discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('window'),
                label: z.string(),
                usedPercent: z.number(),
                resetsAt: z.string().nullable(),
                extraText: z.string().optional(),
                source: z.enum(['response headers', 'live fetch']),
              }),
              z.strictObject({
                kind: z.literal('text'),
                label: z.string(),
                value: z.string(),
                source: z.enum(['response headers', 'live fetch']),
              }),
            ]),
          )
          .optional(),
        rateLimits: z
          .strictObject({
            remainingRequests: z.union([z.number(), z.string()]).optional(),
            remainingTokens: z.union([z.number(), z.string()]).optional(),
            limitRequests: z.union([z.number(), z.string()]).optional(),
            limitTokens: z.union([z.number(), z.string()]).optional(),
            resetRequests: z.string().optional(),
            resetTokens: z.string().optional(),
          })
          .optional(),
        lastUpdated: z.string().optional(),
        planType: z.string().optional(),
        note: z.string().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const UsageTool = buildTool({
  name: USAGE_TOOL_NAME,
  searchHint: 'usage limits quotas rate limits remaining session spend',
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
    return 'Usage'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage(input) {
    return input.provider
      ? `usage (${input.provider}${input.refresh ? ', refresh' : ''})`
      : 'usage'
  },
  async call(input) {
    const report: UsageReport = await buildUsageReport({
      providerFilter: input.provider,
      refresh: input.refresh,
    })
    return { data: report }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: renderUsageReport(content as UsageReport),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
