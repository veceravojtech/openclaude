/**
 * Permission inheritance across the PRIMARY spawn path.
 *
 * spawnInProcess.permissionMode.test.ts covers the resolver by calling
 * spawnInProcessTeammate with a hand-built SpawnContext. That leaves the path
 * every real spawn actually takes untested: spawnTeammate -> handleSpawn ->
 * handleSpawnInProcess, which forwards its whole ToolUseContext as the
 * SpawnContext. Nothing there mentions getAppState, so the inheritance rides
 * entirely on structural typing and a hand-built context cannot detect it
 * breaking. These tests therefore mock only the agent loop and the team-file
 * IO, and let the real spawn run.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { killInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'

type RegistryModule = typeof import('../../utils/swarm/backends/registry.js')
type InProcessRunnerModule = typeof import('../../utils/swarm/inProcessRunner.js')
type TeamHelpersModule = typeof import('../../utils/swarm/teamHelpers.js')
type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

let actualRegistry: RegistryModule | undefined
let actualInProcessRunner: InProcessRunnerModule | undefined
let actualTeamHelpers: TeamHelpersModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/shared/spawnMultiAgent.permissionMode.test.ts',
  )
})

afterEach(() => {
  try {
    mock.restore()
    if (actualRegistry) {
      mock.module(
        '../../utils/swarm/backends/registry.js',
        () => actualRegistry!,
      )
    }
    if (actualInProcessRunner) {
      mock.module(
        '../../utils/swarm/inProcessRunner.js',
        () => actualInProcessRunner!,
      )
    }
    if (actualTeamHelpers) {
      mock.module('../../utils/swarm/teamHelpers.js', () => actualTeamHelpers!)
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importSpawnMultiAgentWithMocks(): Promise<{
  spawnMultiAgent: SpawnMultiAgentModule
  startInProcessTeammate: ReturnType<typeof mock>
}> {
  const tag = `${Date.now()}-${Math.random()}`
  actualRegistry ??= await import(
    `../../utils/swarm/backends/registry.ts?spawnMultiAgentPermActual=${tag}`
  )
  actualInProcessRunner ??= await import(
    `../../utils/swarm/inProcessRunner.ts?spawnMultiAgentPermActual=${tag}`
  )
  actualTeamHelpers ??= await import(
    `../../utils/swarm/teamHelpers.ts?spawnMultiAgentPermActual=${tag}`
  )

  // The teammate's agent loop would start a real conversation; the spawn is
  // all this test cares about.
  const startInProcessTeammate = mock(() => {})
  const teamFiles = new Map<string, TeamFile>()

  mock.module('../../utils/swarm/backends/registry.js', () => ({
    ...actualRegistry!,
    // Pin the in-process route so the prompted spawn does not depend on the
    // ambient teammate-mode flag or on tmux being installed.
    isInProcessEnabled: () => true,
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
    `./spawnMultiAgent.ts?spawnMultiAgentPerm=${tag}`
  )
  return { spawnMultiAgent, startInProcessTeammate }
}

function bypassContext(): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  }
}

/**
 * A ToolUseContext whose live AppState is pinned to `leaderContext`, plus a
 * reader for the state the spawn mutated.
 */
function makeToolUseContext(leaderContext?: ToolPermissionContext): {
  context: ToolUseContext
  getState: () => AppState
} {
  let state: AppState = { ...getDefaultAppState(), mainLoopModel: 'test-model' }
  if (leaderContext) {
    state = { ...state, toolPermissionContext: leaderContext }
  }
  const context = {
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
    toolUseId: 'toolu_spawn_perm',
  } as unknown as ToolUseContext
  return { context, getState: () => state }
}

/**
 * Spawns through the real spawnTeammate entry point and returns the permission
 * mode the teammate's task was registered with.
 */
async function spawnAndReadMode(
  name: string,
  {
    leaderContext,
    planModeRequired = false,
  }: {
    leaderContext?: ToolPermissionContext
    planModeRequired?: boolean
  },
): Promise<string> {
  const { spawnMultiAgent } = await importSpawnMultiAgentWithMocks()
  const { context, getState } = makeToolUseContext(leaderContext)

  const result = await spawnMultiAgent.spawnTeammate(
    {
      name,
      team_name: 'perm-primary-team',
      prompt: 'work',
      plan_mode_required: planModeRequired,
    },
    context,
  )
  // The in-process route must actually have been taken, or the assertion
  // below would be vacuous.
  expect(result.data.tmux_pane_id).toBe('in-process')

  const state = getState()
  const entry = Object.entries(state.tasks).find(
    ([, task]) =>
      task.type === 'in_process_teammate' && task.identity.agentName === name,
  )
  if (!entry) {
    throw new Error(`teammate task for ${name} was not registered`)
  }
  const [taskId, task] = entry
  if (task.type !== 'in_process_teammate') {
    throw new Error('unreachable: task type narrowed above')
  }
  const mode = task.permissionMode
  killInProcessTeammate(taskId, context.setAppState)
  return mode
}

test('a teammate spawned through spawnTeammate inherits the leader bypass mode', async () => {
  // The regression this guards: handleSpawnInProcess passing something other
  // than its own ToolUseContext (or a narrowed shape without getAppState) to
  // spawnInProcessTeammate, which would silently drop the leader's mode.
  expect(
    await spawnAndReadMode('primary-inheritor', {
      leaderContext: bypassContext(),
    }),
  ).toBe('bypassPermissions')
})

test('a teammate spawned through spawnTeammate under a default leader stays in default', async () => {
  expect(await spawnAndReadMode('primary-plain', {})).toBe('default')
})

test('plan_mode_required still wins over the leader mode on the primary path', async () => {
  expect(
    await spawnAndReadMode('primary-planner', {
      leaderContext: bypassContext(),
      planModeRequired: true,
    }),
  ).toBe('plan')
})
