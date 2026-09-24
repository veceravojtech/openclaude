import { z } from 'zod/v4'
import { getCyberMode } from '../bootstrap/state.js'
import { buildTool, type ToolDef } from '../Tool.js'
import { requestCyberEscalation } from '../services/api/cyberEscalation.js'

const inputSchema = z.strictObject({
  reason: z.string().min(1).describe('Why the task needs stronger reasoning'),
  work: z.string().min(1).describe('Task, evidence, work so far and remaining uncertainty'),
})

export const CyberEscalateTool = buildTool({
  name: 'CyberEscalate',
  inputSchema,
  maxResultSizeChars: 40_000,
  isEnabled: () => getCyberMode().enabled,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  userFacingName: () => 'CyberEscalate',
  async description() { return 'Hand an uncertain task to Opus 4.8 for a scoped second opinion.' },
  async prompt() { return 'In cyber mode, use when uncertain. Supply a reason and the task with all work so far. Only this request uses Opus 4.8; your model is unchanged.' },
  renderToolUseMessage: input => input.reason,
  async call(input, context) {
    return { data: await requestCyberEscalation(input.reason, input.work, context) }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content }
  },
} satisfies ToolDef<typeof inputSchema, string>)
