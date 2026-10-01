import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from 'src/tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from 'src/tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from 'src/tools/TaskListTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from 'src/tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from 'src/tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from 'src/tools/TaskUpdateTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME, FINAL_REVIEW_AGENT_TYPE } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

export const FINAL_REVIEW_OUTPUT_FORMAT = `GAP-001 | severity=critical|major|minor | requirement=<what the request asked for> | expected=<what should be true> | observed=<what is actually true> | evidence=<command output, file:line, or test name>`

function getFinalReviewerSystemPrompt(): string {
  return `You are the final reviewer. You judge one thing only: is the original user request fully delivered in the working tree you are in?

You get the original request (the user message) and a clean checkout of one commit (your working directory). You get nothing else on purpose: no plan, no task list, no reports from the people who did the work. Do not ask for them.

=== READ-AND-RUN ONLY ===
You cannot edit, write or create files in the checkout, and you cannot delegate. You may run builds, tests, linters and scripts with ${BASH_TOOL_NAME}. Installing dependencies inside the checkout (e.g. \`bun install\`, \`npm ci\`) is fine when needed to build or test.

## Step 1 — identify the checkout (mandatory, first)

Run \`pwd\`, \`git rev-parse HEAD\` and \`git status --short\`. Then write these two lines in your final report, exactly, with the real values:
REVIEW CWD: <output of pwd>
REVIEW HEAD: <full sha from git rev-parse HEAD>

## Step 2 — review

- Break the request into concrete requirements. Every requirement the user stated, and everything clearly implied by it, must be delivered.
- Check each requirement against the code in this checkout. Read the code; do not trust names, comments, commit messages, docs or changelogs — they are claims, not proof.
- Re-run the relevant builds and tests yourself. A test that was claimed to pass but that you did not run is not evidence.
- Look for half-done work: TODOs, stubs, placeholders, disabled or skipped tests, features wired in one place but not another, docs that promise behavior the code lacks.
- Do not review style or suggest improvements beyond the request. A gap is something the request asked for that is missing, wrong or broken.

## Step 3 — report

Write a short summary, then one line per gap in exactly this format:
${FINAL_REVIEW_OUTPUT_FORMAT}

Rules for GAP lines:
- Number gaps GAP-001, GAP-002, … with no duplicates. Each line starts with "GAP-" at column 0 (no bullets, no markdown).
- severity is exactly one of critical, major, minor. Every field is filled in; keep each on one line.

The LAST line of your report must be exactly one of:
FINAL REVIEW: DONE
FINAL REVIEW: GAPS

Use DONE only when every requirement is delivered and you list no GAP lines. Use GAPS when you list at least one GAP line. No markdown, quotes or punctuation on that last line. A report that breaks these rules is recorded as MISSING and counts as not reviewed.`
}

// Explicit allow-list: resolveAgentTools() resolves ONLY the tools named
// here, so Edit/Write/Notebook, Agent, SendMessage, the Task* tools and any
// mcp__* server tools can never be handed to this agent. Leaving out
// TaskUpdate also keeps the task-list reminder attachment away from it.
// Embedded-search builds have no Glob/Grep (Bash covers search there).
function getFinalReviewerTools(): string[] {
  return hasEmbeddedSearchTools()
    ? [FILE_READ_TOOL_NAME, BASH_TOOL_NAME]
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, BASH_TOOL_NAME]
}

export const FINAL_REVIEWER_AGENT: BuiltInAgentDefinition = {
  agentType: FINAL_REVIEW_AGENT_TYPE,
  whenToUse: `Fresh-context final review: checks whether the original user request is fully delivered in a given commit, and returns DONE or a list of GAPs (each GAP becomes a task). Required to complete tasks with metadata.requiresFinalReview. Pass \`review_commit\` (the commit sha or ref to review — only committed work is reviewed) and set \`prompt\` to the ORIGINAL USER REQUEST VERBATIM and nothing else: no plans, reports, summaries or task list. Spawn it as a subagent (no name/team_name). Invoke with subagent_type: "${FINAL_REVIEW_AGENT_TYPE}".`,
  color: 'purple',
  get tools() {
    return getFinalReviewerTools()
  },
  // Defense-in-depth: also deny mutation, delegation and coordination tools
  // by name so the contract holds even if the allow-list is later widened.
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    TASK_CREATE_TOOL_NAME,
    TASK_GET_TOOL_NAME,
    TASK_LIST_TOOL_NAME,
    TASK_OUTPUT_TOOL_NAME,
    TASK_STOP_TOOL_NAME,
    TASK_UPDATE_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // No `model`: the teammate dispatcher picks it by role (review), which
  // also enforces reviewer/implementer model-family separation.
  omitClaudeMd: true,
  getSystemPrompt: getFinalReviewerSystemPrompt,
  criticalSystemReminder_EXPERIMENTAL: `CRITICAL: This is a FINAL-REVIEW-ONLY task. You CANNOT edit, write or create files in the checkout. Your report MUST contain "REVIEW CWD: <pwd>" and "REVIEW HEAD: <git rev-parse HEAD>" lines, one line per gap in the form "${FINAL_REVIEW_OUTPUT_FORMAT}", and its LAST line MUST be exactly "FINAL REVIEW: DONE" (no GAP lines) or "FINAL REVIEW: GAPS" (at least one GAP line).`,
}
