import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { backgroundAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { getErrorMessageIfRefusal } from '../../services/api/errors.js'
import { listAttentionItems } from '../../utils/attentionItems.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { TEAMMATE_FAILURE_REASONS } from '../../utils/swarm/teammateFailureReasons.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// A provider failure ends an Agent-tool run as an API-error assistant message,
// not an exception. These drive the real AgentTool.call: a synchronous run
// answered inline must come back marked as a failure, and a foreground run
// moved to the background must be reported failed (with an attention item),
// never completed with the error text as its result.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('./runAgent.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')
type SdkEventQueueModule = typeof import('../../utils/sdkEventQueue.js')
type AgentToolModule = typeof import('./AgentTool.js')

const LIST = 'agent-tool-turnfail-list'

let actualPromptsModule: PromptsModule | undefined
let actualRunAgentModule: RunAgentModule | undefined
let actualSettingsModule: SettingsModule | undefined
let actualSdkEventQueueModule: SdkEventQueueModule | undefined
let settingsForTest: SettingsJson = {}
let configDir: string | undefined
let previousListId: string | undefined

const ROUTE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_TEAMMATE_PROFILE_ID',
] as const
const savedRouteEnv: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>> =
  {}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/AgentTool.turnFailure.test.ts',
  )
  for (const key of ROUTE_ENV_KEYS) {
    savedRouteEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-agent-turnfail-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  resetSettingsCache()
  actualSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentTurnFailSettingsActual=${Date.now()}-${Math.random()}`
  )
  // Keep the model dispatcher out of the way: this test is about wiring.
  settingsForTest = { teammateDispatch: { mode: 'off' } } as SettingsJson
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsModule!,
    getInitialSettings: () => settingsForTest,
    getSettings_DEPRECATED: () => settingsForTest,
  }))
})

afterEach(() => {
  try {
    mock.restore()
    if (actualPromptsModule) {
      mock.module('../../constants/prompts.js', () => ({
        ...actualPromptsModule!,
      }))
    }
    if (actualRunAgentModule) {
      mock.module('./runAgent.js', () => ({ ...actualRunAgentModule! }))
    }
    if (actualWorktreeModule) {
      mock.module('../../utils/worktree.js', () => ({ ...actualWorktreeModule! }))
    }
    if (actualSettingsModule) {
      mock.module('../../utils/settings/settings.js', () => ({
        ...actualSettingsModule!,
      }))
    }
    if (actualSdkEventQueueModule) {
      mock.module('../../utils/sdkEventQueue.js', () => ({
        ...actualSdkEventQueueModule!,
      }))
    }
    resetSettingsCache()
    settingsForTest = {}
  } finally {
    if (previousListId === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
    for (const key of ROUTE_ENV_KEYS) {
      const saved = savedRouteEnv[key]
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    releaseSharedMutationLock()
  }
})


type WorktreeModule = typeof import('../../utils/worktree.js')
let actualWorktreeModule: WorktreeModule | undefined

type Script = {
  messages: () => unknown[]
  background?: boolean
  /** Pretend worktree isolation created (and kept) a worktree. */
  worktree?: boolean
}

async function importAgentTool(script: Script) {
  actualPromptsModule ??= await import(
    `../../constants/prompts.ts?agentTurnFailActual=${Date.now()}-${Math.random()}`
  )
  actualRunAgentModule ??= await import(
    `./runAgent.ts?agentTurnFailActual=${Date.now()}-${Math.random()}`
  )
  actualSdkEventQueueModule ??= await import(
    `../../utils/sdkEventQueue.ts?agentTurnFailActual=${Date.now()}-${Math.random()}`
  )
  actualWorktreeModule ??= await import(
    `../../utils/worktree.ts?agentTurnFailActual=${Date.now()}-${Math.random()}`
  )
  if (script.worktree) {
    mock.module('../../utils/worktree.js', () => ({
      ...actualWorktreeModule!,
      createAgentWorktree: async () => ({
        worktreePath: '/tmp/fake-agent-worktree',
        worktreeBranch: 'agent/fake-branch',
        hookBased: true,
      }),
    }))
  }
  let resolveForeground: (agentId: string) => void = () => {}
  const foregroundStarted = new Promise<string>(resolve => {
    resolveForeground = resolve
  })
  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule!,
    enhanceSystemPromptWithEnvDetails: mock(async (prompts: string[]) => prompts),
  }))
  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule!,
    runAgent: mock(async function* (params: {
      isAsync?: boolean
      override?: { agentId?: string }
    }) {
      if (script.background && !params.isAsync) {
        resolveForeground(String(params.override?.agentId))
        await new Promise(() => {})
      }
      for (const message of script.messages()) yield message as never
    }),
  }))
  const { AgentTool } = await import(
    `./AgentTool.js?agentTurnFail=${Date.now()}-${Math.random()}`
  )
  return { AgentTool: AgentTool as AgentToolModule['AgentTool'], foregroundStarted }
}

const workerAgent = (): AgentDefinition =>
  ({
    agentType: 'worker-x',
    color: 'orange',
    source: 'built-in',
    whenToUse: 'work',
    getSystemPrompt: () => 'You work.',
  }) as unknown as AgentDefinition

const assistant = (text: string) => ({
  type: 'assistant',
  uuid: `assistant-${Math.random()}`,
  message: {
    id: `msg-${Math.random()}`,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
})

function createToolUseContext(): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] as Array<{ name: string }> },
    todos: {},
    tasks: {},
    speculation: { status: 'idle' },
  }
  const agents = [workerAgent()]
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'parent-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: agents, allAgents: agents },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    messages: [],
    getAppState: () => appState,
    setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      appState = f(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function callWorker(
  AgentTool: AgentToolModule['AgentTool'],
  context: ToolUseContext,
  extraInput: Record<string, unknown> = {},
) {
  const result = await AgentTool.call(
    { description: 'Do the work', prompt: 'Do it.', subagent_type: 'worker-x', ...extraInput } as never,
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { message: { id: 'parent-message' } } as never,
  )
  const data = result.data as { status: string; agentId: string; failure?: string }
  const block = AgentTool.mapToolResultToToolResultBlockParam(
    result.data as never,
    'toolu_work',
  ) as { is_error?: boolean; content: Array<{ text: string }> }
  return { data, block }
}

async function takeTaskNotification(agentId: string): Promise<string> {
  const matches = (cmd: { value: unknown; mode?: string }) =>
    cmd.mode === 'task-notification' &&
    typeof cmd.value === 'string' &&
    cmd.value.includes(`<task-id>${agentId}</task-id>`)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = dequeueAllMatching(matches as never)
    if (found.length > 0) return String(found[0]!.value)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`no task notification for ${agentId}`)
}

async function runBackgrounded(messages: () => unknown[]) {
  const { AgentTool, foregroundStarted } = await importAgentTool({
    messages,
    background: true,
  })
  const context = createToolUseContext()
  const call = callWorker(AgentTool, context)
  const agentId = await foregroundStarted
  expect(
    backgroundAgentTask(
      agentId,
      context.getAppState as never,
      context.setAppState as never,
    ),
  ).toBe(true)
  await call
  const notification = await takeTaskNotification(agentId)
  await new Promise(resolve => setTimeout(resolve, 100))
  return { agentId, notification }
}

test('a sync run that ends on a refusal comes back as an explicit failure, not as an answer', async () => {
  const refusal = getErrorMessageIfRefusal('refusal', 'some-other-model')!
  const { AgentTool } = await importAgentTool({
    messages: () => [assistant('partial work'), refusal],
  })
  const { data, block } = await callWorker(AgentTool, createToolUseContext())

  expect(data.failure).toContain(TEAMMATE_FAILURE_REASONS.refusal)
  expect(data.failure).toContain('violate our Usage Policy')
  expect(block.is_error).toBe(true)
  expect(block.content[0]!.text).toStartWith('Agent failed: ')
  expect(block.content[0]!.text).toContain(TEAMMATE_FAILURE_REASONS.refusal)
})

test('a failed sync run keeps its partial work and the worktree it left changes in', async () => {
  const refusal = getErrorMessageIfRefusal('refusal', 'some-other-model')!
  const { AgentTool } = await importAgentTool({
    messages: () => [assistant('edited parser.ts, tests still missing'), refusal],
    worktree: true,
  })
  const { block } = await callWorker(AgentTool, createToolUseContext(), {
    isolation: 'worktree',
  })
  const text = block.content[0]!.text
  expect(block.is_error).toBe(true)
  expect(text).toContain(TEAMMATE_FAILURE_REASONS.refusal)
  // The agent's own words before it failed, not the error text as its answer.
  expect(text).toContain('edited parser.ts, tests still missing')
  expect(text).toContain('worktreePath: /tmp/fake-agent-worktree')
  expect(text).not.toContain('undefined')
})

test('a sync run with a redacted secret in the provider error never shows the secret', async () => {
  const { AgentTool } = await importAgentTool({
    messages: () => [
      createAssistantAPIErrorMessage({
        content:
          'API Error: bad key sk-ant-api03-abcdefghijklmnop1234567890 via https://u:pw@proxy.example.com/v1?api_key=SECRET123',
      }),
    ],
  })
  const { block } = await callWorker(AgentTool, createToolUseContext())
  const text = block.content[0]!.text
  expect(block.is_error).toBe(true)
  expect(text).not.toContain('sk-ant-api03-abcdefghijklmnop')
  expect(text).not.toContain('SECRET123')
  expect(text).not.toContain('u:pw@')
})

test('a normal sync run is a plain completed answer', async () => {
  const { AgentTool } = await importAgentTool({ messages: () => [assistant('all done')] })
  const { data, block } = await callWorker(AgentTool, createToolUseContext())
  expect(data.failure).toBeUndefined()
  expect(block.is_error).toBeUndefined()
  expect(block.content[0]!.text).toBe('all done')
})

test('a foreground run moved to the background that ends on a refusal is reported failed, with an attention item', async () => {
  const refusal = getErrorMessageIfRefusal('refusal', 'some-other-model')!
  const { agentId, notification } = await runBackgrounded(() => [
    assistant('partial work'),
    refusal,
  ])

  expect(notification).toContain('<status>failed</status>')
  expect(notification).not.toContain('<status>completed</status>')
  expect(notification).toContain('refused by the model provider')
  const items = await listAttentionItems(LIST)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    kind: 'failure',
    status: 'undecided',
    source: { taskId: agentId },
  })
}, 30_000)

test('a backgrounded run that finishes normally still completes with no attention item', async () => {
  const { notification } = await runBackgrounded(() => [assistant('all done')])
  expect(notification).toContain('<status>completed</status>')
  expect(await listAttentionItems(LIST)).toEqual([])
}, 30_000)
