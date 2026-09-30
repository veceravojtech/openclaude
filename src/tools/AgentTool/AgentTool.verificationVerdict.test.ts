import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
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
// agent records nothing, and an errored run records nothing.
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

async function importAgentTool(script: {
  finalText: string
  throwAfter?: Error
}): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  // Each SDK task_notification with whether a verdict file for the run's
  // agentId existed at the moment it was enqueued.
  notifications: Array<{ status?: string; verdictsDirExisted: boolean }>
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

  const notifications: Array<{ status?: string; verdictsDirExisted: boolean }> =
    []

  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule!,
    enhanceSystemPromptWithEnvDetails: mock(
      async (prompts: string[]) => prompts,
    ),
  }))
  mock.module('../../utils/sdkEventQueue.js', () => ({
    ...actualSdkEventQueueModule!,
    enqueueSdkEvent: (event: SdkEvent) => {
      if (event.subtype === 'task_notification') {
        notifications.push({
          status: event.status,
          verdictsDirExisted: existsSync(getVerdictsDir(LIST)),
        })
      }
    },
  }))
  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule!,
    runAgent: mock(async function* () {
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
  return { AgentTool, notifications }
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
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] as Array<{ name: string }> },
    todos: {},
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
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function callVerifier(
  AgentTool: AgentToolModule['AgentTool'],
  source: string,
) {
  const result = await AgentTool.call(
    {
      description: 'Verify the change',
      prompt: 'Verify it.',
      subagent_type: VERIFICATION_AGENT_TYPE,
    },
    createToolUseContext([verificationAgent(source)]),
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

test('sync built-in verification run records its verdict before completion is signalled', async () => {
  const { AgentTool, notifications } = await importAgentTool({
    finalText: 'checked everything\nVERDICT: PASS',
  })

  const { data, trailer } = await callVerifier(AgentTool, 'built-in')

  expect(data.status).toBe('completed')
  expect((await readVerdict(data.agentId, LIST))?.verdict).toBe('PASS')
  expect(existsSync(getVerdictPath(data.agentId, LIST))).toBe(true)
  // The SDK "completed" notification only went out once the record existed.
  expect(notifications).toEqual([
    { status: 'completed', verdictsDirExisted: true },
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
