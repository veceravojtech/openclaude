import { describe, expect, test } from 'bun:test'
import { DEFAULT_ROLE_TIERS, type TeammateRouteDecision } from '../api/smartRouting/teammate.js'
import {
  BENCH_SCHEMA,
  runBenchmark,
  type BenchCandidate,
  type BenchResults,
  type BenchRun,
  type BenchScenario,
} from './benchmark.js'
import {
  calibration,
  latencyStats,
  percentile,
  rate,
  summarize,
  thresholdSweep,
  SWEEP_MARGINS,
  SWEEP_MIN_P,
} from './benchmarkAnalysis.js'
import { buildBenchEnvironment, SEED_SCENARIOS } from './benchmarkFixtures.js'
import { formatReport } from './benchmarkReport.js'
import type { JevAnswer, JevResult } from './client.js'
import { createFakeJev } from '../../test/fakeJev.js'

describe('small statistics', () => {
  test('rate keeps the counts and is null on an empty denominator', () => {
    expect(rate(1, 4)).toEqual({ n: 1, d: 4, rate: 0.25 })
    expect(rate(0, 0)).toEqual({ n: 0, d: 0, rate: null })
  })

  test('percentile is nearest-rank', () => {
    const v = [1, 2, 3, 4, 5]
    expect(percentile(v, 0.5)).toBe(3)
    expect(percentile(v, 0.95)).toBe(5)
    expect(percentile(v, 0)).toBe(1)
    expect(percentile(v, 1)).toBe(5)
    expect(percentile([], 0.5)).toBeNaN()
  })

  test('latencyStats', () => {
    expect(latencyStats([])).toBeNull()
    expect(latencyStats([300, 100, 200, 400, 3000])).toEqual({
      n: 5, meanMs: 800, p50Ms: 300, p95Ms: 3000, maxMs: 3000,
    })
  })

  test('calibration: Brier and ECE by hand', () => {
    const c = calibration([
      { confidence: 0.9, correct: true },
      { confidence: 0.8, correct: false },
      { confidence: 0.85, correct: true },
    ])!
    // (0.1^2 + 0.8^2 + 0.15^2) / 3
    expect(c.brier).toBeCloseTo(0.224167, 5)
    // All three fall in the top bin: mean confidence 0.85, accuracy 2/3.
    expect(c.bins[4]).toMatchObject({ n: 3, meanConfidence: expect.closeTo(0.85, 9), accuracy: expect.closeTo(2 / 3, 9) })
    expect(c.ece).toBeCloseTo(0.85 - 2 / 3, 9)
    expect(c.bins.slice(0, 4).every(b => b.n === 0)).toBe(true)
    expect(calibration([])).toBeNull()
  })

  test('calibration puts a confidence of exactly 1 in the top bin', () => {
    expect(calibration([{ confidence: 1, correct: true }])!.bins[4]!.n).toBe(1)
  })
})

describe('thresholdSweep', () => {
  const ans = (a: number): JevAnswer => ({
    type: 'choice',
    choice: 'a',
    probabilities: { a, b: Math.round((1 - a) * 1000) / 1000 },
  })
  const samples = [
    { answer: ans(0.9), correct: true },
    { answer: ans(0.8), correct: false },
    { answer: ans(0.6), correct: true }, // margin 0.2
    { answer: ans(0.52), correct: false }, // margin 0.04
    { answer: ans(0.95), correct: undefined }, // no gold: counts for coverage only
  ]
  const cell = (minP: number, minMargin: number) =>
    thresholdSweep(samples, [0.5, 0.75, 0.85], [0, 0.15]).find(c => c.minP === minP && c.minMargin === minMargin)!

  test('coverage counts every asked answer, precision only those with gold', () => {
    expect(cell(0.5, 0)).toMatchObject({ accepted: 5, asked: 5, coverage: 1, acceptedWithGold: 4, precision: 0.5 })
  })

  test('the margin rule removes near-ties', () => {
    // 0.52 vs 0.48 has margin 0.04: out at 0.15, in at 0.
    expect(cell(0.5, 0.15)).toMatchObject({ accepted: 4, coverage: 0.8 })
    expect(cell(0.5, 0.15).precision).toBeCloseTo(2 / 3, 9)
  })

  test('a higher minP trades coverage for precision', () => {
    expect(cell(0.75, 0.15)).toMatchObject({ accepted: 3, acceptedWithGold: 2, precision: 0.5 })
    expect(cell(0.85, 0.15)).toMatchObject({ accepted: 2, acceptedWithGold: 1, precision: 1 })
  })

  test('no samples means null rates, not NaN', () => {
    const [first] = thresholdSweep([], [0.75], [0.15])
    expect(first).toMatchObject({ accepted: 0, asked: 0, coverage: null, precision: null })
  })

  test('the default grid contains the dispatcher defaults', () => {
    expect(SWEEP_MIN_P).toContain(0.75)
    expect(SWEEP_MARGINS).toContain(0.15)
  })
})

// ---------------------------------------------------------------------------
// A small results set with every number worked out by hand
// ---------------------------------------------------------------------------

const cand = (id: string, family: BenchCandidate['family'], priceTier: 'low' | 'mid' | 'high'): BenchCandidate => ({
  id, route: 'anthropic', provider: 'anthropic', family, separationFamily: id, vision: true,
  reasoning: false, priceTier, contextWindow: 1_000_000,
})
const OPUS = cand('opus', 'opus-5.5', 'high')
const SONNET = cand('sonnet', 'sonnet-5-5', 'mid')
const FLASH = cand('flash', 'deepseek-v4.1-flash', 'low')

const S1: BenchScenario = {
  id: 's1', description: 'd1', prompt: 'p1',
  gold: { role: 'review', complexity: 'hard', needsLongContext: false, agentType: 'code-reviewer', model: { tier: 'deep' } },
}
const S2: BenchScenario = {
  id: 's2', description: 'd2', prompt: 'p2',
  gold: { role: 'implement', complexity: 'trivial', needsLongContext: true, agentType: 'dev', model: { tier: 'standard' } },
}
const S3: BenchScenario = { id: 's3', description: 'd3', prompt: 'p3' }

const choice = (top: string, probabilities: Record<string, number>): JevAnswer => ({
  type: 'choice', choice: top, probabilities,
})
const okJev = (latencyMs: number, answers: Record<string, JevAnswer>): JevResult => ({
  ok: true, answers, latencyMs, cached: false, costUsd: 0.001,
  usage: { inputTokens: 100, outputTokens: 10 },
})
const dec = (over: Partial<TeammateRouteDecision> & Pick<TeammateRouteDecision, 'role'>): TeammateRouteDecision => ({
  tier: 'standard', source: 'jev', mode: 'auto', reason: '', ...over,
})
const run = (scenarioId: string, repeat: number, decision: TeammateRouteDecision, jev?: JevResult): BenchRun => ({
  scenarioId, repeat, mode: 'live', decision, ...(jev ? { jev } : {}), wallMs: 1,
})

const ROLES = { review: 0.03, implement: 0.03, design: 0.03, research: 0.03, verify: 0.03, computer_use: 0.03 }
const roleAns = (top: string, p: number) => {
  const others = Object.keys(ROLES).filter(k => k !== top)
  return choice(top, { [top]: p, ...Object.fromEntries(others.map(k => [k, (1 - p) / others.length])) })
}
const modelAns = (top: string, p: number, second: string, q: number) => {
  const rest = ['opus', 'sonnet', 'flash'].filter(k => k !== top && k !== second)[0]!
  return choice(top, { [top]: p, [second]: q, [rest]: Math.round((1 - p - q) * 1e6) / 1e6 })
}
const typeAns = (top: string, p: number) => {
  const others = ['code-reviewer', 'dev', 'default'].filter(k => k !== top)
  return choice(top, { [top]: p, [others[0]!]: (1 - p) / 2, [others[1]!]: (1 - p) / 2 })
}
const answers = (over: Record<string, JevAnswer>): Record<string, JevAnswer> => ({
  complexity: { type: 'score', score: 1 },
  needs_long_context: { type: 'boolean', probability: 0.2 },
  ...over,
})

const RUNS: BenchRun[] = [
  // A: s1 - everything right and confident
  run('s1', 1,
    dec({ role: 'review', roleSource: 'jev', model: 'opus', family: 'opus-5.5', modelSource: 'jev', agentType: 'code-reviewer' }),
    okJev(100, answers({ role: roleAns('review', 0.9), model: modelAns('opus', 0.8, 'sonnet', 0.15), agent_type: typeAns('code-reviewer', 0.8), complexity: { type: 'score', score: 2 } }))),
  // B: s1 - wrong role, unconfident model (tier table decides), unconfident type
  run('s1', 2,
    dec({ role: 'implement', roleSource: 'jev', model: 'opus', family: 'opus-5.5', modelSource: 'tier', agentType: 'default' }),
    okJev(200, answers({ role: roleAns('implement', 0.8), model: modelAns('sonnet', 0.5, 'opus', 0.3), agent_type: typeAns('dev', 0.6) }))),
  // C: s2 - JEV picks a fast model; a rule corrects it to sonnet
  run('s2', 1,
    dec({ role: 'implement', roleSource: 'jev', model: 'sonnet', family: 'sonnet-5-5', modelSource: 'jev', reason: 'role jev; model jev p=0.90 (corrected from flash)', agentType: 'dev' }),
    okJev(300, answers({ role: roleAns('implement', 0.85), model: modelAns('flash', 0.9, 'sonnet', 0.06), agent_type: typeAns('dev', 0.8), complexity: { type: 'score', score: 0.4 }, needs_long_context: { type: 'boolean', probability: 0.9 } }))),
  // D: s2 - the call fails; heuristic and tier table decide
  run('s2', 2,
    dec({ role: 'implement', roleSource: 'heuristic', source: 'heuristic', model: 'sonnet', family: 'sonnet-5-5', modelSource: 'tier', agentType: 'default' }),
    { ok: false, reason: 'timeout', latencyMs: 3000 }),
  // E: s3 - no gold anywhere
  run('s3', 1,
    dec({ role: 'design', roleSource: 'jev', model: 'sonnet', family: 'sonnet-5-5', modelSource: 'jev', agentType: 'default' }),
    okJev(400, answers({ role: roleAns('design', 0.9), model: modelAns('sonnet', 0.85, 'opus', 0.1), agent_type: typeAns('default', 0.9) }))),
]

const BASELINE: BenchRun[] = [
  { ...run('s1', 0, dec({ role: 'review', source: 'heuristic', model: 'opus', family: 'opus-5.5' })), mode: 'baseline' },
  { ...run('s2', 0, dec({ role: 'implement', source: 'heuristic', model: 'sonnet', family: 'sonnet-5-5' })), mode: 'baseline' },
  { ...run('s3', 0, dec({ role: 'implement', source: 'heuristic', model: 'sonnet', family: 'sonnet-5-5' })), mode: 'baseline' },
]

const HAND: BenchResults = {
  schema: BENCH_SCHEMA,
  createdAt: '2026-01-01T00:00:00.000Z',
  config: {
    mode: 'live', repeat: 2, endpoint: 'https://example.invalid/evaluate', jevModel: 'test/jev',
    minP: 0.75, minMargin: 0.15, timeoutMs: 3000, allowlist: [], leaderRoute: 'anthropic',
    profiles: [], agentTypes: ['code-reviewer', 'dev'],
    tierFamilies: { deep: ['opus-5.5'], standard: ['sonnet-5-5'], fast: ['deepseek-v4.1-flash'] },
    roleTiers: { ...DEFAULT_ROLE_TIERS }, withBaseline: true, zeroDataRetention: false,
  },
  scenarios: [S1, S2, S3],
  candidates: { s1: [OPUS, SONNET, FLASH], s2: [OPUS, SONNET, FLASH], s3: [OPUS, SONNET, FLASH] },
  requests: {},
  runs: RUNS,
  baseline: BASELINE,
  aborted: false,
}

describe('summarize (hand-checked)', () => {
  const s = summarize(HAND)

  test('JEV calls, failures, latency and cost', () => {
    expect(s.jev).toMatchObject({ calls: 5, ok: 4, failures: { timeout: 1 }, inputTokens: 400, outputTokens: 40 })
    expect(s.jev!.latency).toEqual({ n: 5, meanMs: 800, p50Ms: 300, p95Ms: 3000, maxMs: 3000 })
    expect(s.jev!.costUsd).toBeCloseTo(0.004, 9)
    expect(s.jev!.costPerCallUsd).toBeCloseTo(0.0008, 9)
    expect(s.candidates).toEqual({ min: 3, median: 3, max: 3 })
  })

  test('role: acceptance, accuracy, precision, calibration, final accuracy, confusion', () => {
    expect(s.role.asked).toBe(4)
    expect(s.role.accepted).toEqual({ n: 4, d: 4, rate: 1 })
    expect(s.role.gold).toBe(3)
    expect(s.role.top1).toMatchObject({ n: 2, d: 3 })
    expect(s.role.precisionWhenAccepted).toMatchObject({ n: 2, d: 3 })
    expect(s.role.calibration!.brier).toBeCloseTo(0.224167, 5)
    expect(s.role.calibration!.ece).toBeCloseTo(0.85 - 2 / 3, 9)
    // All four runs with a role gold, JEV or heuristic: A ok, B wrong, C ok, D ok.
    expect(s.role.finalAccuracy).toMatchObject({ n: 3, d: 4 })
    expect(s.role.confusion).toEqual({ review: { review: 1, implement: 1 }, implement: { implement: 1 } })
  })

  test('model: acceptance, raw accuracy against the tier gold, final ok, outcomes', () => {
    expect(s.model.asked).toBe(4)
    expect(s.model.accepted).toMatchObject({ n: 3, d: 4 }) // A, C, E; B is under minP
    expect(s.model.gold).toBe(3)
    expect(s.model.top1).toMatchObject({ n: 1, d: 3 }) // only A's opus is deep-tier
    expect(s.model.precisionWhenAccepted).toMatchObject({ n: 1, d: 2 }) // A right, C wrong
    expect(s.model.finalOk).toMatchObject({ n: 4, d: 4 })
    expect(s.model.outcomes).toEqual({
      accepted: 2, corrected: 1, unconfident: 1, 'rejected-by-rules': 0, 'jev-failed': 1, 'no-answer': 0, other: 0,
    })
  })

  test('agent type', () => {
    expect(s.agentType.asked).toBe(4)
    expect(s.agentType.accepted).toMatchObject({ n: 3, d: 4 })
    expect(s.agentType.top1).toMatchObject({ n: 2, d: 3 })
    expect(s.agentType.precisionWhenAccepted).toMatchObject({ n: 2, d: 2 })
    // Live runs with a type gold: A ok, B default, C ok, D default.
    expect(s.agentType.finalAccuracy).toMatchObject({ n: 2, d: 4 })
  })

  test('complexity and long context', () => {
    expect(s.complexity.exact).toMatchObject({ n: 2, d: 3 })
    expect(s.complexity.meanAbsError).toBeCloseTo((0 + 1 + 0.4) / 3, 9)
    expect(s.longContext.accuracy).toMatchObject({ n: 3, d: 3 })
    expect(s.longContext.brier).toBeCloseTo((0.04 + 0.04 + 0.01) / 3, 9)
  })

  test('what gets chosen, by role and complexity', () => {
    expect(s.choices.byRole).toEqual({
      review: { opus: 1 },
      implement: { opus: 1, sonnet: 2 },
      design: { sonnet: 1 },
    })
    expect(s.choices.agentTypes).toEqual({ 'code-reviewer': 1, default: 3, dev: 1 })
  })

  test('stability across repeats and the baseline agreement', () => {
    expect(s.stability!.scenarios).toBe(2)
    expect(s.stability!.roleShare).toBeCloseTo(0.75, 9)
    expect(s.stability!.modelShare).toBe(1)
    expect(s.stability!.agentTypeShare).toBeCloseTo(0.5, 9)
    expect(s.stability!.unstable).toEqual([])
    // Live decisions vs the JEV-off pass: B and E differ in role only.
    expect(s.baseline).toEqual({
      role: { n: 3, d: 5, rate: 0.6 },
      model: { n: 5, d: 5, rate: 1 },
      family: { n: 5, d: 5, rate: 1 },
    })
  })

  test('per-scenario rows carry the flags', () => {
    const row = (id: string) => s.rows.find(r => r.id === id)!
    expect(row('s2').flags).toEqual(expect.arrayContaining(['corrected', 'jev-failed']))
    expect(row('s1').runs).toBe(2)
    expect(row('s3').goldRole).toBeUndefined()
    expect(row('s3').flags).toEqual([])
  })

  test('the configured thresholds are always a row and column of the sweep', () => {
    const odd = summarize({ ...HAND, config: { ...HAND.config, minP: 0.66, minMargin: 0.11 } })
    expect(odd.role.sweep.some(c => c.minP === 0.66 && c.minMargin === 0.11)).toBe(true)
  })

  test('a baseline-mode run has no JEV section and no agent-type judgement', async () => {
    const results = await runBenchmark([S1, S2], { mode: 'baseline', environment: buildBenchEnvironment() })
    const base = summarize(results)
    expect(base.jev).toBeNull()
    expect(base.role.asked).toBe(0)
    expect(base.agentType.finalAccuracy).toMatchObject({ n: 0, d: 0, rate: null })
    expect(base.rows.every(r => r.agentType.ok === undefined)).toBe(true)
  })
})

describe('summarize over a full fake-JEV run', () => {
  test('counts stay consistent', async () => {
    const results = await runBenchmark(SEED_SCENARIOS, {
      mode: 'live',
      environment: buildBenchEnvironment(),
      repeat: 2,
      withBaseline: true,
      evaluate: createFakeJev({ scenarios: SEED_SCENARIOS, seed: 11, failEvery: 17 }),
    })
    const s = summarize(results)
    expect(s.runs).toBe(SEED_SCENARIOS.length * 2)
    expect(s.jev!.calls).toBe(s.runs)
    expect(s.jev!.ok + Object.values(s.jev!.failures).reduce((a, b) => a + b, 0)).toBe(s.jev!.calls)
    for (const q of [s.role, s.model, s.agentType]) {
      expect(q.accepted.n).toBeLessThanOrEqual(q.asked)
      expect(q.top1.d).toBeLessThanOrEqual(q.asked)
      expect(q.asked).toBeLessThanOrEqual(s.jev!.ok)
    }
    const outcomeTotal = Object.values(s.model.outcomes).reduce((a, b) => a + b, 0)
    expect(outcomeTotal).toBe(s.jev!.calls)
    expect(s.baseline!.role.d).toBe(s.runs)
    // A sweep cell never accepts more than it was asked.
    expect(s.role.sweep.every(c => c.accepted <= c.asked)).toBe(true)
  })
})

describe('formatReport', () => {
  test('a baseline report says JEV was not called and has no threshold sweep', async () => {
    const results = await runBenchmark([S1, S2, S3], { mode: 'baseline', environment: buildBenchEnvironment() })
    const text = formatReport(summarize(results), results)
    expect(text).toContain('baseline')
    expect(text).toContain('JEV was not called')
    expect(text).toContain('What gets chosen')
    expect(text).not.toContain('threshold sweep')
    expect(text).not.toContain('JEV calls')
  })

  test('a live report has every section and marks the configured sweep cell', () => {
    const text = formatReport(summarize(HAND), HAND)
    for (const heading of [
      'JEV calls', 'What JEV answers', 'Final decisions vs gold', 'What gets chosen',
      'Stability across repeats', 'Agreement with the JEV-off baseline', 'Rule A threshold sweep',
    ]) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('failed 1 [timeout ×1]')
    expect(text).toContain('role confusion (gold→JEV): review→implement ×1')
    // The 0.75 / 0.15 cell carries the marker: one per sweep table, three
    // tables. (The section title mentions "* = configured" too; a cell's
    // marker follows a "%" or the "a" of "n/a".)
    expect(text.match(/[%a] \*(?=\s|$)/g)?.length).toBe(3)
  })

  test('verbose adds the per-scenario table', () => {
    const plain = formatReport(summarize(HAND), HAND)
    const verbose = formatReport(summarize(HAND), HAND, { verbose: true })
    expect(plain).not.toContain('Per scenario')
    expect(verbose).toContain('Per scenario')
    expect(verbose).toContain('corrected')
  })

  test('missing data renders as n/a instead of NaN or undefined', async () => {
    const results = await runBenchmark([S3], { mode: 'baseline', environment: buildBenchEnvironment() })
    const text = formatReport(summarize(results), results)
    expect(text).toContain('n/a')
    expect(text).not.toMatch(/NaN|undefined/)
  })
})
