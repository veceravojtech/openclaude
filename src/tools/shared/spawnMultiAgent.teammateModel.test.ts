import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { GlobalConfig } from '../../utils/config.js'

type ConfigModule = typeof import('../../utils/config.js')
type ProvidersModule = typeof import('../../utils/model/providers.js')
type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

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

/**
 * Import spawnMultiAgent with the two inputs that decide a teammate's default
 * model: the /config value (teammateDefaultModel) and the active provider.
 */
async function importSpawnMultiAgent(options: {
  provider: string
  teammateDefaultModel?: string | null
}): Promise<SpawnMultiAgentModule> {
  const nonce = `${Date.now()}-${Math.random()}`
  actualConfig ??= await import(`../../utils/config.ts?teammateModelActual=${nonce}`)
  actualProviders ??= await import(
    `../../utils/model/providers.ts?teammateModelActual=${nonce}`
  )

  const globalConfig = {
    ...('teammateDefaultModel' in options
      ? { teammateDefaultModel: options.teammateDefaultModel }
      : {}),
  } as unknown as GlobalConfig

  mock.module('../../utils/config.js', () => ({
    ...actualConfig!,
    getGlobalConfig: () => globalConfig,
  }))
  mock.module('../../utils/model/providers.js', () => ({
    ...actualProviders!,
    getAPIProvider: () => options.provider,
    isFirstPartyAnthropicBaseUrl: () => options.provider === 'firstParty',
    isFirstPartyAnthropicProvider: () => options.provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))

  return import(`./spawnMultiAgent.js?teammateModel=${nonce}`)
}

async function importResolveTeammateModel(options: {
  provider: string
  teammateDefaultModel?: string | null
}): Promise<SpawnMultiAgentModule['resolveTeammateModel']> {
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
