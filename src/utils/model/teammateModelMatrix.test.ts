import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ensureIntegrationsLoaded } from '../../integrations/index.js'
import { getCatalogEntriesForRoute } from '../../integrations/registry.js'
import { LEGACY_PROVIDER_MODEL_CONFIGS } from './configs.js'
import {
  CLAUDE_NATIVE_TEAMMATE_ROUTES,
  TEAMMATE_MODEL_FAMILY_KEYS,
  TEAMMATE_MODEL_MATRIX,
  _resetTeammateAllowlistWarningsForTesting,
  checkTeammateModelAllowed,
  getAllowedTeammateEntries,
  resolveTeammateProviderRoute,
  type TeammateMatrixEntry,
} from './teammateModelMatrix.js'

const allEntries = (): TeammateMatrixEntry[] =>
  TEAMMATE_MODEL_FAMILY_KEYS.flatMap(
    key => TEAMMATE_MODEL_MATRIX[key].entries as readonly TeammateMatrixEntry[],
  )

describe('drift guard: every matrix id exists in the catalog for its route', () => {
  ensureIntegrationsLoaded()
  const claudeIds = new Map<string, Set<string>>()
  for (const config of Object.values(LEGACY_PROVIDER_MODEL_CONFIGS)) {
    const byRoute: Record<string, string> = {
      anthropic: config.firstParty,
      vertex: config.vertex,
      foundry: config.foundry,
      bedrock: config.bedrock,
    }
    for (const [route, id] of Object.entries(byRoute)) {
      if (!claudeIds.has(route)) claudeIds.set(route, new Set())
      claudeIds.get(route)!.add(id)
    }
  }

  for (const entry of allEntries()) {
    test(`${entry.route} → ${entry.id}`, () => {
      if ((CLAUDE_NATIVE_TEAMMATE_ROUTES as readonly string[]).includes(entry.route)) {
        expect(claudeIds.get(entry.route)?.has(entry.id)).toBe(true)
        return
      }
      // Codex OAuth serves the OpenAI catalog's ids over the Codex transport.
      const catalogRoute = entry.route === 'codex' ? 'openai' : entry.route
      const ids = getCatalogEntriesForRoute(catalogRoute).map(
        model => model.apiName ?? model.id,
      )
      expect(ids).toContain(entry.id)
    })
  }

  test('no OpenRouter entries (ids unverified)', () => {
    expect(allEntries().some(entry => entry.route === 'openrouter')).toBe(false)
  })
})

describe('resolveTeammateProviderRoute', () => {
  test('first-party Anthropic env is "anthropic"', () => {
    expect(resolveTeammateProviderRoute({ env: {} })).toBe('anthropic')
  })

  test('OpenAI-compatible env resolves the real route, not collapsed "openai"', () => {
    const env = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    }
    expect(resolveTeammateProviderRoute({ env })).toBe('deepseek')
  })

  test('bedrock, vertex and foundry', () => {
    expect(resolveTeammateProviderRoute({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).toBe('bedrock')
    expect(resolveTeammateProviderRoute({ env: { CLAUDE_CODE_USE_VERTEX: '1' } })).toBe('vertex')
    expect(resolveTeammateProviderRoute({ env: { CLAUDE_CODE_USE_FOUNDRY: '1' } })).toBe('foundry')
  })

  test('explicit OpenAI base URL is "openai"; Codex base URL is "codex"', () => {
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-6-astra',
        env: { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
      }),
    ).toBe('openai')
    expect(
      resolveTeammateProviderRoute({
        model: 'glm-5.3',
        env: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toBe('openai')
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-6-astra',
        env: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
        },
      }),
    ).toBe('codex')
  })

  // Mirrors the runtime: with no explicit base URL, resolveProviderRequest
  // sends a Codex alias (gpt-6-astra, codexplan) over the codex_responses
  // transport (shouldUseCodexTransport), so the teammate is on Codex, not
  // on plain OpenAI — and must be checked against Codex's ids.
  test('a Codex alias with no explicit base URL is "codex", matching the transport', () => {
    expect(
      resolveTeammateProviderRoute({ model: 'gpt-6-astra', env: { CLAUDE_CODE_USE_OPENAI: '1' } }),
    ).toBe('codex')
    expect(
      resolveTeammateProviderRoute({ model: 'codexplan', env: { CLAUDE_CODE_USE_OPENAI: '1' } }),
    ).toBe('codex')
  })

  test('a custom (unknown) base URL stays "custom", even for a Codex alias', () => {
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-6-astra',
        env: { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_BASE_URL: 'https://llm.internal.example/v1' },
      }),
    ).toBe('custom')
  })

  test('a bound profile wins over the env', () => {
    expect(
      resolveTeammateProviderRoute({
        env: {},
        profile: { provider: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      }),
    ).toBe('codex')
    expect(
      resolveTeammateProviderRoute({
        env: {},
        profile: { provider: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
      }),
    ).toBe('zai')
  })

  test('an agentModels override base URL wins over the env', () => {
    expect(
      resolveTeammateProviderRoute({
        env: {},
        overrideBaseUrl: 'https://api.deepseek.com/v1',
      }),
    ).toBe('deepseek')
  })
})

describe('checkTeammateModelAllowed', () => {
  let warnSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    _resetTeammateAllowlistWarningsForTesting()
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warnSpy.mockRestore())

  const check = (
    resolvedModel: string,
    providerRoute: string,
    allowlist?: string[],
    isInheritingLeader = false,
  ) =>
    checkTeammateModelAllowed({ resolvedModel, providerRoute, allowlist, isInheritingLeader })

  test('a bogus model is rejected with the documented text', () => {
    expect(check('gpt-99-fake', 'deepseek')).toBe(
      "Model 'gpt-99-fake' is not allowed for teammates on provider 'deepseek'. Allowed here: deepseek-v4-pro, deepseek-flash. Configure teammateModelAllowlist to change this.",
    )
  })

  test('Claude Sonnet 5 is admitted on the Claude-native routes without the wildcard', () => {
    expect(check('claude-sonnet-5', 'anthropic')).toBeNull()
    expect(check('claude-sonnet-5[1m]', 'anthropic')).toBeNull()
    expect(check('claude-sonnet-5', 'vertex')).toBeNull()
    expect(check('claude-sonnet-5', 'foundry')).toBeNull()
    expect(check('us.anthropic.claude-sonnet-5', 'bedrock')).toBeNull()
    // Sonnet 4.6 is still not a teammate family.
    expect(check('claude-sonnet-4-6', 'anthropic')).not.toBeNull()
  })

  test('a valid model on the wrong provider is rejected', () => {
    expect(check('deepseek-v4-pro', 'anthropic')).toContain(
      "Model 'deepseek-v4-pro' is not allowed for teammates on provider 'anthropic'. Allowed here: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5. Configure teammateModelAllowlist to change this.",
    )
  })

  test('Fable 5.1 (4923bf91) is allowed on the Claude-native routes only', () => {
    expect(check('claude-fable-5-1', 'anthropic')).toBeNull()
    expect(check('claude-fable-5-1', 'vertex')).toBeNull()
    expect(check('claude-fable-5-1', 'foundry')).toBeNull()
    expect(check('us.anthropic.claude-fable-5-1', 'bedrock')).toBeNull()
    // Catalog lists no global. inference profile for Fable 5.1.
    expect(check('global.anthropic.claude-fable-5-1', 'bedrock')).not.toBeNull()
    expect(check('claude-fable-5-1', 'openai')).not.toBeNull()
  })

  test('DeepSeek V4.1 Flash is served by DeepSeek and Fireworks', () => {
    expect(check('accounts/fireworks/models/deepseek-v4p1-flash', 'fireworks')).toBeNull()
    expect(check('deepseek-flash', 'fireworks')).toContain("on provider 'fireworks'")
  })

  test('a custom allowlist mixing family keys and exact ids', () => {
    const allowlist = ['glm-5.3', 'deepseek-flash']
    expect(check('glm-5.3', 'zai', allowlist)).toBeNull()
    expect(check('z-ai/glm-5.3-flash', 'commandcode', allowlist)).toBeNull()
    expect(check('deepseek-flash', 'deepseek', allowlist)).toBeNull()
    // deepseek-flash is an exact id: its Fireworks sibling is not admitted.
    expect(check('accounts/fireworks/models/deepseek-v4p1-flash', 'fireworks', allowlist)).toContain(
      'Allowed here: none.',
    )
    expect(check('claude-opus-5-5', 'anthropic', allowlist)).toContain('Allowed here: none.')
  })

  test('valid pairs are accepted', () => {
    expect(check('claude-opus-5-5', 'anthropic')).toBeNull()
    expect(check('claude-opus-5-5[1m]', 'anthropic')).toBeNull()
    expect(check('us.anthropic.claude-opus-5-5-v1', 'bedrock')).toBeNull()
    expect(check('glm-5.3-flash', 'zai')).toBeNull()
    expect(check('gpt-6-astra', 'codex')).toBeNull()
    expect(check('gpt-6-astra?reasoning=max', 'openai')).toBeNull()
    expect(check('deepseek-v4-pro:cloud', 'ollama')).toBeNull()
    expect(check('deepseek-flash', 'deepseek')).toBeNull()
  })

  test('an unknown route lists nothing allowed', () => {
    expect(check('my-local-model', 'lmstudio')).toContain('Allowed here: none.')
  })

  test('the inherit-leader exception always passes', () => {
    expect(check('my-local-model', 'lmstudio', undefined, true)).toBeNull()
    expect(check('gpt-99-fake', 'deepseek', ['glm-5.3'], true)).toBeNull()
  })

  test('"*" disables the check', () => {
    expect(getAllowedTeammateEntries(['*'])).toBeNull()
    expect(check('gpt-99-fake', 'anthropic', ['*'])).toBeNull()
  })

  test('a custom allowlist of family keys restricts to those families', () => {
    expect(check('deepseek-v4-pro', 'deepseek', ['deepseek-v4-pro'])).toBeNull()
    expect(check('deepseek-flash', 'deepseek', ['deepseek-v4-pro'])).toBe(
      "Model 'deepseek-flash' is not allowed for teammates on provider 'deepseek'. Allowed here: deepseek-v4-pro. Configure teammateModelAllowlist to change this.",
    )
  })

  test('a custom allowlist of exact ids admits only those ids', () => {
    expect(check('glm-5.3-flash', 'zai', ['glm-5.3-flash'])).toBeNull()
    expect(check('glm-5.3', 'zai', ['glm-5.3-flash'])).toContain('Allowed here: glm-5.3-flash.')
    expect(check('deepseek-ai/deepseek-v4-pro', 'nvidia-nim', ['deepseek-ai/deepseek-v4-pro'])).toBeNull()
  })

  test('an unknown allowlist entry warns once and does not crash', () => {
    expect(check('glm-5.3', 'zai', ['not-a-family', 'glm-5.3'])).toBeNull()
    expect(check('glm-5.3', 'zai', ['not-a-family', 'glm-5.3'])).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('"not-a-family"')
  })

  test('an empty allowlist allows nothing', () => {
    expect(check('claude-opus-5-5', 'anthropic', [])).toContain('Allowed here: none.')
  })
})
