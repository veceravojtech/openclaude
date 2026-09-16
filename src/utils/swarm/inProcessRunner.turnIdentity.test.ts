import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { type AgentId, asAgentId, toAgentId } from '../../types/ids.js'
import {
  type CallerIdentity,
  resolveCallerIdentity,
} from '../agentIdentity.js'
import {
  enqueuePendingNotification,
  resetCommandQueue,
} from '../messageQueueManager.js'
import type { Task } from '../tasks.js'
import { getTeammateContext } from '../teammateContext.js'
import { createAgentId } from '../uuid.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

// U2b: an in-process teammate's turn runs through the same runAgent as any
// subagent, and runAgent stamps a freshly minted AgentId on every tool context
// it builds (runAgent.ts:389 -> createSubagentContext at :746). That id can
// never equal the ambient identity, which is `name@team` and not an AgentId at
// all — so "the tool context's id differs from the ambient one" used to make a
// real teammate look like a subagent of itself for the whole of its own turn.
// The runner therefore mints the turn's id itself, hands it to runAgent as
// override.agentId, and publishes it on the ambient teammate context, which is
// what these tests pin: what a tool observes during the turn, and that a
// subagent spawned inside the same turn is still told apart from it.

const TEAM_NAME = 'turn-id-team'
const WORKER = 'turn-id-worker'
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
    'utils/swarm/inProcessRunner.turnIdentity.test.ts',
  )
  resetCommandQueue()
})

afterEach(() => {
  try {
    resetCommandQueue()
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

/**
 * What one turn looked like from inside runAgent — i.e. from where a tool the
 * model invokes would run, with the teammate's ambient context in place.
 */
type TurnObservation = {
  /** The id runAgent was told to use, which it puts on the tool contexts. */
  overrideAgentId: AgentId | undefined
  /** The same id as the ambient teammate context published it. */
  ambientTurnAgentId: AgentId | undefined
  /** Who a tool called by the teammate itself resolves the caller to be. */
  ownCall: CallerIdentity
  /** Who a tool called by a subagent spawned inside the turn resolves to. */
  subagentCall: CallerIdentity
  subagentId: AgentId
}

type Harness = {
  runner: RunnerModule
  turns: TurnObservation[]
  idleNotifications: number
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?turnIdActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?turnIdActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?turnIdActual=${stamp}`)
  actualTasks ??= await import(`../tasks.ts?turnIdActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?turnIdActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?turnIdActual=${stamp}`
  )

  const turns: TurnObservation[] = []
  const harness: Harness = {
    runner: undefined as unknown as RunnerModule,
    turns,
    idleNotifications: 0,
  }
  const taskList: Task[] = []

  mock.module('../../constants/prompts.js', () => ({
    ...actualPrompts!,
    getSystemPrompt: async () => ['system prompt'],
  }))
  mock.module('../../tools/AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    runAgent: async function* (params: RunAgentParams) {
      // Stand in for a tool the model invokes during this turn: the tool-use
      // context runAgent hands a tool carries override.agentId verbatim, and
      // the ambient teammate context is the one the runner entered.
      const overrideAgentId = params.override?.agentId
      const subagentId = createAgentId()
      const getAppState = (): {
        agentNameRegistry: ReadonlyMap<string, string>
      } => ({ agentNameRegistry: new Map<string, string>() })
      turns.push({
        overrideAgentId,
        ambientTurnAgentId: getTeammateContext()?.turnAgentId,
        ownCall: resolveCallerIdentity({
          agentId: overrideAgentId,
          getAppState,
        }),
        subagentCall: resolveCallerIdentity({
          agentId: subagentId,
          getAppState,
        }),
        subagentId,
      })
      yield {
        type: 'assistant',
        uuid: `assistant-${turns.length}`,
        timestamp: new Date().toISOString(),
        message: {
          id: `msg-${turns.length}`,
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
    readMailbox: async () => [],
    markMessageAsReadByIndex: async () => {},
    writeToMailbox: async (
      recipient: string,
      message: { from: string; text: string },
    ) => {
      if (recipient !== 'team-lead') return
      try {
        const parsed = JSON.parse(message.text) as { type?: string }
        if (parsed.type === 'idle_notification') harness.idleNotifications++
      } catch {
        // a plain DM, not an idle notification
      }
    },
  }))
  mock.module('../tasks.js', () => ({
    ...actualTasks!,
    listTasks: async () => taskList.map(t => ({ ...t })),
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    // Keep the 500ms poll loop, but make it fast for the test.
    sleep: (ms: number) =>
      new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))),
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))

  harness.runner = await import(`./inProcessRunner.ts?turnIdentity=${stamp}`)
  return harness
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

/** The completion block LocalAgentTask enqueues, verbatim in shape. */
function notificationText(taskId: string): string {
  return `<task-notification>
<task-id>${taskId}</task-id>
<output-file>/tmp/${taskId}.output</output-file>
<status>completed</status>
<summary>Agent "${taskId}" completed</summary>
</task-notification>`
}

type StartedTeammate = {
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
}

async function startIdleTeammate(harness: Harness): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    { name: WORKER, teamName: TEAM_NAME, planModeRequired: false },
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
  expect(spawn.agentId).toBe(WORKER_AGENT_ID)
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
  return { abortController: spawn.abortController, done }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  const result = await started.done
  expect(result.success).toBe(true)
}

/** Run one turn by waking the idle teammate with its own agent notification. */
async function runOneTurn(harness: Harness, taskId: string): Promise<void> {
  const before = harness.turns.length
  enqueuePendingNotification({
    value: notificationText(taskId),
    mode: 'task-notification',
    agentId: WORKER_AGENT_ID,
  })
  await waitFor(
    () => harness.turns.length > before,
    `turn ${before + 1} to start`,
  )
}

test('a tool sees the teammate’s own turn id, and tells a subagent of that turn apart', async () => {
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)
  await waitFor(() => harness.idleNotifications >= 1, 'initial idle')
  expect(harness.turns).toHaveLength(0)

  await runOneTurn(harness, 'agent-one')
  const first = harness.turns[0]!

  // The runner minted the id, so runAgent does not: it is a real AgentId and
  // it reaches the tool contexts through override.agentId.
  expect(first.overrideAgentId).toBeDefined()
  expect(toAgentId(first.overrideAgentId!)).not.toBeNull()
  expect(first.overrideAgentId).not.toBe(WORKER_AGENT_ID)

  // The ambient teammate context publishes exactly that id for the turn, which
  // is the whole point: the two sides of the comparison now agree.
  expect(first.ambientTurnAgentId).toBe(first.overrideAgentId)

  // So the teammate's own tool call resolves to the teammate…
  expect(first.ownCall).toEqual({
    agentId: WORKER_AGENT_ID,
    name: WORKER,
    isTeammate: true,
  })
  // …and a subagent spawned inside the same turn still resolves to itself,
  // with the teammate as its spawner.
  expect(first.subagentCall).toEqual({
    agentId: first.subagentId,
    name: undefined,
    isTeammate: false,
    spawnerAgentId: WORKER_AGENT_ID,
  })

  await stopTeammate(started)
})

test('the turn id is minted fresh for every turn', async () => {
  // Option A keeps runAgent's per-turn id lifetime exactly as it was — the
  // transcript, metadata and end-of-turn cleanup paths are all keyed on it —
  // so consecutive turns must not share one.
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness)
  await waitFor(() => harness.idleNotifications >= 1, 'initial idle')

  await runOneTurn(harness, 'agent-one')
  await waitFor(() => harness.idleNotifications >= 2, 'idle after first turn')
  await runOneTurn(harness, 'agent-two')

  expect(harness.turns).toHaveLength(2)
  const [first, second] = harness.turns
  expect(first!.overrideAgentId).not.toBe(second!.overrideAgentId)
  expect(second!.ambientTurnAgentId).toBe(second!.overrideAgentId)
  expect(second!.ownCall).toEqual({
    agentId: WORKER_AGENT_ID,
    name: WORKER,
    isTeammate: true,
  })

  // Every turn the runner ran carried an override — none fell back to
  // runAgent's internal createAgentId().
  expect(harness.turns.every(turn => turn.overrideAgentId !== undefined)).toBe(
    true,
  )

  await stopTeammate(started)
})
