import { expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

// T4/F3: "Messages from teammates are delivered automatically; you don't check
// an inbox" was only true for the lead (useInboxPoller) — an in-process
// teammate read its own inbox nowhere but the idle loop, so a message sent to
// a BUSY teammate sat unread for the whole turn. F1/F2 make the promise true
// mid-turn; this pins the sentence that now states when a message arrives, so
// the claim and the delivery path stay in step.

test('the automatic-delivery promise says when a message arrives', () => {
  const prompt = getPrompt()

  expect(prompt).toContain(
    "Messages addressed to you are delivered automatically; you don't check an inbox.",
  )
  expect(prompt).toContain('They arrive at your next tool call')
  expect(prompt).toContain(
    'a message sent while you are working reaches you without waiting for you to finish',
  )
})

test('it still tells a teammate to use the tool rather than plain text', () => {
  const prompt = getPrompt()

  expect(prompt).toContain(
    'Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.',
  )
})
