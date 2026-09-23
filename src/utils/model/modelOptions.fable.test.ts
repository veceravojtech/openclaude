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
const realSideQuery = { ...(await import('../sideQuery.js')) }

// Claude Fable 5.1 must be pickable, resolvable and accepted by `/model` for a
// claude.ai subscriber (OAuth), without ever becoming the default.

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'USER_TYPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/modelOptions.fable.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Fable ids come from the process-global model-strings cache, which an
  // earlier file can leave holding another provider's (e.g. Bedrock) ids.
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    mock.restore()
    // mock.restore() does not undo mock.module(); re-register the real
    // modules so a subscriber/provider mock never leaks into later files.
    mock.module('./providers.js', () => ({ ...realProviders }))
    mock.module('../auth.js', () => ({ ...realAuth }))
    mock.module('./check1mAccess.js', () => ({ ...realCheck1m }))
    mock.module('../sideQuery.js', () => ({ ...realSideQuery }))
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

function installMocks(opts: { provider?: string; tier?: Tier } = {}) {
  const provider = opts.provider ?? 'firstParty'
  const tier = opts.tier ?? 'max'
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
    getSubscriptionType: () =>
      tier === 'max' ? 'max' : tier === 'pro' ? 'pro' : null,
  }))
  mock.module('./check1mAccess.js', () => ({
    ...realCheck1m,
    checkOpus1mAccess: () => true,
    checkSonnet1mAccess: () => true,
  }))
}

function nonce(): string {
  return `${Date.now()}-${Math.random()}`
}

async function importOptions(opts: { provider?: string; tier?: Tier } = {}) {
  installMocks(opts)
  return (await import(
    `./modelOptions.js?ts=${nonce()}`
  )) as typeof import('./modelOptions.js')
}

async function importModel(opts: { provider?: string; tier?: Tier } = {}) {
  installMocks(opts)
  return (await import(`./model.js?ts=${nonce()}`)) as typeof import('./model.js')
}

describe('Fable 5.1 in the model picker', () => {
  for (const tier of ['max', 'pro', 'payg'] as const) {
    test(`is listed for ${tier} first-party users, once, and not as the default`, async () => {
      const { getModelOptions } = await importOptions({ tier })
      const options = getModelOptions()
      const fable = options.filter(o => o.value === 'fable')
      expect(fable).toHaveLength(1)
      expect(fable[0]!.label).toBe('Fable')
      expect(fable[0]!.description).toContain('Fable 5.1')
      // Row 0 is always the Default row; Fable is never it.
      expect(options[0]!.value).toBeNull()
      expect(options[0]!.description).not.toContain('Fable')
    })
  }

  test('subscriber row carries no per-token price; PAYG row does', async () => {
    const { getFable51Option } = await importOptions({ tier: 'max' })
    expect(getFable51Option().description).not.toContain('$')
    const payg = await importOptions({ tier: 'payg' })
    expect(payg.getFable51Option(true).description).toContain('$10')
  })
})

describe('Fable 5.1 resolution for subscribers', () => {
  test('the `fable` alias resolves to the pinned Fable id, `fable[1m]` keeps the tag', async () => {
    const { parseUserSpecifiedModel } = await importModel({ tier: 'max' })
    expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5-1')
    expect(parseUserSpecifiedModel('fable[1m]')).toBe('claude-fable-5-1[1m]')
    expect(parseUserSpecifiedModel('claude-fable-5-1')).toBe('claude-fable-5-1')
  })

  test('Fable is never a default: not the main-loop default, not `opus`, not `best`', async () => {
    for (const tier of ['max', 'pro', 'payg'] as const) {
      const {
        getDefaultMainLoopModelSetting,
        parseUserSpecifiedModel,
        getDefaultOpusModel,
        getBestModel,
      } = await importModel({ tier })
      expect(getDefaultMainLoopModelSetting()).not.toContain('fable')
      expect(parseUserSpecifiedModel('opus')).not.toContain('fable')
      expect(getDefaultOpusModel()).not.toContain('fable')
      expect(getBestModel()).not.toContain('fable')
    }
  })

  test('Fable is 1M-native: the main loop prefers the [1m] window like Opus 5.5', async () => {
    const { preferOneMillionContext, parseUserSpecifiedModel } =
      await importModel({ tier: 'max' })
    expect(preferOneMillionContext(parseUserSpecifiedModel('fable'))).toBe(
      'claude-fable-5-1[1m]',
    )
    expect(preferOneMillionContext('claude-opus-5-5')).toBe(
      'claude-opus-5-5[1m]',
    )
  })

  test('on a non-Claude provider the alias falls back to that provider flagship', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o'
    try {
      const { getDefaultFableModel } = await importModel({ provider: 'openai' })
      expect(getDefaultFableModel()).toBe('gpt-4o')
    } finally {
      delete process.env.OPENAI_MODEL
    }
  })
})

describe('`/model` acceptance for Fable under OAuth', () => {
  test('`fable` and `fable[1m]` are known aliases (accepted without an API probe)', async () => {
    installMocks({ tier: 'max' })
    const probes: string[] = []
    mock.module('../sideQuery.js', () => ({
      ...realSideQuery,
      sideQuery: async (opts: { model: string }) => {
        probes.push(opts.model)
        return {}
      },
    }))
    const { validateModel } = (await import(
      `./validateModel.js?ts=${nonce()}`
    )) as typeof import('./validateModel.js')
    expect(await validateModel('fable')).toEqual({ valid: true })
    expect(await validateModel('fable[1m]')).toEqual({ valid: true })
    expect(probes).toEqual([])
  })

  test('the pinned id `claude-fable-5-1` validates via the subscriber probe', async () => {
    installMocks({ tier: 'max' })
    const probes: string[] = []
    mock.module('../sideQuery.js', () => ({
      ...realSideQuery,
      sideQuery: async (opts: { model: string }) => {
        probes.push(opts.model)
        return {}
      },
    }))
    const { validateModel } = (await import(
      `./validateModel.js?ts=${nonce()}`
    )) as typeof import('./validateModel.js')
    expect(await validateModel('claude-fable-5-1')).toEqual({ valid: true })
    expect(probes).toEqual(['claude-fable-5-1'])
  })
})
