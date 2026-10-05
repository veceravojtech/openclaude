import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
// Load the smartRouting module first: teammateModelMatrix reaches it through a
// pre-existing import cycle, and entering the cycle from the matrix side leaves
// DISPATCH_FAMILIES reading matrix constants before they are initialised.
import '../../services/api/smartRouting/teammate.js'
import { ensureIntegrationsLoaded } from '../../integrations/index.js'
import { getCatalogEntriesForRoute } from '../../integrations/registry.js'
import { LEGACY_PROVIDER_MODEL_CONFIGS } from './configs.js'
import {
  CLAUDE_NATIVE_TEAMMATE_ROUTES,
  TEAMMATE_MODEL_FAMILY_KEYS,
  TEAMMATE_MODEL_MATRIX,
  _resetTeammateAllowlistWarningsForTesting,
  assertKnownSubagentModel,
  assertKnownTeammateModel,
  assertTeammateModelCheck,
  checkTeammateModelAllowed,
  getAllowedTeammateEntries,
  isKnownTeammateModel,
  isStrictKnownIdRoute,
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
  // sends a Codex shortcut (codexplan) over the codex_responses
  // transport (shouldUseCodexTransport), so the teammate is on Codex, not
  // on plain OpenAI — and must be checked against Codex's ids.
  test('a Codex alias with no explicit base URL is "codex", matching the transport', () => {
    expect(
      resolveTeammateProviderRoute({ model: 'codexplan', env: { CLAUDE_CODE_USE_OPENAI: '1' } }),
    ).toBe('codex')
    // A concrete id with no base URL goes to api.openai.com, not Codex.
    expect(
      resolveTeammateProviderRoute({ model: 'gpt-6-astra', env: { CLAUDE_CODE_USE_OPENAI: '1' } }),
    ).not.toBe('codex')
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

  test('Claude Sonnet 5.5 is admitted on the Claude-native routes without the wildcard', () => {
    expect(check('claude-sonnet-5-5', 'anthropic')).toBeNull()
    expect(check('claude-sonnet-5-5[1m]', 'anthropic')).toBeNull()
    expect(check('claude-sonnet-5-5', 'vertex')).toBeNull()
    expect(check('claude-sonnet-5-5', 'foundry')).toBeNull()
    expect(check('us.anthropic.claude-sonnet-5-5', 'bedrock')).toBeNull()
  })

  test('a valid model on the wrong provider is rejected', () => {
    expect(check('deepseek-v4-pro', 'anthropic')).toContain(
      "Model 'deepseek-v4-pro' is not allowed for teammates on provider 'anthropic'. Allowed here: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-sonnet-5. Configure teammateModelAllowlist to change this.",
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
    // Fireworks is an open route: any explicit id passes the default allowlist,
    // but a specific list still narrows it to that list's Fireworks ids.
    expect(check('deepseek-flash', 'fireworks')).toBeNull()
    expect(check('deepseek-flash', 'fireworks', ['deepseek-flash'])).toContain(
      "on provider 'fireworks'",
    )
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

  test('an open route with a specific allowlist lists nothing allowed', () => {
    // No allowlist: open routes accept any explicit id (see strict vs open).
    expect(check('my-local-model', 'lmstudio')).toBeNull()
    expect(check('my-local-model', 'lmstudio', ['glm-5.3'])).toContain('Allowed here: none.')
  })

  test('the inherit-leader exception always passes', () => {
    expect(check('my-local-model', 'lmstudio', undefined, true)).toBeNull()
    expect(check('gpt-99-fake', 'deepseek', ['glm-5.3'], true)).toBeNull()
  })

  test('"*" means any known id, not any arbitrary id', () => {
    expect(getAllowedTeammateEntries(['*'])).not.toBeNull()
    // A typo is still refused even under '*'.
    expect(check('gpt-99-fake', 'anthropic', ['*'])).toContain(
      "Model 'gpt-99-fake' is not allowed",
    )
    // A known id passes under '*'.
    expect(check('claude-sonnet-5-5', 'anthropic', ['*'])).toBeNull()
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

describe('assertKnownTeammateModel / isKnownTeammateModel', () => {
  const known = (model: string, route: string) => isKnownTeammateModel(model, route)

  test('a known id is admitted', () => {
    expect(known('claude-sonnet-5-5', 'anthropic')).toBe(true)
    expect(known('deepseek-v4-pro', 'deepseek')).toBe(true)
    expect(known('deepseek-flash', 'deepseek')).toBe(true)
    expect(known('glm-5.3', 'zai')).toBe(true)
    expect(known('gpt-6-astra', 'codex')).toBe(true)
  })

  test('an alias resolves before the check', () => {
    expect(known('sonnet', 'anthropic')).toBe(true)
    expect(known('opus', 'anthropic')).toBe(true)
    expect(known('inherit', 'deepseek')).toBe(true)
    expect(known('codexplan', 'codex')).toBe(true)
  })

  test('the [1m] suffix is stripped', () => {
    expect(known('claude-sonnet-5-5[1m]', 'anthropic')).toBe(true)
    expect(known('deepseek-v4-pro[1m]', 'deepseek')).toBe(true)
  })

  test('case is ignored (uppercase GLM)', () => {
    expect(known('GLM-5.2', 'zai')).toBe(true)
    expect(known('GLM-4.5-Air', 'zai')).toBe(true)
  })

  test('the zai extra ids are known, not just the matrix families', () => {
    expect(known('glm-5.2', 'zai')).toBe(true)
    expect(known('glm-5.3-flashx', 'zai')).toBe(true)
    expect(known('glm-4.6', 'zai')).toBe(true)
  })

  test('an unknown id is refused with a clear message', () => {
    expect(known('gpt-99-fake', 'deepseek')).toBe(false)
    expect(() => assertKnownTeammateModel('gpt-99-fake', 'deepseek')).toThrow(
      /gpt-99-fake/,
    )
    expect(() => assertKnownTeammateModel('gpt-99-fake', 'deepseek')).toThrow(
      /provider 'deepseek'/,
    )
    expect(() => assertKnownTeammateModel('gpt-99-fake', 'deepseek')).toThrow(
      /deepseek-v4-pro/,
    )
  })

  test('a typo is refused', () => {
    expect(known('claude-sonnet-5-6', 'anthropic')).toBe(false)
    expect(() => assertKnownTeammateModel('claude-sonnet-5-6', 'anthropic')).toThrow(
      /claude-sonnet-5-6/,
    )
  })

  test('a claude id on the DeepSeek route is refused', () => {
    expect(known('claude-sonnet-5-5', 'deepseek')).toBe(false)
    expect(() => assertKnownTeammateModel('claude-sonnet-5-5', 'deepseek')).toThrow(
      /deepseek-v4-pro/,
    )
  })
})

// Route comes from the ambient env when no override is given, so pin it.
const ROUTE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_NIM',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_TEAMMATE_PROFILE_ID',
] as const
const savedRouteEnv: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>> = {}

/** Pin the provider route to first-party Anthropic: a test must not inherit the
 *  ambient provider (teammates run bound to DeepSeek/Codex/etc.). */
function clearRouteEnv(): void {
  for (const key of ROUTE_ENV_KEYS) {
    savedRouteEnv[key] = process.env[key]
    delete process.env[key]
  }
}

function restoreRouteEnv(): void {
  for (const key of ROUTE_ENV_KEYS) {
    const saved = savedRouteEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

describe('assertKnownSubagentModel', () => {
  beforeEach(clearRouteEnv)
  afterEach(restoreRouteEnv)

  test('the parent\'s own model on its own provider is exempt', () => {
    expect(() =>
      assertKnownSubagentModel({ model: 'some-local-model', parentModel: 'some-local-model' }),
    ).not.toThrow()
  })

  test('a known literal id passes, an unknown or mistyped one is refused', () => {
    expect(() =>
      assertKnownSubagentModel({ model: 'claude-sonnet-5-5', parentModel: 'claude-opus-5-5' }),
    ).not.toThrow()
    expect(() =>
      assertKnownSubagentModel({
        model: 'claude-sonnet-5-6',
        requestedModel: 'claude-sonnet-5-6',
        parentModel: 'claude-opus-5-5',
      }),
    ).toThrow(/claude-sonnet-5-6/)
  })

  test('a cross-provider override is judged on its own route', () => {
    expect(() =>
      assertKnownSubagentModel({
        model: 'deepseek-v4-pro',
        parentModel: 'claude-opus-5-5',
        overrideBaseUrl: 'https://api.deepseek.com/v1',
      }),
    ).not.toThrow()
    expect(() =>
      assertKnownSubagentModel({
        model: 'claude-sonnet-5-5',
        parentModel: 'claude-opus-5-5',
        overrideBaseUrl: 'https://api.deepseek.com/v1',
      }),
    ).toThrow(/provider 'deepseek'/)
  })
})

describe('"*" allowlist is bounded by known ids', () => {
  test('claude-sonnet-4-6 (configs.ts) is known for anthropic; gpt-99-fake is not', () => {
    expect(isKnownTeammateModel('claude-sonnet-4-6', 'anthropic')).toBe(true)
    expect(() => assertKnownTeammateModel('gpt-99-fake', 'anthropic')).toThrow()
  })

  test('an unset allowlist stays the narrower matrix; "*" widens to known ids only', () => {
    const ids = (a: readonly string[] | undefined) =>
      new Set(getAllowedTeammateEntries(a).map(e => `${e.route}:${e.id}`))
    expect(ids(undefined).has('zai:glm-5.2')).toBe(false)
    expect(ids(['*']).has('zai:glm-5.2')).toBe(true)
    expect(ids(['*']).has('zai:glm-99')).toBe(false)
  })
})

describe('bedrock cross-region prefixes', () => {
  const sonnet55 = 'anthropic.claude-sonnet-5-5'
  test('every standard region prefix is known for an otherwise-known bedrock id', () => {
    for (const prefix of ['us', 'eu', 'apac', 'au', 'jp', 'ca', 'us-gov']) {
      expect(isKnownTeammateModel(`${prefix}.${sonnet55}`, 'bedrock')).toBe(true)
    }
    expect(isKnownTeammateModel(sonnet55, 'bedrock')).toBe(true)
  })

  test('global. is per-model, so it is known only when listed', () => {
    expect(isKnownTeammateModel(`global.${sonnet55}`, 'bedrock')).toBe(false)
  })

  test('a region prefix does not make an unknown model known', () => {
    expect(isKnownTeammateModel('eu.anthropic.claude-sonnet-5-6', 'bedrock')).toBe(false)
    expect(() => assertKnownTeammateModel('apac.anthropic.claude-nope', 'bedrock')).toThrow(
      /provider 'bedrock'/,
    )
  })

  test('prefixes are only stripped on the bedrock route', () => {
    expect(isKnownTeammateModel('eu.anthropic.claude-sonnet-5-5', 'anthropic')).toBe(false)
    expect(isKnownTeammateModel('eu.anthropic.claude-sonnet-5-5', 'vertex')).toBe(false)
  })

  test('the allowlist check accepts a region-pinned bedrock id too', () => {
    expect(() =>
      assertTeammateModelCheck({
        resolvedModel: 'eu.anthropic.claude-sonnet-5-5',
        providerRoute: 'bedrock',
        isInheritingLeader: false,
        allowlist: undefined,
      }),
    ).not.toThrow()
  })
})

describe('codex aliases agree across spawn paths', () => {
  test('gpt-5.3-codex-spark (what codexspark resolves to) is known on codex, not on anthropic', () => {
    expect(isKnownTeammateModel('gpt-5.3-codex-spark', 'codex')).toBe(true)
    expect(isKnownTeammateModel('gpt-5.3-codex-spark', 'anthropic')).toBe(false)
  })

  test('the subagent guard judges it exactly like the teammate guard', () => {
    const codexUrl = 'https://chatgpt.com/backend-api/codex'
    expect(() =>
      assertKnownSubagentModel({
        model: 'gpt-5.3-codex-spark',
        parentModel: 'claude-opus-5-5',
        overrideBaseUrl: codexUrl,
      }),
    ).not.toThrow()
  })
})

describe('"*" refusal message', () => {
  test('an unknown id under "*" gets the known-id message, not "configure the allowlist"', () => {
    let message = ''
    try {
      assertTeammateModelCheck({
        resolvedModel: 'gpt-99-fake',
        providerRoute: 'anthropic',
        isInheritingLeader: false,
        allowlist: ['*'],
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("'gpt-99-fake'")
    expect(message).toContain('Valid options here')
    expect(message).not.toContain('Configure teammateModelAllowlist')
  })

  test('without "*" the allowlist message is unchanged', () => {
    expect(() =>
      assertTeammateModelCheck({
        resolvedModel: 'gpt-99-fake',
        providerRoute: 'anthropic',
        isInheritingLeader: false,
        allowlist: undefined,
      }),
    ).toThrow('Configure teammateModelAllowlist to change this.')
  })
})

describe('strict vs open routes (explicit ids)', () => {
  const OPEN = ['custom', 'unknown-fallback', 'ollama', 'lmstudio', 'llama-cpp', 'vllm']
  const STRICT = ['anthropic', 'bedrock', 'vertex', 'foundry', 'deepseek', 'zai', 'codex', 'openai']
  const check = (model: string, route: string, allowlist?: string[]) => {
    try {
      assertTeammateModelCheck({
        resolvedModel: model,
        providerRoute: route,
        isInheritingLeader: false,
        allowlist,
      })
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  test('the strict set is exactly the routes we have a list for', () => {
    for (const route of STRICT) expect(isStrictKnownIdRoute(route)).toBe(true)
    for (const route of OPEN) expect(isStrictKnownIdRoute(route)).toBe(false)
  })

  test('an explicit unknown id is accepted on custom, ollama and unknown-fallback', () => {
    for (const route of OPEN) {
      expect(check('my-local-model:7b', route)).toBeNull()
      expect(check('my-local-model:7b', route, ['*'])).toBeNull()
      expect(() => assertKnownTeammateModel('my-local-model:7b', route)).not.toThrow()
    }
  })

  test('the same id is refused on deepseek, zai and anthropic', () => {
    for (const route of ['deepseek', 'zai', 'anthropic']) {
      expect(check('my-local-model:7b', route)).not.toBeNull()
      expect(check('my-local-model:7b', route, ['*'])).toContain("provider '" + route + "'")
    }
  })

  test('deepseek-chat through a DeepSeek profile is refused, with the valid ids named', () => {
    const message = check('deepseek-chat', 'deepseek')
    expect(message).toContain("'deepseek-chat'")
    expect(message).toContain('deepseek-v4-pro')
    expect(check('deepseek-chat', 'deepseek', ['*'])).toContain('Valid options here')
  })

  test('a specific allowlist still applies on an open route', () => {
    expect(check('my-local-model:7b', 'ollama', ['deepseek-flash'])).toContain(
      'Configure teammateModelAllowlist',
    )
  })

  test('the matrix entry for ollama stays known for dispatch, without limiting Ollama', () => {
    expect(isKnownTeammateModel('deepseek-v4-pro:cloud', 'ollama')).toBe(true)
    expect(isKnownTeammateModel('my-local-model:7b', 'ollama')).toBe(false)
    expect(check('my-local-model:7b', 'ollama')).toBeNull()
  })

  test('the refusal message never claims a strict route has nothing known', () => {
    expect(check('nope', 'zai')).not.toContain('none known')
  })
})
