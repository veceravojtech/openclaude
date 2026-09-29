import { describe, expect, test } from 'bun:test'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import { getContextWindowForModel } from '../context.js'
import type { CustomAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { SettingsJson } from '../settings/types.js'
import { resolveInProcessTeammateRouting } from './inProcessRunner.js'

const ZAI_BASE = 'https://api.z.ai/api/coding/paas/v4'

const settings = {
  agentModels: {
    'glm-5.3': { base_url: ZAI_BASE, api_key: 'sk-zai' },
  },
} as unknown as SettingsJson

const agentDefinition = {
  agentType: 'leakcheck',
  model: 'glm-5.3',
} as unknown as CustomAgentDefinition

describe('resolveInProcessTeammateRouting', () => {
  test('a cross-provider teammate budgets against its own 1M route, not the 200k lead', () => {
    const routing = resolveInProcessTeammateRouting({
      agentDefinition,
      agentName: 'leakcheck',
      subagentType: undefined,
      model: 'glm-5.3',
      modelWasToolSpecified: true,
      // A 200k-window lead (e.g. claude-sonnet-4-6) must not leak its window
      // into the teammate's history budget.
      parentModel: 'claude-sonnet-4-6',
      permissionMode: 'default',
      settings,
    })

    expect(routing.mainLoopModel).toBe('glm-5.3')
    expect(routing.providerOverride?.baseURL).toBe(ZAI_BASE)

    // The teammate's own route resolves a 1M window and a near-1M threshold.
    const route = { baseUrl: routing.providerOverride!.baseURL }
    expect(
      getContextWindowForModel('glm-5.3', [], undefined, route),
    ).toBe(1_000_000)
    expect(getAutoCompactThreshold('glm-5.3', route)).toBeGreaterThan(900_000)
  })
})
