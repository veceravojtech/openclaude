import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import type { HookInput, HookJSONOutput } from '../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getTeamsDir, setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createTask, getTasksDir, listTasks } from '../tasks.js'
import type { TeammateMessage } from '../teammateMailbox.js'
import {
  killInProcessTeammateAndCascade,
  spawnInProcessTeammate,
} from './spawnInProcess.js'
import {
  armSubLeadHandoff,
  getHandoffDir,
  takeSubLeadHandoff,
  writeSubLeadHandoffFile,
} from './subLeadHandoff.js'
import {
  getTeamDir,
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from './teamHelpers.js'

// U10: a sub-lead can be RETIRED AND REPLACED. The TeammateIdleTimeout hook's
// `handoff` action (and the HandoffTeam tool, which arms the same request)
// ends the run through the completion tail — no cascade, no orphan record —
// and the tail then spawns a successor with the SAME identity, which opens on
// the handoff notes and inherits the sub-team untouched. These pin all four
// halves of that: the successor exists, the team file is re-pointed, the
// children are untouched, and the old task completed.

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
const WORKER = 'worker'
const TEAM_LEAD = 'team-lead'

/** Virtual clock: Date.now() is frozen except when the poll loop sleeps. */
let virtualNow = 1_700_000_000_000
let nowSpy: ReturnType<typeof spyOn> | undefined
let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/inProcessRunner.handoff.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-handoff-runner-'))
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
    // The pending-handoff registry is module-level: nothing may leak from one
    // test into the next.
    takeSubLeadHandoff(SUB_LEAD_AGENT_ID)
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
  inboxes: Map<string, TeammateMessage[]>
  inbox(agentName: string, teamName: string): TeammateMessage[]
  /** emitTaskTerminatedSdk() calls made by the runner. */
  terminatedEvents: Array<{ taskId: string; status: string }>
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?handoffActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?handoffActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?handoffActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?handoffActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?handoffActual=${stamp}`
  )
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?handoffActual=${stamp}`
  )

  const runAgentCalls: RunAgentParams[] = []
  const terminatedEvents: Harness['terminatedEvents'] = []
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
    emitTaskTerminatedSdk: (taskId: string, status: string) => {
      terminatedEvents.push({ taskId, status })
    },
  }))

  const runner: RunnerModule = await import(
    `./inProcessRunner.ts?handoff=${stamp}`
  )
  return { runner, runAgentCalls, inboxes, inbox, terminatedEvents }
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Array<{ agentId: string; name: string }>,
  extra?: Partial<TeamFile>,
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    ...extra,
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

/** The parent team plus the sub-team `supervisor` leads, as TeamCreate records it. */
function writeSubTeamWorld(subTeamExtra?: Partial<TeamFile>): void {
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `${WORKER}@${SUB_TEAM}`, name: WORKER },
    ],
    {
      parentTeam: PARENT_TEAM,
      parentAgentId: SUB_LEAD_AGENT_ID,
      ...subTeamExtra,
    },
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
  }
}

/** Registers one TeammateIdleTimeout callback hook answering from a queue. */
function registerIdleTimeoutHook(responses: HookJSONOutput[]): HookInput[] {
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

const HANDOFF_HOOK_RESPONSE: HookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: 'TeammateIdleTimeout',
    action: 'handoff',
    reason: 'context nearly full',
  },
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

function teammateTasks(state: AppState): InProcessTeammateTaskState[] {
  return Object.values(state.tasks).filter(
    (task): task is InProcessTeammateTaskState =>
      task.type === 'in_process_teammate',
  )
}

/** The successor: a live task carrying the retired lead's identity, new id. */
function findSuccessor(
  state: AppState,
  retiredTaskId: string,
): InProcessTeammateTaskState | undefined {
  return teammateTasks(state).find(
    task =>
      task.id !== retiredTaskId && task.identity.agentId === SUB_LEAD_AGENT_ID,
  )
}

/** Every task carrying the sub-lead's identity, terminal ones included. */
function tasksForSubLead(state: AppState): string[] {
  return teammateTasks(state)
    .filter(task => task.identity.agentId === SUB_LEAD_AGENT_ID)
    .map(task => task.id)
}

/** Stops a successor the test started indirectly, so no runner outlives it. */
async function stopSuccessor(world: World, taskId: string): Promise<void> {
  const task = world.getState().tasks[taskId]
  if (task?.type !== 'in_process_teammate') return
  task.abortController?.abort()
  await waitFor(
    () => {
      const current = world.getState().tasks[taskId]
      return current === undefined || current.status !== 'running'
    },
    'the successor to stop',
  )
}

function memberNames(teamName: string): string[] {
  return readTeamFile(teamName)?.members.map(m => m.name) ?? []
}

function handoffDocuments(): string[] {
  const dir = getHandoffDir(SUB_TEAM)
  if (!existsSync(dir)) return []
  return readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf-8'))
}

function userContentOf(params: RunAgentParams): string {
  const first = params.promptMessages[0]
  if (!first || first.type !== 'user') return ''
  const content = first.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

async function seedSubTeamTask(): Promise<void> {
  await createTask(SUB_TEAM, {
    subject: 'ship the digest',
    description: 'write it',
    status: 'in_progress',
    owner: WORKER,
    blocks: [],
    blockedBy: [],
  })
}

test('the handoff action retires the sub-lead, spawns a successor on the notes, and leaves the busy sub-team untouched', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  registerIdleTimeoutHook([HANDOFF_HOOK_RESPONSE])
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()
  await seedSubTeamTask()

  // A child mid-turn: spawned with a prompt, so it is registered NOT idle.
  // An idle self-shutdown would be refused here and would then cascade; a
  // handoff neither refuses nor tears anything down.
  const worker = await registerTeammate(world, WORKER, SUB_TEAM, 'do the work')
  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)

  await subLead.done

  // 1. The old task completed — not failed, and not killed. The runner's own
  //    bookend is the record: a completed teammate task carries no panel
  //    retain field, so it is evicted from AppState as it goes terminal, and
  //    that eviction is itself half of "the seat is free".
  expect(harness.terminatedEvents).toContainEqual({
    taskId: subLead.taskId,
    status: 'completed',
  })
  expect(harness.terminatedEvents.some(e => e.status === 'failed')).toBe(false)
  expect(world.getState().tasks[subLead.taskId]).toBeUndefined()
  // A handoff is not a crash: no orphan record was written for the sub-team.
  expect(readTeamFile(SUB_TEAM)?.orphanedLead).toBeUndefined()

  // 2. The successor exists, idle, under the SAME identity and new task id.
  const successor = findSuccessor(world.getState(), subLead.taskId)
  expect(successor).toBeDefined()
  expect(successor!.status).toBe('running')
  expect(successor!.identity.agentName).toBe(SUB_LEAD)
  expect(successor!.identity.teamName).toBe(PARENT_TEAM)
  expect(successor!.description).toContain('idle (waiting for work)')

  // 3. The team file points at the successor and records nothing else new.
  const subTeamFile = readTeamFile(SUB_TEAM)
  expect(subTeamFile?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(subTeamFile?.parentTeam).toBe(PARENT_TEAM)
  expect(subTeamFile?.leadAgentId).toBe(`${TEAM_LEAD}@${SUB_TEAM}`)

  // 4. Children untouched: not stopped, not re-identified, not re-teamed,
  //    still on their own task list, and nothing was torn down.
  const workerTask = world.getState().tasks[worker.taskId]
  expect(workerTask?.status).toBe('running')
  expect(
    workerTask?.type === 'in_process_teammate'
      ? workerTask.identity.teamName
      : undefined,
  ).toBe(SUB_TEAM)
  // Nothing but the retiring lead ended: no cascade reached the members.
  expect(harness.terminatedEvents.map(e => e.taskId)).toEqual([subLead.taskId])
  expect(memberNames(SUB_TEAM)).toEqual([TEAM_LEAD, WORKER])
  expect(harness.inbox(WORKER, SUB_TEAM)).toHaveLength(0)
  const tasks = await listTasks(SUB_TEAM)
  expect(tasks.map(t => [t.subject, t.status, t.owner])).toEqual([
    ['ship the digest', 'in_progress', WORKER],
  ])
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(true)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)
  // No orphan directories: exactly the two teams that existed before.
  expect(readdirSync(getTeamsDir()).sort()).toEqual([
    'email',
    'email-supervisor',
  ])
  // The retiring lead keeps its parent-roster seat: the successor inherits it.
  expect(memberNames(PARENT_TEAM)).toContain(SUB_LEAD)

  // 5. The notes were written under the sub-team dir and name the reason,
  //    the members and the task list.
  const documents = handoffDocuments()
  expect(documents).toHaveLength(1)
  expect(documents[0]).toContain(`# Handoff — ${SUB_TEAM}`)
  expect(documents[0]).toContain('context nearly full')
  expect(documents[0]).toContain('TeammateIdleTimeout hook')
  expect(documents[0]).toContain('ship the digest')
  expect(documents[0]).toContain(`- ${WORKER}`)

  // 6. The successor's FIRST message points at those notes, and it takes its
  //    first turn on them.
  const firstMessage = harness
    .inbox(SUB_LEAD, PARENT_TEAM)
    .find(m => m.from === 'handoff')
  expect(firstMessage?.text).toContain(getHandoffDir(SUB_TEAM))
  await waitFor(
    () => harness.runAgentCalls.length > 0,
    'the successor to take its first turn on the handoff message',
  )
  const firstPrompt = userContentOf(harness.runAgentCalls[0]!)
  expect(firstPrompt).toContain('Read the handoff notes first')
  expect(firstPrompt).toContain('teammate_id="handoff"')

  // 7. The lead was told, in one message, what happened and where the notes are.
  const leadMessages = harness
    .inbox(TEAM_LEAD, PARENT_TEAM)
    .filter(m => !m.text.trimStart().startsWith('{'))
    .map(m => m.text)
  expect(
    leadMessages.filter(text =>
      text.includes(`handed sub-team "${SUB_TEAM}" to a fresh successor`),
    ),
  ).toHaveLength(1)
  expect(leadMessages.some(text => text.includes('has shut down'))).toBe(false)

  await stopSuccessor(world, successor!.id)
})

test('the handoff clears a failure record the sub-team was still carrying', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  registerIdleTimeoutHook([HANDOFF_HOOK_RESPONSE])
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  // A respawn whose re-attach failed leaves the sub-team led by its natural
  // lead with the orphan record still standing (`respawning`). The handoff's
  // final re-attach is what takes it back to `led`.
  writeSubTeamWorld({
    orphanedLead: {
      agentId: SUB_LEAD_AGENT_ID,
      reason: 'previous run crashed',
      detectedAt: 1,
    },
  })

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)
  await subLead.done

  const subTeamFile = readTeamFile(SUB_TEAM)
  expect(subTeamFile?.orphanedLead).toBeUndefined()
  expect(subTeamFile?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)

  const successor = findSuccessor(world.getState(), subLead.taskId)
  expect(successor).toBeDefined()
  await stopSuccessor(world, successor!.id)
})

test('a handoff armed mid-turn hands over through the abort that ends the run', async () => {
  // The HandoffTeam tool's contract: write the notes, arm the request, abort
  // the sub-lead's own lifecycle controller. The completion tail does the rest.
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)
  const handoffPath = await writeSubLeadHandoffFile({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    source: 'tool',
    synthesis: 'the digest ships on Fridays',
    openItems: ['confirm the send window'],
    members: [WORKER],
  })
  armSubLeadHandoff({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    handoffPath,
    source: 'tool',
    firstInstruction: 'confirm the send window with the worker',
  })
  subLead.abortController.abort()
  await subLead.done

  expect(harness.terminatedEvents).toEqual([
    { taskId: subLead.taskId, status: 'completed' },
  ])
  const successor = findSuccessor(world.getState(), subLead.taskId)
  expect(successor).toBeDefined()
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(readTeamFile(SUB_TEAM)?.orphanedLead).toBeUndefined()

  const firstMessage = harness
    .inbox(SUB_LEAD, PARENT_TEAM)
    .find(m => m.from === 'handoff')
  expect(firstMessage?.text).toContain(handoffPath)
  expect(firstMessage?.text).toContain('confirm the send window with the worker')

  await stopSuccessor(world, successor!.id)
})

test('a handoff action asked of a teammate that leads no sub-team is ignored and it keeps waiting', async () => {
  process.env.CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS = '1000'
  registerIdleTimeoutHook([HANDOFF_HOOK_RESPONSE])
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: `helper@${PARENT_TEAM}`, name: 'helper' },
  ])

  const helper = await startIdleTeammate(harness, world, 'helper', PARENT_TEAM)
  await waitFor(
    () => virtualNow >= 1_700_000_004_000,
    'the idle policy to fire the handoff hook and be refused',
  )

  // Still running, still a member, no successor, nothing written.
  expect(world.getState().tasks[helper.taskId]?.status).toBe('running')
  expect(memberNames(PARENT_TEAM)).toContain('helper')
  expect(teammateTasks(world.getState())).toHaveLength(1)
  expect(existsSync(getHandoffDir(`${PARENT_TEAM}/helper`))).toBe(false)
  expect(harness.terminatedEvents).toHaveLength(0)

  helper.abortController.abort()
  await helper.done
})

test('a handoff overtaken by a kill is disarmed, and no later run under the same id acts on it', async () => {
  const harness = await importRunnerWithMocks()
  const world = createWorld()
  writeSubTeamWorld()

  const subLead = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)
  const handoffPath = await writeSubLeadHandoffFile({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    source: 'tool',
    synthesis: 'the digest ships on Fridays',
    members: [WORKER],
  })
  armSubLeadHandoff({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    handoffPath,
    source: 'tool',
  })

  // The kill wins the race: it takes the task terminal — and cascades the
  // sub-team away — before the runner's completion tail gets there.
  const killed = killInProcessTeammateAndCascade(
    subLead.taskId,
    world.setAppState,
  )
  await subLead.done
  expect(await killed).toBe(true)

  // The tail took the already-terminal branch, so no successor was started:
  // handing over a sub-team the kill has just torn down would resurrect a
  // lead for a team that no longer exists.
  expect(harness.terminatedEvents).toEqual([
    { taskId: subLead.taskId, status: 'stopped' },
  ])
  expect(findSuccessor(world.getState(), subLead.taskId)).toBeUndefined()
  expect(
    harness.inbox(SUB_LEAD, PARENT_TEAM).some(m => m.from === 'handoff'),
  ).toBe(false)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)

  // And the request is GONE rather than waiting for the next run under this
  // id. The registry is keyed on the stable name@team, so the next teammate
  // of that name — a RecoverTeam respawn, or a fresh spawn as here, the
  // sub-team having been cascaded away — must inherit nothing.
  const second = await startIdleTeammate(harness, world, SUB_LEAD, PARENT_TEAM)
  second.abortController.abort()
  await second.done

  // Both runs ended and were evicted; no third task was ever created.
  expect(tasksForSubLead(world.getState())).toEqual([])
  expect(
    harness.inbox(SUB_LEAD, PARENT_TEAM).some(m => m.from === 'handoff'),
  ).toBe(false)
  expect(
    harness
      .inbox(TEAM_LEAD, PARENT_TEAM)
      .some(m => m.text.includes('handed sub-team')),
  ).toBe(false)
})
