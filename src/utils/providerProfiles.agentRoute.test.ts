import { describe, expect, test } from 'bun:test'
import type { ProviderProfile } from './config.js'
import { findProviderProfileRouteForModel } from './providerProfiles.js'

// Profiles are always passed in: this file must never read the developer's own
// saved profiles, which on a real machine can serve exactly the models tested.
function zaiProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_zai_test',
    name: 'Z.AI test',
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-5.3',
    apiKey: 'test-key-abc123',
    ...overrides,
  }
}

describe('findProviderProfileRouteForModel', () => {
  test('a key-based OpenAI-compatible profile gives the route an agentModels entry would', () => {
    expect(findProviderProfileRouteForModel('glm-5.3', [zaiProfile()])).toEqual({
      model: 'glm-5.3',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'test-key-abc123',
    })
  })

  test('matches any model the profile lists, case-insensitively, and sends the listed spelling', () => {
    const profile = zaiProfile({ model: 'glm-5.3; GLM-5.2' })
    expect(findProviderProfileRouteForModel('glm-5.2', [profile])?.model).toBe(
      'GLM-5.2',
    )
    expect(findProviderProfileRouteForModel('GLM-5.3', [profile])?.model).toBe(
      'glm-5.3',
    )
  })

  test('a profile that does not list the model gives nothing', () => {
    expect(findProviderProfileRouteForModel('glm-9', [zaiProfile()])).toBeNull()
  })

  test('a profile without an API key (an OAuth profile such as Codex) gives nothing', () => {
    const oauth = zaiProfile({
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
      apiKey: undefined,
    })
    expect(findProviderProfileRouteForModel('codexplan', [oauth])).toBeNull()
  })

  test('a profile on a non-OpenAI wire gives nothing, since a route is OpenAI-compatible only', () => {
    const anthropicWire = zaiProfile({ provider: 'anthropic', model: 'glm-5.3' })
    expect(
      findProviderProfileRouteForModel('glm-5.3', [anthropicWire]),
    ).toBeNull()
  })

  test('a profile a plain route would reproduce unfaithfully gives nothing', () => {
    const unfaithful: Partial<ProviderProfile>[] = [
      { apiFormat: 'responses' },
      { authScheme: 'raw' },
      { authHeader: 'X-Api-Key' },
      { authHeaderValue: 'secret' },
      { azureStyle: true },
      { customHeaders: { 'X-Tenant': 'acme' } },
    ]
    for (const overrides of unfaithful) {
      expect(
        findProviderProfileRouteForModel('glm-5.3', [zaiProfile(overrides)]),
      ).toBeNull()
    }
    // The defaults themselves are faithful.
    expect(
      findProviderProfileRouteForModel('glm-5.3', [
        zaiProfile({ apiFormat: 'chat_completions', authScheme: 'bearer' }),
      ]),
    ).not.toBeNull()
  })

  test('the first qualifying profile in saved order wins', () => {
    const first = zaiProfile({ id: 'a', apiKey: 'key-first-111' })
    const second = zaiProfile({ id: 'b', apiKey: 'key-second-222' })
    expect(
      findProviderProfileRouteForModel('glm-5.3', [first, second])?.apiKey,
    ).toBe('key-first-111')
  })
})
