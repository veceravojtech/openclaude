export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Cancel or supersede tasks (do NOT delete them):**
- When a task is no longer needed, set status to \`cancelled\`. The task is kept for the record, its owner is cleared, and tasks that were waiting on it are unblocked.
- When a task is replaced by another task, set status to \`cancelled\` with \`supersededBy\` set to the replacement task's ID. Tasks that were waiting on the old task now wait on the replacement instead, so they stay blocked until it completes.
- The replacement must exist, must not be the task itself, must not be cancelled, and must not create a dependency cycle. Otherwise the update is rejected and nothing is changed.
- Completed or already-cancelled tasks cannot be cancelled, and a cancelled task can never be marked completed.

**Delete tasks:**
- Only for a task that was created by mistake (a duplicate, a typo, the wrong list)
- Setting status to \`deleted\` permanently removes the task and silently drops it from other tasks' dependencies, which can unblock them. For work that was dropped or replaced, cancel or supersede instead.

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **supersededBy**: With \`status: "cancelled"\` only — the ID of the task that replaces this one
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`cancelled\` (optionally with \`supersededBy\`) for work that was dropped or replaced. Use \`deleted\` only to remove a task created by mistake.

## Verification-Gated Tasks

A task whose metadata has \`requiresVerification: true\` can only be marked \`completed\` when \`metadata.verifiedBy\` is the agentId of a verification agent run (subagent_type "verification") whose recorded verdict is PASS. Otherwise the update is rejected and nothing is changed. Tasks without the flag complete as usual.

- Run the verification agent with the Agent tool. Its verdict (the final \`VERDICT: PASS|FAIL|PARTIAL\` line of its report) is recorded under its agentId when the run finishes.
- Get the verifier agentId from the Agent tool result: a synchronous run ends with an \`agentId: <id>\` line followed by a \`verificationVerdict: <verdict>\` line; a background run returns its agentId at launch, and its completion notification carries the same id as the task-id.
- FAIL, PARTIAL, a report with no VERDICT line, or an agentId with no recorded verdict all block completion. Fix the work, run a new verification, and cite the new verifier's agentId.
- \`verifiedBy\` can be set in the same call that completes the task. The \`requiresVerification\` flag cannot be cleared in that call to skip the check.
- Starting or resuming a verifier clears its earlier verdict; only a run that finishes records a new one. If the result says the verdict was NOT recorded, run the verification again.
- This gate is a guardrail against mistakes, not a security boundary: the flag can still be removed in a separate, earlier update, one PASS can be cited for more than one task, and anything with file-write access could forge a record. Do not use it to work around a real verification.

## Final-Review-Gated Tasks

A task whose metadata has \`requiresFinalReview: true\` can only be marked \`completed\` when \`metadata.finalReviewedBy\` is the agentId of a final reviewer run (subagent_type "final-reviewer") that recorded DONE, and no GAP task filed by a final reviewer of this task is still open. Otherwise the update is rejected and nothing is changed. When both flags are set, the verification gate is checked first.

- Run the final reviewer with the Agent tool: \`review_commit\` is the commit to review, and \`prompt\` is the original user request verbatim and nothing else. It reviews a clean, detached checkout of that commit, so only committed work counts.
- Its report ends with \`FINAL REVIEW: DONE\` or \`FINAL REVIEW: GAPS\`. The result is recorded under its agentId; the Agent tool result shows it on a \`finalReview: <result>\` line.
- Every GAP becomes a pending task (\`metadata.gapOf\` = the reviewer's agentId) that blocks each open final-review-gated task. While any of them is open, completion is rejected even with a DONE review. Complete each GAP task when it is fixed, or cancel it if it no longer applies, then run the final reviewer again on the new commit.
- GAPS, MISSING (a report that does not follow the format, or that reviewed the wrong checkout), or an agentId with nothing recorded all block completion.
- \`finalReviewedBy\` can be set in the same call that completes the task. The \`requiresFinalReview\` flag cannot be cleared in that call to skip the check. A task that replaces it via \`supersededBy\` inherits the flag and its open GAP tasks, but not \`finalReviewedBy\`.
- Same limits as verification: a guardrail, not a security boundary. The reviewer is isolated by what it is given (a clean checkout, the request, read-and-run tools), not by a sandbox.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Cancel a task that is no longer needed:
\`\`\`json
{"taskId": "1", "status": "cancelled"}
\`\`\`

Supersede task 1 with task 4 (its dependents now wait on task 4):
\`\`\`json
{"taskId": "1", "status": "cancelled", "supersededBy": "4"}
\`\`\`

Delete a task created by mistake:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`

Complete a verification-gated task, citing the verifier whose verdict was PASS:
\`\`\`json
{"taskId": "3", "status": "completed", "metadata": {"verifiedBy": "<verifier agentId>"}}
\`\`\`

Complete a final-review-gated task, citing the final reviewer that recorded DONE:
\`\`\`json
{"taskId": "4", "status": "completed", "metadata": {"finalReviewedBy": "<final reviewer agentId>"}}
\`\`\`
`
