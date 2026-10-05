import { expect, test } from 'bun:test'
import type { EffortLevel } from '../utils/effort.js'
import type { ProviderTransport } from '../services/api/providerConfig.js'
import gptModels from './models/gpt.js'
import openaiVendor from './vendors/openai.js'
import {
  isCodexAlias,
  isCodexBaseUrl,
  isGpt6Model,
  listCodexAliasIds,
  modelRequiresResponsesApi,
  normalizeModelBaseId,
  resolveProviderRequest,
} from '../services/api/providerConfig.js'
import {
  getAvailableEffortLevels,
  getDefaultEffortForModel,
  modelSupportsMaxEffort,
  resolveModelReasoningControl,
} from '../utils/effort.js'
import { getPublicModelDisplayName } from '../utils/model/model.js'
import {
  isKnownTeammateModel,
  resolveTeammateProviderRoute,
  TEAMMATE_MODEL_MATRIX,
} from '../utils/model/teammateModelMatrix.js'
import { getProviderValidationError } from '../utils/providerValidation.js'

const NEW_MODELS = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
] as const

test.each(NEW_MODELS)('%s exposes 1.05M context, 128k output and all effort levels', (id, label) => {
  const model = gptModels.find(model => model.id === id)
  expect(model?.label).toBe(label)
  expect(model?.contextWindow).toBe(1_050_000)
  expect(model?.maxOutputTokens).toBe(128_000)
  expect(model?.capabilities.supportsReasoning).toBe(true)
  expect(model?.capabilities.supportsVision).toBe(true)
  expect(model?.capabilities.supportsFunctionCalling).toBe(true)
  const entry = openaiVendor.catalog?.models?.find(model => model.id === id)
  expect(entry?.modelDescriptorId).toBe(id)
  expect(entry?.contextWindow).toBe(1_050_000)
  expect(entry?.maxOutputTokens).toBe(128_000)
  const control = resolveModelReasoningControl(id, {
    routeId: 'openai', useRuntimeFallback: false,
  })
  expect(control.controllable).toBe(true)
  expect(control.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(control.defaultLevel).toBe('high')
  expect(control.levels).not.toContain('ultra')
})

test.each(NEW_MODELS)('%s routes through Responses and preserves max reasoning on OpenAI and Codex', id => {
  expect(isGpt6Model(id)).toBe(true)
  expect(isCodexAlias(id)).toBe(true)
  expect(modelRequiresResponsesApi(`${id}?reasoning=max`)).toBe(true)
  for (const baseUrl of ['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex']) {
    const request = resolveProviderRequest({
      model: `${id}?reasoning=max`,
      processEnv: { OPENAI_BASE_URL: baseUrl },
    })
    expect(request.resolvedModel).toBe(id)
    expect(request.transport).toBe(baseUrl.includes('chatgpt.com') ? 'codex_responses' : 'responses')
    expect(request.reasoning?.effort).toBe('max')
  }
  const codexDefault = resolveProviderRequest({
    model: id, processEnv: { OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex' },
  })
  expect(codexDefault.reasoning?.effort).toBe('high')
  const gateway = resolveProviderRequest({
    model: id, processEnv: { OPENAI_BASE_URL: 'https://example.com/v1' },
  })
  expect(gateway.transport).toBe('chat_completions')
  expect(gateway.reasoning).toBeUndefined()
})

test('unlisted GPT-6 ids are not matched', () => {
  for (const id of ['gpt-6', 'gpt-6-unknown', 'gpt-6.1-luna', 'gpt-6.1-astra', 'gpt-6-sol-mini']) {
    expect(isGpt6Model(id)).toBe(false)
    expect(modelRequiresResponsesApi(id)).toBe(false)
  }
})

test.each(NEW_MODELS)('%s has a display name', (id, label) => {
  expect(getPublicModelDisplayName(id)).toBe(label)
})

test('the gpt-6 teammate family lists gpt-6.1-sol first, then astra, and serves every GPT-6 model', () => {
  for (const route of ['openai', 'codex']) {
    const ids = TEAMMATE_MODEL_MATRIX['gpt-6'].entries.filter(e => e.route === route).map(e => e.id)
    expect(ids.slice(0, 2)).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
  }
  for (const [id] of NEW_MODELS) {
    for (const route of ['openai', 'codex']) {
      expect(isKnownTeammateModel(id, route)).toBe(true)
      expect(TEAMMATE_MODEL_MATRIX['gpt-6'].entries).toContainEqual({ route, id })
    }
  }
})

// ---------------------------------------------------------------------------
// Real Codex environment: chatgpt.com/backend-api/codex resolves to the
// 'custom' route (empty catalog), so effort metadata must come from the openai
// vendor catalog via the Codex-transport gate in effort.ts.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_KEY',
  'OPENAI_AZURE_STYLE', 'OPENAI_MODEL', 'OPENAI_API_FORMAT',
  'CLAUDE_CODE_USE_GITHUB', 'GITHUB_TOKEN', 'GH_TOKEN',
] as const
const GPT6_IDS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'] as const
const FULL_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

async function withEnv<T>(env: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_API_KEY: 'test-key', ...env })
  try {
    return await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

const CODEX_ENV = { OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex' }

test.each([...GPT6_IDS])('%s on the real Codex base URL carries max effort metadata', id =>
  withEnv(CODEX_ENV, () => {
    expect(getAvailableEffortLevels(id)).toEqual(FULL_LEVELS)
    expect(modelSupportsMaxEffort(id)).toBe(true)
    expect(getDefaultEffortForModel(id)).toBe('high')
    const control = resolveModelReasoningControl(id)
    expect(control.source).not.toBe('legacy')
    expect(control.levels).toEqual(FULL_LEVELS)
    expect(control.defaultLevel).toBe('high')
    const request = resolveProviderRequest({ model: `${id}?reasoning=max` })
    expect(request.transport).toBe('codex_responses')
    expect(request.reasoning?.effort).toBe('max')
  }),
)

test.each([...GPT6_IDS])('%s on an unrelated custom gateway does NOT get catalog effort metadata', id =>
  withEnv({ OPENAI_BASE_URL: 'https://example.com/v1' }, () => {
    expect(modelSupportsMaxEffort(id)).toBe(false)
    expect(getAvailableEffortLevels(id)).not.toContain('max')
    expect(resolveModelReasoningControl(id).source).toBe('legacy')
    expect(resolveProviderRequest({ model: id }).reasoning).toBeUndefined()
  }),
)

test('a Codex-lookalike host or path does not get catalog effort metadata', () =>
  withEnv({ OPENAI_BASE_URL: 'https://chatgpt.com.evil.example/backend-api/codex' }, () => {
    expect(modelSupportsMaxEffort('gpt-6-sol')).toBe(false)
  }),
)

const TAGGED_IDS = [
  'gpt-6-sol[1m]',
  'gpt-6-sol?reasoning=high[1m]',
  'gpt-6-sol[1m]?reasoning=high',
  'GPT-6.1-SOL',
  'gpt-6-astra[1m]',
  'gpt-6-luna?reasoning=max',
] as const

test.each([...TAGGED_IDS])('tagged/queried/cased id %s is recognised as a GPT-6 model', id => {
  expect(isGpt6Model(id)).toBe(true)
  expect(isCodexAlias(id)).toBe(true)
  expect(modelRequiresResponsesApi(id)).toBe(true)
  // No explicit base URL: a concrete id goes to api.openai.com over plain
  // Responses with the API key — only the Codex URL / codexplan use Codex.
  return withEnv({}, () => resolveProviderRequest({ model: id })).then(request => {
    expect(request.transport).toBe('responses')
    expect(request.baseUrl).toBe('https://api.openai.com/v1')
    expect(request.resolvedModel).toBe(normalizeModelBaseId(id))
  })
})

test.each([...TAGGED_IDS])('tagged/queried/cased id %s gets full effort levels on the Codex URL', id =>
  withEnv(CODEX_ENV, () => {
    expect(getAvailableEffortLevels(id)).toEqual(FULL_LEVELS)
    expect(modelSupportsMaxEffort(id)).toBe(true)
    expect(resolveProviderRequest({ model: id }).transport).toBe('codex_responses')
  }),
)

test('normalizeModelBaseId strips query and tag in either order and lowercases', () => {
  expect(normalizeModelBaseId(' GPT-6-Sol[1m]?reasoning=high ')).toBe('gpt-6-sol')
  expect(normalizeModelBaseId('gpt-6-sol?reasoning=high[1m]')).toBe('gpt-6-sol')
  expect(normalizeModelBaseId('gpt-6-sol')).toBe('gpt-6-sol')
})

test('unlisted ids stay out of responses auto-routing even when tagged', () => {
  for (const id of ['gpt-6-unknown[1m]', 'gpt-6.1-luna[1m]', 'gpt-6[1m]']) {
    expect(isGpt6Model(id)).toBe(false)
    expect(modelRequiresResponsesApi(id)).toBe(false)
  }
})

// ---------------------------------------------------------------------------
// Policy: a `[1m]` tag or `?query`, in any order, never changes the transport,
// endpoint or wire model id — the tagged id resolves to exactly the same
// (transport, baseUrl, resolvedModel) as its untagged twin.
// ---------------------------------------------------------------------------
const tuple = (model: string, env: Record<string, string>) =>
  withEnv(env, () => {
    const request = resolveProviderRequest({ model })
    return {
      transport: request.transport,
      baseUrl: request.baseUrl,
      resolvedModel: request.resolvedModel,
    }
  })

const SHORTCUT_FORMS = (alias: string) => [
  alias,
  `${alias}[1m]`,
  `${alias}[1m]?reasoning=high`,
  `${alias}?reasoning=high[1m]`,
]

test.each(['codexplan', 'codexspark'])(
  'no base URL: every tagged/queried form of %s resolves like the bare shortcut (Codex endpoint)',
  async alias => {
    // Sequential on purpose: withEnv snapshots/restores process.env, so
    // concurrent calls would capture each other's mutated env and leak it.
    let bare: Awaited<ReturnType<typeof tuple>> | undefined
    const variants: Awaited<ReturnType<typeof tuple>>[] = []
    for (const model of SHORTCUT_FORMS(alias)) {
      const resolved = await tuple(model, {})
      if (!bare) bare = resolved
      else variants.push(resolved)
    }
    expect(bare!.transport).toBe('codex_responses')
    expect(bare!.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    for (const variant of variants) expect(variant).toEqual(bare!)
  },
)

test.each(['gpt-5.6-sol', 'gpt-6-sol'])(
  'no base URL: %s[1m] resolves exactly like the untagged id',
  async id => {
    const bare = await tuple(id, {})
    expect(await tuple(`${id}[1m]`, {})).toEqual(bare)
    expect(await tuple(`${id}[1m]?reasoning=high`, {})).toEqual(bare)
    expect(await tuple(`${id}?reasoning=high[1m]`, {})).toEqual(bare)
    expect(bare.resolvedModel).toBe(id)
  },
)

test.each(['gpt-5.6-sol', 'gpt-6-sol', 'codexplan'])(
  'explicit api.openai.com base + API key: %s[1m] resolves exactly like the untagged id',
  async id => {
    const env = { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'sk-test' }
    const bare = await tuple(id, env)
    expect(await tuple(`${id}[1m]`, env)).toEqual(bare)
    // Concrete GPT ids stay on the public OpenAI endpoint over plain Responses —
    // the tag must not push them onto the Codex transport or endpoint.
    if (id !== 'codexplan') {
      expect(bare.baseUrl).toBe('https://api.openai.com/v1')
      expect(bare.transport).toBe('responses')
    }
  },
)

test('only the supported [1m] tag is stripped: other bracket suffixes are not GPT-6 ids', () =>
  withEnv(CODEX_ENV, () => {
    for (const id of ['gpt-6-sol[custom]', 'gpt-6-sol[]', 'gpt-6.1-sol[2m]']) {
      expect(isGpt6Model(id)).toBe(false)
      expect(isCodexAlias(id)).toBe(false)
      expect(modelRequiresResponsesApi(id)).toBe(false)
      expect(modelSupportsMaxEffort(id)).toBe(false)
      expect(getAvailableEffortLevels(id)).not.toContain('max')
    }
    expect(isGpt6Model('gpt-6-sol[1M]')).toBe(true)
  }),
)

// ---------------------------------------------------------------------------
// Invariant: transport === 'codex_responses'  <=>  the resolved baseUrl is the
// Codex backend. Checked for every Codex alias plus the GPT-6 / 5.6 ids, bare
// and [1m]-tagged, with no base URL and with an explicit api.openai.com URL.
// ---------------------------------------------------------------------------
const INVARIANT_IDS = [
  ...listCodexAliasIds(),
  ...GPT6_IDS,
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]

test('invariant (OpenAI/Codex path, not GitHub): codex_responses iff the resolved base URL is the Codex backend', async () => {
  const envs: Record<string, string>[] = [
    {},
    { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'sk-test' },
    CODEX_ENV,
  ]
  // Sequential: withEnv snapshots/restores process.env.
  for (const env of envs) {
    for (const id of new Set(INVARIANT_IDS)) {
      for (const model of [id, `${id}[1m]`]) {
        const request = await withEnv(env, () => resolveProviderRequest({ model }))
        expect(`${model} @ ${JSON.stringify(env)}: ${request.transport === 'codex_responses'}`)
          .toBe(`${model} @ ${JSON.stringify(env)}: ${isCodexBaseUrl(request.baseUrl)}`)
      }
    }
  }
})

test.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-sol[1m]'])(
  'no base URL: %s goes to api.openai.com over plain responses',
  async model => {
    expect(await tuple(model, {})).toEqual({
      transport: 'responses',
      baseUrl: 'https://api.openai.com/v1',
      resolvedModel: normalizeModelBaseId(model),
    })
  },
)

test.each(['codexplan', 'codexplan[1m]'])(
  'no base URL: the %s shortcut resolves to codex_responses on the Codex URL',
  async model => {
    expect(await tuple(model, {})).toEqual({
      transport: 'codex_responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      resolvedModel: 'gpt-5.6-sol',
    })
  },
)

// ---------------------------------------------------------------------------
// isCodexBaseUrl only accepts https on the default port.
// ---------------------------------------------------------------------------
test.each([
  'http://chatgpt.com/backend-api/codex',
  'https://chatgpt.com:8443/backend-api/codex',
  'https://chatgpt.com.evil.example/backend-api/codex',
  'https://chatgpt.com/backend-api/other',
  'ftp://chatgpt.com/backend-api/codex',
  'https://user@chatgpt.com:444/backend-api/codex',
])('%s is NOT a Codex base URL', url => {
  expect(isCodexBaseUrl(url)).toBe(false)
})

test.each([
  'https://chatgpt.com/backend-api/codex',
  'https://chatgpt.com/backend-api/codex/',
  'https://chatgpt.com:443/backend-api/codex',
])('%s IS a Codex base URL', url => {
  expect(isCodexBaseUrl(url)).toBe(true)
})

test('an http:// Codex-lookalike OPENAI_BASE_URL gets neither the Codex transport nor catalog effort metadata', () =>
  withEnv({ OPENAI_BASE_URL: 'http://chatgpt.com/backend-api/codex' }, () => {
    for (const id of GPT6_IDS) {
      const request = resolveProviderRequest({ model: id })
      expect(request.transport).not.toBe('codex_responses')
      expect(modelSupportsMaxEffort(id)).toBe(false)
      expect(getAvailableEffortLevels(id)).not.toContain('max')
      expect(resolveModelReasoningControl(id).source).toBe('legacy')
    }
    // Even the Codex shortcut must not be pushed onto the cleartext URL's Codex transport.
    expect(resolveProviderRequest({ model: 'codexplan' }).transport).not.toBe('codex_responses')
  }),
)

// ---------------------------------------------------------------------------
// Older Codex-branded ids: Responses-only, never chat/completions.
// ---------------------------------------------------------------------------
const CODEX_BRANDED: [string, ProviderTransport, string][] = [
  ['gpt-5.3-codex', 'responses', 'https://api.openai.com/v1'],
  ['gpt-5.2-codex', 'responses', 'https://api.openai.com/v1'],
  ['gpt-5.1-codex-max', 'responses', 'https://api.openai.com/v1'],
  ['gpt-5.1-codex-mini', 'responses', 'https://api.openai.com/v1'],
  // Bare Spark is a concrete id like the rest: its public-API availability is
  // unverified and account-dependent, so it follows option A (api.openai.com,
  // plain Responses). Only the codexspark shortcut and a Codex URL reach Codex.
  ['gpt-5.3-codex-spark', 'responses', 'https://api.openai.com/v1'],
]

test.each(CODEX_BRANDED)('no base URL: %s -> {%s, %s}', async (model, transport, baseUrl) => {
  expect(await tuple(model, {})).toEqual({ transport, baseUrl, resolvedModel: model })
  expect(await tuple(`${model}[1m]`, {})).toEqual({ transport, baseUrl, resolvedModel: model })
})

test('modelRequiresResponsesApi covers exactly the five verified Codex-branded ids', () => {
  for (const [model] of CODEX_BRANDED) {
    expect(modelRequiresResponsesApi(model)).toBe(true)
    expect(modelRequiresResponsesApi(`${model}[1m]`)).toBe(true)
  }
  for (const id of [
    'gpt-99-codex-unknown', 'gpt-6.2-codex-unverified', 'gpt-5.3-codex-extra',
    'codex-mini-latest', 'my-codex-gateway', 'o3', 'gpt-4.1', 'gpt-5-mini',
  ]) {
    expect(modelRequiresResponsesApi(id)).toBe(false)
  }
})

test('invariant: concrete ids resolve to the exact expected transport (not just "not Codex")', async () => {
  const expected: Record<string, ProviderTransport> = {
    'gpt-6-astra': 'responses', 'gpt-6-sol': 'responses', 'gpt-6.1-sol': 'responses', 'gpt-6-luna': 'responses',
    'gpt-5.6-sol': 'responses', 'gpt-5.6-terra': 'responses', 'gpt-5.6-luna': 'responses',
    'gpt-5.5': 'responses', 'gpt-5.4': 'responses',
    'gpt-5.3-codex': 'responses', 'gpt-5.2-codex': 'responses',
    'gpt-5.1-codex-max': 'responses', 'gpt-5.1-codex-mini': 'responses',
    'gpt-5.3-codex-spark': 'responses',
    codexplan: 'codex_responses', codexspark: 'codex_responses',
  }
  for (const [model, transport] of Object.entries(expected)) {
    expect((await tuple(model, {})).transport).toBe(transport)
  }
})

test('GitHub Copilot is the documented exception: it uses codex_responses at api.githubcopilot.com', () =>
  withEnv(
    { CLAUDE_CODE_USE_GITHUB: '1', OPENAI_BASE_URL: 'https://api.githubcopilot.com', GITHUB_TOKEN: 'gh-test' },
    () => {
      const request = resolveProviderRequest({ model: 'gpt-5.3-codex' })
      expect(request.transport).toBe('codex_responses')
      expect(request.baseUrl).toBe('https://api.githubcopilot.com')
      expect(isCodexBaseUrl(request.baseUrl)).toBe(false)
    },
  ),
)

// ---------------------------------------------------------------------------
// Validation hint for a concrete Codex-alias id with no base URL and no key.
// ---------------------------------------------------------------------------
test('missing API key for a concrete Codex alias id explains how to use ChatGPT/Codex sign-in', async () => {
  const message = await withEnv(
    { OPENAI_MODEL: 'gpt-6-astra', OPENAI_API_KEY: '' },
    () => getProviderValidationError({ ...process.env, OPENAI_API_KEY: '' }),
  )
  expect(message).toContain('OPENAI_API_KEYS or OPENAI_API_KEY is required')
  expect(message).toContain('OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex')
  expect(message).toContain('Codex OAuth profile with /provider')
  // A non-Codex model gets the unchanged message, with no hint.
  const plain = await withEnv(
    { OPENAI_MODEL: 'some-model', OPENAI_BASE_URL: 'https://proxy.example/v1', OPENAI_API_KEY: '' },
    () => getProviderValidationError({ ...process.env, OPENAI_API_KEY: '' }),
  )
  expect(plain).toContain('OPENAI_API_KEYS or OPENAI_API_KEY is required')
  expect(plain).not.toContain('chatgpt.com/backend-api/codex')
})
