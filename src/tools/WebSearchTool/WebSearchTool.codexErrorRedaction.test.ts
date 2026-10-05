import { afterEach, beforeEach, expect, test } from 'bun:test'

import { runCodexWebSearch } from './WebSearchTool.js'

// The Codex web-search backend's non-OK response body is provider text and can
// echo the credentials the request carried. It becomes the tool error the
// model sees and the lead's transcript stores, so it is redacted when thrown.

const ENV_KEYS = [
  'CODEX_API_KEY',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CODEX_AUTH_JSON_PATH',
] as const
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CODEX_API_KEY = 'test-codex-key'
  process.env.CHATGPT_ACCOUNT_ID = 'acct-test-account'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
  process.env.OPENAI_MODEL = 'gpt-5-codex'
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('a Codex web search error body that echoes credentials is thrown redacted', async () => {
  const body = JSON.stringify({
    error: {
      message: 'unauthorized for key sk-SECRETOPENAIKEY12345678',
      'chatgpt-account-id': 'acct-SECRETACCT99',
      detail: 'Bearer eyJhbGciOiJIUzI1NiJ9.SECRETJWTPAYLOAD.SECRETJWTSIG',
    },
  })
  globalThis.fetch = (async () =>
    new Response(body, { status: 401 })) as unknown as typeof fetch

  const error = await runCodexWebSearch(
    { query: 'weather' } as never,
    new AbortController().signal,
  ).then(
    () => undefined,
    caught => caught as Error,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error!.message).toContain('Codex web search error 401')
  expect(error!.message).toContain('unauthorized for key')
  for (const secret of ['SECRETOPENAIKEY', 'SECRETACCT99', 'SECRETJWTPAYLOAD']) {
    expect(error!.message).not.toContain(secret)
  }
})
