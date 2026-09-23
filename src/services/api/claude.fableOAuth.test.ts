import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetCostState } from '../../cost-tracker.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { QueryLifecycleOperationTracker } from '../../utils/queryLifecycle.js'
import {
  CLAUDE_CODE_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
} from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import type { Options } from './claude.js'

/**
 * End-to-end proof (no network) that Claude Fable 5.1 works for a user logged
 * in with a claude.ai subscription (OAuth, not an API key): the user-facing
 * `fable` selection resolves the same way the main loop resolves it, and the
 * request queryModel hands the SDK carries the Fable id, the OAuth + 1M betas,
 * adaptive thinking, no forced tool_choice and no temperature — with the same
 * beta set an Opus 5.5 request gets on that path.
 */

const actualClientModule = await import('./client.js')
const realAuth = { ...(await import('../../utils/auth.js')) }

type CreateArgs = [Record<string, unknown>, Record<string, unknown> | undefined]

let captured: Record<string, unknown>[] = []
let restoreClientSpy: (() => void) | undefined
let importCounter = 0
let fixturesRoot: string | undefined

const originalEnv = { ...process.env }
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENCLAUDE_MAX_RETRIES',
  'USER_TYPE',
  'VCR_RECORD',
] as const

function makeBetaMessage(model: string): BetaMessage {
  return {
    id: 'msg-fable-oauth',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    container: null,
    context_management: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { ...EMPTY_USAGE, input_tokens: 1, output_tokens: 1 },
  }
}

function makeCompleteStream(model: string): Stream<BetaRawMessageStreamEvent> {
  const events: BetaRawMessageStreamEvent[] = [
    { type: 'message_start', message: makeBetaMessage(model) },
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
    controller: new AbortController(),
    [Symbol.asyncIterator]: () => iterator,
  } as Stream<BetaRawMessageStreamEvent>
}

function installClientSpy(): void {
  const clientSpy = spyOn(
    actualClientModule,
    'getAnthropicClient',
  ).mockImplementation(
    async () =>
      ({
        beta: {
          messages: {
            create: (...[params]: CreateArgs) => {
              captured.push(params)
              const model = String(params.model)
              return {
                withResponse: async () => ({
                  data: makeCompleteStream(model),
                  request_id: 'req-fable-oauth',
                  response: new Response('', {
                    headers: { 'request-id': 'req-fable-oauth' },
                  }),
                }),
              }
            },
          },
        },
      }) as never,
  )
  restoreClientSpy = () => clientSpy.mockRestore()
}

/** A claude.ai Max subscriber logged in via /login (OAuth). */
function installOAuthSubscriber(): void {
  mock.module('../../utils/auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => true,
    isMaxSubscriber: () => true,
    isProSubscriber: () => false,
    isTeamPremiumSubscriber: () => false,
    getSubscriptionType: () => 'max',
  }))
}

async function clearBetaCaches(): Promise<void> {
  const betas = await import('../../utils/betas.js')
  for (const fn of [
    betas.getAllModelBetas,
    betas.getModelBetas,
    betas.getBedrockExtraBodyParamsBetas,
  ]) {
    ;(fn as unknown as { cache?: { clear?: () => void } }).cache?.clear?.()
  }
}

function makeOptions(model: string): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model,
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    queryLifecycle: new QueryLifecycleOperationTracker(),
    // A caller asking for forced tool use and a deterministic temperature —
    // both of which Fable 5.1 rejects with a 400.
    toolChoice: { type: 'tool', name: 'StructuredOutput' },
    temperatureOverride: 0,
  }
}

// The VCR layer keys fixtures on the message content, so each request gets a
// distinct prompt; otherwise a second model replays the first one's fixture
// and never reaches the client.
function makeMessages(model: string): Message[] {
  return [
    {
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000f51',
      timestamp: '2026-09-23T00:00:00.000Z',
      message: { role: 'user', content: `hello from ${model}` },
    } as Message,
  ]
}

async function sendOneRequest(model: string): Promise<Record<string, unknown>> {
  const { queryModelWithStreaming } = await import(
    `./claude.js?fable-oauth-${importCounter++}`
  )
  const before = captured.length
  for await (const _message of queryModelWithStreaming({
    messages: makeMessages(model),
    systemPrompt: asSystemPrompt([]),
    // Thinking explicitly disabled by the caller: Fable must still get
    // adaptive thinking because it rejects `{type:'disabled'}`.
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: makeOptions(model),
  })) {
    // drain
  }
  expect(captured.length).toBe(before + 1)
  return captured[captured.length - 1]!
}

/** Resolve a `/model` value the same way getMainLoopModel does. */
async function resolveMainLoopModel(setting: string): Promise<string> {
  const { parseUserSpecifiedModel, preferOneMillionContext } = await import(
    '../../utils/model/model.js'
  )
  return preferOneMillionContext(parseUserSpecifiedModel(setting))
}

beforeEach(async () => {
  await acquireSharedMutationLock('services/api/claude.fableOAuth.test.ts')
  for (const key of envKeys) {
    delete process.env[key]
  }
  installOAuthSubscriber()
  installClientSpy()
  await clearBetaCaches()
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
  captured = []
  fixturesRoot = mkdtempSync(join(tmpdir(), 'claude-fable-oauth-'))
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
  process.env.OPENCLAUDE_MAX_RETRIES = '0'
  process.env.VCR_RECORD = '1'
})

afterEach(async () => {
  try {
    resetCostState()
    restoreClientSpy?.()
    restoreClientSpy = undefined
    mock.restore()
    mock.module('../../utils/auth.js', () => ({ ...realAuth }))
    await clearBetaCaches()
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

describe('Claude Fable 5.1 over an Anthropic OAuth subscription', () => {
  test('`/model fable` resolves to the 1M-tagged Fable id on the subscriber main loop', async () => {
    expect(await resolveMainLoopModel('fable')).toBe('claude-fable-5-1[1m]')
    expect(await resolveMainLoopModel('claude-fable-5-1')).toBe(
      'claude-fable-5-1[1m]',
    )
  })

  test('the request carries the Fable id, OAuth + 1M betas, adaptive thinking, no forced tool_choice and no temperature', async () => {
    const model = await resolveMainLoopModel('fable')
    const params = await sendOneRequest(model)

    // Model id: the [1m] tag is a client-side marker and never reaches the API.
    expect(params.model).toBe('claude-fable-5-1')

    const betas = params.betas as string[]
    expect(betas).toContain(OAUTH_BETA_HEADER)
    expect(betas).toContain(CLAUDE_CODE_20250219_BETA_HEADER)
    expect(betas).toContain(CONTEXT_1M_BETA_HEADER)

    // Always-on adaptive thinking even though the caller disabled thinking.
    expect(params.thinking).toEqual({ type: 'adaptive' })

    // Forced tool use is downgraded; Fable 400s on {type:'tool'|'any'}.
    const toolChoice = params.tool_choice as { type?: string } | undefined
    expect(toolChoice?.type === 'tool' || toolChoice?.type === 'any').toBe(false)

    // Non-default temperature is a 400 on Fable; the field must be absent.
    expect('temperature' in params).toBe(false)
    expect(params.top_p).toBeUndefined()
    expect(params.top_k).toBeUndefined()
  })

  test('the pinned id (`--model claude-fable-5-1`) sends the same request shape', async () => {
    const params = await sendOneRequest(
      await resolveMainLoopModel('claude-fable-5-1'),
    )
    expect(params.model).toBe('claude-fable-5-1')
    expect(params.betas as string[]).toContain(OAUTH_BETA_HEADER)
    expect(params.thinking).toEqual({ type: 'adaptive' })
    expect('temperature' in params).toBe(false)
  })

  test('Fable gets the same beta set Opus 5.5 gets on the subscriber path', async () => {
    const fable = await sendOneRequest(await resolveMainLoopModel('fable'))
    const opus = await sendOneRequest(
      await resolveMainLoopModel('claude-opus-5-5'),
    )
    expect(opus.model).toBe('claude-opus-5-5')
    expect([...(fable.betas as string[])].sort()).toEqual(
      [...(opus.betas as string[])].sort(),
    )
  })
})
