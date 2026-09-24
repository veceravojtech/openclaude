import { randomUUID } from 'node:crypto'
import { clearCyberEscalation, getCyberMode, unlockCyberEscalation } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import { CYBER_MODELS, withCyberScope } from '../../utils/model/cyber.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/** A bounded second opinion: the caller keeps its model; only this call unlocks Opus 4.8. */
export async function requestCyberEscalation(reason: string, work: string, context: ToolUseContext): Promise<string> {
  if (!getCyberMode().enabled || !reason.trim()) throw new Error('Enable /cyber and provide an escalation reason.')
  const scope = randomUUID()
  unlockCyberEscalation(scope, reason)
  try {
    return await withCyberScope(scope, async () => {
      if (!isModelAllowed(CYBER_MODELS.escalation)) throw new Error('Opus 4.8 is blocked by availableModels.')
      const { queryWithModel } = await import('./claude.js')
      const result = await queryWithModel({
        systemPrompt: asSystemPrompt(['Resolve the escalated task. Review the work so far, state uncertainties, and provide a concrete solution. This is a scoped cyber escalation.']),
        userPrompt: `Reason: ${reason}\n\nWork so far:\n${work}`,
        signal: context.abortController.signal,
        options: {
          model: CYBER_MODELS.escalation, querySource: 'cyber_escalation',
          isNonInteractiveSession: true, agents: [], hasAppendSystemPrompt: false, mcpTools: [],
        },
      })
      return result.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    })
  } finally {
    clearCyberEscalation(scope)
  }
}
