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

## Target branch

Both flows record the target first, before any spawn; the rest applies when landing. Never stash, reset, clean or check out anything in the user's checkout; local changes there do not block.

- **Record** the checkout path, its branch (\`git symbolic-ref --short HEAD\`), its HEAD sha as the base, and its upstream if any (\`git rev-parse --abbrev-ref @{u}\`). Write branch and base into the \`Deliver:\` task description.
- **Stop and ask** if HEAD is detached, or a merge, rebase, cherry-pick or bisect is in progress (\`git status\` shows all of these).
- **Worktrees** branch from the base sha, never from \`main\` or the default branch: \`git worktree add <path> -b <branch> <base-sha>\`. Teammates get no worktree on their own: put that exact command in every brief.
- **Land.** Re-check the checkout first.
  - Still on the target branch and its tip still the recorded base: \`git -C <checkout> merge --ff-only <delivery>\`. If git refuses (e.g. local files it would overwrite), stop and report; never force it.
  - Branch moved, either way (new commits, or reset/amended): in the delivery worktree, \`git rebase --onto <new-tip> <base-sha> <delivery-branch>\`; the new tip is now the base. Re-run the verification on the new delivery commit — in the full flow also the final review and the repository's own validation — before landing. On a conflict, stop and ask.
  - Switched branches or detached HEAD: stop and report.
- **Push** only if the user asked: \`git push <remote> <delivery>:<upstream-branch>\`, a plain fast-forward to the target branch's own upstream. Split the recorded upstream on its first slash: \`origin/feat/x\` is remote \`origin\`, branch \`feat/x\`. No upstream, or the user wants another branch: ask. Never force, and never push anywhere but that upstream.
- **Clean up** after landing: remove the delivery and implementer worktrees and their branches.

## Full flow

1. **Umbrella task.** After Target branch, create \`Deliver: <the user request verbatim>\` with \`metadata.requiresVerification: true\` and \`metadata.requiresFinalReview: true\`.
2. **Split and implement.** One task per independent piece. Each implementer teammate works in its own git worktree from the base, never in the user's checkout. Brief it with a self-contained spec and the worktree command; ask it to run targeted tests and the typecheck, commit, and report the hash.
3. **Code review.** A reviewer teammate on a different model family than the implementer. Leave \`model\` unset — the dispatcher and \`agentRouting\` pick it and enforce the separation. Send its findings back to the implementer.
4. **Integrate.** In a delivery worktree from the base sha, never the user's checkout, merge the implementers' worktree commits as one delivery commit. Everything after this step works on that commit, never on a partial worktree commit.
5. **Verify.** Run the \`verification\` agent on the delivery commit with the original request, the changed files and the approach. On PASS set \`metadata.verifiedBy\` on the umbrella task. FAIL or PARTIAL is an attention item: decide it, fix the earliest wrong input, integrate the fixes, verify again.
6. **Final review.** Spawn \`final-reviewer\` as a subagent (no \`name\`, no \`team_name\`) with \`review_commit\` set to the newest delivery commit — after any post-FAIL fixes are integrated and re-verified — and \`prompt\` set to the original request verbatim — nothing else. On DONE set \`metadata.finalReviewedBy\`. Every GAP becomes a task: resolve them all, then review again.
7. **Land.** Run the repository's own validation (e.g. its \`bun run check\`) on the delivery commit, then land, push and clean up as in Target branch. Shut teammates down and confirm with ListAgents.

## Light flow

- Single file and small: one implementer in its own worktree from the base, then the \`verification\` agent — always. Skip the separate code review and the final review.
- The implementer's commit on the base is the delivery commit: the verifier runs on it, then it lands as in Target branch.
- A change you could make yourself under §1a is still develop (light), because it gets committed: you may make the edit yourself instead of spawning an implementer, in a worktree from the base, but the \`verification\` agent still runs before it lands.
- The umbrella task gets \`metadata.requiresVerification: true\` only.
- If the change grows beyond one file, escalate to the full flow: say so, add \`requiresFinalReview\`, and run the code review and the final review.

## Rules

- Escalate, never quietly downgrade. An ask that turns into a code change becomes develop before anything is committed.
- Decide every attention item before spawning more; fix the earliest wrong input.
- A reviewer or verifier never runs on the implementer's model family. Never hard-code a model ID.
- Final summary: the commit hash, the verification and review verdicts, what was left undone, and the cost.`

export const ASK_MODE_PROMPT = `# /ask — ask mode

Start your reply with \`Mode: ask\`. Research, investigation or ops: nothing gets committed.

1. Create one task for the request and delegate it: one teammate per independent angle (often just one).
2. Monitor cheaply and wait for the reports; ask for short reports with fixed sections.
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

/**
 * `supervising` is injectable so tests can register the commands with
 * supervision on: COORDINATOR_MODE is a compile-time feature that bun test
 * does not enable, so the real gate always says "off" there.
 */
export function registerWorkModeSkills(
  supervising: () => boolean = isCoordinatorMode,
): void {
  const isEnabled = (): boolean => isWorkModeSkillEnabled(supervising)

  registerBundledSkill({
    name: 'develop',
    description:
      'Develop-mode checklist for the lead: full or light flow for work that will be committed.',
    whenToUse:
      'In develop mode — load it before planning any change that will be committed.',
    argumentHint: '[request]',
    userInvocable: true,
    isEnabled,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: withRequest(DEVELOP_CHECKLIST, args) }]
    },
  })

  registerBundledSkill({
    name: 'ask',
    description:
      'Force ask mode: research or ops, one teammate per independent angle (often just one), nothing committed.',
    argumentHint: '[request]',
    userInvocable: true,
    disableModelInvocation: true,
    isEnabled,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: withRequest(ASK_MODE_PROMPT, args) }]
    },
  })
}
