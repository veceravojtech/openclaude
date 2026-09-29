import { describe, expect, test } from 'bun:test'
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
  test('a cross-provider teammate resolves to its own route, not the 200k lead', () => {
    // A 200k-window lead (e.g. claude-sonnet-4-6) must not leak its window into
    // the teammate's history budget; the teammate's model + provider route are
    // what the runner budgets against.
    const routing = resolveInProcessTeammateRouting({
      agentDefinition,
      agentName: 'leakcheck',
      subagentType: undefined,
      model: 'glm-5.3',
      modelWasToolSpecified: true,
      parentModel: 'claude-sonnet-4-6',
      permissionMode: 'default',
      settings,
    })

    expect(routing.mainLoopModel).toBe('glm-5.3')
    expect(routing.providerOverride?.baseURL).toBe(ZAI_BASE)
  })

  test('a teammate inheriting the lead model has no provider override', () => {
    const routing = resolveInProcessTeammateRouting({
      agentDefinition: { agentType: 'worker' } as unknown as CustomAgentDefinition,
      agentName: 'worker',
      subagentType: undefined,
      model: undefined,
      modelWasToolSpecified: false,
      parentModel: 'claude-opus-5-5',
      permissionMode: 'default',
      settings: {} as unknown as SettingsJson,
    })

    expect(routing.providerOverride).toBeUndefined()
    expect(routing.mainLoopModel).toContain('claude-opus')
  })
})
