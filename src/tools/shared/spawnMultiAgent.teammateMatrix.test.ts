/**
 * The teammate model matrix at the spawn choke point (handleSpawn →
 * assertTeammateModelAllowed): every backend, the inherit-leader exception,
 * the Codex route, the `*` escape hatch, broken agentRouting, and a clean
 * refusal that leaves no pane, task or team-file member behind.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { useHermeticEnv } from '../../test/hermeticEnv.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { TEAMMATE_COMMAND_ENV_VAR } from '../../utils/swarm/constants.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import { PROVIDER_PROFILE_IN_PROCESS_ERROR } from '../AgentTool/providerProfileBinding.js'

// The route is read from the inherited process env; an ambient shell with
// OPENAI_*/CLAUDE_CODE_USE_* must not decide what these tests assert.
useHermeticEnv({ scrubProviderEnv: true })

type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')

const MODULES = {
  config: '../../utils/config.js',
  settings: '../../utils/settings/settings.js',
  layout: '../../utils/swarm/teammateLayoutManager.js',
  teamHelpers: '../../utils/swarm/teamHelpers.js',
  mailbox: '../../utils/teammateMailbox.js',
  registry: '../../utils/swarm/backends/registry.js',
  watchdog: '../../utils/swarm/backends/paneTeammateWatchdog.js',
  framework: '../../utils/task/framework.js',
  execFile: '../../utils/execFileNoThrow.js',
  spawnInProcess: '../../utils/swarm/spawnInProcess.js',
  inProcessRunner: '../../utils/swarm/inProcessRunner.js',
} as const
type ModuleKey = keyof typeof MODULES
const actual: Partial<Record<ModuleKey, Record<string, unknown>>> = {}

const CODEX_OAUTH_PROFILE = {
  id: 'codex-oauth',
  name: 'Codex OAuth',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'gpt-6-astra',
}

let paneCommands: string[] = []
let registerTaskCalls = 0
let teamFiles = new Map<string, TeamFile>()
let inProcessSpawns = 0

beforeEach(async () => {
  await acquireSharedMutationLock('tools/shared/spawnMultiAgent.teammateMatrix.test.ts')
  process.env[TEAMMATE_COMMAND_ENV_VAR] = '/opt/sentinel-openclaude-binary'
  paneCommands = []
  registerTaskCalls = 0
  teamFiles = new Map()
  inProcessSpawns = 0
})

afterEach(() => {
  try {
    delete process.env[TEAMMATE_COMMAND_ENV_VAR]
    mock.restore()
    for (const key of Object.keys(actual) as ModuleKey[]) {
      const real = actual[key]!
      mock.module(MODULES[key], () => ({ ...real }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function load(options: {
  settings?: Record<string, unknown>
  inProcess?: boolean
}): Promise<SpawnMultiAgentModule> {
  const nonce = `${Date.now()}-${Math.random()}`
  for (const key of Object.keys(MODULES) as ModuleKey[]) {
    actual[key] ??= await import(
      `${MODULES[key].replace(/\.js$/, '.ts')}?teammateMatrixActual=${nonce}`
    )
  }
  const real = actual as Required<typeof actual>

  mock.module(MODULES.config, () => ({
    ...real.config,
    getGlobalConfig: () => ({ providerProfiles: [CODEX_OAUTH_PROFILE] }),
  }))
  mock.module(MODULES.settings, () => ({
    ...real.settings,
    getInitialSettings: () => options.settings ?? {},
  }))
  mock.module(MODULES.layout, () => ({
    ...real.layout,
    isInsideTmux: async () => false,
    createTeammatePaneInSwarmView: async () => ({ paneId: '%1', isFirstTeammate: false }),
    enablePaneBorderStatus: async () => {},
    sendCommandToPane: async (_pane: string, command: string) => {
      paneCommands.push(command)
    },
  }))
  mock.module(MODULES.teamHelpers, () => ({
    ...real.teamHelpers,
    readTeamFileAsync: async (team: string) => teamFiles.get(team) ?? null,
    writeTeamFileAsync: async (team: string, file: TeamFile) => {
      teamFiles.set(team, file)
    },
    registerTeamForSessionCleanup: () => {},
  }))
  mock.module(MODULES.mailbox, () => ({ ...real.mailbox, writeToMailbox: async () => {} }))
  mock.module(MODULES.registry, () => ({
    ...real.registry,
    detectAndGetBackend: async () => ({ backend: { type: 'tmux' }, needsIt2Setup: false }),
    isInProcessEnabled: () => options.inProcess ?? false,
  }))
  mock.module(MODULES.watchdog, () => ({
    ...real.watchdog,
    armPaneTeammateWatchdog: () => ({ scan: async () => {}, dispose: () => {} }),
  }))
  mock.module(MODULES.framework, () => ({
    ...real.framework,
    registerTask: () => {
      registerTaskCalls++
    },
  }))
  mock.module(MODULES.execFile, () => ({
    ...real.execFile,
    execFileNoThrow: async (_cmd: string, args: string[]) => {
      if (args[0] === 'send-keys' && String(args[3]).includes(' && env ')) {
        paneCommands.push(String(args[3]))
      }
      return { code: 0, stdout: args[0] === 'new-window' ? '%42' : '', stderr: '' }
    },
  }))
  mock.module(MODULES.spawnInProcess, () => ({
    ...real.spawnInProcess,
    spawnInProcessTeammate: async (config: { name: string; teamName: string }) => {
      inProcessSpawns++
      return {
        success: true,
        agentId: `${config.name}@${config.teamName}`,
        taskId: 'task-1',
        abortController: new AbortController(),
        teammateContext: { parentSessionId: 'parent-session' },
      }
    },
  }))
  mock.module(MODULES.inProcessRunner, () => ({
    ...real.inProcessRunner,
    startInProcessTeammate: () => {},
  }))
  return import(`./spawnMultiAgent.ts?teammateMatrix=${nonce}`)
}

function context(leaderModel = 'claude-opus-5-5'): ToolUseContext {
  let state: AppState = { ...getDefaultAppState(), mainLoopModel: leaderModel }
  return {
    options: {
      tools: [],
      mainLoopModel: leaderModel,
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

/** Nothing exists after a refusal: no pane command, task, in-process
 * teammate or team-file member. */
function expectNothingLeftBehind(team: string): void {
  expect(paneCommands).toHaveLength(0)
  expect(registerTaskCalls).toBe(0)
  expect(inProcessSpawns).toBe(0)
  expect(teamFiles.get(team)?.members ?? []).toHaveLength(0)
}

const DEEPSEEK_ENV = {
  CLAUDE_CODE_USE_OPENAI: '1',
  OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
}

for (const backend of ['in-process', 'split pane', 'separate window'] as const) {
  const spawnOptions = {
    inProcess: backend === 'in-process',
    use_splitpane: backend !== 'separate window',
  }

  test(`${backend}: a bogus model is refused cleanly`, async () => {
    Object.assign(process.env, DEEPSEEK_ENV)
    const spawnMultiAgent = await load({ inProcess: spawnOptions.inProcess })
    await expect(
      spawnMultiAgent.spawnTeammate(
        {
          name: 'bogus',
          prompt: 'work',
          team_name: 'matrix-team',
          use_splitpane: spawnOptions.use_splitpane,
          model: 'gpt-99-fake',
        },
        context(),
      ),
    ).rejects.toThrow(
      "Model 'gpt-99-fake' is not allowed for teammates on provider 'deepseek'. Allowed here: deepseek-v4-pro, deepseek-flash. Configure teammateModelAllowlist to change this.",
    )
    expectNothingLeftBehind('matrix-team')
  })

  test(`${backend}: a valid (route, model) pair spawns`, async () => {
    Object.assign(process.env, DEEPSEEK_ENV)
    const spawnMultiAgent = await load({ inProcess: spawnOptions.inProcess })
    const result = await spawnMultiAgent.spawnTeammate(
      {
        name: 'pro',
        prompt: 'work',
        team_name: 'matrix-team',
        use_splitpane: spawnOptions.use_splitpane,
        model: 'deepseek-v4-pro',
      },
      context(),
    )
    expect(result.data.name).toBe('pro')
    if (backend === 'in-process') expect(inProcessSpawns).toBe(1)
    else expect(paneCommands).toHaveLength(1)
  })
}

test('a valid model on the wrong provider is refused: deepseek-v4-pro on first-party Anthropic', async () => {
  const spawnMultiAgent = await load({})
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'wrong', prompt: 'work', team_name: 'matrix-team', model: 'deepseek-v4-pro' },
      context(),
    ),
  ).rejects.toThrow(
    "Model 'deepseek-v4-pro' is not allowed for teammates on provider 'anthropic'. Allowed here: claude-opus-5-5, claude-fable-5-1. Configure teammateModelAllowlist to change this.",
  )
  expectNothingLeftBehind('matrix-team')
})

test('an alias is judged by what it resolves to, and the error names both', async () => {
  const spawnMultiAgent = await load({})
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'plan', prompt: 'work', team_name: 'matrix-team', model: 'codexplan' },
      context(),
    ),
  ).rejects.toThrow(
    "Model 'codexplan' (resolves to 'gpt-5.6-sol') is not allowed for teammates on provider 'anthropic'.",
  )
})

test('inherit-leader exception: no model on the leader\'s own non-matrix model/provider spawns', async () => {
  // A custom local leader the matrix has never heard of. The teammate runs
  // exactly that pair, which the leader proves works.
  Object.assign(process.env, {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'http://localhost:1234/v1',
  })
  const spawnMultiAgent = await load({})
  await spawnMultiAgent.spawnTeammate(
    { name: 'follower', prompt: 'work', team_name: 'matrix-team' },
    context('my-local-model'),
  )
  expect(paneCommands).toHaveLength(1)
})

test("inherit-leader exception covers model 'inherit' and an explicit copy of the leader's model", async () => {
  const spawnMultiAgent = await load({})
  for (const model of ['inherit', 'test-leader-custom']) {
    await spawnMultiAgent.spawnTeammate(
      { name: `f-${model}`, prompt: 'work', team_name: 'matrix-team', model },
      context('test-leader-custom'),
    )
  }
  expect(paneCommands).toHaveLength(2)
})

const CODEX_ENV = {
  CLAUDE_CODE_USE_OPENAI: '1',
  OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
}

// AgentTool hands the spawn `getAgentModel(...)`, which for 'inherit' (tool
// argument or agent frontmatter) and for the non-native sonnet/haiku fallback
// is the parent's RAW mainLoopModel setting — an alias when the leader's model
// is one. getLeaderModel() is parsed, so the exception has to compare resolved
// ids on both sides.
test("inherit-leader exception with an ALIAS leader: Codex 'codexplan' + inherit, explicit alias, and the AgentTool paths", async () => {
  Object.assign(process.env, CODEX_ENV)
  const { getAgentModel } = await import('../../utils/model/agent.js')
  const spawnMultiAgent = await load({})
  const models = {
    // Tool argument model: 'inherit' as AgentTool passes it on.
    'tool-inherit': getAgentModel(undefined, 'codexplan', 'inherit'),
    // Custom agent frontmatter `model: inherit`.
    'frontmatter-inherit': getAgentModel('inherit', 'codexplan'),
    // Custom agent `model: sonnet` falling back to the parent on a
    // non-Claude-native provider.
    'frontmatter-sonnet': getAgentModel('sonnet', 'codexplan'),
    // The literal alias values that reach spawnTeammate.
    'raw-inherit': 'inherit',
    'explicit-alias': 'codexplan',
  }
  for (const [name, model] of Object.entries(models)) {
    await spawnMultiAgent.spawnTeammate(
      { name, prompt: 'work', team_name: 'matrix-team', model },
      context('codexplan'),
    )
  }
  expect(paneCommands).toHaveLength(Object.keys(models).length)
})

test("inherit-leader exception with an ALIAS leader: first-party 'sonnet' + inherit / explicit 'sonnet'", async () => {
  const { getAgentModel } = await import('../../utils/model/agent.js')
  const spawnMultiAgent = await load({})
  const models = [
    getAgentModel(undefined, 'sonnet', 'inherit'),
    getAgentModel('inherit', 'sonnet'),
    'inherit',
    'sonnet',
  ]
  for (const [i, model] of models.entries()) {
    await spawnMultiAgent.spawnTeammate(
      { name: `s-${i}`, prompt: 'work', team_name: 'matrix-team', model },
      context('sonnet'),
    )
  }
  expect(paneCommands).toHaveLength(models.length)
})

test("the leader's resolved id bound to a different profile is still judged by the matrix", async () => {
  // Leader runs 'codexplan' (→ gpt-5.6-sol) on the Codex env route; a teammate
  // bound to a provider profile running the same resolved id is a different
  // (route, profile) pair and gets no exemption.
  Object.assign(process.env, CODEX_ENV)
  const spawnMultiAgent = await load({})
  await expect(
    spawnMultiAgent.spawnTeammate(
      {
        name: 'bound-same-id',
        prompt: 'work',
        team_name: 'matrix-team',
        providerEnv: {
          OPENCLAUDE_TEAMMATE_PROFILE_ID: 'codex-oauth',
          OPENCLAUDE_TEAMMATE_MODEL: 'gpt-5.6-sol',
        },
      },
      context('codexplan'),
    ),
  ).rejects.toThrow(
    "Model 'gpt-5.6-sol' is not allowed for teammates on provider 'codex'.",
  )
  expectNothingLeftBehind('matrix-team')
})

test('the exception does not extend to a different model on the leader\'s provider', async () => {
  const spawnMultiAgent = await load({})
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'other', prompt: 'work', team_name: 'matrix-team', model: 'gpt-99-fake' },
      context('test-leader-custom'),
    ),
  ).rejects.toThrow("on provider 'anthropic'")
  expectNothingLeftBehind('matrix-team')
})

test('Codex route: a Codex base URL puts gpt-6-astra on codex, and codexplan is refused there', async () => {
  Object.assign(process.env, {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  })
  const spawnMultiAgent = await load({})
  await spawnMultiAgent.spawnTeammate(
    { name: 'astra', prompt: 'work', team_name: 'matrix-team', model: 'gpt-6-astra' },
    context(),
  )
  expect(paneCommands).toHaveLength(1)
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'plan', prompt: 'work', team_name: 'matrix-team', model: 'codexplan' },
      context(),
    ),
  ).rejects.toThrow(
    "Model 'codexplan' (resolves to 'gpt-5.6-sol') is not allowed for teammates on provider 'codex'. Allowed here: gpt-6-astra.",
  )
})

test('Codex route via a provider_profile binding', async () => {
  const spawnMultiAgent = await load({})
  const providerEnv = {
    OPENCLAUDE_TEAMMATE_PROFILE_ID: 'codex-oauth',
    OPENCLAUDE_TEAMMATE_MODEL: 'gpt-6-astra',
  }
  await spawnMultiAgent.spawnTeammate(
    { name: 'bound', prompt: 'work', team_name: 'matrix-team', providerEnv },
    context(),
  )
  expect(paneCommands).toHaveLength(1)
  await expect(
    spawnMultiAgent.spawnTeammate(
      {
        name: 'bound-bogus',
        prompt: 'work',
        team_name: 'matrix-team',
        providerEnv: { ...providerEnv, OPENCLAUDE_TEAMMATE_MODEL: 'gpt-99-fake' },
      },
      context(),
    ),
  ).rejects.toThrow("on provider 'codex'")
})

test('an agentModels cross-provider route is judged on the route\'s provider', async () => {
  const settings = {
    agentModels: {
      ds: { model: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
    },
  }
  const spawnMultiAgent = await load({ settings })
  // First-party leader: the route, not the leader's env, decides.
  await spawnMultiAgent.spawnTeammate(
    { name: 'routed', prompt: 'work', team_name: 'matrix-team', model: 'ds' },
    context(),
  )
  expect(paneCommands).toHaveLength(1)
})

test('"*" in teammateModelAllowlist disables the check', async () => {
  const spawnMultiAgent = await load({ settings: { teammateModelAllowlist: ['*'] } })
  await spawnMultiAgent.spawnTeammate(
    { name: 'anything', prompt: 'work', team_name: 'matrix-team', model: 'gpt-99-fake' },
    context(),
  )
  expect(paneCommands).toHaveLength(1)
})

test('a custom allowlist narrows the matrix', async () => {
  const spawnMultiAgent = await load({
    settings: { teammateModelAllowlist: ['fable-5.1'] },
  })
  await spawnMultiAgent.spawnTeammate(
    { name: 'fable', prompt: 'work', team_name: 'matrix-team', model: 'claude-fable-5-1' },
    context(),
  )
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'opus', prompt: 'work', team_name: 'matrix-team', model: 'claude-opus-5-5' },
      context('some-other-leader'),
    ),
  ).rejects.toThrow('Allowed here: claude-fable-5-1.')
})

test('a broken agentRouting key refuses the spawn cleanly, naming key and entry', async () => {
  const spawnMultiAgent = await load({
    settings: { agentRouting: { reviewer: 'gone' }, agentModels: {} },
  })
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'reviewer', prompt: 'work', team_name: 'matrix-team' },
      context(),
    ),
  ).rejects.toThrow(
    'agentRouting key "reviewer" points to agentModels entry "gone", which does not exist.',
  )
  expectNothingLeftBehind('matrix-team')
})

// An explicit `model` naming a half-configured agentModels entry used to warn,
// skip the route, and spawn the raw key on the LEADER's provider — with ['*']
// straight through to a first-request failure, and on a matching route
// silently on the leader's credentials. It now refuses like a routing key.
for (const backend of ['in-process', 'split pane', 'separate window'] as const) {
  for (const allowlist of [undefined, ['*']]) {
    test(`${backend}${allowlist ? ' with ["*"]' : ''}: an explicit model equal to a half-configured agentModels key is refused`, async () => {
      const spawnMultiAgent = await load({
        inProcess: backend === 'in-process',
        settings: {
          agentModels: { half: { api_key: 'sk-only' } },
          ...(allowlist ? { teammateModelAllowlist: allowlist } : {}),
        },
      })
      await expect(
        spawnMultiAgent.spawnTeammate(
          {
            name: 'half',
            prompt: 'work',
            team_name: 'matrix-team',
            use_splitpane: backend !== 'separate window',
            model: 'half',
          },
          context(),
        ),
      ).rejects.toThrow(
        'agentModels entry "half" has only one of base_url/api_key; both are required for cross-provider routing.',
      )
      expectNothingLeftBehind('matrix-team')
    })
  }
}

test('a deepseek-route leader: an api_key-only `deepseek-v4-pro` entry is refused, not run on the leader credentials', async () => {
  Object.assign(process.env, DEEPSEEK_ENV)
  const spawnMultiAgent = await load({
    settings: { agentModels: { 'deepseek-v4-pro': { api_key: 'sk-other' } } },
  })
  await expect(
    spawnMultiAgent.spawnTeammate(
      { name: 'ds', prompt: 'work', team_name: 'matrix-team', model: 'deepseek-v4-pro' },
      context('deepseek-v4-pro'),
    ),
  ).rejects.toThrow('agentModels entry "deepseek-v4-pro" has only one of base_url/api_key')
  expectNothingLeftBehind('matrix-team')
})

test('the in-process provider_profile error wins over the model check', async () => {
  const spawnMultiAgent = await load({ inProcess: true })
  await expect(
    spawnMultiAgent.spawnTeammate(
      {
        name: 'bound',
        prompt: 'work',
        team_name: 'matrix-team',
        providerEnv: {
          OPENCLAUDE_TEAMMATE_PROFILE_ID: 'codex-oauth',
          OPENCLAUDE_TEAMMATE_MODEL: 'gpt-99-fake',
        },
      },
      context(),
    ),
  ).rejects.toThrow(PROVIDER_PROFILE_IN_PROCESS_ERROR)
  expectNothingLeftBehind('matrix-team')
})
