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
      'its own git worktree from the base, never in the user\'s checkout',
      'on a different model family than the implementer',
      "**Integrate.** In a delivery worktree from the base sha, never the user's checkout, merge the implementers' worktree commits as one delivery commit",
      'Run the `verification` agent on the delivery commit',
      '`metadata.verifiedBy`',
      'Spawn `final-reviewer` as a subagent',
      '`review_commit` set to the newest delivery commit',
      '`metadata.finalReviewedBy`',
      'then land, push and clean up as in Target branch',
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
    expect(DEVELOP_CHECKLIST).toContain(
      'A change you could make yourself under §1a is still develop (light), because it gets committed',
    )
    expect(DEVELOP_CHECKLIST).toContain(
      "you may make the edit yourself instead of spawning an implementer, in a worktree from the base, never the user's checkout, but the `verification` agent still runs before it lands",
    )
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
    const light = DEVELOP_CHECKLIST.slice(DEVELOP_CHECKLIST.indexOf('## Light flow'))
    expect(light).toContain(
      "The implementer's commit on the base is the delivery commit: the verifier runs on it, then it lands as in Target branch.",
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
    expect(target).toContain('Both flows do this first, before any spawn.')
    expect(target).toContain('its branch (`git symbolic-ref --short HEAD`)')
    expect(target).toContain('its HEAD sha as the base')
    expect(target).toContain('its upstream if any (`git rev-parse --abbrev-ref @{u}`)')
    expect(target).toContain('Write the branch and base into the `Deliver:` task description.')
    expect(target).toContain(
      '**Stop and ask** if HEAD is detached, or a merge, rebase, cherry-pick or bisect is in progress.',
    )
    expect(target).toContain('local changes there do not block')
  })

  it('bases every worktree on the recorded base, never on a hard-coded branch', () => {
    expect(target).toContain(
      'branch from the base sha, never from `main` or the default branch: `git worktree add <path> -b <branch> <base-sha>`',
    )
    expect(target).toContain('put that exact command in every brief')
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
    expect(integrate).toContain("In a delivery worktree from the base sha, never the user's checkout")
    expect(integrate).not.toContain('into the target branch')
    expect(prompt).not.toContain('merged result')
  })

  it('lands fast-forward only, and re-verifies or stops when the branch changed', () => {
    const land = target.slice(target.indexOf('**Land.**'), target.indexOf('**Push**'))
    expect(land).toContain('`git merge-base --is-ancestor <tip> <delivery>`')
    expect(land).toContain('`git -C <checkout> merge --ff-only <delivery>`')
    expect(land).toContain('if git refuses, stop and report, never force it')
    expect(land).toContain(
      'Branch moved: rebase the delivery commit onto the new tip in the delivery worktree and verify again before landing',
    )
    expect(land).toContain('on a conflict, stop and ask')
    expect(land).toContain('Switched branches or detached: stop and report.')
    // The only merge into the user's checkout is the fast-forward.
    expect(prompt.match(/git -C <checkout> \S+/g)).toEqual(['git -C <checkout> merge'])
    expect(section(prompt, '## Full flow')).toContain(
      'then land, push and clean up as in Target branch',
    )
  })

  it("pushes only to the target branch's own upstream", () => {
    expect(target).toContain(
      "**Push** only if the user asked: `git push <remote> <delivery>:<upstream-branch>` — a plain fast-forward to the target branch's own upstream",
    )
    expect(target).toContain('no upstream, or another branch wanted: ask')
    expect(target).toContain("Never push to `main` or any branch the user didn't name.")
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
    expect(target).toContain(
      '**Clean up** after landing: remove the delivery and implementer worktrees and their branches.',
    )
  })

  it('holds the light flow to the same rules', () => {
    const light = section(prompt, '## Light flow')
    expect(light).toContain('one implementer in its own worktree from the base')
    expect(light).toContain('the verifier runs on it, then it lands as in Target branch')
    expect(light).toContain("in a worktree from the base, never the user's checkout")
    expect(light).not.toContain('into the target branch first')
  })

  it('is documented in the lead work modes section', () => {
    const docs = readFileSync(
      new URL('../../../docs/agent-routing.md', import.meta.url),
      'utf8',
    )
    const modes = section(docs, '## Lead work modes')
    expect(modes).toContain('`/develop` works on any branch')
    expect(modes).toContain('fast-forward only')
  })
})
