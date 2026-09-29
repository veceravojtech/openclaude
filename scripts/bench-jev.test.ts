import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEED_SCENARIOS } from '../src/services/jev/benchmarkFixtures.js'
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
      live: false, baseline: false, repeat: 1, maxCalls: 300, allowlist: 'default',
      noAnthropic: false, zdr: false, verbose: false, json: false, help: false, list: false,
    })
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
})
