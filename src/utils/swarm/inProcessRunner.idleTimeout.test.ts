import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { HookInput, HookJSONOutput } from '../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import type { TeammateMessage } from '../teammateMailbox.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import { getTeamFilePath, readTeamFile, type TeamFile } from './teamHelpers.js'

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type TasksModule = typeof import('../tasks.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type SdkEventQueueModule = typeof import('../sdkEventQueue.js')
type RunnerModule = typeof import('./inProcessRunner.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualTasks: TasksModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined
let actualSdkEventQueue: SdkEventQueueModule | undefined

const ENV_KEYS = [
  'CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS',
  'CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS',
  'CLAUDE_CODE_SIMPLE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

const TEAM_NAME = 'idle-team'

/** Virtual clock: Date.now() is frozen except when the poll loop sleeps. */
let virtualNow = 1_700_000_000_000
let sleepCount = 0
let nowSpy: ReturnType<typeof spyOn> | undefined
let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/inProcessRunner.idleTimeout.test.ts',
  )
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-idle-timeout-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousInteractive = getIsInteractive()
  setIsInteractive(false)
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
  virtualNow = 1_700_000_000_000
  sleepCount = 0
  nowSpy = spyOn(Date, 'now').mockImplementation(() => virtualNow)
})

afterEach(() => {
  try {
    nowSpy?.mockRestore()
    nowSpy = undefined
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
    if (actualSdkEventQueue) {
      mock.module('../sdkEventQueue.js', () => actualSdkEventQueue!)
    }
    clearRegisteredHooks()
    if (previousRegisteredHooks) {
      registerHookCallbacks(previousRegisteredHooks)
    }
    setIsInteractive(previousInteractive)
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key]
      if (saved === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type RunAgentParams = Parameters<RunAgentModule['runAgent']>[0]

type Harness = {
  runner: RunnerModule
  runAgentCalls: RunAgentParams[]
  /** Messages the runner sent to the lead's mailbox. */
  leadMailbox: Array<{ from: string; text: string }>
  /** The teammate's own inbox, read by the runner's poll loop. */
  teammateInbox: TeammateMessage[]
  /** unassignTeammateTasks() calls made by the runner. */
  unassignCalls: Array<{ taskListId: string; agentId: string; name: string }>
  /** emitTaskTerminatedSdk() calls made by the runner. */
  terminatedEvents: Array<{ taskId: string; status: string }>
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(`../../constants/prompts.ts?idleTimeoutActual=${stamp}`)
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?idleTimeoutActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?idleTimeoutActual=${stamp}`)
  actualTasks ??= await import(`../tasks.ts?idleTimeoutActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?idleTimeoutActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?idleTimeoutActual=${stamp}`
  )
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?idleTimeoutActual=${stamp}`
  )

  const runAgentCalls: RunAgentParams[] = []
  const leadMailbox: Array<{ from: string; text: string }> = []
  const teammateInbox: TeammateMessage[] = []
  const unassignCalls: Harness['unassignCalls'] = []
  const terminatedEvents: Harness['terminatedEvents'] = []

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
      message: { from: string; text: string; timestamp?: string },
    ) => {
      if (recipient === 'team-lead') {
        leadMailbox.push({ from: message.from, text: message.text })
      } else {
        // The teammate's own inbox, e.g. a persisted hook wake message.
        teammateInbox.push({
          from: message.from,
          text: message.text,
          timestamp: message.timestamp ?? new Date().toISOString(),
          read: false,
        })
      }
    },
  }))
  mock.module('../tasks.js', () => ({
    ...actualTasks!,
    listTasks: async () => [],
    unassignTeammateTasks: async (
      taskListId: string,
      agentId: string,
      name: string,
    ) => {
      unassignCalls.push({ taskListId, agentId, name })
      return { unassignedTasks: [], notificationMessage: `${name} has shut down.` }
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    // Advance the virtual clock by the requested poll interval, then yield a
    // real macrotask so the loop stays asynchronous.
    sleep: (ms: number) => {
      virtualNow += ms
      sleepCount++
      return new Promise<void>(resolve => setTimeout(resolve, 1))
    },
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))
  mock.module('../sdkEventQueue.js', () => ({
    ...actualSdkEventQueue!,
    emitTaskTerminatedSdk: (taskId: string, status: string) => {
      terminatedEvents.push({ taskId, status })
    },
  }))

  const runner: RunnerModule = await import(
    `./inProcessRunner.ts?idleTimeout=${stamp}`
  )
  return {
    runner,
    runAgentCalls,
    leadMailbox,
    teammateInbox,
    unassignCalls,
    terminatedEvents,
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
        notifications.push({ from: message.from, idleReason: parsed.idleReason })
      }
    } catch {
      // not JSON: a plain DM
    }
  }
  return notifications
}

function plainMessages(
  leadMailbox: Array<{ from: string; text: string }>,
): string[] {
  return leadMailbox
    .filter(message => !message.text.trimStart().startsWith('{'))
    .map(message => message.text)
}

/** Registers one TeammateIdleTimeout callback hook answering from a queue. */
function registerIdleTimeoutHook(
  responses: HookJSONOutput[],
): HookInput[] {
  const inputs: HookInput[] = []
  registerHookCallbacks({
    TeammateIdleTimeout: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async (input: HookInput) => {
              inputs.push(input)
              return responses.shift() ?? {}
            },
          },
        ],
      },
    ],
  })
  return inputs
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  // performance.now() is real time; Date.now() is the frozen virtual clock.
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
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
  agentId: string
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  /** Every status the teammate task went through, in order. */
  statusTrail: string[]
}

async function startIdleTeammate(
  harness: Harness,
  name: string,
): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const statusTrail: string[] = []
  const getState = (): AppState => state
  let taskIdForTrail: string | undefined
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
    if (taskIdForTrail) {
      const status = state.tasks[taskIdForTrail]?.status
      if (status && statusTrail.at(-1) !== status) statusTrail.push(status)
    }
  }
  const spawn = await spawnInProcessTeammate(
    { name, teamName: TEAM_NAME, planModeRequired: false },
    { setAppState },
  )
  if (
    !spawn.success ||
    !spawn.taskId ||
    !spawn.teammateContext ||
    !spawn.abortController
  ) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  taskIdForTrail = spawn.taskId
  statusTrail.push(state.tasks[spawn.taskId]!.status)

  // The team file and teamContext entry a real spawn would leave behind.
  const teamFile: TeamFile = {
    name: TEAM_NAME,
    createdAt: 0,
    leadAgentId: 'lead-id',
    members: [
      {
        agentId: 'lead-id',
        name: 'team-lead',
        joinedAt: 0,
        tmuxPaneId: 'lead-pane',
        cwd: '/repo',
        subscriptions: [],
      },
      {
        agentId: spawn.agentId,
        name,
        joinedAt: 0,
        tmuxPaneId: 'in-process',
        cwd: '/repo',
        subscriptions: [],
      },
    ],
  }
  const teamFilePath = getTeamFilePath(TEAM_NAME)
  mkdirSync(dirname(teamFilePath), { recursive: true })
  writeFileSync(teamFilePath, JSON.stringify(teamFile))
  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName: TEAM_NAME,
      teamFilePath,
      leadAgentId: 'lead-id',
      teammates: {
        [spawn.agentId]: {
          name,
          tmuxSessionName: '',
          tmuxPaneId: 'in-process',
          cwd: '/repo',
          spawnedAt: 0,
        },
      },
    },
  }))

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
    taskId: spawn.taskId,
    agentId: spawn.agentId,
    abortController: spawn.abortController,
    done,
    getState,
    setAppState,
    statusTrail,
  }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  const result = await started.done
  expect(result.success).toBe(true)
}

function teamFileHasMember(agentId: string): boolean {
  return (
    readTeamFile(TEAM_NAME)?.members.some(m => m.agentId === agentId) ?? false
  )
}

/** What ListAgents would still see: teammate tasks that are running. */
function runningTeammateTasks(state: AppState): number {
  return Object.values(state.tasks).filter(
    task => task.type === 'in_process_teammate' && task.status === 'running',
  ).length
}

async function expectIdleShutdown(
  harness: Harness,
  started: StartedTeammate,
  expectedCause: string,
): Promise<void> {
  const result = await started.done
  expect(result.success).toBe(true)

  // Exits like a normal completion: status completed, task evicted, SDK
  // terminated event; never failed or killed.
  expect(started.statusTrail).toEqual(['running', 'completed'])
  expect(getTeammateTask(started.getState(), started.taskId)).toBeUndefined()
  expect(runningTeammateTasks(started.getState())).toBe(0)
  expect(harness.terminatedEvents).toEqual([
    { taskId: started.taskId, status: 'completed' },
  ])

  // Leaves no stale membership behind and hands its tasks back.
  expect(teamFileHasMember(started.agentId)).toBe(false)
  expect(teamFileHasMember('lead-id')).toBe(true)
  expect(started.getState().teamContext?.teammates).toEqual({})
  expect(harness.unassignCalls).toEqual([
    { taskListId: expect.any(String), agentId: started.agentId, name: 'idle-worker' },
  ])

  // Tells the lead why it left.
  const notes = plainMessages(harness.leadMailbox)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('idle-worker has shut down.')
  expect(notes[0]).toContain('shut down after idle timeout')
  expect(notes[0]).toContain(expectedCause)
  expect(harness.runAgentCalls).toHaveLength(0)
}

test('fires TeammateIdleTimeout at each idle interval with occurrence 1 then 2 and keeps waiting', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  const hookInputs = registerIdleTimeoutHook([])
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  // The mocked poll loop spins fast in real time, so wait for at least two
  // firings and inspect the first two.
  await waitFor(() => hookInputs.length >= 2, 'two hook firings')
  expect(hookInputs[0]).toMatchObject({
    hook_event_name: 'TeammateIdleTimeout',
    teammate_name: 'idle-worker',
    team_name: TEAM_NAME,
    agent_id: started.agentId,
    occurrence: 1,
  })
  expect(hookInputs[1]).toMatchObject({ occurrence: 2 })
  const idle1 = (hookInputs[0] as { idle_ms: number }).idle_ms
  const idle2 = (hookInputs[1] as { idle_ms: number }).idle_ms
  expect(idle1).toBeGreaterThanOrEqual(1000)
  expect(idle1).toBeLessThan(1500)
  expect(idle2).toBeGreaterThanOrEqual(2000)
  expect(idle2).toBeLessThan(2500)

  // A silent hook changes nothing: still parked, no turn, one idle notice.
  expect(harness.runAgentCalls).toHaveLength(0)
  const task = getTeammateTask(started.getState(), started.taskId)
  expect(task?.status).toBe('running')
  expect(task?.isIdle).toBe(true)
  expect(idleNotifications(harness.leadMailbox)).toEqual([
    { from: 'idle-worker', idleReason: 'available' },
  ])
  expect(plainMessages(harness.leadMailbox)).toEqual([])

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(0)
})

test('a blocking TeammateIdleTimeout hook wakes the teammate with its text as the next prompt', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  registerIdleTimeoutHook([{ decision: 'block', reason: 'Review PR #7' }])
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  await waitFor(() => harness.runAgentCalls.length === 1, 'hook-driven turn')
  const prompt = userContentOf(harness.runAgentCalls[0]!)
  expect(prompt).toContain(
    'TeammateIdleTimeout hook feedback:\nReview PR #7',
  )
  expect(prompt).toContain('teammate_id="idle-timeout-hook"')

  // Parks again afterwards, exactly like after any other turn.
  await waitFor(
    () => idleNotifications(harness.leadMailbox).length === 2,
    'post-turn idle notification',
  )
  const task = getTeammateTask(started.getState(), started.taskId)
  expect(task?.isIdle).toBe(true)
  expect(task?.messages?.map(m => m.type)).toEqual(['user', 'assistant'])

  await stopTeammate(started)
  expect(harness.runAgentCalls).toHaveLength(1)
})

test('a TeammateIdleTimeout shutdown action ends the runner cleanly', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  registerIdleTimeoutHook([
    {
      hookSpecificOutput: {
        hookEventName: 'TeammateIdleTimeout',
        action: 'shutdown',
        reason: 'nothing queued',
      },
    },
  ])
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  await expectIdleShutdown(
    harness,
    started,
    'TeammateIdleTimeout hook requested shutdown: nothing queued',
  )
})

test('CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS ends an idle teammate without any hook configured', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '1500'
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  await expectIdleShutdown(
    harness,
    started,
    'idle for 2s, over CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS',
  )
})

test('without a hook or a shutdown policy the teammate keeps polling unchanged', async () => {
  // Default hook interval is 5 minutes: a registered hook must stay silent
  // well past the intervals used above.
  const hookInputs = registerIdleTimeoutHook([])
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  await waitFor(() => sleepCount >= 20, 'twenty poll rounds')
  expect(hookInputs).toHaveLength(0)
  expect(harness.runAgentCalls).toHaveLength(0)
  const task = getTeammateTask(started.getState(), started.taskId)
  expect(task?.status).toBe('running')
  expect(task?.isIdle).toBe(true)
  expect(teamFileHasMember(started.agentId)).toBe(true)
  expect(idleNotifications(harness.leadMailbox)).toHaveLength(1)
  expect(plainMessages(harness.leadMailbox)).toEqual([])

  await stopTeammate(started)
  expect(harness.terminatedEvents).toEqual([
    { taskId: started.taskId, status: 'completed' },
  ])
})

test('an invalid CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS disables the hook, and a stale shutdownRequested flag does not suppress it', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = 'soon'
  const hookInputs = registerIdleTimeoutHook([])
  const harness = await importRunnerWithMocks()
  const started = await startIdleTeammate(harness, 'idle-worker')

  await waitFor(() => sleepCount >= 8, 'eight poll rounds')
  expect(hookInputs).toHaveLength(0)
  await stopTeammate(started)

  // A valid interval, and the lead once asked this teammate to shut down but
  // the model rejected it: task.shutdownRequested is never cleared, and that
  // stale flag must not silence the idle policy for the rest of its life. (A
  // genuinely pending request is consumed by the mailbox scan, which runs
  // before the policy, so no gate on the flag is needed.)
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  sleepCount = 0
  const second = await startIdleTeammate(harness, 'idle-worker')
  await waitFor(
    () => getTeammateTask(second.getState(), second.taskId)?.isIdle === true,
    'parked',
  )
  second.setAppState(prev => {
    const task = prev.tasks[second.taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    return {
      ...prev,
      tasks: { ...prev.tasks, [second.taskId]: { ...task, shutdownRequested: true } },
    }
  })
  await waitFor(() => hookInputs.length >= 1, 'hook fires despite the stale flag')
  expect(hookInputs[0]).toMatchObject({ occurrence: 1 })
  await stopTeammate(second)
})

test('a hook slower than the interval does not re-fire back to back and cannot starve idle shutdown', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '3500'
  const hookInputs: HookInput[] = []
  let release: (() => void) | undefined
  registerHookCallbacks({
    TeammateIdleTimeout: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async (input: HookInput) => {
              hookInputs.push(input)
              // Stay in flight until the test releases the hook.
              await new Promise<void>(resolve => {
                release = resolve
              })
              return {}
            },
          },
        ],
      },
    ],
  })
  const harness = await importRunnerWithMocks()
  const idleStart = virtualNow
  const started = await startIdleTeammate(harness, 'idle-worker')

  await waitFor(() => hookInputs.length === 1, 'first firing')
  // Hold the hook past the second interval (2s). Anchoring occurrences to
  // idle start would re-fire immediately on completion; the next occurrence
  // must instead be one interval after the hook FINISHES (~3.6s), which is
  // after the 3.5s shutdown deadline.
  await waitFor(() => virtualNow - idleStart >= 2600, 'virtual clock past 2.6s')
  expect(hookInputs).toHaveLength(1)
  release!()

  await expectIdleShutdown(
    harness,
    started,
    'over CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS',
  )
  expect(hookInputs).toHaveLength(1)
})

test('a wake message handed over while other work arrives in the same round is not lost', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  let inbox: TeammateMessage[] | undefined
  registerHookCallbacks({
    TeammateIdleTimeout: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async () => {
              // A peer DM lands while the hook runs: the next poll round
              // returns it before the policy can deliver the wake text, so
              // the wait ends with the wake still pending.
              inbox?.push({
                from: 'reviewer',
                text: 'ping from reviewer',
                timestamp: new Date().toISOString(),
                read: false,
              })
              return { decision: 'block', reason: 'Review PR #7' }
            },
          },
        ],
      },
    ],
  })
  const harness = await importRunnerWithMocks()
  inbox = harness.teammateInbox
  const started = await startIdleTeammate(harness, 'idle-worker')

  // Both messages are worked on: the DM first, then the persisted wake text
  // from the teammate's own mailbox on the next idle round.
  await waitFor(() => harness.runAgentCalls.length === 2, 'two turns')
  expect(userContentOf(harness.runAgentCalls[0]!)).toContain('ping from reviewer')
  const second = userContentOf(harness.runAgentCalls[1]!)
  expect(second).toContain('TeammateIdleTimeout hook feedback:\nReview PR #7')
  expect(second).toContain('teammate_id="idle-timeout-hook"')

  await stopTeammate(started)
})
