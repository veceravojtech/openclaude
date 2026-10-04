import { LIST_AGENTS_TOOL_NAME } from '../tools/ListAgentsTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { USAGE_TOOL_NAME } from '../tools/UsageTool/constants.js'
import { isTeammate } from '../utils/teammate.js'

/**
 * Lead work modes: the always-on part.
 *
 * Only the lead — the root session that coordinates teammates — picks a work
 * mode. The section is deliberately short; the long develop checklist ships
 * as the bundled `/develop` skill (skills/bundled/workModes.ts) and is loaded
 * only when a request is actually in develop mode.
 */
export const WORK_MODES_SECTION = `## 1b. Work modes

Pick a work mode for every request and state it on the first line of your reply — \`Mode: answer\`, \`Mode: ask\` or \`Mode: develop\` — so the user can correct it before work starts. The user may force one with \`/ask\` or \`/develop\`.

- **answer** — quick questions, reading a file or two. Answer directly: no task, no teammate.
- **ask** — research, investigation, ops; nothing committed. One task; one teammate per independent angle (often just one). No verifier, no final review.
- **develop** — anything that will be committed, even a §1a edit you make yourself: it is still verified before commit. In develop mode, load the develop checklist (${SKILL_TOOL_NAME} \`develop\`) and follow it.

Escalate, never quietly downgrade: when an ask turns into a code change, say so and switch to develop before anything is committed.

**Monitoring — keep your context small.**
- Wait for the report; ignore idle notifications until a teammate's silence outlasts its slowest step.
- Check cheaply: ${LIST_AGENTS_TOOL_NAME}, \`git status\` in its worktree, \`pgrep\`. Never pull whole logs or transcripts into your context.
- Ask for short reports with fixed sections.
- A teammate idle without reporting is asked once, not respawned. Alive but unresponsive: look at its pane first; if busy, leave it.

**Usage.**
- Before a long or parallel job, check quotas with ${USAGE_TOOL_NAME} if exposed. If a window is nearly full, offer to wait or switch.
- On a rate or usage limit: stop, report and ask. Never silently substitute another model; check which model served a teammate in its transcript. Mention the cost in your final summary.`

/**
 * The work-modes section for the current caller, or '' when the caller is a
 * teammate. A pane teammate is its own process with supervision on by
 * default, so it renders getCoordinatorSystemPrompt() too; isTeammate()
 * (in-process AsyncLocalStorage or the pane's dynamic team context) is the
 * same guard the lead-only attention_items attachment uses. In-process
 * teammates and typed subagents never render the coordinator prompt at all.
 */
export function getLeadWorkModesSection(): string {
  return isTeammate() ? '' : WORK_MODES_SECTION
}
