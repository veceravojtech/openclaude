import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState } from '../../Task.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asAgentId } from '../../types/ids.js'
import {
  listAttentionItems,
  settleAttentionWritesForTesting,
} from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { dequeueAll } from '../../utils/messageQueueManager.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'
import { enqueueAgentNotification } from './LocalAgentTask.js'

// Phase 5: the enqueueAgentNotification hook. One failed notification for a
// run the ROOT lead owns creates exactly one attention item, inside the
// branch that won the `notified` test-and-set.

const LIST = 'attention-notify-list'
const TASK_ID = 'agent-attn-1'
let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tasks/LocalAgentTask/attentionNotification.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attn-notify-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
})

afterEach(async () => {
  try {
    await settleAttentionWritesForTesting()
    dequeueAll()
    if (previousListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function store(task: Record<string, unknown>): SetAppState {
  let state = {
    tasks: { [TASK_ID]: task },
    speculation: { status: 'idle' },
  } as unknown as AppState
  return (f => {
    state = f(state)
  }) as SetAppState
}

function localTask(overrides: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    id: TASK_ID,
    type: 'local_agent',
    status: 'failed',
    description: 'Audit the retry path',
    startTime: 1,
    outputFile: `/tmp/${TASK_ID}.output`,
    outputOffset: 0,
    notified: false,
    agentId: TASK_ID,
    prompt: 'audit',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as LocalAgentTaskState
}

async function notify(
  setAppState: SetAppState,
  status: 'completed' | 'failed' | 'killed',
  extra: { error?: string; attentionTransient?: { transient: boolean; transientReason: string } } = {},
) {
  enqueueAgentNotification({
    taskId: TASK_ID,
    description: 'Audit the retry path',
    status,
    setAppState,
    ...extra,
  })
  await settleAttentionWritesForTesting()
  return listAttentionItems()
}

test('a failed local agent creates exactly one item; a duplicate notify creates none', async () => {
  const setAppState = store(localTask())
  const items = await notify(setAppState, 'failed', { error: 'TypeError: boom' })
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    id: `failure-${TASK_ID}-0`,
    kind: 'failure',
    status: 'undecided',
    transient: false,
    source: { taskId: TASK_ID, backend: 'local_agent' },
    retryKey: `task:${TASK_ID}`,
  })
  expect(items[0]!.summary).toContain('TypeError: boom')
  expect(await notify(setAppState, 'failed', { error: 'again' })).toHaveLength(1)
})

test('a resumed run that fails again gets its own item', async () => {
  const items = await notify(store(localTask({ resumeCount: 2 } as Partial<LocalAgentTaskState>)), 'failed', { error: '429 rate limit' })
  expect(items.map(i => i.id)).toEqual([`failure-${TASK_ID}-2`])
  expect(items[0]!.transient).toBe(true)
})

test('killed and completed create none', async () => {
  expect(await notify(store(localTask({ status: 'killed' })), 'killed')).toEqual([])
  expect(await notify(store(localTask({ status: 'completed' })), 'completed')).toEqual([])
})

test("a teammate's own subagent (parentAgentId) creates none", async () => {
  const task = localTask({ parentAgentId: asAgentId('researcher@team') })
  expect(await notify(store(task), 'failed', { error: 'boom' })).toEqual([])
})

test('inside a teammate context the hook creates none', async () => {
  const setAppState = store(localTask())
  await runWithTeammateContext(
    {
      agentId: 'w@team',
      agentName: 'w',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 's',
      isInProcess: true,
      abortController: new AbortController(),
    },
    () => {
      enqueueAgentNotification({ taskId: TASK_ID, description: 'd', status: 'failed', error: 'boom', setAppState })
    },
  )
  await settleAttentionWritesForTesting()
  expect(await listAttentionItems()).toEqual([])
})

test('a pane teammate failure records its identity and the caller transient hint; a sub-team member creates none', async () => {
  const pane = {
    ...localTask(),
    type: 'in_process_teammate',
    identity: { agentId: 'worker@team', agentName: 'worker', teamName: 'team' },
  }
  const items = await notify(store(pane), 'failed', {
    error: 'Pane exited without completing',
    attentionTransient: { transient: true, transientReason: 'pane exited (dead pane)' },
  })
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    source: { backend: 'pane', agentId: 'worker@team', agentName: 'worker', teamName: 'team' },
    transient: true,
    retryKey: 'agent:worker@team',
  })

  const sub = {
    ...localTask({ notified: false }),
    id: TASK_ID,
    type: 'in_process_teammate',
    identity: { agentId: 'w@team/lead', agentName: 'w', teamName: 'team/lead' },
  }
  enqueueAgentNotification({ taskId: TASK_ID, description: 'd', status: 'failed', error: 'x', setAppState: store(sub) })
  await settleAttentionWritesForTesting()
  expect(await listAttentionItems()).toHaveLength(1)
})
