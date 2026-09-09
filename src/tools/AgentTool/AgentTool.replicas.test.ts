import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { fullInputSchema } from './AgentTool.js'
import { REPLICAS_REQUIRE_NAME_ERROR } from './teammateReplicas.js'

type SettingsModule = typeof import('../../utils/settings/settings.js')
type SpawnMultiAgentModule = typeof import('../shared/spawnMultiAgent.js')
type AgentToolModule = typeof import('./AgentTool.js')
type SpawnTeammateConfig = Parameters<SpawnMultiAgentModule['spawnTeammate']>[0]

let originalSettingsModule: SettingsModule | undefined
let originalSpawnMultiAgentModule: SpawnMultiAgentModule | undefined

const ENV_KEYS = [
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'USER_TYPE',
  'CLAUDE_CODE_MAX_TEAMMATE_REPLICAS',
  'CLAUDE_CODE_MAX_TEAMMATES',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.replicas.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
})

afterEach(() => {
  try {
    mock.restore()
    if (originalSettingsModule) {
      mock.module('../../utils/settings/settings.js', () => originalSettingsModule!)
    }
    if (originalSpawnMultiAgentModule) {
      mock.module(
        '../shared/spawnMultiAgent.js',
        () => originalSpawnMultiAgentModule!,
      )
    }
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type SpawnedData = {
  teammate_id: string
  agent_id: string
  team_name: string
  name: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  is_splitpane: boolean
}

function spawnedData(name: string): { data: SpawnedData } {
  return {
    data: {
      teammate_id: `${name}@review-team`,
      agent_id: `${name}@review-team`,
      team_name: 'review-team',
      name,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      is_splitpane: false,
    },
  }
}

async function importAgentToolWithSpawnMock(options: {
  spawnTeammate?: (config: SpawnTeammateConfig) => Promise<{ data: SpawnedData }>
  uniqueName?: (base: string) => Promise<string>
} = {}): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  spawnTeammate: ReturnType<typeof mock>
  generateUniqueTeammateName: ReturnType<typeof mock>
}> {
  originalSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentToolReplicasActual=${Date.now()}-${Math.random()}`
  )
  originalSpawnMultiAgentModule ??= await import(
    `../shared/spawnMultiAgent.ts?agentToolReplicasActual=${Date.now()}-${Math.random()}`
  )
  const spawnTeammate = mock(
    options.spawnTeammate ??
      (async (config: SpawnTeammateConfig) => spawnedData(config.name)),
  )
  const generateUniqueTeammateName = mock(
    options.uniqueName ?? (async (base: string) => base),
  )
  mock.module('../../utils/settings/settings.js', () => ({
    ...originalSettingsModule!,
    getInitialSettings: () => ({}),
    getSettings_DEPRECATED: () => ({}),
  }))
  mock.module('../shared/spawnMultiAgent.js', () => ({
    ...originalSpawnMultiAgentModule!,
    spawnTeammate,
    generateUniqueTeammateName,
  }))
  const { AgentTool } = await import(
    `./AgentTool.js?agentToolReplicas=${Date.now()}-${Math.random()}`
  )
  return { AgentTool, spawnTeammate, generateUniqueTeammateName }
}

/** `running` in-process teammate tasks, enough to occupy `count` pool slots. */
function runningTeammateTasks(count: number): Record<string, unknown> {
  const tasks: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    tasks[`t-${i}`] = {
      id: `t-${i}`,
      type: 'in_process_teammate',
      status: 'running',
      isIdle: i % 2 === 0,
    }
  }
  return tasks
}

function makeToolUseContext(options: { tasks?: Record<string, unknown> } = {}): ToolUseContext {
  const appState = {
    toolPermissionContext: { mode: 'default' },
    teamContext: undefined,
    tasks: options.tasks ?? {},
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
  } as unknown as ToolUseContext
}

const allow = () => mock(async () => ({ behavior: 'allow' })) as never

test('the full schema accepts replicas as a positive integer only', () => {
  const schema = fullInputSchema()
  expect(
    schema.safeParse({ description: 'pool', name: 'w', replicas: 3 }).success,
  ).toBe(true)
  expect(
    schema.safeParse({ description: 'pool', name: 'w', replicas: 0 }).success,
  ).toBe(false)
  expect(
    schema.safeParse({ description: 'pool', name: 'w', replicas: 1.5 }).success,
  ).toBe(false)
})

test('validateInput rejects replicas without a name and over the per-call cap', async () => {
  const { AgentTool } = await importAgentToolWithSpawnMock()
  await expect(
    AgentTool.validateInput!(
      { description: 'pool', prompt: 'work', replicas: 2 } as never,
    ),
  ).resolves.toMatchObject({ result: false, message: REPLICAS_REQUIRE_NAME_ERROR })
  const over = await AgentTool.validateInput!(
    { description: 'pool', name: 'w', replicas: 9 } as never,
  )
  expect(over.result).toBe(false)
  expect((over as { message: string }).message).toContain('per-call cap of 8')
  await expect(
    AgentTool.validateInput!({ description: 'pool', name: 'w', replicas: 8 } as never),
  ).resolves.toEqual({ result: true })
})

test('replicas=3 without a prompt spawns three idle teammates named name-1..3', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  const result = await AgentTool.call(
    { description: 'pool', name: 'w', team_name: 'review-team', replicas: 3 } as never,
    makeToolUseContext(),
    allow(),
    { requestId: 'req-rep-1' } as never,
  )

  expect(spawnTeammate).toHaveBeenCalledTimes(3)
  const configs = spawnTeammate.mock.calls.map(c => c[0] as SpawnTeammateConfig)
  expect(configs.map(c => c.name)).toEqual(['w-1', 'w-2', 'w-3'])
  for (const config of configs) {
    expect(config.prompt).toBeUndefined()
    expect(config.team_name).toBe('review-team')
    expect(config.description).toBe('pool')
  }
  const data = result.data as unknown as {
    status: string
    teammate_id: string
    replicas: Array<{ name: string; agent_id: string }>
    failed?: unknown
  }
  expect(data.status).toBe('teammate_spawned')
  expect(data.teammate_id).toBe('w-1@review-team')
  expect(data.replicas.map(r => r.name)).toEqual(['w-1', 'w-2', 'w-3'])
  expect(data.failed).toBeUndefined()

  const block = AgentTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_1')
  const text = (block.content as Array<{ text: string }>)[0]!.text
  expect(text).toContain('Spawned 3 teammates in team review-team')
  expect(text).toContain('- w-2 (agent_id: w-2@review-team)')
  expect(text).toContain('started idle')
  expect(text).toContain('ListAgents')
})

test('replica names are made unique against the roster', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock({
    uniqueName: async base => (base === 'w-2' ? 'w-2-2' : base),
  })
  await AgentTool.call(
    { description: 'pool', name: 'w', team_name: 'review-team', prompt: 'go', replicas: 3 } as never,
    makeToolUseContext(),
    allow(),
    { requestId: 'req-rep-2' } as never,
  )
  const names = spawnTeammate.mock.calls.map(c => (c[0] as SpawnTeammateConfig).name)
  expect(names).toEqual(['w-1', 'w-2-2', 'w-3'])
  expect(spawnTeammate.mock.calls.every(c => (c[0] as SpawnTeammateConfig).prompt === 'go')).toBe(true)
})

test('a failing replica stops the loop and reports the successes plus the failure', async () => {
  let calls = 0
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock({
    spawnTeammate: async config => {
      calls++
      if (calls === 3) throw new Error('tmux pane limit reached')
      return spawnedData(config.name)
    },
  })
  const result = await AgentTool.call(
    { description: 'pool', name: 'w', team_name: 'review-team', replicas: 4 } as never,
    makeToolUseContext(),
    allow(),
    { requestId: 'req-rep-3' } as never,
  )
  expect(spawnTeammate).toHaveBeenCalledTimes(3)
  const data = result.data as unknown as {
    replicas: Array<{ name: string }>
    failed?: { index: number; name: string; error: string }
  }
  expect(data.replicas.map(r => r.name)).toEqual(['w-1', 'w-2'])
  expect(data.failed).toEqual({ index: 3, name: 'w-3', error: 'tmux pane limit reached' })
  const block = AgentTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_2')
  const text = (block.content as Array<{ text: string }>)[0]!.text
  expect(text).toContain('Replica 3 (w-3) failed to spawn: tmux pane limit reached')
  expect(text).toContain('The 2 listed above are running')
})

test('the live teammate cap applies to multi-replica and single spawns', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()
  await expect(
    AgentTool.call(
      { description: 'pool', name: 'w', team_name: 'review-team', replicas: 2 } as never,
      makeToolUseContext({ tasks: runningTeammateTasks(15) }),
      allow(),
      { requestId: 'req-rep-4' } as never,
    ),
  ).rejects.toThrow('live teammate cap of 16')
  await expect(
    AgentTool.call(
      { description: 'one', name: 'w', team_name: 'review-team' } as never,
      makeToolUseContext({ tasks: runningTeammateTasks(16) }),
      allow(),
      { requestId: 'req-rep-5' } as never,
    ),
  ).rejects.toThrow('live teammate cap of 16')
  expect(spawnTeammate).not.toHaveBeenCalled()

  process.env.CLAUDE_CODE_MAX_TEAMMATES = '20'
  await AgentTool.call(
    { description: 'pool', name: 'w', team_name: 'review-team', replicas: 2 } as never,
    makeToolUseContext({ tasks: runningTeammateTasks(15) }),
    allow(),
    { requestId: 'req-rep-6' } as never,
  )
  expect(spawnTeammate).toHaveBeenCalledTimes(2)
})

test('replicas=1 and replicas omitted make the same single spawn as before', async () => {
  const { AgentTool, spawnTeammate, generateUniqueTeammateName } =
    await importAgentToolWithSpawnMock()
  for (const input of [
    { description: 'one', name: 'w', team_name: 'review-team', replicas: 1 },
    { description: 'one', name: 'w', team_name: 'review-team' },
  ]) {
    const result = await AgentTool.call(
      input as never,
      makeToolUseContext(),
      allow(),
      { requestId: 'req-rep-7' } as never,
    )
    const data = result.data as unknown as { name: string; replicas?: unknown }
    expect(data.name).toBe('w')
    expect(data.replicas).toBeUndefined()
  }
  expect(spawnTeammate).toHaveBeenCalledTimes(2)
  expect(spawnTeammate.mock.calls.every(c => (c[0] as SpawnTeammateConfig).name === 'w')).toBe(true)
  expect(generateUniqueTeammateName).not.toHaveBeenCalled()
})
