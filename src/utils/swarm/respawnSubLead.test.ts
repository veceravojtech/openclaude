import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getTeamsDir, setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createUserMessage } from '../messages.js'
import { createTask, getTasksDir } from '../tasks.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  killInProcessTeammateAndCascade,
  spawnInProcessTeammate,
} from './spawnInProcess.js'
import {
  adoptOrphanedSubTeam,
  noteSubLeadFailure,
} from './subTeamRecovery.js'
import {
  getTeamDir,
  getTeamFilePath,
  readSubTeamLedBySync,
  readTeamFile,
  registerTeamForSessionCleanup,
  type TeamFile,
} from './teamHelpers.js'

// U9, respawn half: the dead sub-lead comes back as the SAME `name@team`,
// seeded with its own transcript through the `resumeAgent.ts` filter chain,
// and the sub-team is re-attached to it — which is what puts it back under the
// U7 kill cascade, so nothing is left on disk afterwards.

type RunnerModule = typeof import('./inProcessRunner.js')
type SessionStorageModule = typeof import('../sessionStorage.js')
type RespawnModule = typeof import('./respawnSubLead.js')

let actualRunner: RunnerModule | undefined
let actualSessionStorage: SessionStorageModule | undefined

const ENV_KEYS = ['CLAUDE_CODE_MAX_TEAM_TOTAL'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const ROOT_LEAD_AGENT_ID = `${TEAM_LEAD_NAME}@${PARENT_TEAM}`
const WORKER = 'worker'
const TURN_AGENT_ID = 'a0123456789abcdef'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/respawnSubLead.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-respawn-sublead-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.restore()
    // Each restore must hand `mock.module` a SPREAD COPY. In bun 1.3.9 a
    // factory returning the module namespace object itself is a silent no-op,
    // which left the mocks above installed for every later file in the process
    // (a neutered `sleep` then busy-spun other suites into multi-GB heaps).
    if (actualRunner) {
      mock.module('./inProcessRunner.js', () => ({ ...actualRunner! }))
    }
    if (actualSessionStorage) {
      mock.module('../sessionStorage.js', () => ({ ...actualSessionStorage! }))
    }
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

type RunnerConfig = Parameters<RunnerModule['startInProcessTeammate']>[0]

type Harness = {
  respawn: RespawnModule
  /** Every runner the respawn started, instead of running it. */
  startCalls: RunnerConfig[]
  /** Transcript ids actually asked for. */
  transcriptReads: string[]
}

/**
 * Imports the respawn module with the runner start and the transcript read
 * mocked: the real runner would drive an API loop, and the real transcript
 * lives in a session file this test has no session for.
 */
async function importRespawnWithMocks(
  transcripts: Map<string, Message[]>,
): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualRunner ??= await import(`./inProcessRunner.ts?respawnActual=${stamp}`)
  actualSessionStorage ??= await import(
    `../sessionStorage.ts?respawnActual=${stamp}`
  )

  const startCalls: RunnerConfig[] = []
  const transcriptReads: string[] = []

  mock.module('./inProcessRunner.js', () => ({
    ...actualRunner!,
    startInProcessTeammate: (config: RunnerConfig) => {
      startCalls.push(config)
    },
  }))
  mock.module('../sessionStorage.js', () => ({
    ...actualSessionStorage!,
    getAgentTranscript: async (agentId: string) => {
      transcriptReads.push(agentId)
      const messages = transcripts.get(agentId)
      return messages ? { messages, contentReplacements: [] } : null
    },
  }))

  const respawn: RespawnModule = await import(
    `./respawnSubLead.ts?respawn=${stamp}`
  )
  return { respawn, startCalls, transcriptReads }
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Array<{
    agentId: string
    name: string
    model?: string
    color?: string
    planModeRequired?: boolean
    worktreePath?: string
  }>,
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
      model: m.model,
      color: m.color,
      planModeRequired: m.planModeRequired,
      worktreePath: m.worktreePath,
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

type World = {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  toolUseContext: ToolUseContext
}

function createWorld(): World {
  let state: AppState = getDefaultAppState()
  const getState = (): AppState => state
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  return {
    getState,
    setAppState,
    toolUseContext: {
      options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
      messages: [],
      readFileState: new Map(),
      getAppState: getState,
      setAppState,
    } as unknown as ToolUseContext,
  }
}

async function registerTeammate(
  world: World,
  name: string,
  teamName: string,
): Promise<string> {
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false, prompt: 'work' },
    { setAppState: world.setAppState, getAppState: world.getState },
  )
  if (!spawn.success || !spawn.taskId) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  return spawn.taskId
}

function markTaskFailed(world: World, taskId: string): void {
  world.setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    const failed: InProcessTeammateTaskState = {
      ...task,
      status: 'failed',
      isIdle: true,
      error: 'boom',
    }
    return { ...prev, tasks: { ...prev.tasks, [taskId]: failed } }
  })
}

/** An assistant message whose only tool_use never got a result. */
function unresolvedToolUseMessage(): Message {
  return {
    type: 'assistant',
    uuid: 'assistant-unresolved',
    timestamp: new Date(0).toISOString(),
    message: {
      id: 'msg-unresolved',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_never_answered', name: 'Bash', input: {} },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  } as unknown as Message
}

/**
 * The world a crashed sub-lead leaves behind: both team files intact, the
 * sub-team's task list and a member worktree on disk, the member still
 * running, the lead's task terminal, and the orphan recorded.
 */
async function writeCrashedSubLeadWorld(world: World): Promise<{
  workerWorktree: string
}> {
  const workerWorktree = join(configDir!, 'worktrees', WORKER)
  mkdirSync(workerWorktree, { recursive: true })
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    {
      agentId: SUB_LEAD_AGENT_ID,
      name: SUB_LEAD,
      model: 'sonnet',
      color: 'blue',
      planModeRequired: true,
    },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME },
      {
        agentId: `${WORKER}@${SUB_TEAM}`,
        name: WORKER,
        worktreePath: workerWorktree,
      },
    ],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
  registerTeamForSessionCleanup(SUB_TEAM)
  await createTask(SUB_TEAM, {
    subject: 'sub-team work',
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  const leadTaskId = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  await registerTeammate(world, WORKER, SUB_TEAM)
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    turnAgentId: TURN_AGENT_ID,
    reason: 'boom',
    tasks: world.getState().tasks,
  })
  markTaskFailed(world, leadTaskId)
  return { workerWorktree }
}

test('respawnSubLead resumes the sub-lead from its transcript, re-attaches the sub-team, and leaves no orphan directory', async () => {
  const world = createWorld()
  const { workerWorktree } = await writeCrashedSubLeadWorld(world)
  const harness = await importRespawnWithMocks(
    new Map([
      [
        TURN_AGENT_ID,
        [
          createUserMessage({ content: 'coordinate the mail work' }),
          unresolvedToolUseMessage(),
        ],
      ],
    ]),
  )

  const result = await harness.respawn.respawnSubLead({
    subTeamName: SUB_TEAM,
    toolUseContext: world.toolUseContext,
  })
  expect(result).toMatchObject({
    ok: true,
    subTeamName: SUB_TEAM,
    // Agent ids are deterministic, so the respawned lead IS the id the
    // sub-team already records — same inbox, same task list, same pill.
    leadAgentId: SUB_LEAD_AGENT_ID,
    resumedFromTranscript: true,
    // Two messages went in; the assistant turn whose tool_use never got a
    // result is dropped by the resumeAgent.ts filter chain.
    resumedMessageCount: 1,
  })

  // The transcript asked for is the one the failure path recorded.
  expect(harness.transcriptReads).toEqual([TURN_AGENT_ID])

  // The runner was started with the dead lead's identity and spawn record, and
  // with the filtered history as prior context.
  expect(harness.startCalls).toHaveLength(1)
  const started = harness.startCalls[0]!
  expect(started.identity).toMatchObject({
    agentId: SUB_LEAD_AGENT_ID,
    agentName: SUB_LEAD,
    teamName: PARENT_TEAM,
    color: 'blue',
    planModeRequired: true,
  })
  expect(started.model).toBe('sonnet')
  expect(started.resumedMessages).toHaveLength(1)
  expect(started.prompt).toContain(SUB_TEAM)
  // The parent's conversation is not pinned for the teammate's lifetime.
  expect(started.toolUseContext.messages).toEqual([])

  // Re-attach is the last step, and it is what restores leadership: the record
  // is cleared, parentAgentId names the sub-lead again, parentTeam never moved.
  expect(result.ok && result.reattach).toMatchObject({
    ok: true,
    newLeadAgentId: SUB_LEAD_AGENT_ID,
    isNaturalLead: true,
    clearedOrphanRecord: true,
  })
  const teamFile = readTeamFile(SUB_TEAM)
  expect(teamFile?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(teamFile?.orphanedLead).toBeUndefined()
  expect(teamFile?.parentTeam).toBe(PARENT_TEAM)
  expect(
    readSubTeamLedBySync({
      agentId: SUB_LEAD_AGENT_ID,
      name: SUB_LEAD,
      isTeammate: true,
    })?.name,
  ).toBe(SUB_TEAM)

  // No orphan directories: because the sub-team is attached to a live lead
  // again, killing that lead takes the whole sub-tree through the U7 funnel —
  // the sub-team's team directory (inboxes included) and its own task list.
  // The member's worktree is NOT asserted here: the kill drops the member from
  // the roster (`killOneInProcessTeammate`) before the teardown reads it back
  // for worktree paths, which is pre-existing U7 behaviour, not this unit's.
  // The direct-funnel path in `subTeamRecovery.test.ts` does assert it.
  expect(existsSync(workerWorktree)).toBe(true)
  const respawnedTaskId = result.ok ? result.taskId : ''
  expect(
    await killInProcessTeammateAndCascade(respawnedTaskId, world.setAppState),
  ).toBe(true)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(readdirSync(getTeamsDir())).toEqual(['email'])
  expect(readTeamFile(PARENT_TEAM)?.members.map(m => m.name)).toEqual([
    TEAM_LEAD_NAME,
  ])
})

test('respawnSubLead takes an ADOPTED sub-team back from its caretaker', async () => {
  const world = createWorld()
  const { workerWorktree } = await writeCrashedSubLeadWorld(world)
  // The lead adopted the orphan first, so parentAgentId names the CARETAKER
  // rather than the sub-lead: this is the only state in which the respawn's
  // re-point does real work, and DESIGN §6 claims it comes back from here.
  expect(await adoptOrphanedSubTeam(SUB_TEAM)).toMatchObject({
    ok: true,
    newLeadAgentId: ROOT_LEAD_AGENT_ID,
    isNaturalLead: false,
    clearedOrphanRecord: false,
  })
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(ROOT_LEAD_AGENT_ID)
  // The record is retained through an adoption, which is what keeps the dead
  // lead's transcript findable for exactly this respawn.
  expect(readTeamFile(SUB_TEAM)?.orphanedLead?.turnAgentId).toBe(TURN_AGENT_ID)

  const harness = await importRespawnWithMocks(
    new Map([
      [TURN_AGENT_ID, [createUserMessage({ content: 'what it was doing' })]],
    ]),
  )
  const result = await harness.respawn.respawnSubLead({
    subTeamName: SUB_TEAM,
    toolUseContext: world.toolUseContext,
  })
  expect(result).toMatchObject({
    ok: true,
    leadAgentId: SUB_LEAD_AGENT_ID,
    resumedFromTranscript: true,
    resumedMessageCount: 1,
  })

  // The re-point is the assertion this case exists for: parentAgentId moves
  // OFF the caretaker and back onto the natural lead, and the record goes.
  expect(result.ok && result.reattach).toMatchObject({
    ok: true,
    previousLeadAgentId: ROOT_LEAD_AGENT_ID,
    newLeadAgentId: SUB_LEAD_AGENT_ID,
    isNaturalLead: true,
    clearedOrphanRecord: true,
  })
  const teamFile = readTeamFile(SUB_TEAM)
  expect(teamFile?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(teamFile?.orphanedLead).toBeUndefined()
  expect(teamFile?.parentTeam).toBe(PARENT_TEAM)
  // Leadership is real again, not just recorded: the caretaker no longer holds
  // the sub-team, so the members' reports stop being redirected...
  expect(
    readSubTeamLedBySync({
      agentId: SUB_LEAD_AGENT_ID,
      name: SUB_LEAD,
      isTeammate: true,
    })?.name,
  ).toBe(SUB_TEAM)

  // ...and the U7 cascade owns the sub-team again, so nothing is left behind.
  const respawnedTaskId = result.ok ? result.taskId : ''
  expect(
    await killInProcessTeammateAndCascade(respawnedTaskId, world.setAppState),
  ).toBe(true)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(readdirSync(getTeamsDir())).toEqual(['email'])
  // Same pre-existing U7 worktree behaviour the sibling case records.
  expect(existsSync(workerWorktree)).toBe(true)
})

test('respawnSubLead starts the sub-lead cold when no transcript survives', async () => {
  const world = createWorld()
  await writeCrashedSubLeadWorld(world)
  const harness = await importRespawnWithMocks(new Map())

  const result = await harness.respawn.respawnSubLead({
    subTeamName: SUB_TEAM,
    toolUseContext: world.toolUseContext,
    prompt: 'pick the work back up',
  })
  expect(result).toMatchObject({
    ok: true,
    resumedFromTranscript: false,
    resumedMessageCount: 0,
  })
  // A sub-team with live members is worth recovering with or without history.
  expect(harness.startCalls[0]!.resumedMessages).toBeUndefined()
  expect(harness.startCalls[0]!.prompt).toBe('pick the work back up')
  expect(readTeamFile(SUB_TEAM)?.orphanedLead).toBeUndefined()
})

test('respawnSubLead reads no transcript when the failure recorded no turn', async () => {
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [{ agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME }],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
  const harness = await importRespawnWithMocks(
    new Map([[TURN_AGENT_ID, [createUserMessage({ content: 'unused' })]]]),
  )

  const result = await harness.respawn.respawnSubLead({
    subTeamName: SUB_TEAM,
    toolUseContext: world.toolUseContext,
  })
  expect(result.ok).toBe(true)
  // A teammate can fail before its first turn is minted; recovery is still
  // possible, just cold, and no transcript lookup is attempted.
  expect(harness.transcriptReads).toEqual([])
})

test('loadSubLeadResumeMessages ignores an absent id and a non-transcript id', async () => {
  const harness = await importRespawnWithMocks(
    new Map([[TURN_AGENT_ID, [createUserMessage({ content: 'kept' })]]]),
  )
  expect(await harness.respawn.loadSubLeadResumeMessages(undefined)).toEqual([])
  // `name@team` is not an AgentId — a transcript is never keyed by one.
  expect(
    await harness.respawn.loadSubLeadResumeMessages(SUB_LEAD_AGENT_ID),
  ).toEqual([])
  expect(harness.transcriptReads).toEqual([])
  expect(
    await harness.respawn.loadSubLeadResumeMessages(TURN_AGENT_ID),
  ).toHaveLength(1)
})

test('respawnSubLead refuses a root team, a missing sub-team and a squatted directory', async () => {
  const world = createWorld()
  const harness = await importRespawnWithMocks(new Map())

  expect(
    await harness.respawn.respawnSubLead({
      subTeamName: PARENT_TEAM,
      toolUseContext: world.toolUseContext,
    }),
  ).toMatchObject({ ok: false })
  expect(
    await harness.respawn.respawnSubLead({
      subTeamName: SUB_TEAM,
      toolUseContext: world.toolUseContext,
    }),
  ).toMatchObject({ ok: false })

  writeTeam('email-supervisor', [
    { agentId: 'team-lead@email-supervisor', name: TEAM_LEAD_NAME },
  ])
  expect(
    await harness.respawn.respawnSubLead({
      subTeamName: SUB_TEAM,
      toolUseContext: world.toolUseContext,
    }),
  ).toMatchObject({ ok: false })
  expect(harness.startCalls).toEqual([])
})

test('respawnSubLead refuses rather than pushing the session past the teammate cap', async () => {
  const world = createWorld()
  await writeCrashedSubLeadWorld(world)
  // One live teammate already (the sub-team's member), so a respawn would be
  // the second across all teams.
  process.env.CLAUDE_CODE_MAX_TEAM_TOTAL = '1'
  const harness = await importRespawnWithMocks(new Map())

  const result = await harness.respawn.respawnSubLead({
    subTeamName: SUB_TEAM,
    toolUseContext: world.toolUseContext,
  })
  expect(result.ok).toBe(false)
  expect(harness.startCalls).toEqual([])
  // Nothing was re-attached, so the sub-team is still recorded as orphaned and
  // can be adopted or respawned again later.
  expect(readTeamFile(SUB_TEAM)?.orphanedLead?.agentId).toBe(SUB_LEAD_AGENT_ID)
})
