import { expect, test } from 'bun:test'
import { asAgentId } from '../../types/ids.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { getPrompt } from './prompt.js'

// T4/F3: "Messages from teammates are delivered automatically; you don't check
// an inbox" was only true for the lead (useInboxPoller) — an in-process
// teammate read its own inbox nowhere but the idle loop, so a message sent to
// a BUSY teammate sat unread for the whole turn. F1/F2 make the promise true
// mid-turn; this pins the sentence that now states when a message arrives, so
// the claim and the delivery path stay in step.
// T5/F2: that sentence then over-promised in the other direction — a lead and
// a tmux teammate are still served by useInboxPoller, which submits what
// arrived mid-turn only once they are idle. The sentence now states BOTH
// timings and which reader each belongs to, in one wording, because it cannot
// be chosen per reader: toolToAPISchema memoises a tool's description
// process-wide by name (src/utils/api.ts:207-214,
// src/utils/toolSchemaCache.ts:18) and a teammate shares that process with its
// lead, so the first render wins for everybody.

/** The ambient context an in-process teammate's turn runs inside. */
function asInProcessTeammate<T>(fn: () => T): T {
  return runWithTeammateContext(
    {
      agentId: 'supervisor@zeekr',
      agentName: 'supervisor',
      teamName: 'zeekr',
      planModeRequired: false,
      parentSessionId: 'session-1',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: asAgentId('a00000000000beef'),
    },
    fn,
  )
}

test('both delivery timings are stated, each with the reader it belongs to', () => {
  const prompt = getPrompt()

  expect(prompt).toContain(
    "Messages addressed to you are delivered automatically; you don't check an inbox.",
  )
  // Mid-turn, for the agent T4's path actually serves that way.
  expect(prompt).toContain(
    'They arrive at your next tool call when you are a teammate running inside your lead',
  )
  expect(prompt).toContain(
    'a message sent while you are working reaches you without waiting for you to finish',
  )
  // Once idle, for the agents useInboxPoller serves.
  expect(prompt).toContain(
    'once you are idle, as your next turn, when you are a lead or a teammate running in its own terminal',
  )
})

test('the rendered text does not depend on where it is rendered', () => {
  // Required, not incidental: SendMessage's description is memoised per
  // process under its tool name (src/utils/api.ts:207-214, the Map at
  // src/utils/toolSchemaCache.ts:18, cleared only on an auth or tool-set
  // change), and an in-process teammate shares that process with its lead. A
  // prompt that read the ambient context would ship whichever agent rendered
  // first — always the lead, which spawns the teammate — to everyone.
  expect(asInProcessTeammate(() => getPrompt())).toBe(getPrompt())
})

test('it still tells a teammate to use the tool rather than plain text', () => {
  const prompt = getPrompt()

  expect(prompt).toContain(
    'Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.',
  )
})
