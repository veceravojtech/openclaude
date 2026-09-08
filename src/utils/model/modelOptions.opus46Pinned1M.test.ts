import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realAuth from '../auth.js'
import * as realCheck1m from './check1mAccess.js'
import * as realProviders from './providers.js'

// The pinned "Opus 4.6 (1M context)" row must be the next pick after Default on
// every first-party picker, and must not leak onto third-party providers.

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'USER_TYPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/modelOptions.opus46Pinned1M.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    mock.restore()
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type Tier = 'payg' | 'max' | 'pro'

async function importFresh(opts: { provider?: string; tier?: Tier; opus1mAccess?: boolean } = {}) {
  const provider = opts.provider ?? 'firstParty'
  const tier = opts.tier ?? 'payg'
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => true,
    isFirstPartyAnthropicProvider: () => provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))
  mock.module('../auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => tier !== 'payg',
    isMaxSubscriber: () => tier === 'max',
    isProSubscriber: () => tier === 'pro',
    isTeamPremiumSubscriber: () => false,
    getSubscriptionType: () => (tier === 'max' ? 'max' : tier === 'pro' ? 'pro' : null),
  }))
  mock.module('./check1mAccess.js', () => ({
    ...realCheck1m,
    checkOpus1mAccess: () => opts.opus1mAccess ?? true,
    checkSonnet1mAccess: () => opts.opus1mAccess ?? true,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return (await import(`./modelOptions.js?ts=${nonce}`)) as typeof import('./modelOptions.js')
}

const PINNED = 'claude-opus-4-6[1m]'

describe('pinned Opus 4.6 1M picker row', () => {
  test('is the next pick after Default for PAYG first-party users', async () => {
    const { getModelOptions } = await importFresh({ tier: 'payg' })
    const options = getModelOptions()
    expect(options[0]!.value).toBeNull()
    expect(options[1]!.value).toBe(PINNED)
    expect(options[1]!.label).toBe('Opus 4.6 (1M context)')
    expect(options.filter(o => o.value === PINNED)).toHaveLength(1)
  })

  test('is the next pick after Default for Max subscribers', async () => {
    const { getModelOptions } = await importFresh({ tier: 'max' })
    const options = getModelOptions()
    expect(options[0]!.value).toBeNull()
    expect(options[1]!.value).toBe(PINNED)
  })

  test('is the next pick after Default for Pro subscribers', async () => {
    const { getModelOptions } = await importFresh({ tier: 'pro' })
    const options = getModelOptions()
    expect(options[1]!.value).toBe(PINNED)
  })

  test('is hidden when the subscriber has no 1M access', async () => {
    const { getModelOptions, getOpus46Pinned1MOption } = await importFresh({
      tier: 'pro',
      opus1mAccess: false,
    })
    // isOpus1mMergeEnabled() is false for Pro, so access is the only gate.
    expect(getModelOptions().some(o => o.value === PINNED)).toBe(false)
    expect(getOpus46Pinned1MOption().value).toBe(PINNED)
  })

  test('is not offered on third-party providers', async () => {
    // 3P pickers already carry a provider-pinned "Opus (1M context)" row for
    // 4.6; the explicit first-party row must not be added on top of it.
    const { getModelOptions } = await importFresh({ provider: 'bedrock' })
    const options = getModelOptions()
    expect(options.some(o => o.label === 'Opus 4.6 (1M context)')).toBe(false)
    expect(options[1]!.label).not.toBe('Opus 4.6 (1M context)')
  })

  test('describes the pinned model, not the current default Opus', async () => {
    const { getOpus46Pinned1MOption } = await importFresh()
    const option = getOpus46Pinned1MOption()
    expect(option.description).toContain('Opus 4.6 with 1M context')
    expect(option.descriptionForModel).toContain('Opus 4.6')
  })
})
