import { afterEach, describe, expect, it } from 'bun:test'
import {
  getCoordinatorSystemPrompt,
  isCoordinatorModeConfigured,
  isCoordinatorStrictConfigured,
} from './coordinatorMode.js'

const SAVED_MODE = process.env.CLAUDE_CODE_COORDINATOR_MODE
const SAVED_STRICT = process.env.CLAUDE_CODE_COORDINATOR_STRICT

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

afterEach(() => {
  restore('CLAUDE_CODE_COORDINATOR_MODE', SAVED_MODE)
  restore('CLAUDE_CODE_COORDINATOR_STRICT', SAVED_STRICT)
})

describe('supervision defaults', () => {
  it('is on with nothing configured, and soft', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    delete process.env.CLAUDE_CODE_COORDINATOR_STRICT

    expect(isCoordinatorModeConfigured()).toBe(true)
    expect(isCoordinatorStrictConfigured()).toBe(false)
  })

  it('turns off only for an explicit falsy value', () => {
    for (const off of ['0', 'false', 'off', 'no'] as const) {
      process.env.CLAUDE_CODE_COORDINATOR_MODE = off
      expect(isCoordinatorModeConfigured()).toBe(false)
    }
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    expect(isCoordinatorModeConfigured()).toBe(true)
  })

  it('never reports strict while supervision is off', () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '0'
    process.env.CLAUDE_CODE_COORDINATOR_STRICT = '1'

    expect(isCoordinatorStrictConfigured()).toBe(false)
  })

  it('swaps the prompt section when strict is set', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    process.env.CLAUDE_CODE_COORDINATOR_STRICT = '1'

    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('You have no hands')
    expect(prompt).not.toContain('You keep every tool')
  })
})

describe('getCoordinatorSystemPrompt — resumed task notifications', () => {
  it('documents the resumed summary wording', () => {
    expect(getCoordinatorSystemPrompt()).toContain(
      'completed a resumed run (resume #',
    )
  })

  it('documents both resumed tags in their wire position', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('<resumed>N</resumed>')
    expect(prompt).toContain('<resumed-prompt>')
    // Wire order: <status> → <resumed> → <resumed-prompt> → <summary>
    const status = prompt.indexOf('<status>completed|failed|killed</status>')
    const resumed = prompt.indexOf('<resumed>N</resumed>')
    const resumedPrompt = prompt.indexOf(
      '<resumed-prompt>{the follow-up request that started this run}</resumed-prompt>',
    )
    const summary = prompt.indexOf('<summary>{human-readable status summary}</summary>')
    expect(status).toBeGreaterThan(-1)
    expect(resumed).toBeGreaterThan(status)
    expect(resumedPrompt).toBeGreaterThan(resumed)
    expect(summary).toBeGreaterThan(resumedPrompt)
  })

  it('tells the leader a resumed notification is an update, not a duplicate', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('is a **follow-up update** from that same teammate')
    expect(prompt).toContain(
      'it is never a duplicate, a replay, or unexplained output to discard',
    )
  })

  it('explains that <resumed> is a counter, not a boolean', () => {
    expect(getCoordinatorSystemPrompt()).toContain(
      '1 on the first resume, 2 on the second — not a boolean',
    )
  })

  it('keeps a worked task-notification example', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('<task-id>investigator@auth-fix</task-id>')
    expect(prompt).toContain('<status>completed</status>')
    expect(prompt).toContain('- `<result>` and `<usage>` are optional sections')
  })
})

describe('getCoordinatorSystemPrompt — supervision', () => {
  it('delegates to teammates, not one-shot workers', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('You are a **supervisor**')
    // The teammate contract the prompt is built on: no inherited history, it
    // persists, and SendMessage is how it gets its next task.
    expect(prompt).toContain('It starts with no history.')
    expect(prompt).toContain('It persists.')
    expect(prompt).toContain('SendMessage')
    expect(prompt).toContain('TeamCreate')
    expect(prompt).not.toContain('subagent_type `worker`')
  })

  it('tells a soft supervisor what it still does itself', () => {
    const prompt = getCoordinatorSystemPrompt()
    // Soft is the default: the pool is intact, so the prompt has to draw the
    // line the tool filter would otherwise draw for it.
    expect(prompt).toContain('You keep every tool')
    expect(prompt).toContain('**Do it yourself**')
    expect(prompt).toContain('**Delegate** everything else')
  })

  it('states the score rule it will be measured by', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('Delegation Score')
    // The numbers must match delegationScore.ts, or the model is being told a
    // rule it is not actually scored by.
    expect(prompt).toContain('**+3**')
    expect(prompt).toContain('**−1**')
    expect(prompt).toContain('Reading, searching and asking cost **nothing**')
    expect(prompt).toContain('a nudge, not a target')
  })

  it('keeps per-teammate model routing on the table', () => {
    // AgentTool only drops the model argument under strict supervision, so the
    // soft prompt must not tell the supervisor to leave models alone.
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('agentRouting')
    expect(prompt).not.toContain('Do not set the model parameter')
  })
})
