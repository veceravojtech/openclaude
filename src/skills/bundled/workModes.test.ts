import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { CommandBase, PromptCommand } from '../../types/command.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import {
  ASK_MODE_PROMPT,
  DEVELOP_CHECKLIST,
  isWorkModeSkillEnabled,
  registerWorkModeSkills,
} from './workModes.js'

afterEach(() => {
  clearBundledSkills()
})

function findSkill(name: string): CommandBase & PromptCommand {
  const skill = getBundledSkills().find(command => command.name === name)
  if (!skill || skill.type !== 'prompt') {
    throw new Error(`expected /${name} to be registered as a prompt command`)
  }
  return skill
}

async function promptText(name: string, args = ''): Promise<string> {
  const blocks = await findSkill(name).getPromptForCommand(args, {} as never)
  return (blocks[0] as { text: string }).text
}

describe('/develop and /ask registration', () => {
  it('registers both with the bundled skills at startup', () => {
    // initBundledSkills() itself is not called here: it pulls in skills whose
    // optional dependencies are absent from a source checkout. Check its body
    // calls the registrar, and the registrar registers both.
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const body = index.slice(index.indexOf('export function initBundledSkills'))
    expect(body).toContain('registerWorkModeSkills()')
    registerWorkModeSkills()
    const names = getBundledSkills().map(command => command.name)
    expect(names).toContain('develop')
    expect(names).toContain('ask')
  })

  it('makes both user-invocable; only /develop is loadable by the model', () => {
    registerWorkModeSkills()
    const develop = findSkill('develop')
    const ask = findSkill('ask')
    expect(develop.userInvocable).toBe(true)
    expect(ask.userInvocable).toBe(true)
    expect(develop.disableModelInvocation).toBe(false)
    expect(ask.disableModelInvocation).toBe(true)
  })

  it('/develop loads the checklist, plus the request when given', async () => {
    registerWorkModeSkills()
    expect(await promptText('develop')).toBe(DEVELOP_CHECKLIST)
    const withArgs = await promptText('develop', 'add a --json flag')
    expect(withArgs).toContain(DEVELOP_CHECKLIST)
    expect(withArgs).toContain('## The request\n\nadd a --json flag')
  })

  it('/ask loads the ask-mode prompt', async () => {
    registerWorkModeSkills()
    expect(await promptText('ask')).toBe(ASK_MODE_PROMPT)
    expect(ASK_MODE_PROMPT).toContain('`Mode: ask`')
    expect(ASK_MODE_PROMPT).toContain('No verifier and no final review')
    expect(ASK_MODE_PROMPT).toContain('escalating to develop')
  })

  it('/ask lets ask mode cover several angles, in the prompt and the description', () => {
    registerWorkModeSkills()
    const angle = 'one teammate per independent angle (often just one)'
    expect(ASK_MODE_PROMPT).toContain(angle)
    expect(findSkill('ask').description).toContain(angle)
    for (const text of [ASK_MODE_PROMPT, findSkill('ask').description]) {
      expect(text).not.toContain('to one teammate')
    }
  })
})

describe('/develop and /ask scoping', () => {
  it('is enabled only for a supervising lead', () => {
    expect(isWorkModeSkillEnabled(() => true, () => false)).toBe(true)
    expect(isWorkModeSkillEnabled(() => true, () => true)).toBe(false)
    expect(isWorkModeSkillEnabled(() => false, () => false)).toBe(false)
  })

  it('offers both commands to a supervising lead, never to a teammate', () => {
    // bun test does not compile COORDINATOR_MODE in, so the real supervision
    // gate is always off here and a teammate check would pass vacuously.
    // Register with supervision on so the teammate check is what decides.
    registerWorkModeSkills(() => true)
    for (const name of ['develop', 'ask']) {
      const skill = findSkill(name)
      expect(typeof skill.isEnabled).toBe('function')
      // The lead: supervision on, no teammate context.
      expect(skill.isEnabled?.()).toBe(true)

      const inProcess = runWithTeammateContext(
        {
          agentId: 'dev@team',
          agentName: 'dev',
          teamName: 'team',
          planModeRequired: false,
          parentSessionId: 'lead-session',
          isInProcess: true,
          abortController: new AbortController(),
        },
        () => skill.isEnabled?.(),
      )
      expect(inProcess).toBe(false)

      setDynamicTeamContext({
        agentId: 'dev@team',
        agentName: 'dev',
        teamName: 'team',
        planModeRequired: false,
      })
      try {
        expect(skill.isEnabled?.()).toBe(false)
      } finally {
        clearDynamicTeamContext()
      }
    }
  })

  it('hides both commands when supervision is off', () => {
    registerWorkModeSkills(() => false)
    for (const name of ['develop', 'ask']) {
      expect(findSkill(name).isEnabled?.()).toBe(false)
    }
  })

  it('uses the real supervision gate by default', () => {
    // Under bun test COORDINATOR_MODE is not compiled in, so the default gate
    // is off: an unparameterised registration must hide both commands.
    registerWorkModeSkills()
    for (const name of ['develop', 'ask']) {
      expect(findSkill(name).isEnabled?.()).toBe(false)
    }
  })
})

describe('the develop checklist', () => {
  it('has the full flow, in order', () => {
    const steps = [
      '`Deliver: <the user request verbatim>`',
      '`metadata.requiresFinalReview: true`',
      'its own git worktree from the base',
      'on a different model family than the implementer',
      '**Integrate.**',
      'Run the `verification` agent on the delivery commit',
      '`metadata.verifiedBy`',
      'Spawn `final-reviewer` as a subagent',
      '`review_commit` set to the newest delivery commit',
      '`metadata.finalReviewedBy`',
      'as in Target branch',
    ]
    let at = -1
    for (const step of steps) {
      const next = DEVELOP_CHECKLIST.indexOf(step)
      expect(next).toBeGreaterThan(at)
      at = next
    }
  })

  it('states the light flow: single file means verifier only', () => {
    expect(DEVELOP_CHECKLIST).toContain('## Light flow')
    expect(DEVELOP_CHECKLIST).toContain('confined to a single file and is small')
    expect(DEVELOP_CHECKLIST).toContain(
      'then the `verification` agent — always. Skip the separate code review and the final review.',
    )
    expect(DEVELOP_CHECKLIST).toContain(
      'The umbrella task gets `metadata.requiresVerification: true` only.',
    )
    expect(DEVELOP_CHECKLIST).toContain(
      'If the change grows beyond one file, escalate to the full flow',
    )
  })

  it('keeps a §1a edit the lead makes itself in develop, and verified', () => {
    const selfEdit = bullet(section(DEVELOP_CHECKLIST, '## Light flow'), 'A change you could make yourself')
    for (const fragment of [
      'under §1a is still develop (light), because it gets committed',
      'make the edit yourself instead of spawning an implementer',
      'in a worktree from the base',
      'the `verification` agent still runs before it lands',
    ]) {
      expect(selfEdit).toContain(fragment)
    }
  })

  it('never lets the final review see a partial worktree commit', () => {
    const integrate = DEVELOP_CHECKLIST.indexOf('**Integrate.**')
    const finalReview = DEVELOP_CHECKLIST.indexOf('**Final review.**')
    expect(integrate).toBeGreaterThan(-1)
    expect(finalReview).toBeGreaterThan(integrate)
    expect(DEVELOP_CHECKLIST).toContain('never on a partial worktree commit')
  })

  it('reviews the newest delivery commit after post-FAIL fixes', () => {
    expect(DEVELOP_CHECKLIST).toContain(
      'fix the earliest wrong input, integrate the fixes, verify again',
    )
    expect(DEVELOP_CHECKLIST).toContain(
      '`review_commit` set to the newest delivery commit — after any post-FAIL fixes are integrated and re-verified',
    )
  })

  it('verifies the light-flow delivery commit before it lands', () => {
    const delivery = bullet(section(DEVELOP_CHECKLIST, '## Light flow'), "The implementer's commit")
    expect(delivery).toContain('on the base is the delivery commit')
    expect(delivery.indexOf('the verifier runs on it')).toBeGreaterThan(-1)
    expect(delivery.indexOf('then it lands')).toBeGreaterThan(
      delivery.indexOf('the verifier runs on it'),
    )
  })

  it('states the escalation rule', () => {
    expect(DEVELOP_CHECKLIST).toContain('Escalate, never quietly downgrade.')
    expect(DEVELOP_CHECKLIST).toContain(
      'becomes develop before anything is committed',
    )
  })

  it('never hard-codes a model ID', () => {
    for (const text of [DEVELOP_CHECKLIST, ASK_MODE_PROMPT]) {
      expect(text).not.toMatch(/\b(gpt-|claude-|gemini-|sonnet|opus|haiku|o[34]-)/i)
    }
  })
})

/** The text from `heading` up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n## ', start + heading.length)
  return end === -1 ? text.slice(start) : text.slice(start, end)
}

/** The top-level `- ` bullet starting with `lead` (bold or not), sub-bullets included. */
function bullet(text: string, lead: string): string {
  const starts = [`\n- **${lead}`, `\n- ${lead}`].map(s => text.indexOf(s))
  const start = starts.find(i => i > -1) ?? -1
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n- ', start + 1)
  const stop = [end, text.indexOf('\n\n', start + 1)].filter(i => i > -1)
  return text.slice(start + 1, stop.length ? Math.min(...stop) : undefined)
}

/** The nested `  - ` sub-bullet of `parent` that contains `marker`. */
function subBullet(parent: string, marker: string): string {
  const found = parent.split('\n  - ').slice(1).filter(sub => sub.includes(marker))
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('/develop is branch-safe', () => {
  let prompt = ''
  let target = ''
  beforeEach(async () => {
    registerWorkModeSkills()
    prompt = await promptText('develop')
    target = section(prompt, '## Target branch')
  })

  it('records the branch and base first, and stops on a detached HEAD', () => {
    // Recorded before either flow starts, i.e. before any spawn.
    expect(prompt.indexOf('## Target branch')).toBeLessThan(prompt.indexOf('## Full flow'))
    expect(target).toContain('record the target first, before any spawn')
    expect(target).toContain('the rest applies when landing')
    expect(target).toContain('local changes there do not block')

    const record = bullet(target, 'Record')
    for (const fragment of [
      '`git symbolic-ref --short HEAD`',
      'HEAD sha as the base',
      '`git rev-parse --abbrev-ref @{u}`',
      'into the `Deliver:` task description',
    ]) {
      expect(record).toContain(fragment)
    }

    const stop = bullet(target, 'Stop and ask')
    expect(stop).toContain('HEAD is detached')
    for (const op of ['merge', 'rebase', 'cherry-pick', 'bisect']) {
      expect(stop).toContain(op)
    }
    expect(stop).toContain('in progress')
    expect(stop).toContain('`git status`')
  })

  it('bases every worktree on the recorded base, never on a hard-coded branch', () => {
    const worktrees = bullet(target, 'Worktrees')
    expect(worktrees).toContain('from the base sha, never from `main` or the default branch')
    expect(worktrees).toContain('`git worktree add <path> -b <branch> <base-sha>`')
    expect(worktrees).toContain('that exact command in every brief')
    // Every worktree command in the prompt starts from the base sha …
    const adds = prompt.match(/git worktree add[^`]*/g) ?? []
    expect(adds.length).toBeGreaterThan(0)
    for (const add of adds) expect(add).toEndWith('<base-sha>')
    // … and nothing tells the lead to branch off main/master.
    expect(prompt).not.toMatch(/-b\s+\S+\s+(main|master|origin\/\S+)\b/)
    expect(section(prompt, '## Full flow')).toContain(
      'its own git worktree from the base, never in the user\'s checkout',
    )
  })

  it("integrates in a delivery worktree, not the user's checkout", () => {
    const full = section(prompt, '## Full flow')
    const integrate = full.slice(full.indexOf('**Integrate.**'), full.indexOf('5. **Verify.**'))
    for (const fragment of [
      'delivery worktree',
      'from the base sha',
      "never the user's checkout",
      'one delivery commit',
    ]) {
      expect(integrate).toContain(fragment)
    }
    expect(integrate).not.toContain('into the target branch')
    expect(prompt).not.toContain('merged result')
  })

  it('lands fast-forward only, while the tip is still the recorded base', () => {
    const land = bullet(target, 'Land.')
    const ff = subBullet(land, 'merge --ff-only')
    expect(ff).toContain('tip still the recorded base')
    expect(ff).toContain('`git -C <checkout> merge --ff-only <delivery>`')
    expect(ff).toContain('stop and report')
    expect(ff).toContain('never force')
    // An ancestor check would let a branch the user reset backward
    // fast-forward to commits they discarded.
    expect(prompt).not.toContain('is-ancestor')
    // The only command run in the user's checkout is that fast-forward.
    expect(prompt.match(/git -C <checkout> \S+/g)).toEqual(['git -C <checkout> merge'])
    expect(section(prompt, '## Full flow')).toContain('then land, push and clean up as in Target branch')
  })

  it('rebases a moved branch and re-verifies and re-reviews before landing', () => {
    const moved = subBullet(bullet(target, 'Land.'), 'Branch moved')
    expect(moved).toContain('either way')
    expect(moved).toContain('in the delivery worktree')
    expect(moved).toContain('`git rebase --onto <new-tip> <base-sha> <delivery-branch>`')
    const rebase = moved.indexOf('rebase --onto')
    const verify = moved.indexOf('Re-run the verification')
    expect(verify).toBeGreaterThan(rebase)
    expect(moved.indexOf('final review')).toBeGreaterThan(verify)
    expect(moved).toContain("repository's own validation")
    expect(moved).toContain('before landing')
    expect(moved).toContain('On a conflict, stop and ask')

    const gone = subBullet(bullet(target, 'Land.'), 'Switched branches')
    expect(gone).toContain('detached HEAD')
    expect(gone).toContain('stop and report')
  })

  it("pushes only to the target branch's own upstream", () => {
    const push = bullet(target, 'Push')
    expect(push).toContain('only if the user asked')
    expect(push).toContain('`git push <remote> <delivery>:<upstream-branch>`')
    expect(push).toContain("the target branch's own upstream")
    expect(push).toContain('first slash')
    expect(push).toContain('`origin/feat/x` is remote `origin`, branch `feat/x`')
    expect(push).toContain('No upstream')
    expect(push).toContain('Never force')
    expect(push).toContain('never push anywhere but that upstream')
    // On main, main's upstream is the right target: no blanket ban on it.
    expect(prompt).not.toMatch(/push to `?main/i)
    expect(prompt.match(/git push/g)).toHaveLength(1)
    expect(prompt).not.toMatch(/--force|push -f\b/)
  })

  it("never stashes, resets or cleans the user's checkout", () => {
    expect(target).toContain(
      "Never stash, reset, clean or check out anything in the user's checkout",
    )
    expect(prompt).not.toMatch(/git (stash|reset|clean|checkout|switch|restore)\b/)
  })

  it('cleans up the worktrees after landing', () => {
    const cleanUp = bullet(target, 'Clean up')
    expect(cleanUp).toContain('after landing')
    expect(cleanUp).toContain('delivery and implementer worktrees and their branches')
  })

  it('holds the light flow to the same rules', () => {
    const light = section(prompt, '## Light flow')
    expect(light).toContain('one implementer in its own worktree from the base')
    expect(light).toContain('lands as in Target branch')
    expect(bullet(light, 'A change you could make yourself')).toContain('in a worktree from the base')
    expect(light).not.toContain('into the target branch')
  })

  it('is documented in the lead work modes section', () => {
    const docs = readFileSync(
      new URL('../../../docs/agent-routing.md', import.meta.url),
      'utf8',
    )
    const modes = section(docs, '## Lead work modes')
    expect(modes).toContain('`/develop` works on any branch')
    expect(modes).toContain('fast-forward only')
    expect(modes).toContain('still runs before it lands')
    expect(modes).not.toContain('still runs before the commit')
  })
})
