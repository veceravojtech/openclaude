import { expect, test } from 'bun:test'

import {
  countActiveMessages,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createProgressMessage,
  createSystemMessage,
  createUserMessage,
  isMessageSentToProvider,
  normalizeMessagesForAPI,
} from '../messages.js'
import type { Message } from '../../types/message.js'

function progressTick(index: number): Message {
  // Shape-only fixture: the counter never reads progress payloads.
  return createProgressMessage({
    toolUseID: `tool_${index}`,
    parentToolUseID: 'tool_parent',
    data: {
      type: 'agent_progress',
      message: createAssistantMessage({ content: `working ${index}` }),
    },
  } as never)
}

function conversation(): Message[] {
  return [
    createUserMessage({ content: 'do the thing' }),
    createAssistantMessage({ content: 'on it' }),
    createUserMessage({ content: 'and then this' }),
    createAssistantMessage({ content: 'done' }),
  ]
}

test('progress ticks never reach the provider, so they never count', () => {
  const base = conversation()
  const withProgress: Message[] = [
    base[0]!,
    progressTick(1),
    progressTick(2),
    base[1]!,
    progressTick(3),
    base[2]!,
    base[3]!,
    ...Array.from({ length: 50 }, (_, i) => progressTick(100 + i)),
  ]

  expect(countActiveMessages(base)).toBe(4)
  // 53 extra array entries, zero extra provider messages: the active-message
  // limit must not fire on swarm/tool progress (see query.ts force-compact).
  expect(countActiveMessages(withProgress)).toBe(4)
})

test('display-only records do not count, local commands do', () => {
  const informational = createSystemMessage('Query timed out', 'info')
  const syntheticError = createAssistantAPIErrorMessage({
    content: 'You have hit your limit',
  })

  expect(isMessageSentToProvider(informational)).toBe(false)
  expect(isMessageSentToProvider(syntheticError)).toBe(false)
  expect(isMessageSentToProvider(progressTick(1))).toBe(false)
  expect(isMessageSentToProvider(createUserMessage({ content: 'hi' }))).toBe(
    true,
  )

  expect(
    countActiveMessages([...conversation(), informational, syntheticError]),
  ).toBe(4)
})

test('the count never undershoots what normalizeMessagesForAPI sends', () => {
  const messages: Message[] = [
    ...conversation(),
    progressTick(1),
    createSystemMessage('local noise', 'info'),
  ]

  // Normalization only ever merges (consecutive user turns), so the provider
  // message count cannot exceed the active count. An undershoot would let an
  // oversized request through the safety limit.
  expect(countActiveMessages(messages)).toBeGreaterThanOrEqual(
    normalizeMessagesForAPI(messages).length,
  )
})
