import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEED_SCENARIOS } from '../src/services/jev/benchmarkFixtures.js'
import { allScenarios, SCENARIO_SET_NAMES, SCENARIO_SETS } from '../src/services/jev/scenarios/index.js'
import { main, parseArgs, selectScenarios, USAGE, type CliOptions } from './bench-jev.js'

function ok(argv: string[]): CliOptions {
  const parsed = parseArgs(argv)
  if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`)
  return parsed.options
}

function err(argv: string[]): string {
  const parsed = parseArgs(argv)
  if (!('error' in parsed)) throw new Error('expected a parse error')
  return parsed.error
}

describe('parseArgs', () => {
  test('defaults are a free offline baseline run', () => {
    const o = ok([])
    expect(o).toMatchObject({
      live: false, baseline: false, repeat: 1, maxCalls: 300, sets: [], cyber: false,
      noAnthropic: false, zdr: false, verbose: false, json: false, help: false, list: false, listSets: false,
    })
    // Left unset so `--cyber` can default it to "*" while a plain run keeps the matrix families.
    expect(o.allowlist).toBeUndefined()
    expect(o.profiles).toEqual(['deepseek', 'zai', 'codex'])
    expect(o.ids).toEqual([])
  })

  test('values work as "--flag value" and "--flag=value"', () => {
    expect(ok(['--repeat', '3']).repeat).toBe(3)
    expect(ok(['--repeat=4']).repeat).toBe(4)
    expect(ok(['--out=x.json']).out).toBe('x.json')
    expect(ok(['--min-p', '0.6', '--min-margin=0.1'])).toMatchObject({ minP: 0.6, minMargin: 0.1 })
    expect(ok(['--timeout-ms', '5000']).timeoutMs).toBe(5000)
  })

  test('--id and --tag repeat', () => {
    const o = ok(['--id', 'a', '--id', 'b', '--tag', 'review', '--tag=verify'])
    expect(o.ids).toEqual(['a', 'b'])
    expect(o.tags).toEqual(['review', 'verify'])
  })

  test('--allowlist and --profiles', () => {
    expect(ok(['--allowlist', '*']).allowlist).toBe('*')
    expect(ok(['--allowlist', 'opus-5.5, glm-5.3']).allowlist).toEqual(['opus-5.5', 'glm-5.3'])
    expect(ok(['--profiles', 'none']).profiles).toEqual([])
    expect(ok(['--profiles', 'zai,fireworks']).profiles).toEqual(['zai', 'fireworks'])
  })

  test('--set is a comma list, repeats, and accepts "all"', () => {
    expect(ok(['--set', 'vision,coding']).sets).toEqual(['vision', 'coding'])
    expect(ok(['--set=vision', '--set', 'all']).sets).toEqual(['vision', 'all'])
    expect(ok(['--set', ' vision , ']).sets).toEqual(['vision'])
  })

  test('--set rejects an unknown name and lists the known ones', () => {
    const message = err(['--set', 'vision,nope'])
    expect(message).toContain('unknown scenario set "nope"')
    for (const name of [...SCENARIO_SET_NAMES, 'all']) expect(message).toContain(name)
    expect(err(['--set', ','])).toContain('unknown scenario set')
  })

  test('--show-request and --list-sets', () => {
    expect(ok(['--show-request', 're-patch-diff']).showRequest).toBe('re-patch-diff')
    expect(err(['--show-request'])).toContain('--show-request needs a value')
    expect(ok(['--list-sets']).listSets).toBe(true)
  })

  test('--cyber cannot be combined with what needs JEV', () => {
    expect(ok(['--cyber']).cyber).toBe(true)
    expect(err(['--cyber', '--live'])).toContain('cannot be combined with --live')
    expect(err(['--cyber', '--show-request', 'x'])).toContain('cyber mode builds none')
  })

  test('--scenarios and --set are alternatives', () => {
    expect(err(['--scenarios', 'a.json', '--set', 'vision'])).toContain('either --scenarios or --set')
  })

  test('live-only flags need --live', () => {
    expect(ok(['--live', '--baseline', '--zdr'])).toMatchObject({ live: true, baseline: true, zdr: true })
    expect(err(['--baseline'])).toContain('--live')
    expect(err(['--zdr'])).toContain('--live')
    expect(err(['--report', 'r.json', '--live'])).toContain('cannot be combined')
  })

  test('rejects bad input with a message naming the flag', () => {
    expect(err(['--nope'])).toContain('unknown option "--nope"')
    expect(err(['--repeat'])).toContain('--repeat needs a value')
    expect(err(['--out', '--json'])).toContain('--out needs a value')
    expect(err(['--repeat', '0'])).toContain('positive integer')
    expect(err(['--repeat', '2.5'])).toContain('positive integer')
    expect(err(['--max-calls', 'x'])).toContain('positive integer')
    expect(err(['--min-p', '1.5'])).toContain('0 to 1')
    expect(err(['--min-margin', ''])).toContain('0 to 1')
    expect(err(['--profiles', 'deepseek,bogus'])).toContain('unknown profile "bogus"')
    expect(err(['--live=1'])).toContain('does not take a value')
    expect(err(['--allowlist', ' , '])).toContain('--allowlist')
  })
})

describe('selectScenarios', () => {
  test('filters by id and by tag, and both together', () => {
    expect(selectScenarios(SEED_SCENARIOS, ['impl-trivial-typo'], []).map(s => s.id)).toEqual(['impl-trivial-typo'])
    const reviews = selectScenarios(SEED_SCENARIOS, [], ['review'])
    expect(reviews.length).toBeGreaterThan(3)
    expect(reviews.every(s => s.tags?.includes('review'))).toBe(true)
    expect(selectScenarios(SEED_SCENARIOS, ['review-auth-diff', 'impl-trivial-typo'], ['review']).map(s => s.id)).toEqual(['review-auth-diff'])
  })

  test('an unknown id or an empty match is an error', () => {
    expect(() => selectScenarios(SEED_SCENARIOS, ['nope'], [])).toThrow('no scenario with id "nope"')
    expect(() => selectScenarios(SEED_SCENARIOS, [], ['no-such-tag'])).toThrow('no scenarios match')
  })
})

describe('main', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-jev-test-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const savedKey = process.env.AI_GATEWAY_API_KEY
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = savedKey
  })

  const run = async (argv: string[]) => {
    const out: string[] = []
    const errs: string[] = []
    const code = await main(argv, { out: l => out.push(l), err: l => errs.push(l) })
    return { code, out: out.join('\n'), err: errs.join('\n') }
  }

  test('--help prints the usage', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Usage: bun run bench:jev')
    expect(r.out).toBe(USAGE)
  })

  test('a usage error exits 2 and says why', async () => {
    const r = await run(['--repeat', 'many'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('bench:jev: --repeat must be a positive integer')
  })

  test('--list shows the selected scenarios only', async () => {
    const r = await run(['--list', '--tag', 'computer_use'])
    expect(r.code).toBe(0)
    const lines = r.out.split('\n')
    expect(lines.length).toBe(SEED_SCENARIOS.filter(s => s.tags?.includes('computer_use')).length)
    expect(lines.every(l => l.startsWith('cu-'))).toBe(true)
  })

  test('--list-sets shows every set with its size, and the total', async () => {
    const r = await run(['--list-sets'])
    expect(r.code).toBe(0)
    const rows = r.out.split('\n').map(l => l.trim().split(/\s+/))
    expect(rows.map(row => row[0])).toEqual([...SCENARIO_SET_NAMES, 'all'])
    for (const name of SCENARIO_SET_NAMES) {
      expect(rows.find(row => row[0] === name)![1]).toBe(String(SCENARIO_SETS[name]!.length))
    }
    expect(rows.find(row => row[0] === 'all')![1]).toBe(String(allScenarios().length))
  })

  test('--set picks a built-in set and --list names the set of each scenario', async () => {
    const r = await run(['--list', '--set', 'vision'])
    expect(r.code).toBe(0)
    const lines = r.out.split('\n')
    expect(lines).toHaveLength(SCENARIO_SETS.vision!.length)
    expect(lines.every(l => l.startsWith('vis-') && l.split(/\s+/)[1] === 'vision')).toBe(true)
    const both = await run(['--list', '--set', 'vision,computer-use'])
    expect(both.out.split('\n')).toHaveLength(SCENARIO_SETS.vision!.length + SCENARIO_SETS['computer-use']!.length)
    const all = await run(['--list', '--set', 'all'])
    expect(all.out.split('\n')).toHaveLength(allScenarios().length)
  })

  test('--id without --set is looked up in every set', async () => {
    const r = await run(['--list', '--id', 're-patch-diff', '--id', 'impl-trivial-typo'])
    expect(r.code).toBe(0)
    expect(r.out.split('\n').map(l => l.split(/\s+/)[0])).toEqual(['impl-trivial-typo', 're-patch-diff'])
  })

  test('--id with a --set that leaves its set out says which set it is in', async () => {
    const r = await run(['--list', '--set', 'coding', '--id', 're-patch-diff'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('scenario "re-patch-diff" is in the "reverse-engineering" set, which --set did not select')
  })

  test('--show-request prints the request JEV would get, without a key or a call', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    const r = await run(['--show-request', 're-firmware-update-check'])
    expect(r.code).toBe(0)
    const request = JSON.parse(r.out)
    expect(Object.keys(request.questions).sort()).toEqual([
      'agent_type', 'complexity', 'model', 'needs_long_context', 'role',
    ])
    expect(request.state.prompt).toContain('firmware')
    // The domain agent types are offered to JEV.
    expect(Object.keys(request.questions.agent_type.criteria)).toContain('binary-analyst')
    const unknown = await run(['--show-request', 'nope'])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('no scenario with id "nope"')
  })

  test('--cyber runs the policy offline, says so, and has nothing to export', async () => {
    const resultsFile = join(dir, 'cyber.json')
    const trainFile = join(dir, 'cyber.jsonl')
    const r = await run(['--set', 'reverse-engineering', '--cyber', '--out', resultsFile, '--export', trainFile])
    expect(r.code).toBe(0)
    expect(r.out).toContain('cyber mode: JEV is never consulted')
    expect(r.out).toContain('Cyber-policy decisions vs gold')
    expect(r.err).toContain('wrote 0 training example(s)')
    expect(r.err).toContain('cyber mode builds no JEV request')
    const saved = JSON.parse(readFileSync(resultsFile, 'utf8'))
    expect(saved.config.cyber).toBe(true)
    expect(saved.config.allowlist).toEqual(['*'])
    expect(saved.runs).toHaveLength(SCENARIO_SETS['reverse-engineering']!.length)
    expect(saved.runs.every((run: { requestKey?: string }) => run.requestKey === undefined)).toBe(true)
    // Re-analysing the saved file reports it as a cyber run too.
    const again = await run(['--report', resultsFile])
    expect(again.out).toContain('cyber mode: JEV is never consulted')
  })

  test('--cyber honours an explicit --allowlist', async () => {
    const r = await run(['--set', 'reverse-engineering', '--cyber', '--allowlist', 'opus-5.5', '--json'])
    expect(r.code).toBe(0)
    // No policy model is on the list: every run raises and is reported, none crashes the tool.
    const summary = JSON.parse(r.out)
    expect(summary.errors).toHaveLength(SCENARIO_SETS['reverse-engineering']!.length)
  })

  test('a baseline run reports, writes results and training data, and --report re-reads them', async () => {
    const resultsFile = join(dir, 'results.json')
    const trainFile = join(dir, 'train.jsonl')
    const r = await run(['--id', 'review-auth-diff', '--id', 'impl-trivial-typo', '--out', resultsFile, '--export', trainFile])
    expect(r.code).toBe(0)
    expect(r.out).toContain('JEV decision benchmark — baseline · 2 scenarios · 2 runs')
    expect(r.out).toContain('JEV was not called')
    expect(r.err).toContain(`wrote results to ${resultsFile}`)
    expect(r.err).toContain('wrote 2 training example(s)')

    const saved = JSON.parse(readFileSync(resultsFile, 'utf8'))
    expect(saved.schema).toBe('openclaude.jev-bench/1')
    expect(saved.runs).toHaveLength(2)
    const lines = readFileSync(trainFile, 'utf8').trimEnd().split('\n')
    expect(lines.map(l => JSON.parse(l).id).sort()).toEqual(['impl-trivial-typo', 'review-auth-diff'])

    // Re-analysis makes no run and does not rewrite the results file.
    const before = readFileSync(resultsFile, 'utf8')
    const again = await run(['--report', resultsFile, '--out', resultsFile])
    expect(again.code).toBe(0)
    expect(again.out).toContain('baseline · 2 scenarios · 2 runs')
    expect(readFileSync(resultsFile, 'utf8')).toBe(before)
  })

  test('--json prints the summary as JSON', async () => {
    const r = await run(['--id', 'impl-trivial-typo', '--json'])
    expect(r.code).toBe(0)
    const summary = JSON.parse(r.out)
    expect(summary.mode).toBe('baseline')
    expect(summary.scenarios).toBe(1)
    expect(summary.jev).toBeNull()
  })

  test('a custom scenario file replaces the seed set', async () => {
    const file = join(dir, 'custom.json')
    writeFileSync(file, JSON.stringify({ scenarios: [{ id: 'mine', description: 'Review my diff', prompt: 'Critique it.' }] }))
    const r = await run(['--scenarios', file])
    expect(r.code).toBe(0)
    expect(r.out).toContain('1 scenarios')
  })

  test('an invalid scenario file or unknown id exits 1 with the reason', async () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify([{ id: 'x' }]))
    const bad = await run(['--scenarios', file])
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('description is required')
    const unknown = await run(['--id', 'nope'])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('no scenario with id "nope"')
  })

  test('--report refuses a file that is not a results file', async () => {
    const file = join(dir, 'not-results.json')
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    const r = await run(['--report', file])
    expect(r.code).toBe(2)
    expect(r.err).toContain('not a JEV benchmark results file')
  })

  test('--live without a key exits 2 before doing anything', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    const r = await run(['--live'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('AI_GATEWAY_API_KEY')
    expect(existsSync(join(dir, 'never-written.json'))).toBe(false)
  })

  test('--live refuses a run over --max-calls before any call is made', async () => {
    process.env.AI_GATEWAY_API_KEY = 'test-key-not-real'
    const r = await run(['--live', '--repeat', '3', '--max-calls', '10'])
    expect(r.code).toBe(2)
    expect(r.err).toContain(`needs ${SEED_SCENARIOS.length * 3} JEV calls`)
    expect(r.err).toContain('--max-calls is 10')
    // No LIVE banner: the refusal came first.
    expect(r.err).not.toContain('LIVE')
  })

  test('--live over every set counts the calls of every set', async () => {
    process.env.AI_GATEWAY_API_KEY = 'test-key-not-real'
    const r = await run(['--live', '--set', 'all', '--repeat', '3'])
    expect(r.code).toBe(2)
    expect(r.err).toContain(`needs ${allScenarios().length * 3} JEV calls`)
  })
})
