import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getSessionId,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { createSystemAPIErrorMessage } from './messages.js'
import { createUserMessage } from './messages.js'
import { clearOAuthTokenCache } from './auth.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  recordTranscript,
  resetProjectForTesting,
} from './sessionStorage.js'

// A retried provider error is kept as a system `api_error` message that holds
// the whole APIError (status, parsed body). The session transcript must not
// persist the provider's raw body, which can echo credentials.

const FRAGMENTS = [
  'SECRETACCT99',
  'SECRETANTKEY1234567890',
  'SECRETOPENAIKEY12345678',
  'SECRETJWTPAYLOAD',
  'wJalrSECRETAWSVALUE',
  'SECRETCOOKIEVAL',
]

function secretLadenBody(): Record<string, unknown> {
  return {
    error: {
      message: JSON.stringify({
        note: 'visible-context',
        'chatgpt-account-id': 'acct-SECRETACCT99',
        message:
          'key sk-ant-api03-SECRETANTKEY1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.SECRETJWTPAYLOAD.SECRETJWTSIG',
        api_key: 'sk-SECRETOPENAIKEY12345678',
        env: 'Error: AWS_SECRET_ACCESS_KEY=wJalrSECRETAWSVALUE',
        cookie: 'sid=SECRETCOOKIEVAL; theme=dark',
      }),
    },
  }
}

let configDir: string
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-retry-redaction-'))
  setClaudeConfigHomeDirForTesting(configDir)
})
afterEach(() => {
  setClaudeConfigHomeDirForTesting(undefined)
  resetSettingsCache()
  clearOAuthTokenCache()
  rmSync(configDir, { recursive: true, force: true })
})

async function withSessionPersistence<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    test: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    enable: process.env.ENABLE_SESSION_PERSISTENCE,
    skip: process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY,
    nodeEnv: process.env.NODE_ENV,
  }
  const sessionId = getSessionId()
  const disabled = isSessionPersistenceDisabled()
  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  setSessionPersistenceDisabled(false)
  try {
    resetProjectForTesting()
    return await fn()
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore('TEST_ENABLE_SESSION_PERSISTENCE', saved.test)
    restore('ENABLE_SESSION_PERSISTENCE', saved.enable)
    restore('CLAUDE_CODE_SKIP_PROMPT_HISTORY', saved.skip)
    restore('NODE_ENV', saved.nodeEnv)
    setSessionPersistenceDisabled(disabled)
    switchSession(sessionId)
    resetProjectForTesting()
  }
}

test('a retried provider error is persisted without the provider body secrets', async () => {
  const body = secretLadenBody()
  const error = APIError.generate(
    429,
    body,
    `429 ${JSON.stringify(body)}`,
    new Headers(),
  )
  for (const fragment of FRAGMENTS) expect(JSON.stringify(body)).toContain(fragment)
  const retry = createSystemAPIErrorMessage(error, 2000, 1, 5)
  const prompt = createUserMessage({ content: 'hello' })

  await withSessionPersistence(async () => {
    await recordTranscript([prompt, retry] as never)
    await flushSessionStorage()
    const transcript = readFileSync(getTranscriptPath(), 'utf-8')
    // The retry itself is recorded, so the check is not vacuous.
    expect(transcript).toContain('api_error')
    expect(transcript).toContain('visible-context')
    for (const fragment of FRAGMENTS) expect(transcript).not.toContain(fragment)
  })
  // The live message keeps the real error for the UI and the retry logic.
  expect(retry.error).toBe(error)
})
