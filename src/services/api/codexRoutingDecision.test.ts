import { expect, test } from 'bun:test'
import { getRouteDefaultModel } from '../../integrations/routeMetadata.js'
import { getPublicModelDisplayName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  assertKnownSubagentModel,
  isKnownTeammateModel,
  resolveTeammateProviderRoute,
} from '../../utils/model/teammateModelMatrix.js'
import {
  applyAgentProviderOverrideToEnv,
  resolveAgentRunModelRouting,
  resolveOutOfProcessTeammateProvider,
} from './agentRouting.js'
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'
import {
  buildCompatibilityProcessEnv,
  clearManagedProfileEnv,
} from '../../utils/providerProfile.js'
import { getProviderValidationError } from '../../utils/providerValidation.js'
import {
  canonicalizeOverrideModel,
  isCodexBackendRoute,
  isCodexBaseUrl,
  resolveProviderRequest,
} from './providerConfig.js'

// The routing decision is made once, by resolveProviderRequest. This table
// drives the PUBLIC callers — the resolver, the teammate route, the provider
// label and startup validation — through the same session/base/requested
// combinations and asserts they all agree on whether the request goes to the
// ChatGPT Codex backend.

const CODEX_URL = 'https://chatgpt.com/backend-api/codex'
const OPENAI_URL = 'https://api.openai.com/v1'
const CUSTOM_URL = 'https://llm.internal.example/v1'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_GITHUB', 'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL', 'NVIDIA_NIM', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
  'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_MODEL', 'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE', 'CODEX_API_KEY', 'CHATGPT_ACCOUNT_ID', 'CODEX_ACCOUNT_ID',
  'CLINE_API_KEY', 'APISMART_API_KEY',
] as const

// Sequential on purpose: each case snapshots/restores process.env.
async function withEnv<T>(env: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  try {
    return await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

const SESSIONS = [undefined, 'codexplan', 'gpt-6-astra'] as const
const BASES = [undefined, OPENAI_URL, CODEX_URL, CUSTOM_URL] as const
const REQUESTED = [undefined, 'gpt-5.6-sol', 'gpt-6-sol', 'codexplan'] as const

// Expected: does the request reach the Codex backend?
function expectCodex(
  session: string | undefined,
  base: string | undefined,
  requested: string | undefined,
): boolean {
  if (base === CODEX_URL) return true
  if (base === CUSTOM_URL) return false
  // The model the request runs: the explicit request, else the session's, else
  // the openai route default (a concrete id).
  const model = requested ?? session
  if (model === 'codexplan') return true // a shortcut overrides an unset OR default URL
  // A concrete request for the model the session's codexplan resolves to follows it.
  if (requested === 'gpt-5.6-sol' && session === 'codexplan') return true
  return false
}

const rows = SESSIONS.flatMap(session =>
  BASES.flatMap(base => REQUESTED.map(requested => ({ session, base, requested }))),
)

test('the table covers at least 30 rows', () => {
  expect(rows.length).toBeGreaterThanOrEqual(30)
})

test.each(rows)(
  'session=$session base=$base requested=$requested: resolver, teammate route, provider label and validation agree',
  async ({ session, base, requested }) => {
    const env: Record<string, string> = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-test',
      // Codex credentials with no account id: the Codex branch of validation
      // then fails deterministically, whatever is stored on this machine.
      CODEX_API_KEY: 'codex-test-key',
    }
    if (session) env.OPENAI_MODEL = session
    if (base) env.OPENAI_BASE_URL = base

    await withEnv(env, async () => {
      const wantCodex = expectCodex(session, base, requested)

      // 1. The resolver: transport follows the chosen URL.
      const request = resolveProviderRequest({
        model: requested,
        fallbackModel: getRouteDefaultModel('openai'),
      })
      expect(isCodexBackendRoute(request)).toBe(wantCodex)
      expect(request.transport === 'codex_responses').toBe(isCodexBaseUrl(request.baseUrl))
      if (wantCodex) expect(request.baseUrl).toBe(CODEX_URL)
      else expect(request.transport).not.toBe('codex_responses')

      // 2. The teammate route.
      expect(resolveTeammateProviderRoute({ model: requested, env: process.env }) === 'codex')
        .toBe(wantCodex)

      // 3. + 4. The session-level callers judge the session's own request.
      if (requested === undefined) {
        expect(getAPIProvider() === 'codex').toBe(wantCodex)
        const message = await getProviderValidationError(process.env)
        expect(message?.includes('chatgpt_account_id') ?? false).toBe(wantCodex)
        if (!wantCodex) expect(message).toBeNull()
      }
    })
  },
)

test('a profile / agentModels route is judged on its own URL, never the leader\'s session shortcut', () =>
  withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan' }, () => {
    // Concrete model on the profile's custom URL: not Codex, even with a session codexplan.
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-5.6-sol',
        profile: { provider: 'openai', baseUrl: CUSTOM_URL },
        env: process.env,
      }),
    ).toBe('custom')
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-5.6-sol',
        overrideBaseUrl: CUSTOM_URL,
        env: process.env,
      }),
    ).toBe('custom')
    // No model on a profile with the Codex URL: the URL decides.
    expect(
      resolveTeammateProviderRoute({
        profile: { provider: 'openai', baseUrl: CODEX_URL },
        env: process.env,
      }),
    ).toBe('codex')
    // A profile with the default OpenAI URL and a concrete model is plain openai.
    expect(
      resolveTeammateProviderRoute({
        model: 'gpt-6-astra',
        profile: { provider: 'openai', baseUrl: OPENAI_URL },
        env: process.env,
      }),
    ).toBe('openai')
  }),
)

test('an authoritative override URL beats both the shortcut and the session shortcut in the resolver', () =>
  withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan' }, () => {
    const override = resolveProviderRequest({
      model: 'gpt-5.6-sol',
      baseUrl: OPENAI_URL,
      baseUrlIsOverride: true,
    })
    expect(override).toMatchObject({ transport: 'responses', baseUrl: OPENAI_URL, resolvedModel: 'gpt-5.6-sol' })
    // Without the override flag the same URL is just the explicit endpoint, and
    // the session shortcut still wins over the default api.openai.com URL.
    const plain = resolveProviderRequest({ model: 'gpt-5.6-sol', baseUrl: OPENAI_URL })
    expect(plain).toMatchObject({ transport: 'codex_responses', baseUrl: CODEX_URL })
  }),
)

// ---------------------------------------------------------------------------
// An agentModels override that pins a base URL pins the route. A shortcut model
// on it is converted to its concrete id before it is written anywhere, so the
// parent guards, an in-process run, a pane child and a grandchild all resolve
// the same plain (concrete model, URL) pair.
// ---------------------------------------------------------------------------
type Tuple = { transport: string; baseUrl: string; resolvedModel: string }
const asTuple = (r: ReturnType<typeof resolveProviderRequest>): Tuple => ({
  transport: r.transport,
  baseUrl: r.baseUrl,
  resolvedModel: r.resolvedModel,
})

const OVERRIDE_CASES: [string, string][] = [
  ['codexplan', 'gpt-5.6-sol'],
  ['codexspark', 'gpt-5.3-codex-spark'],
  ['codexplan[1m]', 'gpt-5.6-sol'],
  ['gpt-5.6-sol', 'gpt-5.6-sol'],
]

function settingsFor(model: string, baseURL: string) {
  return {
    agentModels: { route: { model, base_url: baseURL, api_key: 'sk-override' } },
  } as never
}

function fourPaths(model: string, baseURL: string) {
  // Parent guard.
  const guardRoute = resolveTeammateProviderRoute({
    model,
    overrideBaseUrl: baseURL,
    env: process.env,
  })
  // In-process: the routing step, then the dispatch resolution with the override flag.
  const routing = resolveAgentRunModelRouting({
    resolvedAgentModel: 'x',
    parentModel: 'p',
    toolSpecifiedModel: 'route',
    settings: settingsFor(model, baseURL),
  })
  const inProcess = asTuple(
    resolveProviderRequest({
      model: routing.providerOverride!.model,
      baseUrl: routing.providerOverride!.baseURL,
      baseUrlIsOverride: true,
    }),
  )
  // Pane child: the override as resolved out-of-process, written as plain env.
  const out = resolveOutOfProcessTeammateProvider({
    cliModel: 'route',
    agentName: 'a',
    settings: settingsFor(model, baseURL),
  })!
  const childEnv: Record<string, string | undefined> = { OPENAI_MODEL: 'codexplan' }
  applyAgentProviderOverrideToEnv(out, childEnv)
  const pane = asTuple(resolveProviderRequest({ processEnv: childEnv as NodeJS.ProcessEnv }))
  return { guardRoute, inProcess, pane, childEnv, routing, out }
}

test.each(OVERRIDE_CASES)(
  'override {model:%s, baseURL: api.openai.com}: guard, in-process and pane child agree on public Responses (%s)',
  (model, wireModel) =>
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan', OPENAI_API_KEY: 'sk-leader' }, () => {
      const { guardRoute, inProcess, pane, childEnv, routing, out } = fourPaths(model, OPENAI_URL)
      expect(guardRoute).toBe('openai')
      expect(() =>
        assertKnownSubagentModel({ model, parentModel: 'something-else', overrideBaseUrl: OPENAI_URL }),
      ).not.toThrow(/provider 'codex'/)
      const expected = { transport: 'responses', baseUrl: OPENAI_URL, resolvedModel: wireModel }
      expect(inProcess).toEqual(expected)
      expect(pane).toEqual(expected)
      // Every producer hands out the same concrete model string.
      const canonical = canonicalizeOverrideModel(model, OPENAI_URL)
      expect(routing.mainLoopModel).toBe(canonical)
      expect(routing.providerOverride!.model).toBe(canonical)
      expect(out.model).toBe(canonical)
      expect(childEnv.OPENAI_MODEL).toBe(canonical)
    }),
)

test('applyAgentProviderOverrideToEnv itself writes the concrete model for a literal shortcut override', () => {
  const env: Record<string, string | undefined> = {}
  applyAgentProviderOverrideToEnv({ model: 'codexplan', baseURL: OPENAI_URL, apiKey: 'k' }, env)
  expect(env.OPENAI_MODEL).toBe('gpt-5.6-sol')
})

test.each(OVERRIDE_CASES)(
  'override {model:%s, baseURL: Codex URL}: guard, in-process and pane child all go to Codex (%s)',
  (model, wireModel) =>
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan', OPENAI_API_KEY: 'sk-leader' }, () => {
      const { guardRoute, inProcess, pane } = fourPaths(model, CODEX_URL)
      expect(guardRoute).toBe('codex')
      const expected = { transport: 'codex_responses', baseUrl: CODEX_URL, resolvedModel: wireModel }
      expect(inProcess).toEqual(expected)
      expect(pane).toEqual(expected)
    }),
)

test('an override with no base URL keeps the shortcut, which routes to Codex', () => {
  const childEnv: Record<string, string | undefined> = {}
  applyAgentProviderOverrideToEnv({ model: 'codexplan', baseURL: '', apiKey: 'sk-x' }, childEnv)
  expect(childEnv.OPENAI_MODEL).toBe('codexplan')
  delete childEnv.OPENAI_BASE_URL
  expect(
    asTuple(resolveProviderRequest({ processEnv: childEnv as NodeJS.ProcessEnv })),
  ).toEqual({ transport: 'codex_responses', baseUrl: CODEX_URL, resolvedModel: 'gpt-5.6-sol' })
  expect(canonicalizeOverrideModel('codexplan', undefined)).toBe('codexplan')
})

test('canonical form: only the shortcut base id changes; the user\'s query and [1m] pass through, tag last', () => {
  expect(canonicalizeOverrideModel('codexplan', OPENAI_URL)).toBe('gpt-5.6-sol')
  expect(canonicalizeOverrideModel('codexspark', OPENAI_URL)).toBe('gpt-5.3-codex-spark')
  expect(canonicalizeOverrideModel('codexplan[1m]', OPENAI_URL)).toBe('gpt-5.6-sol[1m]')
  expect(canonicalizeOverrideModel('codexplan?reasoning=low', OPENAI_URL)).toBe('gpt-5.6-sol?reasoning=low')
  // Both user orders land on one canonical order: base, ?query, [1m] last.
  expect(canonicalizeOverrideModel('codexplan[1m]?reasoning=low', OPENAI_URL)).toBe('gpt-5.6-sol?reasoning=low[1m]')
  expect(canonicalizeOverrideModel('codexplan?reasoning=low[1m]', OPENAI_URL)).toBe('gpt-5.6-sol?reasoning=low[1m]')
  // No synthesized query anywhere.
  for (const m of ['codexplan', 'codexspark', 'codexplan[1m]']) {
    expect(canonicalizeOverrideModel(m, OPENAI_URL)).not.toContain('?')
  }
  // Concrete and non-shortcut ids, and a URL-less override, pass through untouched.
  expect(canonicalizeOverrideModel('gpt-5.6-sol', OPENAI_URL)).toBe('gpt-5.6-sol')
  expect(canonicalizeOverrideModel('some-model', OPENAI_URL)).toBe('some-model')
  expect(canonicalizeOverrideModel('codexplan', undefined)).toBe('codexplan')
})

test.each(['codexplan[1m]?reasoning=low', 'codexplan?reasoning=low[1m]'])(
  'tag order %s: the known-id guards, the subagent guard and routing all agree on one canonical id and tuple',
  model =>
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_API_KEY: 'sk-leader' }, () => {
      const canonical = 'gpt-5.6-sol?reasoning=low[1m]'
      expect(canonicalizeOverrideModel(model, OPENAI_URL)).toBe(canonical)
      // The canonical id is a known id on the route it resolves to.
      expect(isKnownTeammateModel(canonical, 'openai')).toBe(true)
      expect(isKnownTeammateModel('gpt-5.6-sol[1m]?reasoning=low', 'openai')).toBe(true)
      expect(() =>
        assertKnownSubagentModel({ model, parentModel: 'something-else', overrideBaseUrl: OPENAI_URL }),
      ).not.toThrow()
      expect(() =>
        assertKnownSubagentModel({ model: canonical, parentModel: 'something-else', overrideBaseUrl: OPENAI_URL }),
      ).not.toThrow()
      const routing = resolveAgentRunModelRouting({
        resolvedAgentModel: 'x',
        parentModel: 'p',
        toolSpecifiedModel: 'route',
        settings: settingsFor(model, OPENAI_URL),
      })
      expect(routing.providerOverride!.model).toBe(canonical)
      expect(
        asTuple(
          resolveProviderRequest({
            model: routing.providerOverride!.model,
            baseUrl: OPENAI_URL,
            baseUrlIsOverride: true,
          }),
        ),
      ).toEqual({ transport: 'responses', baseUrl: OPENAI_URL, resolvedModel: 'gpt-5.6-sol' })
    }),
)

test('display: a canonical id with a query/tag shows its base model name', () =>
  withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'gpt-5.6-sol' }, () => {
    for (const id of ['gpt-5.6-sol?reasoning=low[1m]', 'gpt-5.6-sol[1m]', 'gpt-5.6-sol?reasoning=high']) {
      expect(getPublicModelDisplayName(id)).toBe('GPT-5.6 Sol')
    }
  }),
)

// The default effort rides on the model's own metadata, never on a synthesized
// id. Through the real client path (getAnthropicClient with the effort value
// claude.ts computes) a bare gpt-5.6-sol override sends `high` on both URLs.
async function overrideRequestBody(
  model: string,
  baseURL: string,
  viaClient: boolean,
): Promise<{ url: string; reasoning: unknown }> {
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test-version' }
  const realFetch = globalThis.fetch
  let url = ''
  let reasoning: unknown
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    url = String(input)
    reasoning = (JSON.parse(String(init?.body)) as { reasoning?: unknown }).reasoning
    return new Response(
      JSON.stringify({
        id: 'r', model: 'gpt-5.6-sol',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const providerOverride = { model, baseURL, apiKey: 'sk-o' }
    let client: { beta: { messages: { create: (p: unknown) => Promise<unknown> } } }
    if (viaClient) {
      const { getAnthropicClient } = await import('./client.js')
      const { resolveAppliedEffort } = await import('../../utils/effort.js')
      client = (await getAnthropicClient({
        maxRetries: 0,
        model,
        providerOverride,
        effortValue: resolveAppliedEffort(model, undefined),
      })) as never
    } else {
      const { createOpenAIShimClient } = await import('./openaiShim.js')
      client = createOpenAIShimClient({ providerOverride }) as never
    }
    await client.beta.messages
      .create({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false })
      .catch(() => {})
  } finally {
    globalThis.fetch = realFetch
  }
  return { url, reasoning }
}

test.each([OPENAI_URL, CODEX_URL])(
  'effort: a URL-pinned codexplan override sends the default high on %s through the real client path',
  baseURL =>
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan', OPENAI_API_KEY: 'sk-leader', CODEX_API_KEY: 'codex-test-key', CHATGPT_ACCOUNT_ID: 'acct-test' }, async () => {
      const canonical = canonicalizeOverrideModel('codexplan', baseURL)
      expect(canonical).toBe('gpt-5.6-sol')
      const { url, reasoning } = await overrideRequestBody(canonical, baseURL, true)
      expect(url.startsWith(baseURL)).toBe(true)
      expect((reasoning as { effort?: string } | undefined)?.effort).toBe('high')
    }),
)

test.each([OPENAI_URL, CODEX_URL])(
  'effort: the user\'s own ?reasoning=low in the override model wins at the request layer on %s',
  baseURL =>
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: 'codexplan', OPENAI_API_KEY: 'sk-leader', CODEX_API_KEY: 'codex-test-key', CHATGPT_ACCOUNT_ID: 'acct-test' }, async () => {
      const canonical = canonicalizeOverrideModel('codexplan?reasoning=low', baseURL)
      expect(canonical).toBe('gpt-5.6-sol?reasoning=low')
      const { reasoning } = await overrideRequestBody(canonical, baseURL, false)
      expect((reasoning as { effort?: string } | undefined)?.effort).toBe('low')
    }),
)

test('grandchild: the env a pane child forwards resolves like the parent guard says (public OpenAI), not Codex', () =>
  withEnv({}, () => {
    const childEnv: Record<string, string | undefined> = {}
    applyAgentProviderOverrideToEnv(
      { model: 'codexplan', baseURL: OPENAI_URL, apiKey: 'sk-override' },
      childEnv,
    )
    // The pane child itself runs buildInheritedEnvVars() to launch a grandchild.
    Object.assign(process.env, childEnv)
    const command = buildInheritedEnvVars()
    const forwarded: Record<string, string> = {}
    for (const m of command.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=(?:'([^']*)'|(\S*))/g)) {
      // shell-quote backslash-escapes characters such as ':' and '?' in bare values.
      forwarded[m[1]!] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
    }
    expect(forwarded.OPENAI_BASE_URL).toBe(OPENAI_URL)
    expect(forwarded.OPENAI_MODEL).toBe('gpt-5.6-sol')
    expect(
      asTuple(resolveProviderRequest({ processEnv: forwarded as NodeJS.ProcessEnv })),
    ).toEqual({ transport: 'responses', baseUrl: OPENAI_URL, resolvedModel: 'gpt-5.6-sol' })
    expect(resolveTeammateProviderRoute({ env: forwarded })).toBe('openai')
  }),
)

test('profile replacement: a later saved (non-override) profile at the same URL with codexplan routes by shortcut policy, in the request and the bound-profile classifier alike', () => {
  const env: Record<string, string | undefined> = {}
  applyAgentProviderOverrideToEnv(
    { model: 'codexplan', baseURL: OPENAI_URL, apiKey: 'sk-override' },
    env,
  )
  clearManagedProfileEnv(env as NodeJS.ProcessEnv)
  const next = buildCompatibilityProcessEnv({
    compatibilityMode: 'openai',
    profileEnv: {
      OPENAI_BASE_URL: OPENAI_URL,
      OPENAI_MODEL: 'codexplan',
      OPENAI_API_KEY: 'sk-profile',
    },
    processEnv: env as NodeJS.ProcessEnv,
  })
  const request = asTuple(resolveProviderRequest({ processEnv: next }))
  expect(request).toEqual({ transport: 'codex_responses', baseUrl: CODEX_URL, resolvedModel: 'gpt-5.6-sol' })
  expect(
    resolveTeammateProviderRoute({
      model: 'codexplan',
      profile: { provider: 'openai', baseUrl: OPENAI_URL },
    }),
  ).toBe('codex')
})

test('pane child dispatch: the canonical override model sends the override key to api.openai.com with no chatgpt-account-id', async () => {
  const out = resolveOutOfProcessTeammateProvider({
    cliModel: 'route',
    agentName: 'a',
    settings: settingsFor('codexplan', OPENAI_URL),
  })!
  const childEnv: Record<string, string | undefined> = { OPENAI_MODEL: 'codexplan' }
  applyAgentProviderOverrideToEnv(
    { ...out, apiKey: 'sk-override-key' },
    childEnv,
  )
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, saved, childEnv)
  const realFetch = globalThis.fetch
  let url = ''
  let headers: Headers | undefined
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    url = String(input)
    headers = new Headers(init?.headers)
    return new Response(
      JSON.stringify({
        id: 'r', model: 'gpt-5.6-sol',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const { createOpenAIShimClient } = await import('./openaiShim.js')
    const client = createOpenAIShimClient({}) as {
      beta: { messages: { create: (p: unknown) => Promise<unknown> } }
    }
    await client.beta.messages.create({
      model: childEnv.OPENAI_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      stream: false,
    })
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(headers?.get('authorization')).toBe('Bearer sk-override-key')
    expect(headers?.has('chatgpt-account-id')).toBe(false)
  } finally {
    globalThis.fetch = realFetch
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})
