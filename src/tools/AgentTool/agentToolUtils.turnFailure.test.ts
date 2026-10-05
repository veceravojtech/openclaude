import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Load the tool graph before agentToolUtils (pre-existing import cycle).
import '../../constants/tools.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getErrorMessageIfRefusal } from '../../services/api/errors.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { listAttentionItems } from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { TEAMMATE_FAILURE_REASONS } from '../../utils/swarm/teammateFailureReasons.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'

// A background agent whose provider call fails does not throw: the failure is
// yielded as an API-error assistant message and the stream ends. It used to be
// reported as `completed` with the error text as its "result" and no attention
// item, so the lead never learned the agent had failed.

const LIST = 'agent-turn-failure-list'
const TASK_ID = 'a0000turnfail001'

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/agentToolUtils.turnFailure.test.ts')
  resetCommandQueue()
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-agent-turnfail-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
})

afterEach(() => {
  try {
    resetCommandQueue()
    if (previousListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function assistant(text: string) {
  return {
    type: 'assistant',
    uuid: `assistant-${Math.random()}`,
    message: {
      id: `msg-${Math.random()}`,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

async function runLifecycle(stream: () => AsyncGenerator<unknown, void>) {
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
    makeStream: stream as never,
    metadata: {
      prompt: 'research it',
      resolvedAgentModel: 'test-model',
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
  const task = (state.tasks as Record<string, { status: string; error?: string }>)[
    TASK_ID
  ]!
  // The attention item is written fire-and-forget by the notification hook.
  await new Promise<void>(resolve => setTimeout(resolve, 100))
  const notifications = getCommandQueue()
    .map(c => (typeof c.value === 'string' ? c.value : JSON.stringify(c.value)))
    .filter(v => v.includes('<task-notification>'))
  return { task, notifications }
}

describe('runAsyncAgentLifecycle failure detection', () => {
  test('a usage-policy refusal is a failed run with the refusal reason, the original text and an attention item', async () => {
    const refusal = getErrorMessageIfRefusal('refusal', 'some-other-model')!
    const { task, notifications } = await runLifecycle(async function* () {
      yield assistant('starting')
      yield refusal
    })

    expect(task.status).toBe('failed')
    expect(task.error).toContain(TEAMMATE_FAILURE_REASONS.refusal)
    expect(task.error).toContain('violate our Usage Policy')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('<status>failed</status>')
    expect(notifications[0]).toContain('refused by the model provider')
    // What the agent produced before the refusal is not lost.
    expect(notifications[0]).toContain('starting')

    const items = await listAttentionItems(LIST)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'failure',
      status: 'undecided',
      source: { backend: 'local_agent', taskId: TASK_ID },
    })
  })

  test('an API error converted to a message (401) is a failed run', async () => {
    const { task, notifications } = await runLifecycle(async function* () {
      yield createAssistantAPIErrorMessage({
        content: 'API Error: 401 Please run /login · Invalid API key',
        error: 'authentication_failed',
      })
    })
    expect(task.status).toBe('failed')
    expect(task.error).toContain(TEAMMATE_FAILURE_REASONS.authentication)
    expect(notifications[0]).toContain('<status>failed</status>')
    expect(await listAttentionItems(LIST)).toHaveLength(1)
  })

  test('secrets in the provider error text never reach the notification, task row or attention item', async () => {
    const { task, notifications } = await runLifecycle(async function* () {
      yield createAssistantAPIErrorMessage({
        content:
          'API Error: calling https://user:hunter2@proxy.example.com/v1?api_key=SECRET123 rejected key sk-ant-api03-abcdefghijklmnop1234567890 with Authorization: Bearer abcDEF123456789xyzabcdef',
      })
    })
    const everything = JSON.stringify([
      task,
      notifications,
      await listAttentionItems(LIST),
    ])
    expect(task.status).toBe('failed')
    for (const secret of [
      'hunter2',
      'SECRET123',
      'sk-ant-api03-abcdefghijklmnop',
      'abcDEF123456789xyzabcdef',
    ]) {
      expect(everything).not.toContain(secret)
    }
    expect(everything).toContain('proxy.example.com')
  })

  test('a thrown exception is still a failed run with an attention item', async () => {
    const { task } = await runLifecycle(async function* () {
      yield assistant('working')
      throw new Error('provider exploded')
    })
    expect(task.status).toBe('failed')
    expect(task.error).toContain('provider exploded')
    expect(await listAttentionItems(LIST)).toHaveLength(1)
  })

  test('a normal run still completes with no failure and no attention item', async () => {
    const { task, notifications } = await runLifecycle(async function* () {
      yield assistant('parser researched')
    })
    expect(task.status).toBe('completed')
    expect(notifications[0]).toContain('<status>completed</status>')
    expect(await listAttentionItems(LIST)).toEqual([])
  })
})
