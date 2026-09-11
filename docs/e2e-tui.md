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
| 4 | a prompt answered by a **fake** Messages API with an `Agent` tool call, then `S-Down Enter`, then `Escape` | the teammates panel is up with **no** teammates before the spawn; `Viewing team-lead › supervisor` opens, one Escape returns to the leader, the prompt input box comes back with no dialog over it, the `@supervisor` row survives |
| 5 | two prompts answered by a fake that scripts the **lead and the teammate**, then `S-Down Enter Escape` and `S-Down Enter Escape` | `@worker-one` is drawn **indented** under `@supervisor-one`, and `Viewing team-lead › supervisor-one` then `… › worker-one` open in turn |
| 6 | boot with the panel hidden, `C-t C-t`, `C-t`, a prompt spawning two idle teammates, then `S-Down`, `S-Down`, `k` | the panel is absent at boot, shows its empty state on ctrl+t, re-appears on Shift+Down with the **leader row selected**, and the killed row keeps its place, its `killed` word and the highlight |

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
teammate and returns from an idle one; the scenario asserts the return, that the
PROMPT is back afterwards - the input box on screen with no dialog drawn over it,
which is a different fact from the header being gone and shares
`restorePromptAfterView` with scenario 5 - and that the teammate is still alive
at that point. Since `b231b071` the header names the
teammate by its path down the team tree, so the string the harness greps for is
`Viewing team-lead › supervisor` rather than the bare handle. Run against the
pre-fix hook it fails with
`still "Viewing team-lead › supervisor" 15000ms after Escape`.

Scenario 5 covers the teammates tree's **nesting**: a teammate that creates its
own sub-team, and a member of that sub-team drawn one level in. The indent is
asserted by COLUMN — `@worker-one`'s tree glyph must start strictly right of
`@supervisor-one`'s, in ONE capture — rather than against a hard-coded prefix,
so the two-columns-per-level width stays free to change. Both rows are then
opened by key, because the view header is what proves the row's PATH down the
tree (`Viewing team-lead › supervisor-one › worker-one`) rather than just its
handle.

Two product limits shape it, and both are worth knowing before editing it:

- The sub-team member is spawned by the **lead**, with an explicit `team_name`,
  not by `@supervisor-one` itself. A teammate's own `Agent` spawn does start a
  teammate — it runs and reports itself idle — but the task is never registered
  in AppState, so it has no row, no pill and no selectable entry. A tool running
  inside a teammate's turn is handed an isolated no-op `setAppState`
  (`inProcessRunner.ts` runs the turn with `isAsync: true` → `runAgent.ts`
  passes `shareSetAppState: !isAsync` → `forkedAgent.ts` substitutes `() => {}`),
  and that is the callback `spawnInProcess.ts` registers the task through; the
  `setAppStateForTasks` escape hatch that exists for exactly this case is not on
  its `SpawnContext`.
- The scenario walks **down only**. `shift+up` is bound to
  `chat:messageActions` in the Chat context (`src/keybindings/defaultBindings.ts`)
  and never reaches `useBackgroundTaskNavigation`, so today `Shift+Down` steps
  the tree selection and `Shift+Up` does nothing — measured in three different
  selection states. Asserting the walk up would pin that as correct, so the
  scenario reaches both rows with `Shift+Down` alone: Escape leaves a transcript
  view but KEEPS the selection, so the next `Shift+Down` carries on from where
  the last one stopped.

Scenario 6 covers the panel as a **panel**. It is the only scenario that boots
with the toggle off (`showSpinnerTree: false` in its OWN config, never in the
shared seed), because the branch under test — the first `Shift+Down` on a
collapsed tree expands it and parks on the leader — cannot be reached from the
shipped default. It then checks that a hidden panel stays hidden across a spawn,
and that a row killed under the cursor keeps its place, reads the terminal word
`killed`, and keeps the highlight: never dangling, never jumped onto the
teammate that is still alive.

Two details of scenario 6 are load-bearing. First, "the leader row is selected"
is asserted on the **selection pointer**, not on the leader row's text: the
leader row is drawn highlighted whenever no teammate transcript is open
(`isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected`), so its `╒═`
glyph says nothing about selection. The pointer does, and the harness reads the
one tree row carrying it (`   ❯╒═ team-lead · shift + ↑/↓ to select`, taken
verbatim from a capture). Second, the empty state is reached with `ctrl+t`
rather than `Shift+Down`: `Shift+Down` is handed to the tree only when a
teammate is alive or the panel is already expanded, so on a collapsed panel with
nothing spawned it belongs to the background-tasks dialog and cannot expand
anything. The killed row is re-checked 2s later rather than after the full 30s
grace, which has no env or config knob to shorten — the grace boundary itself is
a unit test's job, with a mocked clock.

All six scenarios pass on the current tree, so `bun run e2e:tui` exits 0. It
exits non-zero the moment any of them reproduces again, which is what makes it a
regression test rather than a one-shot reproducer.

## The fake Messages API and its per-role scripts

A teammate has to come from the model calling the Agent tool, and the harness
runs offline, so scenarios 4-6 start a fake Anthropic Messages API on the
loopback interface (`Bun.serve`, port 0) and point the CLI at it with
`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (a fake key, pre-approved in the
seeded config's `customApiKeyResponses` so no dialog precedes the prompt). No
teams flag is passed: Agent Teams are on by default, so scenario 4 doubles as
the check that the default path exposes the Agent tool's `name` parameter.
Responses are streamed as SSE when the client asks for a stream and returned as
JSON otherwise; `/v1/messages/count_tokens` answers a constant, and any other
route is a 404.

The fake must never outlive its run. Each of those scenarios boots the CLI
*inside* its own `try`, so a boot timeout still reaches the `finally` that calls
`api.stop()`, and `startFakeAnthropicApi` additionally `unref`s the server: a
listening `Bun.serve` is a live handle, and either hole alone would leave the
harness hanging with the exit code already set. The run report is not what such
a run prints — `report()` is called inside `main()`, after the results array a
boot timeout abandons, so the only output is the error the top-level rejection
handler writes before setting that code.

Each scenario hands the fake ONE script — a list of steps per role, each step a
single content block plus its `stop_reason`:

| Scenario | Role | Step | Answer |
| --- | --- | --- | --- |
| 4 | lead | 1 | `tool_use` `Agent { description, name: supervisor, team_name: e2e-team }` (no prompt: an idle spawn) |
| 4 | lead | 2 | text `Spawned supervisor; it is idle and waiting for work.` |
| 5 | lead | 1 | `tool_use` `Agent { name: supervisor-one, team_name: e2e-team, prompt: "Create your sub-team" }` |
| 5 | lead | 2 | text `Spawned supervisor-one` |
| 5 | lead | 3 | `tool_use` `Agent { name: worker-one, team_name: e2e-team/supervisor-one }` (idle) |
| 5 | lead | 4 | text `Spawned worker-one` |
| 5 | teammate | 1 | `tool_use` `TeamCreate { team_name: e2e-team/supervisor-one }` |
| 5 | teammate | 2 | text `sub-team ready` |
| 6 | lead | 1 | `tool_use` `Agent { name: doomed, team_name: e2e-team }` (idle) |
| 6 | lead | 2 | `tool_use` `Agent { name: survivor, team_name: e2e-team }` (idle) |
| 6 | lead | 3 | text `Spawned doomed and survivor` |

**The discriminator.** A teammate's turn hits the SAME fake — it runs in the
same process, against the same client and the same `ANTHROPIC_BASE_URL` — so the
fake has to know whose conversation a request belongs to. `classifyRole` answers
it from the request body alone: a request is a teammate's iff a `system` block
carries `# Agent Teammate Communication`, the addendum appended to every
in-process teammate's system prompt (`teammatePromptAddendum.ts`,
`inProcessRunner.ts`). A second signal — "the last user message contains
`<teammate-message`" — was tried and **rejected on evidence**: that tag wraps a
message for whoever RECEIVES it, so a teammate's idle notification carries it
into the LEAD's conversation, and the fake would then serve the lead a
teammate's script step.

**The auxiliary-request guard.** Only a request that carries the main tool set —
`tools` containing `Agent` — may consume a step. Everything else is answered
`text: "ok"` and logged as `skipped`. This is not hypothetical: the very first
request of every scenario is a haiku-model side call with **zero** tools, and
without the guard it would eat the lead's step 1 and desynchronise everything
after it. Past the end of a role's script the same default answers, so a late
housekeeping turn ends a conversation instead of failing a scenario. Every
served request is recorded, and `requests()` is both what scenario 5 asserts its
counters on and what a failing scenario prints into its `actual`, e.g.
`fake saw: lead#0:skipped lead#1:tool_use:Agent lead#2:text
teammate#1:tool_use:TeamCreate teammate#2:text lead#3:tool_use:Agent lead#4:text`.

**The `teammateMode: 'in-process'` seed (scenario 5 only).** The harness runs
the CLI inside a tmux pane, and in `auto` mode a PROMPTED spawn is routed to the
pane backend there (`backends/registry.ts`) — where a teammate is refused a
sub-team outright, because nothing would deliver its sub-team's messages or hand
out its task list (`TeamCreateTool.ts`). Without the seed scenario 5 would not
be testing the nested tree at all; it would be testing that refusal. An IDLE
spawn needs no seed: it is always routed in-process.

No other scenario seeds anything that touches teammates, and **no seed may hide
the feature under test** — the one exception is scenario 6's own
`showSpinnerTree: false`, whose whole purpose is to un-hide the panel by key.

With a teammate alive the footer hint changes from `? for shortcuts` to
`shift + ↓ to expand`, so the scenarios read a turn's end from the scripted
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
the scenarios key on. The picker scenarios key on `Select model`, `Set model to`,
`Kept model as` and `? for shortcuts`; the teammate scenarios add their own,
each declared as a named constant in `tui-keys.ts` and spelled with `\uXXXX`
escapes, because a box-drawing glyph or a `›` is one editor round-trip away
from an ASCII lookalike and a degraded literal would cost a 15-second timeout
with no clue why. Most are grouped at the top of the teammate half;
`E2E_SUB_LEAD_HEADER` and `E2E_SUB_WORKER_HEADER` are declared in scenario 5's
own block and `E2E_TREE_KILLED_SELECTED_ROW` in scenario 6's, and
`SELECTION_MARKER` sits higher still — in the shared section at the top of the
file, because the picker half is built from it too. They are: the panel's
two zero-teammate rows (`E2E_TREE_LEADER_ROW`, `E2E_TREE_EMPTY_ROW`), the three
view headers (`E2E_TEAMMATE_HEADER`, `E2E_SUB_LEAD_HEADER`,
`E2E_SUB_WORKER_HEADER`), the selection pointer and the tree glyphs that may
follow it (`SELECTION_MARKER`, aliased as `E2E_TREE_POINTER`, plus
`TREE_GLYPH_AFTER_POINTER` and the row pattern inside `treeRowColumn`), the
killed row (`E2E_TREE_KILLED_SELECTED_ROW`) and the prompt box rule
(`PROMPT_BOX_RULE`). That list is the named constants, not everything the
scenarios key on: the selected teammate row each of scenarios 4-6 gates on is
built inline as `` `\u255E\u2550 @${name}:` `` — escaped the same way, and
stopping at the colon on purpose, which the comment above scenario 6's copy
explains. Those strings are what a timeout now reports: `waitForPane` takes a
label and, on timeout, prints the step that was waiting plus the last captured
pane, so a renamed string yields a readable diff instead of a silent 15-second
wait.

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
