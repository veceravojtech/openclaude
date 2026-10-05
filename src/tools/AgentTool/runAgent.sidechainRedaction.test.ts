import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getSessionId,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
  switchSession,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { enableConfigs } from '../../utils/config.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  flushSessionStorage,
  getAgentTranscriptPath,
  getTranscriptPath,
  recordTranscript,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { getAssistantMessageFromError } from '../../services/api/errors.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// runAgent records every message of an agent run, including a failed turn's
// API-error assistant message, into the agent's own (sidechain) transcript.
// The provider's raw error body must not reach that file, nor the lead's
// transcript that carries the same message.

const FRAGMENTS = [
  'SECRETACCT99',
  'SECRETANTKEY1234567890',
  'SECRETOPENAIKEY12345678',
  'SECRETJWTPAYLOAD',
  'wJalrSECRETAWSVALUE',
  'SECRETCOOKIEVAL',
  'SECRETPEMBODY',
  'SECONDLINEPEM',
]

function secretLadenBody(): string {
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

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-sidechain-redaction-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  mock.restore()
  setClaudeConfigHomeDirForTesting(undefined)
  // Whatever was read while the private config dir was active (settings, OAuth
  // tokens) is cached; do not leave that behind for the next test file.
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

test('a failed agent run never writes the provider secrets into its sidechain or the lead transcript', async () => {
  // The message exactly as production builds it from a failed provider call.
  const errorMessage = getAssistantMessageFromError(
    APIError.generate(400, undefined, secretLadenBody(), new Headers()),
    'gpt-5',
  )
  // The fixture is not vacuous: the raw body carries every fragment.
  for (const fragment of FRAGMENTS) expect(secretLadenBody()).toContain(fragment)

  mock.module('../../query.js', () => ({
    query: async function* () {
      yield errorMessage
    },
  }))
  const { runAgent } = await import(
    `./runAgent.js?sidechainRedaction=${Date.now()}-${Math.random()}`
  )

  const agentDefinition = {
    agentType: 'code-reviewer',
    source: 'built-in',
    getSystemPrompt: () => 'You review.',
  } as unknown as AgentDefinition
  const toolUseContext = {
    options: {
      mainLoopModel: 'test-model',
      agentDefinitions: { activeAgents: [agentDefinition] },
      tools: [],
    },
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
    }),
    setAppState: () => {},
  } as unknown as ToolUseContext
  const agentId = 'asidechainredaction01'

  await withSessionPersistence(async () => {
    enableConfigs()
    const yielded: unknown[] = []
    for await (const message of runAgent({
      agentDefinition,
      promptMessages: [],
      toolUseContext,
      override: { abortController: new AbortController(), agentId: agentId as never },
      querySource: 'subagent',
      canUseTool: async () => ({ behavior: 'allow' }) as never,
      isAsync: false,
      availableTools: [],
    } as never)) {
      yielded.push(message)
    }
    expect(yielded.length).toBeGreaterThan(0)

    // The lead's own transcript records the same message when the error reaches it.
    await recordTranscript([errorMessage] as never)
    await flushSessionStorage()

    const sidechainPath = getAgentTranscriptPath(agentId as never)
    expect(existsSync(sidechainPath)).toBe(true)
    const sidechain = readFileSync(sidechainPath, 'utf-8')
    const lead = readFileSync(getTranscriptPath(), 'utf-8')

    // Both files carry the failure itself, so neither check is vacuous.
    for (const file of [sidechain, lead]) {
      expect(file).toContain('isApiErrorMessage')
      expect(file).toContain('API Error: 400')
      for (const fragment of FRAGMENTS) expect(file).not.toContain(fragment)
    }
  })
})
