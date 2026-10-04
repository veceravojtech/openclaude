import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { CommandBase, PromptCommand } from '../../types/command.js'
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
})

describe('/develop and /ask scoping', () => {
  it('is enabled only for a supervising lead', () => {
    expect(isWorkModeSkillEnabled(() => true, () => false)).toBe(true)
    expect(isWorkModeSkillEnabled(() => true, () => true)).toBe(false)
    expect(isWorkModeSkillEnabled(() => false, () => false)).toBe(false)
  })

  it('wires isEnabled to that gate on both commands', () => {
    registerWorkModeSkills()
    for (const name of ['develop', 'ask']) {
      const skill = findSkill(name)
      expect(typeof skill.isEnabled).toBe('function')
      // bun test does not compile COORDINATOR_MODE in, so supervision is off
      // here and the real gate must say no.
      expect(skill.isEnabled?.()).toBe(isWorkModeSkillEnabled())
    }
    const source = readFileSync(new URL('./workModes.ts', import.meta.url), 'utf8')
    expect(source.match(/isEnabled: \(\) => isWorkModeSkillEnabled\(\)/g)).toHaveLength(2)
  })
})

describe('the develop checklist', () => {
  it('has the full flow, in order', () => {
    const steps = [
      '`Deliver: <the user request verbatim>`',
      '`metadata.requiresFinalReview: true`',
      'its own git worktree, never in the user\'s checkout',
      'on a different model family than the implementer',
      'Run the `verification` agent',
      '`metadata.verifiedBy`',
      'spawn `final-reviewer` as a subagent',
      '`review_commit`',
      '`metadata.finalReviewedBy`',
      'Push only if the user asked for a push',
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
