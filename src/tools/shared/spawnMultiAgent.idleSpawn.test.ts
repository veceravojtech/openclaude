import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'

type SpawnInProcessModule = typeof import('../../utils/swarm/spawnInProcess.js')
type InProcessRunnerModule = typeof import('../../utils/swarm/inProcessRunner.js')
type TeamHelpersModule = typeof import('../../utils/swarm/teamHelpers.js')
type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

let actualSpawnInProcess: SpawnInProcessModule | undefined
let actualInProcessRunner: InProcessRunnerModule | undefined
let actualTeamHelpers: TeamHelpersModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/shared/spawnMultiAgent.idleSpawn.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
    if (actualSpawnInProcess) {
      mock.module(
        '../../utils/swarm/spawnInProcess.js',
        () => ({ ...actualSpawnInProcess! }),
      )
    }
    if (actualInProcessRunner) {
      mock.module(
        '../../utils/swarm/inProcessRunner.js',
        () => ({ ...actualInProcessRunner! }),
      )
    }
    if (actualTeamHelpers) {
      mock.module('../../utils/swarm/teamHelpers.js', () => ({ ...actualTeamHelpers! }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importSpawnMultiAgentWithMocks(): Promise<{
  spawnMultiAgent: SpawnMultiAgentModule
  spawnInProcessTeammate: ReturnType<typeof mock>
  startInProcessTeammate: ReturnType<typeof mock>
  teamFiles: Map<string, TeamFile>
}> {
  actualSpawnInProcess ??= await import(
    `../../utils/swarm/spawnInProcess.ts?spawnMultiAgentIdleActual=${Date.now()}-${Math.random()}`
  )
  actualInProcessRunner ??= await import(
    `../../utils/swarm/inProcessRunner.ts?spawnMultiAgentIdleActual=${Date.now()}-${Math.random()}`
  )
  actualTeamHelpers ??= await import(
    `../../utils/swarm/teamHelpers.ts?spawnMultiAgentIdleActual=${Date.now()}-${Math.random()}`
  )

  const teamFiles = new Map<string, TeamFile>()
  const spawnInProcessTeammate = mock(
    async (config: { name: string; teamName: string }) => ({
      success: true,
      agentId: `${config.name}@${config.teamName}`,
      taskId: 'task-idle-1',
      abortController: new AbortController(),
      teammateContext: { parentSessionId: 'parent-session' },
    }),
  )
  const startInProcessTeammate = mock(() => {})

  mock.module('../../utils/swarm/spawnInProcess.js', () => ({
    ...actualSpawnInProcess!,
    spawnInProcessTeammate,
  }))
  mock.module('../../utils/swarm/inProcessRunner.js', () => ({
    ...actualInProcessRunner!,
    startInProcessTeammate,
  }))
  mock.module('../../utils/swarm/teamHelpers.js', () => ({
    ...actualTeamHelpers!,
    readTeamFileAsync: async (teamName: string) =>
      teamFiles.get(teamName) ?? null,
    writeTeamFileAsync: async (teamName: string, teamFile: TeamFile) => {
      teamFiles.set(teamName, teamFile)
    },
    registerTeamForSessionCleanup: () => {},
  }))

  const spawnMultiAgent: SpawnMultiAgentModule = await import(
    `./spawnMultiAgent.ts?spawnMultiAgentIdle=${Date.now()}-${Math.random()}`
  )
  return {
    spawnMultiAgent,
    spawnInProcessTeammate,
    startInProcessTeammate,
    teamFiles,
  }
}

function makeToolUseContext(): ToolUseContext {
  let state: AppState = { ...getDefaultAppState(), mainLoopModel: 'test-model' }
  return {
    options: {
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    toolUseId: 'toolu_spawn',
  } as unknown as ToolUseContext
}

test('the in-process handler accepts an idle spawn without a prompt', async () => {
  const { spawnMultiAgent, spawnInProcessTeammate, startInProcessTeammate, teamFiles } =
    await importSpawnMultiAgentWithMocks()

  const result = await spawnMultiAgent.spawnTeammate(
    {
      name: 'idle-worker',
      team_name: 'idle-team',
      description: 'idle worker',
      // The Agent tool always passes use_splitpane:true; idle spawns must
      // still land in-process.
      use_splitpane: true,
    },
    makeToolUseContext(),
  )

  expect(result.data.name).toBe('idle-worker')
  expect(result.data.tmux_pane_id).toBe('in-process')
  expect(result.data.is_splitpane).toBe(false)

  expect(spawnInProcessTeammate).toHaveBeenCalledTimes(1)
  const spawnConfig = spawnInProcessTeammate.mock.calls[0]![0] as {
    prompt?: string
    name: string
  }
  expect(spawnConfig.name).toBe('idle-worker')
  expect(spawnConfig.prompt).toBeUndefined()

  expect(startInProcessTeammate).toHaveBeenCalledTimes(1)
  const runnerConfig = startInProcessTeammate.mock.calls[0]![0] as {
    prompt?: string
    description?: string
  }
  expect(runnerConfig.prompt).toBeUndefined()
  expect(runnerConfig.description).toBe('idle worker')

  const member = teamFiles.get('idle-team')?.members.find(m => m.name === 'idle-worker')
  expect(member).toBeDefined()
  expect(member?.prompt).toBeUndefined()
  expect(member?.backendType).toBe('in-process')
})

test('the in-process handler still rejects an empty prompt', async () => {
  const { spawnMultiAgent, spawnInProcessTeammate } =
    await importSpawnMultiAgentWithMocks()

  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'idle-worker', team_name: 'idle-team', prompt: '' },
      makeToolUseContext(),
    ),
  ).rejects.toThrow('prompt must not be empty; omit it to spawn an idle teammate')
  expect(spawnInProcessTeammate).not.toHaveBeenCalled()
})

test('the split-pane handler rejects an idle spawn with a clear error', async () => {
  const { spawnMultiAgent } = await importSpawnMultiAgentWithMocks()

  await expect(
    spawnMultiAgent.handleSpawnSplitPane(
      { name: 'idle-worker', team_name: 'idle-team' },
      makeToolUseContext(),
    ),
  ).rejects.toThrow(spawnMultiAgent.IDLE_SPAWN_UNSUPPORTED_ERROR)
  expect(spawnMultiAgent.IDLE_SPAWN_UNSUPPORTED_ERROR).toBe(
    'idle spawn (no prompt) is only supported for in-process teammates',
  )
})

test('the dispatch decision is recorded on the team member entry', async () => {
  const { spawnMultiAgent, teamFiles } = await importSpawnMultiAgentWithMocks()
  const dispatch = {
    role: 'review' as const,
    family: 'fable-5.1',
    model: 'claude-fable-5-1',
    source: 'jev' as const,
    mode: 'auto' as const,
    reason: 'jev p=0.86; excluded sonnet-5 used by dev',
    probabilities: { review: 0.86, implement: 0.14 },
    costUsd: 0.0004,
  }
  await spawnMultiAgent.spawnTeammate(
    { name: 'rev', team_name: 'dispatch-team', description: 'review', dispatch },
    makeToolUseContext(),
  )
  const member = teamFiles.get('dispatch-team')?.members.find(m => m.name === 'rev')
  expect(member?.role).toBe('review')
  expect(member?.family).toBe('fable-5.1')
  expect(member?.dispatch).toEqual(dispatch)
})
