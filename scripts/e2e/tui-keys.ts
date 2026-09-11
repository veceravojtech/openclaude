/**
 * E2E harness for TUI key delivery, driven through a real pty by tmux.
 *
 * Ink unit tests write to a fake stdin, so they cannot prove how keys arrive
 * from a terminal. This harness runs the BUILT CLI (`dist/cli.mjs`) inside a
 * real tmux pane and drives it with `send-keys`, which is the only way to
 * reproduce two pty-level key-delivery defects:
 *
 *   DEFECT A - every key of a single `send-keys` call reaches the CLI in ONE
 *     stdin read. App.tsx dispatches the whole batch synchronously with no
 *     render in between, so a dialog reading its selected index from the
 *     render closure runs Enter against the PRE-Down selection. `Down Down
 *     Enter` in one burst therefore confirms row 1 instead of row 3.
 *
 *   DEFECT B - a DOWN whose ESC byte is separated from `[B` by more than the
 *     300ms escape flush arrives as a bare Escape followed by a nameless
 *     `[B` key. Reproduced with `send-keys -H` and a deliberate 350ms gap.
 *
 * Safety: this repo is normally worked on from inside tmux, so the harness
 * NEVER touches the default tmux server. Every command goes to a PER-RUN
 * private server whose socket lives inside the run's own temp root
 * (`tmux -S <runRoot>/tmux.sock`, printed once at startup) that is killed in a
 * `finally` block and on SIGINT - Ctrl-C kills the server, removes the run's
 * temp roots and exits 130, while a Ctrl-C landing during a teardown that is
 * ALREADY running is absorbed, so the normal exit code stands.
 *
 * A root orphaned by a hard kill is swept at the next start. Every run stamps
 * its own root with `<runRoot>/pid`, and the sweep trusts that owner pid over
 * the socket: a live owner means hands off, a dead or unrecorded owner whose
 * server still answers is an ORPHAN (that server is killed and the root
 * removed), and one with no server is simply removed. The sweep never throws -
 * a candidate it cannot touch costs one printed line and nothing more.
 *
 * `mkdtemp` gives every run its own directory, so two concurrent runs cannot
 * kill each other's server - and since tmux never unlinks a socket on
 * `kill-server`, keeping it in that directory is what stops each run leaving a
 * dead socket behind in the shared tmux socket directory.
 * The CLI also gets a throwaway config/home so the developer's real OpenClaude
 * config, onboarding state and session history are untouched.
 *
 * Expectations are derived from the RENDERED pane, not from a table of model
 * names: the picker's rows are parsed out of `capture-pane` and the scenarios
 * ask for "the row two Downs below the preselected one". A model rename in the
 * product therefore cannot silently invalidate this harness.
 *
 * Not named `*.test.ts` on purpose: it must never be collected by `bun test`.
 *
 * Requires ES2023 (`Array.prototype.findLast`).
 *
 * Run with: OPENCLAUDE_E2E=1 bun run e2e:tui
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  MIN_TMUX_MAJOR,
  MIN_TMUX_MINOR,
  isTmuxTooOld,
  parseTmuxVersion,
} from './tmux-version'

/**
 * Socket path of the private tmux server for THIS run, assigned by `main()`
 * once the run root exists (see `createRunRoot`).
 *
 * The unique `mkdtemp` directory is what keeps two concurrent runs from killing
 * each other's server - every `kill-server` in here (pre-run, SIGINT, teardown)
 * targets this socket and only this socket. Putting the socket INSIDE that
 * directory is what keeps the shared tmux socket directory clean: tmux leaves
 * the file behind on `kill-server`, so only the temp-root deletion removes it.
 *
 * Empty until `main()` assigns it; `tmux()` throws on that rather than falling
 * back to the default server.
 */
let socketPath = ''
const SESSION = 'oc'
const CLI_WINDOW = `${SESSION}:0`
const SCRATCH_WINDOW = `${SESSION}:1`
const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI_BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')

/** Escape flush is 300ms, so 350ms reliably lands past it. */
const ESCAPE_SPLIT_GAP_MS = 350
const BOOT_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100
/** The CLI can rewrite its config while dying, so cleanup retries. */
const CLEANUP_TIMEOUT_MS = 5_000
/**
 * Teardown budget on the SIGINT path, kept well under the 3s a developer is
 * willing to wait for Ctrl-C. Teardown is otherwise identical to the `finally`
 * one; only the patience for a slow-dying CLI is shorter.
 */
const INTERRUPT_CLEANUP_TIMEOUT_MS = 2_000

/**
 * Name prefix of a run root, and the only thing the startup sweep matches.
 *
 * The `-run-` infix is load-bearing: the per-scenario config roots (and some
 * unrelated `openclaude-e2e-*` directories a developer may already have in
 * `tmpdir()`) share the `openclaude-e2e-` stem, and the sweep must never
 * consider those.
 */
const RUN_ROOT_PREFIX = 'openclaude-e2e-run-'

/**
 * Name of the ownership marker inside a run root, holding the pid of the
 * process that created it.
 *
 * It exists because the SOCKET is not evidence of a live run for most of a
 * run's life: it appears only at the first `new-session` and is already gone
 * (server-wise) before teardown removes the root. The pid is written as soon as
 * the root exists, so a concurrent run's sweep can tell "live, not booted yet"
 * from "killed with -9".
 */
const RUN_PID_FILE = 'pid'

/**
 * Conservative cap on the socket path, checked before any tmux call.
 *
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS/BSD, minus the
 * NUL; tmux itself fails at `new-session` with a confusing `File name too
 * long`. 100 bytes leaves room for that difference and fails early instead.
 */
const SOCKET_PATH_LIMIT_BYTES = 100

/** The glyph the picker puts in front of the selected row. */
const SELECTION_MARKER = '❯'

/**
 * How many rows the picker must render for the scenarios to be meaningful.
 *
 * This is a property of the SCENARIOS, not of the product: scenario 1 sends
 * two Downs from the preselected row, so it needs that row plus two more. It
 * is the one count the harness cannot read off the pane - everything else
 * (which rows exist, their labels, which one starts selected) is parsed from
 * the rendered picker. Fewer rows than this is a hard failure, never a skip.
 */
const MIN_PICKER_ROWS = 3

/**
 * Temp roots created this run - the run root holding the tmux socket, plus one
 * config root per scenario - deleted only once the server is dead.
 */
const tempRoots: string[] = []

/** PIDs of the CLI panes started this run, so teardown can wait them out. */
const clientPids: number[] = []

/** One rendered picker row, parsed out of the captured pane. */
type PickerRow = { row: number; label: string; selected: boolean }

type ScenarioResult = {
  name: string
  passed: boolean
  expected: string
  actual: string
  rows: PickerRow[]
  pane: string
}

/**
 * Awaited sleep - the ONLY sleep on a path that runs while the harness is
 * driving the CLI (pane polling, the scenario timing gap).
 *
 * It yields to the event loop, which is what makes a run interruptible at all:
 * a signal handler is a macrotask, so it can only run between turns. The whole
 * harness is async for this one reason; the individual tmux calls stay
 * `spawnSync` (each is bounded by its own 15s timeout).
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Blocking sleep - used ONLY by `cleanupTempRoots()`, deliberately.
 *
 * Teardown must not yield: the SIGINT handler calls it and then
 * `process.exit(130)`, and an awaited sleep in there would hand control back to
 * the interrupted scenario (which would keep driving a server that is already
 * dead) and let a second Ctrl-C re-enter teardown. `Atomics.wait` keeps the
 * whole teardown one uninterruptible turn.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function tmux(...args: string[]): { status: number; stdout: string; stderr: string } {
  if (socketPath === '') {
    // Never silently fall back to the default server: that is the one the
    // developer works in, and a `kill-server` there would take it down.
    throw new Error('tmux() called before main() created the private server socket')
  }
  const result = spawnSync('tmux', ['-S', socketPath, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * The `tmux -V` banner (trimmed), or null when tmux cannot be run at all.
 *
 * One probe serves both tmux skip checks - "on PATH" and "new enough" - so the
 * version banner is read exactly once. The only tmux call that does not go
 * through `tmux()`: `-V` prints the version without contacting any server,
 * default or otherwise.
 */
function probeTmuxVersion(): string | null {
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 })
  if (probe.status !== 0) return null
  return (probe.stdout ?? '').trim()
}

function capturePane(): string {
  return stripVTControlCharacters(tmux('capture-pane', '-p', '-t', CLI_WINDOW).stdout)
}

/**
 * Poll `capture-pane` until `predicate` holds. Assertions NEVER use a bare
 * sleep - an unmet predicate must fail by timeout, not by racing the UI.
 *
 * `label` names the step being waited for. On timeout it is printed together
 * with the last captured pane, so a renamed UI string yields a readable diff
 * instead of a silent 15s wait. Printing here covers every call site at once.
 */
async function waitForPane(
  label: string,
  predicate: (pane: string) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; pane: string }> {
  const deadline = Date.now() + timeoutMs
  let pane = ''
  do {
    pane = capturePane()
    if (predicate(pane)) return { ok: true, pane }
    await sleep(POLL_INTERVAL_MS)
  } while (Date.now() < deadline)
  console.error(`\nTIMEOUT after ${timeoutMs}ms waiting for ${label}`)
  console.error(`${'-'.repeat(78)}\n${pane.replace(/\n+$/, '')}\n${'-'.repeat(78)}`)
  return { ok: false, pane }
}

/**
 * A rendered picker row: an optional selection marker, the 1-based row number,
 * then the label followed by the aligned description column. Anchored at the
 * start of the line so prose that merely mentions "1." cannot match.
 */
const PICKER_ROW_RE = /^\s*(❯)?\s*(\d+)\.\s+(\S.*)$/

/**
 * The label half of a rendered row. The row is two aligned columns - label,
 * then description - separated by the alignment gap, so the first run of 2+
 * spaces ends the label. A trailing `✔` badge marks the model that is already
 * active and is not part of the label.
 */
function pickerLabel(rest: string): string {
  const [first = ''] = rest.split(/\s{2,}/)
  return first.replace(/\s*✔\s*$/, '').trim()
}

/**
 * Parse the picker's rows out of a captured pane.
 *
 * Only a run of consecutively numbered rows starting at 1 is accepted, and the
 * LAST such run wins: the picker renders below the transcript, so anything the
 * transcript happens to number cannot displace it.
 */
function parsePickerRows(pane: string): PickerRow[] {
  let run: PickerRow[] = []
  let latest: PickerRow[] = []
  for (const line of pane.split('\n')) {
    const match = PICKER_ROW_RE.exec(line)
    if (!match) continue
    const number = Number(match[2])
    const label = pickerLabel(match[3] ?? '')
    if (!Number.isInteger(number) || label.length === 0) continue
    if (number === 1) run = []
    if (number !== run.length + 1) continue
    run.push({ row: number, label, selected: match[1] === SELECTION_MARKER })
    latest = run
  }
  return latest
}

function formatRows(rows: PickerRow[]): string {
  if (rows.length === 0) return '    (no rows parsed)'
  return rows
    .map(row => `    ${row.selected ? SELECTION_MARKER : ' '} ${row.row}. ${row.label}`)
    .join('\n')
}

/**
 * Significant tokens of a rendered string, lowercased: the words and version
 * numbers that identify a model. Separators and punctuation are dropped, but a
 * dot INSIDE a token is kept so `4.6` stays a single token.
 */
function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map(token => token.replace(/^\.+|\.+$/g, ''))
    .filter(token => token.length > 0)
}

/**
 * Which pane-derived row does this confirmation line name?
 *
 * The confirmation text is NOT the row text - row 3 renders `Sonnet (1M
 * context)` but confirms as `Sonnet 4.6 (1M context)` - so a literal
 * `includes()` of the label cannot work, and a constant mapping would put the
 * expectation back into the harness. Instead: every row whose significant
 * tokens all appear in the confirmation is a candidate, and the candidate with
 * the MOST matched tokens wins.
 *
 * The argmax is what makes this discriminating. The picker renders both `Opus
 * 4.6 (1M context)` and `Opus (1M context)`, and the latter's tokens are a
 * strict subset of the former's confirmation, so a plain subset test would
 * call a row-2 confirmation a row-4 match as well. A tie - or no candidate at
 * all - is reported as a failure rather than guessed at.
 */
function rowNamedBy(
  rows: PickerRow[],
  confirmation: string,
): { row: PickerRow | null; reason: string } {
  const confirmationTokens = new Set(significantTokens(confirmation))
  const matches = rows
    .map(row => ({ row, tokens: significantTokens(row.label) }))
    .filter(
      candidate =>
        candidate.tokens.length > 0 &&
        candidate.tokens.every(token => confirmationTokens.has(token)),
    )
    .map(candidate => ({ row: candidate.row, score: candidate.tokens.length }))
    .sort((a, b) => b.score - a.score)

  const [best, runnerUp] = matches
  if (!best) {
    return { row: null, reason: 'no picker row has all of its tokens in the confirmation line' }
  }
  if (runnerUp && runnerUp.score === best.score) {
    const tied = matches
      .filter(match => match.score === best.score)
      .map(match => match.row.row)
      .join(', ')
    return { row: null, reason: `ambiguous - rows ${tied} match the confirmation equally well` }
  }
  return { row: best.row, reason: `${best.score} of its tokens matched` }
}

/**
 * The row a scenario expects after `downs` Down presses. Both ends come from
 * the pane: the starting row is read from the selection marker (the picker
 * preselects the CURRENT model), never assumed to be row 1.
 */
function rowAfterDowns(rows: PickerRow[], downs: number): PickerRow {
  const start = rows.findIndex(row => row.selected)
  if (start < 0) {
    throw new Error(
      `no picker row is marked selected ("${SELECTION_MARKER}") among ${rows.length} parsed rows:\n${formatRows(rows)}`,
    )
  }
  const target = rows[start + downs]
  if (!target) {
    throw new Error(
      `picker cannot reach row ${start + downs + 1} with ${downs} Down key(s); only ${rows.length} rows rendered:\n${formatRows(rows)}`,
    )
  }
  return target
}

/**
 * Create this run's own temp root and point the private server's socket at it.
 *
 * Called from `main()` AFTER the skip checks, never at module scope: a root
 * created before those checks would be leaked by every skipped run. The root
 * goes onto `tempRoots`, so the socket is removed by exactly the teardown that
 * removes the config roots - once the server is dead, never before. It sits
 * directly under `tmpdir()` because a Unix socket path caps near 108 bytes;
 * `/tmp/openclaude-e2e-run-XXXXXX/tmux.sock` is ~40.
 *
 * Returns false when the socket path would exceed `SOCKET_PATH_LIMIT_BYTES` -
 * a deep `TMPDIR`. `socketPath` is then left EMPTY, so `tmux()` still cannot be
 * reached (its throw is the backstop), the just-created root is removed again
 * and taken back off `tempRoots`, and `main()` returns 1 having touched no
 * tmux server at all - which is why the `pid` marker is written only PAST that
 * guard: a run that bails there must leave nothing behind at all.
 */
function createRunRoot(): boolean {
  const root = mkdtempSync(join(tmpdir(), RUN_ROOT_PREFIX))
  tempRoots.push(root)
  const candidate = join(root, 'tmux.sock')
  // Bytes, not characters: a non-ASCII TMPDIR costs more than its length.
  const bytes = Buffer.byteLength(candidate)
  if (bytes > SOCKET_PATH_LIMIT_BYTES) {
    rmSync(root, { recursive: true, force: true })
    const queued = tempRoots.indexOf(root)
    if (queued >= 0) tempRoots.splice(queued, 1)
    console.error(
      `ERROR: tmux socket path too long (${bytes} bytes, limit ~104): set TMPDIR to a shorter directory.`,
    )
    console.error(`       TMPDIR resolves to ${tmpdir()}`)
    console.error(`       the socket would have been ${candidate}`)
    return false
  }
  // Claim the root before anything else can look at it. The socket does not
  // exist until the first `new-session`, so between here and there this marker
  // is the ONLY thing telling a concurrent run's sweep that the root is alive.
  // Left unguarded on purpose: a root we just created and cannot write into is
  // a doomed run, and the loud throw is better than a run that limps on with a
  // root every other sweep is entitled to delete.
  writeFileSync(join(root, RUN_PID_FILE), `${process.pid}\n`)
  socketPath = candidate
  return true
}

/**
 * The owner pid a run root advertises in its `pid` marker, or null.
 *
 * Missing, unreadable, unparseable and non-positive all collapse to UNKNOWN: a
 * legacy root from before the marker existed, one whose owner died between
 * `mkdtemp` and the marker write, a truncated file, a directory we may not read
 * into. Unknown is deliberately NOT read as alive - it falls through to the
 * socket probe, which is exactly the pre-marker behaviour.
 */
function readOwnerPid(root: string): number | null {
  let raw = ''
  try {
    raw = readFileSync(join(root, RUN_PID_FILE), 'utf8')
  } catch {
    return null
  }
  const pid = Number(raw.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** The `errno` code of a caught error, for the sweep's one-line report. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one tmux command against a CANDIDATE root's server and return its status.
 *
 * Deliberately bypasses the `tmux()` funnel - that one targets THIS run's
 * socket, which does not exist yet when the sweep runs - the same way
 * `probeTmuxVersion()` does. The socket path is derived from the candidate root
 * here rather than passed in, so `-S <candidate>/tmux.sock` is the only thing
 * this can ever address: the default socket directory (`/tmp/tmux-<uid>/`, or
 * `$TMUX_TMPDIR`) is neither read nor written, and no `kill-server` in the
 * sweep can be aimed anywhere else.
 */
function candidateServer(root: string, ...args: string[]): number {
  const probe = spawnSync('tmux', ['-S', join(root, 'tmux.sock'), ...args], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  return probe.status ?? 1
}

/**
 * Decide the fate of ONE candidate run root, and act on it.
 *
 * Liveness is the OWNER first and the socket only second, because the socket is
 * not evidence of anything for most of a run's life. `createRunRoot()`
 * publishes the root long before the first `new-session` creates the socket,
 * and teardown kills the server before it removes the root; a socket-only probe
 * therefore judges a perfectly live concurrent run dead in BOTH windows and
 * deletes its root from under it - the victim's `new-session` then fails on the
 * socket's missing parent. A live owner pid closes both windows at once, so
 * whatever the socket says, that root is left completely alone.
 *
 * pid reuse is accepted rather than defended against: an unrelated live process
 * that happens to hold that number only postpones this root's sweep to a later
 * run, which is strictly the better failure. No attempt is made to verify
 * process identity.
 *
 * Owner dead or unknown and yet a server ANSWERS is an orphan - a run killed
 * hard left a private tmux server that nothing owns and nothing will ever kill.
 * It is killed here through its own socket and the root goes with it, because
 * otherwise every such incident costs one immortal tmux server.
 */
function sweepOneRunRoot(root: string): void {
  const owner = readOwnerPid(root)
  if (owner !== null && isProcessAlive(owner)) {
    console.log(`stale-root sweep: ${root} is owned by live pid ${owner} - left alone`)
    return
  }
  const owned = owner === null ? 'no owner pid recorded' : `owner pid ${owner} is gone`
  if (candidateServer(root, 'list-sessions') === 0) {
    candidateServer(root, 'kill-server')
    rmSync(root, { recursive: true, force: true })
    console.log(
      `stale-root sweep: ${root} had an ORPHANED server (${owned}) - killed it and removed the root`,
    )
    return
  }
  rmSync(root, { recursive: true, force: true })
  console.log(`stale-root sweep: removed ${root} (${owned}, no server answered its socket)`)
}

/**
 * Remove run roots left behind by a run that never reached its teardown - a
 * `kill -9`, a crashed shell, a closed terminal - and reclaim any orphaned
 * server still running inside one. `sweepOneRunRoot` holds the decision; this
 * function only selects the candidates and contains their failures.
 *
 * It NEVER throws, by construction. `rmSync(..., { force: true })` forgives
 * only ENOENT, and a directory in a world-writable `tmpdir()` can be owned by
 * another user, sit at mode 000, be busy, or vanish mid-sweep - none of which is
 * this run's problem. Every candidate is wrapped, a failure costs exactly one
 * printed line, and the sweep moves on; `readdirSync` is wrapped for the same
 * reason. A run must never fail because of a root it does not own.
 */
function sweepStaleRunRoots(): void {
  const parent = tmpdir()
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    // An unreadable tmpdir() is about to fail much more loudly in mkdtemp.
    return
  }
  for (const entry of entries) {
    // Directory-ness matters: a plain file named `openclaude-e2e-run-*` is not
    // a run root, and the sweep must not delete a developer's file.
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_ROOT_PREFIX)) continue
    const root = join(parent, entry.name)
    try {
      sweepOneRunRoot(root)
    } catch (error) {
      console.log(`stale-root sweep: skipped ${root} (${errorCode(error)})`)
    }
  }
}

/**
 * Seed an isolated config so the CLI boots straight to the prompt.
 *
 * `OPENCLAUDE_CONFIG_DIR` is the CLI's only config-home override
 * (src/utils/envUtils.ts `resolveConfigDirEnv` deliberately ignores
 * `CLAUDE_CONFIG_DIR`). It redirects both the global config file and the
 * projects/teams directories, so nothing under the real `~/.openclaude*` is
 * read or written. HOME/XDG_CONFIG_HOME are redirected too as a backstop for
 * any library that resolves paths from the home directory directly.
 *
 * Without `theme` + `hasCompletedOnboarding` + per-project
 * `hasTrustDialogAccepted`, `getRequiredSetupScreens` would show the
 * onboarding and trust screens instead of the prompt.
 */
function seedConfigDir(
  extraGlobalConfig: Record<string, unknown> = {},
): { configDir: string; homeDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-e2e-'))
  const configDir = join(root, 'config')
  const homeDir = join(root, 'home')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(
    join(configDir, '.openclaude.json'),
    JSON.stringify(
      {
        theme: 'dark',
        hasCompletedOnboarding: true,
        migrationVersion: 11,
        projects: {
          [REPO_ROOT]: {
            hasTrustDialogAccepted: true,
            allowedTools: [],
            history: [],
          },
        },
        ...extraGlobalConfig,
      },
      null,
      2,
    ),
  )
  return { configDir, homeDir, root }
}

/**
 * Boot the built CLI on the private server, plus a throwaway second window
 * that scenario 2 switches to. Each scenario gets a fresh session and a fresh
 * config so the picker cursor always starts on the same row - the picker
 * preselects the CURRENT model, so reusing a session would make the expected
 * row depend on whatever the previous scenario selected.
 */
async function startCliSession(
  options: {
    /** Extra `-e KEY=VALUE` pairs for the CLI's environment (scenario 4). */
    extraEnv?: Record<string, string>
    /** Extra top-level fields merged into the seeded global config. */
    extraGlobalConfig?: Record<string, unknown>
  } = {},
): Promise<void> {
  const { configDir, homeDir, root } = seedConfigDir(options.extraGlobalConfig)
  tempRoots.push(root)

  const extraEnvArgs = Object.entries(options.extraEnv ?? {}).flatMap(
    ([key, value]) => ['-e', `${key}=${value}`],
  )
  tmux(
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '120',
    '-y',
    '40',
    '-c',
    REPO_ROOT,
    '-e',
    `OPENCLAUDE_CONFIG_DIR=${configDir}`,
    '-e',
    `HOME=${homeDir}`,
    '-e',
    `XDG_CONFIG_HOME=${join(root, 'xdg')}`,
    ...extraEnvArgs,
    `node ${CLI_BUNDLE}`,
  )
  tmux('new-window', '-d', '-t', `${SESSION}:`, '-n', 'scratch', 'sh -c "while :; do sleep 3600; done"')

  // Remember the CLI process so teardown can wait for it to actually exit.
  const panePid = Number(
    tmux('display-message', '-p', '-t', CLI_WINDOW, '#{pane_pid}').stdout.trim(),
  )
  if (Number.isInteger(panePid) && panePid > 0) clientPids.push(panePid)

  const booted = await waitForPane(
    'the CLI prompt ("? for shortcuts") after boot',
    pane => pane.includes('? for shortcuts'),
    BOOT_TIMEOUT_MS,
  )
  if (!booted.ok) {
    throw new Error(`CLI did not reach the prompt within ${BOOT_TIMEOUT_MS}ms:\n${booted.pane}`)
  }
}

/** Kill the session and wait for tmux to actually reap it. */
async function stopCliSession(): Promise<void> {
  tmux('kill-session', '-t', SESSION)
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (tmux('has-session', '-t', SESSION).status !== 0) return
    await sleep(POLL_INTERVAL_MS)
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Delete the temp roots: the per-scenario config roots, and the run root that
 * holds the tmux server's socket.
 *
 * Killing the tmux session - or even the whole server - does NOT mean the CLI
 * has exited. It gets SIGHUP and then flushes config, backups and cache on the
 * way out, so deleting the directory while it is still dying just lets it
 * recreate the tree behind us. Waiting on `has-session`, or deleting-and-
 * retrying, both look like they work and then leak a directory a second later.
 * The only reliable ordering is to wait for the CLI processes themselves to be
 * gone first; the delete-verify-retry loop then covers the remaining slack.
 *
 * Deliberately SYNCHRONOUS, and idempotent: both `tempRoots` and `clientPids`
 * are drained, so a second call - the `finally` after the SIGINT handler, or
 * the top-level rejection path - does nothing. The SIGINT handler depends on
 * both properties: it must tear down in ONE uninterruptible turn (an awaited
 * sleep here would resume the interrupted scenario against a dead server) and
 * it exits before the `finally` can be reached.
 *
 * `budgetMs` is how long to wait for a slow-dying CLI. The SIGINT path passes a
 * shorter one so Ctrl-C stays inside a few seconds; the delete loop itself is
 * do-while, so every root gets at least one `rmSync` regardless of the budget.
 */
function cleanupTempRoots(budgetMs: number = CLEANUP_TIMEOUT_MS): void {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && clientPids.some(isProcessAlive)) {
    sleepSync(POLL_INTERVAL_MS)
  }
  clientPids.length = 0

  for (const root of tempRoots.splice(0)) {
    do {
      rmSync(root, { recursive: true, force: true })
      if (!existsSync(root)) break
      sleepSync(POLL_INTERVAL_MS)
    } while (Date.now() < deadline)
  }
}

/**
 * Open the `/model` picker and return the rows it actually rendered. The wait
 * predicate is row-count based rather than keyed to any particular model name,
 * so renaming a model cannot turn a working picker into a 15s timeout.
 */
async function openModelPicker(): Promise<PickerRow[]> {
  tmux('send-keys', '-t', CLI_WINDOW, '/model', 'Enter')
  const opened = await waitForPane(
    `the /model picker to render at least ${MIN_PICKER_ROWS} rows`,
    pane => pane.includes('Select model') && parsePickerRows(pane).length >= MIN_PICKER_ROWS,
    UI_TIMEOUT_MS,
  )
  if (!opened.ok) {
    const rows = parsePickerRows(opened.pane)
    throw new Error(
      `/model picker did not render at least ${MIN_PICKER_ROWS} rows within ${UI_TIMEOUT_MS}ms - parsed ${rows.length}:\n${formatRows(rows)}\n${opened.pane}`,
    )
  }
  return parsePickerRows(opened.pane)
}

function confirmationLine(pane: string): string {
  const line = pane.split('\n').find(candidate => candidate.includes('Set model to'))
  return line?.trim() ?? '(no "Set model to" line in pane)'
}

/** Shared expectation/actual wording for the two row-selection scenarios. */
function describeSelection(
  rows: PickerRow[],
  target: PickerRow,
  settled: { ok: boolean; pane: string },
): { passed: boolean; expected: string; actual: string } {
  const confirmation = confirmationLine(settled.pane)
  const named = rowNamedBy(rows, confirmation)
  return {
    passed: settled.ok && named.row?.row === target.row,
    expected: `confirmation naming pane-derived row ${target.row} "${target.label}"`,
    actual: `${settled.ok ? '' : 'TIMEOUT waiting for the confirmation; '}${confirmation} -> ${
      named.row
        ? `names row ${named.row.row} "${named.row.label}" (${named.reason})`
        : `names no row (${named.reason})`
    }`,
  }
}

/**
 * DEFECT A: `Down Down Enter` inside ONE `send-keys` call arrives as a single
 * stdin read, so Enter must still act on the row the two Downs selected.
 */
async function scenarioBatchedKeys(): Promise<ScenarioResult> {
  await startCliSession()
  try {
    const rows = await openModelPicker()
    const target = rowAfterDowns(rows, 2)

    // All three keys in ONE send-keys call = one pty write = one stdin read.
    tmux('send-keys', '-t', CLI_WINDOW, 'Down', 'Down', 'Enter')

    const settled = await waitForPane(
      'scenario 1: a "Set model to" confirmation after Down Down Enter in one send-keys',
      pane => pane.includes('Set model to'),
      UI_TIMEOUT_MS,
    )
    return {
      name: `Scenario 1 (DEFECT A): Down Down Enter in ONE send-keys selects row ${target.row}`,
      ...describeSelection(rows, target, settled),
      rows,
      pane: settled.pane,
    }
  } finally {
    // Awaited, not fired and forgotten: the next scenario reuses the session
    // name, and the run's teardown must not race a half-killed session.
    await stopCliSession()
  }
}

/**
 * The user's reported scenario: a real tmux window switch away and back, then
 * `Down` + `Enter` in one burst must select the next row down.
 */
async function scenarioWindowSwitch(): Promise<ScenarioResult> {
  await startCliSession()
  try {
    const rows = await openModelPicker()
    const target = rowAfterDowns(rows, 1)

    // A real window switch away and back - this is the user's exact scenario.
    tmux('select-window', '-t', SCRATCH_WINDOW)
    tmux('select-window', '-t', CLI_WINDOW)
    const back = await waitForPane(
      'scenario 2: the picker still open after the tmux window switch',
      pane => pane.includes('Select model'),
      UI_TIMEOUT_MS,
    )
    if (!back.ok) {
      throw new Error(`picker vanished across the window switch:\n${back.pane}`)
    }

    tmux('send-keys', '-t', CLI_WINDOW, 'Down', 'Enter')

    const settled = await waitForPane(
      'scenario 2: a "Set model to" confirmation after Down Enter',
      pane => pane.includes('Set model to'),
      UI_TIMEOUT_MS,
    )
    return {
      name: `Scenario 2: window switch away/back, then Down + Enter selects row ${target.row}`,
      ...describeSelection(rows, target, settled),
      rows,
      pane: settled.pane,
    }
  } finally {
    // Awaited, not fired and forgotten: the next scenario reuses the session
    // name, and the run's teardown must not race a half-killed session.
    await stopCliSession()
  }
}

/**
 * DEFECT B: DOWN sent as raw hex with its ESC byte split from its `5b 42` tail
 * by 350ms, asserted against ruling (b) - the ruling that was actually
 * implemented.
 *
 * Outcome (a) ("swallow the Escape, picker stays open, selection moves down
 * one row") is IMPOSSIBLE at the parser layer and is documented as such in
 * `src/ink/parse-keypress.ts:375-381`: by the time the orphaned tail is read,
 * the lone Escape has already been emitted AND dispatched to the UI by the
 * earlier flush, and a pure token->key function cannot un-send it. So the
 * picker closes, and that dismissal is the accepted, documented residual of
 * ruling (b) - not a regression this harness should chase.
 *
 * What the fix DOES remove is the user-visible damage. Pre-fix the tail leaked
 * as a nameless key whose raw bytes were typed into the prompt (the pane showed
 * the two-character tail after the prompt glyph); post-fix it is re-synthesized
 * as a real DOWN key, so nothing lands in the prompt. PASS is therefore both
 * halves at once:
 *   - the picker is dismissed WITHOUT a selection ("Kept model as ...", never
 *     "Set model to ..."), and
 *   - no literal bracket-B tail survives anywhere in the captured pane.
 *
 * Note on wording: the strings this scenario REPORTS deliberately spell the
 * tail as "5b 42" / "bracket-B" rather than printing it literally. report()
 * echoes name/expected/actual into the run log, so a literal tail in the prose
 * would make `grep -c` over a full-run log useless as a leak detector. The
 * assertion below still tests the literal bytes, and promptLine still prints
 * whatever the pane holds - so a bracket-B in the log now means a real leak.
 */
async function scenarioSplitEscape(): Promise<ScenarioResult> {
  await startCliSession()
  try {
    const rows = await openModelPicker()

    // Raw hex: ESC, then a gap past the 300ms escape flush, then the tail.
    tmux('send-keys', '-H', '-t', CLI_WINDOW, '1b')
    await sleep(ESCAPE_SPLIT_GAP_MS)
    tmux('send-keys', '-H', '-t', CLI_WINDOW, '5b', '42')

    // Poll for the dismissal rather than sleeping on it, so an unmet outcome
    // fails by timeout instead of racing the UI.
    const dismissed = await waitForPane(
      'scenario 3: the picker dismissed with "Kept model as" after the split ESC',
      pane => !pane.includes('Select model') && pane.includes('Kept model as'),
      UI_TIMEOUT_MS,
    )
    const tailLeaked = dismissed.pane.includes('[B')
    // findLast, not find: the FIRST `❯` line is the `❯ /model` transcript echo,
    // while the prompt input line - the one the leaked tail used to land in -
    // is the last one.
    const promptLine =
      dismissed.pane
        .split('\n')
        .findLast(line => line.trimStart().startsWith('❯'))
        ?.trim() ?? '(no prompt line)'
    return {
      name: 'Scenario 3 (DEFECT B, ruling b): split ESC + hex "5b 42" dismisses the picker and leaves no bracket-B tail in the prompt',
      passed: dismissed.ok && !tailLeaked,
      expected:
        'picker dismissed by the residual Escape ("Kept model as ...", never "Set model to ...") AND no literal bracket-B tail anywhere in the captured pane',
      actual: `${
        dismissed.pane.includes('Select model') ? 'picker STILL OPEN' : 'picker dismissed'
      }; ${
        dismissed.pane.includes('Kept model as')
          ? '"Kept model as" present'
          : 'no "Kept model as" line'
      }; ${confirmationLine(dismissed.pane)}; prompt line: "${promptLine}"; literal bracket-B tail in pane: ${
        tailLeaked ? 'YES (tail leaked)' : 'no'
      }`,
      rows,
      pane: dismissed.pane,
    }
  } finally {
    // Awaited, not fired and forgotten: the next scenario reuses the session
    // name, and the run's teardown must not race a half-killed session.
    await stopCliSession()
  }
}

/**
 * Scenario 4 - the teammates panel is up with zero teammates, and Escape must
 * leave an idle teammate's transcript view.
 *
 * Two halves, in that order. The first is asserted at boot, before the model is
 * asked for anything: the panel draws its `team-lead` row and its empty state
 * with no teammate alive at all. Nothing in the seeded config sets the toggle,
 * so what is under test there is the shipped default; it is the only point in
 * the run where the panel can be seen with zero rows, because every later step
 * has a teammate in it.
 *
 * The second half reproduces the "stuck on Viewing @supervisor" report: a live
 * in-process teammate keeps `status: 'running'` for its whole life (idle is a
 * separate flag), and the Escape handler used to gate on that status alone - it
 * aborted the current turn and returned WITHOUT leaving the view. An idle
 * teammate has no turn to abort, so Escape did nothing and the header's "esc
 * return" hint lied. The fix (src/hooks/useBackgroundTaskNavigation.ts)
 * interrupts a busy teammate and returns from an idle one.
 *
 * The teammate has to come from the model calling the Agent tool, and the
 * harness runs offline, so the CLI is pointed (ANTHROPIC_BASE_URL) at a fake
 * Messages API on the loopback interface that scripts exactly two main turns:
 * the first answers with an `Agent` tool_use spawning `supervisor` with no
 * prompt (an idle spawn, always in-process), the second - the tool_result turn
 * - ends with a short text. Every other request (side calls without the Agent
 * tool: titles, suggestions) gets a one-word text, so nothing else can spawn.
 */
const FAKE_API_KEY = 'sk-ant-api03-e2e-fake-key-0123456789abcdef'
const E2E_TEAMMATE = 'supervisor'
const E2E_TEAM = 'e2e-team'
/**
 * The teammate view header names a teammate by its path down the team tree
 * (`team-lead › supervisor` for a member of the root team), so the line to grep
 * for is the path, not the bare handle. The pill row still shows `@supervisor`,
 * which is what the "teammate survived Escape" check below looks for.
 */
const E2E_TEAMMATE_HEADER = `Viewing team-lead \u203A ${E2E_TEAMMATE}`

/**
 * The two rows the teammates tree panel draws with NO teammates at all - its
 * entire visible surface at boot, and the thing the panel exists for ("visible
 * every time it is enabled, even when no teammates are available").
 *
 * Both come from `src/components/Spinner/TeammateSpinnerTree.tsx`: the root row
 * is assembled from the highlighted-leader glyph, `team-lead` and
 * TEAMMATE_SELECT_HINT (`\u2552\u2550`, :77; `team-lead`, :91; the hint, :128,
 * defined in `Spinner/teammateSelectHint.ts`), and the muted line under it is
 * EmptyTeammatesRow (:329-333). The panel passes no verb, idle text or token
 * count, so nothing else can appear between `team-lead` and the hint.
 *
 * Spelled with escapes on purpose: `\u00B7` and `\u2026` are one editor
 * round-trip away from an ASCII `.` or `...`, and a silently degraded literal
 * here would turn a real regression into a 15s timeout with no clue why.
 */
const E2E_TREE_LEADER_ROW = `\u2552\u2550 team-lead \u00B7 shift + \u2191/\u2193 to select`
const E2E_TREE_EMPTY_ROW = `no teammates \u00B7 Agent(name: "\u2026") spawns one`

/**
 * The selection pointer the tree draws on the row the cursor is on
 * (`figures.pointer`, `TeammateSpinnerTree.tsx:71` for the leader row and the
 * `hide` row, `TeammateSpinnerLine.tsx:232` for a teammate row).
 *
 * This - NOT the leader row's `╒═` - is the only mark that says "selected".
 * `isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected`
 * (`TeammateSpinnerTree.tsx:63-65`) and `isLeaderForegrounded` is true whenever
 * no teammate transcript is open, so `E2E_TREE_LEADER_ROW` is drawn at boot
 * too, selection or no selection.
 *
 * Spelled as an escape and derived from a real capture, not from the JSX: see
 * `selectedTreeRows`.
 */
const E2E_TREE_POINTER = '\u276F'

/**
 * The tree glyph that follows the pointer on a highlighted row: `╒═` on the
 * leader row, `╞═`/`╘═` on a teammate row, `╘═` on the `hide` row. The
 * un-highlighted `┌─`/`├─`/`└─` are accepted too, so a row that ever renders
 * the pointer without the highlight would still be found rather than silently
 * missed.
 *
 * Spelled with escapes, like `treeRowColumn` below, which matches the same
 * glyph class: a box-drawing character is one editor round-trip away from an
 * ASCII lookalike, and a silently degraded class here would stop matching every
 * tree row at once.
 */
const TREE_GLYPH_AFTER_POINTER =
  /^[\u2552\u255E\u2558\u250C\u251C\u2514][\u2550\u2500]/

/**
 * Every tree row the selection pointer sits on, each from its glyph onwards
 * (so the panel's left padding cannot break a comparison).
 *
 * Requiring a tree glyph immediately after the pointer is what keeps the
 * prompt's own `❯` - and any `❯` inside rendered text - out of the result. A
 * healthy tree in selection mode returns EXACTLY one row, which is how a
 * scenario tells "the highlight is still on the row I killed" apart from both
 * "it jumped to another row" and "it dangles on none at all".
 */
function selectedTreeRows(pane: string): string[] {
  const rows: string[] = []
  for (const line of pane.split('\n')) {
    const at = line.indexOf(E2E_TREE_POINTER)
    if (at < 0) continue
    const fromGlyph = line.slice(at + E2E_TREE_POINTER.length)
    if (!TREE_GLYPH_AFTER_POINTER.test(fromGlyph)) continue
    rows.push(fromGlyph.trimEnd())
  }
  return rows
}

/** The one selected tree row, or null when none or more than one is marked. */
function selectedTreeRow(pane: string): string | null {
  const rows = selectedTreeRows(pane)
  return rows.length === 1 ? rows[0]! : null
}

/**
 * The prompt's input box rule - the full-width line drawn immediately above and
 * below the line being typed into.
 */
const PROMPT_BOX_RULE = /^\u2500{20,}\s*$/

/**
 * What the prompt's input line currently holds, or null when the input box is
 * not on screen at all (a dialog drawn over the prompt replaces it).
 *
 * The pointer alone cannot find it: a SUBMITTED user message is drawn with the
 * same `\u276F` in the transcript above, and a selected tree row draws it too
 * (see `selectedTreeRows`). The box is what tells them apart - only the live
 * input line sits directly under the rule - so this reads the pane's structure
 * rather than the prompt's padding, and an empty input comes back as `''`
 * instead of being confused with "no input box".
 */
function promptInputLine(pane: string): string | null {
  const lines = pane.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith(E2E_TREE_POINTER)) continue
    if (!PROMPT_BOX_RULE.test(lines[i - 1]!)) continue
    return line.slice(E2E_TREE_POINTER.length).trim()
  }
  return null
}

/**
 * Column at which a teammate's TREE row starts - the tree glyph, past the
 * panel's padding and the selection cell - or -1 when the row is not drawn.
 *
 * The column IS the nesting: `TeammateSpinnerTree` wraps a row of a sub-team in
 * `paddingLeft={(getTeamDepth(team) - 1) * 2}`, so a sub-team member's glyph
 * sits strictly right of its sub-lead's. Read from the pane rather than
 * compared against a hard-coded prefix, so the indent WIDTH is free to change
 * and only the nesting is asserted.
 *
 * Keyed on `@name:` - the row draws `@{agentName}: {status}` - which is what
 * keeps a footer pill (`@name`, no colon) and the view header from matching.
 */
function treeRowColumn(pane: string, agentName: string): number {
  const row = new RegExp(
    `[\\u2552\\u255E\\u2558\\u250C\\u251C\\u2514][\\u2550\\u2500] @${agentName}:`,
  )
  for (const line of pane.split('\n')) {
    const found = row.exec(line)
    if (found) return found.index
  }
  return -1
}

type FakeAnthropicApi = {
  baseUrl: string
  /** Main-loop turns served (the tool_use turn and the tool_result turn). */
  mainTurns: () => number
  /**
   * Every `/v1/messages` request served, in order.
   *
   * This is what a scenario asserts its script on ("the per-role counters match
   * the script") and what a failing scenario prints into its `actual`, so a red
   * run says WHICH request went where instead of needing a second run to find
   * out.
   */
  requests: () => readonly FakeRequest[]
  stop: () => void
}

type FakeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/**
 * Which conversation a request came from: the lead's main loop, or an
 * in-process teammate's own turn. Both hit this ONE fake - a teammate runs in
 * the same process against the same client and the same ANTHROPIC_BASE_URL - so
 * a scenario that scripts both has to tell them apart (see `classifyRole`).
 */
type FakeRole = 'lead' | 'teammate'

/** One scripted response: the single content block to answer with, and how that turn ends. */
type FakeStep = { block: FakeContentBlock; stopReason: 'tool_use' | 'end_turn' }

/**
 * What the fake answers for ONE scenario, per role.
 *
 * A request that carries the main tool set consumes its role's NEXT step; past
 * the end of a role's script the default `text: 'ok'` answers instead, so a
 * late housekeeping turn ends a conversation rather than failing a scenario.
 * The two roles advance independently, which is what makes a lead turn and a
 * teammate turn interleaving in wall-clock order harmless.
 */
type FakeScript = { lead: FakeStep[]; teammate?: FakeStep[] }

/**
 * One served request, as the log records it.
 *
 * `step` is the 1-based script step the request consumed. On a `skipped`
 * request - one carrying no main tool set, or arriving after its role's script
 * ran out - it is instead how many steps that role had consumed by then, and
 * nothing advanced.
 */
type FakeRequest = {
  role: FakeRole
  step: number
  kind: 'tool_use' | 'text' | 'skipped'
  name?: string
}

/**
 * The half of a `/v1/messages` body this fake reads.
 *
 * `system` is the array of blocks the client sends (src/services/api sends
 * `system: [{type:'text', text}]`) and is what tells the two roles apart. A
 * message's `content` is either a plain string - which is what the CLI's side
 * calls send - or an array of blocks; the type carries both so a future
 * assertion on message content cannot be written against the wrong one.
 */
type FakeRequestBody = {
  model?: string
  stream?: boolean
  system?: Array<{ type: string; text: string }>
  messages?: Array<{
    role: string
    content: string | Array<{ type?: string; text?: string }>
  }>
  tools?: Array<{ name: string }>
}

/**
 * The heading of the teammate system-prompt addendum
 * (`src/utils/swarm/teammatePromptAddendum.ts:9`), appended to a teammate's
 * system prompt and to nothing else.
 */
const TEAMMATE_SYSTEM_MARKER = '# Agent Teammate Communication'
/**
 * Lead or teammate, decided from the request body alone.
 *
 * Named and pure so the rule is one readable thing rather than a condition
 * buried in the handler: a request is a TEAMMATE's iff its system prompt
 * carries the teammate addendum. Everything else - the main loop, and every
 * side call the CLI makes - is the lead's.
 *
 * A second signal was tried and REJECTED on evidence: "the last user message
 * contains `<teammate-message`". It misclassifies the LEAD, because the LEAD's
 * own inbox poller wraps an incoming message in that tag before submitting it
 * into the lead's turn (`src/hooks/useInboxPoller.ts:866` and `:970`; the same
 * wrapping in `formatTeammateMessages`, `src/utils/teammateMailbox.ts:386`) -
 * and a teammate's idle notification is delivered to the lead. The tag is
 * therefore written for whoever RECEIVES the message, lead included; it is NOT
 * a teammate marker. (`formatAsTeammateMessage`,
 * `src/utils/swarm/inProcessRunner.ts:583-592`, is the teammate-side twin: all
 * three of its call sites - `:1856`, `:1892`, `:2214` - build a TEAMMATE's
 * prompt, so it is not what puts the tag in front of the lead.) Observed
 * directly while building scenario 5: a request with 34 tools, the lead's model
 * and NO addendum, carrying `<teammate-message teammate_id="supervisor-one">`.
 * Reading that as a teammate turn would serve the lead a teammate's script
 * step. The addendum is
 * appended to every in-process teammate's system prompt
 * (`inProcessRunner.ts:2124`) except one this harness never uses
 * (`systemPromptMode: 'replace'`), so it is both sufficient and safe here.
 */
function classifyRole(body: FakeRequestBody): FakeRole {
  for (const block of body.system ?? []) {
    if (block?.text?.includes(TEAMMATE_SYSTEM_MARKER) === true) return 'teammate'
  }
  return 'lead'
}

/** The tool whose presence marks the MAIN tool set. Also the tool the scripts spawn with. */
const E2E_AGENT_TOOL = 'Agent'

/**
 * Does this request carry the main tool set - i.e. is it a turn of a
 * conversation, rather than a side call?
 *
 * The guard that keeps the step counters honest. The old rule was stateless
 * (`last message has a tool_result`), so any extra `/v1/messages` call the CLI
 * makes - a topic or title classifier, a quota probe, a haiku-model helper -
 * fell harmlessly into the `text: 'ok'` default. A step counter without this
 * guard would let such a call EAT a scripted step and desynchronise the rest of
 * the scenario. The main loop and a teammate's turn both ship the Agent tool; a
 * classifier ships no tools at all.
 */
function carriesMainToolSet(body: FakeRequestBody): boolean {
  return body.tools?.some(tool => tool.name === E2E_AGENT_TOOL) === true
}

/**
 * The steps one role actually consumed, as `<step>:<kind>[:<tool>]`.
 *
 * Skipped requests are left out on purpose: they advance nothing, and how many
 * of them the CLI makes is not something a scenario should pin.
 */
function consumedSteps(api: FakeAnthropicApi, role: FakeRole): string[] {
  return api
    .requests()
    .filter(entry => entry.role === role && entry.kind !== 'skipped')
    .map(entry => `${entry.step}:${entry.kind}${entry.name === undefined ? '' : `:${entry.name}`}`)
}

/**
 * The same shape derived from the SCRIPT, so the expectation cannot drift from
 * what the scenario actually scripted.
 *
 * A role can never consume more than its script holds (past the end every
 * request is `skipped`), so comparing the two is exactly "the whole script was
 * consumed, in order".
 */
function scriptedSteps(steps: FakeStep[]): string[] {
  return steps.map(
    (step, index) =>
      `${index + 1}:${step.block.type}${step.block.type === 'tool_use' ? `:${step.block.name}` : ''}`,
  )
}

/** The whole request log on one line, for a failing scenario's `actual`. */
function formatRequestLog(api: FakeAnthropicApi): string {
  const served = api
    .requests()
    .map(entry => `${entry.role}#${entry.step}:${entry.kind}${entry.name === undefined ? '' : `:${entry.name}`}`)
    .join(' ')
  return served === '' ? 'the fake served no /v1/messages request at all' : `fake saw: ${served}`
}

function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

/** One complete SSE stream for a single-block assistant message. */
function fakeMessageStream(
  id: string,
  model: string,
  block: FakeContentBlock,
  stopReason: 'tool_use' | 'end_turn',
): string {
  const usage = { input_tokens: 10, output_tokens: 20 }
  const start = sseEvent('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1 },
    },
  })
  const blockEvents =
    block.type === 'text'
      ? sseEvent('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        }) +
        sseEvent('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: block.text },
        })
      : sseEvent('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        }) +
        sseEvent('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        })
  return (
    start +
    blockEvents +
    sseEvent('content_block_stop', { index: 0 }) +
    sseEvent('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }) +
    sseEvent('message_stop', {})
  )
}

/**
 * The fake Messages API, driven by one scenario's per-role script.
 *
 * Statelessness was the old design: "the last message has a tool_result" and a
 * single `spawnIssued` flag were enough while exactly one conversation (the
 * lead's) ever reached it. A teammate that takes a turn of its own hits the
 * SAME server, so the fake now keeps one step counter per ROLE and answers
 * whatever that role's script says next - which is what lets scenario 5 script
 * a lead spawning a sub-lead and that sub-lead building its own sub-team.
 */
function startFakeAnthropicApi(script: FakeScript): FakeAnthropicApi {
  let mainTurns = 0
  let nextId = 1
  const consumed: Record<FakeRole, number> = { lead: 0, teammate: 0 }
  const log: FakeRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 10 })
      }
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
        const body = (await request.json()) as FakeRequestBody
        const role = classifyRole(body)
        // Only a real turn may advance a counter (see `carriesMainToolSet`):
        // a side call is served the default text and logged as `skipped`.
        const roleScript = role === 'lead' ? script.lead : script.teammate ?? []
        const step = carriesMainToolSet(body) ? roleScript[consumed[role]] : undefined
        let block: FakeContentBlock
        let stopReason: 'tool_use' | 'end_turn' = 'end_turn'
        if (step) {
          consumed[role] += 1
          // The lead's conversation IS the main loop, so its scripted steps are
          // the main turns scenario 4 counts - the same arithmetic the
          // tool_use/tool_result pair produced before there were roles.
          if (role === 'lead') mainTurns++
          block = step.block
          stopReason = step.stopReason
          log.push({
            role,
            step: consumed[role],
            kind: block.type,
            ...(block.type === 'tool_use' && { name: block.name }),
          })
        } else {
          block = { type: 'text', text: 'ok' }
          log.push({ role, step: consumed[role], kind: 'skipped' })
        }
        const id = `msg_e2e_${nextId++}`
        const model = body.model ?? 'e2e-model'
        const headers = { 'request-id': `req_e2e_${id}` }
        if (body.stream) {
          return new Response(fakeMessageStream(id, model, block, stopReason), {
            headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          })
        }
        return Response.json(
          {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [block],
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 20 },
          },
          { headers },
        )
      }
      return Response.json(
        {
          type: 'error',
          error: { type: 'not_found_error', message: `fake API: no route for ${request.method} ${url.pathname}` },
        },
        { status: 404 },
      )
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    mainTurns: () => mainTurns,
    requests: () => log,
    stop: () => {
      server.stop(true)
    },
  }
}

/**
 * Scenario 4's script, unchanged in every byte the CLI can see: the first main
 * turn spawns `supervisor` into `e2e-team` with NO prompt - an idle spawn, so
 * the Agent tool routes it in-process - and the turn carrying that tool's
 * tool_result ends with a short text. Same tool_use id, same strings, same two
 * main turns as before roles existed; only the mechanism that picks them moved
 * out of the handler and into this table.
 */
const E2E_IDLE_SPAWN_SCRIPT: FakeScript = {
  lead: [
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_spawn',
        name: E2E_AGENT_TOOL,
        // No `prompt`: an idle spawn, routed in-process by the Agent tool.
        input: { description: 'idle supervisor', name: E2E_TEAMMATE, team_name: E2E_TEAM },
      },
      stopReason: 'tool_use',
    },
    {
      block: { type: 'text', text: `Spawned ${E2E_TEAMMATE}; it is idle and waiting for work.` },
      stopReason: 'end_turn',
    },
  ],
}

async function scenarioTeammateViewEscape(): Promise<ScenarioResult> {
  const name =
    'Scenario 4 (teammate view): the teammates panel is visible with zero teammates, and Escape returns from an idle @supervisor view without killing the teammate'
  const expected = `the teammates panel visible BEFORE the spawn (its "team-lead" row and its "no teammates" line), then "${E2E_TEAMMATE_HEADER}" gone and the prompt back after one Escape, with the @${E2E_TEAMMATE} row still shown`
  const fail = (actual: string, pane: string): ScenarioResult => ({
    name,
    passed: false,
    expected,
    actual,
    rows: [],
    pane,
  })
  const api = startFakeAnthropicApi(E2E_IDLE_SPAWN_SCRIPT)
  await startCliSession({
    // No teams flag: Agent Teams are on by default, and this scenario is
    // also the check that the default path really exposes the Agent tool's
    // `name` parameter.
    extraEnv: {
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_API_KEY: FAKE_API_KEY,
    },
    // Pre-approve the env key so no "use this API key?" dialog precedes the
    // prompt. Both the raw key and its 20-char tail are listed so the check
    // passes whichever normalisation the config layer applies.
    extraGlobalConfig: {
      customApiKeyResponses: { approved: [FAKE_API_KEY, FAKE_API_KEY.slice(-20)], rejected: [] },
    },
  })
  try {
    // BEFORE anything spawns: the panel is up at its real default with zero
    // teammates. Nothing in the seeded config touches the toggle, so this is
    // the shipped default path - the one behaviour the panel exists for, and
    // the one no other scenario can observe once a teammate is alive.
    const panelAtBoot = await waitForPane(
      `scenario 4: the teammates panel at boot - "${E2E_TREE_LEADER_ROW}" over "${E2E_TREE_EMPTY_ROW}"`,
      pane => pane.includes(E2E_TREE_LEADER_ROW) && pane.includes(E2E_TREE_EMPTY_ROW),
      UI_TIMEOUT_MS,
    )
    if (!panelAtBoot.ok) {
      return fail(
        `the teammates panel was not visible with zero teammates before the spawn (leader row: ${
          panelAtBoot.pane.includes(E2E_TREE_LEADER_ROW) ? 'present' : 'MISSING'
        }, empty state: ${panelAtBoot.pane.includes(E2E_TREE_EMPTY_ROW) ? 'present' : 'MISSING'})`,
        panelAtBoot.pane,
      )
    }

    tmux('send-keys', '-t', CLI_WINDOW, 'spawn an idle supervisor teammate', 'Enter')
    // With a teammate alive the footer hint changes from "? for shortcuts" to
    // "shift + ↓ to expand", so the turn's end is read from the scripted final
    // text instead, plus the spinner's "esc to interrupt" being gone.
    const spawned = await waitForPane(
      `scenario 4: the @${E2E_TEAMMATE} pill and the scripted "Spawned ${E2E_TEAMMATE}" text, with the turn over`,
      pane =>
        pane.includes(`@${E2E_TEAMMATE}`) &&
        pane.includes(`Spawned ${E2E_TEAMMATE}`) &&
        api.mainTurns() >= 2 &&
        !pane.includes('esc to interrupt'),
      UI_TIMEOUT_MS,
    )
    if (!spawned.ok) {
      return fail(`the idle teammate was not spawned (fake API served ${api.mainTurns()} main turn(s))`, spawned.pane)
    }

    // ONE Shift+Down, not two. `stepTeammateSelection`
    // (src/hooks/useBackgroundTaskNavigation.ts:36-43) spends a first press
    // expanding a COLLAPSED tree onto the leader row; the panel above is
    // already expanded, so that branch is skipped and this press moves the
    // selection straight to the teammate. Enter opens its transcript view.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'Enter')
    const viewing = await waitForPane(
      `scenario 4: "${E2E_TEAMMATE_HEADER}" after Shift+Down, Enter`,
      pane => pane.includes(E2E_TEAMMATE_HEADER),
      UI_TIMEOUT_MS,
    )
    if (!viewing.ok) return fail('the teammate view never opened', viewing.pane)

    tmux('send-keys', '-t', CLI_WINDOW, 'Escape')
    const returned = await waitForPane(
      'scenario 4: the leader view back after one Escape',
      pane => !pane.includes(E2E_TEAMMATE_HEADER),
      UI_TIMEOUT_MS,
    )
    const stillAlive = returned.pane.includes(`@${E2E_TEAMMATE}`)
    const actual = !returned.ok
      ? `still "${E2E_TEAMMATE_HEADER}" ${UI_TIMEOUT_MS}ms after Escape (the pre-fix behaviour)`
      : stillAlive
        ? 'the panel was visible with zero teammates before the spawn; returned to the leader view, and the teammate row/pill is still shown'
        : 'returned to the leader view, but the teammate row/pill is gone (Escape killed it)'
    return { name, passed: returned.ok && stillAlive, expected, actual, rows: [], pane: returned.pane }
  } finally {
    await stopCliSession()
    api.stop()
  }
}

/** The sub-lead the lead spawns, and the worker that sub-lead spawns into its own sub-team. */
const E2E_SUB_LEAD = 'supervisor-one'
const E2E_SUB_WORKER = 'worker-one'
/**
 * The team a teammate may create for itself: `<its team>/<its name>`, the only
 * name TeamCreate accepts from a teammate (`TeamCreateTool.ts:143-156`).
 */
const E2E_SUB_TEAM = `${E2E_TEAM}/${E2E_SUB_LEAD}`
/** The view header names a teammate by its path down the tree, one `›` per level. */
const E2E_SUB_LEAD_HEADER = `Viewing team-lead › ${E2E_SUB_LEAD}`
const E2E_SUB_WORKER_HEADER = `${E2E_SUB_LEAD_HEADER} › ${E2E_SUB_WORKER}`

/**
 * How many times scenario 5 will dismiss whatever the final Escape left drawn
 * over the prompt before it gives up and fails on it, and how long each attempt
 * lets the view-exit render settle first.
 */
const PROMPT_RESTORE_ATTEMPTS = 3
const PROMPT_RESTORE_SETTLE_MS = 400

/**
 * Scenario 5's script - the first one that answers BOTH roles.
 *
 * The lead spawns `supervisor-one` WITH a prompt, so it takes a turn at once
 * instead of parking idle, and that turn creates its own sub-team. The member
 * of that sub-team is then spawned by the LEAD, on a second prompt, with an
 * explicit `team_name`.
 *
 * WHY THE LEAD AND NOT THE SUB-LEAD. The shape this scenario was written for -
 * `supervisor-one` spawning `worker-one` itself - runs to completion but draws
 * NOTHING: the teammate really is spawned and really does start (it reports
 * itself idle over the team mailbox), yet it never gets a row, a pill, or a
 * selectable entry, because a tool running inside a teammate's turn is handed
 * an isolated no-op `setAppState` and that is the callback the spawn registers
 * its task through. Chain, verified at this commit:
 * `inProcessRunner.ts:2500` runs the turn with `isAsync: true` →
 * `runAgent.ts:758` passes `shareSetAppState: !isAsync` →
 * `forkedAgent.ts:421-423` substitutes `() => {}` →
 * `spawnInProcess.ts:124,:224` registers through it. The escape hatch that
 * exists for exactly this (`setAppStateForTasks`, `forkedAgent.ts:426-428` -
 * "Task registration/kill must always reach the root store, even when
 * setAppState is a no-op") is not on `SpawnContext` (`spawnInProcess.ts:66`).
 * The tree is not at fault and this scenario proves it: spawned by the lead,
 * the very same sub-team member is drawn indented under its sub-lead. Restoring
 * the intended shape is a two-step script edit once that gap is fixed - drop
 * the lead's steps 3-4 and give the teammate `Agent { name: worker-one }` with
 * no `team_name`.
 */
const E2E_NESTED_TREE_SCRIPT: FakeScript = {
  lead: [
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_spawn_sub_lead',
        name: E2E_AGENT_TOOL,
        input: {
          description: 'lead a sub-team',
          name: E2E_SUB_LEAD,
          team_name: E2E_TEAM,
          prompt: 'Create your sub-team',
        },
      },
      stopReason: 'tool_use',
    },
    { block: { type: 'text', text: `Spawned ${E2E_SUB_LEAD}` }, stopReason: 'end_turn' },
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_spawn_worker',
        name: E2E_AGENT_TOOL,
        // No prompt: an idle spawn. `team_name` is the sub-team the teammate
        // created in its own turn, which is what puts this row one level down.
        input: { description: 'idle worker', name: E2E_SUB_WORKER, team_name: E2E_SUB_TEAM },
      },
      stopReason: 'tool_use',
    },
    { block: { type: 'text', text: `Spawned ${E2E_SUB_WORKER}` }, stopReason: 'end_turn' },
  ],
  teammate: [
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_sub_team',
        name: 'TeamCreate',
        // The only name TeamCreate accepts from a teammate: its own
        // `<its team>/<its name>` (`TeamCreateTool.ts:143-156`).
        input: { team_name: E2E_SUB_TEAM },
      },
      stopReason: 'tool_use',
    },
    { block: { type: 'text', text: 'sub-team ready' }, stopReason: 'end_turn' },
  ],
}

/**
 * Scenario 5 - the nested teammates tree: a sub-team member is drawn INDENTED
 * under the sub-lead whose team it belongs to, and both rows are reachable by
 * key, the deeper one naming its whole path in the view header.
 *
 * It is the first scenario in which a TEAMMATE takes a turn, which is the whole
 * reason the fake grew per-role scripts: `supervisor-one` runs in this same
 * process against the same client and the same ANTHROPIC_BASE_URL, so its
 * requests and the lead's arrive at one server and are told apart by
 * `classifyRole`.
 *
 * It walks DOWN only. Shift+Up is bound to `chat:messageActions` in the Chat
 * context (`src/keybindings/defaultBindings.ts:88-90`) and never reaches
 * `useBackgroundTaskNavigation`, so in a real terminal today the leader row's
 * own `shift + ↑/↓ to select` hint is half true: Shift+Down steps, Shift+Up
 * does nothing. Measured three times in three different selection states while
 * building this scenario. Asserting the walk up would pin that defect as
 * correct, so the scenario reaches both rows the way a user actually can - one
 * Shift+Down at a time, Escape between them (Escape leaves the view but keeps
 * the selection, so the next Shift+Down carries on from where the last one
 * stopped).
 */
async function scenarioNestedTeamTree(): Promise<ScenarioResult> {
  const name =
    'Scenario 5 (nested tree): a sub-team member is drawn indented under its sub-lead, and Shift+Down + Enter opens first the sub-lead and then the deeper row, whose header names the whole path'
  const expected = `one capture holding "${E2E_TREE_LEADER_ROW}", @${E2E_SUB_LEAD} and @${E2E_SUB_WORKER} indented under it, then "${E2E_SUB_LEAD_HEADER}" and "${E2E_SUB_WORKER_HEADER}" opened by Shift+Down + Enter, with the fake's per-role counters matching the script`
  const fail = (actual: string, pane: string): ScenarioResult => ({
    name,
    passed: false,
    expected,
    actual,
    rows: [],
    pane,
  })
  const api = startFakeAnthropicApi(E2E_NESTED_TREE_SCRIPT)
  await startCliSession({
    extraEnv: {
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_API_KEY: FAKE_API_KEY,
    },
    extraGlobalConfig: {
      customApiKeyResponses: { approved: [FAKE_API_KEY, FAKE_API_KEY.slice(-20)], rejected: [] },
      // The one seed this scenario needs, and it does not touch the panel.
      // The harness runs the CLI INSIDE a tmux pane, where `auto` routes a
      // PROMPTED spawn to the pane backend (`backends/registry.ts:380-382`) -
      // and a pane teammate is refused a sub-team outright, because nothing
      // would deliver its sub-team's messages or hand out its task list
      // (`TeamCreateTool.ts:136-140`). Without this the scenario would not be
      // testing the nested tree at all; it would be testing that refusal.
      teammateMode: 'in-process',
    },
  })
  try {
    tmux('send-keys', '-t', CLI_WINDOW, 'spawn supervisor-one to build its own sub-team', 'Enter')
    // Both turns finished: the sub-lead has a row, its own script is spent (so
    // TeamCreate has already returned and the sub-team exists), and the prompt
    // is idle again. That is ALL this gate proves. Submitting does not empty the
    // input box, so being idle is not being empty - the second prompt is given
    // an empty input explicitly, below.
    const subTeamReady = await waitForPane(
      `scenario 5: @${E2E_SUB_LEAD} spawned and its sub-team created`,
      pane =>
        treeRowColumn(pane, E2E_SUB_LEAD) >= 0 &&
        consumedSteps(api, 'teammate').length >= 2 &&
        !pane.includes('esc to interrupt'),
      UI_TIMEOUT_MS,
    )
    if (!subTeamReady.ok) {
      return fail(
        `the sub-lead never created its sub-team (@${E2E_SUB_LEAD} column: ${treeRowColumn(
          subTeamReady.pane,
          E2E_SUB_LEAD,
        )}; ${formatRequestLog(api)})`,
        subTeamReady.pane,
      )
    }

    // A submitted prompt STAYS in the input box - captured here while building
    // this scenario, the box still read `spawn supervisor-one to build its own
    // sub-team` a full turn after that prompt was answered. Typed straight on
    // top of it, the next prompt would be submitted as the two concatenated
    // (`...sub-teamadd worker-one...`), which is what this scenario used to do.
    // Ctrl+U is the input's kill-to-line-start key (`useTextInput.ts:672-680`),
    // and the wait after it is what makes "the second prompt lands in an EMPTY
    // input" a property this scenario CHECKS rather than one it assumes.
    tmux('send-keys', '-t', CLI_WINDOW, 'C-u')
    const inputCleared = await waitForPane(
      'scenario 5: an empty prompt input after Ctrl+U, before the second prompt',
      pane => promptInputLine(pane) === '',
      UI_TIMEOUT_MS,
    )
    if (!inputCleared.ok) {
      return fail(
        `Ctrl+U did not clear the input (it holds ${
          promptInputLine(inputCleared.pane) === null
            ? 'NO INPUT BOX'
            : `"${promptInputLine(inputCleared.pane)}"`
        })`,
        inputCleared.pane,
      )
    }

    tmux('send-keys', '-t', CLI_WINDOW, `add ${E2E_SUB_WORKER} to that sub-team`, 'Enter')

    // ONE capture, all three rows: the nesting is a property of a single frame.
    // @worker-one's glyph must sit strictly right of @supervisor-one's - the
    // column, not a hard-coded prefix, so the indent width stays free to change
    // and only the nesting itself is asserted.
    const tree = await waitForPane(
      `scenario 5: the nested tree - "${E2E_TREE_LEADER_ROW}" over @${E2E_SUB_LEAD} over an indented @${E2E_SUB_WORKER}`,
      pane =>
        pane.includes(E2E_TREE_LEADER_ROW) &&
        treeRowColumn(pane, E2E_SUB_LEAD) >= 0 &&
        treeRowColumn(pane, E2E_SUB_WORKER) > treeRowColumn(pane, E2E_SUB_LEAD),
      UI_TIMEOUT_MS,
    )
    if (!tree.ok) {
      return fail(
        `the nested tree never rendered (leader row: ${
          tree.pane.includes(E2E_TREE_LEADER_ROW) ? 'present' : 'MISSING'
        }, @${E2E_SUB_LEAD} column: ${treeRowColumn(tree.pane, E2E_SUB_LEAD)}, @${E2E_SUB_WORKER} column: ${treeRowColumn(
          tree.pane,
          E2E_SUB_WORKER,
        )}; ${formatRequestLog(api)})`,
        tree.pane,
      )
    }

    // One Shift+Down: the selectable rows are leader → the two teammates in
    // depth-first order → hide, and an untouched selection steps from the
    // leader (`stepOver`, `teammateSelection.ts:164-173`), so this lands on the
    // sub-lead. Its header is a PREFIX of the deeper row's, so it is asserted
    // together with the deeper one being absent.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'Enter')
    const viewingSubLead = await waitForPane(
      `scenario 5: "${E2E_SUB_LEAD_HEADER}" (and not the deeper row's) after Shift+Down, Enter`,
      pane => pane.includes(E2E_SUB_LEAD_HEADER) && !pane.includes(E2E_SUB_WORKER_HEADER),
      UI_TIMEOUT_MS,
    )
    if (!viewingSubLead.ok) {
      return fail(
        `the sub-lead's view never opened (selected row: ${selectedTreeRow(viewingSubLead.pane) ?? 'NONE'})`,
        viewingSubLead.pane,
      )
    }

    tmux('send-keys', '-t', CLI_WINDOW, 'Escape')
    const leftSubLead = await waitForPane(
      `scenario 5: the leader view back after Escape from @${E2E_SUB_LEAD}`,
      pane => !pane.includes(E2E_SUB_LEAD_HEADER),
      UI_TIMEOUT_MS,
    )
    if (!leftSubLead.ok) return fail(`Escape did not leave "${E2E_SUB_LEAD_HEADER}"`, leftSubLead.pane)

    // Escape kept the selection, so this second Shift+Down carries on from the
    // sub-lead into its sub-team. The header now names the whole path down the
    // tree, which is the thing a bare handle could not tell apart.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'Enter')
    const viewingWorker = await waitForPane(
      `scenario 5: "${E2E_SUB_WORKER_HEADER}" after a second Shift+Down, Enter`,
      pane => pane.includes(E2E_SUB_WORKER_HEADER),
      UI_TIMEOUT_MS,
    )
    if (!viewingWorker.ok) {
      return fail(
        `the sub-team member's view never opened (selected row: ${selectedTreeRow(viewingWorker.pane) ?? 'NONE'})`,
        viewingWorker.pane,
      )
    }

    tmux('send-keys', '-t', CLI_WINDOW, 'Escape')
    const returned = await waitForPane(
      `scenario 5: the leader view back after Escape from @${E2E_SUB_WORKER}`,
      pane => !pane.includes(E2E_SUB_WORKER_HEADER),
      UI_TIMEOUT_MS,
    )
    if (!returned.ok) return fail(`Escape did not leave "${E2E_SUB_WORKER_HEADER}"`, returned.pane)

    // The header being gone is NOT the prompt being back, and this scenario used
    // to end on exactly that gap: the Escape above can reach the prompt as well
    // as the view, and Escape at the prompt opens the Rewind dialog
    // (`MessageSelector.tsx:347`) - a modal that REPLACES the input box while
    // leaving the leader view visible behind it, so `!includes(header)` is
    // satisfied by it. Whether it appears depends on how the view-exit render
    // interleaves with the keys before it (observed both ways while building
    // this), so it is DISMISSED when present rather than asserted - pinning the
    // stray Escape would make fixing it read as a regression here. The end state
    // is what gets asserted, and the input box is the one thing a dialog cannot
    // fake.
    for (let attempt = 0; attempt < PROMPT_RESTORE_ATTEMPTS; attempt++) {
      await sleep(PROMPT_RESTORE_SETTLE_MS)
      if (promptInputLine(capturePane()) !== null) break
      tmux('send-keys', '-t', CLI_WINDOW, 'Escape')
    }
    const atPrompt = await waitForPane(
      'scenario 5: the prompt input box back, with no dialog drawn over it',
      pane => promptInputLine(pane) !== null,
      UI_TIMEOUT_MS,
    )
    if (!atPrompt.ok) {
      return fail('the prompt never came back - a dialog is still drawn over the input box', atPrompt.pane)
    }

    // Both scripts consumed in full, in order. A role can never consume more
    // steps than its script holds, so this is exactly "every scripted step was
    // served to the role it was written for" - the per-role counters.
    const leadSteps = consumedSteps(api, 'lead').join(' ')
    const teammateSteps = consumedSteps(api, 'teammate').join(' ')
    const wantedLead = scriptedSteps(E2E_NESTED_TREE_SCRIPT.lead).join(' ')
    const wantedTeammate = scriptedSteps(E2E_NESTED_TREE_SCRIPT.teammate ?? []).join(' ')
    const countersMatch = leadSteps === wantedLead && teammateSteps === wantedTeammate
    const actual = countersMatch
      ? `all three rows in one capture with @${E2E_SUB_WORKER} indented under @${E2E_SUB_LEAD}; both headers opened and left by key; ${formatRequestLog(api)}`
      : `the tree and both headers were right, but the fake's per-role counters did not match the script (lead: "${leadSteps}" vs "${wantedLead}", teammate: "${teammateSteps}" vs "${wantedTeammate}"; ${formatRequestLog(api)})`
    return { name, passed: countersMatch, expected, actual, rows: [], pane: atPrompt.pane }
  } finally {
    await stopCliSession()
    api.stop()
  }
}
/**
 * Scenario 6's two idle teammates. The names are the roles they play, and the
 * order matters: a team's members are sorted by name
 * (`orderTeammatesDepthFirst`), so `doomed` is the FIRST row and `survivor` the
 * second - the shape the nearest-survivor rule is written for.
 */
const E2E_KILL_TARGET = 'doomed'
const E2E_KILL_SURVIVOR = 'survivor'

/**
 * The selected `doomed` row once it has been killed, as
 * `TeammateSpinnerLine` draws it: the highlighted tree glyph `╞═`
 * (`:97` - `╘═` is only for the LAST row, and in selection mode no row is
 * last), the `@name`, and the terminal word that replaces the activity
 * (`:196`). Everything from the pointer leftwards is padding, and everything
 * past `killed` is the stats block, so this is asserted as a prefix.
 *
 * Derived from a real capture, like every other literal here, and spelled with
 * escapes so an editor round-trip cannot quietly turn `╞═` into `|=`.
 */
const E2E_TREE_KILLED_SELECTED_ROW = `\u255E\u2550 @${E2E_KILL_TARGET}: killed`

/** How long a killed row is given to prove it LINGERS rather than merely existing for one frame. */
const GRACE_PROBE_MS = 2_000

/** Two idle teammates in one turn, so one can be killed while the other stays alive. */
const E2E_TWO_TEAMMATES_SCRIPT: FakeScript = {
  lead: [
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_spawn_doomed',
        name: E2E_AGENT_TOOL,
        input: { description: 'idle teammate', name: E2E_KILL_TARGET, team_name: E2E_TEAM },
      },
      stopReason: 'tool_use',
    },
    {
      block: {
        type: 'tool_use',
        id: 'toolu_e2e_spawn_survivor',
        name: E2E_AGENT_TOOL,
        input: { description: 'idle teammate', name: E2E_KILL_SURVIVOR, team_name: E2E_TEAM },
      },
      stopReason: 'tool_use',
    },
    {
      block: { type: 'text', text: `Spawned ${E2E_KILL_TARGET} and ${E2E_KILL_SURVIVOR}` },
      stopReason: 'end_turn',
    },
  ],
}

/**
 * Scenario 6 - the panel is a PANEL: it is reachable with no teammates at all,
 * a hidden one stays hidden until the user asks for it, and a row that dies
 * under the cursor keeps both its place and the cursor.
 *
 * This is the only scenario that boots with the toggle OFF, and the seed is
 * deliberate rather than convenient: the branch under test is
 * `stepTeammateSelection`'s first-press-expands-a-collapsed-tree
 * (`useBackgroundTaskNavigation.ts:43-50`), which no scenario can reach from
 * the shipped default. Every OTHER scenario boots at the default, on.
 *
 * The order of the steps is forced by one product rule: Shift+Down is handed to
 * the tree only when a teammate is alive OR the panel is already expanded
 * (`useBackgroundTaskNavigation.ts:219-226`), so with a collapsed panel and no
 * teammates the press belongs to the background-tasks dialog and CANNOT expand
 * the panel. The empty state is therefore reached the way a user reaches it
 * with nothing spawned - ctrl+t, which cycles none → tasks → teammates → none
 * (`nextExpandedView`) - and the expand-from-collapsed press comes later, once
 * the teammates are alive.
 */
async function scenarioTreePersists(): Promise<ScenarioResult> {
  const name =
    'Scenario 6 (tree persists): a hidden panel stays hidden, ctrl+t reaches its empty state with no teammates, Shift+Down expands it onto the leader row, and a killed row keeps its place AND the highlight'
  const expected = `no panel at boot, then "${E2E_TREE_LEADER_ROW}" over "${E2E_TREE_EMPTY_ROW}" on ctrl+t, hidden again, then Shift+Down expanding onto the selected leader row and "${E2E_TREE_KILLED_SELECTED_ROW}" still selected and still on screen ${GRACE_PROBE_MS}ms after the kill, with @${E2E_KILL_SURVIVOR} alive beside it`
  const fail = (actual: string, pane: string): ScenarioResult => ({
    name,
    passed: false,
    expected,
    actual,
    rows: [],
    pane,
  })
  const api = startFakeAnthropicApi(E2E_TWO_TEAMMATES_SCRIPT)
  await startCliSession({
    extraEnv: {
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_API_KEY: FAKE_API_KEY,
    },
    extraGlobalConfig: {
      customApiKeyResponses: { approved: [FAKE_API_KEY, FAKE_API_KEY.slice(-20)], rejected: [] },
      // The ONE scenario that hides the panel, and only to test un-hiding it.
      // Never in the shared seed (`seedConfigDir`) and never in another
      // scenario: a seed that turns the feature under test off is how the
      // panel's own end-to-end coverage was lost once already.
      showSpinnerTree: false,
    },
  })
  try {
    // `startCliSession` has already waited for the prompt, so this capture is a
    // decided state rather than a race: an explicit hide survived startup.
    const atBoot = capturePane()
    if (atBoot.includes(E2E_TREE_LEADER_ROW)) {
      return fail('the panel was drawn at boot even though the config hid it', atBoot)
    }

    // Two presses: none → tasks → teammates. The panel draws its own empty
    // state, so this is reachable with nothing spawned - which is exactly the
    // state no other scenario can hold once a teammate is alive.
    tmux('send-keys', '-t', CLI_WINDOW, 'C-t')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'C-t')
    const emptyPanel = await waitForPane(
      `scenario 6: the empty panel after ctrl+t ×2 - "${E2E_TREE_LEADER_ROW}" over "${E2E_TREE_EMPTY_ROW}"`,
      pane => pane.includes(E2E_TREE_LEADER_ROW) && pane.includes(E2E_TREE_EMPTY_ROW),
      UI_TIMEOUT_MS,
    )
    if (!emptyPanel.ok) {
      return fail(
        `ctrl+t did not reach the panel's empty state (leader row: ${
          emptyPanel.pane.includes(E2E_TREE_LEADER_ROW) ? 'present' : 'MISSING'
        }, empty state: ${emptyPanel.pane.includes(E2E_TREE_EMPTY_ROW) ? 'present' : 'MISSING'})`,
        emptyPanel.pane,
      )
    }

    // Back to collapsed, so the Shift+Down below is the expand press.
    tmux('send-keys', '-t', CLI_WINDOW, 'C-t')
    const collapsed = await waitForPane(
      'scenario 6: the panel hidden again after a third ctrl+t',
      pane => !pane.includes(E2E_TREE_LEADER_ROW),
      UI_TIMEOUT_MS,
    )
    if (!collapsed.ok) return fail('ctrl+t did not collapse the panel again', collapsed.pane)

    tmux('send-keys', '-t', CLI_WINDOW, 'spawn two idle teammates', 'Enter')
    const spawned = await waitForPane(
      `scenario 6: @${E2E_KILL_TARGET} and @${E2E_KILL_SURVIVOR} spawned with the panel still hidden`,
      pane =>
        pane.includes(`Spawned ${E2E_KILL_TARGET} and ${E2E_KILL_SURVIVOR}`) &&
        api.mainTurns() >= 3 &&
        !pane.includes('esc to interrupt'),
      UI_TIMEOUT_MS,
    )
    if (!spawned.ok) {
      return fail(
        `the two idle teammates were not spawned (fake API served ${api.mainTurns()} main turn(s); ${formatRequestLog(api)})`,
        spawned.pane,
      )
    }
    if (spawned.pane.includes(E2E_TREE_LEADER_ROW)) {
      return fail('spawning a teammate re-opened the panel the user had hidden', spawned.pane)
    }

    // The branch this scenario exists for: from a COLLAPSED panel the first
    // Shift+Down expands the tree and parks on the leader - it does not step a
    // row. The pointer is what proves "selected"; `E2E_TREE_LEADER_ROW` alone
    // cannot, because the leader row is highlighted whenever no teammate
    // transcript is open and would read the same unselected.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    const expanded = await waitForPane(
      'scenario 6: the panel expanded by Shift+Down with the leader row selected',
      pane => selectedTreeRow(pane)?.startsWith(E2E_TREE_LEADER_ROW) === true,
      UI_TIMEOUT_MS,
    )
    if (!expanded.ok) {
      return fail(
        `Shift+Down did not expand the panel onto the selected leader row (selected rows: ${JSON.stringify(
          selectedTreeRows(expanded.pane),
        )})`,
        expanded.pane,
      )
    }

    // One more press moves onto the FIRST teammate row - the one about to die.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    const onTarget = await waitForPane(
      `scenario 6: the selection on @${E2E_KILL_TARGET}, the first teammate row`,
      pane => selectedTreeRow(pane)?.startsWith(`╞═ @${E2E_KILL_TARGET}:`) === true,
      UI_TIMEOUT_MS,
    )
    if (!onTarget.ok) {
      return fail(
        `the selection never reached @${E2E_KILL_TARGET} (selected rows: ${JSON.stringify(
          selectedTreeRows(onTarget.pane),
        )})`,
        onTarget.pane,
      )
    }

    // The half of the survivor rule that is pinnable without sleeping out the
    // 30s grace: the killed row does not vanish under the cursor. It keeps its
    // place, reads its terminal word, and the highlight is STILL on it - not
    // dangling on nothing, and not jumped onto the teammate that is still
    // alive. (The other half - where the highlight lands once the grace
    // expires and the row finally leaves - would cost a 30s sleep; see RISKS.)
    tmux('send-keys', '-t', CLI_WINDOW, 'k')
    const killed = await waitForPane(
      `scenario 6: "${E2E_TREE_KILLED_SELECTED_ROW}" still selected, with @${E2E_KILL_SURVIVOR} alive`,
      pane =>
        selectedTreeRow(pane)?.startsWith(E2E_TREE_KILLED_SELECTED_ROW) === true &&
        treeRowColumn(pane, E2E_KILL_SURVIVOR) >= 0,
      UI_TIMEOUT_MS,
    )
    if (!killed.ok) {
      return fail(
        `the killed row did not keep its place and its highlight (selected rows: ${JSON.stringify(
          selectedTreeRows(killed.pane),
        )}, @${E2E_KILL_SURVIVOR} column: ${treeRowColumn(killed.pane, E2E_KILL_SURVIVOR)})`,
        killed.pane,
      )
    }

    // It LINGERS: the same three facts a couple of seconds later, plus the
    // panel itself still on screen with its root row. Deliberately not the
    // full 30s - the grace has no env or config knob to shorten it, and a
    // half-minute sleep in an e2e run buys one boundary that unit tests
    // already own with a mocked clock.
    await sleep(GRACE_PROBE_MS)
    const lingering = capturePane()
    const stillSelected = selectedTreeRow(lingering)
    const passed =
      stillSelected?.startsWith(E2E_TREE_KILLED_SELECTED_ROW) === true &&
      treeRowColumn(lingering, E2E_KILL_SURVIVOR) >= 0 &&
      lingering.includes(E2E_TREE_LEADER_ROW)
    const actual = passed
      ? `the panel stayed hidden until asked for, ctrl+t reached its empty state, Shift+Down expanded it onto the selected leader row, and @${E2E_KILL_TARGET} still reads "killed" under the highlight ${GRACE_PROBE_MS}ms later with @${E2E_KILL_SURVIVOR} alive and the root row on screen`
      : `${GRACE_PROBE_MS}ms after the kill the tree was wrong (selected rows: ${JSON.stringify(
          selectedTreeRows(lingering),
        )}, @${E2E_KILL_SURVIVOR} column: ${treeRowColumn(lingering, E2E_KILL_SURVIVOR)}, root row: ${
          lingering.includes(E2E_TREE_LEADER_ROW) ? 'present' : 'MISSING'
        })`
    return { name, passed, expected, actual, rows: [], pane: lingering }
  } finally {
    await stopCliSession()
    api.stop()
  }
}

function report(results: ScenarioResult[]): void {
  for (const result of results) {
    console.log(`\n${'='.repeat(78)}`)
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`)
    console.log('  picker rows parsed from the pane:')
    console.log(formatRows(result.rows))
    console.log(`  expected: ${result.expected}`)
    console.log(`  actual:   ${result.actual}`)
    console.log(`${'-'.repeat(78)}\n${result.pane.replace(/\n+$/, '')}`)
  }
  const failed = results.filter(result => !result.passed)
  console.log(`\n${'='.repeat(78)}`)
  console.log(`${results.length - failed.length}/${results.length} scenarios passed`)
  for (const result of failed) {
    console.log(`  FAILED: ${result.name}`)
  }
}

/**
 * True once a teardown has started - by Ctrl-C or by reaching the end of a run.
 *
 * Two jobs. It stops a second Ctrl-C starting a second teardown: teardown never
 * yields (see `cleanupTempRoots`), so it cannot be re-entered mid-way, and the
 * guard covers the remaining window - a signal arriving during the `spawnSync`
 * of a teardown's own `kill-server`, which Node delivers as soon as that call
 * returns. And it makes a Ctrl-C landing during the NORMAL teardown a no-op:
 * both teardown paths set it as their FIRST statement and keep `onSigint`
 * registered until cleanup is done, so the handler absorbs the signal (it sees
 * the flag and returns) instead of Node's default action killing the process
 * mid-cleanup and leaving a run root plus a live private server behind.
 */
let tearingDown = false

/**
 * Ctrl-C: kill this run's private server, delete this run's temp roots, exit
 * 130.
 *
 * At module scope, not inside `main()`, so that BOTH teardown paths - `main()`'s
 * `finally` and the top-level rejection path - can hold the same handler
 * registered across their own cleanup and unhook it only afterwards.
 *
 * It has to tolerate an empty `socketPath` because it is registered BEFORE
 * anything creates a run root (no signal window may leak one): until
 * `createRunRoot()` succeeds there is no server to kill, and calling `tmux()`
 * then would - correctly - throw rather than reach the default server. The
 * throw inside `tmux()` stays; the CALL is what is guarded.
 */
const onSigint = (): void => {
  if (tearingDown) return
  tearingDown = true
  console.log(`\nSIGINT: killing the private tmux server and removing this run's temp roots ...`)
  if (socketPath !== '') tmux('kill-server')
  cleanupTempRoots(INTERRUPT_CLEANUP_TIMEOUT_MS)
  process.exit(130)
}

async function main(): Promise<number> {
  if (process.env.OPENCLAUDE_E2E !== '1') {
    console.log('SKIP: tmux TUI e2e harness requires OPENCLAUDE_E2E=1 (set it to opt in).')
    return 0
  }
  const tmuxVersion = probeTmuxVersion()
  if (tmuxVersion === null) {
    console.log('SKIP: tmux TUI e2e harness requires tmux on PATH.')
    return 0
  }
  // Ubuntu 20.04 ships 3.0a and Debian 11 ships 3.1c, and on those the run used
  // to get all the way to `new-session` before dying with `unknown option -- e`
  // - past the run root and the printed socket line. A skip here keeps the
  // harness's contract (it cannot run -> exit 0 with a message) and stays a
  // pure no-op: no handler, no sweep, no run root.
  if (isTmuxTooOld(parseTmuxVersion(tmuxVersion))) {
    console.log(
      `SKIP: tmux TUI e2e harness requires tmux >= ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR} (found ${tmuxVersion}) - new-session -e is unavailable.`,
    )
    return 0
  }
  if (!existsSync(CLI_BUNDLE)) {
    console.error(`ERROR: ${CLI_BUNDLE} is missing. Run \`bun run build\` first.`)
    return 1
  }

  // Registered here and nowhere else: AFTER the skip checks, so a skipped run
  // stays a pure no-op, and BEFORE the sweep and `createRunRoot()`, so no
  // signal window can leak a run root. The handler itself lives at module
  // scope because both teardown paths keep it registered across their cleanup.
  process.on('SIGINT', onSigint)

  try {
    // Before this run's own root exists, so it can never sweep itself, and
    // after the skip checks, so a skipped run stays a pure no-op.
    sweepStaleRunRoots()

    // After the skip checks, never before them: a run root created earlier would
    // be leaked by every skipped run. Nothing may call tmux() until this returns.
    if (!createRunRoot()) return 1

    // Printed once so a run is observable from outside: `tmux -S <path> ls`.
    console.log(
      `tmux socket: ${socketPath} (private per-run server; the default socket is never touched)`,
    )

    // Defensive only - `mkdtemp` hands this run a socket path no other run holds,
    // so there is nothing stale to inherit; a stale session would poison every
    // scenario, and killing an absent server costs nothing.
    tmux('kill-server')

    // Awaited one at a time, deliberately: all six drive the same session
    // name on the same server, so they must not overlap.
    const results = [
      await scenarioBatchedKeys(),
      await scenarioWindowSwitch(),
      await scenarioSplitEscape(),
      await scenarioTeammateViewEscape(),
      await scenarioNestedTeamTree(),
      await scenarioTreePersists(),
    ]
    report(results)
    return results.every(result => result.passed) ? 0 : 1
  } finally {
    // FIRST statement, before anything else in here: from this point on a
    // Ctrl-C must be ABSORBED, not acted on. `onSigint` stays registered for
    // the whole teardown and sees this flag, so the signal costs nothing and
    // the run's own exit code stands. Unhooking first - as this used to -
    // restored Node's default terminate action for the ~100ms of cleanup, so a
    // Ctrl-C there killed the process mid-teardown and left a run root AND a
    // live private server that nothing owned.
    tearingDown = true
    // Order matters: the temp roots can only go once the server is dead and
    // every CLI process writing into them with it. The socket goes with them,
    // which is why no dead socket is left in the shared socket directory.
    // Guarded like the handler is: the socket-path check can bail out before
    // `socketPath` was ever assigned, and there is then no server to kill.
    if (socketPath !== '') tmux('kill-server')
    cleanupTempRoots()
    // Only now, with nothing left for a signal to corrupt: the next Ctrl-C
    // should kill this process like any other, not be swallowed.
    process.off('SIGINT', onSigint)
  }
}

// Not `process.exit(main())`: the event loop has to run for a signal handler to
// ever be called, so `main()` is async and the exit code arrives in a callback.
//
// And not `process.exit(code)` in that callback either. `report()` writes the
// whole run log - the per-scenario blocks, the `N/N scenarios passed` summary
// and the `FAILED:` lines - immediately before this runs, and a pipe write is
// asynchronous on macOS and Windows (only on Linux is it synchronous). Exiting
// synchronously there truncates the TAIL of `... | tee e2e.log`, which is the
// part that says whether the run passed. Setting `process.exitCode` and letting
// the loop drain hands the same code back while stdout finishes flushing.
//
// This exits immediately in practice because nothing outlives `main()`: every
// `sleep` timer has already resolved (they are all awaited, none is fired and
// forgotten), every tmux call is `spawnSync` so no child handle is held here,
// the scratch window's `sh` loop is a child of the tmux SERVER rather than of
// this process (and that server is dead by now), the harness never opens stdin,
// and `main()`'s `finally` has already removed the SIGINT listener. `onSigint`
// keeps its own `process.exit(130)`: it fires from a signal callback with an
// interrupted scenario still pending, so it must not hand control back.
main().then(
  code => {
    process.exitCode = code
  },
  (error: unknown) => {
    // The same shape as main()'s `finally`, for a throw from OUTSIDE it: guard
    // first so a Ctrl-C in here is absorbed rather than acted on, tear down
    // with the handler still registered, unhook only once cleanup is done.
    // Usually main()'s own `finally` has already run and this is a no-op
    // (`cleanupTempRoots()` is idempotent and drains both queues); what it
    // really covers is a throw that never reached the `try` at all.
    tearingDown = true
    console.error(error)
    if (socketPath !== '') tmux('kill-server')
    cleanupTempRoots()
    process.off('SIGINT', onSigint)
    // Same reasoning as the resolved path, and it matters more here: the thing
    // most likely to be truncated is the `console.error(error)` above - the
    // only record of why the run died. Cleanup is finished and synchronous, so
    // by this line nothing is left to keep the loop alive either.
    process.exitCode = 1
  },
)
