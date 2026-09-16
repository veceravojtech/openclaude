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
 * Import resolveTeammateModel() with the two inputs that decide the default:
 * the /config value (teammateDefaultModel) and the active provider category.
 */
async function importResolveTeammateModel(options: {
  provider: string
  teammateDefaultModel?: string | null
}): Promise<SpawnMultiAgentModule['resolveTeammateModel']> {
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

  const mod: SpawnMultiAgentModule = await import(
    `./spawnMultiAgent.js?teammateModel=${nonce}`
  )
  return mod.resolveTeammateModel
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

test('the first-party default is unchanged by the OpenAI-compatible fix', async () => {
  // The leader being on Sonnet must NOT drag first-party teammates off Opus:
  // only the ambiguous `openai` bucket inherits.
  const resolveTeammateModel = await importResolveTeammateModel({
    provider: 'firstParty',
  })

  expect(resolveTeammateModel(undefined, 'claude-sonnet-4-5-20250929')).toBe(
    'claude-opus-5',
  )
})
