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
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { TEAMMATE_GRACE_MS } from '../task/framework.js'
import { createUserMessage } from '../messages.js'
import type { TeammateMessage } from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import {
  getTeamFilePath,
  readTeamFile,
  reattachSubTeamToLead,
  type TeamFile,
} from './teamHelpers.js'

// U9, runner wiring: the failure path is where a dead sub-lead is detected, so
// these drive the REAL runner into it and pin what it leaves behind. They also
// pin the two other wires: an adopted sub-team's member reports upward into the
// team that adopted it, and a resumed teammate's first turn carries the dead
// lead's conversation.

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
const ROOT_LEAD_AGENT_ID = `${TEAM_LEAD_NAME}@${PARENT_TEAM}`
const WORKER = 'worker'

/** Virtual clock: Date.now() is frozen except when the poll loop sleeps. */
let virtualNow = 1_700_000_000_000
let nowSpy: ReturnType<typeof spyOn> | undefined
let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/inProcessRunner.recovery.test.ts',
  )
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-recovery-runner-'))
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
  inbox(agentName: string, teamName: string): TeammateMessage[]
  deliver(
    agentName: string,
    teamName: string,
    message: { from: string; text: string },
  ): void
}

/**
 * Imports the runner with the same mocks the U5 sub-team suite uses: a
 * scripted `runAgent`, an in-memory mailbox keyed by team, and a `sleep` that
 * only advances the virtual clock. `failTurns` makes `runAgent` throw, which
 * is the only way into the runner's terminal failure path.
 */
async function importRunnerWithMocks(
  options: { failTurns?: boolean } = {},
): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?recoveryActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?recoveryActual=${stamp}`
  )
  actualMailbox ??= await import(
    `../teammateMailbox.ts?recoveryActual=${stamp}`
  )
  actualSleep ??= await import(`../sleep.ts?recoveryActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?recoveryActual=${stamp}`
  )
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?recoveryActual=${stamp}`
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
      if (options.failTurns) {
        throw new Error('boom: the model stream died')
      }
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
    `./inProcessRunner.ts?recovery=${stamp}`
  )
  return {
    runner,
    runAgentCalls,
    inbox,
    deliver(agentName, teamName, message) {
      inbox(agentName, teamName).push({
        from: message.from,
        text: message.text,
        timestamp: new Date().toISOString(),
        read: false,
      })
    },
  }
}

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

/** The parent team plus the sub-team `supervisor` leads, as U3 records them. */
function writeSubTeamWorld(): void {
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME },
      { agentId: `${WORKER}@${SUB_TEAM}`, name: WORKER },
    ],
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
}

/** Spawns a teammate and drives its real runner. */
async function startTeammate(
  harness: Harness,
  world: World,
  name: string,
  teamName: string,
  extra: { prompt?: string; resumedMessages?: Parameters<
    RunnerModule['runInProcessTeammate']
  >[0]['resumedMessages'] } = {},
): Promise<StartedTeammate> {
  const spawn = await spawnInProcessTeammate(
    {
      name,
      teamName,
      planModeRequired: false,
      ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
    },
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
    ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
    ...(extra.resumedMessages ? { resumedMessages: extra.resumedMessages } : {}),
  })
  return {
    taskId: spawn.taskId,
    agentId: spawn.agentId,
    abortController: spawn.abortController,
    done,
  }
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

test('the runner failure path records the orphaned sub-team and tells the lead above it', async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const harness = await importRunnerWithMocks({ failTurns: true })
  // A member of the sub-team is still running, and is what the notification
  // has to name — that is the whole reason the orphan matters.
  await spawnInProcessTeammate(
    { name: WORKER, teamName: SUB_TEAM, planModeRequired: false, prompt: 'work' },
    { setAppState: world.setAppState },
  )

  const subLead = await startTeammate(harness, world, SUB_LEAD, PARENT_TEAM, {
    prompt: 'coordinate the mail work',
  })
  const result = await subLead.done
  expect(result.success).toBe(false)
  expect(result.error).toContain('boom')

  // The sub-team is recorded as orphaned, with the failing turn's transcript
  // id — the only key a respawn can reach the dead lead's conversation with.
  const record = readTeamFile(SUB_TEAM)?.orphanedLead
  expect(record?.agentId).toBe(SUB_LEAD_AGENT_ID)
  expect(record?.reason).toContain('boom')
  expect(record?.turnAgentId).toMatch(/^a[0-9a-f]{16}$/)
  // Detection is additive: nothing a teardown or a leadership check depends on
  // was touched, and the sub-team was NOT torn down.
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(readTeamFile(SUB_TEAM)?.parentTeam).toBe(PARENT_TEAM)
  expect(readTeamFile(SUB_TEAM)?.members.map(m => m.name)).toEqual([
    TEAM_LEAD_NAME,
    WORKER,
  ])

  // The lead gets the pre-existing failure notification AND the new one that
  // says a sub-team was left behind, naming the live member and both actions.
  const leadInbox = harness.inbox(TEAM_LEAD_NAME, PARENT_TEAM)
  expect(leadInbox).toHaveLength(2)
  expect(leadInbox[0]!.text).toContain('"idleReason":"failed"')
  expect(leadInbox[1]!.text).toContain(SUB_TEAM)
  expect(leadInbox[1]!.text).toContain(WORKER)
  expect(leadInbox[1]!.text).toContain('respawn')
  expect(leadInbox[1]!.text).toContain('adopt')
})

test('a failing teammate that leads no sub-team records nothing and reports only its own failure', async () => {
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: `${WORKER}@${PARENT_TEAM}`, name: WORKER },
  ])
  const harness = await importRunnerWithMocks({ failTurns: true })

  const worker = await startTeammate(harness, world, WORKER, PARENT_TEAM, {
    prompt: 'work',
  })
  expect((await worker.done).success).toBe(false)

  const leadInbox = harness.inbox(TEAM_LEAD_NAME, PARENT_TEAM)
  expect(leadInbox).toHaveLength(1)
  expect(leadInbox[0]!.text).toContain('"idleReason":"failed"')
})

test('a failed teammate keeps its task and its row for the grace window', async () => {
  // The failure tail used to evict the task from AppState on the spot, which is
  // how a row vanished between two keystrokes. It now writes the retain/grace
  // pair instead and leaves the collecting to the shared funnel, so the row
  // stays — dimmed, reading `failed` — and the transcript can still be opened.
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: `${WORKER}@${PARENT_TEAM}`, name: WORKER },
  ])
  const harness = await importRunnerWithMocks({ failTurns: true })

  const worker = await startTeammate(harness, world, WORKER, PARENT_TEAM, {
    prompt: 'work',
  })
  expect((await worker.done).success).toBe(false)

  const task = world.getState().tasks[worker.taskId]
  expect(task).toBeDefined()
  expect(task?.status).toBe('failed')
  expect(task?.notified).toBe(true)
  const graced = task as InProcessTeammateTaskState
  expect(graced.retain).toBe(false)
  expect(graced.evictAfter).toBe(Date.now() + TEAMMATE_GRACE_MS)
  expect(getRunningTeammatesSorted(world.getState().tasks).map(t => t.id)).toEqual([
    worker.taskId,
  ])
  // …and it is gone from the order the moment the window closes.
  expect(
    getRunningTeammatesSorted(
      world.getState().tasks,
      Date.now() + TEAMMATE_GRACE_MS,
    ),
  ).toEqual([])
})

test("a member of an adopted sub-team reports into the adopting team's inbox", async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const harness = await importRunnerWithMocks()

  // While the sub-team is LED, the member's idle notification goes to its own
  // sub-team's team-lead inbox, exactly as U5 established.
  const worker = await startTeammate(harness, world, WORKER, SUB_TEAM)
  await waitFor(
    () => harness.inbox(TEAM_LEAD_NAME, SUB_TEAM).length === 1,
    'the sub-lead to be told its member is available',
  )
  expect(harness.inbox(TEAM_LEAD_NAME, PARENT_TEAM)).toHaveLength(0)

  // Adopt the sub-team, then give the member another turn to finish.
  expect(
    await reattachSubTeamToLead(SUB_TEAM, ROOT_LEAD_AGENT_ID),
  ).toMatchObject({ ok: true, isNaturalLead: false })
  harness.deliver(WORKER, SUB_TEAM, {
    from: TEAM_LEAD_NAME,
    text: 'keep going',
  })

  // Its next report reaches the team that adopted it instead of the inbox its
  // dead sub-lead used to read — with no member restarted and no identity
  // re-pointed.
  await waitFor(
    () => harness.inbox(TEAM_LEAD_NAME, PARENT_TEAM).length === 1,
    "the adopting lead to be told the member is available",
    5000,
  )
  expect(harness.inbox(TEAM_LEAD_NAME, SUB_TEAM)).toHaveLength(1)
  expect(harness.inbox(TEAM_LEAD_NAME, PARENT_TEAM)[0]!.text).toContain(
    '"idleReason":"available"',
  )
  expect(
    world.getState().tasks[worker.taskId]?.type === 'in_process_teammate' &&
      (
        world.getState().tasks[worker.taskId] as {
          identity: { teamName: string }
        }
      ).identity.teamName,
  ).toBe(SUB_TEAM)

  worker.abortController.abort()
  await worker.done
})

test("a resumed teammate carries the dead lead's conversation into its first turn", async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const harness = await importRunnerWithMocks()

  const prior = createUserMessage({ content: 'what the dead lead was doing' })
  const subLead = await startTeammate(harness, world, SUB_LEAD, PARENT_TEAM, {
    prompt: 'pick it back up',
    resumedMessages: [prior],
  })
  await waitFor(
    () => harness.runAgentCalls.length === 1,
    'the resumed teammate to take its first turn',
  )

  // The runner turns its accumulated history into forkContextMessages, so
  // seeding the buffer is all it takes for the first turn to carry it.
  const forkContext = harness.runAgentCalls[0]!.forkContextMessages
  expect(forkContext).toHaveLength(1)
  expect(forkContext?.[0]).toBe(prior)

  subLead.abortController.abort()
  await subLead.done
})

test('an ordinary spawn still opens with no prior context at all', async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const harness = await importRunnerWithMocks()

  const subLead = await startTeammate(harness, world, SUB_LEAD, PARENT_TEAM, {
    prompt: 'start fresh',
  })
  await waitFor(
    () => harness.runAgentCalls.length === 1,
    'the teammate to take its first turn',
  )
  expect(harness.runAgentCalls[0]!.forkContextMessages).toBeUndefined()

  subLead.abortController.abort()
  await subLead.done
})
