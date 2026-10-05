import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realAuth from '../auth.js'
import * as realCheck1m from './check1mAccess.js'
import * as realProviders from './providers.js'
import { captureRealModules } from '../../test/moduleMockRestore.js'

// Every module this file stubs with mock.module(), captured before any stub
// is installed. mock.restore() does not undo mock.module(), so afterEach puts
// the real modules back; otherwise the last stub leaked into later test files
// (e.g. a ./providers.js stub decided UsageTool/logout's provider).
const restoreRealModules = await captureRealModules(import.meta.dir, [
  '../auth.js',
  './check1mAccess.js',
  './providers.js',
])

// The pinned "Opus 4.8 (1M context)" and "Opus 4.6 (1M context)" rows must be
// the next picks after Default (4.8 first, then 4.6) on every first-party
// picker, and must not leak onto third-party providers.

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
    restoreRealModules()
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
const PINNED_48 = 'claude-opus-4-8[1m]'

function expectNoDuplicateValues(options: { value: unknown }[]) {
  const values = options.map(o => o.value)
  expect(new Set(values).size).toBe(values.length)
}

describe('pinned Opus 4.6 1M picker row', () => {
  test('is the next pick after Default for PAYG first-party users', async () => {
    const { getModelOptions } = await importFresh({ tier: 'payg' })
    const options = getModelOptions()
    expect(options[0]!.value).toBeNull()
    expect(options[1]!.value).toBe(PINNED_48)
    expect(options[1]!.label).toBe('Opus 4.8 (1M context)')
    expect(options[2]!.value).toBe(PINNED)
    expect(options[2]!.label).toBe('Opus 4.6 (1M context)')
    expect(options.filter(o => o.value === PINNED)).toHaveLength(1)
    expect(options.filter(o => o.value === PINNED_48)).toHaveLength(1)
    expectNoDuplicateValues(options)
  })

  test('is the next pick after Default for Max subscribers', async () => {
    const { getModelOptions } = await importFresh({ tier: 'max' })
    const options = getModelOptions()
    expect(options[0]!.value).toBeNull()
    expect(options[1]!.value).toBe(PINNED_48)
    expect(options[2]!.value).toBe(PINNED)
    expectNoDuplicateValues(options)
  })

  test('is the next pick after Default for Pro subscribers', async () => {
    const { getModelOptions } = await importFresh({ tier: 'pro' })
    const options = getModelOptions()
    expect(options[1]!.value).toBe(PINNED_48)
    expect(options[2]!.value).toBe(PINNED)
    expectNoDuplicateValues(options)
  })

  test('is hidden when the subscriber has no 1M access', async () => {
    const {
      getModelOptions,
      getOpus46Pinned1MOption,
      getOpus48Pinned1MOption,
    } = await importFresh({
      tier: 'pro',
      opus1mAccess: false,
    })
    // isOpus1mMergeEnabled() is false for Pro, so access is the only gate.
    expect(getModelOptions().some(o => o.value === PINNED)).toBe(false)
    expect(getModelOptions().some(o => o.value === PINNED_48)).toBe(false)
    expect(getOpus46Pinned1MOption().value).toBe(PINNED)
    expect(getOpus48Pinned1MOption().value).toBe(PINNED_48)
  })

  test('is offered on the ant path, 4.8 immediately before 4.6', async () => {
    process.env.USER_TYPE = 'ant'
    const { getModelOptions } = await importFresh({ tier: 'payg' })
    const values = getModelOptions().map(o => o.value)
    expect(values[0]).toBeNull()
    expect(values.indexOf(PINNED_48)).toBe(1)
    expect(values.indexOf(PINNED)).toBe(2)
    expectNoDuplicateValues(getModelOptions())
  })

  test('ant path hides both pinned rows without 1M access', async () => {
    process.env.USER_TYPE = 'ant'
    const { getModelOptions } = await importFresh({ tier: 'pro', opus1mAccess: false })
    const values = getModelOptions().map(o => o.value)
    expect(values).not.toContain(PINNED_48)
    expect(values).not.toContain(PINNED)
  })

  test('4.8 row is placed immediately before 4.6 and keeps the default alias rows distinct', async () => {
    // PAYG carries the alias-valued `opus` / `opus[1m]` rows and a 4.8 `opus`
    // row; none of them may share a value with the pinned rows.
    const { getModelOptions } = await importFresh({ tier: 'payg' })
    const values = getModelOptions().map(o => o.value)
    expect(values.indexOf(PINNED)).toBe(values.indexOf(PINNED_48) + 1)
    expectNoDuplicateValues(getModelOptions())
  })

  test('is not offered on third-party providers', async () => {
    // 3P pickers already carry a provider-pinned "Opus (1M context)" row for
    // 4.6; the explicit first-party row must not be added on top of it.
    const { getModelOptions } = await importFresh({ provider: 'bedrock' })
    const options = getModelOptions()
    expect(options.some(o => o.label === 'Opus 4.6 (1M context)')).toBe(false)
    expect(options.some(o => o.label === 'Opus 4.8 (1M context)')).toBe(false)
    expect(options.some(o => o.value === PINNED_48)).toBe(false)
    expect(options[1]!.label).not.toBe('Opus 4.6 (1M context)')
    expectNoDuplicateValues(options)
  })

  test('describes the pinned model, not the current default Opus', async () => {
    const { getOpus46Pinned1MOption } = await importFresh()
    const option = getOpus46Pinned1MOption()
    expect(option.description).toContain('Opus 4.6 with 1M context')
    expect(option.descriptionForModel).toContain('Opus 4.6')
  })

  test('describes the pinned 4.8 model, not the current default Opus', async () => {
    const { getOpus48Pinned1MOption } = await importFresh()
    const option = getOpus48Pinned1MOption()
    expect(option.label).toBe('Opus 4.8 (1M context)')
    expect(option.description).toContain('Opus 4.8 with 1M context')
    expect(option.descriptionForModel).toContain('Opus 4.8')
  })

  test('the pinned 4.8 value round-trips through display name and 1M detection', async () => {
    const { getOpus48Pinned1MOption } = await importFresh()
    const { getPublicModelDisplayName } = await import('./model.js')
    const { has1mContext } = await import('../context.js')
    const value = getOpus48Pinned1MOption().value as string
    expect(getPublicModelDisplayName(value)).toBe('Opus 4.8 (1M context)')
    expect(has1mContext(value)).toBe(true)
  })
})
