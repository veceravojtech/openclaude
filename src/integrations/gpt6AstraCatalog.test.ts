import { expect, test } from 'bun:test'
import gptModels from './models/gpt.js'
import openaiVendor from './vendors/openai.js'
import { modelRequiresResponsesApi, resolveProviderRequest, isCodexAlias } from '../services/api/providerConfig.js'
import { resolveModelReasoningControl } from '../utils/effort.js'

test('Astra exposes its limits, capabilities and all documented effort levels', () => {
  const model = gptModels.find(model => model.id === 'gpt-6-astra')
  expect(model?.contextWindow).toBe(1_050_000)
  expect(model?.maxOutputTokens).toBe(128_000)
  expect(model?.capabilities.supportsVision).toBe(true)
  expect(model?.capabilities.supportsFunctionCalling).toBe(true)
  const entry = openaiVendor.catalog?.models?.find(model => model.id === 'gpt-6-astra')
  expect(entry?.modelDescriptorId).toBe(model?.id)
  const control = resolveModelReasoningControl('gpt-6-astra', {
    routeId: 'openai', useRuntimeFallback: false,
  })
  expect(control.controllable).toBe(true)
  expect(control.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(control.defaultLevel).toBe('high')
})

test('Astra routes through Responses and preserves max reasoning on OpenAI and Codex', () => {
  expect(isCodexAlias('gpt-6-astra')).toBe(true)
  expect(modelRequiresResponsesApi('gpt-6-astra?reasoning=max')).toBe(true)
  expect(modelRequiresResponsesApi('gpt-6-unknown')).toBe(false)
  for (const baseUrl of ['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex']) {
    const request = resolveProviderRequest({
      model: 'gpt-6-astra?reasoning=max',
      processEnv: { OPENAI_BASE_URL: baseUrl },
    })
    expect(request.resolvedModel).toBe('gpt-6-astra')
    expect(request.transport).toBe(baseUrl.includes('chatgpt.com') ? 'codex_responses' : 'responses')
    expect(request.reasoning?.effort).toBe('max')
  }
  const gateway = resolveProviderRequest({
    model: 'gpt-6-astra', processEnv: { OPENAI_BASE_URL: 'https://example.com/v1' },
  })
  expect(gateway.transport).toBe('chat_completions')
  expect(gateway.reasoning).toBeUndefined()
})
