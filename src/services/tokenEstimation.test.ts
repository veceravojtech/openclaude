import type { Anthropic } from '@anthropic-ai/sdk'
import { expect, mock, test } from 'bun:test'
import { jsonStringify } from '../utils/slowOperations.js'
import { __test, roughTokenCountEstimation } from './tokenEstimation.js'

function createTextTool(): Anthropic.Beta.Messages.BetaToolUnion {
  return {
    name: 'lookup_docs',
    description: 'Look up project documentation.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  }
}

test('countMessagesTokensWithClient falls back when shim client lacks countTokens', async () => {
  const content = 'hello from an openai-compatible provider'

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {},
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    tools: [],
    filteredBetas: [],
    containsThinking: false,
  })

  expect(result).toBe(roughTokenCountEstimation(content))
})

test('countMessagesTokensWithClient includes tool overhead in fallback estimates', async () => {
  const content = 'count this request with tool definitions'
  const tools = [createTextTool()]

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {},
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    tools,
    filteredBetas: [],
    containsThinking: false,
  })

  expect(result).toBe(
    roughTokenCountEstimation(content) +
      500 +
      roughTokenCountEstimation(jsonStringify(tools)),
  )
})

test('countMessagesTokensWithClient uses countTokens when the client supports it', async () => {
  const countTokens = mock(async (_params: unknown) => ({ input_tokens: 42 }))
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: 'use exact count when available' },
  ]

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {
      countTokens:
        countTokens as unknown as Anthropic['beta']['messages']['countTokens'],
    },
    model: 'gpt-4o',
    messages,
    tools: [],
    filteredBetas: [],
    containsThinking: false,
  })

  expect(countTokens).toHaveBeenCalledTimes(1)
  expect(countTokens.mock.calls[0]?.[0]).toEqual({
    model: 'gpt-4o',
    messages,
    tools: [],
  })
  expect(result).toBe(42)
})

const FABLE_MODEL = 'claude-fable-5-1'
const NON_FABLE_MODEL = 'claude-sonnet-4-5'
const THINKING_MESSAGES: Anthropic.Beta.Messages.BetaMessageParam[] = [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'hello' },
    ],
  },
]
const ENABLED_THINKING = { type: 'enabled', budget_tokens: 1024 }

async function captureCountTokensParams(model: string) {
  const countTokens = mock(async (_params: unknown) => ({ input_tokens: 7 }))
  await __test.countMessagesTokensWithClient({
    messagesClient: {
      countTokens:
        countTokens as unknown as Anthropic['beta']['messages']['countTokens'],
    },
    model,
    messages: THINKING_MESSAGES,
    tools: [],
    filteredBetas: [],
    containsThinking: true,
  })
  return countTokens.mock.calls[0]?.[0] as Record<string, unknown>
}

test('countTokens request for Fable uses adaptive thinking, not a budget', async () => {
  const params = await captureCountTokensParams(FABLE_MODEL)
  expect(params.thinking).toEqual({ type: 'adaptive' })
})

test('countTokens request for non-Fable keeps enabled budgeted thinking', async () => {
  const params = await captureCountTokensParams(NON_FABLE_MODEL)
  expect(params.thinking).toEqual(ENABLED_THINKING)
})

test('Haiku-fallback create params for Fable use adaptive thinking', () => {
  const params = __test.buildHaikuFallbackCreateParams({
    model: FABLE_MODEL,
    messages: THINKING_MESSAGES,
    tools: [],
    filteredBetas: [],
    containsThinking: true,
    extraParams: { temperature: 0 },
  }) as unknown as Record<string, unknown>
  expect(params.thinking).toEqual({ type: 'adaptive' })
  expect(params.temperature).toBeUndefined()
})

test('Haiku-fallback create params for non-Fable are unchanged', () => {
  const params = __test.buildHaikuFallbackCreateParams({
    model: NON_FABLE_MODEL,
    messages: THINKING_MESSAGES,
    tools: [],
    filteredBetas: [],
    containsThinking: true,
    extraParams: { temperature: 0 },
  }) as unknown as Record<string, unknown>
  expect(params.thinking).toEqual(ENABLED_THINKING)
  expect(params.temperature).toBe(0)
  expect(params.max_tokens).toBe(2048)
})

test('Bedrock CountTokens body for Fable uses adaptive thinking and omits model', () => {
  const body = __test.buildBedrockCountTokensBody({
    model: 'us.anthropic.claude-fable-5-1',
    messages: THINKING_MESSAGES,
    tools: [],
    betas: [],
    containsThinking: true,
  })
  expect(body.thinking).toEqual({ type: 'adaptive' })
  expect('model' in body).toBe(false)
})

test('Bedrock CountTokens body for non-Fable keeps enabled budgeted thinking', () => {
  const body = __test.buildBedrockCountTokensBody({
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    messages: THINKING_MESSAGES,
    tools: [],
    betas: [],
    containsThinking: true,
  })
  expect(body.thinking).toEqual(ENABLED_THINKING)
  expect(body.anthropic_version).toBe('bedrock-2023-05-31')
  expect('model' in body).toBe(false)
})
