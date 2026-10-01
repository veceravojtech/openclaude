import { expect, test } from 'bun:test'
import { isProviderEnvVar, providerFreeEnv } from './provider-env.js'

test('provider selection from a provider-bound shell is stripped', () => {
  const env = providerFreeEnv({
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'p1',
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    OPENCLAUDE_TEAMMATE_PROFILE_ID: 'p1',
    OPENCLAUDE_TEAMMATE_MODEL: 'gpt-x',
    CLAUDE_CODE_USE_OPENAI: '1',
    CLAUDE_CODE_USE_GEMINI: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    OPENAI_MODEL: 'gpt-x',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
    OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    GEMINI_API_KEY: 'g',
    PATH: '/usr/bin',
    HOME: '/home/x',
    TERM: 'xterm',
    UNSET: undefined,
  })
  expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm' })
})

test('unrelated variables that merely mention a provider are kept', () => {
  expect(isProviderEnvVar('MY_OPENAI_NOTE')).toBe(false)
  expect(isProviderEnvVar('CLAUDE_CODE_ENTRYPOINT')).toBe(false)
  expect(isProviderEnvVar('OPENCLAUDE_E2E')).toBe(false)
  expect(isProviderEnvVar('OPENCLAUDE_CONFIG_DIR')).toBe(false)
})
