/**
 * `bun run test:full` - the fail-closed driver for the repository's unit sweep.
 *
 * WHY THIS EXISTS
 * `test:full` used to be a bare shell chain:
 *   `bun test --feature=UNATTENDED_RETRY --max-concurrency=1 && bun run test:conversation-arc`
 * The first half was observed printing 64 `(fail)` lines and then STOPPING without its
 * `N pass / N fail / Ran N tests across M files` block - yet exiting 0. `&&` therefore
 * proceeded, `bun run check` went green, and CI (`.github/workflows/pr-checks.yml` ->
 * `bun run check` -> `test:full`) could never go red on unit-test breakage. A child's
 * exit status is not, on its own, evidence that the suite actually ran.
 *
 * WHAT THIS DOES
 * Every step is spawned with its stdout and stderr streamed through live - a ~30-minute
 * suite has to stay observable - while the same bytes are accumulated for parsing. When
 * the child exits, the captured text must PROVE the run completed:
 *   A1 SUMMARY     a `Ran <N> tests across <M> file(s)` line was emitted.
 *   A2 NO FAILURES the reported `fail` count is 0.
 *   A3 RECONCILED  pass + fail + skip + todo equals the `Ran` line's test count.
 *   A4 NON-EMPTY   at least one test actually ran.
 *   A5 CLEAN EXIT  the child exited 0 and did not die on a signal.
 *   A6 MIN PASSING a step that declares `minPassing` reported at least that many passes.
 * Anything unrecognised is a FAILURE, never a pass: a parser that cannot find a summary
 * must not report success. Each failed assertion is named in the diagnostic.
 *
 * Both halves of `test:full` go through the same guard, so the conversation-arc step
 * cannot silently no-op either.
 *
 * Usage: `bun run scripts/run-test-full.ts` (no arguments). Exit 0 only when every step
 * passed every assertion; otherwise the child's non-zero code, or 1 when the child lied
 * with 0.
 */
import { type SpawnOptions, spawn } from 'node:child_process'

/** One phase of `test:full`: a command, plus optional extra environment. */
export type StepSpec = {
  /** Human label used in diagnostics. */
  readonly name: string
  /** argv[0] plus arguments. Never routed through a shell. */
  readonly command: readonly [string, ...string[]]
  /** Extra environment layered over `process.env` for this step only. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Minimum number of PASSING tests this step must report. A step that exists to execute
   * particular tests proves nothing by skipping them: bun reports
   * ` 0 pass / 1 skip / 0 fail` above `Ran 1 test across 1 file.` for a `test.skip`, and
   * that shape satisfies A1-A5. Declare this wherever "it ran" is not "it verified".
   */
  readonly minPassing?: number
}

/**
 * Phase 1 - the unit sweep. This is verbatim the command the old `test:full` ran first;
 * it is the one whose silent exit-0 this script exists to catch.
 */
export const SWEEP_STEP: StepSpec = {
  name: 'unit sweep',
  command: ['bun', 'test', '--feature=UNATTENDED_RETRY', '--max-concurrency=1'],
}

/**
 * Phase 2 - the conversation-arc pass, still resolved through `bun run` so
 * `package.json`'s `test:conversation-arc` stays the single definition of that command.
 *
 * The A1 transpiler-cache fix - `src/query.ts` is over bun's 50 KiB cache threshold and
 * its cache key ignores the `--feature` set, so phase 1 leaves an arc-OFF artifact that
 * the arc half is then served - lives in `package.json:60` as a
 * `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` prefix. It is deliberately NOT duplicated as an
 * `env` field here: because this step re-enters the script, the one prefix fixes both
 * this route and a human's `bun run test:conversation-arc`, and a second copy would
 * silently mask a regression of that line.
 *
 * `minPassing` is set because this step exists to run exactly one test, and
 * `src/query.conversationArc.test.ts` degrades that test to `test.skip` when the
 * `--feature` flags do not reach it - a shape A1-A5 alone would accept as a pass.
 */
export const CONVERSATION_ARC_STEP: StepSpec = {
  name: 'conversation-arc',
  command: ['bun', 'run', 'test:conversation-arc'],
  minPassing: 1,
}

/** The steps `test:full` runs, in order. A step only starts if the previous one passed. */
export const TEST_FULL_STEPS: readonly StepSpec[] = [SWEEP_STEP, CONVERSATION_ARC_STEP]

/** The four labels bun counts toward the `Ran <N> tests` total. */
export const TEST_COUNT_LABELS = ['pass', 'fail', 'skip', 'todo'] as const

/** One of bun's test-count categories. */
export type TestCountLabel = (typeof TEST_COUNT_LABELS)[number]

/** Test counts from bun's summary block. Absent lines read as 0 - see `reportedLabels`. */
export type BunTestCounts = Record<TestCountLabel, number>

/** A parsed bun summary block. */
export type BunTestSummary = {
  /** The `Ran ...` line itself, ANSI-stripped, for quoting back in diagnostics. */
  readonly line: string
  /** `<N>` from `Ran <N> tests`. */
  readonly tests: number
  /** `<M>` from `across <M> files`. */
  readonly files: number
  /** pass/fail/skip/todo, defaulting to 0 for lines bun did not print. */
  readonly counts: BunTestCounts
  /** Which of the four count lines were actually present. */
  readonly reportedLabels: readonly TestCountLabel[]
  /** Other count lines in the block (`expect() calls`, `error`, `filtered out`, ...). */
  readonly otherLabels: readonly string[]
}

/**
 * CSI, OSC and two-character escape sequences. bun colourises its summary when it
 * believes it has a TTY; through a pipe it does not, but stripping is cheap insurance
 * and a coloured ` 5 fail` must never read as an unrecognised shape.
 */
const ANSI_PATTERN =
  /\u001B\[[0-9;:?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g

/** bun's run footer, e.g. `Ran 132 tests across 40 files. [12.34s]` (both nouns pluralise). */
const RAN_LINE_PATTERN = /^\s*Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\b/

/** One line of bun's count block, e.g. ` 4 skip`, ` 2 expect() calls`, ` 2 filtered out`. */
const COUNT_LINE_PATTERN = /^\s*(\d+)\s+(\S.*?)\s*$/

/** Remove ANSI escape sequences so a coloured summary parses exactly like a plain one. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Split captured output into lines. Carriage returns become line breaks: under a PTY bun
 * rewrites progress in place with bare `\r`, which would otherwise hide the summary
 * inside one enormous "line".
 */
export function toLines(text: string): string[] {
  return stripAnsi(text).replace(/\r\n?/g, '\n').split('\n')
}

/**
 * Parse the LAST bun summary block in `output`, or `undefined` when there is none.
 *
 * Scanning backwards means trailing output after the summary is harmless, and that an
 * earlier nested summary can never shadow the real one. The count block is the run of
 * `<n> <label>` lines immediately above the `Ran` line; the walk stops at the first line
 * that is not one (in practice bun's blank separator), so unrelated test output above the
 * block can never be absorbed into it.
 */
export function parseBunTestSummary(output: string): BunTestSummary | undefined {
  const lines = toLines(output)

  for (let i = lines.length - 1; i >= 0; i--) {
    const ran = RAN_LINE_PATTERN.exec(lines[i] ?? '')
    if (!ran) {
      continue
    }

    const counts: BunTestCounts = { pass: 0, fail: 0, skip: 0, todo: 0 }
    const reportedLabels: TestCountLabel[] = []
    const otherLabels: string[] = []

    for (let j = i - 1; j >= 0; j--) {
      const count = COUNT_LINE_PATTERN.exec(lines[j] ?? '')
      if (!count) {
        break
      }
      const value = Number.parseInt(count[1] ?? '', 10)
      const label = count[2] ?? ''
      const known = TEST_COUNT_LABELS.find(candidate => candidate === label)
      if (known !== undefined && !reportedLabels.includes(known)) {
        counts[known] = value
        reportedLabels.push(known)
      } else {
        otherLabels.push(`${value} ${label}`)
      }
    }

    return {
      line: (lines[i] ?? '').trim(),
      tests: Number.parseInt(ran[1] ?? '', 10),
      files: Number.parseInt(ran[2] ?? '', 10),
      counts,
      reportedLabels: reportedLabels.reverse(),
      otherLabels: otherLabels.reverse(),
    }
  }

  return undefined
}

/**
 * Provider env names whose PRESENCE marks a sweep shell as provider-configured.
 *
 * This session attributed ~30 sweep failures to the wrong commits because the user's
 * mid-session `/provider` switch had exported OPENAI_ and CLAUDE_CODE_USE_ vars into the
 * shell the sweep ran from (mechanism 3 of the false-attribution taxonomy:
 * VINTAGE-VS-SHELL-STATE). The fingerprint makes a future poisoned-shell sweep
 * self-identifying in its own log.
 *
 * NAMES ONLY, never values: OPENAI_API_KEY can be set in a sweep environment and must
 * never land in a log.
 */
export const PROVIDER_ENV_NAMES = [
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const

/** Which provider-env names are set in `env`, sorted. Names only - values are never read. */
export function providerEnvNames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const names = new Set<string>()
  for (const name of PROVIDER_ENV_NAMES) {
    if (env[name] !== undefined) {
      names.add(name)
    }
  }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE_CODE_USE_/.test(key)) {
      names.add(key)
    }
  }
  return [...names].sort()
}

/** The one-line fingerprint the driver prints before its first step. */
export function formatProviderEnvFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const names = providerEnvNames(env)
  return names.length > 0 ? `provider env present: ${names.join(', ')}` : 'provider env: none'
}

/** A bun file block header, e.g. `src/memdir/autoExtractFacts.test.ts:` on its own line. */
const FILE_HEADER_PATTERN = /^(\S+\.[cm]?[jt]sx?):\s*$/

/** A failing-test marker line; group 1 is the test name. */
const FAIL_MARKER_PATTERN = /^\(fail\)\s?(.*)$/

/** An `error:` detail line inside a file block. */
const ERROR_LINE_PATTERN = /^error:/

/** One file's slice of the output, with its failures and - only if it failed - its errors. */
export type FileAttribution = {
  /** File path as bun printed it (header minus the trailing colon). */
  readonly file: string
  /** How many `(fail)` markers this file's own block carried. */
  readonly failCount: number
  /** Names from this block's `(fail)` marker lines. */
  readonly failingTests: readonly string[]
  /**
   * `error:` lines from THIS block, attributed only when the block itself carries a
   * `(fail)` marker. A passing test that deliberately throws internally (an
   * EXPECTED-THROW-IN-GREEN block) contributes nothing, and no error line is ever read
   * across a file-header boundary (WINDOW-BLEED).
   */
  readonly errorLines: readonly string[]
  /** Whether this block carried any `(fail)` marker. */
  readonly hasFailures: boolean
}

/**
 * Split captured output into bun's file-scoped blocks and attribute failures per file.
 *
 * The rule set exists to make ad-hoc greps unnecessary, because greps over this output
 * produced two classes of false attribution: a context-window that crossed a file-header
 * boundary pinned one file's error on its neighbour (WINDOW-BLEED), and a passing test's
 * deliberate internal throw printed an `error:` line inside a green block that the
 * pipeline counted as a failure (EXPECTED-THROW-IN-GREEN). Here an error line belongs to
 * a file only when that file's OWN block carries a `(fail)` marker, and the walk never
 * looks past a boundary: a new header or the `Ran` summary line closes the block.
 */
export function parseFileAttributions(output: string): readonly FileAttribution[] {
  const attributions: FileAttribution[] = []
  let file: string | undefined
  let failingTests: string[] = []
  let errorLines: string[] = []

  const closeCurrent = (): void => {
    if (file === undefined) {
      return
    }
    attributions.push({
      file,
      failCount: failingTests.length,
      failingTests: [...failingTests],
      errorLines: failingTests.length > 0 ? [...errorLines] : [],
      hasFailures: failingTests.length > 0,
    })
    file = undefined
    failingTests = []
    errorLines = []
  }

  for (const line of toLines(output)) {
    if (RAN_LINE_PATTERN.test(line)) {
      closeCurrent()
      continue
    }
    const header = FILE_HEADER_PATTERN.exec(line)
    if (header !== null) {
      closeCurrent()
      file = header[1] ?? ''
      continue
    }
    if (file === undefined) {
      continue
    }
    const fail = FAIL_MARKER_PATTERN.exec(line)
    if (fail !== null) {
      failingTests.push((fail[1] ?? '').trim())
      continue
    }
    if (ERROR_LINE_PATTERN.test(line)) {
      errorLines.push(line.trim())
    }
  }
  closeCurrent()

  return attributions
}

/** Render the per-file failure table printed after a failing step's verdict. Additive output. */
export function formatFileAttributionTable(attributions: readonly FileAttribution[]): string {
  const failing = attributions.filter(attribution => attribution.hasFailures)
  if (failing.length === 0) {
    return ''
  }
  return [
    "run-test-full: per-file failures (an error: line is attributed only within its own file's failing block):",
    ...failing.flatMap(attribution => [
      `  ${attribution.file} - ${attribution.failCount} failing test(s)`,
      ...attribution.failingTests.map(name => `    (fail) ${name}`),
      ...attribution.errorLines.map(line => `    ${line}`),
    ]),
  ].join('\n')
}

/** Why a step was rejected. Every value means "do not let this pass". */
export type StepFailureReason =
  | 'spawn-failed'
  | 'signal'
  | 'no-summary'
  | 'no-tests'
  | 'unreconciled-summary'
  | 'reported-failures'
  | 'below-min-passing'
  | 'child-exit'

/** How the child process ended. */
export type StepOutcome = {
  /** Exit status, or `null` when the child died on a signal. */
  readonly exitCode: number | null
  /** Terminating signal, or `null`. */
  readonly signal: string | null
  /** Set when the process could not be spawned at all. */
  readonly spawnError?: string
}

/** The guard's ruling on one step. */
export type StepVerdict = {
  readonly ok: boolean
  /** Exit code this driver should use: the child's own when non-zero, else 1. */
  readonly exitCode: number
  /** Every assertion that failed, most diagnostic first. Empty when `ok`. */
  readonly reasons: readonly StepFailureReason[]
  /** Multi-line, unmistakable diagnostic naming which assertion(s) failed. */
  readonly message: string
  /** The parsed summary, when one was found. */
  readonly summary: BunTestSummary | undefined
}

/** Render what a step's summary actually said, for the failure diagnostic. */
function describeSummary(summary: BunTestSummary | undefined): string {
  if (!summary) {
    return '  parsed summary: (none - no "Ran <N> tests across <M> files" line in the captured output)'
  }
  const counts = TEST_COUNT_LABELS.map(label => `${label}=${summary.counts[label]}`).join(' ')
  const reported = summary.reportedLabels.length > 0 ? summary.reportedLabels.join(',') : '(none)'
  const other = summary.otherLabels.length > 0 ? ` other=[${summary.otherLabels.join(', ')}]` : ''
  return [
    `  parsed summary: ${summary.line}`,
    `  parsed counts:  ${counts} (lines present: ${reported})${other}`,
  ].join('\n')
}

/**
 * Decide whether a finished step may count as a pass. Pure - `output` and `outcome` are
 * everything it looks at - so the whole decision is unit-testable without spawning bun.
 *
 * Fail-closed by construction: the only route to `ok: true` is to positively satisfy
 * A1-A5. A truncated, empty or otherwise unrecognised shape falls through to
 * `no-summary` (or `unreconciled-summary`) and fails.
 */
export function evaluateStep(step: StepSpec, output: string, outcome: StepOutcome): StepVerdict {
  const summary = parseBunTestSummary(output)
  const reasons: StepFailureReason[] = []
  const problems: string[] = []

  if (outcome.spawnError !== undefined) {
    reasons.push('spawn-failed')
    problems.push(`could not spawn \`${step.command.join(' ')}\`: ${outcome.spawnError}`)
  }

  if (outcome.signal !== null) {
    reasons.push('signal')
    problems.push(`the child was killed by signal ${outcome.signal} - the run did not finish`)
  }

  if (!summary) {
    reasons.push('no-summary')
    problems.push(
      `A1 SUMMARY: no "Ran <N> tests across <M> files" line was emitted (child exit ${String(outcome.exitCode)}) - treating as failure`,
    )
  } else {
    const { counts, tests } = summary

    if (tests === 0) {
      reasons.push('no-tests')
      problems.push('A4 NON-EMPTY: the summary reports 0 tests - nothing was actually executed')
    }

    const accounted = counts.pass + counts.fail + counts.skip + counts.todo
    if (accounted !== tests) {
      reasons.push('unreconciled-summary')
      problems.push(
        `A3 RECONCILED: pass+fail+skip+todo = ${accounted} but the summary says ${tests} test(s) ran - the count block does not add up, treating as failure`,
      )
    }

    if (counts.fail > 0) {
      reasons.push('reported-failures')
      problems.push(`A2 NO FAILURES: the summary reports ${counts.fail} failing test(s)`)
    }

    if (step.minPassing !== undefined && counts.pass < step.minPassing) {
      reasons.push('below-min-passing')
      problems.push(
        `A6 MIN PASSING: the summary reports ${counts.pass} passing test(s) but this step must report at least ${step.minPassing} - a skipped or filtered-out run proves nothing`,
      )
    }
  }

  if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    reasons.push('child-exit')
    problems.push(`A5 CLEAN EXIT: the child exited ${outcome.exitCode}`)
  }

  if (reasons.length === 0 && summary !== undefined) {
    const { counts, tests, files } = summary
    return {
      ok: true,
      exitCode: 0,
      reasons: [],
      message: `run-test-full: ${step.name} OK - ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.todo} todo across ${tests} test(s) / ${files} file(s)`,
      summary,
    }
  }

  return {
    ok: false,
    exitCode: outcome.exitCode !== null && outcome.exitCode !== 0 ? outcome.exitCode : 1,
    reasons,
    message: [
      `run-test-full: FAILED - step "${step.name}" (${step.command.join(' ')})`,
      ...problems.map(problem => `  - ${problem}`),
      describeSummary(summary),
    ].join('\n'),
    summary,
  }
}

/**
 * How long the group gets to honour SIGTERM before it is SIGKILLed.
 *
 * The failure this exists for is a pure-userland spin - a `bun test` worker at 98.9% CPU
 * holding 15.7 GB - which is exactly the shape that never gets around to running a signal
 * handler. Polite first, then certain.
 */
export const GROUP_KILL_GRACE_MS = 2_000

/**
 * Signal an entire process group, tolerating a group that has already gone.
 *
 * `process.kill` reads a NEGATIVE pid as "every process in the group led by that pid" -
 * that minus sign is the whole point of this helper, and is why the child is spawned
 * `detached` (below) so that its pid IS a group id.
 *
 * Two hazards are deliberately closed off:
 *   - pids <= 1 are refused. `kill(-0, ...)` signals the CALLER's own group (suicide, and
 *     it would take the supervisor's shell with it) and `kill(-1, ...)` signals every
 *     process the user can reach. A missing `child.pid` must never degrade into either.
 *   - ESRCH is swallowed. The group being gone is the NORMAL path - a step that exited
 *     cleanly is already reaped - and a throw here would escape into an exit handler and
 *     corrupt the exit code this script exists to get right.
 *
 * @returns whether a signal was actually delivered - false means "nothing was there".
 */
export function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  kill: (target: number, signal: NodeJS.Signals) => void = (target, sig) => {
    process.kill(target, sig)
  },
): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) {
    return false
  }
  try {
    kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * The spawn options every step runs under.
 *
 * `detached: true` is the fix: on POSIX it puts the child through `setsid()`, so the
 * child leads its own session and process group (pgid == pid) and `killProcessGroup` can
 * reach the whole tree - the `bun test` worker included - with one negative-pid signal.
 * Without it, killing this wrapper leaves the grandchild reparented to init and running:
 * measured once at 98.9% CPU / 15.7 GB resident for 3h36m, taking the box to load 186 and
 * two OOM kills.
 *
 * stdin is `'ignore'`, NOT the `'inherit'` it used to be, and that pairing is not
 * incidental. A detached child is no longer in the terminal's foreground process group,
 * so if it ever read the terminal it would take SIGTTIN and STOP - converting a runaway
 * orphan into a silent hang, which is strictly worse. Both steps are non-interactive
 * `bun test` invocations (`SWEEP_STEP`, `CONVERSATION_ARC_STEP`) that never read stdin,
 * so handing them `/dev/null` costs nothing and removes the failure mode by construction.
 * stdout/stderr stay piped - the run has to remain observable and parseable.
 */
export function stepSpawnOptions(step: StepSpec): SpawnOptions {
  return {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: step.env ? { ...process.env, ...step.env } : process.env,
  }
}

/**
 * Spawn one step, streaming both streams straight through while capturing them.
 *
 * stdout AND stderr are captured into a single buffer on purpose: bun writes its summary
 * block to STDERR, so a stdout-only capture would never see it and would reject every
 * run.
 *
 * The step runs as its own process GROUP (see `stepSpawnOptions`), and every path that
 * ends this wrapper tears that whole group down:
 *   - SIGINT / SIGTERM reaching the wrapper are forwarded to the group, then escalated to
 *     SIGKILL after `GROUP_KILL_GRACE_MS`;
 *   - the wrapper's own `exit` SIGKILLs the group synchronously, because an exit handler
 *     cannot wait out a grace period and a live orphan is worse than an abrupt child;
 *   - a step that finishes SIGKILLs its group too, so no straggler the child spawned
 *     outlives the step that started it.
 * The listeners are removed once the step settles, so a multi-step run does not leak a
 * handler set per step.
 */
export async function runStep(step: StepSpec): Promise<{ output: string; outcome: StepOutcome }> {
  const [command, ...args] = step.command
  const chunks: string[] = []

  return await new Promise(resolve => {
    const child = spawn(command, args, stepSpawnOptions(step))
    const groupPid = child.pid

    let escalation: ReturnType<typeof setTimeout> | undefined
    let settled = false

    /** Forward a wrapper-level signal to the group, then make sure it dies. */
    const onSignal = (signal: NodeJS.Signals): void => {
      killProcessGroup(groupPid, signal)
      escalation ??= setTimeout(() => {
        killProcessGroup(groupPid, 'SIGKILL')
      }, GROUP_KILL_GRACE_MS)
    }

    /** Last resort. `exit` handlers are synchronous, so there is no grace period to give. */
    const onExit = (): void => {
      killProcessGroup(groupPid, 'SIGKILL')
    }

    const cleanup = (): void => {
      if (escalation !== undefined) {
        clearTimeout(escalation)
        escalation = undefined
      }
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('exit', onExit)
    }

    const settle = (result: { output: string; outcome: StepOutcome }): void => {
      if (settled) {
        return
      }
      settled = true
      killProcessGroup(groupPid, 'SIGKILL')
      cleanup()
      resolve(result)
    }

    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    process.on('exit', onExit)

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'))
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'))
      process.stderr.write(chunk)
    })

    child.once('error', (error: Error) => {
      settle({
        output: chunks.join(''),
        outcome: { exitCode: null, signal: null, spawnError: error.message },
      })
    })

    child.once('close', (code: number | null, signal: string | null) => {
      settle({ output: chunks.join(''), outcome: { exitCode: code, signal } })
    })
  })
}

/** Run one step and rule on it, echoing the verdict. Returns the code to exit with. */
export async function runGuardedStep(step: StepSpec): Promise<number> {
  const envNote = step.env
    ? ` (env: ${Object.entries(step.env)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')})`
    : ''
  console.error(`run-test-full: running ${step.name} - ${step.command.join(' ')}${envNote}`)

  const { output, outcome } = await runStep(step)
  const verdict = evaluateStep(step, output, outcome)
  console.error(verdict.message)
  // Additive diagnostics only - the verdict and exit code above are untouched.
  const attributionTable = formatFileAttributionTable(parseFileAttributions(output))
  if (attributionTable !== '') {
    console.error(attributionTable)
  }
  return verdict.exitCode
}

/** Run every step in order, stopping at the first failure. */
export async function main(steps: readonly StepSpec[] = TEST_FULL_STEPS): Promise<number> {
  // Names only, never values (see PROVIDER_ENV_NAMES). A sweep run from a
  // provider-switched shell is self-identifying from its first line onward.
  console.error(formatProviderEnvFingerprint())
  for (const step of steps) {
    const code = await runGuardedStep(step)
    if (code !== 0) {
      return code
    }
  }
  console.error('run-test-full: all steps passed')
  return 0
}

if (import.meta.main) {
  process.exitCode = await main()
}
