import { expect, test } from 'bun:test'
import type { ProviderProfile } from '../../utils/config.js'
import {
  PROVIDER_PROFILE_IN_PROCESS_ERROR,
  resolveProviderProfileEnv,
} from './providerProfileBinding.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

function codexProfile(
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id: 'profile-codex',
    name: 'Codex',
    provider: 'openai',
    baseUrl: CODEX_BASE_URL,
    model: 'codexplan',
    ...overrides,
  } as ProviderProfile
}

function apiKeyProfile(
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id: 'profile-zai',
    name: 'Z.AI',
    provider: 'openai',
    baseUrl: 'https://api.z.ai/v1',
    model: 'glm-5.3',
    apiKey: 'sk-not-a-real-key',
    ...overrides,
  } as ProviderProfile
}

/** Stand-in for buildCodexProfileEnv's OAuth output: no credential material. */
function oauthCodexEnv(): Record<string, string> {
  return {
    OPENAI_BASE_URL: CODEX_BASE_URL,
    OPENAI_MODEL: 'codexplan',
    CODEX_CREDENTIAL_SOURCE: 'oauth',
    CHATGPT_ACCOUNT_ID: 'a'.repeat(36),
  }
}

function resolve(
  ref: string,
  options: {
    profiles?: ProviderProfile[]
    codexEnv?: Record<string, string> | null
  } = {},
): Record<string, string> {
  return resolveProviderProfileEnv(ref, {
    profiles: options.profiles ?? [codexProfile()],
    buildCodexEnv: () =>
      options.codexEnv === undefined ? oauthCodexEnv() : options.codexEnv,
  })
}

test('resolves a profile by its exact id', () => {
  expect(resolve('profile-codex').OPENAI_BASE_URL).toBe(CODEX_BASE_URL)
})

test('resolves a profile by name, case-insensitively and ignoring surrounding space', () => {
  expect(resolve('  cOdEx  ').OPENAI_BASE_URL).toBe(CODEX_BASE_URL)
})

test('prefers an id match over a name match when the two collide', () => {
  // 'codex' is the NAME of the api-key profile and the ID of the codex one.
  const profiles = [
    apiKeyProfile({ id: 'profile-zai', name: 'codex' }),
    codexProfile({ id: 'codex', name: 'Codex OAuth' }),
  ]
  // An id hit must win; a name hit would have thrown the non-codex error.
  expect(resolve('codex', { profiles }).OPENAI_BASE_URL).toBe(CODEX_BASE_URL)
})

test('throws naming the unknown ref and listing the available profiles', () => {
  const profiles = [codexProfile(), apiKeyProfile()]
  expect(() => resolve('nope', { profiles })).toThrow(/nope/)
  expect(() => resolve('nope', { profiles })).toThrow(/profile-codex/)
  expect(() => resolve('nope', { profiles })).toThrow(/Z\.AI/)
})

test('throws a configuration-specific error when no profiles exist at all', () => {
  expect(() => resolve('anything', { profiles: [] })).toThrow(
    /No provider profiles are configured/,
  )
})

test('returns the codex routing vars for an OAuth codex profile', () => {
  const env = resolve('profile-codex')
  expect(env.OPENAI_BASE_URL).toBe(CODEX_BASE_URL)
  expect(env.OPENAI_MODEL).toBe('codexplan')
  expect(env.CODEX_CREDENTIAL_SOURCE).toBe('oauth')
  // Account id is an account-linked identifier: assert shape, never value.
  expect(env.CHATGPT_ACCOUNT_ID).toBeDefined()
  expect(env.CHATGPT_ACCOUNT_ID!.length).toBeGreaterThan(0)
})

test('sets CLAUDE_CODE_USE_OPENAI so the child does not wipe the injected env', () => {
  // Without a CLAUDE_CODE_USE_* flag, hasCompleteProviderSelection() is false
  // and applyActiveProviderProfileFromConfig clears every injected key.
  expect(resolve('profile-codex').CLAUDE_CODE_USE_OPENAI).toBe('1')
})

test('never returns a credential-shaped key', () => {
  const env = resolve('profile-codex')
  const offending = Object.keys(env).filter(key =>
    /API_KEY|TOKEN|SECRET/.test(key),
  )
  expect(offending).toEqual([])
})

test('strips a credential even when the codex env builder emits one', () => {
  // The env lands in an `env KEY=VALUE` argv visible in the process table,
  // so the no-secrets property must hold regardless of builder output.
  const env = resolve('profile-codex', {
    codexEnv: { ...oauthCodexEnv(), CODEX_API_KEY: 'sk-leaked' },
  })
  expect(env.CODEX_API_KEY).toBeUndefined()
  expect(Object.values(env)).not.toContain('sk-leaked')
})

test('throws when codex credentials cannot be resolved', () => {
  expect(() => resolve('profile-codex', { codexEnv: null })).toThrow(
    /credentials/i,
  )
})

test('throws when the codex profile is not in OAuth credential mode', () => {
  const env = { ...oauthCodexEnv(), CODEX_CREDENTIAL_SOURCE: 'existing' }
  expect(() => resolve('profile-codex', { codexEnv: env })).toThrow(/OAuth/i)
})

test('rejects a non-codex profile instead of half-supporting it', () => {
  const profiles = [apiKeyProfile()]
  expect(() => resolve('profile-zai', { profiles })).toThrow(/Codex/)
  expect(() => resolve('profile-zai', { profiles })).toThrow(/model/)
})

test('never echoes an api key into the non-codex rejection message', () => {
  const profiles = [apiKeyProfile({ apiKey: 'sk-super-secret' })]
  let message = ''
  try {
    resolve('profile-zai', { profiles })
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).not.toContain('sk-super-secret')
})

test('exports a distinct in-process rejection message naming the reason', () => {
  expect(PROVIDER_PROFILE_IN_PROCESS_ERROR).toMatch(/in-process/i)
  expect(PROVIDER_PROFILE_IN_PROCESS_ERROR).toMatch(/provider_profile/)
})
