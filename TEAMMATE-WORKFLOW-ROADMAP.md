# One objective, one agent — prompt rules roadmap

Created 2026-09-23. Rewritten 2026-09-24. Status: **implemented 2026-09-24** in
`cef56e7b`; no enforcement code was written, by decision.

This was a plan for prompt text, and it shipped as prompt text. The delegation
policy below is carried by written rules in the agent prompts, not by enforcement
code. Two code-enforced designs were drafted and the user rejected both (see
"Rejected designs"); the only code involved is a per-call cap that already
shipped. The prompts named in "Where the rules go" now carry rules 1-7 — see
"What landed" for which commit delivered which part.

## What landed

Three commits, in order. The mapping is exact: each names only the work it
actually delivered.

- `a7c9ad5b` — **feat(agents): cap teammate replicas at 4.** The per-call ceiling
  described in "The code that stays", and nothing else. It predates the rules and
  carries none of them: `MAX_TEAMMATE_REPLICAS_CEILING = 4` with
  `DEFAULT_MAX_TEAMMATE_REPLICAS` set to it
  (`src/tools/AgentTool/teammateReplicas.ts:32-33`), plus the clamp that lets
  `CLAUDE_CODE_MAX_TEAMMATE_REPLICAS` only lower the cap, never raise it. Touches
  `teammateReplicas.ts`, `AgentTool.tsx` and their two test files — no prompt text.
- `3786bedc` — **docs: add prompt-rules roadmap for one objective, one agent.**
  This document. Documentation only: the single file in the commit is
  `TEAMMATE-WORKFLOW-ROADMAP.md`.
- `cef56e7b` — **feat(prompt): one objective, one agent delegation rules.** The
  rules themselves, on both sides — U3 and U4 below, in one commit:
  - Lead side: `TEAMMATE_OBJECTIVE_RULES`
    (`src/tools/AgentTool/prompt.ts:186-195`), rendered in the shared core at
    `:357`, so the slim coordinator description carries it too.
  - Teammate and sub-lead side: the `# Delegating Work to Other Agents` section
    (`src/utils/swarm/teammatePromptAddendum.ts:20-30`).
  - System prompt: the headline sentence only (`src/constants/prompts.ts:323`),
    not a second copy of the list, to limit topic duplication.
  - Plus three test files pinning one distinct phrase per rule. The diff is
    string literals, their doc comments, one tool-name import and tests: no new
    gate and no control-flow change.

### What deliberately did not ship

No enforcement code, and none is pending. The user reduced the scope to prompt
rules only, and the code unit drafted alongside them — an across-call live cap on
agents and a programmatic predecessor-terminated check before a successor may
start — was cancelled, not deferred. It is the second of the two drafts under
"Rejected designs", and neither returns piecemeal. Nothing counts objectives,
nothing reserves them, and nothing verifies a shutdown; the rendered prompt string
is the whole mechanism, which is why the tests pin its wording.

The rules bind whoever is delegating: the lead in a session, and equally a
teammate or sub-lead that delegates further.

## The rules

1. **One objective, one agent by default.** Do not start a second agent on an
   objective another agent is already working on. An objective has one live
   assignment; starting, running, idle, and shutting-down agents all occupy it.
2. **At most two agents on one objective, and only after asking the user.** Ask
   before creating the overlap, not after it exists. Silence is not approval, and
   neither is a user request that merely sounds urgent.
3. **Follow-ups go to the live owner.** Re-task the agent that already owns the
   objective with `SendMessage` instead of shutting it down and spawning a
   replacement. Its context is still loaded; that is the point of a teammate.
4. **Wait for results.** While an assigned agent is still working, do not start a
   speculative replacement, a competing implementation, or a second investigator
   for the same question.
5. **Capture the result, then shut down, then confirm it is gone.** Only then may
   a successor start on that objective. A completion message or a shutdown
   acknowledgement is not proof that the agent stopped.
6. **No renaming around the rules.** Re-wording the objective, renaming the agent,
   changing its model or role, or splitting the same work under a new label does
   not make it a new objective.
7. **Parked teammates still own their objective.** A teammate parked on a usage
   limit is idle, not finished; continuation goes to the parked owner, not to a
   replacement. `parked` is already a distinct idle reason in the mailbox state
   (`src/utils/teammateMailbox.ts:408`).

### The same rules bind nested delegation

A teammate that leads a sub-team, and a sub-lead spawning its own workers, follow
rules 1-7 unchanged for the objectives they hand out. Delegating one level down
does not reset the count. If a teammate splits the objective it was given and
wants two agents on the same split, that is rule 2 and it needs the user's
approval. The approval is the user's: a teammate cannot approve its own overlap,
and a lead cannot grant one on the user's behalf.

## Workflows

Both sequences below are kept only as far as they express the rules above.

### Development

Investigate → develop → code review → repair → validate and close. Each stage is
one assignment on the same objective, and each hands the next stage its result.
Between stages: capture the result, shut the agent down, confirm it is gone
(rule 5). If review finds in-scope problems, repeat investigate → develop →
review on the same objective rather than opening a second one (rule 6). Close
only after findings are resolved and every assignment is terminated.

### Ordinary tasks

Execute → capture the result → shut down → confirm termination → next step or
close.

Research, explanation, and planning tasks use the same ownership and cleanup
rules; they do not automatically need development or review stages. A follow-up
on the same objective goes to the live owner (rule 3), not to a second agent.

## Where the rules go

Line numbers below are current as of `cef56e7b`. This map was drawn before the
rules landed, so it names the neighbourhood each block sits in rather than the
final home: on the lead side the rules went into a new constant beside these,
`TEAMMATE_OBJECTIVE_RULES` at `src/tools/AgentTool/prompt.ts:186-195`, not inside
`TEAMMATE_DEFAULT_RECOMMENDATION`.

Lead side — the delegating agent's own instructions:

- `src/tools/AgentTool/prompt.ts:135` — `TEAMMATE_SPAWN_RULES`, the per-parameter
  rules block rendered into the Agent tool description.
- `src/tools/AgentTool/prompt.ts:147` — `TEAMMATE_BACKGROUND_RULE`, an adjacent
  block under the same gating pattern.
- `src/tools/AgentTool/prompt.ts:160` — `TEAMMATE_DEFAULT_RECOMMENDATION`, the
  "**Default to teammates.**" block (body at `:162`). It already tells the lead
  that a teammate persists and can be re-tasked with `SendMessage`, which is why
  rules 1 and 3 render directly after it.
- `src/tools/AgentTool/prompt.ts:231` — `const teammateSpawnAvailable =
  isAgentSwarmsEnabled()`, the gate that keeps teammate text out of the tool
  description when Agent Teams is off. The rule text sits behind this same gate;
  with Agent Teams off the parameters and `SendMessage` do not exist for the model.
- `src/constants/prompts.ts:316` — `getAgentToolSection()`, the system-prompt
  delegation text. Its Agent-Teams branch is the "When you delegate, strongly
  prefer a team…" return at `:323`, gated by `isAgentSwarmsEnabled()` at `:322`.

Teammate and sub-lead side — nested delegation:

- `src/utils/swarm/teammatePromptAddendum.ts:9` —
  `TEAMMATE_SYSTEM_PROMPT_ADDENDUM`, whose "# Agent Teammate Communication"
  section is `:10-18`. This is the one teammate addendum; the delegation rules
  were appended to it as a second section, `:20-30`.
- `src/main.tsx:1320-1324` — injection for pane/tmux teammates. The addendum is
  appended to `appendSystemPrompt` when `isAgentSwarmsEnabled()` and the
  agentId/agentName/teamName triple is present.
- `src/utils/swarm/inProcessRunner.ts:2239-2242` — injection for in-process
  teammates. The addendum is pushed into `systemPromptParts` after the full
  main-agent system prompt.

Both injection sites read the same constant, so the nested-delegation rules are
written once in `teammatePromptAddendum.ts` and reach both backends. There is no
second addendum to keep in sync, and no pane-only or in-process-only wording.

## Rejected designs

A heavy design was drafted first: persisted topic, assignment, handoff, and
approval records, atomic reserve-before-spawn, cross-process locks, generation
fencing so a late event cannot overwrite a successor, and a scoped user-approval
flow. The user rejected it. The reason on record: the lead chooses the topic IDs,
so a code topic guard cannot stop it inventing new ones.

A lighter code-enforced design was drafted next: surface the live agent list at
spawn time, cap live replica agents at 4 across calls rather than per call, and
require a termination check before a successor starts. The user rejected this
too. The reason on record: the lead must follow his written rules, and there is
no need to build a program around it.

Neither design returns piecemeal. No topic records, no persistence, no locks, no
generation binding, no approval flow in code, no spawn-time agent listing, no
across-call cap, and no programmatic termination check.

## The code that stays

One piece of code in this area already shipped and stays as it is:
`MAX_TEAMMATE_REPLICAS_CEILING = 4` with `DEFAULT_MAX_TEAMMATE_REPLICAS` set to
it, at `src/tools/AgentTool/teammateReplicas.ts:32-33`, from commit `a7c9ad5b`
("feat(agents): cap teammate replicas at 4"). It is a per-call cap: one spawn
call cannot ask for more than four replicas, and the env override is clamped to
the same ceiling. It counts nothing across calls and knows nothing about
objectives. No across-call live cap is being added; rules 1 and 2 cover that, in
prose.

## The three slices

Three separately committable slices. None of them adds enforcement code. U3 and
U4 landed together in `cef56e7b`; U5 is the remainder.

### U3 — lead-side prompt rules

Status: **done** — `cef56e7b`. `TEAMMATE_OBJECTIVE_RULES` at
`src/tools/AgentTool/prompt.ts:186-195`, rendered at `:357`; headline sentence at
`src/constants/prompts.ts:323`. Exit criterion met and pinned by
`src/tools/AgentTool/prompt.test.ts` and
`src/constants/prompts.agentTeams.test.ts`, which assert both the Agent-Teams-on
and Agent-Teams-off branches.

Write rules 1-7 into the lead's own instructions, behind the existing
`isAgentSwarmsEnabled()` gates.

Files: `src/tools/AgentTool/prompt.ts`, `src/constants/prompts.ts`, plus the
prompt snapshot and tool-description tests covering them.

Exit criterion: with Agent Teams on, the rendered tool description and system
prompt carry the rules; with Agent Teams off, neither mentions them.

### U4 — teammate and sub-lead prompt rules

Status: **done** — `cef56e7b`, the same commit as U3. The
`# Delegating Work to Other Agents` section at
`src/utils/swarm/teammatePromptAddendum.ts:20-30`. `src/main.tsx` and
`src/utils/swarm/inProcessRunner.ts` are listed below but needed no edit: both
injection sites already read that one constant, which is exactly what this slice
predicted. Pinned by `src/utils/swarm/teammatePromptAddendum.test.ts`.

Write the nested-delegation rules into the teammate addendum and confirm both
injection paths still carry it.

Files: `src/utils/swarm/teammatePromptAddendum.ts`, `src/main.tsx`,
`src/utils/swarm/inProcessRunner.ts`, plus their tests.

Exit criterion: a pane teammate and an in-process teammate both receive the rules
from that one constant.

### U5 — validation, docs, and reinstall

Status: **outstanding** at the time of writing. `cef56e7b` ran the three prompt
test files (28 tests), `typecheck` and `build` green, but the full pre-push
contract, the user-facing docs, and the reinstall-and-read-back are still open.
Rebase onto `main` and the push are owed as well
([CONTRIBUTING § Keep Your Branch Current](CONTRIBUTING.md#keep-your-branch-current));
neither has been done.

Run the authoritative [pre-push validation contract](CONTRIBUTING.md#validation),
update any user-facing docs that describe delegation, reinstall, and read the
rules back out of a live lead prompt and a live teammate prompt.

Files: the docs the wording change touches; no source files beyond U3 and U4.

Exit criterion: the required checks pass and the rules appear verbatim in a live
session.

The rules are now written into those prompts. What remains before this roadmap
closes is U5: reading them back out of a live lead prompt and a live teammate
prompt after a reinstall, plus the docs and validation that go with it. There is
no enforcement code to verify, because none was built.

## Relationship to existing follow-up work

Keep the validation-driver attribution defect, model-picker suite failure,
scanner buffer failure, isolated compaction work, and isolated progress work as
separate tracked topics. Their blockers and restoration requirements remain in
[FOLLOW-UP.md](FOLLOW-UP.md). Do not restore those stashes as part of this work
or merge their unrelated repairs into the prompt change.

Writing this document changed no behaviour; `cef56e7b` did. The prompts in "Where
the rules go" now carry rules 1-7, so an agent running with Agent Teams enabled
receives them as instructions rather than as a plan. With Agent Teams off it
receives none of them: every block sits inside the pre-existing
`isAgentSwarmsEnabled()` gates.
