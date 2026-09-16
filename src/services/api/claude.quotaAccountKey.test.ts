import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { mkdtempSync, rmSync } from 'fs'
import { mock } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { QueryLifecycleOperationTracker } from '../../utils/queryLifecycle.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import type { Options } from './claude.js'

/**
 * R7 at the claude.ts layer: the account a first-party response is filed under
 * must be the account that was active when the REQUEST WAS BUILT, not the one
 * active when the response is parsed. switchAccount clears the memoized OAuth
 * token, so the two differ exactly when a switch lands mid-flight — which is
 * the window these tests reproduce by flipping the account inside the SDK call.
 */

const actualClientModule = await import('./client.js')
const realLimitsModule = { ...(await import('../claudeAiLimits.js')) }

const BUILD_TIME_ACCOUNT = 'account-active-at-request-build'
const PARSE_TIME_ACCOUNT = 'account-switched-in-mid-flight'

type CreateArgs = [Record<string, unknown>, Record<string, unknown> | undefined]
type CreateHandler = (...args: CreateArgs) => unknown

type QuotaCall = { via: 'headers' | 'error'; accountKey: string }

let createHandler: CreateHandler | undefined
let restoreClientSpy: (() => void) | undefined
let reportedAccountKey = BUILD_TIME_ACCOUNT
let quotaCalls: QuotaCall[] = []
let importCounter = 0
let fixturesRoot: string | undefined

const originalEnv = { ...process.env }
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
const envKeys = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'OPENCLAUDE_MAX_RETRIES',
  'VCR_RECORD',
] as const

function installClientSpy(): void {
  const clientSpy = spyOn(
    actualClientModule,
    'getAnthropicClient',
  ).mockImplementation(
    async () =>
      ({
        beta: {
          messages: {
            create: (...args: CreateArgs) => {
              if (!createHandler) {
                throw new Error('test client create handler not configured')
              }
              return createHandler(...args)
            },
          },
        },
      }) as never,
  )
  restoreClientSpy = () => clientSpy.mockRestore()
}

/**
 * Replace the quota store with a recorder. currentAccountUsageKey answers with
 * whatever account is active AT THE MOMENT IT IS CALLED, so the recorded key
 * tells us unambiguously when claude.ts called it.
 */
function installLimitsRecorder(): void {
  mock.module('src/services/claudeAiLimits.js', () => ({
    ...realLimitsModule,
    currentAccountUsageKey: () => reportedAccountKey,
    extractQuotaStatusFromHeaders: (
      _headers: globalThis.Headers,
      accountKey: string,
    ) => {
      quotaCalls.push({ via: 'headers', accountKey })
    },
    extractQuotaStatusFromError: (_error: APIError, accountKey: string) => {
      quotaCalls.push({ via: 'error', accountKey })
    },
  }))
}

function makeBetaMessage(id: string): BetaMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-h1-quota-key-test',
    content: [],
    container: null,
    context_management: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { ...EMPTY_USAGE, input_tokens: 1, output_tokens: 1 },
  }
}

function makeCompleteStream(): Stream<BetaRawMessageStreamEvent> {
  const events: BetaRawMessageStreamEvent[] = [
    { type: 'message_start', message: makeBetaMessage('msg-h1-start') },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'ok' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      context_management: null,
      delta: {
        container: null,
        stop_details: null,
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: {
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: null,
        iterations: null,
        output_tokens: 1,
        server_tool_use: null,
      },
    },
    { type: 'message_stop' },
  ]
  const controller = new AbortController()
  const iterator: AsyncIterator<BetaRawMessageStreamEvent> = {
    next() {
      const value = events.shift()
      return Promise.resolve(
        value === undefined
          ? { done: true, value: undefined }
          : { done: false, value },
      )
    },
  }
  return {
    controller,
    [Symbol.asyncIterator]: () => iterator,
  } as Stream<BetaRawMessageStreamEvent>
}

function makeWithResponse(stream: Stream<BetaRawMessageStreamEvent>) {
  return {
    withResponse: async () => ({
      data: stream,
      request_id: 'req-h1-quota-key',
      response: new Response('', {
        headers: {
          'request-id': 'req-h1-quota-key',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.5',
          'anthropic-ratelimit-unified-5h-reset': '111',
        },
      }),
    }),
  }
}

function rateLimitError(): APIError {
  return new APIError(
    429,
    { error: { type: 'rate_limit_error', message: 'rate limited' } },
    'rate limited',
    new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }),
  )
}

function makeOptions(): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'claude-h1-quota-key-test',
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    queryLifecycle: new QueryLifecycleOperationTracker(),
  }
}

function makeMessages(): Message[] {
  return [
    {
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000901',
      timestamp: '2026-09-16T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    } as Message,
  ]
}

async function drainQuery(): Promise<void> {
  const { queryModelWithStreaming } = await import(
    `./claude.js?h1-quota-account-key-${importCounter++}`
  )
  const controller = new AbortController()
  for await (const _message of queryModelWithStreaming({
    messages: makeMessages(),
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: controller.signal,
    options: makeOptions(),
  })) {
    // drain
  }
}

function setTestMacro(): void {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('claude.quotaAccountKey.test.ts')
  installClientSpy()
  installLimitsRecorder()
  setTestMacro()
  quotaCalls = []
  reportedAccountKey = BUILD_TIME_ACCOUNT
  fixturesRoot = mkdtempSync(join(tmpdir(), 'claude-h1-quota-key-'))
  for (const key of envKeys) {
    delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test-h1-quota-key'
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
  process.env.OPENCLAUDE_MAX_RETRIES = '0'
  process.env.VCR_RECORD = '1'
})

afterEach(() => {
  try {
    restoreClientSpy?.()
    restoreClientSpy = undefined
    createHandler = undefined
    mock.restore()
    mock.module('src/services/claudeAiLimits.js', () => ({
      ...realLimitsModule,
    }))
    for (const key of envKeys) {
      const envKey: string = key
      if (originalEnv[envKey] === undefined) {
        delete process.env[envKey]
      } else {
        process.env[envKey] = originalEnv[envKey]
      }
    }
    if (hadSavedMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { force: true, recursive: true })
      fixturesRoot = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('quota account key is snapshotted at request-build time', () => {
  test('a successful stream files its headers under the build-time account, not the parse-time one', async () => {
    createHandler = () => {
      // The request is built and dispatched; the switch lands right here.
      reportedAccountKey = PARSE_TIME_ACCOUNT
      return makeWithResponse(makeCompleteStream())
    }

    await drainQuery()

    // The flip really happened, so a parse-time read would have produced the
    // other value — this assertion is what makes the one below discriminating.
    expect(reportedAccountKey).toBe(PARSE_TIME_ACCOUNT)
    expect(quotaCalls).toEqual([
      { via: 'headers', accountKey: BUILD_TIME_ACCOUNT },
    ])
  })

  test('a 429 files its error under the build-time account, not the parse-time one', async () => {
    createHandler = () => {
      reportedAccountKey = PARSE_TIME_ACCOUNT
      throw rateLimitError()
    }

    await drainQuery()

    expect(reportedAccountKey).toBe(PARSE_TIME_ACCOUNT)
    expect(quotaCalls).toEqual([
      { via: 'error', accountKey: BUILD_TIME_ACCOUNT },
    ])
  })

  test('without a mid-flight switch the build-time and parse-time accounts agree', async () => {
    createHandler = () => makeWithResponse(makeCompleteStream())

    await drainQuery()

    expect(reportedAccountKey).toBe(BUILD_TIME_ACCOUNT)
    expect(quotaCalls).toEqual([
      { via: 'headers', accountKey: BUILD_TIME_ACCOUNT },
    ])
  })
})
