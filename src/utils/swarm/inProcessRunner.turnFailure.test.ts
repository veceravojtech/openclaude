import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
// Load the tool graph first (import-cycle TDZ otherwise).
import '../../constants/tools.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getErrorMessageIfRefusal } from '../../services/api/errors.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { listAttentionItems } from '../attentionItems.js'
import { createTask, getSubTeamTaskListId, getTask, listTasks } from '../tasks.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createAssistantAPIErrorMessage } from '../messages.js'
import { resetCommandQueue } from '../messageQueueManager.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

import { TEAMMATE_FAILURE_REASONS } from './teammateFailureReasons.js'

// A provider failure rarely throws: a usage-policy refusal, a 401, an
// overloaded response all arrive as an assistant API-error MESSAGE, the turn
// "completes", and the runner used to report `available` with no failure and
// no attention item — the lead never learned the teammate had failed.
//
// These tests drive the real runner with runAgent mocked at the same seam the
// other in-process runner tests use, and assert on what the LEAD receives:
// the idle notification written to its mailbox and the attention item.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type RunnerModule = typeof import('./inProcessRunner.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined
let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/inProcessRunner.turnFailure.test.ts')
  resetCommandQueue()
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-inproc-turnfailure-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    resetCommandQueue()
    mock.restore()
    // Spread copies: a factory returning the namespace itself is a no-op.
    if (actualPrompts) mock.module('../../constants/prompts.js', () => ({ ...actualPrompts! }))
    if (actualRunAgent) mock.module('../../tools/AgentTool/runAgent.js', () => ({ ...actualRunAgent! }))
    if (actualMailbox) mock.module('../teammateMailbox.js', () => ({ ...actualMailbox! }))
    if (actualSleep) mock.module('../sleep.js', () => ({ ...actualSleep! }))
    if (actualDiskOutput) mock.module('../task/diskOutput.js', () => ({ ...actualDiskOutput! }))
    setClaudeConfigHomeDirForTesting(undefined)
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

type Turn = () => unknown[] | Promise<unknown[]>

const assistantText = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: `assistant-${Math.random()}`,
  timestamp: new Date().toISOString(),
  message: {
    id: 'msg-1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  },
  ...extra,
})

type LeadNotification = {
  type: string
  idleReason?: string
  failureReason?: string
  summary?: string
}

type InboxMessage = { from: string; text: string; read: boolean }

async function runTeammate(
  turn: Turn,
  options: {
    onTasks?: (teamName: string, parentSessionId: string) => Promise<void>
    teamNameOverride?: string
    /** Spawn without a prompt: the teammate's first turn is a claimed task. */
    idle?: boolean
    /** Reuse an already imported runner module (one module, as in production). */
    runner?: RunnerModule
  } = {},
): Promise<{
  teamName: string
  taskId: string
  agentId: string
  notifications: LeadNotification[]
  rawLeadMessages: string[]
  inbox: InboxMessage[]
  turnCount: () => number
  runner: RunnerModule
  setAppState: (updater: (prev: AppState) => AppState) => void
  stop: () => Promise<void>
  waitForNotification: () => Promise<LeadNotification>
  waitForNotifications: (count: number) => Promise<void>
}> {
  const teamName =
    options.teamNameOverride ??
    `turnfail-${Math.random().toString(36).slice(2, 8)}`
  process.env.CLAUDE_CODE_TASK_LIST_ID = teamName
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(`../../constants/prompts.ts?tfActual=${stamp}`)
  actualRunAgent ??= await import(`../../tools/AgentTool/runAgent.ts?tfActual=${stamp}`)
  actualMailbox ??= await import(`../teammateMailbox.ts?tfActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?tfActual=${stamp}`)
  actualDiskOutput ??= await import(`../task/diskOutput.ts?tfActual=${stamp}`)
  const notifications: LeadNotification[] = []
  const rawLeadMessages: string[] = []
  const inbox: InboxMessage[] = []
  let turns = 0
  mock.module('../../constants/prompts.js', () => ({
    ...actualPrompts!,
    getSystemPrompt: async () => ['system prompt'],
  }))
  mock.module('../../tools/AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    runAgent: async function* () {
      turns++
      for (const message of await turn()) yield message as never
    },
  }))
  mock.module('../teammateMailbox.js', () => ({
    ...actualMailbox!,
    readMailbox: async (agentName: string) =>
      agentName === 'builder' ? inbox.map(m => ({ ...m })) : [],
    markMessageAsReadByIndex: async (agentName: string, _team: string, index: number) => {
      if (agentName !== 'builder') return
      const message = inbox[index]
      if (message) message.read = true
    },
    writeToMailbox: async (_recipient: string, message: { text: string }) => {
      rawLeadMessages.push(message.text)
      try {
        const parsed = JSON.parse(message.text) as LeadNotification
        if (parsed.type === 'idle_notification') notifications.push(parsed)
      } catch {
        // plain DM
      }
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))),
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))
  const runner: RunnerModule =
    options.runner ?? (await import(`./inProcessRunner.ts?turnFailure=${stamp}`))

  let state: AppState = getDefaultAppState()
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    { name: 'builder', teamName, planModeRequired: false },
    { setAppState, getAppState: () => state },
  )
  if (!spawn.success || !spawn.taskId || !spawn.teammateContext || !spawn.abortController) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  await options.onTasks?.(teamName, spawn.teammateContext.parentSessionId)
  const done = runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: 'builder',
      teamName,
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    ...(options.idle ? {} : { prompt: 'build it' }),
    description: 'build the parser',
    teammateContext: spawn.teammateContext,
    toolUseContext: {
      options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
      abortController: spawn.abortController,
      messages: [],
      readFileState: new Map(),
      getAppState: () => state,
      setAppState,
    } as unknown as ToolUseContext,
    abortController: spawn.abortController,
  })
  const waitForNotification = async (): Promise<LeadNotification> => {
    const deadline = Date.now() + 5000
    while (notifications.length === 0) {
      if (Date.now() > deadline) throw new Error('no idle notification reached the lead')
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    return notifications[0]!
  }
  const waitForNotifications = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5000
    while (notifications.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} idle notifications, got ${notifications.length}`)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  return {
    teamName,
    taskId: spawn.taskId,
    agentId: spawn.agentId,
    notifications,
    rawLeadMessages,
    inbox,
    turnCount: () => turns,
    runner,
    setAppState,
    waitForNotification,
    waitForNotifications,
    stop: async () => {
      spawn.abortController!.abort()
      await done
    },
  }
}

test('a usage-policy refusal reaches the lead as a failed notification and an attention item', async () => {
  const refusal = getErrorMessageIfRefusal('refusal', 'some-other-model')!
  const originalText = (refusal.message.content[0] as { text: string }).text
  expect(originalText).toContain('violate our Usage Policy')

  const run = await runTeammate(() => [refusal])
  const note = await run.waitForNotification()

  // Not `available`: the lead is told the turn FAILED, with the specific
  // reason and the original provider text.
  expect(note.idleReason).toBe('failed')
  expect(note.failureReason).toContain(TEAMMATE_FAILURE_REASONS.refusal)
  expect(note.failureReason).toContain(originalText)

  const items = await listAttentionItems(run.teamName)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    kind: 'failure',
    status: 'undecided',
    transient: false,
    source: { backend: 'in_process', agentId: run.agentId, agentName: 'builder' },
  })
  expect(items[0]!.summary).toContain('refused by the model provider')
  await run.stop()
})

test('an API error converted to a message (401) is a failure with its own kind', async () => {
  const text = 'API Error: 401 Please run /login · Invalid API key'
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage({ content: text, error: 'authentication_failed' }),
  ])
  const note = await run.waitForNotification()
  expect(note.idleReason).toBe('failed')
  expect(note.failureReason).toContain(TEAMMATE_FAILURE_REASONS.authentication)
  expect(note.failureReason).toContain('Invalid API key')
  expect(await listAttentionItems(run.teamName)).toHaveLength(1)
  await run.stop()
})

test('an overloaded response with no structured code still reports as a provider failure', async () => {
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' }),
  ])
  const note = await run.waitForNotification()
  expect(note.idleReason).toBe('failed')
  expect(note.failureReason).toContain(TEAMMATE_FAILURE_REASONS.provider)
  expect(note.failureReason).toContain('529 Overloaded')
  await run.stop()
})

test('an error followed by a successful assistant message was recovered and is not a failure', async () => {
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' }),
    assistantText('all done'),
  ])
  const note = await run.waitForNotification()
  expect(note.idleReason).toBe('available')
  expect(note.failureReason).toBeUndefined()
  expect(await listAttentionItems(run.teamName)).toEqual([])
  await run.stop()
})

test('a normal successful turn reports available with no failure and no attention item', async () => {
  const run = await runTeammate(() => [assistantText('parser built')])
  const note = await run.waitForNotification()
  expect(note.idleReason).toBe('available')
  expect(note.failureReason).toBeUndefined()
  expect(await listAttentionItems(run.teamName)).toEqual([])
  await run.stop()
})

test('a thrown exception reaches the lead as a failed notification and an attention item', async () => {
  const run = await runTeammate(() => {
    throw new Error('provider exploded mid-turn')
  })
  const note = await run.waitForNotification()
  expect(note.idleReason).toBe('failed')
  expect(note.failureReason).toContain('provider exploded mid-turn')
  expect(await listAttentionItems(run.teamName)).toHaveLength(1)
})

test('provider error text is redacted before it reaches the lead or the attention item', async () => {
  const secretText =
    'API Error: calling https://user:hunter2@proxy.example.com/v1/messages?api_key=SECRET123&x=1 rejected key sk-ant-api03-abcdefghijklmnop1234567890 with Authorization: Bearer abcDEF123456789xyzabcdef'
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage({ content: secretText, error: 'authentication_failed' }),
  ])
  await run.waitForNotification()
  const everything = JSON.stringify([
    run.rawLeadMessages,
    await listAttentionItems(run.teamName),
  ])
  expect(everything).not.toContain('sk-ant-api03-abcdefghijklmnop')
  expect(everything).not.toContain('abcDEF123456789xyzabcdef')
  expect(everything).not.toContain('hunter2')
  expect(everything).not.toContain('SECRET123')
  expect(everything).toContain('proxy.example.com')
  await run.stop()
})

test('a crash with secrets in the exception text is redacted on the older failure path too', async () => {
  const run = await runTeammate(() => {
    throw new Error('connect failed https://user:hunter2@proxy.example.com/v1?token=SECRET123 key sk-ant-api03-abcdefghijklmnop1234567890')
  })
  await run.waitForNotification()
  const everything = JSON.stringify([
    run.rawLeadMessages,
    await listAttentionItems(run.teamName),
  ])
  expect(everything).not.toContain('hunter2')
  expect(everything).not.toContain('SECRET123')
  expect(everything).not.toContain('sk-ant-api03-abcdefghijklmnop')
  expect(everything).toContain('connect failed')
})

test('a teammate failing every turn raises one item, holds its task and claims no further work', async () => {
  const lists: { listId: string; first: string; second: string } = { listId: '', first: '', second: '' }
  const run = await runTeammate(
    () => [createAssistantAPIErrorMessage({ content: 'API Error: 401 Please run /login', error: 'authentication_failed' })],
    {
      onTasks: async (_team, parentSessionId) => {
        lists.listId = parentSessionId
        const base = { description: 'd', status: 'pending' as const, blocks: [], blockedBy: [] }
        lists.first = await createTask(parentSessionId, { ...base, subject: 'first task' })
        lists.second = await createTask(parentSessionId, { ...base, subject: 'second task' })
      },
    },
  )
  await run.waitForNotifications(1)
  // Let the idle poll run: it must not claim the second task.
  await new Promise<void>(resolve => setTimeout(resolve, 300))

  expect(run.turnCount()).toBe(1)
  const items = await listAttentionItems(run.teamName)
  expect(items).toHaveLength(1)
  // The task the failed turn held was handed back, owner cleared, and held
  // for the lead's decision; the other was never claimed.
  const rows = await Promise.all(
    [lists.first, lists.second].map(id => getTask(lists.listId, id)),
  )
  const held = rows.filter(t => t?.metadata?.attentionHold === items[0]!.id)
  const untouched = rows.filter(t => t?.metadata?.attentionHold === undefined)
  expect(held).toHaveLength(1)
  expect(held[0]).toMatchObject({ status: 'pending' })
  expect(held[0]?.owner).toBeUndefined()
  expect(untouched).toHaveLength(1)
  expect(untouched[0]).toMatchObject({ status: 'pending' })
  expect(untouched[0]?.owner).toBeUndefined()
  expect((await listTasks(lists.listId)).filter(t => t.owner)).toEqual([])

  // A second failing turn (a prompt from the lead) folds into the same item.
  run.inbox.push({ from: 'team-lead', text: 'try again', read: false })
  await run.waitForNotifications(2)
  expect(run.turnCount()).toBe(2)
  expect(await listAttentionItems(run.teamName)).toHaveLength(1)
  expect(run.notifications.map(n => n.idleReason)).toEqual(['failed', 'failed'])
  await run.stop()
})

test('a repeat failure of a different kind updates the open item to the latest reason', async () => {
  let call = 0
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage(
      ++call === 1
        ? { content: 'API Error: 529 Overloaded' }
        : { content: 'API Error: 401 Please run /login', error: 'authentication_failed' },
    ),
  ])
  await run.waitForNotifications(1)
  const [first] = await listAttentionItems(run.teamName)
  expect(first!.summary).toContain(TEAMMATE_FAILURE_REASONS.provider)
  expect(first!.transient).toBe(true)

  run.inbox.push({ from: 'team-lead', text: 'try again', read: false })
  await run.waitForNotifications(2)
  const items = await listAttentionItems(run.teamName)
  expect(items).toHaveLength(1)
  expect(items[0]!.id).toBe(first!.id)
  expect(items[0]!.summary).toContain(TEAMMATE_FAILURE_REASONS.authentication)
  expect(items[0]!.summary).not.toContain(TEAMMATE_FAILURE_REASONS.provider)
  expect(items[0]!.summary).toContain('failed again, 2 times')
  expect(items[0]!.transient).toBe(false)
  expect(items[0]!.repeatCount).toBe(1)
  await run.stop()
})

test('the claim block dies with the runner: a same-name teammate spawned later claims tasks', async () => {
  const base = { description: 'd', status: 'pending' as const, blocks: [], blockedBy: [] }
  const SUB_TEAM = 'turnfail-root/builder-lead'
  const listId = getSubTeamTaskListId(SUB_TEAM)
  const failing = await runTeammate(
    () => [createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' })],
    { teamNameOverride: SUB_TEAM },
  )
  await failing.waitForNotifications(1)
  // Sub-team members have no root item: the block is held in the runner only.
  await createTask(listId, { ...base, subject: 'late task' })
  await new Promise<void>(resolve => setTimeout(resolve, 300))
  // Blocked: it ran its one failing turn and claimed nothing since.
  expect(failing.turnCount()).toBe(1)
  expect((await listTasks(listId)).filter(t => t.owner)).toEqual([])
  expect(failing.runner.failedTeammateHoldCountForTesting()).toBe(1)
  await failing.stop()
  // The block is removed when the runner exits.
  expect(failing.runner.failedTeammateHoldCountForTesting()).toBe(0)

  const successor = await runTeammate(() => [assistantText('picked it up')], {
    teamNameOverride: SUB_TEAM,
    idle: true,
    runner: failing.runner,
  })
  await successor.waitForNotifications(1)
  expect(successor.turnCount()).toBe(1)
  expect((await listTasks(listId)).filter(t => t.owner)).toHaveLength(1)
  await successor.stop()
})

test('only the first idle notification of a failed turn says failed; a later refresh reports status', async () => {
  const run = await runTeammate(() => [
    createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' }),
  ])
  await run.waitForNotifications(1)
  expect(run.notifications[0]!.idleReason).toBe('failed')

  // A helper starts working under this teammate: delegated activity changes,
  // so the idle poll re-sends the status.
  run.setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      helper: {
        type: 'local_agent',
        agentId: 'helper',
        delegationParentId: run.agentId,
        status: 'running',
      } as never,
    },
  }))
  await run.waitForNotifications(2)
  expect(run.notifications[1]!.idleReason).toBe('waiting_for_children')
  expect(run.notifications[1]!.failureReason).toBeUndefined()
  await run.stop()
})
