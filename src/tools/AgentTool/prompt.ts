import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { LIST_AGENTS_TOOL_NAME } from '../ListAgentsTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', true)
}

/**
 * What `name`, `team_name` and `mode` mean for a LEAD and for a TEAMMATE —
 * both answers in one text, because only one of them can ever reach the model.
 *
 * The three cases are genuinely different. A lead spawns a teammate into the
 * team it names or the team it is already in — and with neither, `name` makes
 * no teammate at all (`resolveTeamName`, `AgentTool.tsx:1773-1782`, returns
 * undefined, the spawn branch at `:481` is skipped, and `:610-614` runs a
 * plain subagent or refuses a prompt-less call). A teammate running inside its
 * lead's session can only spawn into the sub-team it leads, and only once it
 * has created that sub-team (`AgentTool.tsx:437-457`, whose refusals name
 * `TeamCreate` and the `team_name` equality rule). A teammate in its own
 * terminal cannot lead a sub-team at all: `createSubTeam` refuses every caller
 * that is not an in-process teammate (`TeamCreateTool.ts:130-141`), so
 * `readSubTeamLedBy` never finds one for it and `:440-450` refuses its named
 * spawn every time — the only honest thing to tell that reader is to ask its
 * lead.
 *
 * `mode: "plan"` splits along the same seam, and the third bullet says so. The
 * plan arrives as a message for the two readers that bullet names —
 * `useInboxPoller.ts:699-702` for a lead, `inProcessRunner.ts:1351-1384` for a
 * teammate reading the `team-lead` inbox of the sub-team it leads — but not for
 * every spawner, which is why it no longer says "whoever you are": a plain
 * subagent inside a lead's turn is not a teammate, so `AgentTool.tsx:437` is
 * skipped and `:481` spawns a real teammate into the LEAD's team, whose plan
 * reaches the lead and never the subagent that asked for it. Only a lead's own
 * INTERACTIVE session approves one: the auto-approver is gated on
 * `isTeamLead(teamContext)` (`useInboxPoller.ts:641-644`) and answers into its
 * OWN team (`:669-677`), and that poller is a REPL hook (`REPL.tsx:4700`) which
 * does not run under `-p`, where only `shutdown_approved` is handled out of
 * band (`attachments.ts:4382-4384`) and a headless lead answers the request by
 * hand with `SendMessage` (`SendMessageTool/prompt.ts:79`). A sub-team child
 * writes its request to the SUB-team's `team-lead` mailbox
 * (`ExitPlanModeV2Tool.ts:292-300`, that team being the one
 * `AgentTool.tsx:457` substituted); a teammate's own poller returns before any
 * of this (`useInboxPoller.ts:97-99`). Nor can a sub-lead approve by hand:
 * `handlePlanApproval` throws unless `isTeamLead`
 * (`SendMessageTool.ts:479-482`), which compares `getAgentId()` to
 * `teamContext.leadAgentId` (`teammate.ts:171-190`). So nothing within that
 * reader's reach approves a sub-team member spawned with `mode: "plan"` — the
 * ROOT lead still can, out of band, by addressing `child@<sub-team>`
 * (`addressing.ts:126-133` resolves a qualified `to`, and `handlePlanApproval`
 * gates only on ITS own team) — which is why the bullet says nothing approves
 * it AUTOMATICALLY, and tells that reader not to spawn one: the only half it
 * can act on.
 *
 * DO NOT branch this text on the ambient context (an `isInProcessTeammate()`
 * or `isTeammate()` read in the render path, or anything like it). Tool
 * descriptions are memoised process-wide by `toolToAPISchema`
 * (`src/utils/api.ts:207-214`) in the Map at `src/utils/toolSchemaCache.ts:18`,
 * keyed on the tool NAME — `Agent` carries no `inputJSONSchema`, so the key is
 * the bare string `'Agent'` — and cleared only on an auth change or a tool-set
 * change. An in-process teammate shares that process, and that Map, with its
 * lead, and the lead necessarily renders `Agent` before it can spawn a
 * teammate: a context-dependent branch therefore ships the LEAD's text to
 * every teammate, which is exactly how the sub-team rule below stopped
 * reaching the one reader it was written for. Telling both, once, costs a
 * clause and is true in either render order.
 *
 * Rendered only when `isAgentSwarmsEnabled()` — `toolToAPISchema` strips
 * `name`, `team_name` and `mode` from the input schema in that same cache-miss
 * branch when Agent Teams is off (`src/utils/api.ts:89-91,224-227`), and
 * `TeamCreate` is not even registered (`TeamCreateTool.ts:245-247`), so this
 * text would describe parameters the model cannot pass and a tool it does not
 * have. That gate is process-level — env plus a `_CACHED_MAY_BE_STALE` read,
 * the same one the strip above uses — so the description and the schema flip
 * together, and this is NOT the ambient branch the paragraph above forbids.
 */
const TEAMMATE_SPAWN_RULES = `
- \`name\` spawns a TEAMMATE, and which team it lands in depends on who you are: as a LEAD, the team you pass in \`team_name\` or the team you are already in — with neither, \`name\` makes no teammate at all and the call runs an ordinary subagent, which needs a prompt; as a TEAMMATE running inside your lead's session, the sub-team YOU lead, never your own team; as a TEAMMATE running in your own terminal, none — you cannot lead a sub-team there, so a spawn with \`name\` is refused: ask your team lead to create the team and spawn its members instead. Omit \`name\` and you get an ordinary subagent whoever you are.
- To lead a sub-team from inside your lead's session, create it first with \`${TEAM_CREATE_TOOL_NAME}(team_name: "<your team>/<your name>")\`; until it exists the spawn is refused. \`team_name\` is then optional: omit it and your sub-team is used, and if you do pass it, it must name exactly that sub-team.
- \`mode: "plan"\` starts the teammate in plan mode and is the only \`mode\` value a teammate spawn acts on. Its plan reaches you as a message. As a LEAD in an interactive session it is also approved for you automatically. As a TEAMMATE leading a sub-team from inside your lead's session, nothing approves it automatically: your lead auto-approves only requests addressed to its own team, and you cannot approve a plan yourself — so do not spawn your sub-team members with \`mode: "plan"\`. A teammate you spawn works on its own and reports back with ${SEND_MESSAGE_TOOL_NAME}, which states when its messages reach you.`

/**
 * Appended only when `run_in_background` is actually on the schema AND Agent
 * Teams is on, so that being a teammate is a thing that can happen at all —
 * see `backgroundAgentsAvailable` and `teammateSpawnAvailable` in getPrompt().
 * Same reader-attributed shape as TEAMMATE_SPAWN_RULES, and for the same
 * reason.
 */
const TEAMMATE_BACKGROUND_RULE = `
- \`run_in_background\` is not available to you when you are a teammate running inside your lead's session — omit it there; a lead, or a teammate running in its own terminal, can use it.`

/**
 * The default the model should reach for when Agent Teams is on: a team, and
 * named teammates in it. Rendered in the SHARED core so the slim supervisor
 * description carries it too. It only recommends — forks, unnamed subagents
 * and the built-in types keep working, and the built-ins stay the documented
 * exception because the teammate path rejects them (AgentTool.tsx).
 * Gated on `isAgentSwarmsEnabled()` for the same reason as
 * TEAMMATE_SPAWN_RULES: without Agent Teams, `name`/`team_name` and
 * `TeamCreate` do not exist for the model.
 */
const TEAMMATE_DEFAULT_RECOMMENDATION = `

**Default to teammates.** Create a team once with ${TEAM_CREATE_TOOL_NAME}, then spawn every agent with \`name\` (and \`team_name\`) so it joins that team as a teammate. Teammates persist after they report, can be re-tasked with ${SEND_MESSAGE_TOOL_NAME} with their context still loaded, and report back to you — an unnamed subagent or a fork can do none of that. Omitting \`name\` still works; treat it as the fallback, for a built-in type that cannot be a teammate (\`Explore\`, \`Plan\`, \`code-reviewer\`, \`verification\`) or a truly throwaway lookup.`

/**
 * Who owns an objective, and what has to be true before a second agent may
 * touch it. Rendered in the SHARED core alongside
 * TEAMMATE_DEFAULT_RECOMMENDATION, so the slim coordinator description carries
 * it too — the coordinator makes the same spawn decision these rules govern.
 *
 * Reader-attributed, not branched, for the reason TEAMMATE_SPAWN_RULES gives
 * above: the description is memoised process-wide and a teammate reads
 * whatever its lead's render cached, so the nested-delegation clause is stated
 * to both readers rather than gated on being one of them.
 *
 * Gated on `isAgentSwarmsEnabled()` like its neighbours: it names
 * SendMessage and ListAgents, whose own isEnabled() is that same flag
 * (`SendMessageTool.ts:836-838`, `ListAgentsTool.ts:114-115`), so with Agent
 * Teams off it would point at tools the model does not have.
 *
 * Text is the whole mechanism here, deliberately: no code checks ownership.
 * `TEAMMATE-WORKFLOW-ROADMAP.md` ("Rejected designs") records both the
 * topic-record design and the lighter spawn-guard design being rejected, the
 * second because the lead must follow its written rules rather than have a
 * program built around them.
 */
const TEAMMATE_OBJECTIVE_RULES = `

**One objective, one agent.** An objective is owned by the agent working on it, and starting, running, idle, parked and shutting-down agents all hold that ownership.
- Do not spawn a second agent for an objective another agent already owns. Send the follow-up to the owner with ${SEND_MESSAGE_TOOL_NAME} — its context is still loaded, which is the point of a teammate.
- A second agent on the same objective needs the user's approval, asked for before you create the overlap, and two is the ceiling. Silence is not approval, and neither is a request that merely sounds urgent.
- While an owner is still working, do not start a speculative replacement, a competing implementation, or a second investigator for the same question. Wait for its result.
- Capture the result, shut the owner down, then confirm with ${LIST_AGENTS_TOOL_NAME} that it is no longer listed. A completion message or a shutdown acknowledgement is not proof that it stopped. Only then may a successor start on that objective.
- Re-wording the objective, renaming the agent, changing its model or role, or splitting the same work under a new label does not make it a new objective.
- A teammate parked on a usage limit is idle, not finished: it still owns its objective, and the continuation goes to it, not to a replacement.
- These rules bind whoever delegates. If you lead a sub-team they apply unchanged to the objectives you hand out; delegating one level down does not reset the count. Splitting an objective you were given and putting two agents on the same split is still the two-agent case and still needs the user's approval — you cannot approve your own overlap, and a lead cannot grant one on the user's behalf.`

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "When to fork" section
  // (fork semantics, directive-style prompts) and swap in fork-aware examples.
  const forkEnabled = isForkSubagentEnabled()

  // `run_in_background` is stripped from the schema when either of these is
  // set (`inputSchema()`, AgentTool.tsx:141-143), so the description must not
  // offer it then. Both are process-level, unlike the ambient reads this text
  // used to branch on — see TEAMMATE_SPAWN_RULES.
  const backgroundAgentsAvailable =
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !forkEnabled

  // Same rule for the teammate parameters: `name`, `team_name` and `mode` are
  // stripped from the schema when Agent Teams is off (`api.ts:89-91,224-227`),
  // so the text that explains them must go with them. Process-level, like the
  // gate above — see TEAMMATE_SPAWN_RULES. It also gates the FORK render's
  // omit-name/team_name note — `isForkSubagentEnabled()` is independent of this
  // flag, so a fork render with Agent Teams off would otherwise discuss
  // `name`/`team_name` that the same cache-miss branch has just stripped from
  // the schema — and every mention of `SendMessage`, whose own `isEnabled()` is
  // this same `isAgentSwarmsEnabled()` (`SendMessageTool.ts:583-585`): with
  // Agent Teams off that tool is not registered, so naming it would offer a
  // tool the model does not have.
  const teammateSpawnAvailable = isAgentSwarmsEnabled()

  const whenToForkSection = forkEnabled
    ? `

## When to fork
${teammateSpawnAvailable ? `
A fork is the fallback, not the default — a named teammate in your team is still the better choice for work you may want to re-task or hear back on.
` : ''}
Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative \u2014 "will I need this output again" \u2014 not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this \u2014 it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache.

**Don't peek.** The tool result includes an \`output_file\` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.${teammateSpawnAvailable ? ` If you need to course-correct, use ${SEND_MESSAGE_TOOL_NAME} — never Read.` : ''}

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Don't take over.** A fork that looks stuck is usually in its read phase, not failing. ${teammateSpawnAvailable ? `Course-correct with ${SEND_MESSAGE_TOOL_NAME}; never` : 'Never'} write its output yourself or discard its result when it lands. Override belongs to the Review phase.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  const forkExamples = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this \u2014 it's a survey question. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list \u2014 done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn \u2014 the notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn \u2014 notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit \u2014 that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read. The code-reviewer requires the diff inline, so I need to include the changed hunks.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The code-reviewer contract requires the caller to provide the diff or changed hunks inline — the reviewer cannot run git diff itself.${teammateSpawnAvailable ? '\nNote: this is the exception to the "always teammates" default. Do NOT add a name parameter here — code-reviewer is a built-in and will be rejected if spawned as a teammate. Omit name/team_name so it runs as a standard subagent.' : ''}
</commentary>
${AGENT_TOOL_NAME}({
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table with a backfill default.\n\nHere is the diff:\n\`\`\`sql\n--- a/migrations/0042_user_schema.sql\n+++ b/migrations/0042_user_schema.sql\n@@ -0,0 +1,5 @@\n+ALTER TABLE users ADD COLUMN org_id INTEGER NOT NULL DEFAULT 0;\n+UPDATE users SET org_id = (SELECT id FROM orgs WHERE orgs.legacy_id = users.legacy_org_id);\n+ALTER TABLE users ALTER COLUMN org_id DROP DEFAULT;\n\`\`\`\n\nI want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  const currentExamples = `Example usage:

<example_agent_descriptions>
"claude-code-guide": use this agent when the user asks how Claude Code works or how to use its features
"statusline-setup": use this agent to configure the user's Claude Code status line setting
</example_agent_descriptions>

<example>
user: "How do I configure Claude Code hooks?"
<commentary>
This is a Claude Code usage question, so use the claude-code-guide agent
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the claude-code-guide agent
</example>

<example>
user: "Set up my Claude Code status line"
<commentary>
This matches the statusline-setup agent, so use it to configure the setting
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the statusline-setup agent"
</example>
`

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}${teammateSpawnAvailable ? `${TEAMMATE_DEFAULT_RECOMMENDATION}${TEAMMATE_OBJECTIVE_RULES}` : ''}`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // When listing via attachment, the "launch multiple agents" note is in the
  // attachment message (conditioned on subscription there). When inline, keep
  // the existing per-call getSubscriptionType() check.
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    backgroundAgentsAvailable
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
- ${teammateSpawnAvailable ? `To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ` : ''}${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.
- When the current session is outside a git repository (for example a parent folder that contains multiple git repos), set \`cwd\` to the absolute path of the target child repository. You can combine \`cwd\` with \`isolation: "worktree"\` so the worktree is created from that child repo. If worktree creation fails only because no git repository is available, the agent still runs with that \`cwd\` override instead of failing, and the tool result notes that worktree isolation was unavailable.${
    teammateSpawnAvailable ? TEAMMATE_SPAWN_RULES : ''
  }${
    teammateSpawnAvailable && backgroundAgentsAvailable
      ? TEAMMATE_BACKGROUND_RULE
      : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
