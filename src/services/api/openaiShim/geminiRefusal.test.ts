import { expect, test } from 'bun:test'

import { convertGeminiToAnthropicResponse } from './responseAdapters.js'

// Gemini candidate finish reasons that mean a safety / policy block are
// refusals (they used to be reported as output-limit truncations, or as a
// normal end of turn).

const respond = (finishReason: string, parts: unknown[] = [{ text: 'partial' }]) =>
  convertGeminiToAnthropicResponse(
    { candidates: [{ content: { parts }, finishReason }] },
    'gemini-test',
  ).stop_reason

test('Gemini safety and policy finish reasons are refusals', () => {
  for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
    expect(respond(reason)).toBe('refusal')
  }
})

test('Gemini normal and length finish reasons are unchanged', () => {
  expect(respond('STOP')).toBe('end_turn')
  expect(respond('MAX_TOKENS')).toBe('max_tokens')
  expect(
    respond('STOP', [{ functionCall: { name: 'Read', args: { path: 'a' } } }]),
  ).toBe('tool_use')
})

test('a Gemini safety finish next to a function call stays tool_use', () => {
  expect(
    respond('SAFETY', [{ functionCall: { name: 'Read', args: { path: 'a' } } }]),
  ).toBe('tool_use')
})
