import { expect, test } from 'bun:test'
import type { ProviderProfile } from '../../utils/config.js'
import { PROVIDER_PROFILE_IN_PROCESS_ERROR, resolveProviderProfileEnv } from './providerProfileBinding.js'

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: 'selected', name: 'Selected', provider: 'openai', model: 'chosen,other',
  baseUrl: 'https://provider.example/v1', apiKey: 'SECRET_KEY',
  authHeaderValue: 'SECRET_HEADER', ...overrides,
} as ProviderProfile)

for (const provider of ['openai', 'anthropic', 'gemini', 'mistral', 'ollama']) {
  test(`binds ${provider} by identity only without resolving parent credentials`, () => {
    const env = resolveProviderProfileEnv(' selected ', { profiles: [profile({ provider })] })
    expect(env).toEqual({ OPENCLAUDE_TEAMMATE_PROFILE_ID: 'selected', OPENCLAUDE_TEAMMATE_MODEL: 'chosen' })
    expect(JSON.stringify(env)).not.toContain('SECRET')
  })
}
test('ID wins over a conflicting name; name lookup is case insensitive', () => {
  const profiles = [profile({ id: 'other', name: 'selected' }), profile()]
  expect(resolveProviderProfileEnv('selected', { profiles }).OPENCLAUDE_TEAMMATE_PROFILE_ID).toBe('selected')
  expect(resolveProviderProfileEnv(' SELECTED ', { profiles: [profile()] }).OPENCLAUDE_TEAMMATE_PROFILE_ID).toBe('selected')
})
test('explicit effective model wins and keyless local profiles work', () => {
  expect(resolveProviderProfileEnv('selected', { profiles: [profile({ apiKey: undefined, baseUrl: 'http://localhost:11434/v1' })], model: 'custom-model' }).OPENCLAUDE_TEAMMATE_MODEL).toBe('custom-model')
})
test('unknown profile errors do not echo untrusted credential-bearing input', () => {
  expect(() => resolveProviderProfileEnv('SECRET', { profiles: [] })).toThrow('Unknown provider profile')
  try { resolveProviderProfileEnv('SECRET', { profiles: [] }) } catch (error) { expect(String(error)).not.toContain('SECRET') }
  expect(PROVIDER_PROFILE_IN_PROCESS_ERROR).toContain('cannot be used for in-process')
})
