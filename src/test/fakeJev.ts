/**
 * A seeded, offline stand-in for JEV, for tests of the JEV benchmark.
 *
 * It answers every question in a request with valid typed answers (keys match
 * the criteria, probabilities sum to 1, the choice is the argmax). Role,
 * complexity, long-context and agent type follow the scenario's gold labels
 * with tunable noise; the model pick is seeded-random, so its accuracy is
 * whatever the seed gives. It is NOT a model of real JEV behaviour: never
 * quote numbers measured against it.
 */
import { asList, COMPLEXITY_LEVELS, type BenchScenario } from '../services/jev/benchmark.js'
import type { JevAnswer, JevQuestion, JevRequest, JevResult } from '../services/jev/client.js'

export type FakeJevOptions = {
  /** Scenarios, matched to requests by their description. */
  scenarios: readonly BenchScenario[]
  seed?: number
  /** Chance the top role is the gold one (default 0.9). */
  roleAccuracy?: number
  /** Chance the top agent type is the gold one (default 0.8). */
  typeAccuracy?: number
  /** Every Nth call fails with a timeout (default: never). */
  failEvery?: number
}

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A probability distribution over `keys` with `top` as the argmax. `wantedTopP`
 * is raised when needed so no other key can reach it; the rest is split by
 * random weights. Sums to 1.
 */
export function distribution(
  keys: readonly string[],
  top: string,
  wantedTopP: number,
  random: () => number,
): Record<string, number> {
  const others = keys.filter(k => k !== top)
  if (others.length === 0) return { [top]: 1 }
  const weights = others.map(() => 0.05 + random())
  const total = weights.reduce((a, b) => a + b, 0)
  const shares = weights.map(w => w / total)
  // The biggest other gets (1 - topP) * maxShare; keep it strictly below topP.
  const maxShare = Math.max(...shares)
  const topP = Math.min(0.99, Math.max(wantedTopP, maxShare / (1 + maxShare) + 0.01))
  const out: Record<string, number> = { [top]: topP }
  others.forEach((key, i) => {
    out[key] = (1 - topP) * shares[i]!
  })
  return out
}

export function createFakeJev(options: FakeJevOptions) {
  const random = seededRandom(options.seed ?? 1)
  const byDescription = new Map(options.scenarios.map(s => [s.description, s]))
  const roleAccuracy = options.roleAccuracy ?? 0.9
  const typeAccuracy = options.typeAccuracy ?? 0.8
  let calls = 0

  const pick = (keys: readonly string[]): string => keys[Math.floor(random() * keys.length)]!

  const choose = (
    question: Extract<JevQuestion, { type: 'choice' }>,
    goldChoices: readonly string[],
    accuracy: number,
  ): JevAnswer => {
    const keys = Object.keys(question.criteria)
    const usable = goldChoices.filter(g => keys.includes(g))
    const right = usable.length > 0 && random() < accuracy
    const wrongPool = keys.filter(k => !usable.includes(k))
    const top = right ? usable[0]! : pick(wrongPool.length > 0 ? wrongPool : keys)
    const topP = right ? 0.6 + random() * 0.38 : 0.35 + random() * 0.3
    return { type: 'choice', choice: top, probabilities: distribution(keys, top, topP, random) }
  }

  return async (request: JevRequest): Promise<JevResult> => {
    calls += 1
    const latencyMs = 300 + Math.round(random() * 1200)
    if (options.failEvery && calls % options.failEvery === 0) {
      return { ok: false, reason: 'timeout', latencyMs: 3000 }
    }
    const state = request.state as { description?: string }
    const gold = byDescription.get(state.description ?? '')?.gold
    const answers: Record<string, JevAnswer> = {}
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type === 'choice') {
        const goldChoices =
          name === 'role' ? (asList(gold?.role) as string[])
          : name === 'agent_type' ? asList(gold?.agentType)
          : []
        answers[name] = choose(question, goldChoices, name === 'role' ? roleAccuracy : typeAccuracy)
      } else if (question.type === 'score') {
        const target = asList(gold?.complexity)[0]
        const index = target ? COMPLEXITY_LEVELS.indexOf(target) : 1
        const score = Math.max(0, Math.min(question.criteria.length - 1, index + (random() - 0.5) * 0.8))
        answers[name] = { type: 'score', score }
      } else {
        const long = gold?.needsLongContext
        const base = long === undefined ? 0.5 : long ? 0.8 : 0.2
        answers[name] = { type: 'boolean', probability: Math.max(0, Math.min(1, base + (random() - 0.5) * 0.3)) }
      }
    }
    return {
      ok: true,
      answers,
      latencyMs,
      cached: false,
      usage: { inputTokens: 900 + Math.round(random() * 400), outputTokens: 60 },
      costUsd: 0.0004,
    }
  }
}
