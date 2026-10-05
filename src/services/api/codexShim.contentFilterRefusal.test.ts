import { expect, test } from 'bun:test'

import {
  codexStreamToAnthropic,
  convertCodexResponseToAnthropicMessage,
} from './codexShim.js'

// The Responses API ends a response blocked by its safety / usage policy as
// `incomplete` with reason `content_filter`. That is a refusal, not a normal
// end of turn: the stop reason is `refusal` so the caller reports it.

const textOutput = [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
]

test('a non-streaming Codex response incomplete for content_filter is a refusal', () => {
  const message = convertCodexResponseToAnthropicMessage(
    {
      id: 'resp_1',
      model: 'gpt-5.4',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: textOutput,
    },
    'gpt-5.4',
  )
  expect(message.stop_reason).toBe('refusal')
  expect(message.content).toEqual([{ type: 'text', text: 'partial' }])
})

test('other incomplete reasons and a normal completion are not refusals', () => {
  const stop = (response: Record<string, unknown>) =>
    convertCodexResponseToAnthropicMessage(
      { id: 'r', model: 'gpt-5.4', output: textOutput, ...response },
      'gpt-5.4',
    ).stop_reason
  expect(stop({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).toBe('max_tokens')
  expect(stop({ status: 'completed' })).toBe('end_turn')
})

async function streamStopReason(response: Record<string, unknown>, event: string) {
  const sse = [
    `event: ${event}`,
    `data: ${JSON.stringify({ type: event, response })}`,
    '',
    '',
  ].join('\n')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  for await (const e of codexStreamToAnthropic(new Response(stream), 'gpt-5.4')) {
    if (e.type === 'message_delta') {
      return (e as unknown as { delta: { stop_reason: string } }).delta.stop_reason
    }
  }
  return undefined
}

test('a streamed Codex response incomplete for content_filter ends with a refusal stop reason', async () => {
  expect(
    await streamStopReason(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: textOutput,
      },
      'response.incomplete',
    ),
  ).toBe('refusal')
  expect(
    await streamStopReason(
      { id: 'resp_2', model: 'gpt-5.4', status: 'completed', output: textOutput },
      'response.completed',
    ),
  ).toBe('end_turn')
})

// A model refusal arrives as a `refusal` content part (non-streaming and in the
// terminal payload) and streams as `response.refusal.delta`. It is shown as
// text and ends the turn as a refusal.
const refusalOutput = [
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: "I can't help with that." }],
  },
]

test('a non-streaming Codex refusal part is visible text and a refusal stop reason', () => {
  const message = convertCodexResponseToAnthropicMessage(
    { id: 'resp_r', model: 'gpt-5.4', status: 'completed', output: refusalOutput },
    'gpt-5.4',
  )
  expect(message.stop_reason).toBe('refusal')
  expect(message.content).toEqual([{ type: 'text', text: "I can't help with that." }])
})

test('an empty refusal part or none at all is not a refusal', () => {
  const stop = (output: unknown[]) =>
    convertCodexResponseToAnthropicMessage(
      { id: 'r', model: 'gpt-5.4', status: 'completed', output },
      'gpt-5.4',
    ).stop_reason
  expect(stop([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '' }] }])).toBe('end_turn')
  expect(stop(textOutput)).toBe('end_turn')
})

test('a streamed Codex refusal shows its text and ends with a refusal stop reason', async () => {
  const frames = [
    ['response.content_part.added', { type: 'response.content_part.added', part: { type: 'refusal', refusal: '' } }],
    ['response.refusal.delta', { type: 'response.refusal.delta', delta: "I can't " }],
    ['response.refusal.delta', { type: 'response.refusal.delta', delta: 'help.' }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_s', model: 'gpt-5.4', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: "I can't help." }] }] } }],
  ]
  const sse = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  let text = ''
  let stopReason: string | undefined
  for await (const e of codexStreamToAnthropic(new Response(stream), 'gpt-5.4')) {
    const event = e as unknown as { type: string; delta?: { type?: string; text?: string; stop_reason?: string } }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text
    if (event.type === 'message_delta') stopReason = event.delta?.stop_reason
  }
  expect(text).toBe("I can't help.")
  expect(stopReason).toBe('refusal')
})

// Flagged output next to a tool call is not a refusal: the tool runs and the
// turn goes on.
const toolCallOutput = [
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '{"value":"x"}', status: 'completed' },
]

test('Codex content_filter or a refusal part next to a function call stays tool_use', () => {
  const stop = (response: Record<string, unknown>) =>
    convertCodexResponseToAnthropicMessage(
      { id: 'r', model: 'gpt-5.4', ...response },
      'gpt-5.4',
    ).stop_reason
  expect(
    stop({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: toolCallOutput }),
  ).toBe('tool_use')
  expect(stop({ status: 'completed', output: [...refusalOutput, ...toolCallOutput] })).toBe('tool_use')
  // Without the tool call the same responses are refusals.
  expect(
    stop({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: textOutput }),
  ).toBe('refusal')
  expect(stop({ status: 'completed', output: refusalOutput })).toBe('refusal')
})
