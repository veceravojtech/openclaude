# Follow-up: unresolved branch issues

Recorded 2026-09-23 for `agent-view-and-test-hygiene`, after commit `81595cab`.
This is an engineering handoff, not release notes. Findings below distinguish
problems in the current branch from unfinished changes isolated locally.

The teammate query-watchdog change is committed with its tests and documentation.
The branch is **not ready to push**: the full test suite and canonical PR scan
still fail. The broader branch has not received an exhaustive source review.

## Current branch blockers

### 1. Model-picker test fails in the full suite

**Observed:** `bun run check` reports:

```text
getModelOptions: allowlist checks a non-switch custom id verbatim, not decoded
Expected to contain: "__switch_profile__:sneaky:real-model"
Received: [ null ]
```

The assertion is in
[`src/utils/model/modelOptions.crossProfile.test.ts`](src/utils/model/modelOptions.crossProfile.test.ts).
The isolated file passes all 22 tests:

```bash
bun test --feature=UNATTENDED_RETRY src/utils/model/modelOptions.crossProfile.test.ts
```

The full sweep after isolation completed with **11,385 passes, 11 skips, and
one failure across 885 files**. The same assertion failed before the split.
Suite interaction is suspected; the root cause and whether it reproduces on
current upstream main have not been established. Do not label it an upstream
failure or treat the isolated pass as resolution.

Next steps:

- Find the minimal preceding test set that makes this assertion fail.
- Inspect module-mock restoration, provider environment, settings, and model
  caches across that sequence; record the actual causal state before fixing it.
- Add regression coverage for the interaction and make `bun run check` pass.

### 2. Canonical PR intent scan overflows its output buffer

**Observed:** the required command fails while reading the branch diff:

```bash
git fetch https://github.com/Gitlawb/openclaude.git main
bun run security:pr-scan -- --base FETCH_HEAD --head HEAD
```

[`getGitDiff` in `scripts/pr-intent-scan.ts`](scripts/pr-intent-scan.ts)
uses `spawnSync` without increasing its default output buffer. A direct probe
returned `status: null` and `error.code: ENOBUFS` on this branch's large diff.

A temporary copy with a 64 MiB diff buffer completed with **zero high and ten
medium findings**, exiting zero under the default policy. The repository's
scanner remains unchanged, so its required command still fails. The workaround
is diagnostic evidence, not completion of the pre-push contract.

Next steps:

- Handle large diffs without truncation and report subprocess errors accurately.
- Test a diff larger than the old buffer and a failed Git subprocess.
- Run the unchanged canonical invocation successfully after fixing the scanner,
  and review its findings.

### 3. Full-test failure attribution duplicates the summary failure

**Observed:** the full-test driver attributes the model-picker failure both to
its actual file and to the final `wizardSteps.test.tsx` file, whose own tests
passed. The overall Bun summary correctly reports one failure.

[`parseFileAttributions` in `scripts/run-test-full.ts`](scripts/run-test-full.ts)
keeps the last file open until the `Ran ...` line; Bun's repeated failure list
appears before that line and is counted as another failure in the last file.

Next steps:

- Distinguish the global skipped/failed-test summary from per-file output.
- Add a fixture containing a failed file, a final passing file, and Bun's
  repeated summary. Assert that only the original file is reported as failing.
- Preserve the driver's existing completion and exit-status checks.

## Isolated work: token-only compaction

**Not applied to the current branch.** The 15-file change removes message-count
and process-memory forced compaction, including three utility/test deletions.

Restore on a clean working tree when ready to repair it:

```bash
git stash apply refs/wip/isolated-compaction-removal-20260923
```

Local stash object: `79371250c20d349c667ccfbc82d9812a7003773e`.

Confirmed blockers:

- [`scripts/system-check.test.ts`](scripts/system-check.test.ts) imports the
  deleted `src/utils/maxActiveMessages.ts`. It fails at module load and still
  asserts the old diagnostic behavior. This failure disappeared after isolation.
- [`src/components/Settings/Config.tsx`](src/components/Settings/Config.tsx) and
  [`docs/advanced-setup.md`](docs/advanced-setup.md) still advertise numeric
  message thresholds, a hard cap, and environment overrides that the restored
  change would no longer honor.
- `src/query.ts` still uses `maxMessagesCompactionThreshold` to gate
  microcompaction, while the changed diagnostic says the setting does nothing.

Completion criteria:

- Reconcile saved-setting compatibility, UI, diagnostics, and documentation.
- Update diagnostic tests; remove all references to deleted modules.
- Add positive regression coverage proving many small messages and high RSS
  do not force summarizing compaction below the token threshold.
- Keep token-threshold compaction and real provider context-overflow recovery
  covered, including disabled auto-compaction and cooldown behavior.
- Validate both the main query path and in-process teammate path, then run the
  full required checks from [CONTRIBUTING.md](CONTRIBUTING.md#validation).

## Isolated work: teammate progress reporting

**Not applied to the current branch.** Eight files, including four new files,
implement and test pane progress reporting. Related in-process progress tests
were kept with this group.

```bash
git stash apply refs/wip/isolated-teammate-progress-20260923
```

Local stash object: `5c008d0e3e99cb771ea118934cc613c2e7f2d4de`.

Confirmed blockers:

- **Protocol filtering:** `isStructuredProtocolMessage` in
  [`src/utils/teammateMailbox.ts`](src/utils/teammateMailbox.ts) does not recognize
  `teammate_progress`. A direct probe returned false. The attachment consumer in
  [`src/utils/attachments.ts`](src/utils/attachments.ts) can therefore deliver a
  progress update to the model and mark it read before the UI poller handles it.
- **Out-of-order counts:** in the isolated `teammateProgressReporter.ts`, a
  delayed timer read can finish after `flush()`. A controlled reproduction
  delivered token counts `[20, 10]`; the receiver accepts the older update last.
- **Suppressed retries:** the reporter records counts as sent before the mailbox
  write succeeds. Two ticks with identical counts and a failing writer produced
  only one delivery attempt.

Additional test-harness concern found during separation: the new
`AgentTool.dispatchProgress.test.ts` sets the Agent Teams environment flag
without restoring it and leaves its spawned in-process teammate without explicit
teardown. Repair that lifecycle before relying on the test in a shared suite;
it has not been established as the cause of the model-picker failure.

Completion criteria:

- Keep progress out of model context across UI, attachment, headless, and sub-team
  consumers; ensure the intended state consumer still receives it.
- Coordinate timer reads, sends, final flush, and shutdown so stale work cannot
  overwrite newer state. Do not assume token counts can never decrease.
- Advance delivery state only after a successful write and test transient failure
  followed by unchanged counts.
- Add controlled race tests and restore test environment/mocks and live tasks.
- Verify pane progress visually and run the full required validation contract.

## Recovery and validation notes

The two `refs/wip/...` refs pin the stash objects even if stash numbering changes.
They and the stashes are **local only**, not included when this documentation is
committed or pushed. A fresh clone cannot restore them without transferring the
objects. Use `git stash apply`, which preserves the backup; restore one group
at a time and inspect the result before committing.

After isolation, 111 focused tests, main and type-test typechecks, build/smoke,
deadcode, docs-index checks, and both Node launcher checks passed. Earlier testing
of the combined working tree also passed provider tests (1,810), provider
recommendation tests (160), web checks, script/E2E typechecks, and the separate
conversation-arc test. Those earlier results are not a substitute for validating
the eventual repaired commits.

Environment: Node **26.3.1**, Bun **1.3.9**. The CI Node 22/24 matrix, live provider
acceptance, optional tmux E2E, and multi-hour memory soak were not run in this
audit. Historical acceptance notes do not establish those results for this state.

Local evidence is under `/tmp/openclaude-validation/`, with the post-isolation
run under `isolated/`; temporary logs may not survive cleanup. Recovery metadata
is also recorded in `.git/isolated-changes-20260923.md`. Existing root handoff
notes and `.playwright-mcp/` artifacts remain untracked and untouched.

At the audit fetch, upstream main was
`5cd11336caeaf2023ca1e02e5975c761cfc585fe`, with 20 commits absent from this branch.
Before any push, follow the synchronization and guarded-push rules in
[CONTRIBUTING.md](CONTRIBUTING.md#keep-your-branch-current), then rerun its full
validation contract. No push was performed during the audit or isolation.
