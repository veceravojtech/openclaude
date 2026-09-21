# Teammate Stop & Shutdown Fixes — Roadmap

> Created 2026-09-21 from a live failure investigation (team `test`, teammate `opus-worker`, tmux pane `%21`).
> The prior routing roadmap is preserved verbatim below this section.

## Implementation status (updated 2026-09-21, after Steps 0–4 landed and an independent review)

Steps 0–4 are **committed** (`e9c1c94c`, `c0bb8621`, `511c8b59`). An independent review has since run and found substantial defects — see "Review findings & open items" below. Those fixes are uncommitted and in progress; full validation is not started.

| Step | Owner | State | Tests |
|---|---|---|---|
| 0a+1 — shutdown_request delivery | deepseek-worker | ✅ committed | SendMessageTool 31/0 (154 assertions); +swarm/mailbox/inboxPoller 203/0; typecheck clean |
| 0b+2 — TaskStop from lead session | deepseek-pro-worker | ✅ committed | tasks 129/0 (stopTask 11), TaskStopTool 7/0, swarm 170/0; typecheck + `git diff --check` clean |
| 3 — watchdog ghost sweep | deepseek-worker | ✅ committed, but inert for socket-less members (see findings) | paneWatchdog 14/0 (5 new), TmuxBackend.paneLiveness 6/0, swarm/shared/hooks/task 479/0 (52 files); typecheck clean |
| 4 — dead-teammate UX | — | ✅ committed (`e9c1c94c`, `511c8b59`) | ListAgents/collectAddressableAgents/teamDiscovery tests extended |
| Independent review + defect fixes | — | 🔄 in progress | review defects below, uncommitted |
| Cross-review, pre-push contract, live acceptance | — | ❌ pending | — |

### Premise corrections found while implementing

- **Symptom 3 was inverted for structured calls.** The `"…is not running (task status: …)"` refusal lives only in the plain-text `handleMessage` path (`SendMessageTool.ts:271-284`). A structured `{type:'shutdown_request'}` routed straight to `handleShutdownRequest` with **no delivery check at all** — it returned false success even to a dead pane. Step 1 therefore did two things: added the live-pane exemption *and* closed the false-success hole (dead pane now refused).
- **Step 2 had two phases, not one.** Within `TEAMMATE_GRACE_MS` (30s) the terminal row stays in `AppState.tasks` and `resolveStoppableTask` already resolves it — the in-window refusal was `stopTask.ts:64` throwing `not_running`, *not* the roster fallback. The `"belongs to session <leadSessionId>"` mislabel only appears after the row is evicted (`explainMiss`, `resolveStoppableTask.ts:159-174`) — that ghost is Step 3's domain, not Step 2's.
- **Step 3 hit a real probe bug.** On tmux 3.6b, `display-message -p -t <missing-pane>` returns `,` with **exit 0 and empty stderr** (it does not say "can't find pane"), so `isPaneAlive` returned `unknown` — identical to unreachable tmux. With the fail-open rule (never sweep `unknown`), real ghosts would never be reaped. Fixed by echoing `#{pane_id}` first; an empty id in a successful reply now means `dead`. This also makes Step 1's `hasLivePaneRunner` correct against real tmux (only `alive` exempts, so it was already safe; the mocked-probe review risk is now resolved — see review findings item 3, though `hasLivePaneRunner` still derives its socket from the caller's environment rather than the roster's recorded socket).

### Deviations from the original spec (each deliberate)

- **Step 1 (4 deviations):** D1 extended the terminal-task gate to the structured path (required to make the exemption reachable; dead pane is now refused instead of falsely succeeding). D2 fail-closed — probe `unknown` refuses. D3 refusal is returned in the plain-message shape because `UI.tsx` renders nothing when `request_id`+`target` are present. D4 the envelope is still written on refusal (durable-inbox semantics), which meant a refused shutdown_request would stay as a live command for a future respawn under the same name — since resolved by `511c8b59`, which moved the shutdown write below the refusal gate (see review findings item 6).
- **Step 2:** also touched `spawnInProcess.ts` (10-line relaxation of `killOneInProcessTeammate` to abort a `failed` row). Required because the existing kill cascade itself early-returned on non-running tasks.
- **Step 3:** blocker fix in `TmuxBackend.ts` (probe format 2→3 fields) + new `src/utils/swarm/teammateRetirement.ts` extracting the poller's retirement block; `useInboxPoller.ts` now delegates to it (behavior unchanged).

### Review findings & open items (post-review, 2026-09-21)

The independent review has now run. It proved the Step 1 probe fix real (item 3), confirmed the "who sweeps" risk as a live bug (item 2), and found a set of further defects now being fixed but not yet landed. Distinctions are preserved: **proved by execution**, **proved by code reading**, and **reasoned but unreproduced**.

1. **Ghost sweep is currently inert for every member.** `isPaneAliveOnSocket` deliberately returns `unknown` when a member has no recorded `tmuxSocket` (a wrong-but-reachable server answers identically for a live pane, so it fails open rather than risk a destructive false `dead`). But no member in any live team file has that field: the running lead is pre-change code and does not record it — including teammates spawned minutes ago. Since `unknown` never reaps, the sweep is a no-op for 100% of current members, and stays one until the lead is rebuilt, restarted, **and** fresh teammates are spawned under it. The trade is documented in the code comment and `c0bb8621`'s message but was missing here. Consequence: Step 3's acceptance holds only for members spawned by rebuilt code. A discovery backfill for socket-less members is being implemented — **in progress, not done**. (Proved by code reading.)
2. **"Who sweeps" is confirmed broken, not merely structural.** In `paneTeammateWatchdog.ts scan()`, the dispose guard (`if (taskStatusNow !== 'running' && !watchingLateCompletion) { dispose(); return }`) sits **above** the `sweepDeadRosterMembers()` call, so a watchdog stops sweeping the moment its own task row goes terminal. The exemption covers only a task *this* watchdog failed on a deadline, so a **self-reported** failure — the roadmap's own motivating incident — disposes immediately. A single-teammate team never reconciles. (Proved by code reading.)
3. **Resolved: the Step 1 probe fix is proven, not self-referential.** The review reconstructed the buggy pre-fix logic and ran the new test against it: it fails on all four inputs, so the fix is demonstrated rather than a test agreeing with its own implementation. (Proved by execution.) Trap for future archaeology: against the *committed parent* the test passes both before and after, because the older two-field parser returned `unknown` for unrelated reasons — so a `git bisect` or "does it fail on the parent commit" check will wrongly suggest the test is vacuous.
4. **Live acceptance still needs a rebuild/restart** — the running lead is pre-change code, so the live roster ghosts (`opus-worker` `%21` etc.) survive until a rebuild; and because no member has a recorded socket, the sweep reads `unknown` for them (item 1).
5. **Defects found by review, fixes in progress** (file references for the fix team):
   - `TaskStop` on a failed pane teammate reports success but never kills the pane: the task row's `abortController` is cleared (`abortController: undefined` at `inProcessRunner.ts:3003`), and the abort listener is the only `killPane` caller. It then deletes the roster row holding the pane id, turning a visible ghost into an invisible orphan.
   - `src/utils/teamDiscovery.test.ts:10-13` leaks a module mock (no per-test `mock.restore()`); adding that one file to four clean suites turns 368 pass / 0 fail into 339 pass / 37 fail, casualties including Step 2's own acceptance tests. Ordering-dependent, so the failing set varies between runs.
   - `sweepDeadRosterMembers` had no `leadSessionId` check, so one session's watchdog could delete another session's live member from the shared roster — bypassing the cross-session refusal Step 2 preserves. (An uncommitted fix adds the check.)
   - The sweep's `removeMember` was called with `{agentId, name}` against an OR-matching filter (`teamHelpers.ts:472-474`), so a ghost's name respawned with a fresh agentId during the debounce window gets the healthy member deleted too. (An uncommitted fix narrows it to `agentId` only.)
   - `dead` covers both "pane absent" and "pane exists running a shell", so the sweep can delete the record of a pane it leaves running, under a log line claiming "confirmed gone".
   - `hasLivePaneRunner` (`SendMessageTool.ts`) still derives its own socket from the probing process's environment — `c0bb8621` did not touch that file.
   - The shutdown delivery gate fires only on `undeliverable`, so once the 30s grace evicts the task row the delivery classifies as `untracked`, skips the gate, and returns false success against a confirmed-dead pane — reopening the hole Step 1 closed, in exactly the roster-ghost state this roadmap addresses.
   - `socketServerReachable` proves a server *answers* on a socket, not that it *owns* the pane; the commit message's "positive server identity" overstates it. Correctness now rests on the recorded socket name being right, and a user running tmux on an explicit `-S /elsewhere/default` would record just `"default"` and could convict a live pane. (Reasoned, not reproduced.)
6. **`clearMailbox` has no production callers**, so nothing would ever have cleared a stale queued envelope. That is why moving the shutdown write below the refusal gate (`511c8b59`) was a correctness fix rather than a defensive one.
7. **`[1m]` tag preserved verbatim** in the roster binding (`claude-opus-5[1m]`); whether the child re-parses `OPENCLAUDE_TEAMMATE_MODEL` at startup is unverified because no request ever reached a servable route.
8. **Roster `isActive` is not deterministically flipped on failure** — `opus5-worker` stayed `active:true` after its failed task while `opus-worker` flipped to `false` (watchdog timing). Step 3's sweep reconciles this only when the pane is confirmed dead; Step 4's probe-based `dead` verdict narrows the damage.

### Cross-provider dispatch results (same session)

- ✅ `deepseek-flash` → DeepSeek profile via model-only auto-routing (transcript 12× `model:deepseek-flash` + runtime env)
- ✅ `deepseek-v4-pro` → same (runtime env, first turn)
- ❌ `opus-5`, `claude-opus-5`, `claude-opus-5[1m]` → all failed at provider: no configured profile serves Anthropic models (Z.AI GLM active, Codex OAuth, DeepSeek are the only saved profiles). This is the spawn-time validation gap in out-of-scope below.

## Symptoms observed (live repro, this session)

1. Spawned a pane teammate with a model unusable on the active provider (`opus-5` while the leader ran on Z.AI GLM). Spawn-time validation passed; the first provider request failed → task status `failed`, teammate marked `isActive: false`.
2. The tmux pane stayed alive (a `node` process kept running in `%21`). By design: the failure path has no teardown (`paneTeammateWatchdog.ts` treats failed children as alive-at-prompt and resumable).
3. Cooperative stop was broken in **two** ways. Plain-text `SendMessage` to a terminal row → **"Not delivered … (task status: failed)"** (only the text path carries that refusal). A structured `{type:'shutdown_request'}` had the opposite bug: **no delivery check at all**, returning false success even when the pane was dead. (Premise corrected during implementation — see status above.)
4. `TaskStop <task-id>` → **"No task found"** — the terminal task row is no longer in the per-process stoppable registry.
5. `TaskStop <name>@<team>` **from the lead session that spawned it** → false **"it belongs to session <leadSessionId>"** refusal; address resolution fell back to the on-disk roster and reported our own session as foreign.
6. Roster ghost: the member stays in `~/.openclaude/teams/<team>/config.json` forever (only `kill` and in-process idle-retire paths remove members — `respawnSubLead.ts:104-118`); `ListAgents` shows the dead teammate indefinitely (`teamDiscovery.ts:39-56`).

Net effect: **a failed pane teammate can be neither cooperatively stopped, hard-stopped, nor forgotten.** Only `tmux kill-pane` works, and it leaves the roster ghost.

## Root causes

- The failure path intentionally preserves the pane for resume, but the stop mechanisms had specific holes:
  - plain-text delivery refused terminal rows (`SendMessageTool.ts:271-284`); the structured `shutdown_request` path had **no** check, so it falsely succeeded against dead panes;
  - within the 30s grace the terminal row is still resolvable but `stopTask.ts:64` throws `not_running`; after eviction `resolveStoppableTask.ts:159-174` reads the roster and mislabels the lead's own teammate as foreign-owned.
- No roster-removal path exists for failed pane teammates: idle-retire exists only for in-process runners (`inProcessRunner.ts:1594`); pane teammates have no runner.

## Fix steps

### Step 0 — Pin current behavior with characterization tests (no product change)

- Reproduce: spawn a pane teammate with a model the active provider cannot serve; capture symptoms 3–6 (refusal texts, pane-alive check, roster contents).
- Add tests that document today's behavior for each stop path so later fixes are diff-visible:
  - `SendMessageTool.test.ts` (extend the terminal-task cases near lines 398–417)
  - `resolveStoppableTask` / `stopTask` tests for failed pane tasks
  - `paneTeammateWatchdog` test for "failed ⇒ pane untouched, member retained"

### Step 1 — Deliver `shutdown_request` to failed-but-alive pane teammates

**File:** `src/tools/SendMessageTool/SendMessageTool.ts:271-284`

- Exempt `shutdown_request` (and only it) from the terminal-task refusal when the target is a roster member with `backendType: 'tmux'` **and** its pane still exists.
- The child side already works: the pane poller surfaces the request (`useInboxPoller.ts:244,259`) → approval → `gracefulShutdown(0)` (`SendMessageTool.ts:422-526`) → lead cleanup kills the pane, removes the member, unassigns tasks, and force-completes the task row (`useInboxPoller.ts:740-806`).
- Ordinary messages stay undeliverable (durable-inbox-for-respawn semantics unchanged).
- **Acceptance:** from the lead session, `SendMessage(shutdown_request)` to a failed pane teammate whose pane is alive → teammate approves → pane closes, roster member removed, task force-completed.
- **Tests:** delivery allowed for `shutdown_request` + live pane; still refused for dead pane and for non-shutdown messages.

### Step 2 — Make `TaskStop` work from the lead session for failed pane teammates

**Files:** `src/tasks/resolveStoppableTask.ts` (registry lookup ~60–79; miss-explanation ~159–174), `src/tasks/stopTask.ts:48-93`

- First verify why address resolution fell through in our live test (we were the lead session): expected cause is that the `failed` task left the local registry, so resolution fell back to the disk roster, which compares `leadSessionId` against the wrong context and mislabels the owner.
- Fix: when the roster entry's `leadSessionId` matches the current session, treat the address as stoppable even if the task row is terminal — drive the existing kill cascade (`killInProcessTeammateAndCascade`, `spawnInProcess.ts:350`), whose abort listener kills the pane (`spawnMultiAgent.ts:1129-1137`) and removes the roster entry (`spawnInProcess.ts:589-591`).
- Cross-session stops remain refused by design (keep the existing error text that suggests closing the pane).
- **Acceptance:** `TaskStop opus-worker@test` from the lead session (task already `failed`) kills pane `%N` and removes the member; from any other session it still refuses with the pane hint.
- **Tests:** lead-session stop of a failed task; foreign-session stop still refused; pane-missing stop still safe.

### Step 3 — Watchdog ghost sweep: reconcile the roster with pane reality

**File:** `src/utils/swarm/backends/paneTeammateWatchdog.ts` (scan loop; failure transition ~448–468)

- In the existing 5s scan, for each roster member with `isActive: false` and `backendType: 'tmux'`: check pane existence (`tmux has-pane` equivalent already used by the backend). If the pane is gone:
  - remove the roster member,
  - unassign and force-complete its task rows (reuse the removal helpers from `useInboxPoller.ts:781-806`).
- Guardrails: debounce (e.g. require two consecutive scans or a grace interval after failure) so a pane mid-respawn is not reaped; never touch members with live panes (resumability unchanged).
- **Acceptance:** after a manual `tmux kill-pane`, the member disappears from `config.json` and `ListAgents` within one scan cycle, without touching healthy teammates. **Conditional:** this holds only for members spawned by rebuilt code (a recorded `tmuxSocket`); socket-less members read `unknown` and are never reaped — see review findings.
- **Tests:** dead-pane member swept; live-pane member untouched; sweep is idempotent; grace period respected.

### Step 4 — Surface dead teammates honestly in ListAgents / TeamsDialog

**Files:** `src/utils/teamDiscovery.ts:39-56`, `src/components/teams/TeamsDialog.tsx`

- `getTeammateStatuses` currently renders `isActive: false` as `idle`. Distinguish "dead pane" (member present, pane missing) from idle, and expose a remove/kill action in the Teams dialog that goes through the Step 2/3 paths.
- **Acceptance:** `ListAgents` no longer shows a killed-pane teammate as merely `idle`; the dialog can remove a ghost.

### Step 5 — Validation

- Focused suites: `SendMessageTool`, `resolveStoppableTask`/`stopTask`, `paneTeammateWatchdog`, `teamDiscovery`, `teammateMailbox`.
- Then the full pre-push contract from `CONTRIBUTING.md § Validation` (`bun run build`, `smoke`, `check`, `typecheck`, `typecheck:type-tests`, plus `docs:check` if docs change).
- Live re-run of the original repro to confirm all six symptoms are gone. **The live acceptance re-run must spawn *fresh* teammates under a rebuilt lead** — otherwise the sweep reads `unknown` for socket-less members and appears broken when it is merely inert (see review findings).

## Suggested order & dependencies

- Step 0 first (safety net), then Steps 1 and 2 independently (both unlock "stop"), then Step 3 (cleanup of what 1/2 or manual kills leave), then Step 4 (UX on top of 3), Step 5 throughout.

## Out of scope / follow-ups

- Spawn-time provider/model compatibility checks — three live repros this session (`opus-5`, `claude-opus-5`, `claude-opus-5[1m]`) each accepted at spawn then died on first request because no saved profile serves Anthropic models — separate work.
- Auto-killing panes on failure — resumability is intended; this roadmap only makes stopping *possible*, not automatic.
- Cross-session stopping of another session's teammates — stays unsupported by design.
- `paneTeammateWatchdog.ts` currently has uncommitted edits in the working tree; coordinate Step 3 with that work before touching the file.

---

# Cross-Provider Teammate Routing — Roadmap

> Status snapshot: 2026-09-21. All work is **uncommitted** in the working tree alongside pre-existing user changes. No commits or pushes have been made.

## Goal

Let any leader session spawn teammates on any configured provider, regardless of the leader's own provider or auth:

- Codex leader → native Anthropic Claude teammate
- Claude leader → Codex OAuth teammate (already worked)
- Any leader → DeepSeek, Gemini/Mistral, local, or custom-gateway teammate
- Different teammates → different configured profiles concurrently

Constraints: no model-name allowlists, no secrets in spawn commands/logs/metadata, no mutation of global config from a child, custom/aggregator model IDs keep working.

## Background findings

- Claude → Codex worked via a Codex-only `provider_profile` binding (`providerProfileBinding.ts` built Codex env only). The reverse direction was simply not implemented — not a fundamental limitation.
- Model-only saved-profile lookup (`agentRouting.ts:245` `resolveProviderProfileRoute`) only ran for first-party Anthropic leaders and excluded Claude-looking names, so a Codex leader could never auto-select another saved route.
- `ProviderOverride` (`agentRouting.ts:22-39`) assumes OpenAI-compatible transport; native Anthropic cannot be represented as `{model, baseURL, apiKey}`.
- **Prerequisite bug:** Codex strict tool-schema conversion (`codexShim.ts` `enforceStrictSchema`) marked *every* property required, so the model was forced to send `provider_profile`/`replicas` even when it meant "omit". This made spawn-time guards receive garbage and blocked model-only routing.
- Live DeepSeek smoke test: spawn passed local validation, then failed at the server with `400: 'deepseek-v4-pro' model is not supported when using Codex with a ChatGPT account.` — proving the guard gap (Anthropic names were blocked; nothing else was).
- Consumer safety boundary: `claude.ts:2693-2732` yields an executable assistant message at `content_block_stop`; `query.ts:1808-1824` immediately queues the tool. Any rejection *after* block stop is too late to prevent dispatch.
- Security debt observed: `spawnUtils.ts:220-278` serialized inherited credential env vars (OPENAI_API_KEY, GITHUB_TOKEN, credential-bearing proxy URLs) into the visible tmux command.

---

## Phase 1 — Codex strict-schema optional-argument roundtrip ✅ ACCEPTED

**Status: complete, independently verified (PASS). Files frozen.**

### What it does

- Strict wire schemas encode originally-optional non-nullable properties as a full-schema `anyOf: [<strict original>, {type:'null'}]` — preserving enum/const/combinator/nested constraints.
- The original JSON schemas are captured **request-locally** in `clientDispatch.ts` (no global name→schema cache) and threaded into both streaming and non-streaming Codex converters.
- At arguments conversion, synthetic `null` placeholders are restored to omission **only** where the original schema proves the field optional and non-nullable. Required fields, genuine nullables (`type:'null'`, nullable unions, `enum`/`const` with null, unresolved `$refs`), `false`/`0`/`''`, and defaults are preserved.
- Constraint evaluation is recursive and conjunctive: `allOf` grandchildren, sibling `required` unions, per-property and per-array-item schemas are intersected — not last-wins.
- **Conservative by design:** unsupported or ambiguous constructs (`if`/`then`/`else`, `dependentRequired`, `dependentSchemas`, `dependencies`, `not`, `patternProperties`, `unevaluated*`, `contains`, `prefixItems`, cycles, unresolved refs) preserve the whole node instead of guessing. Tri-state null proof (allow/disallow/unknown).
- Streaming: schema-backed calls buffer arguments per item ID and emit exactly **one** normalized `input_json_delta` before `content_block_stop`, only after authoritative successful completion (`output_item.done` with explicit completed status and non-empty authoritative arguments). Duplicate/reordered done events are idempotent; late deltas after `arguments.done` are ignored.
- **Fail-closed:** malformed, truncated, aborted, `response.incomplete`, EOF, or missing-status/schema-args cases reject *before* any executable block stop.
- Schema-less legacy Responses behavior is untouched (done-only payload emits exactly once on completed/EOF); generic Responses providers opt out of both encoding and decoding (scope is `codex_responses` only, streaming and non-streaming parity).
- Non-stream: missing/null/non-object arguments reject for schema-backed calls instead of inventing `{}` or `{raw:...}`.

### Changed files

- `src/services/api/codexShim.ts` (+ tests: `codexShim.test.ts`, new `codexShim.optionalArguments.test.ts`)
- `src/services/api/openaiShim/clientDispatch.ts` (+ test)
- `src/services/api/openaiShim/requestPlanner.ts` (+ test)

### Verification

Independent reviewer (fresh, read-only): **278 pass / 0 fail, 963 assertions** across six suites; `bun run typecheck` PASS; `bun run typecheck:type-tests` PASS (10 files); `git diff --check` PASS. All previously reproduced blockers replayed and confirmed fixed in both streaming and non-streaming modes.

Review history (each round found real bugs the green tests missed): 5 blockers → 3 → 4 (recursive constraints + schema-less payload loss) → 2 (conservative union/conditional handling) → **PASS**.

---

## Phase 2A — Explicit provider-profile binding (any provider) 🔄 IMPLEMENTED, AWAITING REVIEW

**Status: writer stopped; independent review NOT yet started. Author-reported checks green (599 pass / 0 fail, 2204 assertions, 13 suites).**

### What it does

- `provider_profile` accepts **any** saved profile — native Anthropic, Codex OAuth, OpenAI-compatible, Gemini/Mistral, keyless local, custom gateways with advanced headers — not just Codex.
- Binding carries only `OPENCLAUDE_TEAMMATE_PROFILE_ID` + `OPENCLAUDE_TEAMMATE_MODEL` (ID resolved before name; effective model = explicit model or profile default). **No** API keys, base URLs, or header values serialized anywhere.
- Child process applies the exact selected profile via existing provider env builders (`applyProviderProfileToProcessEnv` path, new `applySessionBoundProviderProfileFromEnv`), ahead of active-profile early-return logic, clearing ambient leader provider env first. Never writes `saveGlobalConfig` or `activeProviderProfileId`.
- Binding survives managed-env refresh (`managedEnv.ts` re-applies it after remembered provider/env-file inputs reapply).
- CLI applies the binding before startup-profile validation; bound model drives parsed model + teammate model; legacy `agentModels` ProviderOverride skipped when bound.
- Bound spawn commands (pane **and** window) use an explicit allowlist: identity + model + config/runtime flags only. Inherited credential env vars, header values, proxy URLs, and arbitrary extras never reach the command. Conflicting inherited `--provider`/`--provider-env-file`/`--model` flags are stripped on the spawn-constructed path.
- Per-provider chosen-auth lookup with no ambient fallback; unknown profile ID fails closed; in-process profile binding remains rejected; unbound legacy behavior unchanged; narrow known Codex+native-Claude mismatch guard now uses selected-profile metadata.
- Docs: `docs/agent-routing.md` gained an explicit `provider_profile` section.

### Changed files

- `src/tools/AgentTool/providerProfileBinding.ts` (+ test)
- `src/utils/providerProfiles.ts`
- `src/utils/managedEnv.ts`
- `src/entrypoints/cli.tsx`
- `src/utils/swarm/spawnUtils.ts`
- `src/tools/shared/spawnMultiAgent.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `docs/agent-routing.md`
- Tests: `providerProfileBinding.test.ts`, `providerProfiles.test.ts`, `managedEnv.test.ts`, `cli.test.ts`, spawnUtils/spawnMultiAgent suites, `AgentTool.teammateModel.test.ts`

### Known residuals (accepted for this phase)

- `processEnv` injection into profile application now throws (child actual-process only) — intentional tightening.
- Manually combining the binding env var with an explicit `--provider` on the *same* command line: binding wins.
- No live network validation. Build, smoke, and docs:check now pass; the full
  unit sweep still has unrelated failures from pre-existing DeepSeek model
  metadata changes in the working tree.

---

## Phase 2B — Model-only auto-routing (leader-independent) ✅ IMPLEMENTED, AWAITING REVIEW

The saved-profile discovery path is implemented for pane/window teammates and
works independently of the leader provider:

- `agentRouting.ts` now resolves identity-only profile routes for any leader
  provider without widening the legacy `ProviderOverride` path.
- Precedence remains explicit tool model, normalized name, `subagent_type`,
  default, definition model, then inherited provider. Configured
  `agentModels` entries win before discovery; unknown/custom model IDs pass
  through unchanged; ambiguity names every candidate profile and fails closed.
- `agentModels` accepts a discriminated `provider_profile` route and rejects
  profile entries combined with inline credentials.
- Agent route settings display saved-profile routes, and profile matching is
  tested across native, Codex, OpenAI-compatible, and custom model metadata.

Focused verification: 355 tests passed across routing, settings, profile
binding, spawn security, startup protocol, and pane-watchdog suites.

---

## Phase 3 — Validation, hardening, release 🔄 HARDENED, VALIDATION PARTIAL

1. **Independent review of Phase 2A and 2B** remains the next review step.
2. The child now reports resolved model/provider/transport at startup without
   credentials. Provider/runtime turn failures send a fixed failure
   notification even when Stop hooks are skipped, and the leader/watchdog
   transitions the task promptly.
3. Validation run: frozen install, build, smoke, typecheck, typecheck:type-tests,
   docs:check, CLI launcher checks, provider-recommendation tests, and focused
   routing/readiness tests pass. The full unit sweep reports five failures in
   pre-existing DeepSeek model-cap metadata changes (expected 65,536, working
   tree returns 393,216); those files are outside this roadmap change.
4. The required PR intent scan could not complete because the current
   branch's pre-existing diff from `FETCH_HEAD` is larger than the scanner's
   `spawnSync` output buffer. No suspicious-addition result was produced.
5. Live cross-provider smoke tests (opt-in, configured accounts): Codex → native Claude, Codex → DeepSeek, reverse directions, custom gateway, keyless local. A local headless leader attempt reached its max-turn limit before a teammate spawn, so it produced no live inference evidence. Report provider working only on actual inference, not pane creation.
6. Later (separate projects): per-account OAuth storage (profile labels do not currently bind distinct accounts), request-scoped in-process provider isolation (today: in-process binding rejected), headless child backend so cross-provider teammates don't need a visible pane.

## Non-goals / guardrails

- No hardcoded model allowlists; custom/aggregator models always pass through.
- No secrets in tmux command strings, logs, task metadata, or error messages.
- No `process.env` mutation to switch a single in-process teammate.
- No silent provider substitution when a profile is explicitly selected.

## Quick status table

| Work | Status |
|---|---|
| Phase 1 schema roundtrip | ✅ Accepted (278/0, all checks green) |
| Phase 2A explicit profile binding | 🔄 Implemented, awaiting independent review |
| Phase 2B model-only routing | ✅ Implemented, awaiting independent review |
| Readiness and first-request failure reporting | ✅ Implemented and focused-tested |
| Full pre-push validation | ⚠️ Partial; unrelated pre-existing DeepSeek cap failures |
| Live provider smoke tests | ⚠️ Attempted; no teammate evidence |
| Commits / PR | ❌ None — all work uncommitted |
| Original Codex OAuth usage research | ❌ Researcher timed out; unanswered |
