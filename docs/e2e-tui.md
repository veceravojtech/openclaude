# TUI key-delivery E2E harness

`scripts/e2e/tui-keys.ts` drives the **built** CLI (`dist/cli.mjs`) inside a real
tmux pane. Ink unit tests write to a fake stdin, so they cannot show how keys
actually arrive from a terminal; this harness can, because tmux gives the CLI a
real pty.

## Running it

```bash
bun run build          # the harness runs dist/cli.mjs, not the sources
OPENCLAUDE_E2E=1 bun run e2e:tui
```

It **skips with exit code 0** and a printed message in three cases:
`OPENCLAUDE_E2E=1` is not set, `tmux` is not on `PATH`, or the tmux found is
**older than 3.2** — the harness hands the CLI its throwaway config home with
`new-session -e KEY=VALUE`, which exists only from tmux 3.2 on (Ubuntu 20.04
ships 3.0a, Debian 11 ships 3.1c). Without that check such a machine got past
the skips and died mid-run at `new-session` with `unknown option -- e`; it now
prints `SKIP: tmux TUI e2e harness requires tmux >= 3.2 (found tmux 3.0a) -
new-session -e is unavailable.` and touches nothing. A version string that names
no `major.minor` at all (`tmux master`, a distro-patched build) is treated as
unknown and the run **proceeds** — a working tmux is never refused over a
cosmetic string. All three skips make the run a pure no-op: no sweep, no run
root, no tmux server — so it is safe in CI and on machines without a usable
tmux.

The harness sets `process.exitCode` and lets the event loop drain rather than
calling `process.exit()`, so the tail of a piped log (`| tee`) — the
`N/N scenarios passed` summary and any `FAILED:` lines — cannot be truncated
where pipe writes are asynchronous (macOS, Windows). The exit codes themselves
are unchanged: 0 pass or skip, 1 failure, 130 on Ctrl-C.

It is deliberately not named `*.test.ts`, so `bun test` never
collects it. It needs **ES2023** (`Array.prototype.findLast`); the repo's
`tsconfig.json` already targets ES2023, but the harness is outside that config's
`include` (`src/**/*`), so type-check it directly when you change it:

```bash
bun run typecheck:e2e
```

That script type-checks the harness, the helper module and the helper module's
test with compiler options compatible with the repo's `tsconfig.json`: it adds
`--types node,bun` and omits the output, `jsx` and `paths` options, but the
type-checking flags — `strict`, `noImplicitAny: false` — match. The pure
version helpers — `MIN_TMUX_MAJOR`, `MIN_TMUX_MINOR`, `parseTmuxVersion` and
`isTmuxTooOld` — live in `scripts/e2e/tmux-version.ts` and are unit-tested by
`scripts/e2e/tmux-version.test.ts`, which — unlike the harness itself — **is**
collected by the default `bun test`, and therefore by `bun run check` and CI.

## What it covers

| Scenario | Input | Expected |
| --- | --- | --- |
| 1 | `Down Down Enter` in **one** `send-keys` call | the row **two** below the preselected one is confirmed |
| 2 | `select-window` away and back, then `Down Enter` | the row **one** below the preselected one is confirmed |
| 3 | `send-keys -H 1b`, 350ms gap, `send-keys -H 5b 42` | picker dismissed by the residual Escape, **no** `[B` in the prompt |
| 4 | a prompt answered by a **fake** Messages API with an `Agent` tool call, then `S-Down S-Down Enter`, then `Escape` | `Viewing @supervisor` opens, one Escape returns to the leader, the `@supervisor` pill survives |

Scenario 1 reproduces the batched-stdin defect: every key of a single
`send-keys` call reaches the CLI in one stdin read, so `Enter` can act on the
selection as it was *before* the `Down` keys. Scenario 2 is the same defect
reached the way a user hits it — after switching tmux windows. Scenario 3
covers the split-escape defect: a `DOWN` whose `ESC` byte is separated from
`[B` by more than the 300ms escape flush. Pre-fix it arrived as a bare Escape
plus a nameless `[B` key, which dismissed the dialog *and* typed `[B` into the
prompt. The parser now re-synthesizes that orphaned tail as a real `DOWN`, so
the literal text is gone — but the Escape had already been dispatched to the UI
by the earlier flush and cannot be un-sent
(`src/ink/parse-keypress.ts:375-381`), so the dialog is still dismissed. That
residual is accepted and asserted rather than chased: the scenario passes on
`Kept model as …` (never `Set model to …`) plus no literal `[B` anywhere in the
captured pane.

Scenario 4 reproduces the "stuck on `Viewing @supervisor`" report. A live
in-process teammate keeps `status: 'running'` for its whole life (idle is a
separate flag), and the Escape handler in `useBackgroundTaskNavigation` used to
gate on that status alone: it aborted the current turn and returned without
leaving the view, so for an idle teammate, which has no turn to abort, Escape
did nothing and the header's `esc return` hint lied. The fix interrupts a busy
teammate and returns from an idle one; the scenario asserts the return and that
the teammate is still alive afterwards. Run against the pre-fix hook it fails
with `still "Viewing @supervisor" 15000ms after Escape`.

All four scenarios pass on the current tree, so `bun run e2e:tui` exits 0. It
exits non-zero the moment any of them reproduces again, which is what makes it a
regression test rather than a one-shot reproducer.

## Scenario 4's fake Messages API

The teammate has to come from the model calling the Agent tool, and the harness
runs offline, so scenario 4 starts a fake Anthropic Messages API on the loopback
interface (`Bun.serve`, port 0) and points the CLI at it with
`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (a fake key, pre-approved in the
seeded config's `customApiKeyResponses` so no dialog precedes the prompt) and
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, which is the gate the Agent tool's
`name` parameter sits behind. The fake scripts exactly two main turns: the first
request that declares the `Agent` tool is answered with a `tool_use` spawning
`supervisor` in team `e2e-team` with **no prompt** (an idle spawn, always
in-process), and the request carrying that tool's `tool_result` is answered with
a short text. Every other request, such as side calls that declare no `Agent`
tool, gets a one-word text, so nothing else can spawn. Responses are streamed as
SSE when the client asks for a stream and returned as JSON otherwise;
`/v1/messages/count_tokens` answers a constant, and any other route is a 404.

With a teammate alive the footer hint changes from `? for shortcuts` to
`shift + ↓ to expand`, so the scenario reads the turn's end from the scripted
final text plus the spinner's `esc to interrupt` being gone, not from the hint.

## Expectations come from the pane, not from a table

The harness parses the picker's rows out of `capture-pane` — the `❯ N. label`
(selected) and `  N. label` (unselected) lines — and takes its expectations from
what actually rendered. Nothing about the model list is hardcoded: which rows
exist, their labels, and which row starts selected are all read from the pane,
so the scenarios say "the row two Downs below the preselected one", not "row 3
is `Sonnet (1M context)`". Renaming or reordering models cannot silently
invalidate the harness, and `openModelPicker()` waits on a row **count**, not on
any particular model name.

The confirmation line is not the row text (row 3 renders `Sonnet (1M context)`
but confirms as `Sonnet 4.6 (1M context)`), so the match is by significant
tokens: every candidate row whose tokens all appear in the confirmation is
scored, and the row with the most matched tokens wins. The argmax is what makes
it discriminating — the picker renders both `Opus 4.6 (1M context)` and `Opus
(1M context)`, and the second's tokens are a strict subset of the first's
confirmation. A tie, or no candidate, fails rather than guesses.

Two things are still constants, on purpose: `MIN_PICKER_ROWS = 3` (a property of
the *scenarios* — scenario 1 needs the preselected row plus two more, and fewer
rendered rows is a hard failure with the parsed rows dumped), and the UI strings
the scenarios key on (`Select model`, `Set model to`, `Kept model as`,
`? for shortcuts`). Those strings are what a timeout now reports: `waitForPane`
takes a label and, on timeout, prints the step that was waiting plus the last
captured pane, so a renamed string yields a readable diff instead of a silent
15-second wait.

## Log hygiene

Scenario 3's reported strings — its name, `expected` and `actual` — spell the
tail as `5b 42` / "bracket-B" instead of printing it literally, because
`report()` echoes all three into the run log. The *assertion* still tests the
literal bytes (`dismissed.pane.includes('[B')`) and the prompt line is still
interpolated verbatim, so a literal `[B` in a full-run log now means a real
leak:

```bash
OPENCLAUDE_E2E=1 bun run e2e:tui 2>&1 | tee /tmp/e2e.log
grep -c '\[B' /tmp/e2e.log     # 0 on a healthy tree
```

## Why the `/model` picker

It is the list UI reachable with no API call and no credentials — `/model` only
edits local config, so the harness works fully offline. Each scenario gets a
fresh session because the picker preselects the *current* model, which would
otherwise make the expected row depend on the previous scenario.

## Isolation

- **tmux**: every command targets a private, **per-run** server whose socket
  lives inside the run's own temp directory (`tmux -S <runRoot>/tmux.sock`,
  printed once at startup as
  `tmux socket: /tmp/openclaude-e2e-run-AbC123/tmux.sock`), never the default
  socket you work in. `mkdtemp` gives every run its own directory, so two
  concurrent runs cannot kill each other's server; the pre-run `kill-server`,
  the `finally` teardown and the `SIGINT` handler all target that socket only.
  Keeping the socket in the temp root is also what keeps the shared tmux socket
  directory (`/tmp/tmux-<uid>/`, or `$TMUX_TMPDIR`) clean: tmux does **not**
  unlink a socket on `kill-server`, so it goes only because the whole run root
  is deleted at teardown. Printing the path makes a run observable from
  outside — `tmux -S /tmp/openclaude-e2e-run-AbC123/tmux.sock list-sessions`
  shows the `oc` session while it is in flight.
- **Ctrl-C**: `SIGINT` kills that private server, deletes the run's temp roots
  (the per-scenario config roots *and* the run root holding the socket) and
  exits **130**, typically within a poll interval rather than after the whole
  run finishes. This is why the harness is `async`: a signal handler only runs
  between event-loop turns, so every pane poll and the scenario timing gap are
  awaited timers (`sleep`), and only teardown still blocks (`sleepSync`), so it
  cannot be re-entered by a second Ctrl-C. The handler is registered *before*
  the run root is created and tolerates a not-yet-assigned socket, so a signal
  arriving in that window cannot leak an empty run root either.
- **Ctrl-C during teardown**: a `SIGINT` that lands while a teardown is already
  running — the normal end-of-run one included — is **absorbed**, and the run's
  own exit code stands (0 for a clean run, never 130). Both teardown paths
  (`main()`'s `finally` and the top-level rejection path) raise the same
  `tearingDown` guard as their *first* statement and keep the handler registered
  through `kill-server` *and* the temp-root deletion, unhooking it only once
  cleanup is finished. Unhooking it first — as an earlier revision did — restored
  Node's default terminate action for those ~100 ms, so a Ctrl-C there killed the
  process mid-cleanup and left a run root *plus* a live private server that
  nothing owned.
- **Stale run roots**: a run that never reaches teardown — `kill -9`, a closed
  terminal — leaves its run root behind, sometimes with a live private server
  still inside it. Every start therefore sweeps `openclaude-e2e-run-*`
  directories in `tmpdir()`, printing one line per candidate. Liveness is
  decided by the **owner pid**, not by the socket: every run stamps its root
  with `<runRoot>/pid` (its own `process.pid`) the moment the root exists, and
  the sweep reads that first. Three outcomes:
  - owner pid **alive** → left completely alone, whatever the socket says;
  - owner **dead**, or no `pid` recorded at all (a legacy root), but a server
    still **answers** `list-sessions` → an **orphaned server**: it is killed
    through its own socket and the root removed, so a hard-killed run no longer
    costs one immortal tmux server per incident;
  - owner dead or unrecorded and **no** server answers → the root is removed.

  Trusting the pid over the socket is what makes concurrent runs safe. The
  socket file appears only at the first `new-session` and the server is already
  dead before teardown deletes the root, so a socket-only probe judges a
  perfectly live run dead in *both* of those windows and deletes its root from
  under it — the victim's next `new-session` then fails on the socket's missing
  parent directory. pid reuse is accepted rather than defended against: an
  unrelated process that happens to hold that number only postpones one root's
  sweep to a later run, which is the better failure by far.

  The sweep also **never throws**. A directory in a world-writable `/tmp` can
  belong to another user, sit at mode `000`, be busy, or vanish mid-sweep, and
  `rmSync(…, { force: true })` forgives only `ENOENT`; each candidate is
  therefore wrapped, and any failure costs exactly one line
  (`stale-root sweep: skipped /tmp/openclaude-e2e-run-AbC123 (EACCES)`) before
  the sweep moves to the next one. `readdirSync` on `tmpdir()` is wrapped for
  the same reason: a run must never fail because of a root it does not own. The
  default socket directory is never inspected, and the `-run-` infix is what
  keeps the per-scenario config roots (and any unrelated `openclaude-e2e-*`
  leftovers) out of the sweep.
- **Socket-path limit**: `sockaddr_un` caps a Unix socket path at 108 bytes on
  Linux and 104 on macOS/BSD, and tmux reports the overflow late and obscurely
  (`File name too long` at `new-session`). The harness therefore refuses to
  start when `<runRoot>/tmux.sock` would exceed 100 bytes: it exits **1** with
  `ERROR: tmux socket path too long (<n> bytes, limit ~104): set TMPDIR to a
  shorter directory.`, names the resolved `TMPDIR`, and touches no tmux server
  at all. The default `/tmp/openclaude-e2e-run-XXXXXX/tmux.sock` is ~40 bytes,
  so only a deep `TMPDIR` (a nested scratch directory, say) trips this — point
  `TMPDIR` at something shorter and rerun.
- **CLI state**: the CLI is started with `OPENCLAUDE_CONFIG_DIR` (its only
  config-home override — `resolveConfigDirEnv` in `src/utils/envUtils.ts`
  deliberately ignores `CLAUDE_CONFIG_DIR`) pointed at a temp directory, with
  `HOME` and `XDG_CONFIG_HOME` redirected as a backstop. Your real
  `~/.openclaude*` config, onboarding state and session history are never read
  or written. The temp directories are removed only after the tmux server is
  dead, because the CLI flushes config on shutdown.
