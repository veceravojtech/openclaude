import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { GlobalConfig } from '../../utils/config.js'

type AuthModule = typeof import('../../utils/auth.js')
type ConfigModule = typeof import('../../utils/config.js')
type ProvidersModule = typeof import('../../utils/model/providers.js')
type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

let actualAuth: AuthModule | undefined
let actualConfig: ConfigModule | undefined
let actualProviders: ProvidersModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/shared/spawnMultiAgent.teammateModel.test.ts',
  )
})

afterEach(() => {
  try {
    mock.restore()
    if (actualAuth) {
      mock.module('../../utils/auth.js', () => ({ ...actualAuth! }))
    }
    if (actualConfig) {
      mock.module('../../utils/config.js', () => ({ ...actualConfig! }))
    }
    if (actualProviders) {
      mock.module('../../utils/model/providers.js', () => ({ ...actualProviders! }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type ImportOptions = {
  provider: string
  teammateDefaultModel?: string | null
  /** Claude.ai subscriber (OAuth) rather than API key. Default: false. */
  subscriber?: boolean
  /** cachedExtraUsageDisabledReason; omitted = no cache yet (undefined). */
  extraUsageDisabledReason?: string | null
}

/**
 * Import spawnMultiAgent with the inputs that decide a teammate's default
 * model: the /config value (teammateDefaultModel), the active provider, and —
 * for Sonnet 4.x's 1M window — subscription and cached extra-usage state.
 */
async function importSpawnMultiAgent(
  options: ImportOptions,
): Promise<SpawnMultiAgentModule> {
  const nonce = `${Date.now()}-${Math.random()}`
  actualAuth ??= await import(`../../utils/auth.ts?teammateModelActual=${nonce}`)
  actualConfig ??= await import(`../../utils/config.ts?teammateModelActual=${nonce}`)
  actualProviders ??= await import(
    `../../utils/model/providers.ts?teammateModelActual=${nonce}`
  )

  const globalConfig = {
    ...('teammateDefaultModel' in options
      ? { teammateDefaultModel: options.teammateDefaultModel }
      : {}),
    ...('extraUsageDisabledReason' in options
      ? { cachedExtraUsageDisabledReason: options.extraUsageDisabledReason }
      : {}),
  } as unknown as GlobalConfig

  mock.module('../../utils/auth.js', () => ({
    ...actualAuth!,
    isClaudeAISubscriber: () => options.subscriber ?? false,
  }))

  mock.module('../../utils/config.js', () => ({
    ...actualConfig!,
    getGlobalConfig: () => globalConfig,
  }))
  // Pin check1mAccess to a fresh real copy that reads the auth/config mocks
  // above: other test files stub checkSonnet1mAccess and can leave that stub
  // registered for the rest of the run.
  const freshCheck1m = await import(`../../utils/model/check1mAccess.ts?teammateModelCheck1m=${nonce}`)
  mock.module('../../utils/model/check1mAccess.js', () => ({ ...freshCheck1m }))
  mock.module('../../utils/model/providers.js', () => ({
    ...actualProviders!,
    getAPIProvider: () => options.provider,
    isFirstPartyAnthropicBaseUrl: () => options.provider === 'firstParty',
    isFirstPartyAnthropicProvider: () => options.provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))

  return import(`./spawnMultiAgent.js?teammateModel=${nonce}`)
}

async function importResolveTeammateModel(
  options: ImportOptions,
): Promise<SpawnMultiAgentModule['resolveTeammateModel']> {
  return (await importSpawnMultiAgent(options)).resolveTeammateModel
}

test('an unconfigured teammate default inherits the leader model on an OpenAI-compatible provider', async () => {
  // Regression: with teammateDefaultModel never set, the spawn layer used the
  // provider table's `openai` entry ('gpt-4o') for every OpenAI-compatible
  // endpoint. On Z.AI/GLM that model does not exist, so the spawn died with
  // 400 code 1211 "Unknown Model, please check the model code." before the
  // teammate ran a single turn.
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'openai',
  })

  expect(resolveTeammateModel(undefined, 'glm-5.3')).toBe('glm-5.3')
})

test('inherit resolves to the leader model on an OpenAI-compatible provider', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'openai',
  })

  expect(resolveTeammateModel('inherit', 'glm-5.3')).toBe('glm-5.3')
})

test('an explicit teammate model still wins over the inherited default', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'openai',
  })

  expect(resolveTeammateModel('glm-5.3-flash', 'glm-5.3')).toBe('glm-5.3-flash')
})

test('an explicit teammateDefaultModel in /config still wins over the leader model', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'openai',
    teammateDefaultModel: 'glm-5.3-flash',
  })

  expect(resolveTeammateModel(undefined, 'glm-5.3')).toBe('glm-5.3-flash')
})

test('an unset teammate default follows the leader on first-party too', async () => {
  // This used to assert the opposite — that a leader on Sonnet must NOT pull
  // first-party teammates off the newest Opus. The rule now is that a teammate
  // runs the leader's model unless something explicitly says otherwise, on
  // every provider, not only the OpenAI-compatible bucket.
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-5-20250929')).toBe(
    'claude-sonnet-4-5-20250929[1m]',
  )
})

test('a lead on Opus 4.6 spawns Opus 4.6 teammates when no model is given', async () => {
  // Regression: the unset default took the newest default Opus, so a lead on
  // Opus 4.6 got Opus 5 teammates.
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel(undefined, 'claude-opus-4-6')).toBe(
    'claude-opus-4-6[1m]',
  )
  expect(resolveTeammateModel(undefined, 'claude-opus-4-6[1m]')).toBe(
    'claude-opus-4-6[1m]',
  )
  expect(resolveTeammateModel('inherit', 'claude-opus-4-6')).toBe(
    'claude-opus-4-6[1m]',
  )
})

test('a model the spawn names explicitly still wins over the leader on first-party', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel('claude-sonnet-4-6', 'claude-opus-4-6')).toBe(
    'claude-sonnet-4-6[1m]',
  )
})

test('with no leader model at all, the provider default is the last resort', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel(undefined, null)).toBe('claude-opus-5-5[1m]')
})

test('the leader model is what the leader actually runs: a session switch first, then the setting', async () => {
  // query.ts sends the leader's requests with mainLoopModelForSession ??
  // mainLoopModel ?? default. Reading mainLoopModel alone handed teammates the
  // persistent setting after a session-only /model switch.
  const { getLeaderModel } = await importSpawnMultiAgent({
    provider: 'firstParty',
  })

  expect(
    getLeaderModel({
      mainLoopModelForSession: 'claude-opus-4-6',
      mainLoopModel: 'claude-opus-5[1m]',
    }),
  ).toBe('claude-opus-4-6')
  expect(
    getLeaderModel({
      mainLoopModelForSession: null,
      mainLoopModel: 'claude-opus-4-6[1m]',
    }),
  ).toBe('claude-opus-4-6[1m]')
  // A default leader still yields a concrete model, never null.
  const onDefault = getLeaderModel({
    mainLoopModelForSession: null,
    mainLoopModel: null,
  })
  expect(typeof onDefault).toBe('string')
  expect(onDefault.length).toBeGreaterThan(0)
})

test('an unset teammate default runs on the same 1M window as its claude-opus-5[1m] lead', async () => {
  // Regression: with teammateDefaultModel never set, a lead on
  // claude-opus-5[1m] spawned teammates on plain claude-opus-5. They compacted
  // at 150k tokens instead of 950k, and with ~198k tokens of system prompt and
  // tools on every request they were over that line on their first call —
  // compacting instead of working, with nothing new in their view.
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel(undefined, 'claude-opus-5[1m]')).toBe(
    'claude-opus-5[1m]',
  )
  expect(resolveTeammateModel('inherit', 'claude-opus-5[1m]')).toBe(
    'claude-opus-5[1m]',
  )
})

test('a teammate model picked in /config is still honoured, on its 1M variant', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
    teammateDefaultModel: 'sonnet',
  })

  const model = resolveTeammateModel(undefined, 'claude-opus-5[1m]')
  expect(model).toContain('sonnet')
  expect(model.endsWith('[1m]')).toBe(true)
})

test('a subscriber without extra usage keeps a Sonnet 4.x teammate off the 1M window', async () => {
  // Regression: on a Claude.ai subscription without extra usage, Sonnet 4.x
  // teammates were upgraded to claude-sonnet-4-6[1m] and every request came
  // back 429 "Usage credits are required for long context requests".
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })

  expect(resolveTeammateModel('claude-sonnet-4-6', 'claude-opus-5[1m]')).toBe(
    'claude-sonnet-4-6',
  )
  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6')).toBe(
    'claude-sonnet-4-6',
  )
  // An explicit [1m] the user wrote is still theirs to keep.
  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6[1m]')).toBe(
    'claude-sonnet-4-6[1m]',
  )
  // Frontier models are not gated on extra usage.
  expect(resolveTeammateModel('claude-opus-5-5', 'claude-sonnet-4-6')).toBe(
    'claude-opus-5-5[1m]',
  )
  expect(resolveTeammateModel('claude-fable-5-1', 'claude-sonnet-4-6')).toBe(
    'claude-fable-5-1[1m]',
  )
})

test('a subscriber with no cached extra-usage state keeps Sonnet 4.x untagged', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
    subscriber: true,
  })

  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6')).toBe(
    'claude-sonnet-4-6',
  )
})

test('a subscriber with extra usage enabled gets the Sonnet 4.x 1M window', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
    subscriber: true,
    extraUsageDisabledReason: null,
  })

  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6')).toBe(
    'claude-sonnet-4-6[1m]',
  )
})

test('a Sonnet 5 teammate gets the 1M window even without extra usage', async () => {
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
    subscriber: true,
    extraUsageDisabledReason: 'overage_not_provisioned',
  })

  expect(resolveTeammateModel('claude-sonnet-5', 'claude-opus-5[1m]')).toBe(
    'claude-sonnet-5[1m]',
  )
  expect(resolveTeammateModel(undefined, 'claude-sonnet-5')).toBe(
    'claude-sonnet-5[1m]',
  )
  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6')).toBe(
    'claude-sonnet-4-6',
  )
})
