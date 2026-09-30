export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
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

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Verification-Gated Tasks

A task whose metadata has \`requiresVerification: true\` can only be marked \`completed\` when \`metadata.verifiedBy\` is the agentId of a verification agent run (subagent_type "verification") whose recorded verdict is PASS. Otherwise the update is rejected and nothing is changed. Tasks without the flag complete as usual.

- Run the verification agent with the Agent tool. Its verdict (the final \`VERDICT: PASS|FAIL|PARTIAL\` line of its report) is recorded under its agentId when the run finishes.
- Get the verifier agentId from the Agent tool result: a synchronous run ends with an \`agentId: <id>\` line followed by a \`verificationVerdict: <verdict>\` line; a background run returns its agentId at launch, and its completion notification carries the same id as the task-id.
- FAIL, PARTIAL, a report with no VERDICT line, or an agentId with no recorded verdict all block completion. Fix the work, run a new verification, and cite the new verifier's agentId.
- \`verifiedBy\` can be set in the same call that completes the task. The \`requiresVerification\` flag cannot be cleared in that call to skip the check.

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

Delete a task:
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
`
