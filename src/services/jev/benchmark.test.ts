import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeJev, distribution } from '../../test/fakeJev.js'
import { chooseTeammateRoute, separationFamilyOf } from '../api/smartRouting/teammate.js'
import {
  asList,
  buildTrainingExamples,
  evaluateModelGold,
  isBenchResults,
  parseScenarioFile,
  requestKey,
  runBenchmark,
  trainingExamplesToJsonl,
  validateScenarios,
  type BenchCandidate,
  type BenchScenario,
} from './benchmark.js'
import { buildBenchEnvironment, DEFAULT_BENCH_AGENT_TYPES, SEED_SCENARIOS } from './benchmarkFixtures.js'
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  RULE_A_MIN_MARGIN,
  RULE_A_MIN_P,
  type JevAnswer,
  type JevRequest,
  type JevResult,
} from './client.js'

const REVIEW: BenchScenario = {
  id: 'rev',
  description: 'Review the auth diff',
  prompt: 'Critique this diff for correctness and security.',
  gold: { role: 'review', model: { tier: 'deep' } },
}
const IMPLEMENT: BenchScenario = {
  id: 'impl',
  description: 'Implement retry fix',
  prompt: 'Fix the null check in validate.ts, add a test and commit.',
  gold: { role: 'implement', model: { tier: 'standard' } },
}

/** Valid typed answers for a request, with chosen top picks. */
function canned(
  request: JevRequest,
  picks: { role?: [string, number]; model?: [string, number]; agent_type?: [string, number]; complexity?: number; longContext?: number } = {},
): JevResult {
  const answers: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria)
      const [top, p] = picks[name as 'role' | 'model' | 'agent_type'] ?? [keys[0]!, 0.9]
      answers[name] = { type: 'choice', choice: top, probabilities: distribution(keys, top, p, () => 0.5) }
    } else if (question.type === 'score') {
      answers[name] = { type: 'score', score: picks.complexity ?? 1 }
    } else {
      answers[name] = { type: 'boolean', probability: picks.longContext ?? 0.1 }
    }
  }
  return {
    ok: true,
    answers,
    latencyMs: 100,
    cached: false,
    costUsd: 0.001,
    usage: { inputTokens: 100, outputTokens: 10 },
  }
}

describe('validateScenarios', () => {
  test('accepts the built-in seed set', () => {
    expect(() => validateScenarios(SEED_SCENARIOS)).not.toThrow()
  })

  test('lists every problem in one error', () => {
    const bad = [
      { id: 'a b', description: '', prompt: 1 },
      { id: 'dup', description: 'd', prompt: 'p' },
      { id: 'dup', description: 'd', prompt: 'p' },
      {
        id: 'gold',
        description: 'd',
        prompt: 'p',
        gold: { role: 'nope', complexity: 'huge', model: { tier: 'ultra' } },
      },
    ] as unknown as BenchScenario[]
    let message = ''
    try {
      validateScenarios(bad)
    } catch (e) {
      message = (e as Error).message
    }
    for (const fragment of [
      'id must match',
      'description is required',
      'prompt must be a string',
      'duplicate id',
      'unknown gold role "nope"',
      'unknown gold complexity "huge"',
      'unknown gold model tier "ultra"',
    ]) {
      expect(message).toContain(fragment)
    }
  })

  test('rejects an empty list', () => {
    expect(() => validateScenarios([])).toThrow('non-empty')
  })

  test('parseScenarioFile takes an array or an object with scenarios', () => {
    expect(parseScenarioFile([REVIEW])).toHaveLength(1)
    expect(parseScenarioFile({ scenarios: [REVIEW, IMPLEMENT] })).toHaveLength(2)
    expect(() => parseScenarioFile({ nope: true })).toThrow('expected an array')
    expect(() => parseScenarioFile('x')).toThrow('expected an array')
  })

  test('asList normalises a value, a list and undefined', () => {
    expect(asList('a')).toEqual(['a'])
    expect(asList(['a', 'b'] as const)).toEqual(['a', 'b'])
    expect(asList(undefined)).toEqual([])
  })
})

describe('evaluateModelGold', () => {
  const tiers = {
    deep: ['fable-5.1', 'opus-5.5', 'gpt-6'],
    standard: ['sonnet-5-5', 'deepseek-v4-pro'],
    fast: ['deepseek-v4.1-flash'],
  }
  const opus: BenchCandidate = {
    id: 'claude-opus-5-5', route: 'anthropic', provider: 'anthropic', family: 'opus-5.5',
    separationFamily: 'claude-opus', contextWindow: 1_000_000, vision: true, reasoning: true,
    priceTier: 'high', vendor: 'anthropic',
  }
  const flash: BenchCandidate = {
    id: 'deepseek-flash', route: 'deepseek', provider: 'DeepSeek', family: 'deepseek-v4.1-flash',
    separationFamily: 'deepseek', contextWindow: 128_000, vision: false, reasoning: false,
    priceTier: 'low', vendor: 'deepseek',
  }
  const mystery: BenchCandidate = {
    id: 'mystery', route: 'x', provider: 'x', separationFamily: 'mystery', vision: false,
    reasoning: false, priceTier: 'mid',
  }

  test('nothing to judge is undefined, not false', () => {
    expect(evaluateModelGold(undefined, opus, tiers)).toBeUndefined()
    expect(evaluateModelGold({ tier: 'deep' }, undefined, tiers)).toBeUndefined()
  })

  test('tier resolves through the effective policy families', () => {
    expect(evaluateModelGold({ tier: 'deep' }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ tier: 'standard' }, opus, tiers)).toBe(false)
    expect(evaluateModelGold({ tier: ['standard', 'deep'] }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ tier: 'fast' }, flash, tiers)).toBe(true)
  })

  test('a model outside every dispatch family fails any tier', () => {
    expect(evaluateModelGold({ tier: ['deep', 'standard', 'fast'] }, mystery, tiers)).toBe(false)
  })

  test('ids, vendors, vision and context', () => {
    expect(evaluateModelGold({ anyOf: ['CLAUDE-OPUS-5-5'] }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ anyOf: ['gpt-6-astra'] }, opus, tiers)).toBe(false)
    expect(evaluateModelGold({ notIn: ['claude-opus-5-5'] }, opus, tiers)).toBe(false)
    expect(evaluateModelGold({ vendors: ['deepseek', 'zai'] }, flash, tiers)).toBe(true)
    expect(evaluateModelGold({ vendors: ['openai'] }, flash, tiers)).toBe(false)
    expect(evaluateModelGold({ vision: true }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ vision: true }, flash, tiers)).toBe(false)
    expect(evaluateModelGold({ minContext: 200_000 }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ minContext: 200_000 }, flash, tiers)).toBe(false)
    // An unknown window cannot satisfy a minimum.
    expect(evaluateModelGold({ minContext: 1 }, mystery, tiers)).toBe(false)
  })

  test('every set constraint must hold', () => {
    expect(evaluateModelGold({ tier: 'deep', vision: true, vendors: ['anthropic'] }, opus, tiers)).toBe(true)
    expect(evaluateModelGold({ tier: 'deep', vision: false }, opus, tiers)).toBe(false)
  })
})

describe('runBenchmark, baseline mode', () => {
  test('records deterministic decisions, captures and dedupes requests, never calls JEV', async () => {
    const results = await runBenchmark([REVIEW, IMPLEMENT], {
      mode: 'baseline',
      environment: buildBenchEnvironment(),
      repeat: 2,
    })
    expect(isBenchResults(results)).toBe(true)
    expect(results.runs).toHaveLength(4)
    expect(results.baseline).toHaveLength(0)
    expect(results.runs.every(r => r.mode === 'baseline' && r.jev === undefined)).toBe(true)
    expect(results.runs.map(r => r.repeat)).toEqual([1, 2, 1, 2])
    // Two scenarios, two repeats each: identical requests share one entry.
    expect(Object.keys(results.requests)).toHaveLength(2)
    for (const run of results.runs) expect(results.requests[run.requestKey!]).toBeDefined()
    // Baseline is the heuristic: same input, same decision.
    const [a, b] = results.runs
    expect(b!.decision.model).toBe(a!.decision.model)
    expect(results.runs[0]!.decision.role).toBe('review')
    expect(results.runs[2]!.decision.role).toBe('implement')
    expect(results.config.minP).toBe(RULE_A_MIN_P)
    expect(results.config.minMargin).toBe(RULE_A_MIN_MARGIN)
    expect(results.candidates.rev!.length).toBeGreaterThan(0)
    expect(results.candidates.rev!.every(c => c.vendor === undefined || typeof c.vendor === 'string')).toBe(true)
  })

  test('the separation rule is applied: a reviewer never shares the implementer family', async () => {
    const scenario: BenchScenario = {
      ...REVIEW,
      id: 'sep',
      implementers: ['claude-opus-5-5'],
    }
    const results = await runBenchmark([scenario], {
      mode: 'baseline',
      environment: buildBenchEnvironment(),
    })
    const model = results.runs[0]!.decision.model
    expect(model).toBeDefined()
    expect(separationFamilyOf(model)).not.toBe('claude-opus')
    // The request offered no Opus model either.
    const offered = Object.keys((results.requests[results.runs[0]!.requestKey!]!.questions.model as { criteria: object }).criteria)
    expect(offered.some(id => separationFamilyOf(id) === 'claude-opus')).toBe(false)
  })

  test('leaves the dispatcher unpatched afterwards', async () => {
    await runBenchmark([REVIEW], { mode: 'baseline', environment: buildBenchEnvironment() })
    // With the runner's stub still installed this would read "jev no_key".
    const after = await chooseTeammateRoute({ description: 'Review the diff', settings: {} })
    expect(after.reason).toContain('jev not configured')
  })

  test('rejects invalid scenarios before running anything', async () => {
    await expect(
      runBenchmark([{ ...REVIEW, id: 'bad id' }], { mode: 'baseline', environment: buildBenchEnvironment() }),
    ).rejects.toThrow('invalid scenarios')
  })
})

describe('runBenchmark, live mode (injected evaluator; no network)', () => {
  const env = () => buildBenchEnvironment()

  test('captures the raw JEV answer and the dispatcher uses a confident role', async () => {
    const seen: JevRequest[] = []
    const results = await runBenchmark([REVIEW], {
      mode: 'live',
      environment: env(),
      evaluate: async request => {
        seen.push(request)
        return canned(request, { role: ['review', 0.92] })
      },
    })
    const run = results.runs[0]!
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0]!.questions).sort()).toEqual([
      'agent_type', 'complexity', 'model', 'needs_long_context', 'role',
    ])
    expect(run.mode).toBe('live')
    expect(run.jev?.ok).toBe(true)
    expect(run.decision.roleSource).toBe('jev')
    expect(run.decision.role).toBe('review')
    expect(run.requestKey).toBe(requestKey(seen[0]!))
  })

  test('an unconfident role falls back to the heuristic', async () => {
    const results = await runBenchmark([REVIEW], {
      mode: 'live',
      environment: env(),
      evaluate: async request => canned(request, { role: ['design', 0.4] }),
    })
    const { decision } = results.runs[0]!
    expect(decision.roleSource).toBe('heuristic')
    expect(decision.role).toBe('review')
    expect(decision.roleReason).toContain('jev not confident')
  })

  test('the configured timeout reaches the evaluator', async () => {
    let timeout: number | undefined
    await runBenchmark([REVIEW], {
      mode: 'live',
      environment: buildBenchEnvironment({ timeoutMs: 1234 }),
      evaluate: async (request, opts) => {
        timeout = opts?.timeoutMs
        return canned(request)
      },
    })
    expect(timeout).toBe(1234)
  })

  test('an evaluator that throws becomes a recorded failed call', async () => {
    const results = await runBenchmark([REVIEW], {
      mode: 'live',
      environment: env(),
      evaluate: async () => {
        throw new Error('boom')
      },
    })
    const run = results.runs[0]!
    expect(run.jev).toMatchObject({ ok: false, reason: 'network_error', detail: 'boom' })
    expect(run.decision.source).toBe('heuristic')
    expect(run.decision.role).toBe('review')
  })

  test('withBaseline adds one JEV-off pass per scenario and counts progress', async () => {
    const progress: Array<[number, number]> = []
    const results = await runBenchmark([REVIEW, IMPLEMENT], {
      mode: 'live',
      environment: env(),
      repeat: 2,
      withBaseline: true,
      evaluate: async request => canned(request),
      onRun: ({ done, total }) => progress.push([done, total]),
    })
    expect(results.runs).toHaveLength(4)
    expect(results.baseline).toHaveLength(2)
    expect(results.baseline.every(r => r.mode === 'baseline' && r.repeat === 0 && r.jev === undefined)).toBe(true)
    expect(progress.at(-1)).toEqual([6, 6])
    expect(results.config.withBaseline).toBe(true)
  })

  test('an abort stops the run and keeps what was collected', async () => {
    const controller = new AbortController()
    const results = await runBenchmark([REVIEW, IMPLEMENT], {
      mode: 'live',
      environment: env(),
      repeat: 3,
      evaluate: async request => canned(request),
      signal: controller.signal,
      onRun: () => controller.abort(),
    })
    expect(results.aborted).toBe(true)
    expect(results.runs).toHaveLength(1)
  })

  test('a seeded fake JEV runs every seed scenario without throwing', async () => {
    const results = await runBenchmark(SEED_SCENARIOS, {
      mode: 'live',
      environment: env(),
      evaluate: createFakeJev({ scenarios: SEED_SCENARIOS, seed: 3, failEvery: 10 }),
    })
    expect(results.runs).toHaveLength(SEED_SCENARIOS.length)
    const failed = results.runs.filter(r => r.jev && !r.jev.ok)
    expect(failed.length).toBeGreaterThan(0)
    expect(results.runs.every(r => r.error === undefined)).toBe(true)
  })
})

describe('runBenchmark, live mode through the real JEV client (fetch stubbed)', () => {
  const savedFetch = globalThis.fetch
  const savedKey = process.env.AI_GATEWAY_API_KEY
  afterEach(() => {
    globalThis.fetch = savedFetch
    if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = savedKey
  })

  type Wire = { url: string; auth: string; body: { model: string; state: unknown; providerOptions?: unknown; questions: Record<string, { type: string; criteria?: unknown }> } }

  /** Answers every question the way the gateway would: valid, confident, keyed by the criteria. */
  function stubGateway(): Wire[] {
    const seen: Wire[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Wire['body']
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization!, body })
      const answers: Record<string, unknown> = {}
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === 'choice') {
          const keys = Object.keys(q.criteria as object)
          answers[name] = { type: 'choice', choice: keys[0], probabilities: distribution(keys, keys[0]!, 0.9, () => 0.5) }
        } else if (q.type === 'score') {
          answers[name] = { type: 'score', score: 1 }
        } else {
          answers[name] = { type: 'boolean', probability: 0.1 }
        }
      }
      return new Response(
        JSON.stringify({ answers, usage: { inputTokens: 10, outputTokens: 2 }, providerMetadata: { gateway: { cost: 0.0005, generationId: 'gen-1' } } }),
        { status: 200 },
      )
    }) as typeof fetch
    return seen
  }

  test('posts to the JEV endpoint, bypasses the client cache, and passes zero data retention', async () => {
    process.env.AI_GATEWAY_API_KEY = 'test-key-not-real'
    const seen = stubGateway()
    const results = await runBenchmark([REVIEW], {
      mode: 'live',
      environment: buildBenchEnvironment(),
      repeat: 2,
      zeroDataRetention: true,
    })
    // Two identical requests must both go out: the client's cache is off.
    expect(seen).toHaveLength(2)
    expect(seen.every(w => w.url === JEV_ENDPOINT)).toBe(true)
    expect(seen.every(w => w.auth === 'Bearer test-key-not-real')).toBe(true)
    expect(seen.every(w => w.body.model === JEV_MODEL)).toBe(true)
    expect(seen.every(w => JSON.stringify(w.body.providerOptions) === JSON.stringify({ gateway: { zeroDataRetention: true } }))).toBe(true)
    expect(results.runs.map(r => r.jev && r.jev.ok && r.jev.cached)).toEqual([false, false])
    expect(results.runs[0]!.jev).toMatchObject({ ok: true, costUsd: 0.0005, generationId: 'gen-1' })
    expect(results.config.zeroDataRetention).toBe(true)
  })

  test('zero data retention is off unless asked for', async () => {
    process.env.AI_GATEWAY_API_KEY = 'test-key-not-real'
    const seen = stubGateway()
    await runBenchmark([REVIEW], { mode: 'live', environment: buildBenchEnvironment() })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body.providerOptions).toBeUndefined()
  })

  test('without a key every call fails as no_key and the dispatcher falls back', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    const seen = stubGateway()
    const results = await runBenchmark([REVIEW], { mode: 'live', environment: buildBenchEnvironment() })
    expect(seen).toHaveLength(0)
    expect(results.runs[0]!.jev).toMatchObject({ ok: false, reason: 'no_key' })
    expect(results.runs[0]!.decision.roleSource).toBe('heuristic')
  })
})

describe('training export', () => {
  test('exports gold-labelled scenarios with the request and offered-only gold', async () => {
    const explicitType: BenchScenario = {
      id: 'explicit',
      description: 'Implement retry fix',
      prompt: 'Fix it.',
      subagentType: 'dev',
      gold: { role: 'implement', agentType: 'dev' },
    }
    const noGold: BenchScenario = { id: 'nogold', description: 'Handle it', prompt: '' }
    const results = await runBenchmark([REVIEW, explicitType, noGold], {
      mode: 'baseline',
      environment: buildBenchEnvironment(),
    })
    const examples = buildTrainingExamples(results)
    expect(examples.map(e => e.id)).toEqual(['rev', 'explicit'])

    const review = examples[0]!
    expect(review.gold.role?.choices).toEqual(['review'])
    expect(review.gold.role?.distribution).toEqual({ review: 1 })
    const offered = Object.keys((review.request.questions.model as { criteria: object }).criteria)
    expect(review.gold.model!.acceptable.length).toBeGreaterThan(0)
    for (const id of review.gold.model!.acceptable) expect(offered).toContain(id)
    const total = Object.values(review.gold.model!.distribution).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 9)

    // The type was explicit, so JEV was never asked: no agent_type gold.
    expect(examples[1]!.request.questions.agent_type).toBeUndefined()
    expect(examples[1]!.gold.agent_type).toBeUndefined()
  })

  test('JSONL is one parseable object per line and empty for no examples', async () => {
    const results = await runBenchmark([REVIEW, IMPLEMENT], {
      mode: 'baseline',
      environment: buildBenchEnvironment(),
    })
    const jsonl = trainingExamplesToJsonl(buildTrainingExamples(results))
    const lines = jsonl.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(jsonl.endsWith('\n')).toBe(true)
    expect(JSON.parse(lines[0]!).id).toBe('rev')
    expect(trainingExamplesToJsonl([])).toBe('')
  })
})

describe('seed scenarios stay satisfiable', () => {
  // A gold no candidate can satisfy would silently score every model wrong,
  // and an agent-type gold JEV is never offered could never be right.
  for (const [label, allowlist] of [['default allowlist', 'default'], ['wildcard allowlist', '*']] as const) {
    test(`every gold in the seed set is reachable under the ${label}`, async () => {
      const results = await runBenchmark(SEED_SCENARIOS, {
        mode: 'baseline',
        environment: buildBenchEnvironment({ allowlist }),
      })
      const examples = new Map(buildTrainingExamples(results).map(e => [e.id, e]))
      const unreachable: string[] = []
      for (const scenario of SEED_SCENARIOS) {
        const gold = scenario.gold
        if (!gold) continue
        const example = examples.get(scenario.id)
        if (!example) {
          unreachable.push(`${scenario.id}: no example`)
          continue
        }
        if (gold.model && !example.gold.model) unreachable.push(`${scenario.id}: no acceptable model`)
        if (asList(gold.role).length > 0 && !example.gold.role) unreachable.push(`${scenario.id}: role not offered`)
        const wantedTypes = asList(gold.agentType)
        if (wantedTypes.length > 0 && !scenario.subagentType) {
          const kept = example.gold.agent_type?.choices ?? []
          const dropped = wantedTypes.filter(t => !kept.includes(t))
          if (dropped.length > 0) unreachable.push(`${scenario.id}: agent type not offered: ${dropped.join(',')}`)
        }
      }
      expect(unreachable).toEqual([])
    })
  }

  test('scenarios with an explicit agent type do not also carry an agent-type gold', () => {
    for (const s of SEED_SCENARIOS) {
      if (s.subagentType) expect(s.gold?.agentType).toBeUndefined()
    }
  })

  test('the fixture agent types are the ones the seed golds name', () => {
    const known = new Set([...DEFAULT_BENCH_AGENT_TYPES.map(a => a.agentType), 'default'])
    for (const s of SEED_SCENARIOS) {
      for (const t of asList(s.gold?.agentType)) expect(known.has(t)).toBe(true)
    }
  })
})
