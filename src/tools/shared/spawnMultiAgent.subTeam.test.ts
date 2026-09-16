import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'

// U3: a member spawned by a sub-team leader belongs to the SUB-team's roster,
// never to its parent's, and a sub-team is never conjured by the spawn path —
// ensureTeamFileExists auto-creates root teams only, because a sub-team it
// invented would have no parent recorded and no leader anything can resolve.

type SpawnInProcessModule = typeof import('../../utils/swarm/spawnInProcess.js')
type InProcessRunnerModule = typeof import('../../utils/swarm/inProcessRunner.js')
type TeamHelpersModule = typeof import('../../utils/swarm/teamHelpers.js')
type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

let actualSpawnInProcess: SpawnInProcessModule | undefined
let actualInProcessRunner: InProcessRunnerModule | undefined
let actualTeamHelpers: TeamHelpersModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/shared/spawnMultiAgent.subTeam.test.ts')
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
  teamFiles: Map<string, TeamFile>
}> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualSpawnInProcess ??= await import(
    `../../utils/swarm/spawnInProcess.ts?spawnMultiAgentSubTeamActual=${stamp}`
  )
  actualInProcessRunner ??= await import(
    `../../utils/swarm/inProcessRunner.ts?spawnMultiAgentSubTeamActual=${stamp}`
  )
  actualTeamHelpers ??= await import(
    `../../utils/swarm/teamHelpers.ts?spawnMultiAgentSubTeamActual=${stamp}`
  )

  const teamFiles = new Map<string, TeamFile>()
  const spawnInProcessTeammate = mock(
    async (config: { name: string; teamName: string }) => ({
      success: true,
      agentId: `${config.name}@${config.teamName}`,
      taskId: 'task-subteam-1',
      abortController: new AbortController(),
      teammateContext: { parentSessionId: 'parent-session' },
    }),
  )

  mock.module('../../utils/swarm/spawnInProcess.js', () => ({
    ...actualSpawnInProcess!,
    spawnInProcessTeammate,
  }))
  mock.module('../../utils/swarm/inProcessRunner.js', () => ({
    ...actualInProcessRunner!,
    startInProcessTeammate: mock(() => {}),
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
    `./spawnMultiAgent.ts?spawnMultiAgentSubTeam=${stamp}`
  )
  return { spawnMultiAgent, teamFiles }
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
    toolUseId: 'toolu_spawn_subteam',
  } as unknown as ToolUseContext
}

function seedTeam(
  teamFiles: Map<string, TeamFile>,
  name: string,
  parent?: { parentTeam: string; parentAgentId: string },
): void {
  teamFiles.set(name, {
    name,
    createdAt: 1,
    leadAgentId: `team-lead@${name}`,
    ...parent,
    members: [
      {
        agentId: `team-lead@${name}`,
        name: 'team-lead',
        joinedAt: 1,
        tmuxPaneId: '',
        cwd: '/tmp',
        subscriptions: [],
      },
    ],
  })
}

test('a member spawned into a sub-team lands in that roster only', async () => {
  const { spawnMultiAgent, teamFiles } = await importSpawnMultiAgentWithMocks()
  seedTeam(teamFiles, 'email')
  seedTeam(teamFiles, 'email/supervisor', {
    parentTeam: 'email',
    parentAgentId: 'supervisor@email',
  })

  const result = await spawnMultiAgent.spawnTeammate(
    { name: 'worker', team_name: 'email/supervisor', description: 'worker' },
    makeToolUseContext(),
  )

  expect(result.data.agent_id).toBe('worker@email/supervisor')
  expect(result.data.team_name).toBe('email/supervisor')

  const subTeam = teamFiles.get('email/supervisor')
  expect(subTeam?.members.map(m => m.agentId)).toEqual([
    'team-lead@email/supervisor',
    'worker@email/supervisor',
  ])
  expect(subTeam?.parentTeam).toBe('email')
  expect(subTeam?.parentAgentId).toBe('supervisor@email')

  // The parent roster stays flat and unchanged.
  expect(teamFiles.get('email')?.members.map(m => m.name)).toEqual(['team-lead'])
})

test('a missing sub-team is not auto-created', async () => {
  const { spawnMultiAgent, teamFiles } = await importSpawnMultiAgentWithMocks()
  seedTeam(teamFiles, 'email')

  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'worker', team_name: 'email/supervisor' },
      makeToolUseContext(),
    ),
  ).rejects.toThrow(
    'A sub-team of "email" has to be created by its leader with TeamCreate',
  )
  expect(teamFiles.has('email/supervisor')).toBe(false)
})

test('a missing root team is still auto-created', async () => {
  const { spawnMultiAgent, teamFiles } = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.spawnTeammate(
    { name: 'worker', team_name: 'fresh-team' },
    makeToolUseContext(),
  )

  const team = teamFiles.get('fresh-team')
  expect(team?.leadAgentId).toBe('team-lead@fresh-team')
  expect(team?.parentTeam).toBeUndefined()
  expect(team?.members.map(m => m.name)).toEqual(['team-lead', 'worker'])
})
