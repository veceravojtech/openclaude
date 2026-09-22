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
