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
// arrived mid-turn only once they are idle. The wording is now chosen per
// context; both variants are pinned here, and so is the default.

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

test('an in-process teammate is promised mid-turn delivery', () => {
  const prompt = getPrompt(true)

  expect(prompt).toContain(
    "Messages addressed to you are delivered automatically; you don't check an inbox.",
  )
  expect(prompt).toContain('They arrive at your next tool call')
  expect(prompt).toContain(
    'a message sent while you are working reaches you without waiting for you to finish',
  )
})

test('everyone else is promised delivery once they are idle', () => {
  const prompt = getPrompt(false)

  expect(prompt).toContain(
    "Messages addressed to you are delivered automatically; you don't check an inbox.",
  )
  expect(prompt).toContain('They arrive as your next turn, once you are idle')
  expect(prompt).toContain(
    'a message sent while you are working reaches you when you finish, not inside the turn you are in',
  )
  // The promise the lead and a tmux teammate cannot keep.
  expect(prompt).not.toContain('at your next tool call')
  expect(prompt).not.toContain('without waiting for you to finish')
})

test('the variant is chosen by the ambient context, not by the caller', () => {
  // SendMessageTool.prompt() takes no argument, so the default is the whole
  // production wiring: what an agent is told depends on where getPrompt runs.
  expect(getPrompt()).toBe(getPrompt(false))
  expect(asInProcessTeammate(() => getPrompt())).toBe(getPrompt(true))
})

test('it still tells a teammate to use the tool rather than plain text', () => {
  const prompt = getPrompt()

  expect(prompt).toContain(
    'Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.',
  )
})
