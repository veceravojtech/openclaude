import { APIError } from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { findTurnFailure } from '../../utils/swarm/turnFailure.js'
import {
  classifyTeammateApiError,
  redactFailureDetail,
} from '../../utils/swarm/teammateFailureReasons.js'
import {
  CCR_AUTH_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE,
  OPENCODE_GO_USAGE_LIMIT_ERROR_MESSAGE,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  REPEATED_529_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
  getAssistantMessageFromError,
  getCodexPlanLimitMessage,
  getErrorMessageIfRefusal,
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getProviderMaxTokensCapFromMessage,
  getPromptTooLongTokenGap,
  getRequestTooLargeErrorMessage,
  getVisionNotSupportedErrorMessages,
  isCodexPlanLimitError,
  isPromptTooLongMessage,
} from './errors.js'

// The API-error assistant message is built from the provider's own error body.
// It is scrubbed once, where it is created, so every later copy (sidechain and
// lead transcripts, mailbox, notifications, task output, UI) is already clean.
// These tests pin both halves: no secret survives creation, and every consumer
// that reads the text still classifies it correctly.

const SECRET_FRAGMENTS = [
  'SECRETACCT99',
  'SECRETANTKEY1234567890',
  'SECRETOPENAIKEY12345678',
  'SECRETJWTPAYLOAD',
  'wJalrSECRETAWSVALUE',
  'SECRETCOOKIEVAL',
  'SECRETPEMBODY',
]

function secretBody(): string {
  const inner = JSON.stringify({
    note: 'visible-context',
    'chatgpt-account-id': 'acct-SECRETACCT99',
    message:
      'key sk-ant-api03-SECRETANTKEY1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.SECRETJWTPAYLOAD.SECRETJWTSIG',
    api_key: 'sk-SECRETOPENAIKEY12345678',
    env: 'Error: AWS_SECRET_ACCESS_KEY=wJalrSECRETAWSVALUE',
    cookie: 'sid=SECRETCOOKIEVAL; theme=dark',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIESECRETPEMBODY\nSECONDLINEPEM',
  })
  return JSON.stringify({ error: { message: inner } })
}

function textOf(message: ReturnType<typeof getAssistantMessageFromError>): string {
  const first = message.message.content[0]
  return first && typeof first === 'object' && 'text' in first
    ? String(first.text)
    : ''
}

function expectNoSecrets(text: string): void {
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment)
}

test('the fixture really carries every secret fragment', () => {
  for (const fragment of SECRET_FRAGMENTS) expect(secretBody()).toContain(fragment)
})

test('an API error built from a secret-laden provider body never holds the secret', () => {
  const error = APIError.generate(400, undefined, secretBody(), new Headers())
  const message = getAssistantMessageFromError(error, 'gpt-5')
  expect(message.isApiErrorMessage).toBe(true)
  expectNoSecrets(JSON.stringify(message))
  expect(textOf(message)).toContain('API Error: 400')
})

test('the factory scrubs both the visible text and errorDetails', () => {
  const message = createAssistantAPIErrorMessage({
    content: `API Error: 400 ${secretBody()}`,
    errorDetails: `prompt is too long: 137500 tokens > 135000 maximum ${secretBody()}`,
  })
  expectNoSecrets(JSON.stringify(message))
  expect(textOf(message)).toContain('visible-context')
  expect(message.errorDetails).toContain('prompt is too long: 137500 tokens > 135000 maximum')
})

test('a prompt-too-long error still parses its token counts after scrubbing', () => {
  const raw = `prompt is too long: 137500 tokens > 135000 maximum ${secretBody()}`
  const message = getAssistantMessageFromError(
    APIError.generate(400, undefined, raw, new Headers()),
    'claude-x',
  )
  expect(textOf(message)).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE)
  expect(isPromptTooLongMessage(message)).toBe(true)
  expect(getPromptTooLongTokenGap(message)).toBe(2500)
  expectNoSecrets(JSON.stringify(message))
  // A plain Error (Vertex style, capitalised) takes the same path.
  const vertex = getAssistantMessageFromError(
    new Error('Prompt is too long: 250000 tokens > 200000 maximum'),
    'claude-x',
  )
  expect(getPromptTooLongTokenGap(vertex)).toBe(50000)
})

test('a provider max_tokens cap is still read from the scrubbed errorDetails', () => {
  const message = getAssistantMessageFromError(
    new Error(
      'OpenAI API error 400: max_tokens exceeds maximum output tokens for this model: 27342. [openai_category=unknown] Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
    ),
    'gpt-5',
  )
  expect(message.apiError).toBe('max_tokens_too_high')
  expect(getProviderMaxTokensCapFromMessage(message)).toBe(27342)
  expect(JSON.stringify(message)).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
})

test('a usage-policy refusal is still a refusal, with its wording intact', () => {
  const message = getErrorMessageIfRefusal('refusal', 'some-model')!
  const text = textOf(message)
  expect(text).toContain(
    'unable to respond to this request, which appears to violate our Usage Policy',
  )
  expect(text).toContain('https://www.anthropic.com/legal/aup')
  expect(text).toBe(redactFailureDetail(text))
  expect(message.apiError).toBe('refusal')
  expect(findTurnFailure([message])?.kind).toBe('refusal')
  // The text fallback alone (no structured marker) classifies it the same way.
  expect(classifyTeammateApiError(undefined, text)).toBe('refusal')
})

test('a Codex plan limit keeps its reset time and still classifies as quota', () => {
  const resetsIn = 2 * 3600 + 5 * 60 + 30
  const body = {
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      plan_type: 'plus',
      resets_at: Math.floor(Date.now() / 1000) + resetsIn,
      resets_in_seconds: resetsIn,
    },
  }
  const raw = APIError.generate(
    429,
    body,
    `Codex API error 429: ${JSON.stringify(body)}`,
    new Headers(),
  )
  expect(isCodexPlanLimitError(raw)).toBe(true)
  const planLimit = getCodexPlanLimitMessage(raw)!
  const message = getAssistantMessageFromError(new Error(planLimit), 'gpt-5.6-sol')
  const text = textOf(message)
  expect(text).toContain("ChatGPT plan's Codex usage limit has been reached")
  expect(text).toMatch(/It resets at .+ \(in 2h 5m\)\./)
  expect(text).toContain('/provider')
  expect(findTurnFailure([message])?.kind).toBe('quota')
})

test('a 429 rate limit is still a rate_limit failure', () => {
  const message = getAssistantMessageFromError(
    APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { message: 'Rate limit reached, Bearer abcdefghijklmnopqrstuvwxyz0123' } }),
      new Headers(),
    ),
    'claude-x',
  )
  expect(message.error).toBe('rate_limit')
  expect(findTurnFailure([message])?.kind).toBe('rate_limit')
  expect(JSON.stringify(message)).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
})

test('a 401 authentication error is still an authentication failure', () => {
  const message = getAssistantMessageFromError(
    APIError.generate(
      401,
      undefined,
      JSON.stringify({ error: { message: 'bad key sk-ant-api03-SECRETANTKEY1234567890' } }),
      new Headers(),
    ),
    'claude-x',
  )
  expect(message.error).toBe('authentication_failed')
  expect(findTurnFailure([message])?.kind).toBe('authentication')
  expectNoSecrets(JSON.stringify(message))
  // And the text-only fallback on the login hint.
  expect(
    classifyTeammateApiError(undefined, `Please run /login · API Error: 401 ${secretBody()}`),
  ).toBe('authentication')
})

test('the fixed error constants other code matches on are untouched by scrubbing', () => {
  // normalizeMessagesForAPI strips attachments by exact error text; the UI and
  // retry logic match on these strings. A scrub that changed one would break them.
  const constants = [
    PROMPT_TOO_LONG_ERROR_MESSAGE,
    CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
    INVALID_API_KEY_ERROR_MESSAGE,
    INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
    ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
    ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
    TOKEN_REVOKED_ERROR_MESSAGE,
    CCR_AUTH_ERROR_MESSAGE,
    REPEATED_529_ERROR_MESSAGE,
    OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE,
    OPENCODE_GO_USAGE_LIMIT_ERROR_MESSAGE,
    getPdfTooLargeErrorMessage(),
    getPdfPasswordProtectedErrorMessage(),
    getPdfInvalidErrorMessage(),
    getImageTooLargeErrorMessage(),
    getRequestTooLargeErrorMessage(),
    ...getVisionNotSupportedErrorMessages(),
  ]
  for (const constant of constants) {
    expect(redactFailureDetail(constant)).toBe(constant)
    expect(textOf(createAssistantAPIErrorMessage({ content: constant }) as never)).toBe(constant)
  }
})
