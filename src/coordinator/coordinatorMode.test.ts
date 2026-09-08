import { describe, expect, it } from 'bun:test'
import { getCoordinatorSystemPrompt } from './coordinatorMode.js'

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
    expect(prompt).toContain('is a **follow-up update** from that same worker')
    expect(prompt).toContain(
      'it is never a duplicate, a replay, or unexplained output to discard',
    )
  })

  it('explains that <resumed> is a counter, not a boolean', () => {
    expect(getCoordinatorSystemPrompt()).toContain(
      '1 on the first resume, 2 on the second — not a boolean',
    )
  })

  it('keeps the original task-notification example intact', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('<task-id>agent-a1b</task-id>')
    expect(prompt).toContain(
      '<summary>Agent "Investigate auth bug" completed</summary>',
    )
    expect(prompt).toContain(
      '<result>Found null pointer in src/auth/validate.ts:42...</result>',
    )
    expect(prompt).toContain('- `<result>` and `<usage>` are optional sections')
  })
})
