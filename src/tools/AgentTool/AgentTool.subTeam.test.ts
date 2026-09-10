import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  type TeamFile,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'

// U3: the flat-roster guard is relaxed for exactly one caller — a teammate
// that leads its own sub-team, which spawns into THAT team. Everyone the
// guard blocks today must still be blocked, in particular a subagent running
// inside a teammate's turn: `isTeammate()` is ambient and true for it, while
// resolveCallerIdentity() (what the guard now asks) says it is not the
// teammate. The neighbouring background-agent guard is untouched.

type SettingsModule = typeof import('../../utils/settings/settings.js')
type SpawnMultiAgentModule = typeof import('../shared/spawnMultiAgent.js')
type AgentToolModule = typeof import('./AgentTool.js')
type SpawnTeammateConfig = Parameters<SpawnMultiAgentModule['spawnTeammate']>[0]

let originalSettingsModule: SettingsModule | undefined
let originalSpawnMultiAgentModule: SpawnMultiAgentModule | undefined
let configDir: string | undefined

const TURN_AGENT_ID = asAgentId('a00000000000beef')
const SUBAGENT_ID = asAgentId('a11111111111cafe')

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.subTeam.test.ts')
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-agent-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.restore()
    if (originalSettingsModule) {
      mock.module(
        '../../utils/settings/settings.js',
        () => originalSettingsModule!,
      )
    }
    if (originalSpawnMultiAgentModule) {
      mock.module(
        '../shared/spawnMultiAgent.js',
        () => originalSpawnMultiAgentModule!,
      )
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

async function importAgentToolWithSpawnMock(): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  spawnTeammate: ReturnType<typeof mock>
}> {
  const stamp = `${Date.now()}-${Math.random()}`
  originalSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentToolSubTeamActual=${stamp}`
  )
  originalSpawnMultiAgentModule ??= await import(
    `../shared/spawnMultiAgent.ts?agentToolSubTeamActual=${stamp}`
  )
  const spawnTeammate = mock(async (config: { name: string; team_name?: string }) => ({
    data: {
      teammate_id: `${config.name}@${config.team_name}`,
      agent_id: `${config.name}@${config.team_name}`,
      team_name: config.team_name,
      name: config.name,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      is_splitpane: false,
    },
  }))
  // Keep agent routing and the model allowlist off the developer's real
  // settings files (precedent: AgentTool.idleSpawn.test.ts).
  mock.module('../../utils/settings/settings.js', () => ({
    ...originalSettingsModule!,
    getInitialSettings: () => ({}),
    getSettings_DEPRECATED: () => ({}),
  }))
  mock.module('../shared/spawnMultiAgent.js', () => ({
    ...originalSpawnMultiAgentModule!,
    spawnTeammate,
  }))
  const { AgentTool } = await import(`./AgentTool.js?agentToolSubTeam=${stamp}`)
  return { AgentTool, spawnTeammate }
}

function makeToolUseContext(options: {
  teamName?: string
  agentId?: string
}): ToolUseContext {
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    toolPermissionContext: { mode: 'default' },
    tasks: {},
    teamContext: options.teamName ? { teamName: options.teamName } : undefined,
  } as unknown as AppState
  return {
    agentId: options.agentId ?? TURN_AGENT_ID,
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

function asTeammate<T>(
  name: string,
  team: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTeammateContext(
    {
      agentId: `${name}@${team}`,
      agentName: name,
      teamName: team,
      planModeRequired: false,
      parentSessionId: 'parent-session',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: TURN_AGENT_ID,
    },
    fn,
  )
}

async function writeSubTeam(): Promise<void> {
  const teamFile: TeamFile = {
    name: 'email/supervisor',
    createdAt: 1,
    leadAgentId: 'team-lead@email/supervisor',
    parentTeam: 'email',
    parentAgentId: 'supervisor@email',
    members: [],
  }
  await writeTeamFileAsync('email/supervisor', teamFile)
}

function spawn(
  AgentTool: AgentToolModule['AgentTool'],
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<unknown> {
  return AgentTool.call(
    input as never,
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-subteam-spawn' } as never,
  )
}

test('a teammate leading a sub-team spawns named members into it', async () => {
  await writeSubTeam()
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await asTeammate('supervisor', 'email', () =>
    spawn(
      AgentTool,
      { description: 'worker', name: 'worker' },
      makeToolUseContext({ teamName: 'email' }),
    ),
  )

  expect(spawnTeammate).toHaveBeenCalledTimes(1)
  const config = spawnTeammate.mock.calls[0]![0] as SpawnTeammateConfig
  expect(config.name).toBe('worker')
  // team_name defaults to the sub-team, not to the caller's own team.
  expect(config.team_name).toBe('email/supervisor')
})

test('an explicit team_name is accepted only for the caller sub-team', async () => {
  await writeSubTeam()
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await asTeammate('supervisor', 'email', () =>
    spawn(
      AgentTool,
      {
        description: 'worker',
        name: 'worker',
        team_name: 'email/supervisor',
      },
      makeToolUseContext({ teamName: 'email' }),
    ),
  )
  expect(
    (spawnTeammate.mock.calls[0]![0] as SpawnTeammateConfig).team_name,
  ).toBe('email/supervisor')

  await expect(
    asTeammate('supervisor', 'email', () =>
      spawn(
        AgentTool,
        { description: 'worker', name: 'worker', team_name: 'email' },
        makeToolUseContext({ teamName: 'email' }),
      ),
    ),
  ).rejects.toThrow(
    'Teammates can only spawn into their own sub-team "email/supervisor", not "email"',
  )
  expect(spawnTeammate).toHaveBeenCalledTimes(1)
})

test('a teammate without a sub-team still gets the flat-roster error, now naming the sub-team to create', async () => {
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  const err = await asTeammate('supervisor', 'email', () =>
    spawn(
      AgentTool,
      { description: 'worker', name: 'worker' },
      makeToolUseContext({ teamName: 'email' }),
    ),
  ).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(String(err)).toContain('the team roster is flat')
  // The teammate CAN lead a sub-team; the error must say how, with the exact
  // name TeamCreate accepts from this caller, instead of leaving the model to
  // guess a team_name that the guard below refuses anyway.
  expect(String(err)).toContain('TeamCreate(team_name: "email/supervisor")')
  expect(spawnTeammate).not.toHaveBeenCalled()
})

test('a subagent inside a teammate turn still gets the flat-roster error', async () => {
  await writeSubTeam()
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  // Ambient isTeammate() is true for this caller; resolveCallerIdentity() is
  // what tells it apart from the teammate whose turn it runs in.
  const err = await asTeammate('supervisor', 'email', () =>
    spawn(
      AgentTool,
      { description: 'worker', name: 'worker' },
      makeToolUseContext({ teamName: 'email', agentId: SUBAGENT_ID }),
    ),
  ).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(String(err)).toContain('the team roster is flat')
  // A subagent cannot lead a sub-team, so it gets no TeamCreate guidance.
  expect(String(err)).not.toContain('TeamCreate(')
  expect(spawnTeammate).not.toHaveBeenCalled()
})

test('the background-agent guard is unchanged for a sub-team leader', async () => {
  await writeSubTeam()
  const { AgentTool, spawnTeammate } = await importAgentToolWithSpawnMock()

  await expect(
    asTeammate('supervisor', 'email', () =>
      spawn(
        AgentTool,
        {
          description: 'worker',
          prompt: 'do the thing',
          name: 'worker',
          run_in_background: true,
        },
        makeToolUseContext({ teamName: 'email' }),
      ),
    ),
  ).rejects.toThrow('In-process teammates cannot spawn background agents')
  expect(spawnTeammate).not.toHaveBeenCalled()
})
