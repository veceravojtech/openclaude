import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
// Load the tool graph before agentToolUtils (pre-existing import cycle).
import '../../constants/tools.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { resetCostState } from '../../cost-tracker.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { runAsyncAgentLifecycle } from '../../tools/AgentTool/agentToolUtils.js'
import type { Message } from '../../types/message.js'
import { listAttentionItems } from '../../utils/attentionItems.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { QueryLifecycleOperationTracker } from '../../utils/queryLifecycle.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { findTurnFailure } from '../../utils/swarm/turnFailure.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import type { Options } from './claude.js'
import { createGeminiVertexClient } from './geminiVertexClient.js'
import { createOpenAIShimClient } from './openaiShim.js'

// On OpenAI-compatible providers a provider safety / usage-policy refusal is a
// `content_filter` (or `safety`) finish, not an Anthropic `stop_reason:
// 'refusal'`. It used to come out of the shim as a normal end_turn reply with a
// "[Content blocked ...]" line, so a teammate or agent that was filtered was
// reported as having finished. These drive the real shim and the real
// queryModelWithStreaming, streamed and via the non-streaming fallback.

const actualClientModule = await import('./client.js')
const LIST = 'content-filter-refusal-list'
const TASK_ID = 'a0000contentfilter01'
const realFetch = globalThis.fetch
const originalEnv = { ...process.env }
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'OPENCLAUDE_MAX_RETRIES',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_TASK_LIST_ID',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'VCR_RECORD',
] as const

type CreateParams = Record<string, unknown>
let streamMode: 'shim' | 'wedged' | 'vertex' = 'shim'
let vertexResponse: unknown = {}
// OpenAI reports a model refusal in `refusal`, not `content`.
let refusalField: string | null = null
// A tool call that comes with the flagged output.
let withToolCall = false
const TOOL_CALL = {
  index: 0,
  id: 'call_1',
  type: 'function',
  function: { name: 'Read', arguments: '{"file_path":"/tmp/x"}' },
}
let restoreClientSpy: (() => void) | undefined
let configDir: string | undefined
let fixturesRoot: string | undefined
let importCounter = 0
let queryCounter = 0
let finishReason: string | null = 'content_filter'
let partialText = 'partial answer'

function installClientSpy(): void {
  const shim = createOpenAIShimClient({}) as unknown as {
    beta: { messages: { create: (p: CreateParams, o?: unknown) => unknown } }
  }
  const spy = spyOn(actualClientModule, 'getAnthropicClient').mockImplementation(
    async () =>
      ({
        beta: {
          messages: {
            create: (params: CreateParams, options?: unknown) => {
              if (streamMode === 'vertex') {
                return createGeminiVertexClient({
                  project: 'p',
                  location: 'global',
                  model: 'gemini-test',
                  getAccessToken: async () => 'token',
                  fetch: (async () =>
                    new Response(JSON.stringify(vertexResponse), {
                      headers: { 'Content-Type': 'application/json' },
                    })) as unknown as typeof fetch,
                }).messages.create(params as never)
              }
              if (params.stream === true && streamMode === 'wedged') {
                return wedgedWithResponse()
              }
              return shim.beta.messages.create(params, options)
            },
          },
        },
      }) as never,
  )
  restoreClientSpy = () => spy.mockRestore()
}

// A stream that starts and then never produces another event, so the stream
// watchdog falls back to a non-streaming request.
function wedgedWithResponse() {
  const controller = new AbortController()
  let calls = 0
  const stream = {
    controller,
    [Symbol.asyncIterator]: () => ({
      next() {
        calls++
        if (calls === 1) {
          return Promise.resolve({
            done: false,
            value: {
              type: 'message_start',
              message: {
                id: 'msg-wedged',
                type: 'message',
                role: 'assistant',
                model: 'gpt-4o',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            } as unknown as BetaRawMessageStreamEvent,
          })
        }
        return new Promise(() => {})
      },
      return: () => Promise.resolve({ done: true, value: undefined }),
    }),
  } as unknown as Stream<BetaRawMessageStreamEvent>
  return {
    withResponse: async () => ({
      data: stream,
      request_id: 'req-wedged',
      response: new Response('', { headers: { 'request-id': 'req-wedged' } }),
    }),
  }
}

function chatChunk(delta: Record<string, unknown>, reason: string | null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: reason }],
  })}\n\n`
}

function installFetch(): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { stream?: boolean }
    if (body.stream) {
      const encoder = new TextEncoder()
      const text =
        (partialText ? chatChunk({ role: 'assistant', content: partialText }, null) : '') +
        (refusalField !== null
          ? chatChunk({ role: 'assistant', refusal: refusalField }, null)
          : '') +
        (withToolCall ? chatChunk({ tool_calls: [TOOL_CALL] }, null) : '') +
        chatChunk({}, finishReason) +
        'data: [DONE]\n\n'
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(text))
            controller.close()
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: partialText || null,
              ...(refusalField !== null ? { refusal: refusalField } : {}),
              ...(withToolCall
                ? { tool_calls: [{ id: TOOL_CALL.id, type: 'function', function: TOOL_CALL.function }] }
                : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

beforeEach(async () => {
  await acquireSharedMutationLock('services/api/openaiShim.contentFilterRefusal.test.ts')
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_MODEL = 'gpt-4o'
  process.env.OPENCLAUDE_MAX_RETRIES = '0'
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
  resetCommandQueue()
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-content-filter-'))
  setClaudeConfigHomeDirForTesting(configDir)
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  // The streaming pipeline records/replays responses by input hash (VCR); a
  // fresh root per test keeps every test on the live shim and off the repo.
  fixturesRoot = mkdtempSync(join(tmpdir(), 'openclaude-content-filter-vcr-'))
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
  process.env.VCR_RECORD = '1'
  streamMode = 'shim'
  finishReason = 'content_filter'
  partialText = 'partial answer'
  refusalField = null
  withToolCall = false
  vertexResponse = {}
  installFetch()
  installClientSpy()
})

afterEach(() => {
  try {
    resetCostState()
    restoreClientSpy?.()
    restoreClientSpy = undefined
    globalThis.fetch = realFetch
    resetCommandQueue()
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    if (hadSavedMacro) (globalThis as Record<string, unknown>).MACRO = savedMacro
    else delete (globalThis as Record<string, unknown>).MACRO
    setClaudeConfigHomeDirForTesting(undefined)
    resetSettingsCache()
    clearOAuthTokenCache()
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
    if (fixturesRoot) rmSync(fixturesRoot, { recursive: true, force: true })
    fixturesRoot = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function makeOptions(): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'gpt-4o',
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    queryLifecycle: new QueryLifecycleOperationTracker(),
  }
}

async function* queryOnce(): AsyncGenerator<Message> {
  const { queryModelWithStreaming } = await import(
    `./claude.js?content-filter-${importCounter++}`
  )
  for await (const message of queryModelWithStreaming({
    messages: [
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000201',
        timestamp: '2026-06-30T00:00:00.000Z',
        // Unique per call: the streaming pipeline records/replays by input hash
        // (VCR), and a replay is not the live response this test is about.
        message: { role: 'user', content: `hello ${queryCounter++}` },
      } as Message,
    ],
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: makeOptions(),
  })) {
    yield message as Message
  }
}

async function collect(): Promise<Message[]> {
  const out: Message[] = []
  for await (const message of queryOnce()) out.push(message)
  return out
}

const assistantTexts = (messages: Message[]): string[] =>
  messages
    .filter(m => m.type === 'assistant')
    .map(m => JSON.stringify((m as { message: { content: unknown } }).message.content))

test('a streamed content_filter finish is a refusal turn failure, and the partial text stays', async () => {
  const messages = await collect()
  const failure = findTurnFailure(messages)
  expect(failure?.kind).toBe('refusal')
  expect(failure?.errorText).toContain('violate our Usage Policy')
  // What the model streamed before the filter is not lost.
  expect(assistantTexts(messages).some(t => t.includes('partial answer'))).toBe(true)
  const last = messages.filter(m => m.type === 'assistant').at(-1) as {
    isApiErrorMessage?: boolean
    apiError?: string
  }
  expect(last.isApiErrorMessage).toBe(true)
  expect(last.apiError).toBe('refusal')
})

test('a content_filter finish via the non-streaming fallback is a refusal turn failure too', async () => {
  streamMode = 'wedged'
  const messages = await collect()
  const failure = findTurnFailure(messages)
  expect(failure?.kind).toBe('refusal')
  expect(assistantTexts(messages).some(t => t.includes('partial answer'))).toBe(true)
})

test('a safety finish is a refusal as well', async () => {
  finishReason = 'safety'
  const ms = await collect()
  expect(findTurnFailure(ms)?.kind).toBe('refusal')
})

test('a normal stop finish is not a failure, streamed or not', async () => {
  finishReason = 'stop'
  expect(findTurnFailure(await collect())).toBeUndefined()
  streamMode = 'wedged'
  expect(findTurnFailure(await collect())).toBeUndefined()
})

async function runLifecycle() {
  let state: Record<string, unknown> = {
    tasks: {
      [TASK_ID]: {
        type: 'local_agent',
        id: TASK_ID,
        agentId: TASK_ID,
        status: 'running',
        description: 'research the parser',
        prompt: 'research it',
        startTime: Date.now(),
        notified: false,
        retain: false,
        messages: [],
      },
    },
    toolPermissionContext: { mode: 'default' },
    speculation: { status: 'idle' },
  }
  await runAsyncAgentLifecycle({
    taskId: TASK_ID,
    abortController: new AbortController(),
    makeStream: (() => queryOnce()) as never,
    metadata: {
      prompt: 'research it',
      resolvedAgentModel: 'gpt-4o',
      isBuiltInAgent: false,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: true,
    },
    description: 'research the parser',
    toolUseContext: {
      options: { tools: [] },
      getAppState: () => state,
      toolUseId: 'toolu_research',
    } as never,
    rootSetAppState: ((f: (prev: never) => unknown) => {
      state = f(state as never) as Record<string, unknown>
    }) as never,
    agentIdForCleanup: TASK_ID,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
  })
  const task = (state.tasks as Record<string, { status: string; error?: string }>)[TASK_ID]!
  await new Promise<void>(resolve => setTimeout(resolve, 100))
  const notifications = getCommandQueue()
    .map(c => (typeof c.value === 'string' ? c.value : JSON.stringify(c.value)))
    .filter(v => v.includes('<task-notification>'))
  return { task, notifications }
}

test('an agent whose provider filtered the answer is reported failed to the lead, with an attention item', async () => {
  const { task, notifications } = await runLifecycle()
  expect(task.status).toBe('failed')
  expect(notifications).toHaveLength(1)
  expect(notifications[0]).toContain('<status>failed</status>')
  expect(notifications[0]).toContain('refused by the model provider')
  expect(notifications[0]).toContain('partial answer')
  const items = await listAttentionItems(LIST)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ kind: 'failure', status: 'undecided' })
}, 30_000)

test('an agent whose answer was not filtered completes with no attention item', async () => {
  finishReason = 'stop'
  const { task, notifications } = await runLifecycle()
  expect(task.status).toBe('completed')
  expect(notifications[0]).toContain('<status>completed</status>')
  expect(await listAttentionItems(LIST)).toEqual([])
}, 30_000)

test('a filter that blocks everything still yields a non-empty message and a refusal failure', async () => {
  partialText = ''
  const messages = await collect()
  expect(findTurnFailure(messages)?.kind).toBe('refusal')
  const texts = assistantTexts(messages)
  expect(texts.some(t => t.includes('Content blocked by provider safety filter'))).toBe(true)
})

test('a streamed OpenAI refusal field is a refusal turn failure and its text stays visible', async () => {
  partialText = ''
  refusalField = "I'm sorry, I can't help with that request."
  finishReason = 'stop'
  const messages = await collect()
  expect(findTurnFailure(messages)?.kind).toBe('refusal')
  expect(assistantTexts(messages).some(t => t.includes("can't help with that request"))).toBe(true)
  // The refusal text is shown as ordinary assistant text, before the API-error message.
  const texts = messages.filter(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage)
  expect(texts.length).toBeGreaterThan(0)
})

test('a non-streamed OpenAI refusal field is a refusal turn failure and its text stays visible', async () => {
  partialText = ''
  refusalField = "I'm sorry, I can't help with that request."
  finishReason = 'stop'
  streamMode = 'wedged'
  const messages = await collect()
  expect(findTurnFailure(messages)?.kind).toBe('refusal')
  expect(assistantTexts(messages).some(t => t.includes("can't help with that request"))).toBe(true)
})

test('a null or empty refusal field next to normal content is not a failure', async () => {
  finishReason = 'stop'
  for (const value of [null, '']) {
    refusalField = value
    expect(findTurnFailure(await collect())).toBeUndefined()
    streamMode = 'wedged'
    expect(findTurnFailure(await collect())).toBeUndefined()
    streamMode = 'shim'
  }
})

test('a Gemini Vertex safety finish is a refusal turn failure through the real pipeline', async () => {
  streamMode = 'vertex'
  vertexResponse = { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }
  const failure = findTurnFailure(await collect())
  expect(failure?.kind).toBe('refusal')
  // A normal Vertex answer is not a failure.
  vertexResponse = { candidates: [{ content: { parts: [{ text: 'fine' }] }, finishReason: 'STOP' }] }
  expect(findTurnFailure(await collect())).toBeUndefined()
})

const hasToolUse = (messages: Message[]): boolean =>
  messages.some(
    m =>
      m.type === 'assistant' &&
      Array.isArray(m.message.content) &&
      m.message.content.some(block => (block as { type?: string }).type === 'tool_use'),
  )

test('a flagged finish that also carries a tool call stays tool_use: no refusal, no banner, the tool call survives', async () => {
  for (const mode of ['shim', 'wedged'] as const) {
    streamMode = mode
    withToolCall = true
    for (const reason of ['content_filter', 'safety']) {
      finishReason = reason
      const messages = await collect()
      expect(findTurnFailure(messages)).toBeUndefined()
      expect(messages.some(m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)).toBe(false)
      expect(hasToolUse(messages)).toBe(true)
      const stopReasons = messages
        .filter(m => m.type === 'assistant')
        .map(m => (m as { message: { stop_reason?: string | null } }).message.stop_reason)
      expect(stopReasons).toContain('tool_use')
      expect(stopReasons).not.toContain('refusal')
    }
  }
})

test('a refusal field next to a tool call also stays tool_use', async () => {
  withToolCall = true
  partialText = ''
  refusalField = 'cannot comply fully'
  finishReason = 'tool_calls'
  expect(findTurnFailure(await collect())).toBeUndefined()
  streamMode = 'wedged'
  expect(findTurnFailure(await collect())).toBeUndefined()
})

test('the same flagged finish without a tool call is still a refusal', async () => {
  withToolCall = false
  for (const mode of ['shim', 'wedged'] as const) {
    streamMode = mode
    expect(findTurnFailure(await collect())?.kind).toBe('refusal')
  }
})

test('a whitespace-only streamed refusal is not a refusal', async () => {
  finishReason = 'stop'
  refusalField = '   \n'
  expect(findTurnFailure(await collect())).toBeUndefined()
  streamMode = 'wedged'
  expect(findTurnFailure(await collect())).toBeUndefined()
})
