import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { injectUserMessageToTeammate } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { Task } from '../tasks.js'
import type { TeammateMessage } from '../teammateMailbox.js'
import {
  killInProcessTeammate,
  spawnInProcessTeammate,
} from './spawnInProcess.js'

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type TasksModule = typeof import('../tasks.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type RunnerModule = typeof import('./inProcessRunner.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualTasks: TasksModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/inProcessRunner.idleSpawn.test.ts',
  )
})

afterEach(() => {
  try {
    mock.restore()
    // Each restore must hand `mock.module` a SPREAD COPY. In bun 1.3.9 a
    // factory returning the module namespace object itself is a silent no-op,
    // which left the mocks above installed for every later file in the process
    // (a neutered `sleep` then busy-spun other suites into multi-GB heaps).
    if (actualPrompts) {
      mock.module('../../constants/prompts.js', () => ({ ...actualPrompts! }))
    }
    if (actualRunAgent) {
      mock.module('../../tools/AgentTool/runAgent.js', () => ({ ...actualRunAgent! }))
    }
    if (actualMailbox) {
      mock.module('../teammateMailbox.js', () => ({ ...actualMailbox! }))
    }
    if (actualTasks) {
      mock.module('../tasks.js', () => ({ ...actualTasks! }))
    }
    if (actualSleep) {
      mock.module('../sleep.js', () => ({ ...actualSleep! }))
    }
    if (actualDiskOutput) {
      mock.module('../task/diskOutput.js', () => ({ ...actualDiskOutput! }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type RunAgentParams = Parameters<RunAgentModule['runAgent']>[0]

type Harness = {
  runner: RunnerModule
  runAgentCalls: RunAgentParams[]
  /** Idle notifications already sent to the lead when each turn started. */
  idleCountAtTurnStart: number[]
  /** Messages the runner sent to the lead's mailbox. */
  leadMailbox: Array<{ from: string; text: string }>
  /** The teammate's own inbox, read by the runner's poll loop. */
  teammateInbox: TeammateMessage[]
  /** The team task list returned by listTasks(). */
  taskList: Task[]
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(`../../constants/prompts.ts?idleActual=${stamp}`)
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?idleActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?idleActual=${stamp}`)
  actualTasks ??= await import(`../tasks.ts?idleActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?idleActual=${stamp}`)
  actualDiskOutput ??= await import(`../task/diskOutput.ts?idleActual=${stamp}`)

  const runAgentCalls: RunAgentParams[] = []
  const idleCountAtTurnStart: number[] = []
  const leadMailbox: Array<{ from: string; text: string }> = []
  const teammateInbox: TeammateMessage[] = []
  const taskList: Task[] = []

  mock.module('../../constants/prompts.js', () => ({
    ...actualPrompts!,
    getSystemPrompt: async () => ['system prompt'],
  }))
  mock.module('../../tools/AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    runAgent: async function* (params: RunAgentParams) {
      runAgentCalls.push(params)
      idleCountAtTurnStart.push(idleNotifications(leadMailbox).length)
      yield {
        type: 'assistant',
        uuid: `assistant-${runAgentCalls.length}`,
        timestamp: new Date().toISOString(),
        message: {
          id: `msg-${runAgentCalls.length}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      } as never
    },
  }))
  mock.module('../teammateMailbox.js', () => ({
    ...actualMailbox!,
    readMailbox: async () => teammateInbox.map(m => ({ ...m })),
    markMessageAsReadByIndex: async (
      _agentName: string,
      _teamName: string | undefined,
      index: number,
    ) => {
      const message = teammateInbox[index]
      if (message) message.read = true
    },
    writeToMailbox: async (
      recipient: string,
      message: { from: string; text: string },
    ) => {
      if (recipient === 'team-lead') {
        leadMailbox.push({ from: message.from, text: message.text })
      }
    },
  }))
  mock.module('../tasks.js', () => ({
    ...actualTasks!,
    listTasks: async () => taskList.map(t => ({ ...t })),
    claimTask: async (
      _taskListId: string,
      taskId: string,
      claimant: string,
    ) => {
      const task = taskList.find(t => t.id === taskId)
      if (!task || task.owner) return { success: false, reason: 'already_claimed' }
      task.owner = claimant
      return { success: true }
    },
    updateTask: async (
      _taskListId: string,
      taskId: string,
      updates: Partial<Task>,
    ) => {
      const task = taskList.find(t => t.id === taskId)
      if (!task) return null
      Object.assign(task, updates)
      return { ...task }
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    // Keep the 500ms poll loop but make it fast for the test.
    sleep: (ms: number) =>
      new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))),
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))

  const runner: RunnerModule = await import(
    `./inProcessRunner.ts?idleSpawn=${stamp}`
  )
  return {
    runner,
    runAgentCalls,
    idleCountAtTurnStart,
    leadMailbox,
    teammateInbox,
    taskList,
  }
}

function idleNotifications(
  leadMailbox: Array<{ from: string; text: string }>,
): Array<{ from: string; idleReason?: string }> {
  const notifications: Array<{ from: string; idleReason?: string }> = []
  for (const message of leadMailbox) {
    try {
      const parsed = JSON.parse(message.text) as {
        type?: string
        idleReason?: string
      }
      if (parsed.type === 'idle_notification') {
        notifications.push({
          from: message.from,
          idleReason: parsed.idleReason,
        })
      }
    } catch {
      // not JSON: a plain DM, ignore
    }
  }
  return notifications
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function settle(ms = 40): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

function getTeammateTask(
  state: AppState,
  taskId: string,
): InProcessTeammateTaskState | undefined {
  const task = state.tasks[taskId]
  return task?.type === 'in_process_teammate'
    ? (task as InProcessTeammateTaskState)
    : undefined
}

function userContentOf(params: RunAgentParams): string {
  const first = params.promptMessages[0]
  if (!first || first.type !== 'user') return ''
  const content = first.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

type StartedTeammate = {
  taskId: string
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}

async function startTeammate(
  harness: Harness,
  options: { name: string; prompt?: string; description?: string },
): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const getState = (): AppState => state
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    {
      name: options.name,
      teamName: 'idle-team',
      prompt: options.prompt,
      planModeRequired: false,
    },
    { setAppState, getAppState: () => state },
  )
  if (
    !spawn.success ||
    !spawn.taskId ||
    !spawn.teammateContext ||
    !spawn.abortController
  ) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  const toolUseContext = {
    options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
    abortController: spawn.abortController,
    messages: [],
    readFileState: new Map(),
    getAppState: getState,
    setAppState,
  } as unknown as ToolUseContext

  const done = harness.runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: options.name,
      teamName: 'idle-team',
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    prompt: options.prompt,
    description: options.description,
    teammateContext: spawn.teammateContext,
    toolUseContext,
    abortController: spawn.abortController,
  })
  return {
    taskId: spawn.taskId,
    abortController: spawn.abortController,
    done,
    getState,
    setAppState,
  }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  const result = await started.done
  expect(result.success).toBe(true)
}

test('an idle spawn parks without a turn, then runs exactly one turn for a mailbox message', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startTeammate(harness, { name: 'idle-worker' })
  const { taskId, getState } = started

  // Parked: the lead is told once, nothing has run, no user message mirrored.
  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 1,
    'initial idle notification',
  )
  expect(idleNotifications(harness.leadMailbox)).toEqual([
    { from: 'idle-worker', idleReason: 'available' },
  ])
  // Give the poll loop a few rounds to prove it stays parked.
  await settle()
  expect(harness.runAgentCalls).toHaveLength(0)
  const parked = getTeammateTask(getState(), taskId)
  expect(parked?.isIdle).toBe(true)
  expect(parked?.messages ?? []).toHaveLength(0)
  expect(parked?.description).toBe('idle-worker: idle (waiting for work)')

  // Work arrives through the mailbox.
  harness.teammateInbox.push({
    from: 'team-lead',
    text: 'Please summarize the repository layout',
    timestamp: new Date().toISOString(),
    read: false,
  })
  await waitFor(() => harness.runAgentCalls.length === 1, 'first turn')
  const turnPrompt = userContentOf(harness.runAgentCalls[0]!)
  expect(turnPrompt).toContain('Please summarize the repository layout')
  expect(turnPrompt).toContain('teammate_id="team-lead"')

  // After the turn it parks again and tells the lead again.
  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 2,
    'post-turn idle notification',
  )
  expect(harness.runAgentCalls).toHaveLength(1)
  const afterTurn = getTeammateTask(getState(), taskId)
  expect(afterTurn?.isIdle).toBe(true)
  // Exactly the mirrored lead message and the assistant reply.
  expect(afterTurn?.messages?.map(m => m.type)).toEqual(['user', 'assistant'])

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
  expect(idleNotifications(harness.leadMailbox)).toHaveLength(2)
})

test('an idle spawn runs a turn for a message typed into its view', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startTeammate(harness, { name: 'idle-worker' })
  const { taskId, setAppState } = started

  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 1,
    'initial idle notification',
  )
  expect(harness.runAgentCalls).toHaveLength(0)

  injectUserMessageToTeammate(taskId, 'typed from the view', setAppState)
  await waitFor(
    () => harness.runAgentCalls.length === 1,
    'turn for the typed message',
  )
  expect(userContentOf(harness.runAgentCalls[0]!)).toBe('typed from the view')

  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 2,
    'post-turn idle notification',
  )
  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
})

test('an idle spawn picks up queued task-list work at once instead of parking', async () => {
  const harness = await importRunnerWithMocks()
  harness.taskList.push({
    id: '7',
    subject: 'Write the release notes',
    description: 'Cover the idle spawn feature',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  const started = await startTeammate(harness, { name: 'idle-worker' })
  const { taskId, getState } = started

  await waitFor(() => harness.runAgentCalls.length === 1, 'task-list turn')
  const turnPrompt = userContentOf(harness.runAgentCalls[0]!)
  expect(turnPrompt).toContain('Start with task #7')
  expect(turnPrompt).toContain('Write the release notes')
  expect(turnPrompt).toContain('teammate_id="task-list"')
  // The claimed task was the first turn: no idle notification preceded it.
  expect(harness.idleCountAtTurnStart).toEqual([0])
  expect(harness.taskList[0]?.owner).toBe('idle-worker')
  expect(harness.taskList[0]?.status).toBe('in_progress')

  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 1,
    'post-turn idle notification',
  )
  const afterTurn = getTeammateTask(getState(), taskId)
  expect(afterTurn?.messages?.map(m => m.type)).toEqual(['user', 'assistant'])

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
})

test('a prompted spawn runs its first turn immediately and sends exactly one idle notification', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startTeammate(harness, {
    name: 'busy-worker',
    prompt: 'Summarize the repository layout',
    description: 'summarize',
  })
  const { taskId, getState } = started

  await waitFor(() => harness.runAgentCalls.length === 1, 'first turn')
  const turnPrompt = userContentOf(harness.runAgentCalls[0]!)
  expect(turnPrompt).toContain('Summarize the repository layout')
  expect(turnPrompt).toContain('teammate_id="team-lead"')
  expect(turnPrompt).toContain('summary="summarize"')
  // No idle notification before the first turn.
  expect(harness.idleCountAtTurnStart).toEqual([0])

  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 1,
    'idle notification',
  )
  expect(idleNotifications(harness.leadMailbox)).toEqual([
    { from: 'busy-worker', idleReason: 'available' },
  ])
  const afterTurn = getTeammateTask(getState(), taskId)
  expect(afterTurn?.isIdle).toBe(true)
  // The wrapped initial prompt is mirrored before the turn, as before.
  expect(afterTurn?.messages?.map(m => m.type)).toEqual(['user', 'assistant'])

  // Stays parked with a single notification.
  await settle()
  expect(idleNotifications(harness.leadMailbox)).toHaveLength(1)

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
  expect(idleNotifications(harness.leadMailbox)).toHaveLength(1)
})

test('an idle spawn killed before it parks neither touches the task nor tells the lead', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startTeammate(harness, { name: 'idle-worker' })
  const { taskId, getState, setAppState } = started

  // The runner is still suspended in setup (getSystemPrompt); kill it there,
  // the same window a prompted spawn's loop guard already covers.
  expect(killInProcessTeammate(taskId, setAppState)).toBe(true)
  expect(getTeammateTask(getState(), taskId)?.status).toBe('killed')
  const result = await started.done
  expect(result.success).toBe(true)

  await settle()
  expect(harness.runAgentCalls).toHaveLength(0)
  expect(idleNotifications(harness.leadMailbox)).toHaveLength(0)
  // The runner's exit path no longer evicts the terminal task: a killed teammate
  // keeps its row for TEAMMATE_GRACE_MS, dimmed and reading `killed`, and the
  // shared funnel collects it once the window closes.
  const killed = getTeammateTask(getState(), taskId)
  expect(killed?.status).toBe('killed')
  expect(killed?.retain).toBe(false)
  expect(killed?.evictAfter).toBeGreaterThan(Date.now())
})
