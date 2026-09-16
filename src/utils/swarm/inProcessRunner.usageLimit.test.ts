import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetCommandQueue } from '../messageQueueManager.js'
import type { Task } from '../tasks.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
// Imported canonically: the runner is re-imported under a cache-busting
// specifier below, but its own import of the guard resolves to this same
// module record, so the state the test reads is the state the runner wrote.
import {
  clearCannotProceed,
  isCannotProceed,
  markCannotProceed,
  shouldReportUsageLimit,
} from './usageLimitGuard.js'

// An out-of-usage 429 is yielded as an assistant message rather than thrown
// (services/api/claude.ts), so the turn reports SUCCESS. Left alone the
// teammate parks idle, messages the lead, claims the next task with no
// awaited delay, fails again — one lead-bound message per lap at CPU speed.
//
// These tests pin the runner half of the fix end to end: the teammate stops
// instead of spinning, hands its claim back rather than stranding it, the
// lead hears the notice exactly once WITH the reset time, a teammate gated by
// another's stop never claims at all, and the failed-turn floor exists
// without regressing the deliberate fast path for genuinely fresh idle.

const TEAM_NAME = 'limit-team'
const WORKER = 'limit-worker'

/** Verbatim shape of what services/rateLimitMessages.ts produces. */
const OUT_OF_USAGE = "You're out of extra usage · resets 3pm"

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
  await acquireSharedMutationLock('utils/swarm/inProcessRunner.usageLimit.test.ts')
  resetCommandQueue()
  // Module-level by design (in-process teammates share a process), so it
  // leaks between tests unless reset.
  clearCannotProceed()
})

afterEach(() => {
  try {
    resetCommandQueue()
    clearCannotProceed()
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
  leadMailbox: Array<{ from: string; text: string }>
  taskList: Task[]
  claimCalls: string[]
  sleepCalls: number[]
}

function pendingTask(id: string, subject: string): Task {
  return {
    id,
    subject,
    description: `do ${subject}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
  }
}

/**
 * @param turnOutcome what each turn's assistant message should be — an
 * out-of-usage limit, some other API error, or an ordinary success.
 */
async function importRunnerWithMocks(
  turnOutcome: 'usage-limit' | 'other-api-error' | 'success',
): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?limitActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?limitActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?limitActual=${stamp}`)
  actualTasks ??= await import(`../tasks.ts?limitActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?limitActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?limitActual=${stamp}`
  )

  const runAgentCalls: RunAgentParams[] = []
  const leadMailbox: Array<{ from: string; text: string }> = []
  const taskList: Task[] = []
  const claimCalls: string[] = []
  const sleepCalls: number[] = []

  const turnText =
    turnOutcome === 'usage-limit'
      ? OUT_OF_USAGE
      : turnOutcome === 'other-api-error'
        ? 'API Error: 529 Overloaded'
        : 'noted'

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
        // The keystone: an API error travels as a MESSAGE, so the turn
        // still reports success and the runner's terminal catch never sees
        // it. Anything that only handles throws misses this entirely.
        ...(turnOutcome === 'success' ? {} : { isApiErrorMessage: true }),
        message: {
          id: `msg-${runAgentCalls.length}`,
          role: 'assistant',
          content: [{ type: 'text', text: turnText }],
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
    readMailbox: async () => [],
    markMessageAsReadByIndex: async () => {},
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
    claimTask: async (_listId: string, taskId: string, agentName: string) => {
      claimCalls.push(taskId)
      const task = taskList.find(t => t.id === taskId)
      if (!task) return { success: false, reason: 'not found' }
      task.owner = agentName
      return { success: true }
    },
    updateTask: async (
      _listId: string,
      taskId: string,
      updates: Partial<Task>,
    ) => {
      const task = taskList.find(t => t.id === taskId)
      if (task) Object.assign(task, updates)
      return { success: true }
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    sleep: (ms: number) => {
      sleepCalls.push(ms)
      // Record the REQUESTED duration, then return fast so the test does not
      // actually wait out the floor it is asserting on.
      return new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5)))
    },
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))

  const runner: RunnerModule = await import(
    `./inProcessRunner.ts?usageLimit=${stamp}`
  )
  return { runner, runAgentCalls, leadMailbox, taskList, claimCalls, sleepCalls }
}

/** Lead-bound idle notifications carrying the given text. */
function notificationsMentioning(
  leadMailbox: Array<{ from: string; text: string }>,
  needle: string,
): string[] {
  const found: string[] = []
  for (const message of leadMailbox) {
    try {
      const parsed = JSON.parse(message.text) as { type?: string }
      if (parsed.type === 'idle_notification' && message.text.includes(needle)) {
        found.push(message.text)
      }
    } catch {
      // not JSON: a plain DM, ignore
    }
  }
  return found
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function settle(ms = 150): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

type StartedTeammate = {
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
}

/** Spawns an idle teammate, which claims from the task list on startup. */
async function startTeammate(
  harness: Harness,
  name = WORKER,
): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    { name, teamName: TEAM_NAME, planModeRequired: false },
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
    getAppState: () => state,
    setAppState,
  } as unknown as ToolUseContext

  const done = harness.runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: name,
      teamName: TEAM_NAME,
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    teammateContext: spawn.teammateContext,
    toolUseContext,
    abortController: spawn.abortController,
  })
  return { abortController: spawn.abortController, done }
}

test('a teammate that hits the limit stops, hands its task back, and tells the lead once', async () => {
  const harness = await importRunnerWithMocks('usage-limit')
  harness.taskList.push(pendingTask('1', 'first task'))
  harness.taskList.push(pendingTask('2', 'second task'))

  const started = await startTeammate(harness)

  // It exits on its own — no abort from the test. Before the fix it would
  // park idle and come straight back for task #2.
  const result = await started.done
  expect(result.success).toBe(true)

  // One turn, not one per remaining task.
  expect(harness.runAgentCalls).toHaveLength(1)
  expect(harness.claimCalls).toEqual(['1'])

  // The claim is handed back, owner cleared — findAvailableTask rejects any
  // truthy owner, so a status-only reset would strand it unclaimable.
  const released = harness.taskList.find(t => t.id === '1')!
  expect(released.status).toBe('pending')
  expect(released.owner).toBeFalsy()

  // The lead is told, exactly once, and the reset time survives the trip.
  const reports = notificationsMentioning(harness.leadMailbox, 'out of extra usage')
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('resets 3pm')

  // And the stop is recorded so no other teammate picks up where it left off.
  expect(isCannotProceed()).toBe(true)
})

test('a second teammate on the same limit adds no further lead-bound message', async () => {
  const harness = await importRunnerWithMocks('usage-limit')
  harness.taskList.push(pendingTask('1', 'first task'))

  // Stand in for a teammate that already reported this exact notice. Five
  // teammates hit one account-wide limit at the same instant; the lead needs
  // it once, not five times.
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)

  const started = await startTeammate(harness)
  const result = await started.done
  expect(result.success).toBe(true)

  // It still stops and still releases — it just does not re-report.
  expect(harness.taskList.find(t => t.id === '1')!.status).toBe('pending')
  expect(
    notificationsMentioning(harness.leadMailbox, 'out of extra usage'),
  ).toHaveLength(0)
})

test('a teammate spawned while the account is stopped never claims a task', async () => {
  const harness = await importRunnerWithMocks('usage-limit')
  harness.taskList.push(pendingTask('1', 'first task'))

  // Another teammate already stopped the account.
  markCannotProceed(OUT_OF_USAGE)

  const started = await startTeammate(harness)
  await settle(300)

  // Never claimed, never ran, and the task is untouched and still available
  // for whoever picks it up after usage returns.
  expect(harness.claimCalls).toEqual([])
  expect(harness.runAgentCalls).toHaveLength(0)
  const task = harness.taskList.find(t => t.id === '1')!
  expect(task.status).toBe('pending')
  expect(task.owner).toBeFalsy()

  started.abortController.abort()
  await started.done
})

test('a turn that fails on some other API error waits before the next one', async () => {
  const harness = await importRunnerWithMocks('other-api-error')
  harness.taskList.push(pendingTask('1', 'first task'))

  const started = await startTeammate(harness)
  await waitFor(() => harness.runAgentCalls.length >= 1, 'first turn')
  await settle(300)

  // A 529 is not a reason to stop the whole account — the teammate keeps
  // going and the lead is not told it is out of usage.
  expect(
    notificationsMentioning(harness.leadMailbox, 'out of extra usage'),
  ).toHaveLength(0)
  // …but it IS a reason not to sprint into the next turn. Nothing else on
  // this path awaits anything, so without the floor it spins at CPU speed.
  expect(harness.sleepCalls).toContain(1000)

  started.abortController.abort()
  await started.done
})

test('a successful turn keeps the deliberate no-wait fast path into idle', async () => {
  const harness = await importRunnerWithMocks('success')
  harness.taskList.push(pendingTask('1', 'first task'))

  const started = await startTeammate(harness)
  await waitFor(() => harness.runAgentCalls.length >= 1, 'first turn')
  await settle(300)

  // The floor lives on the FAILURE path only. Putting it in the poll loop
  // instead would have slowed every genuinely fresh idle period — the
  // pollCount>0 skip is correct and must stay that way.
  expect(harness.sleepCalls).not.toContain(1000)

  started.abortController.abort()
  await started.done
})
