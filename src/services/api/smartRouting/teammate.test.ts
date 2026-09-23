import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ProviderProfile } from '../../../utils/config.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import type { JevRequest, JevResult } from '../../jev/client.js'
import {
  _resetTeammateDispatchWarningsForTesting,
  _setTeammateDispatchDepsForTesting,
  chooseTeammateRoute,
  agentTypeOptionsFor,
  classifyRoleHeuristic,
  describeSpawnableModel,
  listSpawnableModels,
  collectExcludedFamilies,
  DEFAULT_TIER_FAMILIES,
  familyOfModel,
  formatDispatchSummary,
  hasNamedAgentRouting,
  readTeammateDispatchSettings,
  separationFamilyOf,
  pruneRouteCatalog,
  toDispatchRecord,
  vendorOf,
  type TeamMemberLike,
  type TeammateDispatchDeps,
} from './teammate.js'

const deepseekProfile: ProviderProfile = {
  id: 'prof_deepseek',
  name: 'DeepSeek',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-pro, deepseek-flash',
  apiKey: 'sk-test-not-real',
}

const zaiProfile: ProviderProfile = {
  id: 'prof_zai',
  name: 'Z.ai',
  provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  model: 'glm-5.3, glm-5.3-flash',
  apiKey: 'zai-test-not-real',
}

type JevCall = { req: JevRequest; opts?: { timeoutMs?: number } }

let jevCalls: JevCall[]
let members: TeamMemberLike[]

function jevOk(
  role: string,
  probabilities: Record<string, number>,
  complexity = 1,
): JevResult {
  return {
    ok: true,
    answers: {
      role: { type: 'choice', choice: role, probabilities },
      complexity: { type: 'score', score: complexity },
      needs_long_context: { type: 'boolean', probability: 0.1 },
    },
    latencyMs: 42,
    cached: false,
    costUsd: 0.0004,
  }
}

function withModel(
  result: JevResult,
  choice: string,
  probabilities: Record<string, number>,
  type?: { choice: string; probabilities: Record<string, number> },
): JevResult {
  if (!result.ok) return result
  return {
    ...result,
    answers: {
      ...result.answers,
      model: { type: 'choice', choice, probabilities },
      ...(type ? { agent_type: { type: 'choice' as const, ...type } } : {}),
    },
  }
}

const codexProfile: ProviderProfile = {
  id: 'prof_codex',
  name: 'Codex',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'codexplan',
}

function setDeps(overrides: Partial<TeammateDispatchDeps> = {}): void {
  _setTeammateDispatchDepsForTesting({
    isJevConfigured: () => false,
    evaluateJev: async (req, opts) => {
      jevCalls.push({ req, opts })
      return { ok: false, reason: 'no_key', latencyMs: 0 }
    },
    readTeamMembers: () => members,
    leaderRoute: () => 'anthropic',
    hasAnthropicAuth: () => true,
    providerProfiles: () => [],
    isModelAllowed: () => true,
    ...overrides,
  })
}

beforeEach(() => {
  jevCalls = []
  members = []
  _resetTeammateDispatchWarningsForTesting()
  setDeps()
})

afterEach(() => {
  _setTeammateDispatchDepsForTesting(undefined)
})

const settings = (extra: SettingsJson = {}): SettingsJson => extra

describe('heuristic role detection', () => {
  const cases: Array<[string, Parameters<typeof classifyRoleHeuristic>[0], string]> = [
    ['research', { description: 'Investigate auth flow', prompt: 'Explore src/auth and find where tokens are read. Report findings — do not modify files.' }, 'research'],
    ['implement', { description: 'Implement retry fix', prompt: 'Fix the null check in validate.ts, add a test and commit.' }, 'implement'],
    ['review', { description: 'Review the auth diff', prompt: 'Critique this diff for correctness.' }, 'review'],
    ['verify', { description: 'Verify the retry fix', prompt: 'Prove it works; run the tests and try edge cases.' }, 'verify'],
    ['design', { description: 'Design the cache architecture', prompt: 'Plan the architecture and weigh trade-offs.' }, 'design'],
    ['computer_use', { description: 'Browser smoke test via Playwright', prompt: 'Open the page in the browser, click login and take a screenshot.' }, 'computer_use'],
  ]
  for (const [label, input, expected] of cases) {
    test(`detects ${label}`, () => {
      const result = classifyRoleHeuristic(input)
      expect(result.role).toBe(expected as never)
      expect(result.confident).toBe(true)
    })
  }

  test('names and agent types count', () => {
    expect(classifyRoleHeuristic({ name: 'reviewer' }).role).toBe('review')
    expect(classifyRoleHeuristic({ subagent_type: 'Explore' }).role).toBe('research')
  })

  test('"do not modify files" does not read as implement', () => {
    const result = classifyRoleHeuristic({
      description: 'Survey the tests',
      prompt: 'Do not modify files. Do not commit.',
    })
    expect(result.scores.implement).toBe(0)
  })

  test('an ambiguous task is not confident', () => {
    expect(classifyRoleHeuristic({ description: 'Handle the thing' }).confident).toBe(false)
  })
})

describe('JEV classification', () => {
  const ambiguous = { description: 'Handle the payments module', prompt: 'Take care of the payments module.' }

  test('a confident JEV answer is accepted', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return jevOk('review', { review: 0.86, implement: 0.1, research: 0.04 })
      },
    })
    const decision = await chooseTeammateRoute({ ...ambiguous, settings: settings() })
    expect(jevCalls).toHaveLength(1)
    expect(Object.keys(jevCalls[0]!.req.questions).sort()).toEqual([
      'complexity',
      'model',
      'needs_long_context',
      'role',
    ])
    expect(decision.source).toBe('jev')
    expect(decision.role).toBe('review')
    expect(decision.family).toBe('fable-5.1')
    expect(decision.costUsd).toBe(0.0004)
    expect(decision.probabilities?.review).toBe(0.86)
    expect(formatDispatchSummary(decision)).toBe('dispatch: review → fable-5.1 (role jev p=0.86; model tier, jev gave no model)')
  })

  test('an unconfident JEV answer falls back to the heuristic', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return jevOk('design', { design: 0.5, implement: 0.45 })
      },
    })
    const decision = await chooseTeammateRoute({ ...ambiguous, settings: settings() })
    expect(jevCalls).toHaveLength(1)
    expect(decision.source).toBe('heuristic')
    expect(decision.role).toBe('implement')
    expect(decision.reason).toContain('jev not confident: design p=0.50')
  })

  test('JEV is called even when the heuristic is confident', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return withModel(jevOk('review', { review: 0.9, verify: 0.05 }), 'claude-opus-5-5', {
          'claude-opus-5-5': 0.88,
          'claude-fable-5-1': 0.08,
        })
      },
    })
    expect(classifyRoleHeuristic({ description: 'Review the auth diff', prompt: 'Critique it.' }).confident).toBe(true)
    const decision = await chooseTeammateRoute({
      description: 'Review the auth diff',
      prompt: 'Critique it.',
      settings: settings(),
    })
    expect(jevCalls).toHaveLength(1)
    expect(decision.role).toBe('review')
    expect(decision.source).toBe('jev')
    expect(decision.model).toBe('claude-opus-5-5')
    expect(formatDispatchSummary(decision)).toStartWith('dispatch: review → opus-5.5 (role jev p=0.90; model jev p=0.88')
  })

  test('JEV failure is non-blocking', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async () => {
        throw new Error('boom')
      },
    })
    const decision = await chooseTeammateRoute({ ...ambiguous, settings: settings() })
    expect(decision.role).toBe('implement')
    expect(decision.model).toBe('claude-sonnet-5')
    expect(decision.reason).toContain('jev error: boom')
  })

  test('a hanging JEV call is cut off at the timeout', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: () => new Promise<JevResult>(() => {}),
    })
    const started = Date.now()
    const decision = await chooseTeammateRoute({
      ...ambiguous,
      settings: settings({ teammateDispatch: { jev: { timeoutMs: 50 } } }),
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(decision.reason).toContain('jev timeout')
    expect(decision.model).toBe('claude-sonnet-5')
  })

  test('jev.enabled=false never calls JEV', async () => {
    setDeps({ isJevConfigured: () => true })
    await chooseTeammateRoute({
      ...ambiguous,
      settings: settings({ teammateDispatch: { jev: { enabled: false } } }),
    })
    expect(jevCalls).toHaveLength(0)
  })

  test('JEV hard complexity bumps implement to deep', async () => {
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async () => jevOk('implement', { implement: 0.9, design: 0.05 }, 2),
    })
    const decision = await chooseTeammateRoute({ ...ambiguous, settings: settings() })
    expect(decision.tier).toBe('deep')
    expect(decision.family).toBe('fable-5.1')
  })
})

describe('policy and candidates', () => {
  test('each tier picks the first configured family', async () => {
    const review = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect([review.tier, review.family, review.model]).toEqual(['deep', 'fable-5.1', 'claude-fable-5-1'])
    const impl = await chooseTeammateRoute({ description: 'Implement the fix', settings: settings() })
    expect([impl.tier, impl.family, impl.model]).toEqual(['standard', 'sonnet-5', 'claude-sonnet-5'])
  })

  test('fast tier on a DeepSeek leader picks the flash model', async () => {
    setDeps({ leaderRoute: () => 'deepseek' })
    const decision = await chooseTeammateRoute({
      description: 'Research quick lookup',
      prompt: 'Find the trivial config key.',
      settings: settings(),
    })
    expect(decision.role).toBe('research')
    expect(decision.tier).toBe('fast')
    expect(decision.model).toBe('deepseek-flash')
  })

  test('hard implement is bumped one tier deeper', async () => {
    const decision = await chooseTeammateRoute({
      description: 'Implement the fix',
      prompt: 'Fix a subtle race condition in the scheduler.',
      settings: settings(),
    })
    expect(decision.complexity).toBe('hard')
    expect(decision.tier).toBe('deep')
  })

  test('computer_use picks a vision-capable fast model from the catalog', async () => {
    // Leader on DeepSeek; GLM via a saved profile. deepseek-v4-pro has no
    // vision in the catalog, so a policy that lists it first must skip it.
    setDeps({ leaderRoute: () => 'deepseek', providerProfiles: () => [zaiProfile] })
    const fast = await chooseTeammateRoute({ description: 'Browser test with Playwright', settings: settings() })
    expect(fast.role).toBe('computer_use')
    expect(fast.model).toBe('deepseek-flash')
    const skipped = await chooseTeammateRoute({
      description: 'Browser test with Playwright',
      settings: settings({
        teammateDispatch: { policy: { tiers: { fast: ['deepseek-v4-pro', 'glm-5.3'] } } },
      }),
    })
    expect(skipped.model).toBe('glm-5.3-flash')
    expect(skipped.providerProfile).toBe('prof_zai')
  })

  test('candidates exclude unconfigured routes', async () => {
    // Anthropic not authenticated: no Claude, and no profiles → default model.
    setDeps({ hasAnthropicAuth: () => false })
    const decision = await chooseTeammateRoute({ description: 'Implement the fix', settings: settings() })
    expect(decision.model).toBeUndefined()
    expect(decision.warning).toContain('spawning on the default model')
  })

  test('saved profiles make other routes usable, ordered by tier list', async () => {
    setDeps({ hasAnthropicAuth: () => false, providerProfiles: () => [zaiProfile, deepseekProfile] })
    const decision = await chooseTeammateRoute({ description: 'Implement the fix', settings: settings() })
    expect(decision.family).toBe('deepseek-v4-pro')
    expect(decision.providerProfile).toBe('prof_deepseek')
  })

  test('in-process spawns only use the leader route', async () => {
    setDeps({ hasAnthropicAuth: () => false, providerProfiles: () => [deepseekProfile] })
    const decision = await chooseTeammateRoute({
      description: 'Implement the fix',
      settings: settings(),
      allowProfileBinding: false,
    })
    expect(decision.model).toBeUndefined()
  })

  test('candidates exclude families the allowlist does not admit', async () => {
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      settings: settings({ teammateModelAllowlist: ['opus-5.5', 'sonnet-5'] }),
    })
    expect(decision.family).toBe('opus-5.5')
  })

  test('gpt-5.6 is only a candidate under the wildcard allowlist', async () => {
    setDeps({ leaderRoute: () => 'codex', hasAnthropicAuth: () => false })
    // Unset allowlist: no gpt-5.6, so standard is empty and it climbs to gpt-6.
    const unset = await chooseTeammateRoute({ description: 'Implement the fix', settings: settings() })
    expect(unset.family).toBe('gpt-6')
    const wildcard = await chooseTeammateRoute({
      description: 'Implement the fix',
      settings: settings({ teammateModelAllowlist: ['*'] }),
    })
    expect(wildcard.model).toBe('gpt-5.6-sol')
    const fast = await chooseTeammateRoute({
      description: 'Browser test with Playwright',
      settings: settings({ teammateModelAllowlist: ['*'] }),
    })
    expect(fast.model).toBe('gpt-5.6-luna')
  })

  test('organization model allowlist is honoured', async () => {
    setDeps({ isModelAllowed: model => model !== 'claude-fable-5-1' })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect(decision.family).toBe('opus-5.5')
  })

  test('unknown policy families warn once and do not crash', () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    try {
      const policy = { policy: { tiers: { deep: ['nope-1', 'opus-5.5'] }, roles: { reviewer: 'deep' } } }
      readTeammateDispatchSettings(settings({ teammateDispatch: policy }))
      const config = readTeammateDispatchSettings(settings({ teammateDispatch: policy }))
      expect(config.tierFamilies.deep).toEqual(['opus-5.5'])
      expect(config.tierFamilies.standard).toEqual([...DEFAULT_TIER_FAMILIES.standard])
    } finally {
      console.warn = original
    }
    expect(warnings.filter(w => w.includes('nope-1'))).toHaveLength(1)
    expect(warnings.filter(w => w.includes('reviewer'))).toHaveLength(1)
  })
})

describe('separation rule', () => {
  test('a reviewer after an implementer on sonnet-5 never gets sonnet-5', async () => {
    members = [{ name: 'dev', role: 'implement', family: 'sonnet-5', model: 'claude-sonnet-5' }]
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      teamName: 't',
      name: 'rev',
      // Policy puts sonnet-5 first for review; separation must still skip it.
      settings: settings({ teammateDispatch: { policy: { tiers: { deep: ['sonnet-5', 'opus-5.5'] } } } }),
    })
    expect(decision.family).toBe('opus-5.5')
    expect(decision.excluded).toEqual([{ family: 'claude-sonnet', by: 'dev' }])
    expect(formatDispatchSummary(decision)).toContain('excluded claude-sonnet used by dev')
  })

  test('verify is separated too, falling to the next tier down when needed', async () => {
    members = [{ name: 'dev', role: 'implement', family: 'sonnet-5' }]
    setDeps({ leaderRoute: () => 'anthropic', providerProfiles: () => [] })
    const decision = await chooseTeammateRoute({
      description: 'Verify the fix',
      teamName: 't',
      settings: settings({ teammateDispatch: { policy: { tiers: { standard: ['sonnet-5'], fast: [] } } } }),
    })
    // standard empty after exclusion, fast empty → climbs to deep.
    expect(decision.family).toBe('fable-5.1')
    expect(decision.reason).toContain('standard tier unavailable, used deep')
  })

  test('an explicit same-family review model is refused', async () => {
    members = [{ name: 'dev', role: 'implement', family: 'sonnet-5' }]
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      teamName: 't',
      name: 'rev',
      explicitModel: 'claude-sonnet-5',
      settings: settings(),
    })
    expect(decision.refusal).toContain("'dev' implemented with claude-sonnet")
    expect(decision.refusal).toContain("teammate 'rev'")
    expect(decision.refusal).toContain('fable-5.1')
  })

  test('an explicit non-review model is respected', async () => {
    members = [{ name: 'dev', role: 'implement', family: 'sonnet-5' }]
    const decision = await chooseTeammateRoute({
      description: 'Implement another part',
      teamName: 't',
      explicitModel: 'claude-sonnet-5',
      settings: settings(),
    })
    expect(decision.refusal).toBeUndefined()
    expect(decision.source).toBe('explicit')
    expect(decision.model).toBe('claude-sonnet-5')
  })

  test('a reviewer with no allowed model outside the implementer family is refused, not defaulted', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      name: 'rev',
      teamName: 't',
      settings: settings({ teammateModelAllowlist: ['sonnet-5'] }),
    })
    expect(decision.role).toBe('review')
    expect(decision.model).toBeUndefined()
    expect(decision.modelSource).toBe('none')
    expect(decision.refusal).toContain("Refusing to spawn review teammate 'rev'")
    expect(decision.refusal).toContain('claude-sonnet used by dev')
    expect(decision.refusal).toContain('Widen teammateModelAllowlist')
    expect(decision.refusal).toContain('model from another family')
  })

  test('a role without separation still spawns on the default with a warning when nothing is allowed', async () => {
    const decision = await chooseTeammateRoute({
      description: 'Implement the fix',
      settings: settings({ teammateModelAllowlist: ['sonnet-5'] }),
      prompt: 'Fix the bug and commit.',
    })
    // sonnet-5 is allowed and fits implement: no refusal.
    expect(decision.refusal).toBeUndefined()
    expect(decision.model).toBe('claude-sonnet-5')
    setDeps({ hasAnthropicAuth: () => false })
    const none = await chooseTeammateRoute({
      description: 'Implement the fix',
      settings: settings({ teammateModelAllowlist: ['sonnet-5'] }),
    })
    expect(none.refusal).toBeUndefined()
    expect(none.model).toBeUndefined()
    expect(none.warning).toContain('spawning on the default model')
  })

  test('an explicit (e.g. inherited leader) model in the implementer family is refused for a reviewer', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-opus-5-5' }]
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      name: 'rev',
      teamName: 't',
      explicitModel: 'claude-opus-4-8',
      settings: settings(),
    })
    expect(decision.refusal).toContain("'dev' implemented with claude-opus")
  })

  test('old teams without role data exclude every non-review member family', () => {
    const excluded = collectExcludedFamilies(
      [
        { name: 'worker', model: 'claude-opus-5-5' },
        { name: 'reviewer-old', model: 'claude-fable-5-1' },
        { name: 'inheritor' },
        { name: 'scout', role: 'research', family: 'glm-5.3' },
      ],
      'sonnet',
    )
    expect(excluded).toEqual([
      { family: 'claude-opus', by: 'worker' },
      { family: 'claude-sonnet', by: 'inheritor' },
    ])
  })
})

describe('modes and helpers', () => {
  test('mode off does nothing', async () => {
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      settings: settings({ teammateDispatch: { mode: 'off' } }),
    })
    expect(decision.source).toBe('off')
    expect(decision.model).toBeUndefined()
  })

  test('mode suggest still computes the choice and marks it', async () => {
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      settings: settings({ teammateDispatch: { mode: 'suggest' } }),
    })
    expect(decision.mode).toBe('suggest')
    expect(decision.family).toBe('fable-5.1')
    expect(formatDispatchSummary(decision)).toContain('[suggest only — not applied]')
  })

  test('familyOfModel resolves ids, aliases and route variants', () => {
    expect(familyOfModel('claude-sonnet-5')).toBe('sonnet-5')
    expect(familyOfModel('claude-opus-5-5[1m]')).toBe('opus-5.5')
    expect(familyOfModel('glm-5.3-flash')).toBe('glm-5.3')
    expect(familyOfModel('gpt-5.6-luna')).toBe('gpt-5.6')
    expect(familyOfModel('some-local-model')).toBeUndefined()
    expect(familyOfModel('inherit')).toBeUndefined()
  })

  test('hasNamedAgentRouting ignores the default key', () => {
    const s = settings({ agentRouting: { default: 'x', 'code_reviewer': 'y' } })
    expect(hasNamedAgentRouting('rev', undefined, s)).toBe(false)
    expect(hasNamedAgentRouting('code-reviewer', undefined, s)).toBe(true)
  })
})

describe('JEV model and agent-type choice', () => {
  const jevWith = (result: JevResult) =>
    setDeps({
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return result
      },
    })

  test('the "*" candidate list includes gpt-5.6-luna and claude-sonnet-4-6', async () => {
    setDeps({ providerProfiles: () => [codexProfile, zaiProfile, deepseekProfile] })
    const { candidates } = listSpawnableModels({ settings: settings({ teammateModelAllowlist: ['*'] }) })
    const ids = candidates.map(c => c.id)
    expect(ids).toContain('gpt-5.6-luna')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('glm-5.3')
    expect(ids).toContain('deepseek-v4-pro')
    expect(candidates.find(c => c.id === 'gpt-5.6-luna')?.providerProfile).toBe('prof_codex')
    expect(candidates.find(c => c.id === 'claude-sonnet-4-6')?.providerProfile).toBeUndefined()
    // Descriptions come from catalog data.
    const luna = describeSpawnableModel(candidates.find(c => c.id === 'gpt-5.6-luna')!)
    expect(luna).toContain('provider Codex')
    expect(luna).toContain('context')
    expect(luna).toContain('price low')
    expect(luna).toMatch(/vision/)
    // The unset allowlist keeps only matrix models: no gpt-5.6, no sonnet-4-6.
    const strict = listSpawnableModels({ settings: settings() }).candidates.map(c => c.id)
    expect(strict).not.toContain('gpt-5.6-luna')
    expect(strict).not.toContain('claude-sonnet-4-6')
    expect(strict).toContain('claude-sonnet-5')
  })

  test('the model question offers every allowed candidate', async () => {
    setDeps({ providerProfiles: () => [codexProfile], isJevConfigured: () => true, evaluateJev: async (req, opts) => { jevCalls.push({ req, opts }); return { ok: false, reason: 'timeout', latencyMs: 1 } } })
    await chooseTeammateRoute({ description: 'Handle payments', settings: settings({ teammateModelAllowlist: ['*'] }) })
    const model = jevCalls[0]!.req.questions.model
    expect(model?.type).toBe('choice')
    const keys = model?.type === 'choice' ? Object.keys(model.criteria) : []
    expect(keys).toContain('gpt-5.6-luna')
    expect(keys).toContain('claude-sonnet-4-6')
    expect(jevCalls[0]!.req.instruction).toContain('deep tier (prefer fable-5.1, opus-5.5, gpt-6)')
  })

  test('a pick that breaks a hard rule is corrected', async () => {
    // The implementer ran Sonnet 5; claude-sonnet-4-6 is the same family.
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    jevWith(
      withModel(jevOk('review', { review: 0.95, verify: 0.05 }), 'claude-sonnet-4-6', {
        'claude-sonnet-4-6': 0.8,
        'claude-opus-5-5': 0.17,
        'claude-haiku-4-5-20251001': 0.03,
      }),
    )
    const decision = await chooseTeammateRoute({
      description: 'Handle payments',
      name: 'checker',
      teamName: 't',
      settings: settings({ teammateModelAllowlist: ['*'] }),
    })
    expect(decision.role).toBe('review')
    expect(decision.model).toBe('claude-opus-5-5')
    expect(decision.reason).toContain('corrected from claude-sonnet-4-6')
    // Pre-filtered too: an ambiguous role still offered it, but a heuristic
    // review would not have.
    const reviewCall = jevCalls[0]!.req.questions.model
    expect(reviewCall?.type === 'choice' && 'claude-sonnet-4-6' in reviewCall.criteria).toBe(true)
  })

  test('a heuristic review never offers the implementer family', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    jevWith({ ok: false, reason: 'timeout', latencyMs: 1 })
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      name: 'rev',
      teamName: 't',
      settings: settings({ teammateModelAllowlist: ['*'] }),
    })
    const model = jevCalls[0]!.req.questions.model
    const keys = model?.type === 'choice' ? Object.keys(model.criteria) : []
    expect(keys).not.toContain('claude-sonnet-4-6')
    expect(keys).not.toContain('claude-sonnet-5')
    expect(decision.excludedModels?.some(e => e.model === 'claude-sonnet-4-6' && e.reason.startsWith('separation'))).toBe(true)
  })

  test('a computer_use pick without vision is corrected', async () => {
    setDeps({
      leaderRoute: () => 'zai',
      hasAnthropicAuth: () => false,
      isJevConfigured: () => true,
      evaluateJev: async () =>
        withModel(jevOk('computer_use', { computer_use: 0.9, research: 0.1 }), 'glm-5.3', { 'glm-5.3': 0.9, 'glm-5.3-flash': 0.1 }),
      supportsVision: model => model === 'glm-5.3-flash',
      routeCatalog: () => [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }],
    })
    const decision = await chooseTeammateRoute({ description: 'Handle it', settings: settings() })
    expect(decision.role).toBe('computer_use')
    expect(decision.model).toBe('glm-5.3-flash')
  })

  test('an unconfident model pick falls back to the tier table', async () => {
    jevWith(withModel(jevOk('review', { review: 0.9, verify: 0.1 }), 'claude-opus-5-5', { 'claude-opus-5-5': 0.5, 'claude-fable-5-1': 0.45 }))
    const decision = await chooseTeammateRoute({ description: 'Handle it', settings: settings() })
    expect(decision.source).toBe('jev')
    expect(decision.model).toBe('claude-fable-5-1')
    expect(decision.modelSource).toBe('tier')
    expect(decision.reason).toBe('role jev p=0.90; model tier, jev top claude-opus-5-5 p=0.50 < 0.75')
  })

  test('a JEV failure falls back to the heuristic', async () => {
    setDeps({ isJevConfigured: () => true, evaluateJev: async () => ({ ok: false, reason: 'http_error', latencyMs: 5 }) })
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      agentTypes: [{ agentType: 'reviewer', source: 'userSettings', whenToUse: 'Reviews code' }],
      settings: settings(),
    })
    expect(decision.role).toBe('review')
    expect(decision.source).toBe('heuristic')
    expect(decision.model).toBe('claude-fable-5-1')
    expect(decision.agentType).toBe('default')
    expect(decision.reason).toContain('jev http_error')
  })

  const defs = [
    { agentType: 'reviewer', source: 'userSettings', whenToUse: 'Reviews diffs', tools: ['Read', 'Grep'] },
    { agentType: 'coder', source: 'projectSettings', whenToUse: 'Writes code' },
    { agentType: 'Explore', source: 'built-in', whenToUse: 'Explores the codebase', tools: ['Read', 'Grep', 'Glob'] },
    { agentType: 'general-purpose', source: 'built-in', whenToUse: 'General' },
  ]

  test('agent_type criteria come from the loaded definitions plus default', async () => {
    jevWith({ ok: false, reason: 'timeout', latencyMs: 1 })
    await chooseTeammateRoute({ description: 'Handle it', agentTypes: defs, settings: settings() })
    const q = jevCalls[0]!.req.questions.agent_type
    expect(q?.type).toBe('choice')
    const criteria = q?.type === 'choice' ? q.criteria : {}
    expect(Object.keys(criteria).sort()).toEqual(['coder', 'default', 'reviewer'])
    expect(criteria.reviewer).toContain('Reviews diffs')
    expect(criteria.reviewer).toContain('read-only')
    expect(criteria.coder).toContain('can edit files')
  })

  test('built-ins are excluded on the teammate path and allowed on the subagent path', () => {
    expect(agentTypeOptionsFor(defs, 'teammate').map(d => d.agentType)).toEqual(['reviewer', 'coder'])
    // general-purpose is what `default` means on the subagent path.
    expect(agentTypeOptionsFor(defs, 'subagent').map(d => d.agentType)).toEqual(['reviewer', 'coder', 'Explore'])
  })

  test('an explicit subagent_type is not asked about', async () => {
    jevWith({ ok: false, reason: 'timeout', latencyMs: 1 })
    const decision = await chooseTeammateRoute({ description: 'Handle it', subagent_type: 'coder', agentTypes: defs, settings: settings() })
    expect(jevCalls[0]!.req.questions.agent_type).toBeUndefined()
    expect(decision.agentType).toBe('coder')
  })

  test('an explicit model is not asked about', async () => {
    jevWith({ ok: false, reason: 'timeout', latencyMs: 1 })
    await chooseTeammateRoute({ description: 'Handle it', explicitModel: 'claude-opus-5-5', settings: settings() })
    expect(jevCalls[0]!.req.questions.model).toBeUndefined()
  })

  test('an edit-incapable type for implement falls back', async () => {
    jevWith(
      withModel(jevOk('implement', { implement: 0.95, review: 0.05 }), 'claude-sonnet-5', { 'claude-sonnet-5': 0.9, 'claude-opus-5-5': 0.1 }, {
        choice: 'reviewer',
        probabilities: { reviewer: 0.8, coder: 0.15, default: 0.05 },
      }),
    )
    const decision = await chooseTeammateRoute({ description: 'Handle it', agentTypes: defs, settings: settings() })
    expect(decision.role).toBe('implement')
    expect(decision.agentType).toBe('coder')
    expect(decision.agentTypeP).toBe(0.15)
    expect(decision.reason).toContain('type corrected from reviewer cannot edit files')
    expect(formatDispatchSummary(decision)).toBe(
      `dispatch: implement → sonnet-5 as coder (${decision.reason} / type p=0.15)`,
    )
    // With no capable confident alternative: default.
    jevWith(
      withModel(jevOk('implement', { implement: 0.95, review: 0.05 }), 'claude-sonnet-5', { 'claude-sonnet-5': 0.9, 'claude-opus-5-5': 0.1 }, {
        choice: 'reviewer',
        probabilities: { reviewer: 0.5, coder: 0.26, default: 0.24 },
      }),
    )
    const fallback = await chooseTeammateRoute({ description: 'Handle it', agentTypes: defs, settings: settings() })
    expect(fallback.agentType).toBe('default')
  })

  test("a chosen type's model frontmatter is used, and separation still applies", async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-opus-5-5' }]
    const typed = [
      { agentType: 'opus-reviewer', source: 'userSettings', whenToUse: 'Reviews with Opus', model: 'claude-opus-5-5' },
      { agentType: 'fable-reviewer', source: 'userSettings', whenToUse: 'Reviews with Fable', model: 'claude-fable-5-1' },
    ]
    jevWith(
      withModel(jevOk('review', { review: 0.95, verify: 0.05 }), 'claude-fable-5-1', { 'claude-fable-5-1': 0.9, 'gpt-6-astra': 0.1 }, {
        choice: 'opus-reviewer',
        probabilities: { 'opus-reviewer': 0.8, 'fable-reviewer': 0.18, default: 0.02 },
      }),
    )
    const decision = await chooseTeammateRoute({ description: 'Handle it', name: 'rev', teamName: 't', agentTypes: typed, settings: settings() })
    expect(decision.agentType).toBe('fable-reviewer')
    expect(decision.model).toBe('claude-fable-5-1')
    expect(decision.source).toBe('explicit')
    expect(decision.refusal).toBeUndefined()
  })
})

describe('separation families are vendor model lines', () => {
  const table: Array<[string, string]> = [
    ['claude-opus-5-5', 'claude-opus'],
    ['claude-opus-4-8', 'claude-opus'],
    ['claude-opus-4-20250514', 'claude-opus'],
    ['claude-opus-4-6[1m]', 'claude-opus'],
    ['us.anthropic.claude-opus-4-5-20251101-v1:0', 'claude-opus'],
    ['anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus'],
    ['claude-opus-4-1@20250805', 'claude-opus'],
    ['claude-3-opus-20240229', 'claude-opus'],
    ['claude-sonnet-5', 'claude-sonnet'],
    ['claude-sonnet-4-6[1m]', 'claude-sonnet'],
    ['claude-3-5-sonnet-20241022', 'claude-sonnet'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet'],
    ['claude-haiku-4-5-20251001', 'claude-haiku'],
    ['claude-fable-5-1', 'claude-fable'],
    ['gpt-6-astra', 'gpt-6'],
    ['gpt-6', 'gpt-6'],
    ['gpt-5.6-sol', 'gpt-5'],
    ['gpt-5.6-luna', 'gpt-5'],
    ['gpt-5.5', 'gpt-5'],
    ['gpt-5.4', 'gpt-5'],
    ['gpt-5.3-codex', 'gpt-5'],
    ['openai/gpt-5.5', 'gpt-5'],
    ['glm-5.3', 'glm'],
    ['GLM-4.5-Air', 'glm'],
    ['z-ai/glm-5.3-flash', 'glm'],
    ['glm-5.1:cloud', 'glm'],
    ['accounts/fireworks/models/glm-5p1', 'glm'],
    ['deepseek-v4-pro', 'deepseek'],
    ['deepseek-flash', 'deepseek'],
    ['deepseek-ai/deepseek-v4-pro', 'deepseek'],
    ['accounts/fireworks/models/deepseek-v4-pro', 'deepseek'],
    ['kimi-k2.5', 'kimi-k2.5'],
    ['mistral-large-2025-06-01', 'mistral-large'],
    ['some-model-20250101[1m]', 'some-model'],
  ]
  for (const [id, family] of table) {
    test(`${id} → ${family}`, () => {
      expect(separationFamilyOf(id)).toBe(family)
    })
  }
  test('aliases resolve to their line', () => {
    expect(separationFamilyOf('opus')).toBe('claude-opus')
    expect(separationFamilyOf('sonnet')).toBe('claude-sonnet')
    expect(separationFamilyOf('inherit')).toBeUndefined()
  })
})

describe('spawnable candidates under "*"', () => {
  const zaiAll: ProviderProfile = { ...zaiProfile, model: 'glm-5.3, glm-5.3-flash, glm-5.2, GLM-5.1, GLM-5-Turbo, GLM-4.7, GLM-4.5-Air' }
  const WORKING = [
    'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'GLM-5.1', 'GLM-5-Turbo', 'GLM-4.7', 'GLM-4.5-Air',
    'deepseek-v4-pro', 'deepseek-flash',
    'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
  ]
  const LEGACY = ['claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-5-20251101']

  test('drop dated legacy Claude ids, keep every verified working model', () => {
    setDeps({ providerProfiles: () => [zaiAll, deepseekProfile, codexProfile] })
    const ids = listSpawnableModels({ settings: settings({ teammateModelAllowlist: ['*'] }) }).candidates.map(c => c.id)
    for (const id of LEGACY) expect(ids).not.toContain(id)
    for (const id of WORKING) expect(ids).toContain(id)
    expect(ids.some(id => /codex-spark|codexspark/.test(id))).toBe(false)
  })

  test('pruneRouteCatalog: dated ids stay when they are the only one of their line; spark is dropped on codex', () => {
    expect(pruneRouteCatalog('anthropic', [{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-opus-4-20250514' }]).map(e => e.id))
      .toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-20250514'])
    expect(pruneRouteCatalog('anthropic', [{ id: 'claude-opus-4-20250514' }, { id: 'claude-opus-5-5' }]).map(e => e.id))
      .toEqual(['claude-opus-5-5'])
    expect(pruneRouteCatalog('codex', [{ id: 'gpt-5.3-codex-spark' }, { id: 'gpt-5.5' }]).map(e => e.id)).toEqual(['gpt-5.5'])
    expect(pruneRouteCatalog('openai', [{ id: 'gpt-5.3-codex-spark' }]).map(e => e.id)).toEqual(['gpt-5.3-codex-spark'])
  })

  test('teammateDispatch.excludeModels prunes exact ids from candidates and the tier fallback', async () => {
    const s = settings({ teammateModelAllowlist: ['*'], teammateDispatch: { excludeModels: ['claude-fable-5-1', 'claude-opus-4-8'] } })
    const listing = listSpawnableModels({ settings: s })
    const ids = listing.candidates.map(c => c.id)
    expect(ids).not.toContain('claude-fable-5-1')
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-5-5')
    expect(listing.excluded).toContainEqual({ model: 'claude-fable-5-1', reason: 'teammateDispatch.excludeModels' })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', settings: s })
    expect(decision.model).not.toBe('claude-fable-5-1')
    expect(decision.model).toBe('claude-opus-5-5')
  })
})

describe('usage-aware dispatch', () => {
  const allProfiles = [codexProfile, zaiProfile, deepseekProfile]
  const usageOf = (levels: Record<string, number | 'unknown'>): TeammateDispatchDeps['routeUsage'] =>
    route => {
      const level = levels[route] ?? 'unknown'
      return level === 'unknown' ? { route, level } : { route, level, window: '7d', source: 'headers' }
    }
  const jevWith = (result: JevResult, extra: Partial<TeammateDispatchDeps> = {}) =>
    setDeps({
      providerProfiles: () => allProfiles,
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return result
      },
      ...extra,
    })

  test('settings: defaults, and exhausted never below high', () => {
    const defaults = readTeammateDispatchSettings(settings())
    expect(defaults.usage).toEqual({ enabled: true, high: 0.8, exhausted: 0.95 })
    const custom = readTeammateDispatchSettings(settings({ teammateDispatch: { usage: { enabled: false, high: 0.5, exhausted: 0.9 } } }))
    expect(custom.usage).toEqual({ enabled: false, high: 0.5, exhausted: 0.9 })
    const original = console.warn
    console.warn = () => {}
    try {
      const inverted = readTeammateDispatchSettings(settings({ teammateDispatch: { usage: { high: 0.9, exhausted: 0.5 } } }))
      expect(inverted.usage).toEqual({ enabled: true, high: 0.9, exhausted: 0.9 })
    } finally {
      console.warn = original
    }
  })

  test('anthropic at 0.85: a review goes to gpt-6, an implement to deepseek-v4-pro (tier fallback)', async () => {
    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ anthropic: 0.85 }) })
    const review = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect(review.family).toBe('gpt-6')
    expect(review.model).toBe('gpt-6-astra')
    expect(review.providerProfile).toBe('prof_codex')
    expect(review.reason).toContain('model tier: anthropic at 85% (7d) → gpt-6')
    expect(review.routeUsage).toEqual({ anthropic: 0.85, codex: 'unknown', deepseek: 'unknown', zai: 'unknown' })
    expect(formatDispatchSummary(review)).toContain('anthropic at 85% (7d) → gpt-6')

    const implement = await chooseTeammateRoute({ description: 'Implement the fix', settings: settings() })
    expect(implement.family).toBe('deepseek-v4-pro')
    expect(implement.tier).toBe('standard')
    expect(implement.reason).toContain('anthropic at 85% (7d) → deepseek-v4-pro')
  })

  test('anthropic at 0.97 is excluded from the JEV offer; the pick of an excluded model is corrected', async () => {
    jevWith(
      withModel(jevOk('review', { review: 0.95, verify: 0.05 }), 'claude-fable-5-1', {
        'claude-fable-5-1': 0.9,
        'gpt-6-astra': 0.1,
      }),
      { routeUsage: usageOf({ anthropic: 0.97 }) },
    )
    const decision = await chooseTeammateRoute({ description: 'Handle payments', name: 'rev', settings: settings() })
    const model = jevCalls[0]!.req.questions.model
    const keys = model?.type === 'choice' ? Object.keys(model.criteria) : []
    expect(keys).not.toContain('claude-fable-5-1')
    expect(keys).toContain('gpt-6-astra')
    expect(keys).toContain('deepseek-v4-pro')
    expect(decision.excludedModels).toContainEqual({ model: 'claude-fable-5-1', reason: 'usage: anthropic at 97% (7d), excluded' })
    expect(decision.model).toBe('gpt-6-astra')
    expect(decision.modelSource).toBe('jev')
    expect(decision.reason).toContain('corrected from claude-fable-5-1 usage: anthropic at 97% (7d), excluded')
    expect(decision.warning).toBeUndefined()
  })

  test('a demoted (high) route leaves the JEV offer when a calmer route remains, and the instruction stays silent about it', async () => {
    jevWith(
      withModel(jevOk('implement', { implement: 0.95, research: 0.05 }), 'claude-sonnet-5', {
        'claude-sonnet-5': 0.9,
        'deepseek-v4-pro': 0.1,
      }),
      { routeUsage: usageOf({ anthropic: 0.85 }) },
    )
    const decision = await chooseTeammateRoute({ description: 'Handle payments', settings: settings() })
    const model = jevCalls[0]!.req.questions.model
    const keys = model?.type === 'choice' ? Object.keys(model.criteria) : []
    expect(keys).not.toContain('claude-sonnet-5')
    expect(jevCalls[0]!.req.instruction).not.toContain('Provider usage is high')
    expect(decision.excludedModels).toContainEqual({ model: 'claude-sonnet-5', reason: 'usage: anthropic at 85% (7d), demoted' })
    expect(decision.model).toBe('deepseek-v4-pro')
    expect(decision.reason).toContain('corrected from claude-sonnet-5 usage: anthropic at 85% (7d), demoted')
  })

  test('everything high: the least-used route wins, exhausted routes are kept only with a warning, and JEV is told', async () => {
    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ anthropic: 0.9, codex: 0.82, zai: 0.88, deepseek: 0.85 }) })
    const review = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect(review.family).toBe('gpt-6')
    expect(review.reason).toContain('anthropic at 90% (7d) → gpt-6 (least used, codex at 82% (7d))')
    expect(review.warning).toBeUndefined()

    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ anthropic: 0.99, codex: 0.96, zai: 0.98, deepseek: 0.97 }) })
    const exhausted = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect(exhausted.family).toBe('gpt-6')
    expect(exhausted.warning).toContain('exhausted threshold; using the least used (codex at 96% (7d))')

    jevWith({ ok: false, reason: 'timeout', latencyMs: 1 }, { routeUsage: usageOf({ anthropic: 0.9, codex: 0.82, zai: 0.88, deepseek: 0.85 }) })
    await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    const instruction = jevCalls[0]!.req.instruction
    expect(instruction).toContain('Provider usage is high: ')
    expect(instruction).toContain('anthropic at 90% (7d)')
    expect(instruction).toContain('codex at 82% (7d)')
    expect(instruction).toContain('prefer other providers, and among these the least used')
  })

  test('unknown usage counts as low', async () => {
    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ codex: 0.9 }) })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    expect(decision.family).toBe('fable-5.1')
    expect(decision.reason).not.toContain('→')
    expect(decision.routeUsage?.anthropic).toBe('unknown')
  })

  test('usage.enabled=false keeps the old behaviour and reads nothing', async () => {
    let reads = 0
    setDeps({
      providerProfiles: () => allProfiles,
      routeUsage: route => {
        reads++
        return { route, level: 0.99 }
      },
    })
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      settings: settings({ teammateDispatch: { usage: { enabled: false } } }),
    })
    expect(decision.family).toBe('fable-5.1')
    expect(decision.routeUsage).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('the separation rule wins over usage', async () => {
    // Codex is the only calm route, but the implementer used it. The reviewer
    // must still avoid gpt-6 and lands on an exhausted Anthropic model.
    members = [{ name: 'dev', role: 'implement', model: 'gpt-6-astra' }]
    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ anthropic: 0.99, codex: 0.1, zai: 0.99, deepseek: 0.99 }) })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', name: 'rev', teamName: 't', settings: settings() })
    expect(decision.family).toBe('fable-5.1')
    expect(decision.excluded).toEqual([{ family: 'gpt-6', by: 'dev' }])
    expect(decision.warning).toContain('exhausted')
    // And a JEV pick that breaks separation is corrected even when its route is the calm one.
    jevWith(
      withModel(jevOk('review', { review: 0.95, verify: 0.05 }), 'gpt-6-astra', { 'gpt-6-astra': 0.9, 'claude-fable-5-1': 0.1 }),
      { routeUsage: usageOf({ anthropic: 0.9, codex: 0.1, zai: 0.9, deepseek: 0.9 }) },
    )
    const corrected = await chooseTeammateRoute({ description: 'Handle payments', name: 'rev', teamName: 't', settings: settings() })
    expect(corrected.model).toBe('claude-fable-5-1')
    expect(corrected.reason).toContain('separation: gpt-6 is an implementer')
  })

  test('the debug line and the record carry every route usage', async () => {
    setDeps({ providerProfiles: () => allProfiles, routeUsage: usageOf({ anthropic: 0.41 }) })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', settings: settings() })
    const record = toDispatchRecord(decision)
    expect(record.routeUsage).toEqual({ anthropic: 0.41, codex: 'unknown', deepseek: 'unknown', zai: 'unknown' })
  })
})

describe('cross-vendor review preference', () => {
  const allProfiles = [codexProfile, zaiProfile, deepseekProfile]

  test('vendorOf', () => {
    expect(vendorOf('claude-sonnet-5')).toBe('anthropic')
    expect(vendorOf('claude-sonnet')).toBe('anthropic')
    expect(vendorOf('fable-5.1')).toBe('anthropic')
    expect(vendorOf('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('anthropic')
    expect(vendorOf('gpt-6-astra')).toBe('openai')
    expect(vendorOf('gpt-5')).toBe('openai')
    expect(vendorOf('glm-5.3-flash')).toBe('zai')
    expect(vendorOf('glm')).toBe('zai')
    expect(vendorOf('deepseek-ai/deepseek-v4-pro')).toBe('deepseek')
    expect(vendorOf('kimi-k2')).toBeUndefined()
    expect(vendorOf(undefined)).toBeUndefined()
  })

  test('implementer on sonnet-5 → the reviewer is gpt-6 via the tier fallback', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    setDeps({ providerProfiles: () => allProfiles })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', name: 'rev', teamName: 't', settings: settings() })
    expect(decision.family).toBe('gpt-6')
    expect(decision.tier).toBe('deep')
    expect(decision.reason).toContain('other vendor than anthropic preferred')
    // Without a Codex profile the same-vendor deep model is still fine.
    setDeps({ providerProfiles: () => [zaiProfile, deepseekProfile] })
    const noCodex = await chooseTeammateRoute({ description: 'Review the diff', name: 'rev', teamName: 't', settings: settings() })
    expect(noCodex.family).toBe('fable-5.1')
    expect(noCodex.reason).not.toContain('other vendor')
  })

  test('implementer on gpt-6-astra → the reviewer is fable-5.1', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'gpt-6-astra' }]
    setDeps({ providerProfiles: () => allProfiles })
    const decision = await chooseTeammateRoute({ description: 'Review the diff', name: 'rev', teamName: 't', settings: settings() })
    expect(decision.family).toBe('fable-5.1')
    expect(decision.excluded).toEqual([{ family: 'gpt-6', by: 'dev' }])
  })

  test('design roles are unaffected', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    setDeps({ providerProfiles: () => allProfiles })
    const decision = await chooseTeammateRoute({ description: 'Plan the architecture', name: 'architect', teamName: 't', settings: settings() })
    expect(decision.role).toBe('design')
    expect(decision.family).toBe('fable-5.1')
    expect(decision.reason).not.toContain('other vendor')
  })

  test('JEV is hinted, and its confident same-vendor pick still stands', async () => {
    members = [{ name: 'dev', role: 'implement', model: 'claude-sonnet-5' }]
    setDeps({
      providerProfiles: () => allProfiles,
      isJevConfigured: () => true,
      evaluateJev: async (req, opts) => {
        jevCalls.push({ req, opts })
        return withModel(jevOk('review', { review: 0.95, verify: 0.05 }), 'claude-fable-5-1', { 'claude-fable-5-1': 0.9, 'gpt-6-astra': 0.1 })
      },
    })
    const decision = await chooseTeammateRoute({ description: 'Handle payments', name: 'rev', teamName: 't', settings: settings() })
    expect(jevCalls[0]!.req.instruction).toContain('prefer a model from a different vendor than the implementer (implementer vendor: anthropic)')
    expect(decision.model).toBe('claude-fable-5-1')
    expect(decision.modelSource).toBe('jev')
    expect(decision.reason).not.toContain('corrected')
  })
})
