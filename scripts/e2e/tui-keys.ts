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
 * Scenario 4 - Escape must leave an idle teammate's transcript view.
 *
 * Reproduces the "stuck on Viewing @supervisor" report: a live in-process
 * teammate keeps `status: 'running'` for its whole life (idle is a separate
 * flag), and the Escape handler used to gate on that status alone - it aborted
 * the current turn and returned WITHOUT leaving the view. An idle teammate has
 * no turn to abort, so Escape did nothing and the header's "esc return" hint
 * lied. The fix (src/hooks/useBackgroundTaskNavigation.ts) interrupts a busy
 * teammate and returns from an idle one.
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

type FakeAnthropicApi = {
  baseUrl: string
  /** Main-loop turns served (the tool_use turn and the tool_result turn). */
  mainTurns: () => number
  stop: () => void
}

type FakeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

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

function startFakeAnthropicApi(): FakeAnthropicApi {
  let mainTurns = 0
  let spawnIssued = false
  let nextId = 1
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 10 })
      }
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
        const body = (await request.json()) as {
          model?: string
          stream?: boolean
          messages?: Array<{ role: string; content: unknown }>
          tools?: Array<{ name: string }>
        }
        const last = body.messages?.at(-1)
        const lastHasToolResult =
          Array.isArray(last?.content) &&
          (last!.content as Array<{ type?: string }>).some(b => b?.type === 'tool_result')
        const agentTool = body.tools?.find(tool => tool.name === 'Agent')
        let block: FakeContentBlock
        let stopReason: 'tool_use' | 'end_turn' = 'end_turn'
        if (lastHasToolResult) {
          mainTurns++
          block = { type: 'text', text: `Spawned ${E2E_TEAMMATE}; it is idle and waiting for work.` }
        } else if (agentTool && !spawnIssued) {
          spawnIssued = true
          mainTurns++
          stopReason = 'tool_use'
          block = {
            type: 'tool_use',
            id: 'toolu_e2e_spawn',
            name: agentTool.name,
            // No `prompt`: an idle spawn, routed in-process by the Agent tool.
            input: { description: 'idle supervisor', name: E2E_TEAMMATE, team_name: E2E_TEAM },
          }
        } else {
          block = { type: 'text', text: 'ok' }
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
    stop: () => {
      server.stop(true)
    },
  }
}

async function scenarioTeammateViewEscape(): Promise<ScenarioResult> {
  const name =
    'Scenario 4 (teammate view): Escape returns from an idle @supervisor view without killing the teammate'
  const expected = `"${E2E_TEAMMATE_HEADER}" gone and the prompt back after one Escape, with the @${E2E_TEAMMATE} pill still shown`
  const fail = (actual: string, pane: string): ScenarioResult => ({
    name,
    passed: false,
    expected,
    actual,
    rows: [],
    pane,
  })
  const api = startFakeAnthropicApi()
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

    // Shift+Down opens the teammate selection on the leader row, a second one
    // moves to the first teammate, Enter opens its transcript view.
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'S-Down')
    await sleep(200)
    tmux('send-keys', '-t', CLI_WINDOW, 'Enter')
    const viewing = await waitForPane(
      `scenario 4: "${E2E_TEAMMATE_HEADER}" after Shift+Down, Shift+Down, Enter`,
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
        ? 'returned to the leader view; the teammate pill is still shown'
        : 'returned to the leader view, but the teammate pill is gone (Escape killed it)'
    return { name, passed: returned.ok && stillAlive, expected, actual, rows: [], pane: returned.pane }
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

    // Awaited one at a time, deliberately: all four drive the same session
    // name on the same server, so they must not overlap.
    const results = [
      await scenarioBatchedKeys(),
      await scenarioWindowSwitch(),
      await scenarioSplitEscape(),
      await scenarioTeammateViewEscape(),
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
