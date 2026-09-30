import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as realSessionStorage from '../../utils/sessionStorage.js'
import {
  getVerdictPath,
  readVerdict,
  recordVerdict,
} from '../../utils/verificationVerdicts.js'
import * as realAgentToolUtils from './agentToolUtils.js'
import { VERIFICATION_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resumeAgentBackground } from './resumeAgent.js'

// Phase 1: resuming a built-in verifier clears its previous verdict BEFORE
// the resumed run starts, so an old PASS cannot stay valid while (or after)
// the new run fails, errors, or cannot record. Mock layout follows
// resumeAgent.test.ts.

const pristineRealSessionStorage = { ...realSessionStorage }
const pristineRealAgentToolUtils = { ...realAgentToolUtils }

const LIST = 'resume-verdict-list'
const AGENT_ID = 'a0000verifier01'

let mockMetadata: Record<string, unknown> = {}
let lifecycleStarted: (() => void | Promise<void>) | undefined

mock.module('../../utils/sessionStorage.js', () => ({
  ...pristineRealSessionStorage,
  getAgentTranscript: async () => ({ messages: [], contentReplacements: [] }),
  readAgentMetadata: async () => mockMetadata,
  writeAgentMetadata: async () => {},
  getAgentTranscriptPath: (agentId: string) => `/tmp/${agentId}.jsonl`,
}))

mock.module('./agentToolUtils.js', () => ({
  ...pristineRealAgentToolUtils,
  runAsyncAgentLifecycle: async () => {
    await lifecycleStarted?.()
  },
}))

afterAll(() => {
  mock.module('../../utils/sessionStorage.js', () => ({
    ...pristineRealSessionStorage,
  }))
  mock.module('./agentToolUtils.js', () => ({ ...pristineRealAgentToolUtils }))
})

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/resumeAgent.verificationVerdict.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-resume-verdict-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  mockMetadata = { agentType: VERIFICATION_AGENT_TYPE, source: 'built-in' }
  lifecycleStarted = undefined
})

afterEach(() => {
  try {
    if (previousListId === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function verificationAgent(source: string): AgentDefinition {
  return {
    agentType: VERIFICATION_AGENT_TYPE,
    source,
    getSystemPrompt: () => 'You are a verifier.',
  } as unknown as AgentDefinition
}

function makeToolUseContext(activeAgents: AgentDefinition[]): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
    speculation: { status: 'idle' },
    tasks: {},
  }
  return {
    options: {
      agentDefinitions: { activeAgents, allAgents: activeAgents },
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
    getAppState: () => appState,
    setAppState: (f: (prev: unknown) => Record<string, unknown>) => {
      appState = f(appState)
    },
    contentReplacementState: { replacements: new Map() },
  } as unknown as ToolUseContext
}

function resume(context: ToolUseContext) {
  return resumeAgentBackground({
    agentId: AGENT_ID,
    prompt: 'check again',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' }) as never,
  })
}

test('resuming a built-in verifier clears its old verdict before the run starts', async () => {
  await recordVerdict({ agentId: AGENT_ID, verdict: 'PASS' }, LIST)
  // The resumed lifecycle is launched fire-and-forget; wait for it.
  const recordAtLifecycleStart = new Promise(resolve => {
    lifecycleStarted = async () => {
      resolve(await readVerdict(AGENT_ID, LIST))
    }
  })

  await resume(makeToolUseContext([verificationAgent('built-in')]))

  expect(await recordAtLifecycleStart).toBeUndefined()
  expect(await readVerdict(AGENT_ID, LIST)).toBeUndefined()
})

test('resume refuses to start when the old verdict cannot be cleared', async () => {
  // A directory at the record path makes the delete fail (not ENOENT).
  mkdirSync(getVerdictPath(AGENT_ID, LIST), { recursive: true })
  let started = false
  lifecycleStarted = () => {
    started = true
  }
  const context = makeToolUseContext([verificationAgent('built-in')])

  await expect(resume(context)).rejects.toThrow(
    /Refusing to run while a possibly stale verdict is on file/,
  )
  expect(started).toBe(false)
  // Nothing was registered for the refused run.
  expect(
    (context.getAppState() as unknown as { tasks: Record<string, unknown> })
      .tasks[AGENT_ID],
  ).toBeUndefined()
})

test('resuming a non-built-in "verification" agent leaves records alone', async () => {
  mockMetadata = { agentType: VERIFICATION_AGENT_TYPE, source: 'projectSettings' }
  await recordVerdict({ agentId: AGENT_ID, verdict: 'PASS' }, LIST)

  await resume(makeToolUseContext([verificationAgent('projectSettings')]))

  expect((await readVerdict(AGENT_ID, LIST))?.verdict).toBe('PASS')
})
