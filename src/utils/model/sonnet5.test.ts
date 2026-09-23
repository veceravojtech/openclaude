import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
// Snapshot the real exports before any mock.module() swaps them out.
const realAuth = { ...(await import('../auth.js')) }
const realCheck1m = { ...(await import('./check1mAccess.js')) }
const realProviders = { ...(await import('./providers.js')) }

// Claude Sonnet 5: a first-party model with a native 1M window, the target of
// the `sonnet` alias, listed once in the picker.

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'USER_TYPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/sonnet5.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('./providers.js', () => ({ ...realProviders }))
    mock.module('../auth.js', () => ({ ...realAuth }))
    mock.module('./check1mAccess.js', () => ({ ...realCheck1m }))
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetModelStringsForTestingOnly()
  } finally {
    releaseSharedMutationLock()
  }
})

type Tier = 'payg' | 'max' | 'pro'

function installMocks(tier: Tier) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
    isFirstPartyAnthropicProvider: () => true,
    isCustomAnthropicProvider: () => false,
  }))
  mock.module('../auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => tier !== 'payg',
    isMaxSubscriber: () => tier === 'max',
    isProSubscriber: () => tier === 'pro',
    isTeamPremiumSubscriber: () => false,
    getSubscriptionType: () =>
      tier === 'max' ? 'max' : tier === 'pro' ? 'pro' : null,
  }))
  // A subscriber WITHOUT extra usage: Sonnet 4.x 1M is not available.
  mock.module('./check1mAccess.js', () => ({
    ...realCheck1m,
    checkOpus1mAccess: () => tier === 'payg',
    checkSonnet1mAccess: () => tier === 'payg',
  }))
}

const nonce = () => `${Date.now()}-${Math.random()}`

async function importModel(tier: Tier = 'max') {
  installMocks(tier)
  return (await import(`./model.js?ts=${nonce()}`)) as typeof import('./model.js')
}

async function importOptions(tier: Tier) {
  installMocks(tier)
  return (await import(
    `./modelOptions.js?ts=${nonce()}`
  )) as typeof import('./modelOptions.js')
}

describe('Sonnet 5 ids and aliases', () => {
  test('getCanonicalName strips the tag and provider prefixes', async () => {
    const { getCanonicalName } = await importModel()
    expect(getCanonicalName('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(getCanonicalName('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(getCanonicalName('us.anthropic.claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
    // Sonnet 4.x canonicalization is untouched.
    expect(getCanonicalName('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6')
    expect(getCanonicalName('claude-sonnet-4-5-20250929')).toBe(
      'claude-sonnet-4-5',
    )
  })

  test('`sonnet` resolves to claude-sonnet-5; Sonnet 4.6 stays selectable by id', async () => {
    const { parseUserSpecifiedModel, getDefaultSonnetModel } =
      await importModel()
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5')
    expect(parseUserSpecifiedModel('sonnet')).toBe('claude-sonnet-5')
    expect(parseUserSpecifiedModel('sonnet[1m]')).toBe('claude-sonnet-5[1m]')
    expect(parseUserSpecifiedModel('claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('display names', async () => {
    const { renderModelName, getPublicModelDisplayName } = await importModel()
    expect(getPublicModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(renderModelName('claude-sonnet-5[1m]')).toContain('Sonnet 5')
  })
})

describe('Sonnet 5 is 1M-native', () => {
  test('tagged for a subscriber without extra usage, while Sonnet 4.6 stays plain', async () => {
    const { preferOneMillionContext } = await importModel('pro')
    expect(preferOneMillionContext('claude-sonnet-5')).toBe(
      'claude-sonnet-5[1m]',
    )
    expect(preferOneMillionContext('claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('context window, max output and capability gates', async () => {
    const { getContextWindowForModel, getModelMaxOutputTokens, modelSupports1M } =
      await import(`../context.ts?ts=${nonce()}`)
    const { modelSupportsAdaptiveThinking } = await import(
      `../thinking.ts?ts=${nonce()}`
    )
    expect(modelSupports1M('claude-sonnet-5')).toBe(true)
    expect(getContextWindowForModel('claude-sonnet-5[1m]', [])).toBe(1_000_000)
    expect(getModelMaxOutputTokens('claude-sonnet-5').upperLimit).toBe(128_000)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-5')).toBe(true)
  })
})

describe('Sonnet 5 in the model picker', () => {
  for (const tier of ['max', 'pro', 'payg'] as const) {
    test(`is listed once for ${tier} first-party users, with no Sonnet 4.6 1M row`, async () => {
      const { getModelOptions } = await importOptions(tier)
      const options = getModelOptions()
      const sonnet5 = options.filter(o =>
        `${o.label} ${o.description}`.includes('Sonnet 5'),
      )
      expect(sonnet5).toHaveLength(1)
      expect(options.filter(o => o.value === 'sonnet[1m]')).toHaveLength(0)
      expect(
        options.filter(o => (o.description ?? '').includes('Sonnet 4.6')),
      ).toHaveLength(0)
    })
  }
})
