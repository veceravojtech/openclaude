import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { GlobalConfig } from '../config.js'

/**
 * Sonnet 4.x's 1M window is a paid long-context feature for Claude.ai
 * subscribers. preferOneMillionContext used to tag it whenever the model
 * supported 1M, so a subscriber without extra usage got claude-sonnet-4-6[1m]
 * and every request failed with 429 "Usage credits are required for long
 * context requests". Frontier Opus/Fable are not gated.
 */

type AuthModule = typeof import('../auth.js')
type ConfigModule = typeof import('../config.js')
type ProvidersModule = typeof import('./providers.js')
type ModelModule = typeof import('./model.js')

let actualAuth: AuthModule | undefined
let actualConfig: ConfigModule | undefined
let actualProviders: ProvidersModule | undefined
const originalDisable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/model.sonnet1m.test.ts')
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
})

afterEach(() => {
  try {
    mock.restore()
    if (actualAuth) mock.module('../auth.js', () => ({ ...actualAuth! }))
    if (actualConfig) mock.module('../config.js', () => ({ ...actualConfig! }))
    if (actualProviders) {
      mock.module('./providers.js', () => ({ ...actualProviders! }))
    }
    if (originalDisable1m === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    } else {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = originalDisable1m
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importModel(options: {
  subscriber: boolean
  /** cachedExtraUsageDisabledReason; omitted = no cache yet (undefined). */
  extraUsageDisabledReason?: string | null
  provider?: string
}): Promise<ModelModule> {
  const nonce = `${Date.now()}-${Math.random()}`
  actualAuth ??= await import(`../auth.ts?sonnet1mActual=${nonce}`)
  actualConfig ??= await import(`../config.ts?sonnet1mActual=${nonce}`)
  actualProviders ??= await import(`./providers.ts?sonnet1mActual=${nonce}`)
  const provider = options.provider ?? 'firstParty'

  const globalConfig = {
    ...('extraUsageDisabledReason' in options
      ? { cachedExtraUsageDisabledReason: options.extraUsageDisabledReason }
      : {}),
  } as unknown as GlobalConfig

  mock.module('../auth.js', () => ({
    ...actualAuth!,
    isClaudeAISubscriber: () => options.subscriber,
  }))
  mock.module('../config.js', () => ({
    ...actualConfig!,
    getGlobalConfig: () => globalConfig,
  }))
  // Pin check1mAccess to a fresh real copy that reads the auth/config mocks
  // above: other test files stub checkSonnet1mAccess and can leave that stub
  // registered for the rest of the run.
  const freshCheck1m = await import(`./check1mAccess.ts?sonnet1mCheck1m=${nonce}`)
  mock.module('./check1mAccess.js', () => ({ ...freshCheck1m }))
  mock.module('./providers.js', () => ({
    ...actualProviders!,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => provider === 'firstParty',
    isFirstPartyAnthropicProvider: () => provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))

  return import(`./model.ts?sonnet1m=${nonce}`)
}

function mainThread(model: ModelModule, mainLoopModel: string): string {
  return model.getRuntimeMainLoopModel({
    permissionMode: 'default',
    mainLoopModel,
  })
}

test('a subscriber without extra usage keeps Sonnet 4.x on the main thread untagged', async () => {
  const model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })

  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  expect(model.preferOneMillionContext('claude-sonnet-4-5-20250929')).toBe(
    'claude-sonnet-4-5-20250929',
  )
})

test('a subscriber with no cached extra-usage state keeps Sonnet 4.x untagged', async () => {
  const model = await importModel({ subscriber: true })

  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
})

test('a subscriber with extra usage enabled gets the Sonnet 4.x 1M window', async () => {
  let model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: null,
  })
  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]')

  // Provisioned but out of credits still counts as enabled.
  model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: 'out_of_credits',
  })
  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]')
})

test('an API-key user still gets the Sonnet 4.x 1M window', async () => {
  const model = await importModel({ subscriber: false })

  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]')
})

test('frontier Opus and Fable are tagged regardless of extra usage', async () => {
  const model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })

  expect(mainThread(model, 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]')
  expect(mainThread(model, 'claude-fable-5-1')).toBe('claude-fable-5-1[1m]')
})

test('an explicit claude-sonnet-4-6[1m] from the user is preserved', async () => {
  const model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })

  expect(mainThread(model, 'claude-sonnet-4-6[1m]')).toBe(
    'claude-sonnet-4-6[1m]',
  )
})

test('Sonnet 5 is 1M-native: tagged even for a subscriber without extra usage', async () => {
  // The same subscriber whose claude-sonnet-4-6 stays plain.
  const model = await importModel({
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })
  expect(model.preferOneMillionContext('claude-sonnet-5')).toBe(
    'claude-sonnet-5[1m]',
  )
  expect(mainThread(model, 'claude-sonnet-5')).toBe('claude-sonnet-5[1m]')
  expect(mainThread(model, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')

  const noCache = await importModel({ subscriber: true })
  expect(mainThread(noCache, 'claude-sonnet-5')).toBe('claude-sonnet-5[1m]')
})
