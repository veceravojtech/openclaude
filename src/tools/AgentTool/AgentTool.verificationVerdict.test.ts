import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
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
import { getTasksDir } from '../../utils/tasks.js'
import {
  getVerdictPath,
  getVerdictsDir,
  readVerdict,
} from '../../utils/verificationVerdicts.js'
import { VERIFICATION_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Phase 1 wiring through the real synchronous AgentTool.call path: a built-in
// verification run records its verdict under its agentId BEFORE completion
// is signalled (SDK task_notification), an overriding custom "verification"
// agent records nothing, and an errored run records nothing. A run moved to
// the background reports in its completion notification whether the verdict
// was recorded.
// Harness modelled on AgentTool.routing.test.ts.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('./runAgent.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')
type SdkEventQueueModule = typeof import('../../utils/sdkEventQueue.js')
type AgentToolModule = typeof import('./AgentTool.js')

const LIST = 'agent-tool-verdict-list'

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
    'tools/AgentTool/AgentTool.verificationVerdict.test.ts',
  )
  for (const key of ROUTE_ENV_KEYS) {
    savedRouteEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-agent-verdict-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  resetSettingsCache()
  actualSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentVerdictSettingsActual=${Date.now()}-${Math.random()}`
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

type SdkEvent = { type: string; subtype?: string; status?: string }

// What the on-disk record for the run's own agentId said at the moment an
// SDK task_notification was enqueued. Read synchronously on purpose: the
// enqueue is synchronous, and an async read would observe the file later.
type NotificationObservation = {
  status?: string
  recordAgentId?: string
  recordVerdict?: string
}

type Script = {
  finalText: string
  throwAfter?: Error
  // Move the run to the background: the foreground run blocks until the
  // test backgrounds it, then the background continuation produces the
  // final text. beforeFinal runs in the background continuation first.
  background?: { beforeFinal?: () => void }
}

function readRecordSync(agentId: string): {
  agentId?: string
  verdict?: string
} {
  const path = getVerdictPath(agentId, LIST)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

async function importAgentTool(script: Script): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  notifications: NotificationObservation[]
  // agentId of each runAgent call, as AgentTool passed it in override.agentId.
  runAgentIds: string[]
  foregroundStarted: Promise<string>
}> {
  actualPromptsModule ??= await import(
    `../../constants/prompts.ts?agentVerdictActual=${Date.now()}-${Math.random()}`
  )
  actualRunAgentModule ??= await import(
    `./runAgent.ts?agentVerdictActual=${Date.now()}-${Math.random()}`
  )
  actualSdkEventQueueModule ??= await import(
    `../../utils/sdkEventQueue.ts?agentVerdictActual=${Date.now()}-${Math.random()}`
  )

  const notifications: NotificationObservation[] = []
  const runAgentIds: string[] = []
  let resolveForeground: (agentId: string) => void = () => {}
  const foregroundStarted = new Promise<string>(resolve => {
    resolveForeground = resolve
  })

  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule!,
    enhanceSystemPromptWithEnvDetails: mock(
      async (prompts: string[]) => prompts,
    ),
  }))
  mock.module('../../utils/sdkEventQueue.js', () => ({
    ...actualSdkEventQueueModule!,
    enqueueSdkEvent: (event: SdkEvent) => {
      if (event.subtype !== 'task_notification') return
      const agentId = runAgentIds[0]
      const record = agentId ? readRecordSync(agentId) : {}
      notifications.push({
        status: event.status,
        recordAgentId: record.agentId,
        recordVerdict: record.verdict,
      })
    },
  }))
  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule!,
    runAgent: mock(async function* (params: {
      isAsync?: boolean
      override?: { agentId?: string }
    }) {
      const agentId = String(params.override?.agentId)
      runAgentIds.push(agentId)
      if (script.background) {
        if (!params.isAsync) {
          // Foreground leg: never yields; the test backgrounds it.
          resolveForeground(agentId)
          await new Promise(() => {})
        }
        script.background.beforeFinal?.()
      }
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: script.finalText }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }
      if (script.throwAfter) throw script.throwAfter
    }),
  }))

  const { AgentTool } = await import(
    `./AgentTool.js?agentVerdict=${Date.now()}-${Math.random()}`
  )
  return { AgentTool, notifications, runAgentIds, foregroundStarted }
}

function verificationAgent(source: string): AgentDefinition {
  return {
    agentType: VERIFICATION_AGENT_TYPE,
    color: 'orange',
    source,
    whenToUse: 'verify work',
    getSystemPrompt: () => 'You are a verifier.',
  } as unknown as AgentDefinition
}

function createToolUseContext(activeAgents: AgentDefinition[]): ToolUseContext {
  // A real (if minimal) store: foreground registration, backgrounding and
  // the background completion notification all go through it.
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
      agentDefinitions: { activeAgents, allAgents: activeAgents },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
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

async function callVerifier(
  AgentTool: AgentToolModule['AgentTool'],
  source: string,
  context: ToolUseContext = createToolUseContext([verificationAgent(source)]),
) {
  const result = await AgentTool.call(
    {
      description: 'Verify the change',
      prompt: 'Verify it.',
      subagent_type: VERIFICATION_AGENT_TYPE,
    },
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { message: { id: 'parent-message' } } as never,
  )
  const data = result.data as { status: string; agentId: string }
  const block = AgentTool.mapToolResultToToolResultBlockParam(
    result.data as never,
    'toolu_verify',
  )
  const trailer = JSON.stringify(block.content)
  return { data, trailer }
}

/** Waits for the background completion notification for `agentId`. */
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

test('sync built-in verification run records its verdict before completion is signalled', async () => {
  const { AgentTool, notifications, runAgentIds } = await importAgentTool({
    finalText: 'checked everything\nVERDICT: PASS',
  })

  const { data, trailer } = await callVerifier(AgentTool, 'built-in')

  expect(data.status).toBe('completed')
  expect(runAgentIds).toEqual([data.agentId])
  expect((await readVerdict(data.agentId, LIST))?.verdict).toBe('PASS')
  // At the moment the SDK "completed" notification was enqueued, this run's
  // own record was already on disk and said PASS.
  expect(notifications).toEqual([
    { status: 'completed', recordAgentId: data.agentId, recordVerdict: 'PASS' },
  ])
  expect(trailer).toContain(
    'verificationVerdict: PASS (recorded for this agentId',
  )
  expect(trailer).toContain(`metadata.verifiedBy: '${data.agentId}'`)
})

test('a custom agent overriding the "verification" name records nothing', async () => {
  const { AgentTool } = await importAgentTool({
    finalText: 'trust me\nVERDICT: PASS',
  })

  const { data, trailer } = await callVerifier(AgentTool, 'projectSettings')

  expect(data.status).toBe('completed')
  expect(await readVerdict(data.agentId, LIST)).toBeUndefined()
  expect(existsSync(getVerdictsDir(LIST))).toBe(false)
  expect(trailer).not.toContain('verificationVerdict')
})

test('an errored sync verification run records nothing', async () => {
  const { AgentTool } = await importAgentTool({
    finalText: 'VERDICT: PASS',
    throwAfter: new Error('provider exploded'),
  })

  // The sync path recovers partial output from an errored run and returns
  // it, but must not record a verdict for it.
  const { data, trailer } = await callVerifier(AgentTool, 'built-in')

  expect(data.status).toBe('completed')
  expect(await readVerdict(data.agentId, LIST)).toBeUndefined()
  expect(existsSync(getVerdictsDir(LIST))).toBe(false)
  expect(trailer).not.toContain('verificationVerdict')
})

async function runBackgroundedVerifier(script: Script) {
  const { AgentTool, foregroundStarted } = await importAgentTool(script)
  const context = createToolUseContext([verificationAgent('built-in')])
  const call = callVerifier(AgentTool, 'built-in', context)
  const agentId = await foregroundStarted
  expect(
    backgroundAgentTask(
      agentId,
      context.getAppState as never,
      context.setAppState as never,
    ),
  ).toBe(true)
  const { data } = await call
  expect(data.agentId).toBe(agentId)
  const notification = await takeTaskNotification(agentId)
  return { agentId, notification }
}

test('a verification run moved to the background records and reports its verdict', async () => {
  const { agentId, notification } = await runBackgroundedVerifier({
    finalText: 'checked\nVERDICT: PASS',
    background: {},
  })

  expect(notification).toContain('<status>completed</status>')
  expect(notification).toContain(
    `verificationVerdict: PASS (recorded for this agentId; to complete a task with requiresVerification, set metadata.verifiedBy: '${agentId}'`,
  )
  expect((await readVerdict(agentId, LIST))?.verdict).toBe('PASS')
}, 30_000)

test('a backgrounded verification run whose write fails says NOT recorded', async () => {
  const { agentId, notification } = await runBackgroundedVerifier({
    finalText: 'checked\nVERDICT: PASS',
    background: {
      // After the launch-time clear, put a regular file where the
      // .verdicts directory must go, so recording the verdict fails.
      beforeFinal: () => {
        mkdirSync(getTasksDir(LIST), { recursive: true })
        writeFileSync(getVerdictsDir(LIST), 'not a directory')
      },
    },
  })

  expect(notification).toContain('<status>completed</status>')
  expect(notification).toContain('verificationVerdict: PASS (NOT recorded:')
  expect(notification).not.toContain('(recorded for this agentId')
  expect(await readVerdict(agentId, LIST)).toBeUndefined()
}, 30_000)
