import { expect, test } from 'bun:test'
import {
  createTeammateStartupNotification,
  isStructuredProtocolMessage,
  isTeammateStartupNotification,
} from './teammateMailbox.js'

test('startup notifications round-trip as credential-free structured messages', () => {
  const notification = createTeammateStartupNotification('worker', {
    model: 'deepseek-chat',
    provider: 'openai',
    transport: 'openai-chat-completions',
  })
  const text = JSON.stringify(notification)

  expect(isTeammateStartupNotification(text)).toMatchObject({
    type: 'teammate_startup',
    from: 'worker',
    model: 'deepseek-chat',
    provider: 'openai',
    transport: 'openai-chat-completions',
  })
  expect(isStructuredProtocolMessage(text)).toBe(true)
  expect(text).not.toContain('apiKey')
  expect(text).not.toContain('baseUrl')
})

test('malformed startup notifications are ignored', () => {
  expect(
    isTeammateStartupNotification(
      JSON.stringify({
        type: 'teammate_startup',
        from: 'worker',
        model: 'deepseek-chat',
      }),
    ),
  ).toBeNull()
})

test('startup notifications carry the teammate dispatch decision', () => {
  const dispatch = {
    role: 'review' as const,
    family: 'fable-5.1',
    model: 'claude-fable-5-1',
    source: 'jev' as const,
    mode: 'auto' as const,
    reason: 'jev p=0.86; excluded sonnet-5 used by dev',
    probabilities: { review: 0.86 },
    costUsd: 0.0004,
  }
  const text = JSON.stringify(
    createTeammateStartupNotification('rev', {
      model: 'claude-fable-5-1',
      provider: 'firstParty',
      transport: 'anthropic-messages',
      dispatch,
    }),
  )
  expect(isTeammateStartupNotification(text)?.dispatch).toEqual(dispatch)
  // Absent when no decision was made.
  const plain = createTeammateStartupNotification('w', {
    model: 'm',
    provider: 'p',
    transport: 't',
  })
  expect('dispatch' in plain).toBe(false)
})
