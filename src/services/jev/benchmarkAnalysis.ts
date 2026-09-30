/**
 * Statistics over a JEV benchmark's results. Everything here is a pure
 * function of `BenchResults`, so a saved results file can be re-analysed
 * (new thresholds, new gold labels) without another call to JEV.
 *
 * Terms:
 * - "raw pick": JEV's own top choice, before Rule A and the hard rules.
 * - "accepted": Rule A (`acceptChoice`) takes the raw pick at the thresholds.
 * - "final": what the dispatcher finally decided (raw pick, a corrected pick,
 *   or the heuristic / tier-table fallback).
 * - "gold": the scenario's label for the question, when it has one.
 */
import * as jevClient from './client.js'
import type { JevAnswer } from './client.js'
import {
  asList,
  COMPLEXITY_LEVELS,
  evaluateModelGold,
  type BenchCandidate,
  type BenchResults,
  type BenchRun,
  type BenchScenario,
  type ModelGold,
} from './benchmark.js'

/**
 * The model gold that applies to a run: the scenario's `model` label normally,
 * its `cyberModel` label (where the cyber policy should send it) in cyber mode.
 */
export function modelGoldOf(
  scenario: BenchScenario,
  config: Pick<BenchResults['config'], 'cyber'>,
): ModelGold | undefined {
  return config.cyber ? scenario.gold?.cyberModel : scenario.gold?.model
}

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

export type Rate = { n: number; d: number; rate: number | null }

export function rate(n: number, d: number): Rate {
  return { n, d, rate: d === 0 ? null : n / d }
}

/** Nearest-rank percentile of an ascending list; NaN when empty. */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return Number.NaN
  const rank = Math.ceil(q * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]!
}

export type LatencyStats = { n: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number }

export function latencyStats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1]!,
  }
}

export type CalibrationBin = {
  lo: number
  hi: number
  n: number
  meanConfidence: number
  accuracy: number
}

export type Calibration = {
  n: number
  /** Mean squared gap between the top pick's probability and whether it was right. */
  brier: number
  /** Expected calibration error: the bin-weighted gap between confidence and accuracy. */
  ece: number
  bins: CalibrationBin[]
}

export function calibration(
  samples: ReadonlyArray<{ confidence: number; correct: boolean }>,
  binCount = 5,
): Calibration | null {
  if (samples.length === 0) return null
  const acc = Array.from({ length: binCount }, (_, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    n: 0,
    conf: 0,
    hit: 0,
  }))
  let brier = 0
  for (const s of samples) {
    brier += (s.confidence - (s.correct ? 1 : 0)) ** 2
    const bin = acc[Math.min(binCount - 1, Math.max(0, Math.floor(s.confidence * binCount)))]!
    bin.n += 1
    bin.conf += s.confidence
    bin.hit += s.correct ? 1 : 0
  }
  let ece = 0
  const bins: CalibrationBin[] = acc.map(b => {
    if (b.n === 0) return { lo: b.lo, hi: b.hi, n: 0, meanConfidence: 0, accuracy: 0 }
    const meanConfidence = b.conf / b.n
    const accuracy = b.hit / b.n
    ece += (b.n / samples.length) * Math.abs(accuracy - meanConfidence)
    return { lo: b.lo, hi: b.hi, n: b.n, meanConfidence, accuracy }
  })
  return { n: samples.length, brier: brier / samples.length, ece, bins }
}

// ---------------------------------------------------------------------------
// Samples: one JEV choice answer, tied to its run and (when labelled) its gold
// ---------------------------------------------------------------------------

export type QuestionName = 'role' | 'model' | 'agent_type'

type ChoiceAnswer = Extract<JevAnswer, { type: 'choice' }>

export type Sample = {
  run: BenchRun
  scenario: BenchScenario
  answer: ChoiceAnswer
  top: string
  confidence: number
  /** Whether the raw pick matches gold; undefined when the scenario has none. */
  correct: boolean | undefined
}

export type Thresholds = { minP: number; minMargin: number }

function acceptedAt(answer: JevAnswer, t: Thresholds): boolean {
  return jevClient.acceptChoice(answer, t) !== null
}

function liveRuns(results: BenchResults): BenchRun[] {
  return results.runs.filter(r => r.mode === 'live')
}

function okAnswers(run: BenchRun): Record<string, JevAnswer> | undefined {
  return run.jev && run.jev.ok ? run.jev.answers : undefined
}

function candidateIndex(results: BenchResults): Map<string, Map<string, BenchCandidate>> {
  const out = new Map<string, Map<string, BenchCandidate>>()
  for (const [scenarioId, list] of Object.entries(results.candidates)) {
    out.set(scenarioId, new Map(list.map(c => [c.id, c])))
  }
  return out
}

function collectSamples(
  results: BenchResults,
  question: QuestionName,
  index: Map<string, Map<string, BenchCandidate>>,
): Sample[] {
  const scenarios = new Map(results.scenarios.map(s => [s.id, s]))
  const samples: Sample[] = []
  for (const run of liveRuns(results)) {
    const scenario = scenarios.get(run.scenarioId)
    const answer = okAnswers(run)?.[question]
    if (!scenario || !answer || answer.type !== 'choice') continue
    if (!Object.hasOwn(answer.probabilities, answer.choice)) continue
    const confidence = answer.probabilities[answer.choice]!
    let correct: boolean | undefined
    if (question === 'role') {
      const gold = asList(scenario.gold?.role) as string[]
      correct = gold.length > 0 ? gold.includes(answer.choice) : undefined
    } else if (question === 'agent_type') {
      const gold = asList(scenario.gold?.agentType)
      correct = gold.length > 0 ? gold.includes(answer.choice) : undefined
    } else {
      correct = evaluateModelGold(
        modelGoldOf(scenario, results.config),
        index.get(scenario.id)?.get(answer.choice),
        results.config.tierFamilies,
      )
    }
    samples.push({ run, scenario, answer, top: answer.choice, confidence, correct })
  }
  return samples
}

// ---------------------------------------------------------------------------
// Rule A threshold sweep
// ---------------------------------------------------------------------------

export const SWEEP_MIN_P: readonly number[] = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]
export const SWEEP_MARGINS: readonly number[] = [0, 0.15, 0.3]

export type SweepCell = {
  minP: number
  minMargin: number
  accepted: number
  asked: number
  /** accepted / asked */
  coverage: number | null
  /** Among accepted picks that have gold: the share that is right. */
  precision: number | null
  acceptedWithGold: number
}

export function thresholdSweep(
  samples: ReadonlyArray<{ answer: JevAnswer; correct: boolean | undefined }>,
  minPs: readonly number[] = SWEEP_MIN_P,
  margins: readonly number[] = SWEEP_MARGINS,
): SweepCell[] {
  const cells: SweepCell[] = []
  for (const minP of minPs) {
    for (const minMargin of margins) {
      const accepted = samples.filter(s => acceptedAt(s.answer, { minP, minMargin }))
      const withGold = accepted.filter(s => s.correct !== undefined)
      cells.push({
        minP,
        minMargin,
        accepted: accepted.length,
        asked: samples.length,
        coverage: samples.length === 0 ? null : accepted.length / samples.length,
        precision:
          withGold.length === 0 ? null : withGold.filter(s => s.correct).length / withGold.length,
        acceptedWithGold: withGold.length,
      })
    }
  }
  return cells
}

function unionSorted(base: readonly number[], extra: number): number[] {
  return [...new Set([...base, extra])].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type QuestionSummary = {
  /** Live runs that produced a usable answer to this question. */
  asked: number
  /** Rule A takes JEV's raw pick at the configured thresholds. */
  accepted: Rate
  /** Asked runs whose scenario has a gold label for the question. */
  gold: number
  /** JEV's raw pick matches gold. */
  top1: Rate
  /** The same, among the picks Rule A accepted. */
  precisionWhenAccepted: Rate
  calibration: Calibration | null
  sweep: SweepCell[]
}

export type ModelOutcome =
  | 'accepted' // JEV's pick was used as is
  | 'corrected' // a hard rule or usage moved it to JEV's next-best legal option
  | 'unconfident' // Rule A declined; the tier table chose
  | 'rejected-by-rules' // Rule A took it but every JEV option broke a rule; the tier table chose
  | 'jev-failed' // the JEV call failed; the tier table chose
  | 'no-answer' // no model question was asked or answered
  | 'other'

export type BenchSummary = {
  mode: BenchResults['config']['mode']
  scenarios: number
  runs: number
  aborted: boolean
  thresholds: Thresholds
  /** Models the dispatcher offered JEV per scenario. */
  candidates: { min: number; median: number; max: number } | null
  /** Null in baseline mode: JEV was not called. */
  jev: {
    calls: number
    ok: number
    failures: Record<string, number>
    latency: LatencyStats | null
    costUsd: number
    costPerCallUsd: number | null
    inputTokens: number
    outputTokens: number
  } | null
  role: QuestionSummary & {
    /** The dispatcher's final role matches gold, over every run (JEV or heuristic). */
    finalAccuracy: Rate
    /** gold role -> JEV raw pick -> count, for labelled asked runs. */
    confusion: Record<string, Record<string, number>>
  }
  model: QuestionSummary & {
    /** The dispatcher's final model satisfies gold, over every run. */
    finalOk: Rate
    outcomes: Record<ModelOutcome, number>
  }
  agentType: QuestionSummary & {
    /** The final agent type matches gold, over live runs that asked for one. */
    finalAccuracy: Rate
  }
  complexity: { exact: Rate; meanAbsError: number | null }
  longContext: { accuracy: Rate; brier: number | null }
  choices: {
    /** final role -> final model -> count */
    byRole: Record<string, Record<string, number>>
    byComplexity: Record<string, Record<string, number>>
    agentTypes: Record<string, number>
  }
  stability: {
    /** Scenarios that ran at least twice. */
    scenarios: number
    /** Mean share of the most common final value, per question. 1 = perfectly stable. */
    roleShare: number | null
    modelShare: number | null
    agentTypeShare: number | null
    unstable: Array<{ id: string; models: Record<string, number> }>
  } | null
  /** Live decisions against the JEV-off baseline pass. */
  baseline: {
    role: Rate
    model: Rate
    family: Rate
  } | null
  /**
   * Runs where the dispatcher raised instead of deciding. In cyber mode that is
   * a real outcome ("no available model"), so it is reported, not hidden.
   */
  errors: Array<{ id: string; message: string }>
  rows: ScenarioRow[]
}

export type ScenarioRow = {
  id: string
  runs: number
  goldRole?: string
  role: { value: string; share: number; meanP: number | null; ok?: boolean }
  model: { value: string; share: number; meanP: number | null; ok?: boolean }
  agentType: { value: string; share: number; meanP: number | null; ok?: boolean }
  latencyMs: number | null
  flags: string[]
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function bump2(map: Record<string, Record<string, number>>, a: string, b: string): void {
  bump((map[a] ??= {}), b)
}

function modal(values: readonly string[]): { value: string; share: number } {
  const counts: Record<string, number> = {}
  for (const v of values) bump(counts, v)
  const [value, count] = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0] ?? ['-', 0]
  return { value, share: values.length === 0 ? 0 : count / values.length }
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

export function summarize(
  results: BenchResults,
  options: { sweepMinP?: readonly number[]; sweepMargins?: readonly number[] } = {},
): BenchSummary {
  const { config } = results
  const thresholds: Thresholds = { minP: config.minP, minMargin: config.minMargin }
  const index = candidateIndex(results)
  const scenarios = new Map(results.scenarios.map(s => [s.id, s]))
  const minPs = unionSorted(options.sweepMinP ?? SWEEP_MIN_P, thresholds.minP)
  const margins = unionSorted(options.sweepMargins ?? SWEEP_MARGINS, thresholds.minMargin)
  const live = liveRuns(results)

  const question = (name: QuestionName): { samples: Sample[]; summary: QuestionSummary } => {
    const samples = collectSamples(results, name, index)
    const accepted = samples.filter(s => acceptedAt(s.answer, thresholds))
    const gold = samples.filter(s => s.correct !== undefined)
    const goldAccepted = accepted.filter(s => s.correct !== undefined)
    return {
      samples,
      summary: {
        asked: samples.length,
        accepted: rate(accepted.length, samples.length),
        gold: gold.length,
        top1: rate(gold.filter(s => s.correct).length, gold.length),
        precisionWhenAccepted: rate(
          goldAccepted.filter(s => s.correct).length,
          goldAccepted.length,
        ),
        calibration: calibration(
          gold.map(s => ({ confidence: s.confidence, correct: s.correct === true })),
        ),
        sweep: thresholdSweep(samples, minPs, margins),
      },
    }
  }
  const role = question('role')
  const model = question('model')
  const type = question('agent_type')

  // --- JEV calls ---------------------------------------------------------
  const called = live.filter(r => r.jev)
  const jev: BenchSummary['jev'] =
    config.mode === 'baseline'
      ? null
      : (() => {
          const failures: Record<string, number> = {}
          let costUsd = 0
          let inputTokens = 0
          let outputTokens = 0
          let ok = 0
          for (const run of called) {
            const r = run.jev!
            if (!r.ok) {
              bump(failures, r.reason)
              continue
            }
            ok += 1
            costUsd += r.costUsd ?? 0
            inputTokens += r.usage?.inputTokens ?? 0
            outputTokens += r.usage?.outputTokens ?? 0
          }
          return {
            calls: called.length,
            ok,
            failures,
            latency: latencyStats(called.map(r => r.jev!.latencyMs)),
            costUsd,
            costPerCallUsd: called.length === 0 ? null : costUsd / called.length,
            inputTokens,
            outputTokens,
          }
        })()

  // --- Final decisions vs gold (every run, JEV or heuristic) ---------------
  let roleFinalN = 0
  let roleFinalHit = 0
  let modelFinalN = 0
  let modelFinalHit = 0
  let typeFinalN = 0
  let typeFinalHit = 0
  for (const run of results.runs) {
    const scenario = scenarios.get(run.scenarioId)
    if (!scenario?.gold) continue
    const goldRoles = asList(scenario.gold.role) as string[]
    if (goldRoles.length > 0) {
      roleFinalN += 1
      if (goldRoles.includes(run.decision.role)) roleFinalHit += 1
    }
    const modelGold = modelGoldOf(scenario, config)
    if (modelGold) {
      modelFinalN += 1
      const chosen = run.decision.model
        ? index.get(scenario.id)?.get(run.decision.model)
        : undefined
      if (evaluateModelGold(modelGold, chosen, config.tierFamilies) === true) {
        modelFinalHit += 1
      }
    }
    const goldTypes = asList(scenario.gold.agentType)
    if (run.mode === 'live' && goldTypes.length > 0 && run.decision.agentType !== undefined) {
      typeFinalN += 1
      if (goldTypes.includes(run.decision.agentType)) typeFinalHit += 1
    }
  }

  // --- Role confusion ------------------------------------------------------
  const confusion: Record<string, Record<string, number>> = {}
  for (const s of role.samples) {
    const gold = asList(s.scenario.gold?.role) as string[]
    if (gold.length === 0) continue
    bump2(confusion, s.correct ? s.top : gold[0]!, s.top)
  }

  // --- Model outcomes ------------------------------------------------------
  const outcomes: Record<ModelOutcome, number> = {
    accepted: 0,
    corrected: 0,
    unconfident: 0,
    'rejected-by-rules': 0,
    'jev-failed': 0,
    'no-answer': 0,
    other: 0,
  }
  for (const run of called) {
    if (!run.jev!.ok) {
      outcomes['jev-failed'] += 1
      continue
    }
    const answer = okAnswers(run)?.model
    if (!answer || answer.type !== 'choice') {
      outcomes['no-answer'] += 1
      continue
    }
    const source = run.decision.modelSource
    if (source === 'jev') {
      outcomes[run.decision.model === answer.choice ? 'accepted' : 'corrected'] += 1
    } else if (source === 'tier') {
      outcomes[acceptedAt(answer, thresholds) ? 'rejected-by-rules' : 'unconfident'] += 1
    } else {
      outcomes.other += 1
    }
  }

  // --- Complexity and long context ----------------------------------------
  let complexityN = 0
  let complexityHit = 0
  let complexityErr = 0
  let longN = 0
  let longHit = 0
  let longBrier = 0
  for (const run of live) {
    const answers = okAnswers(run)
    const gold = scenarios.get(run.scenarioId)?.gold
    if (!answers || !gold) continue
    const score = answers.complexity
    const goldLevels = asList(gold.complexity)
    if (score?.type === 'score' && goldLevels.length > 0) {
      const goldIdx = goldLevels.map(l => COMPLEXITY_LEVELS.indexOf(l))
      const predicted = Math.max(0, Math.min(2, Math.round(score.score)))
      complexityN += 1
      if (goldIdx.includes(predicted)) complexityHit += 1
      complexityErr += Math.min(...goldIdx.map(i => Math.abs(score.score - i)))
    }
    const long = answers.needs_long_context
    if (long?.type === 'boolean' && gold.needsLongContext !== undefined) {
      longN += 1
      const y = gold.needsLongContext ? 1 : 0
      if (long.probability >= 0.5 === gold.needsLongContext) longHit += 1
      longBrier += (long.probability - y) ** 2
    }
  }

  // --- What gets chosen ------------------------------------------------------
  const byRole: Record<string, Record<string, number>> = {}
  const byComplexity: Record<string, Record<string, number>> = {}
  const agentTypes: Record<string, number> = {}
  for (const run of results.runs) {
    const chosen = run.decision.model ?? '(default)'
    bump2(byRole, run.decision.role, chosen)
    bump2(byComplexity, run.decision.complexity ?? '?', chosen)
    if (run.decision.agentType !== undefined) bump(agentTypes, run.decision.agentType)
  }

  // --- Per-scenario rows and stability ---------------------------------------
  const rows: ScenarioRow[] = []
  const shares = { role: [] as number[], model: [] as number[], type: [] as number[] }
  const unstable: Array<{ id: string; models: Record<string, number> }> = []
  for (const scenario of results.scenarios) {
    const runs = results.runs.filter(r => r.scenarioId === scenario.id)
    if (runs.length === 0) continue
    const roleModal = modal(runs.map(r => r.decision.role))
    const modelModal = modal(runs.map(r => r.decision.model ?? '(default)'))
    const typeModal = modal(runs.map(r => r.decision.agentType ?? '-'))
    const answers = runs.map(okAnswers)
    const topP = (name: QuestionName): number | null =>
      mean(
        answers.flatMap(a => {
          const ans = a?.[name]
          return ans && ans.type === 'choice' && Object.hasOwn(ans.probabilities, ans.choice)
            ? [ans.probabilities[ans.choice]!]
            : []
        }),
      )
    const goldRoles = asList(scenario.gold?.role) as string[]
    const goldTypes = asList(scenario.gold?.agentType)
    const chosen = index.get(scenario.id)?.get(modelModal.value)
    const rowModelGold = modelGoldOf(scenario, config)
    const modelOk = rowModelGold
      ? evaluateModelGold(rowModelGold, chosen, config.tierFamilies)
      : undefined
    const roleOk = goldRoles.length > 0 ? goldRoles.includes(roleModal.value) : undefined
    // Only JEV chooses an agent type; a baseline run always yields `default`,
    // so judging it against gold would flag every scenario.
    const typeOk =
      runs.some(r => r.mode === 'live') && goldTypes.length > 0 && typeModal.value !== '-'
        ? goldTypes.includes(typeModal.value)
        : undefined
    const latencies = runs.flatMap(r => (r.jev ? [r.jev.latencyMs] : []))
    const flags: string[] = []
    if (roleOk === false) flags.push('role-miss')
    if (modelOk === false) flags.push('model-miss')
    if (typeOk === false) flags.push('type-miss')
    if (runs.some(r => r.decision.modelSource === 'jev' && r.decision.reason.includes('corrected'))) {
      flags.push('corrected')
    }
    if (runs.some(r => r.jev && !r.jev.ok)) flags.push('jev-failed')
    if (runs.length > 1) {
      shares.role.push(roleModal.share)
      shares.model.push(modelModal.share)
      shares.type.push(typeModal.share)
      const counts: Record<string, number> = {}
      for (const r of runs) bump(counts, r.decision.model ?? '(default)')
      if (Object.keys(counts).length > 1) {
        unstable.push({ id: scenario.id, models: counts })
        flags.push('unstable')
      }
    }
    rows.push({
      id: scenario.id,
      runs: runs.length,
      ...(goldRoles.length > 0 ? { goldRole: goldRoles.join('|') } : {}),
      role: { value: roleModal.value, share: roleModal.share, meanP: topP('role'), ...(roleOk !== undefined ? { ok: roleOk } : {}) },
      model: { value: modelModal.value, share: modelModal.share, meanP: topP('model'), ...(modelOk !== undefined ? { ok: modelOk } : {}) },
      agentType: { value: typeModal.value, share: typeModal.share, meanP: topP('agent_type'), ...(typeOk !== undefined ? { ok: typeOk } : {}) },
      latencyMs: mean(latencies),
      flags,
    })
  }

  // --- Agreement with the JEV-off baseline pass -------------------------------
  let baseline: BenchSummary['baseline'] = null
  if (results.baseline.length > 0 && live.length > 0) {
    const base = new Map(results.baseline.map(r => [r.scenarioId, r.decision]))
    let n = 0
    let roleSame = 0
    let modelSame = 0
    let familySame = 0
    for (const run of live) {
      const b = base.get(run.scenarioId)
      if (!b) continue
      n += 1
      if (run.decision.role === b.role) roleSame += 1
      if (run.decision.model === b.model) modelSame += 1
      if (run.decision.family === b.family) familySame += 1
    }
    baseline = { role: rate(roleSame, n), model: rate(modelSame, n), family: rate(familySame, n) }
  }

  const counts = Object.values(results.candidates)
    .map(c => c.length)
    .sort((a, b) => a - b)

  return {
    mode: config.mode,
    scenarios: results.scenarios.length,
    runs: results.runs.length,
    aborted: results.aborted,
    thresholds,
    candidates:
      counts.length === 0
        ? null
        : { min: counts[0]!, median: percentile(counts, 0.5), max: counts[counts.length - 1]! },
    jev,
    role: {
      ...role.summary,
      finalAccuracy: rate(roleFinalHit, roleFinalN),
      confusion,
    },
    model: { ...model.summary, finalOk: rate(modelFinalHit, modelFinalN), outcomes },
    agentType: { ...type.summary, finalAccuracy: rate(typeFinalHit, typeFinalN) },
    complexity: {
      exact: rate(complexityHit, complexityN),
      meanAbsError: complexityN === 0 ? null : complexityErr / complexityN,
    },
    longContext: {
      accuracy: rate(longHit, longN),
      brier: longN === 0 ? null : longBrier / longN,
    },
    choices: { byRole, byComplexity, agentTypes },
    stability:
      shares.role.length === 0
        ? null
        : {
            scenarios: shares.role.length,
            roleShare: mean(shares.role),
            modelShare: mean(shares.model),
            agentTypeShare: mean(shares.type),
            unstable,
          },
    baseline,
    errors: results.runs.flatMap(r => (r.error ? [{ id: r.scenarioId, message: r.error }] : [])),
    rows,
  }
}
