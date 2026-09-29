/**
 * `bun run bench:jev` — measure which model, role and agent type the teammate
 * dispatcher (and JEV inside it) picks for which task.
 *
 * It replays task scenarios through the real `chooseTeammateRoute` in a
 * synthetic environment (no dependence on this machine's saved profiles or
 * auth), records what JEV answered and what the dispatcher finally decided,
 * and reports accuracy against gold labels, calibration, the Rule A threshold
 * trade-off, stability across repeats, latency and cost. The same run can be
 * exported as request -> gold training examples.
 *
 * Default is a free, offline BASELINE run (JEV is not called): the keyword
 * heuristic and tier table decide, and the exact JEV requests are captured.
 * `--live` calls the real JEV endpoint — see the warning it prints.
 *
 * Deliberately NOT part of `check`, CI or the pre-push contract: a live run
 * needs a key and costs money.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  buildTrainingExamples,
  isBenchResults,
  parseScenarioFile,
  runBenchmark,
  trainingExamplesToJsonl,
  type BenchResults,
  type BenchScenario,
} from '../src/services/jev/benchmark.js'
import { summarize } from '../src/services/jev/benchmarkAnalysis.js'
import {
  BENCH_PROFILE_NAMES,
  buildBenchEnvironment,
  DEFAULT_BENCH_PROFILES,
  SEED_SCENARIOS,
  type BenchProfileName,
} from '../src/services/jev/benchmarkFixtures.js'
import { formatReport } from '../src/services/jev/benchmarkReport.js'
import * as jevClient from '../src/services/jev/client.js'

export const USAGE = `Usage: bun run bench:jev [options]

Modes
  (default)             baseline: JEV is NOT called. Heuristic role + tier-table model.
                        Free and offline; also captures the exact JEV requests.
  --live                call the real JEV (needs AI_GATEWAY_API_KEY). Sends the scenario
                        text to ${jevClient.JEV_ENDPOINT} and costs money.
                        Use synthetic prompts only.
  --baseline            with --live: also run one JEV-off pass and report agreement

Scenarios
  --scenarios <file>    JSON: an array of scenarios, or { "scenarios": [...] }
                        (default: the built-in seed set; see --list)
  --id <id>             only this scenario (repeatable)
  --tag <tag>           only scenarios with this tag (repeatable)
  --list                list the selected scenarios and exit
  --repeat <n>          runs per scenario (default 1; use 3+ live to measure stability)
  --max-calls <n>       refuse a live run needing more JEV calls than this (default 300)

Environment (synthetic; nothing is read from your config)
  --allowlist <v>       default (matrix families only) | * (every catalog model) | a,b,c
  --profiles <list>     comma list of ${BENCH_PROFILE_NAMES.join(', ')} or none
                        (default ${DEFAULT_BENCH_PROFILES.join(',')}; fireworks adds ~280 models)
  --leader-route <r>    leader route (default anthropic)
  --no-anthropic        simulate an unauthenticated Anthropic route
  --min-p <x>           Rule A minimum probability (default ${jevClient.RULE_A_MIN_P})
  --min-margin <x>      Rule A margin over the runner-up (default ${jevClient.RULE_A_MIN_MARGIN})
  --timeout-ms <n>      JEV timeout per call (default 3000)
  --zdr                 ask the gateway for zero data retention (Hobby plans reject it: 403)

Output
  --out <file.json>     write the full results (requests, raw answers, decisions)
  --export <file.jsonl> write training examples for scenarios that have gold labels
  --report <file.json>  re-analyse a saved results file; makes no calls
  --verbose             add a per-scenario table
  --json                print the summary as JSON instead of text
  --help
`

export type CliOptions = {
  live: boolean
  baseline: boolean
  scenariosFile?: string
  ids: string[]
  tags: string[]
  list: boolean
  repeat: number
  maxCalls: number
  allowlist: 'default' | '*' | string[]
  profiles: BenchProfileName[]
  leaderRoute?: string
  noAnthropic: boolean
  minP?: number
  minMargin?: number
  timeoutMs?: number
  zdr: boolean
  out?: string
  exportFile?: string
  reportFile?: string
  verbose: boolean
  json: boolean
  help: boolean
}

export type ParseResult = { options: CliOptions } | { error: string }

const VALUE_FLAGS = new Set([
  '--scenarios', '--id', '--tag', '--repeat', '--max-calls', '--allowlist', '--profiles',
  '--leader-route', '--min-p', '--min-margin', '--timeout-ms', '--out', '--export', '--report',
])
const BOOLEAN_FLAGS = new Set([
  '--live', '--baseline', '--list', '--no-anthropic', '--zdr', '--verbose', '--json', '--help',
])

function toInt(flag: string, raw: string): number | string {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : `${flag} must be a positive integer (got "${raw}")`
}

function toProbability(flag: string, raw: string): number | string {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 1
    ? n
    : `${flag} must be a number from 0 to 1 (got "${raw}")`
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const options: CliOptions = {
    live: false,
    baseline: false,
    ids: [],
    tags: [],
    list: false,
    repeat: 1,
    maxCalls: 300,
    allowlist: 'default',
    profiles: [...DEFAULT_BENCH_PROFILES],
    noAnthropic: false,
    zdr: false,
    verbose: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    if (BOOLEAN_FLAGS.has(flag)) {
      if (eq > 0) return { error: `${flag} does not take a value` }
      if (flag === '--live') options.live = true
      else if (flag === '--baseline') options.baseline = true
      else if (flag === '--list') options.list = true
      else if (flag === '--no-anthropic') options.noAnthropic = true
      else if (flag === '--zdr') options.zdr = true
      else if (flag === '--verbose') options.verbose = true
      else if (flag === '--json') options.json = true
      else options.help = true
      continue
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `unknown option "${arg}" (see --help)` }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
    if (value === undefined || (eq < 0 && value.startsWith('--'))) {
      return { error: `${flag} needs a value` }
    }
    switch (flag) {
      case '--scenarios': options.scenariosFile = value; break
      case '--id': options.ids.push(value); break
      case '--tag': options.tags.push(value); break
      case '--out': options.out = value; break
      case '--export': options.exportFile = value; break
      case '--report': options.reportFile = value; break
      case '--leader-route': options.leaderRoute = value; break
      case '--repeat':
      case '--max-calls':
      case '--timeout-ms': {
        const n = toInt(flag, value)
        if (typeof n === 'string') return { error: n }
        if (flag === '--repeat') options.repeat = n
        else if (flag === '--max-calls') options.maxCalls = n
        else options.timeoutMs = n
        break
      }
      case '--min-p':
      case '--min-margin': {
        const n = toProbability(flag, value)
        if (typeof n === 'string') return { error: n }
        if (flag === '--min-p') options.minP = n
        else options.minMargin = n
        break
      }
      case '--allowlist': {
        options.allowlist =
          value === 'default' || value === '*'
            ? value
            : value.split(',').map(v => v.trim()).filter(Boolean)
        if (Array.isArray(options.allowlist) && options.allowlist.length === 0) {
          return { error: '--allowlist needs "default", "*" or a comma list' }
        }
        break
      }
      case '--profiles': {
        const names = value === 'none' ? [] : value.split(',').map(v => v.trim()).filter(Boolean)
        const bad = names.find(n => !(BENCH_PROFILE_NAMES as readonly string[]).includes(n))
        if (bad) return { error: `unknown profile "${bad}" (known: ${BENCH_PROFILE_NAMES.join(', ')}, none)` }
        options.profiles = names as BenchProfileName[]
        break
      }
    }
  }
  if (options.baseline && !options.live) return { error: '--baseline only applies together with --live' }
  if (options.zdr && !options.live) return { error: '--zdr only applies together with --live' }
  if (options.reportFile && options.live) return { error: '--report re-analyses a saved file and cannot be combined with --live' }
  return { options }
}

export function selectScenarios(
  all: readonly BenchScenario[],
  ids: readonly string[],
  tags: readonly string[],
): BenchScenario[] {
  const known = new Set(all.map(s => s.id))
  const unknown = ids.find(id => !known.has(id))
  if (unknown) throw new Error(`no scenario with id "${unknown}" (see --list)`)
  const selected = all.filter(
    s =>
      (ids.length === 0 || ids.includes(s.id)) &&
      (tags.length === 0 || tags.some(t => s.tags?.includes(t))),
  )
  if (selected.length === 0) throw new Error('no scenarios match the given --id / --tag')
  return [...selected]
}

export type Io = { out: (line: string) => void; err: (line: string) => void }

function listScenarios(scenarios: readonly BenchScenario[]): string {
  const rows = scenarios.map(s => {
    const role = [s.gold?.role].flat().filter(Boolean).join('|') || '-'
    const extra = [
      s.implementers?.length ? `implementers=${s.implementers.join(',')}` : '',
      s.subagentType ? `type=${s.subagentType}` : '',
      s.spawnPath === 'subagent' ? 'subagent' : '',
    ].filter(Boolean).join(' ')
    return [s.id, role, s.gold ? 'gold' : 'no-gold', (s.tags ?? []).join(','), extra]
  })
  const widths = [0, 1, 2, 3].map(c => Math.max(...rows.map(r => r[c]!.length)))
  return rows
    .map(r => r.map((cell, c) => (c < 4 ? cell.padEnd(widths[c]!) : cell)).join('  ').trimEnd())
    .join('\n')
}

export async function main(
  argv: readonly string[],
  io: Io = { out: line => console.log(line), err: line => console.error(line) },
): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    io.err(`bench:jev: ${parsed.error}`)
    return 2
  }
  const { options } = parsed
  if (options.help) {
    io.out(USAGE)
    return 0
  }

  const finish = (results: BenchResults): number => {
    const summary = summarize(results)
    io.out(options.json ? JSON.stringify(summary, null, 2) : formatReport(summary, results, { verbose: options.verbose }).trimEnd())
    if (options.out && !options.reportFile) {
      writeFileSync(options.out, JSON.stringify(results, null, 2) + '\n')
      io.err(`wrote results to ${options.out}`)
    }
    if (options.exportFile) {
      const examples = buildTrainingExamples(results)
      writeFileSync(options.exportFile, trainingExamplesToJsonl(examples))
      io.err(`wrote ${examples.length} training example(s) to ${options.exportFile}`)
    }
    return 0
  }

  try {
    if (options.reportFile) {
      const json: unknown = JSON.parse(readFileSync(options.reportFile, 'utf8'))
      if (!isBenchResults(json)) {
        io.err(`bench:jev: ${options.reportFile} is not a JEV benchmark results file`)
        return 2
      }
      return finish(json)
    }

    const all = options.scenariosFile
      ? parseScenarioFile(JSON.parse(readFileSync(options.scenariosFile, 'utf8')))
      : [...SEED_SCENARIOS]
    const scenarios = selectScenarios(all, options.ids, options.tags)
    if (options.list) {
      io.out(listScenarios(scenarios))
      return 0
    }

    const calls = scenarios.length * options.repeat
    if (options.live) {
      if (!jevClient.isJevConfigured()) {
        io.err('bench:jev: --live needs AI_GATEWAY_API_KEY (a Vercel AI Gateway key) in the environment')
        return 2
      }
      // The --baseline pass never calls JEV, so it adds no calls.
      if (calls > options.maxCalls) {
        io.err(`bench:jev: this run needs ${calls} JEV calls; --max-calls is ${options.maxCalls}. Raise it or narrow the scenarios.`)
        return 2
      }
      io.err(
        `bench:jev: LIVE — ${calls} JEV call(s) to ${jevClient.JEV_ENDPOINT} (${jevClient.JEV_MODEL}). ` +
          'The scenario text leaves this machine and each call costs money; Ctrl-C stops and keeps partial results.',
      )
    }

    const environment = buildBenchEnvironment({
      allowlist: options.allowlist,
      leaderRoute: options.leaderRoute,
      anthropicAuth: !options.noAnthropic,
      profiles: options.profiles,
      minP: options.minP,
      minMargin: options.minMargin,
      timeoutMs: options.timeoutMs,
    })

    const controller = new AbortController()
    const onSigint = () => {
      io.err('\nbench:jev: interrupted; finishing the current call and reporting what was collected')
      controller.abort()
    }
    process.once('SIGINT', onSigint)
    const showProgress = options.live || options.verbose
    try {
      const results = await runBenchmark(scenarios, {
        mode: options.live ? 'live' : 'baseline',
        environment,
        repeat: options.repeat,
        withBaseline: options.baseline,
        zeroDataRetention: options.zdr,
        signal: controller.signal,
        onRun: ({ run, done, total }) => {
          if (!showProgress) return
          const d = run.decision
          const jev = run.jev ? (run.jev.ok ? `jev ${Math.round(run.jev.latencyMs)}ms` : `jev ${run.jev.reason}`) : 'no jev'
          io.err(`[${done}/${total}] ${run.scenarioId}${run.repeat > 0 ? ` #${run.repeat}` : ' (baseline)'} -> ${d.role} / ${d.model ?? '(default)'} (${jev})`)
        },
      })
      return finish(results)
    } finally {
      process.off('SIGINT', onSigint)
    }
  } catch (error) {
    io.err(`bench:jev: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
