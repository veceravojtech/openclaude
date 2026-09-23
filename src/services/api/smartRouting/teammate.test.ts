import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ProviderProfile } from '../../../utils/config.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import type { JevRequest, JevResult } from '../../jev/client.js'
import {
  _resetTeammateDispatchWarningsForTesting,
  _setTeammateDispatchDepsForTesting,
  chooseTeammateRoute,
  classifyRoleHeuristic,
  collectExcludedFamilies,
  DEFAULT_TIER_FAMILIES,
  familyOfModel,
  formatDispatchSummary,
  hasNamedAgentRouting,
  readTeammateDispatchSettings,
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
      'needs_long_context',
      'role',
    ])
    expect(decision.source).toBe('jev')
    expect(decision.role).toBe('review')
    expect(decision.family).toBe('fable-5.1')
    expect(decision.costUsd).toBe(0.0004)
    expect(decision.probabilities?.review).toBe(0.86)
    expect(formatDispatchSummary(decision)).toBe('dispatch: review → fable-5.1 (jev p=0.86)')
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

  test('a confident heuristic skips JEV', async () => {
    setDeps({ isJevConfigured: () => true })
    const decision = await chooseTeammateRoute({
      description: 'Review the auth diff',
      prompt: 'Critique it.',
      settings: settings(),
    })
    expect(jevCalls).toHaveLength(0)
    expect(decision.role).toBe('review')
    expect(decision.source).toBe('heuristic')
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
    expect(decision.excluded).toEqual([{ family: 'sonnet-5', by: 'dev' }])
    expect(formatDispatchSummary(decision)).toContain('excluded sonnet-5 used by dev')
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
    expect(decision.refusal).toContain("'dev' implemented with sonnet-5")
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

  test('nothing left at all spawns on the default with a warning', async () => {
    members = [{ name: 'dev', role: 'implement', family: 'fable-5.1' }]
    const decision = await chooseTeammateRoute({
      description: 'Review the diff',
      teamName: 't',
      settings: settings({ teammateModelAllowlist: ['fable-5.1'] }),
    })
    expect(decision.model).toBeUndefined()
    expect(decision.warning).toContain('after excluding fable-5.1 used by dev')
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
      { family: 'opus-5.5', by: 'worker' },
      { family: 'sonnet-5', by: 'inheritor' },
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
