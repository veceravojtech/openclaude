import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asAgentId } from '../../types/ids.js'
import {
  enqueuePendingNotification,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../messageQueueManager.js'
import type { Task } from '../tasks.js'
import type { TeammateMessage } from '../teammateMailbox.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

// Defect 1, the wake half: a background agent spawned inside a teammate's turn
// stamps that teammate's id on its completion (LocalAgentTask), but the
// teammate is parked in pollForNextPromptOrShutdown by the time the agent
// finishes — no query loop of its own is running to drain it, and every
// coordinator drain filters the command out for being addressed. So the poll
// loop drains it itself and runs a turn on it. These tests pin that, the
// chosen priority, and the fact that nothing addressed elsewhere is touched.

const TEAM_NAME = 'notify-team'
const WORKER = 'notify-worker'
// formatAgentId(name, team) — what identity.agentId is, and what the poll loop
// matches queued commands against.
const WORKER_AGENT_ID = asAgentId(`${WORKER}@${TEAM_NAME}`)

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
    'utils/swarm/inProcessRunner.taskNotification.test.ts',
  )
  resetCommandQueue()
})

afterEach(() => {
  try {
    resetCommandQueue()
    mock.restore()
    if (actualPrompts) {
      mock.module('../../constants/prompts.js', () => actualPrompts!)
    }
    if (actualRunAgent) {
      mock.module('../../tools/AgentTool/runAgent.js', () => actualRunAgent!)
    }
    if (actualMailbox) {
      mock.module('../teammateMailbox.js', () => actualMailbox!)
    }
    if (actualTasks) {
      mock.module('../tasks.js', () => actualTasks!)
    }
    if (actualSleep) {
      mock.module('../sleep.js', () => actualSleep!)
    }
    if (actualDiskOutput) {
      mock.module('../task/diskOutput.js', () => actualDiskOutput!)
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type RunAgentParams = Parameters<RunAgentModule['runAgent']>[0]

type Harness = {
  runner: RunnerModule
  runAgentCalls: RunAgentParams[]
  leadMailbox: Array<{ from: string; text: string }>
  teammateInbox: TeammateMessage[]
  taskList: Task[]
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?notifyActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?notifyActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?notifyActual=${stamp}`)
  actualTasks ??= await import(`../tasks.ts?notifyActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?notifyActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?notifyActual=${stamp}`
  )

  const runAgentCalls: RunAgentParams[] = []
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
      yield {
        type: 'assistant',
        uuid: `assistant-${runAgentCalls.length}`,
        timestamp: new Date().toISOString(),
        message: {
          id: `msg-${runAgentCalls.length}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'noted' }],
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
    `./inProcessRunner.ts?taskNotification=${stamp}`
  )
  return { runner, runAgentCalls, leadMailbox, teammateInbox, taskList }
}

function idleNotificationCount(
  leadMailbox: Array<{ from: string; text: string }>,
): number {
  let total = 0
  for (const message of leadMailbox) {
    try {
      const parsed = JSON.parse(message.text) as { type?: string }
      if (parsed.type === 'idle_notification') total++
    } catch {
      // not JSON: a plain DM, ignore
    }
  }
  return total
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

async function settle(ms = 60): Promise<void> {
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

/** The completion block LocalAgentTask enqueues, verbatim in shape. */
function notificationText(taskId: string, summary: string): string {
  return `<task-notification>
<task-id>${taskId}</task-id>
<output-file>/tmp/${taskId}.output</output-file>
<status>completed</status>
<summary>${summary}</summary>
</task-notification>`
}

type StartedTeammate = {
  taskId: string
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
  getState: () => AppState
}

async function startIdleTeammate(harness: Harness): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const getState = (): AppState => state
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    {
      name: WORKER,
      teamName: TEAM_NAME,
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
  // The id the poll loop matches queued commands against.
  expect(spawn.agentId).toBe(WORKER_AGENT_ID)
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
      agentName: WORKER,
      teamName: TEAM_NAME,
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    teammateContext: spawn.teammateContext,
    toolUseContext,
    abortController: spawn.abortController,
  })
  return { taskId: spawn.taskId, abortController: spawn.abortController, done, getState }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  const result = await started.done
  expect(result.success).toBe(true)
}

test('an idle teammate wakes for its own notification and runs exactly one turn', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)

  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 1,
    'initial idle notification',
  )
  expect(harness.runAgentCalls).toHaveLength(0)

  const text = notificationText('agent-abc', 'Agent "Count call sites" completed')
  enqueuePendingNotification({
    value: text,
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })

  await waitFor(() => harness.runAgentCalls.length >= 1, 'notification turn')
  const prompt = userContentOf(harness.runAgentCalls[0]!)
  // The envelope reaches the model verbatim, exactly as the coordinator sees
  // it — no <teammate-message> wrapper around a system notification.
  expect(prompt).toBe(text)
  expect(prompt).toContain('<task-notification>')
  expect(prompt).toContain('<task-id>agent-abc</task-id>')
  expect(prompt).not.toContain('teammate_id=')

  // Drained, not left behind.
  expect(getCommandQueueSnapshot()).toHaveLength(0)

  // Exactly one turn, then back to idle; the notification is mirrored into the
  // transcript like any other prompt the teammate ran on.
  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 2,
    'post-turn idle notification',
  )
  await settle()
  expect(harness.runAgentCalls).toHaveLength(1)
  const afterTurn = getTeammateTask(started.getState(), started.taskId)
  expect(afterTurn?.isIdle).toBe(true)
  expect(afterTurn?.messages?.map(m => m.type)).toEqual(['user', 'assistant'])

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
})

test('an unaddressed notification is left in the queue untouched', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)

  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 1,
    'initial idle notification',
  )

  // The coordinator's own background agent…
  enqueuePendingNotification({
    value: notificationText('agent-lead', 'Agent "lead work" completed'),
    mode: 'task-notification',
  })
  // …and one addressed to a different teammate.
  enqueuePendingNotification({
    value: notificationText('agent-peer', 'Agent "peer work" completed'),
    mode: 'task-notification',
    agentId: asAgentId(`other-worker@${TEAM_NAME}`),
  })
  // …and a user prompt that happens to carry this teammate's id.
  enqueuePendingNotification({
    value: 'a prompt, not a notification',
    mode: 'prompt',
    agentId: WORKER_AGENT_ID,
  })

  // Several poll rounds go by and it stays parked.
  await settle(200)
  expect(harness.runAgentCalls).toHaveLength(0)
  expect(idleNotificationCount(harness.leadMailbox)).toBe(1)
  expect(getCommandQueueSnapshot()).toHaveLength(3)

  await stopTeammate(started)
  expect(getCommandQueueSnapshot()).toHaveLength(3)
})

test('several addressed notifications arrive in one turn, none dropped', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)

  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 1,
    'initial idle notification',
  )

  const first = notificationText('agent-one', 'Agent "one" completed')
  const second = notificationText('agent-two', 'Agent "two" completed')
  enqueuePendingNotification({
    value: first,
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })
  enqueuePendingNotification({
    value: second,
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })

  await waitFor(() => harness.runAgentCalls.length >= 1, 'notification turn')
  const prompt = userContentOf(harness.runAgentCalls[0]!)
  // dequeueAllMatching takes both off the queue at once, so both have to be in
  // the prompt — dropping one would lose it outright.
  expect(prompt).toContain('<task-id>agent-one</task-id>')
  expect(prompt).toContain('<task-id>agent-two</task-id>')
  expect(prompt).toBe(`${first}\n\n${second}`)
  expect(getCommandQueueSnapshot()).toHaveLength(0)

  await settle(120)
  expect(harness.runAgentCalls).toHaveLength(1)

  await stopTeammate(started)
})

test('a queued notification outranks an unread peer message', async () => {
  // The documented priority at the poll site: after pendingUserMessages and
  // the mailbox shutdown scan, before team-lead/FIFO peer selection.
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)

  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 1,
    'initial idle notification',
  )

  harness.teammateInbox.push({
    from: 'team-lead',
    text: 'unrelated peer chatter',
    timestamp: new Date().toISOString(),
    read: false,
  })
  const text = notificationText('agent-abc', 'Agent "Count call sites" completed')
  enqueuePendingNotification({
    value: text,
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })

  // Both turns run back to back, so assert on the recorded ORDER rather than
  // on a count the poller could race past.
  await waitFor(() => harness.runAgentCalls.length >= 2, 'both turns')
  await settle()
  expect(harness.runAgentCalls).toHaveLength(2)

  expect(userContentOf(harness.runAgentCalls[0]!)).toBe(text)
  // The peer message is not lost — it is simply second.
  const second = userContentOf(harness.runAgentCalls[1]!)
  expect(second).toContain('unrelated peer chatter')
  expect(second).toContain('teammate_id="team-lead"')

  await stopTeammate(started)
})

test('a shutdown request still pre-empts a queued notification', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)

  await waitFor(
    () => idleNotificationCount(harness.leadMailbox) === 1,
    'initial idle notification',
  )

  harness.teammateInbox.push({
    from: 'team-lead',
    text: JSON.stringify({
      type: 'shutdown_request',
      requestId: 'req-1',
      from: 'team-lead',
      timestamp: new Date().toISOString(),
    }),
    timestamp: new Date().toISOString(),
    read: false,
  })
  enqueuePendingNotification({
    value: notificationText('agent-abc', 'Agent "late" completed'),
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })

  await waitFor(() => harness.runAgentCalls.length >= 1, 'shutdown turn')
  // The FIRST turn is the shutdown request; the notification waits its turn.
  const prompt = userContentOf(harness.runAgentCalls[0]!)
  expect(prompt).toContain('shutdown_request')
  expect(prompt).not.toContain('<task-notification>')

  await stopTeammate(started)
})
