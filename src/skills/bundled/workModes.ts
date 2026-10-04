import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { isTeammate } from '../../utils/teammate.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * Lead work modes: the on-demand part.
 *
 * The always-on lead prompt (coordinator/workModes.ts) only names the modes
 * and says "in develop mode, load the develop checklist". The checklist lives
 * here so it costs nothing until a request is actually headed for a commit.
 * `/ask` is an optional user override that forces the lighter mode.
 *
 * Model choice is deliberately absent: reviewers and verifiers run "on a
 * different model family", and which models that means comes from the
 * dispatcher and the user's `agentRouting` settings, never from this text.
 */
export const DEVELOP_CHECKLIST = `# /develop — develop-mode checklist

Start your reply with \`Mode: develop\`. Pick the flow, say which, then follow it.

- **Light flow** — the change is confined to a single file and is small.
- **Full flow** — everything else: multi-file or non-trivial. When unsure, full.

## Full flow

1. **Umbrella task.** Create \`Deliver: <the user request verbatim>\` with \`metadata.requiresVerification: true\` and \`metadata.requiresFinalReview: true\`.
2. **Split and implement.** One task per independent piece. Each implementer teammate works in its own git worktree, never in the user's checkout. Brief it with a self-contained spec; ask it to run targeted tests and the typecheck, commit, and report the hash.
3. **Code review.** A reviewer teammate on a different model family than the implementer. Leave \`model\` unset — the dispatcher and \`agentRouting\` pick it and enforce the separation. Send its findings back to the implementer.
4. **Integrate.** Merge the implementers' worktree commits into the target branch as one delivery commit. Everything after this step works on that commit, never on a partial worktree commit.
5. **Verify.** Run the \`verification\` agent on the delivery commit with the original request, the changed files and the approach. On PASS set \`metadata.verifiedBy\` on the umbrella task. FAIL or PARTIAL is an attention item: decide it, fix the earliest wrong input, verify again.
6. **Final review.** Spawn \`final-reviewer\` as a subagent (no \`name\`, no \`team_name\`) with \`review_commit\` set to the delivery commit and \`prompt\` set to the original request verbatim — nothing else. On DONE set \`metadata.finalReviewedBy\`. Every GAP becomes a task: resolve them all, then review again.
7. **Land.** Run the repository's own validation (e.g. its \`bun run check\`-style pre-push checks). Push only if the user asked for a push, and then only a plain fast-forward push. Shut teammates down and confirm with ListAgents.

## Light flow

- Single file and small: one implementer in its own worktree, then the \`verification\` agent — always. Skip the separate code review and the final review.
- A change you could make yourself under §1a is still develop (light), because it gets committed: you may make the edit yourself instead of spawning an implementer, but the \`verification\` agent still runs before the commit.
- The umbrella task gets \`metadata.requiresVerification: true\` only.
- If the change grows beyond one file, escalate to the full flow: say so, add \`requiresFinalReview\`, and run the code review and the final review.

## Rules

- Escalate, never quietly downgrade. An ask that turns into a code change becomes develop before anything is committed.
- Decide every attention item before spawning more; fix the earliest wrong input.
- A reviewer or verifier never runs on the implementer's model family. Never hard-code a model ID.
- Final summary: the commit hash, the verification and review verdicts, what was left undone, and the cost.`

export const ASK_MODE_PROMPT = `# /ask — ask mode

Start your reply with \`Mode: ask\`. Research, investigation or ops: nothing gets committed.

1. Create one task for the request and delegate it to one teammate.
2. Monitor cheaply and wait for its report; ask for a short report with fixed sections.
3. Deliver the result to the user. No verifier and no final review.

If the work turns into a code change, stop before anything is committed, tell the user you are escalating to develop, and load the develop checklist.`

/**
 * The work-mode skills belong to the lead alone: supervision on, and not a
 * teammate (an in-process teammate is caught by its AsyncLocalStorage context,
 * a pane teammate by its dynamic team context).
 */
export function isWorkModeSkillEnabled(
  supervising: () => boolean = isCoordinatorMode,
  teammate: () => boolean = isTeammate,
): boolean {
  return supervising() && !teammate()
}

function withRequest(prompt: string, args: string): string {
  const request = args.trim()
  return request ? `${prompt}\n\n## The request\n\n${request}` : prompt
}

export function registerWorkModeSkills(): void {
  registerBundledSkill({
    name: 'develop',
    description:
      'Develop-mode checklist for the lead: full or light flow for work that will be committed.',
    whenToUse:
      'In develop mode — load it before planning any change that will be committed.',
    argumentHint: '[request]',
    userInvocable: true,
    isEnabled: () => isWorkModeSkillEnabled(),
    async getPromptForCommand(args) {
      return [{ type: 'text', text: withRequest(DEVELOP_CHECKLIST, args) }]
    },
  })

  registerBundledSkill({
    name: 'ask',
    description:
      'Force ask mode: research or ops delegated to one teammate, nothing committed.',
    argumentHint: '[request]',
    userInvocable: true,
    disableModelInvocation: true,
    isEnabled: () => isWorkModeSkillEnabled(),
    async getPromptForCommand(args) {
      return [{ type: 'text', text: withRequest(ASK_MODE_PROMPT, args) }]
    },
  })
}
