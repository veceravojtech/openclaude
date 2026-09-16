import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
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
// These tests pin the runner half of the fix end to end: the teammate PARKS
// instead of spinning — alive, holding no claim, and resumable with its work
// intact — hands its claim back rather than stranding it, the lead hears the
// notice exactly once WITH the reset time and is told 'parked' rather than
// 'failed', a teammate gated by another's stop never claims at all, and the
// failed-turn floor exists without regressing the deliberate fast path for
// genuinely fresh idle.
//
// The park replaced an earlier stop-and-exit. Exiting was the wrong shape for
// a RECOVERABLE failure: returning from runInProcessTeammate destroys the
// runner-local `allMessages` buffer and `lastTurnAgentId`, which together are
// the only complete record of the teammate's work, so anything downstream
// could offer would be a cold respawn rather than a continuation.

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

/** What a single model turn should come back as. */
type TurnOutcome = 'usage-limit' | 'other-api-error' | 'success'

type InboxMessage = { from: string; text: string; read: boolean }

type Harness = {
  runner: RunnerModule
  runAgentCalls: RunAgentParams[]
  leadMailbox: Array<{ from: string; text: string }>
  /**
   * The teammate's OWN inbox, served by the readMailbox mock. Pushing to it is
   * exactly what SendMessageTool does to a live teammate, so it is how a test
   * resumes a parked one.
   */
  workerInbox: InboxMessage[]
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
 * out-of-usage limit, some other API error, or an ordinary success. Pass an
 * ARRAY to give each successive turn its own outcome (the last entry holds for
 * any turn beyond the sequence), which is what lets a test drive a teammate
 * INTO a park on turn 1 and back OUT of it on turn 2.
 */
async function importRunnerWithMocks(
  turnOutcome: TurnOutcome | TurnOutcome[],
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
  const workerInbox: InboxMessage[] = []
  const taskList: Task[] = []
  const claimCalls: string[] = []
  const sleepCalls: number[] = []

  const outcomes: TurnOutcome[] = Array.isArray(turnOutcome)
    ? turnOutcome
    : [turnOutcome]

  const textFor = (outcome: TurnOutcome): string =>
    outcome === 'usage-limit'
      ? OUT_OF_USAGE
      : outcome === 'other-api-error'
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
      // This call is already recorded, so it is the LAST entry: index by
      // length-1, and hold the final outcome for any turn past the sequence.
      const outcome = outcomes[runAgentCalls.length - 1] ?? outcomes.at(-1)!
      yield {
        type: 'assistant',
        uuid: `assistant-${runAgentCalls.length}`,
        timestamp: new Date().toISOString(),
        // The keystone: an API error travels as a MESSAGE, so the turn
        // still reports success and the runner's terminal catch never sees
        // it. Anything that only handles throws misses this entirely.
        ...(outcome === 'success' ? {} : { isApiErrorMessage: true }),
        message: {
          id: `msg-${runAgentCalls.length}`,
          role: 'assistant',
          content: [{ type: 'text', text: textFor(outcome) }],
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
    // Only the worker's own inbox is backed; the sub-team `team-lead` inbox the
    // runner also polls stays empty, as it is for a teammate that leads nobody.
    readMailbox: async (agentName: string) =>
      agentName === WORKER ? workerInbox.map(m => ({ ...m })) : [],
    markMessageAsReadByIndex: async (
      agentName: string,
      _teamName: string,
      index: number,
    ) => {
      if (agentName !== WORKER) return
      const message = workerInbox[index]
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
  return {
    runner,
    runAgentCalls,
    leadMailbox,
    workerInbox,
    taskList,
    claimCalls,
    sleepCalls,
  }
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

/** Waits until the runner has recorded the park on the teammate's row. */
async function waitForPark(started: StartedTeammate): Promise<void> {
  await waitFor(
    () => teammateRow(started)?.parkedNotice !== undefined,
    'the teammate to park',
  )
}

/**
 * True when `runInProcessTeammate` has NOT returned within `ms`.
 *
 * The distinction the whole change rests on: the promise resolving means the
 * runner unwound and took the conversation buffer with it, so a teammate can
 * only be continuable if this stays pending.
 */
async function stillRunning(
  started: StartedTeammate,
  ms = 300,
): Promise<boolean> {
  const outcome = await Promise.race([
    started.done.then(() => 'returned' as const),
    new Promise<'running'>(resolve => setTimeout(() => resolve('running'), ms)),
  ])
  return outcome === 'running'
}

type StartedTeammate = {
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
  /** The teammate's row id, and a reader for the AppState the runner writes. */
  taskId: string
  getState: () => AppState
}

/** The teammate's own row, narrowed — the runner is the only writer. */
function teammateRow(
  started: StartedTeammate,
): InProcessTeammateTaskState | undefined {
  const task = started.getState().tasks[started.taskId]
  return task && task.type === 'in_process_teammate' ? task : undefined
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
  return {
    abortController: spawn.abortController,
    done,
    taskId: spawn.taskId,
    getState: () => state,
  }
}

test('a teammate that hits the limit parks alive, hands its task back, and tells the lead once', async () => {
  const harness = await importRunnerWithMocks('usage-limit')
  harness.taskList.push(pendingTask('1', 'first task'))
  harness.taskList.push(pendingTask('2', 'second task'))

  const started = await startTeammate(harness)
  await waitForPark(started)

  // It does NOT exit. A usage limit is recoverable; ending the teammate over
  // it is not, and it would take the runner-local conversation buffer with it.
  expect(await stillRunning(started)).toBe(true)

  // One turn, not one per remaining task — it parks instead of coming straight
  // back for task #2.
  expect(harness.runAgentCalls).toHaveLength(1)
  expect(harness.claimCalls).toEqual(['1'])

  // The claim is handed back, owner cleared — findAvailableTask rejects any
  // truthy owner, so a status-only reset would strand it unclaimable. Parking
  // must not hold a claimed task hostage.
  const released = harness.taskList.find(t => t.id === '1')!
  expect(released.status).toBe('pending')
  expect(released.owner).toBeFalsy()

  // The lead is told, exactly once, and the reset time survives the trip.
  const reports = notificationsMentioning(harness.leadMailbox, 'out of extra usage')
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('resets 3pm')
  // …and it is told the truth: parked, not failed. The row agrees with it.
  expect(JSON.parse(reports[0]!).idleReason).toBe('parked')
  expect(JSON.parse(reports[0]!).completedStatus).toBeUndefined()

  // The row stays alive and running, carrying the park as a field. Anything
  // else drops it out of getRunningTeammatesSorted and nothing could reach it.
  const row = teammateRow(started)!
  expect(row.status).toBe('running')
  expect(row.parkedNotice).toContain('out of extra usage')
  expect(row.parkedAt).toBeGreaterThan(0)
  // Not evicted: the grace pair is the terminal transition's, and no terminal
  // transition happened.
  expect(row.evictAfter).toBeUndefined()

  // And the stop is recorded so no other teammate picks up where it left off.
  expect(isCannotProceed()).toBe(true)

  started.abortController.abort()
  await started.done
})

test('a second teammate on the same limit adds no further lead-bound message', async () => {
  const harness = await importRunnerWithMocks('usage-limit')
  harness.taskList.push(pendingTask('1', 'first task'))

  // Stand in for a teammate that already reported this exact notice. Five
  // teammates hit one account-wide limit at the same instant; the lead needs
  // it once, not five times.
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)

  const started = await startTeammate(harness)
  await waitForPark(started)

  // It still parks and still releases — it just does not re-report.
  expect(harness.taskList.find(t => t.id === '1')!.status).toBe('pending')
  expect(
    notificationsMentioning(harness.leadMailbox, 'out of extra usage'),
  ).toHaveLength(0)
  expect(teammateRow(started)!.status).toBe('running')

  started.abortController.abort()
  await started.done
})

test('a teammate parked by a usage limit resumes on the next prompt with its work intact', async () => {
  // Turn 1 hits the limit and parks; turn 2 — the one an inbound prompt buys —
  // succeeds.
  const harness = await importRunnerWithMocks(['usage-limit', 'success'])
  harness.taskList.push(pendingTask('1', 'first task'))

  const started = await startTeammate(harness)
  await waitForPark(started)

  // Parked, not dead: the runner has not returned, so `allMessages` and
  // `lastTurnAgentId` — both locals of runInProcessTeammate, and the only
  // complete record of this teammate's work — are still in hand.
  expect(await stillRunning(started)).toBe(true)
  expect(isCannotProceed()).toBe(true)
  expect(teammateRow(started)!.status).toBe('running')

  // Resume it exactly the way SendMessageTool does — a write to its inbox.
  // Its poll loop never stopped, so this is read within one poll interval.
  harness.workerInbox.push({
    from: 'team-lead',
    text: 'carry on',
    read: false,
  })

  await waitFor(() => harness.runAgentCalls.length >= 2, 'the resumed turn')

  // THE CONTINUABILITY ASSERTION. Surviving is not enough: the pre-limit
  // conversation has to come WITH it. forkContextMessages is the buffer the
  // runner carries across turns, so a teammate that survived but restarted
  // cold passes every assertion above and fails this one.
  const resumed = harness.runAgentCalls[1]!
  expect(resumed.forkContextMessages).toBeDefined()
  expect(JSON.stringify(resumed.forkContextMessages)).toContain('first task')
  // The limit notice itself is part of that history too — the teammate can see
  // why it was parked.
  expect(JSON.stringify(resumed.forkContextMessages)).toContain(
    'out of extra usage',
  )

  // And the park lifts by itself on the successful turn — no one has to clear
  // it by hand.
  await waitFor(
    () => teammateRow(started)?.parkedNotice === undefined,
    'the park to lift',
  )
  expect(isCannotProceed()).toBe(false)
  expect(teammateRow(started)!.parkedAt).toBeUndefined()

  started.abortController.abort()
  await started.done
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
