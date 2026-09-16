import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  fullInputSchema,
  getMissingPromptError,
  IDLE_TEAMMATE_PROMPT_REQUIRED_ERROR,
  IDLE_TEAMMATE_TEAMS_DISABLED_ERROR,
  inputSchema,
} from './AgentTool.js'

type SettingsModule = typeof import('../../utils/settings/settings.js')
type SpawnMultiAgentModule = typeof import('../shared/spawnMultiAgent.js')
type AgentToolModule = typeof import('./AgentTool.js')
type SpawnTeammateConfig = Parameters<SpawnMultiAgentModule['spawnTeammate']>[0]

let originalSettingsModule: SettingsModule | undefined
let originalSpawnMultiAgentModule: SpawnMultiAgentModule | undefined

const originalEnv = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
  CLAUDE_CODE_DISABLE_AGENT_TEAMS: process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS,
  USER_TYPE: process.env.USER_TYPE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.idleSpawn.test.ts')
  // Teams are on by default; individual tests turn them off explicitly.
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  delete process.env.USER_TYPE
})

afterEach(() => {
  try {
    mock.restore()
    if (originalSettingsModule) {
      mock.module('../../utils/settings/settings.js', () => ({ ...originalSettingsModule! }))
    }
    if (originalSpawnMultiAgentModule) {
      mock.module(
        '../shared/spawnMultiAgent.js',
        () => ({ ...originalSpawnMultiAgentModule! }),
      )
    }
    restoreEnv('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS')
    restoreEnv('CLAUDE_CODE_DISABLE_AGENT_TEAMS')
    restoreEnv('USER_TYPE')
  } finally {
    releaseSharedMutationLock()
  }
})

function restoreEnv(key: keyof typeof originalEnv): void {
  const originalValue = originalEnv[key]
  if (originalValue === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalValue
  }
}

function disableTeams(): void {
  process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
  delete process.env.USER_TYPE
}

async function importAgentToolWithSpawnMock(): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  spawnTeammate: ReturnType<typeof mock>
}> {
  originalSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentToolIdleActual=${Date.now()}-${Math.random()}`
  )
  originalSpawnMultiAgentModule ??= await import(
    `../shared/spawnMultiAgent.ts?agentToolIdleActual=${Date.now()}-${Math.random()}`
  )
  const spawnTeammate = mock(async () => ({
    data: {
      teammate_id: 'idle-worker@review-team',
      agent_id: 'idle-worker@review-team',
      team_name: 'review-team',
      name: 'idle-worker',
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      is_splitpane: false,
    },
  }))
  // The teammate path resolves agent routing and the model allowlist from
  // getInitialSettings()/getSettings_DEPRECATED(), which otherwise read the
  // developer's real settings files and prime the session settings cache.
  mock.module('../../utils/settings/settings.js', () => ({
    ...originalSettingsModule!,
    getInitialSettings: () => ({}),
    getSettings_DEPRECATED: () => ({}),
  }))
  mock.module('../shared/spawnMultiAgent.js', () => ({
    ...originalSpawnMultiAgentModule!,
    spawnTeammate,
  }))
  const { AgentTool } = await import(
    `./AgentTool.js?agentToolIdle=${Date.now()}-${Math.random()}`
  )
  return { AgentTool, spawnTeammate }
}

function makeToolUseContext(options: { teamName?: string } = {}): ToolUseContext {
  const appState = {
    toolPermissionContext: { mode: 'default' },
    teamContext: options.teamName ? { teamName: options.teamName } : undefined,
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: {},
    messages: [],
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

test('input schema accepts a missing prompt', () => {
  expect(
    inputSchema().safeParse({ description: 'idle worker', name: 'worker' })
      .success,
  ).toBe(true)
  expect(
    fullInputSchema().safeParse({ description: 'idle worker', name: 'worker' })
      .success,
  ).toBe(true)
  // The name requirement is enforced by validateInput/call, not the schema.
  expect(inputSchema().safeParse({ description: 'idle worker' }).success).toBe(
    true,
  )
  expect(inputSchema().shape.prompt.description).toContain('omitted')
  expect(inputSchema().shape.prompt.description).toContain('idle')
})

test('a missing prompt without a name is rejected with the exact error', async () => {
  expect(getMissingPromptError({})).toBe(IDLE_TEAMMATE_PROMPT_REQUIRED_ERROR)
  expect(getMissingPromptError({ prompt: 'work' })).toBeUndefined()

  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await expect(
    AgentTool.validateInput!(
      { description: 'idle worker' } as never,
    ),
  ).resolves.toEqual({
    result: false,
    message: IDLE_TEAMMATE_PROMPT_REQUIRED_ERROR,
    errorCode: 1,
  })

  await expect(
    AgentTool.call(
      { description: 'idle worker' } as never,
      makeToolUseContext({ teamName: 'review-team' }),
      mock(async () => ({ behavior: 'allow' })) as never,
      { requestId: 'req-idle-1' } as never,
    ),
  ).rejects.toThrow(IDLE_TEAMMATE_PROMPT_REQUIRED_ERROR)
  expect(spawnTeammate).not.toHaveBeenCalled()
})

test('a missing prompt with a name is rejected when Agent Teams is disabled', async () => {
  disableTeams()
  expect(getMissingPromptError({ name: 'worker' })).toBe(
    IDLE_TEAMMATE_TEAMS_DISABLED_ERROR,
  )

  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await expect(
    AgentTool.validateInput!(
      { description: 'idle worker', name: 'worker' } as never,
    ),
  ).resolves.toEqual({
    result: false,
    message: IDLE_TEAMMATE_TEAMS_DISABLED_ERROR,
    errorCode: 1,
  })

  await expect(
    AgentTool.call(
      { description: 'idle worker', name: 'worker' } as never,
      makeToolUseContext(),
      mock(async () => ({ behavior: 'allow' })) as never,
      { requestId: 'req-idle-2' } as never,
    ),
  ).rejects.toThrow(IDLE_TEAMMATE_TEAMS_DISABLED_ERROR)
  expect(spawnTeammate).not.toHaveBeenCalled()
})

test('a missing prompt with a name but no team is rejected before the subagent path', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await expect(
    AgentTool.call(
      { description: 'idle worker', name: 'worker' } as never,
      makeToolUseContext(),
      mock(async () => ({ behavior: 'allow' })) as never,
      { requestId: 'req-idle-3' } as never,
    ),
  ).rejects.toThrow(/requires a team/)
  expect(spawnTeammate).not.toHaveBeenCalled()
})

test('a missing prompt with a name spawns an idle teammate', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await expect(
    AgentTool.validateInput!(
      { description: 'idle worker', name: 'idle-worker' } as never,
    ),
  ).resolves.toEqual({ result: true })

  const result = await AgentTool.call(
    { description: 'idle worker', name: 'idle-worker', team_name: 'review-team' } as never,
    makeToolUseContext(),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-idle-4' } as never,
  )

  expect(spawnTeammate).toHaveBeenCalledTimes(1)
  const config = spawnTeammate.mock.calls[0]![0] as SpawnTeammateConfig
  expect(config.name).toBe('idle-worker')
  expect(config.team_name).toBe('review-team')
  expect(config.prompt).toBeUndefined()
  expect(config.description).toBe('idle worker')

  const data = result.data as unknown as { status: string; prompt?: string }
  expect(data.status).toBe('teammate_spawned')
  expect(data.prompt).toBeUndefined()
})

test('a prompted teammate spawn still forwards its prompt', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await AgentTool.call(
    {
      description: 'review',
      prompt: 'check the branch',
      name: 'worker-a',
      team_name: 'review-team',
    } as never,
    makeToolUseContext(),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-idle-5' } as never,
  )

  const config = spawnTeammate.mock.calls[0]![0] as SpawnTeammateConfig
  expect(config.prompt).toBe('check the branch')
})
