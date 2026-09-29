import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getCyberMode, setCyberModeEnabled } from '../../bootstrap/state.js'
import { CYBER_MODELS } from '../../utils/model/cyber.js'
import { separationFamilyOf } from '../api/smartRouting/teammate.js'
import { createFakeJev } from '../../test/fakeJev.js'
import { buildTrainingExamples, runBenchmark, type BenchScenario } from './benchmark.js'
import { modelGoldOf, summarize } from './benchmarkAnalysis.js'
import { buildBenchEnvironment } from './benchmarkFixtures.js'
import { formatReport } from './benchmarkReport.js'
import { CYBER_EASY, CYBER_LEAD, CYBER_WORKER } from './scenarios/cyberGold.js'

const REVIEW: BenchScenario = {
  id: 'review',
  description: 'Review the parser diff',
  prompt: 'Critique this diff for correctness and security.',
  gold: { role: 'review', model: { anyOf: ['no-such-model'] }, cyberModel: CYBER_LEAD },
}
const TYPO: BenchScenario = {
  id: 'typo',
  description: 'Fix a typo in the README',
  prompt: 'Quick fix: correct the typo in README.md.',
  gold: { role: 'implement', complexity: 'trivial', model: { anyOf: ['no-such-model'] }, cyberModel: CYBER_EASY },
}
const KEYWORD_HARD: BenchScenario = {
  id: 'keyword-hard',
  description: 'Fix a race condition in the queue',
  prompt: 'This is a subtle race condition between the producer and the consumer. Find it and fix it.',
  gold: { role: 'implement', complexity: 'hard', model: { anyOf: ['no-such-model'] }, cyberModel: CYBER_WORKER },
}
// Just as hard, but none of the words the keyword heuristic looks for.
const PLAIN_HARD: BenchScenario = {
  id: 'plain-hard',
  description: 'Rewrite the scheduler so tasks never run twice',
  prompt: 'Rewrite the scheduler so a task is never run twice, even after a crash between the claim and the ack.',
  gold: { role: 'implement', complexity: 'hard', model: { anyOf: ['no-such-model'] }, cyberModel: CYBER_WORKER },
}
const VERIFY_AFTER_GLM: BenchScenario = {
  id: 'verify-after-glm',
  description: 'Verify the patch',
  prompt: 'Verify that the patch closes the hole.',
  implementers: [CYBER_MODELS.lead],
  gold: { role: 'verify', cyberModel: { anyOf: [CYBER_MODELS.worker, CYBER_MODELS.easy] } },
}

const cyberEnv = () => buildBenchEnvironment({ cyber: true })

describe('runBenchmark in cyber mode', () => {
  const before = getCyberMode().enabled
  beforeEach(() => setCyberModeEnabled(false))
  afterEach(() => setCyberModeEnabled(before))

  test('routes onto the policy models, never asks JEV, and records no request', async () => {
    const results = await runBenchmark([REVIEW, TYPO, KEYWORD_HARD, PLAIN_HARD], {
      mode: 'baseline',
      environment: cyberEnv(),
    })
    const model = (id: string) => results.runs.find(r => r.scenarioId === id)!.decision.model
    expect(model('review')).toBe(CYBER_MODELS.lead)
    expect(model('typo')).toBe(CYBER_MODELS.easy)
    expect(model('keyword-hard')).toBe(CYBER_MODELS.worker)
    // The policy reads difficulty from keywords, so a hard task worded plainly
    // goes to the cheap model. That miss is what the benchmark exists to show.
    expect(model('plain-hard')).toBe(CYBER_MODELS.easy)

    expect(results.runs.every(r => r.error === undefined && r.jev === undefined && r.requestKey === undefined)).toBe(true)
    expect(results.requests).toEqual({})
    expect(results.config.cyber).toBe(true)
    expect(results.config.cyberModels).toEqual({
      lead: CYBER_MODELS.lead,
      easy: CYBER_MODELS.easy,
      worker: CYBER_MODELS.worker,
    })
    // The policy's models are outside the default matrix, so cyber widens the allowlist.
    expect(results.config.allowlist).toEqual(['*'])
    expect(buildTrainingExamples(results)).toEqual([])
  })

  test('a verifier still does not share the implementer family', async () => {
    const results = await runBenchmark([VERIFY_AFTER_GLM], { mode: 'baseline', environment: cyberEnv() })
    const model = results.runs[0]!.decision.model
    expect(model).toBeDefined()
    expect(model).not.toBe(CYBER_MODELS.lead)
    expect(separationFamilyOf(model)).not.toBe(separationFamilyOf(CYBER_MODELS.lead))
    expect(model).toBe(CYBER_MODELS.worker)
  })

  test('cyber mode is on only for the run, whatever state it was in', async () => {
    let during: boolean | undefined
    const probe: BenchScenario = { ...REVIEW, id: 'probe' }
    setCyberModeEnabled(false)
    await runBenchmark([probe], { mode: 'baseline', environment: cyberEnv(), onRun: () => { during = getCyberMode().enabled } })
    expect(during).toBe(true)
    expect(getCyberMode().enabled).toBe(false)

    // A normal run made while cyber mode happens to be on is not a cyber run.
    setCyberModeEnabled(true)
    const normal = await runBenchmark([probe], { mode: 'baseline', environment: buildBenchEnvironment(), onRun: () => { during = getCyberMode().enabled } })
    expect(during).toBe(false)
    expect(normal.config.cyber).toBe(false)
    expect(normal.config.cyberModels).toBeUndefined()
    expect(Object.keys(normal.requests)).toHaveLength(1)
    expect(getCyberMode().enabled).toBe(true)
  })

  test('a live cyber run is refused: it would measure nothing', async () => {
    await expect(
      runBenchmark([REVIEW], {
        mode: 'live',
        environment: cyberEnv(),
        evaluate: createFakeJev({ scenarios: [REVIEW], seed: 1 }),
      }),
    ).rejects.toThrow('never consults JEV')
    expect(getCyberMode().enabled).toBe(false)
  })

  test('no available policy model is a recorded error, not a crash', async () => {
    const results = await runBenchmark([REVIEW, TYPO], {
      mode: 'baseline',
      environment: buildBenchEnvironment({ cyber: true, allowlist: ['opus-5.5'] }),
    })
    expect(results.runs).toHaveLength(2)
    for (const run of results.runs) {
      expect(run.error).toContain('Cyber mode: no available model')
      expect(run.decision.warning).toContain('Cyber mode')
    }
    const summary = summarize(results)
    expect(summary.errors.map(e => e.id)).toEqual(['review', 'typo'])
    const text = formatReport(summary, results)
    expect(text).toContain('Runs that raised instead of deciding (2)')
    expect(text).toContain('Cyber mode: no available model')
  })
})

describe('cyber results are judged against the cyber label', () => {
  const before = getCyberMode().enabled
  beforeEach(() => setCyberModeEnabled(false))
  afterEach(() => setCyberModeEnabled(before))

  test('modelGoldOf picks the label for the mode the run was made in', () => {
    expect(modelGoldOf(REVIEW, { cyber: true })).toEqual(CYBER_LEAD)
    expect(modelGoldOf(REVIEW, { cyber: false })).toEqual({ anyOf: ['no-such-model'] })
    expect(modelGoldOf({ id: 'x', description: 'd', prompt: 'p' }, { cyber: true })).toBeUndefined()
    // Only a JEV label: a cyber run has nothing to judge, rather than borrowing it.
    const jevOnly: BenchScenario = { ...REVIEW, gold: { role: 'review', model: { tier: 'deep' } } }
    expect(modelGoldOf(jevOnly, { cyber: true })).toBeUndefined()
  })

  test('the summary scores a cyber run by policy fit, not by the JEV model label', async () => {
    const scenarios = [REVIEW, TYPO, KEYWORD_HARD, PLAIN_HARD]
    const cyber = await runBenchmark(scenarios, { mode: 'baseline', environment: cyberEnv() })
    const normal = await runBenchmark(scenarios, { mode: 'baseline', environment: buildBenchEnvironment() })

    const s = summarize(cyber)
    // review, typo and the keyworded hard task land where the policy says; the plain hard one does not.
    expect(s.model.finalOk).toMatchObject({ n: 3, d: 4 })
    expect(s.rows.filter(r => r.model.ok === false).map(r => r.id)).toEqual(['plain-hard'])
    expect(s.errors).toEqual([])
    // The same scenarios under the JEV label ('no-such-model') are all misses.
    expect(summarize(normal).model.finalOk).toMatchObject({ n: 0, d: 4 })
  })

  test('the report says it is a cyber run and names the policy models', async () => {
    const results = await runBenchmark([REVIEW, TYPO], { mode: 'baseline', environment: cyberEnv() })
    const text = formatReport(summarize(results), results)
    expect(text).toContain('cyber mode: JEV is never consulted')
    expect(text).toContain(`${CYBER_MODELS.lead} review/verify`)
    expect(text).toContain(`${CYBER_MODELS.easy} easy`)
    expect(text).toContain(`${CYBER_MODELS.worker} hard`)
    expect(text).toContain('Cyber-policy decisions vs gold')
    expect(text).not.toContain('JEV was not called')
    expect(text).not.toContain('Runs that raised')
  })

  test('a results file from before the policy models were recorded still reports', async () => {
    const results = await runBenchmark([REVIEW], { mode: 'baseline', environment: cyberEnv() })
    const { cyberModels: _dropped, ...config } = results.config
    const text = formatReport(summarize({ ...results, config }), { ...results, config })
    expect(text).toContain('cyber mode: JEV is never consulted')
    expect(text).not.toMatch(/undefined|NaN/)
  })
})
