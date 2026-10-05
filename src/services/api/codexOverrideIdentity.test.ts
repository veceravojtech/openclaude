import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { getMainLoopModel, getUserSpecifiedModelSetting } from '../../utils/model/model.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  applyAgentProviderOverrideToEnv,
  assertAgentRunModelAllowed,
  assertRoutedTeammateProviderAllowed,
  resolveAgentRunModelRouting,
  resolveOutOfProcessTeammateProvider,
} from './agentRouting.js'

// The model id is an identity: the org allowlist, custom pricing and usage
// buckets match it exactly. A URL-pinned codexplan override is canonicalized to
// `gpt-5.6-sol` with NO synthesized query, so those still match.

const OPENAI_URL = 'https://api.openai.com/v1'

let originalSources: ReturnType<typeof getAllowedSettingSources>
let originalFlagPath: string | undefined
let originalFlagInline: Record<string, unknown> | null

beforeEach(async () => {
  await acquireSharedMutationLock('services/api/codexOverrideIdentity.test.ts')
  originalSources = [...getAllowedSettingSources()]
  originalFlagPath = getFlagSettingsPath()
  originalFlagInline = getFlagSettingsInline()
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsPath(undefined)
})

afterEach(() => {
  try {
    setAllowedSettingSources(originalSources)
    setFlagSettingsPath(originalFlagPath)
    setFlagSettingsInline(originalFlagInline)
    resetSettingsCache()
  } finally {
    releaseSharedMutationLock()
  }
})

function useSettings(settings: Record<string, unknown>): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

function overrideSettingsFor(model: string) {
  return {
    agentModels: {
      route: { model, base_url: OPENAI_URL, api_key: 'sk-override' },
    },
  }
}
const overrideSettings = overrideSettingsFor('codexplan')

// The REAL gates, not mirrors: runAgent calls assertAgentRunModelAllowed and the
// AgentTool pane preflight calls assertRoutedTeammateProviderAllowed.
function runAgentGateAllows(configured = 'codexplan', settings = overrideSettingsFor(configured)): {
  model: string
  allowed: boolean
} {
  const routing = resolveAgentRunModelRouting({
    resolvedAgentModel: 'inherited-model',
    parentModel: 'inherited-model',
    toolSpecifiedModel: 'route',
    settings: settings as never,
  })
  try {
    assertAgentRunModelAllowed('inherited-model', routing.mainLoopModel, routing.providerOverride)
    return { model: routing.mainLoopModel, allowed: true }
  } catch {
    return { model: routing.mainLoopModel, allowed: false }
  }
}

function paneGateAllows(configured = 'codexplan', settings = overrideSettingsFor(configured)): boolean {
  const routed = resolveOutOfProcessTeammateProvider({
    cliModel: 'route',
    agentName: 'a',
    settings: settings as never,
  })!
  try {
    assertRoutedTeammateProviderAllowed(routed)
    return true
  } catch {
    return false
  }
}

// The pane child's effective main-loop model: the env the override wrote, with no
// state beyond it (so a grandchild inheriting that env behaves identically).
function paneChildMainLoopModel(configured: string): string {
  const routed = resolveOutOfProcessTeammateProvider({
    cliModel: 'route',
    agentName: 'a',
    settings: overrideSettingsFor(configured) as never,
  })!
  const env: Record<string, string | undefined> = {}
  applyAgentProviderOverrideToEnv(routed, env)
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    return getMainLoopModel()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

test('allowlist: a URL-pinned codexplan override is allowed when the org lists codexplan and gpt-5.6-sol', () => {
  useSettings({ ...overrideSettings, availableModels: ['codexplan', 'gpt-5.6-sol'] })
  const { model, allowed } = runAgentGateAllows()
  expect(model).toBe('gpt-5.6-sol')
  expect(allowed).toBe(true)
  // The canonical id carries no query, so the exact allowlist match holds.
  expect(isModelAllowed('gpt-5.6-sol')).toBe(true)
  expect(isModelAllowed('gpt-5.6-sol?reasoning=high')).toBe(false)
})

test('allowlist: it is rejected when the org allows only unrelated models', () => {
  useSettings({ ...overrideSettings, availableModels: ['gpt-4o'] })
  expect(runAgentGateAllows().allowed).toBe(false)
})

test('pricing: the canonical override model is priced by its custom gpt-5.6-sol entry', () => {
  const price = {
    inputTokens: 1,
    outputTokens: 2,
    promptCacheReadTokens: 0,
    promptCacheWriteTokens: 0,
    webSearchRequests: 0,
  }
  useSettings({ ...overrideSettings, modelPricing: { 'gpt-5.6-sol': price } })
  const routing = resolveAgentRunModelRouting({
    resolvedAgentModel: 'inherited-model',
    parentModel: 'inherited-model',
    toolSpecifiedModel: 'route',
    settings: overrideSettings as never,
  })
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 } as never
  // 1M input at $1 + 1M output at $2.
  expect(calculateUSDCost(routing.providerOverride!.model, usage)).toBe(3)
  // A synthesized-query id would have missed the exact-id price (unknown-model fallback).
  expect(calculateUSDCost('gpt-5.6-sol?reasoning=high', usage)).not.toBe(3)
})

// ---------------------------------------------------------------------------
// The configured shortcut still passes an allowlist written against it, at every
// gate a canonical override passes through: runAgent, the AgentTool pane
// preflight and the pane child's own startup.
// ---------------------------------------------------------------------------
const ALLOWLIST_CASES: [string, string, string, boolean][] = [
  ['codexplan', 'gpt-5.6-sol', 'codexplan', true],
  ['codexplan', 'gpt-5.6-sol', 'gpt-5.6-sol', true],
  ['codexplan', 'gpt-5.6-sol', 'gpt-4o', false],
  ['codexspark', 'gpt-5.3-codex-spark', 'codexspark', true],
  ['codexspark', 'gpt-5.3-codex-spark', 'gpt-5.3-codex-spark', true],
  ['codexspark', 'gpt-5.3-codex-spark', 'gpt-4o', false],
]

test.each(ALLOWLIST_CASES)(
  'availableModels [%s-configured override -> %s] listing only %s: allowed=%s at the runAgent gate and the pane preflight',
  (configured, canonical, listed, allowed) => {
    useSettings({ ...overrideSettingsFor(configured), availableModels: [listed] })
    const run = runAgentGateAllows(configured)
    expect(run.model).toBe(canonical)
    expect(run.allowed).toBe(allowed)
    expect(paneGateAllows(configured)).toBe(allowed)
  },
)

test('isModelAllowed itself is not loosened: the canonical id alone is still refused', () => {
  useSettings({ availableModels: ['codexplan'] })
  expect(isModelAllowed('gpt-5.6-sol')).toBe(false)
  expect(isModelAllowed('codexplan')).toBe(true)
})

test('no over-authorization: a route configured directly as gpt-5.6-sol stays refused after a codexplan override ran', () => {
  const direct = {
    agentModels: {
      route: { model: 'gpt-5.6-sol', base_url: 'https://proxy.example/v1', api_key: 'sk-proxy' },
    },
  }
  useSettings({ ...direct, availableModels: ['codexplan'] })
  // Before any shortcut override is processed ...
  expect(runAgentGateAllows('gpt-5.6-sol', direct).allowed).toBe(false)
  expect(paneGateAllows('gpt-5.6-sol', direct)).toBe(false)
  // ... a URL-pinned codexplan override is processed (it is admitted by its original) ...
  useSettings({ ...overrideSettingsFor('codexplan'), availableModels: ['codexplan'] })
  expect(runAgentGateAllows('codexplan').allowed).toBe(true)
  expect(paneGateAllows('codexplan')).toBe(true)
  expect(paneChildMainLoopModel('codexplan')).toBe('gpt-5.6-sol')
  // ... and the directly configured route is still refused at both real gates.
  useSettings({ ...direct, availableModels: ['codexplan'] })
  expect(runAgentGateAllows('gpt-5.6-sol', direct).allowed).toBe(false)
  expect(paneGateAllows('gpt-5.6-sol', direct)).toBe(false)
})

test('pane child (and so a grandchild) under [codexplan]: no state needed, the main-loop model is still gpt-5.6-sol', () => {
  useSettings({ ...overrideSettingsFor('codexplan'), availableModels: ['codexplan'] })
  expect(paneChildMainLoopModel('codexplan')).toBe('gpt-5.6-sol')
  // The inherited OPENAI_MODEL alone — no registry — gives the same answer.
  const saved = process.env.OPENAI_MODEL
  const savedFlag = process.env.CLAUDE_CODE_USE_OPENAI
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  try {
    expect(getUserSpecifiedModelSetting()).toBeUndefined()
    expect(getMainLoopModel()).toBe('gpt-5.6-sol')
  } finally {
    if (saved === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = saved
    if (savedFlag === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = savedFlag
  }
})
