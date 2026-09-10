import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { TEAMMATE_GRACE_MS } from '../task/framework.js'
import { createTask, getTasksDir, listTasks } from '../tasks.js'
import {
  createIdleNotification,
  createShutdownRequestMessage,
  type TeammateMessage,
} from '../teammateMailbox.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import {
  getTeamDir,
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from './teamHelpers.js'

// U5: a teammate that leads a sub-team polls TWO inboxes — its own, in the
// parent team, and `team-lead` of the sub-team, where its children report.
// These pin the ordering between the two read paths, the rule that a child's
// shutdown REQUEST must never be read as an order to shut the sub-lead down,
// which task list each teammate claims from, and the gate that refuses to tear
// a sub-lead down while its children are still working.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type SdkEventQueueModule = typeof import('../sdkEventQueue.js')
type RunnerModule = typeof import('./inProcessRunner.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined
let actualSdkEventQueue: SdkEventQueueModule | undefined

const ENV_KEYS = [
  'CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS',
  'CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS',
  'CLAUDE_CODE_TASK_LIST_ID',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const TEAM_LEAD = 'team-lead'

/** Virtual clock: Date.now() is frozen except when the poll loop sleeps. */
let virtualNow = 1_700_000_000_000
let nowSpy: ReturnType<typeof spyOn> | undefined
let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/inProcessRunner.subTeam.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-runner-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousInteractive = getIsInteractive()
  setIsInteractive(false)
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
  virtualNow = 1_700_000_000_000
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

/** Mailboxes are keyed by TEAM as well as name, so the two are distinguishable. */
function inboxKey(agentName: string, teamName: string): string {
  return `${teamName}::${agentName}`
}

type Harness = {
  runner: RunnerModule
  runAgentCalls: RunAgentParams[]
  /** Every mailbox in play, keyed by team and agent name. */
  inboxes: Map<string, TeammateMessage[]>
  inbox(agentName: string, teamName: string): TeammateMessage[]
  deliver(
    agentName: string,
    teamName: string,
    message: { from: string; text: string; color?: string },
  ): void
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?subTeamActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?subTeamActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?subTeamActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?subTeamActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?subTeamActual=${stamp}`
  )
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?subTeamActual=${stamp}`
  )

  const runAgentCalls: RunAgentParams[] = []
  const inboxes = new Map<string, TeammateMessage[]>()
  const inbox = (agentName: string, teamName: string): TeammateMessage[] => {
    const key = inboxKey(agentName, teamName)
    const existing = inboxes.get(key)
    if (existing) return existing
    const created: TeammateMessage[] = []
    inboxes.set(key, created)
    return created
  }

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
    readMailbox: async (agentName: string, teamName?: string) =>
      inbox(agentName, teamName ?? 'default').map(m => ({ ...m })),
    markMessageAsReadByIndex: async (
      agentName: string,
      teamName: string | undefined,
      index: number,
    ) => {
      const message = inbox(agentName, teamName ?? 'default')[index]
      if (message) message.read = true
    },
    writeToMailbox: async (
      recipient: string,
      message: { from: string; text: string; timestamp?: string },
      teamName?: string,
    ) => {
      inbox(recipient, teamName ?? 'default').push({
        from: message.from,
        text: message.text,
        timestamp: message.timestamp ?? new Date().toISOString(),
        read: false,
      })
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    // Advance the virtual clock by the requested poll interval, then yield a
    // real macrotask so the loop stays asynchronous.
    sleep: (ms: number) => {
      virtualNow += ms
      return new Promise<void>(resolve => setTimeout(resolve, 1))
    },
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))
  mock.module('../sdkEventQueue.js', () => ({
    ...actualSdkEventQueue!,
    emitTaskTerminatedSdk: () => {},
  }))

  const runner: RunnerModule = await import(
    `./inProcessRunner.ts?subTeam=${stamp}`
  )
  return {
    runner,
    runAgentCalls,
    inboxes,
    inbox,
    deliver(agentName, teamName, message) {
      inbox(agentName, teamName).push({
        from: message.from,
        text: message.text,
        color: message.color,
        timestamp: new Date().toISOString(),
        read: false,
      })
    },
  }
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Array<{ agentId: string; name: string }>,
  parent?: { parentTeam: string; parentAgentId: string },
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    ...parent,
    members: members.map(m => ({
      agentId: m.agentId,
      name: m.name,
      joinedAt: 0,
      tmuxPaneId: 'in-process',
      cwd: '/repo',
      subscriptions: [],
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

/**
 * The parent team plus the sub-team `supervisor` leads, recorded exactly as
 * TeamCreate's sub-team branch records it (name + parentAgentId are what
 * readSubTeamLedBy checks).
 */
function writeSubTeamWorld(
  subTeamMembers: Array<{ agentId: string; name: string }> = [],
): void {
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [{ agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD }, ...subTeamMembers],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
}

type World = {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}

function createWorld(): World {
  let state: AppState = getDefaultAppState()
  return {
    getState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

type StartedTeammate = {
  taskId: string
  agentId: string
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
  parentSessionId: string
}

/** Registers a teammate task in AppState WITHOUT running its runner. */
async function registerTeammate(
  world: World,
  name: string,
  teamName: string,
  prompt?: string,
): Promise<{ taskId: string; agentId: string }> {
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false, prompt },
    { setAppState: world.setAppState },
  )
  if (!spawn.success || !spawn.taskId) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  return { taskId: spawn.taskId, agentId: spawn.agentId }
}

/** Spawns a teammate AND drives its runner, parked idle awaiting work. */
async function startIdleTeammate(
  harness: Harness,
  world: World,
  name: string,
  teamName: string,
): Promise<StartedTeammate> {
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false },
    { setAppState: world.setAppState },
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
    getAppState: world.getState,
    setAppState: world.setAppState,
  } as unknown as ToolUseContext

  const done = harness.runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: name,
      teamName,
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
    parentSessionId: spawn.teammateContext.parentSessionId,
  }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  await started.done
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

function userContentOf(params: RunAgentParams): string {
  const first = params.promptMessages[0]
  if (!first || first.type !== 'user') return ''
  const content = first.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function prompts(harness: Harness): string[] {
  return harness.runAgentCalls.map(userContentOf)
}

function memberNames(teamName: string): string[] {
  return readTeamFile(teamName)?.members.map(m => m.name) ?? []
}

test("a child's idle notification in the sub-team's team-lead inbox wakes the idle sub-lead", async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  harness.deliver(TEAM_LEAD, SUB_TEAM, {
    from: 'worker',
    text: JSON.stringify(
      createIdleNotification('worker', { idleReason: 'available' }),
    ),
  })

  await waitFor(
    () => harness.runAgentCalls.length > 0,
    "the sub-lead to take a turn on its child's notification",
  )
  expect(prompts(harness)[0]).toContain('idle_notification')
  expect(prompts(harness)[0]).toContain('teammate_id="worker"')

  // Marked read in the SUB-team inbox; the parent-team inbox is untouched.
  expect(harness.inbox(TEAM_LEAD, SUB_TEAM)[0]?.read).toBe(true)
  expect(harness.inbox(SUB_LEAD, PARENT_TEAM).length).toBe(0)

  await stopTeammate(subLead)
})

test('a peer message in the sub-lead own parent-team inbox still arrives', async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  harness.deliver(SUB_LEAD, PARENT_TEAM, {
    from: 'peer',
    text: 'can you review this?',
  })

  await waitFor(
    () => harness.runAgentCalls.length > 0,
    'the sub-lead to take a turn on its own inbox',
  )
  expect(prompts(harness)[0]).toContain('can you review this?')
  expect(prompts(harness)[0]).toContain('teammate_id="peer"')
  expect(harness.inbox(SUB_LEAD, PARENT_TEAM)[0]?.read).toBe(true)

  await stopTeammate(subLead)
})

test('the own inbox is served before the sub-team inbox, and both are served', async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  // The child reports first in wall-clock terms; the sub-lead's own lead speaks
  // second. Obligations UPWARD still outrank coordination DOWNWARD.
  harness.deliver(TEAM_LEAD, SUB_TEAM, { from: 'worker', text: 'child report' })
  harness.deliver(SUB_LEAD, PARENT_TEAM, {
    from: TEAM_LEAD,
    text: 'lead instruction',
  })

  await waitFor(
    () => harness.runAgentCalls.length >= 2,
    'both inboxes to be drained',
  )
  const delivered = prompts(harness)
  expect(delivered[0]).toContain('lead instruction')
  expect(delivered[1]).toContain('child report')

  await stopTeammate(subLead)
})

test("a child's shutdown request is an ordinary message, never an order to shut the sub-lead down", async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  // A child asking its lead for permission to stop writes a genuine
  // shutdown_request into team-lead@<sub-team> (sendShutdownRequestToMailbox).
  harness.deliver(TEAM_LEAD, SUB_TEAM, {
    from: 'worker',
    color: 'blue',
    text: JSON.stringify(
      createShutdownRequestMessage({ requestId: 'req-1', from: 'worker' }),
    ),
  })
  // Something ordinary waits in the sub-lead's OWN inbox at the same time.
  harness.deliver(SUB_LEAD, PARENT_TEAM, {
    from: 'peer',
    text: 'unrelated peer chatter',
  })

  await waitFor(
    () => harness.runAgentCalls.length >= 2,
    'both messages to be delivered',
  )
  const delivered = prompts(harness)

  // Had the shutdown scan run over the sub-team inbox, the request would have
  // come back FIRST: that scan outranks every ordinary message. It is served
  // last instead, in ordinary-message order.
  expect(delivered[0]).toContain('unrelated peer chatter')
  expect(delivered[1]).toContain('shutdown_request')
  // And it came through the ordinary-message path, which carries the sender's
  // color; the shutdown-request path drops it and uses the JSON's `from`.
  expect(delivered[1]).toContain('color="blue"')

  // The sub-lead is still running, and still a member of its own team.
  expect(memberNames(PARENT_TEAM)).toContain(SUB_LEAD)

  await stopTeammate(subLead)
})

test('a member of a sub-team claims from the sub-team task list', async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld([{ agentId: `worker@${SUB_TEAM}`, name: 'worker' }])

  await createTask(SUB_TEAM, {
    subject: 'ship the digest',
    description: 'write it',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  const child = await startIdleTeammate(harness, world, 'worker', SUB_TEAM)

  await waitFor(
    () => harness.runAgentCalls.length > 0,
    'the child to claim the sub-team task',
  )
  expect(prompts(harness)[0]).toContain('ship the digest')
  const tasks = await listTasks(SUB_TEAM)
  expect(tasks[0]?.owner).toBe('worker')
  expect(tasks[0]?.status).toBe('in_progress')

  await stopTeammate(child)
})

test('a root-team teammate never claims a sub-team task', async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  await createTask(SUB_TEAM, {
    subject: 'sub-team only work',
    description: 'not for the parent team',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  // `helper` is an ordinary member of the ROOT team, so its list is the
  // leader's session id — which has no tasks in it.
  const helper = await startIdleTeammate(harness, world, 'helper', PARENT_TEAM)
  await waitFor(
    () => virtualNow >= 1_700_000_002_000,
    'several poll rounds, each of which checks the task list',
  )

  expect(harness.runAgentCalls.length).toBe(0)
  const tasks = await listTasks(SUB_TEAM)
  expect(tasks[0]?.owner).toBeUndefined()
  expect(tasks[0]?.status).toBe('pending')

  await stopTeammate(helper)
})

test('idle shutdown is refused while a child of the sub-team is busy, and allowed once it is idle', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '1000'
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld([{ agentId: `worker@${SUB_TEAM}`, name: 'worker' }])

  // A child mid-turn: spawned with a prompt, so it is registered not-idle.
  const worker = await registerTeammate(world, 'worker', SUB_TEAM, 'do the work')

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  // Far past the 1000ms shutdown threshold (500ms of virtual time per round),
  // so the idle policy has fired — and been refused — several times over.
  await waitFor(
    () => virtualNow >= 1_700_000_005_000,
    'the idle policy to pass the shutdown threshold several times over',
  )

  // Refused: still a member of its team, and the lead was never told it left.
  expect(memberNames(PARENT_TEAM)).toContain(SUB_LEAD)
  expect(
    harness.inbox(TEAM_LEAD, PARENT_TEAM).some(m => m.text.includes('shut down')),
  ).toBe(false)

  // The child parks idle; the next idle period may now end the sub-lead.
  world.setAppState(prev => {
    const task = prev.tasks[worker.taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    return {
      ...prev,
      tasks: { ...prev.tasks, [worker.taskId]: { ...task, isIdle: true } },
    }
  })

  await subLead.done
  expect(memberNames(PARENT_TEAM)).not.toContain(SUB_LEAD)
  expect(
    harness.inbox(TEAM_LEAD, PARENT_TEAM).some(m => m.text.includes('shut down')),
  ).toBe(true)
})

test('a child whose row is still inside its 30s grace window does not hold the gate', async () => {
  // findBusySubTeamChildren skips a child that is isIdle OR terminal, and the
  // retain/grace pair the teammates tree added leaves the status alone. So a
  // child that FINISHED — its row still drawn, dimmed, reading `killed` — is not
  // busy, and its sub-lead may end its own idle period. Counting a drawn row as
  // busy would keep every sub-lead alive for 30s after its last worker stopped.
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '1000'
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld([{ agentId: `worker@${SUB_TEAM}`, name: 'worker' }])

  const worker = await registerTeammate(world, 'worker', SUB_TEAM, 'do the work')
  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  await waitFor(
    () => virtualNow >= 1_700_000_005_000,
    'the idle policy to pass the shutdown threshold several times over',
  )
  expect(memberNames(PARENT_TEAM)).toContain(SUB_LEAD)

  // The child is killed and keeps its row: terminal status, grace deadline in
  // the future, isIdle still false.
  world.setAppState(prev => {
    const task = prev.tasks[worker.taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [worker.taskId]: {
          ...task,
          status: 'killed' as const,
          notified: true,
          retain: false,
          evictAfter: Date.now() + 30_000,
          isIdle: false,
        },
      },
    }
  })

  await subLead.done
  expect(memberNames(PARENT_TEAM)).not.toContain(SUB_LEAD)
  expect(
    harness.inbox(TEAM_LEAD, PARENT_TEAM).some(m => m.text.includes('shut down')),
  ).toBe(true)

  // And the sub-lead's OWN row enters the same grace window on the way out: the
  // runner's completion tail marks the pair instead of evicting the task, so the
  // last thing the user saw does not disappear as the runner returns.
  const leadTask = world.getState().tasks[subLead.taskId]
  expect(leadTask?.status).toBe('completed')
  expect((leadTask as InProcessTeammateTaskState).retain).toBe(false)
  expect((leadTask as InProcessTeammateTaskState).evictAfter).toBe(
    Date.now() + TEAMMATE_GRACE_MS,
  )
})

test('a teammate that leads no sub-team is unaffected by the gate', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '1000'
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: `helper@${PARENT_TEAM}`, name: 'helper' },
  ])

  const helper = await startIdleTeammate(harness, world, 'helper', PARENT_TEAM)
  await helper.done

  expect(memberNames(PARENT_TEAM)).not.toContain('helper')
})

test('the idle self-shutdown tears the sub-team down, and tears nothing down while a child is busy', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS = '1000'
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld([{ agentId: `worker@${SUB_TEAM}`, name: 'worker' }])
  await createTask(SUB_TEAM, {
    subject: 'sub-team work',
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  // A child mid-turn: spawned with a prompt, so it is registered not-idle.
  const worker = await registerTeammate(world, 'worker', SUB_TEAM, 'do the work')

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  await waitFor(
    () => virtualNow >= 1_700_000_005_000,
    'the idle policy to pass the shutdown threshold several times over',
  )

  // Refused, so NOTHING is torn down: the gate returns before the teardown.
  expect(world.getState().tasks[worker.taskId]?.status).toBe('running')
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(true)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)

  // The child parks idle; the next idle period may now end the sub-lead, and
  // the sub-team goes with it.
  world.setAppState(prev => {
    const task = prev.tasks[worker.taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    return {
      ...prev,
      tasks: { ...prev.tasks, [worker.taskId]: { ...task, isIdle: true } },
    }
  })

  await subLead.done

  expect(world.getState().tasks[worker.taskId]?.status).toBe('killed')
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(memberNames(PARENT_TEAM)).not.toContain(SUB_LEAD)
})
