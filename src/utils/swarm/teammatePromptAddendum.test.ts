import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'

/** One distinct phrase per delegation rule, in TEAMMATE-WORKFLOW-ROADMAP.md order. */
const RULE_PHRASES: Array<[string, string]> = [
  ['rule 1 - one objective, one agent', 'One objective, one agent.'],
  ['rule 2 - two is the ceiling, user approves first', 'two is the ceiling'],
  ['rule 3 - follow-ups go to the live owner', 'Send the follow-up to the owner with `SendMessage`'],
  ['rule 4 - wait for results', 'do not start a speculative replacement'],
  ['rule 5 - confirm it is gone', 'confirm with `ListAgents` that it is no longer listed'],
  ['rule 6 - no renaming around the rules', 'does not make it a new objective'],
  ['rule 7 - parked teammates still own their objective', 'parked on a usage limit is idle, not finished'],
]

test.each(RULE_PHRASES)('teammate addendum carries %s', (_label, phrase) => {
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(phrase)
})

test('teammate addendum binds nested delegation', () => {
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain('These rules bind whoever delegates.')
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(
    'delegating one level down does not reset the count',
  )
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain('you cannot approve your own overlap')
})

test('teammate addendum keeps the pre-existing communication guidance', () => {
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain('# Agent Teammate Communication')
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(
    'Use the SendMessage tool with `to: "<name>"` to send messages to specific teammates',
  )
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(
    'Use the SendMessage tool with `to: "*"` sparingly for team-wide broadcasts',
  )
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(
    'you MUST use the SendMessage tool',
  )
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain(
    'The user interacts primarily with the team lead.',
  )
  // The delegation section is appended after the communication section, not in place of it.
  expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM.indexOf('# Agent Teammate Communication')).toBeLessThan(
    TEAMMATE_SYSTEM_PROMPT_ADDENDUM.indexOf('# Delegating Work to Other Agents'),
  )
})

test('both teammate backends inject this one constant', () => {
  // Pane/tmux teammates: src/main.tsx appends it to appendSystemPrompt.
  const mainSource = readFileSync(join(import.meta.dir, '../../main.tsx'), 'utf8')
  expect(mainSource).toContain('TEAMMATE_SYSTEM_PROMPT_ADDENDUM')
  // In-process teammates: inProcessRunner.ts pushes it into systemPromptParts.
  const runnerSource = readFileSync(join(import.meta.dir, 'inProcessRunner.ts'), 'utf8')
  expect(runnerSource).toContain('TEAMMATE_SYSTEM_PROMPT_ADDENDUM')
})
