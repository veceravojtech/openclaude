import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getCyberMode, getMainLoopModelOverride, setCyberModeEnabled } from '../bootstrap/state.js'
import { isModelAllowed } from '../utils/model/modelAllowlist.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { requestCyberEscalation } from '../services/api/cyberEscalation.js'

let warnedMissingBinaryNinja = false

export const call: LocalCommandCall = async (args, context) => {
  const action = args.trim().toLowerCase() || 'status'
  const connected = context.getAppState().mcp.clients.some(client => client.name === 'binary_ninja_mcp' && client.type === 'connected')
  if (!['on', 'off', 'status', 'escalate'].includes(action)) {
    return { type: 'text', value: 'Usage: /cyber [on|off|status|escalate]' }
  }
  if (action === 'escalate') {
    const value = await requestCyberEscalation('User requested escalation of the current task', JSON.stringify(context.messages), context)
    return { type: 'text', value }
  }
  let warning = ''
  if (action === 'on') {
    if (!isModelAllowed('glm-5.3')) return { type: 'text', value: 'Cannot enable cyber mode: glm-5.3 is blocked by availableModels.' }
    setCyberModeEnabled(true)
    context.setAppState(prev => ({ ...prev, mainLoopModel: 'glm-5.3', mainLoopModelForSession: 'glm-5.3' }))
    if (!connected && !warnedMissingBinaryNinja) {
      warnedMissingBinaryNinja = true
      warning = '\nWarning: Binary Ninja MCP is not connected. Cyber mode is still enabled.'
    }
  } else if (action === 'off') {
    setCyberModeEnabled(false)
    const model = getMainLoopModelOverride() ?? getMainLoopModel()
    context.setAppState(prev => ({ ...prev, mainLoopModel: model, mainLoopModelForSession: null }))
  }
  const mode = getCyberMode()
  return {
    type: 'text',
    value: `Cyber mode: ${mode.enabled ? 'ON' : 'OFF'} (session only)\nLead / side calls: glm-5.3\nWorkers: easy → deepseek-v4-pro; hard → claude-opus-4-6\nReview: glm-5.3; fallback uses a different implementer family\nEscalation: claude-opus-4-8, scoped requests only (${mode.escalationScopes.size} active)\nBinary Ninja: ${connected ? 'connected' : 'not connected'}${warning}`,
  }
}

export default {
  name: 'cyber', description: 'Toggle session-only cyber model routing and scoped escalation',
  argumentHint: '[on|off|status|escalate]', type: 'local', supportsNonInteractive: true,
  load: async () => ({ call }),
} satisfies Command
