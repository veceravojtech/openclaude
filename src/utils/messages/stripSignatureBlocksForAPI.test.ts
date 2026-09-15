import { describe, expect, test } from 'bun:test'
import type {
  AssistantMessage,
  UserMessage,
} from '../../types/message.js'
import { stripSignatureBlocksForAPI } from '../messages.js'

function assistantMessage(
  content: Record<string, unknown>[],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      id: 'msg_1',
      role: 'assistant',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: content as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function userMessage(content: string): UserMessage {
  return {
    type: 'user',
    uuid: 'user-1',
    message: { role: 'user', content },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('stripSignatureBlocksForAPI', () => {
  test('removes thinking and redacted_thinking, keeps the rest', () => {
    const input = [
      userMessage('hello'),
      assistantMessage([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-a' },
        { type: 'text', text: 'answer' },
        { type: 'redacted_thinking', data: 'x', signature: 'sig-b' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ]),
    ]
    const [user, assistant] = stripSignatureBlocksForAPI(input)
    expect(user).toBe(input[0])
    expect(assistant.message.content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ])
  })

  test('does not mutate the input — the stale signature survives in the original', () => {
    const input = [
      assistantMessage([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-a' },
        { type: 'text', text: 'answer' },
      ]),
    ]
    stripSignatureBlocksForAPI(input)
    expect(input[0].message.content).toHaveLength(2)
    expect(input[0].message.content[0]).toMatchObject({ type: 'thinking' })
  })

  test('returns the same array reference when there is nothing to strip', () => {
    const input = [userMessage('hello')]
    expect(stripSignatureBlocksForAPI(input)).toBe(input)
  })

  test('a message whose blocks were all signature-bearing gets a placeholder, never empty content', () => {
    const input = [
      assistantMessage([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-a' },
      ]),
    ]
    const [assistant] = stripSignatureBlocksForAPI(input)
    expect(assistant.message.content).toEqual([
      { type: 'text', text: '[No message content]', citations: [] },
    ])
  })

  test('idempotent: stripping an already-stripped list changes nothing', () => {
    const input = [
      assistantMessage([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-a' },
        { type: 'text', text: 'answer' },
      ]),
    ]
    const once = stripSignatureBlocksForAPI(input)
    expect(stripSignatureBlocksForAPI(once)).toBe(once)
  })
})
