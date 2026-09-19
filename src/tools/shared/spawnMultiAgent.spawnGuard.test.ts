import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { TEAMMATE_COMMAND_ENV_VAR } from '../../utils/swarm/constants.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'

type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')
type ConfigModule = typeof import('../../utils/config.js')
type ProvidersModule = typeof import('../../utils/model/providers.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')
type TeammateLayoutManagerModule = typeof import(
  '../../utils/swarm/teammateLayoutManager.js'
)
type TeamHelpersModule = typeof import('../../utils/swarm/teamHelpers.js')
type TeammateMailboxModule = typeof import('../../utils/teammateMailbox.js')
type RegistryModule = typeof import('../../utils/swarm/backends/registry.js')
type PaneWatchdogModule = typeof import(
  '../../utils/swarm/backends/paneTeammateWatchdog.js'
)
type TaskFrameworkModule = typeof import('../../utils/task/framework.js')
type ExecFileModule = typeof import('../../utils/execFileNoThrow.js')

const SENTINEL_BINARY = '/opt/sentinel-openclaude-binary'

/** The saved profile at the center of the acceptance incident: Codex, OAuth
 * (no apiKey), explicitly listing gpt-5.6-sol. findProviderProfileRouteForModel
 * skips it at its `!apiKey` guard, which is exactly the hole this suite pins. */
const CODEX_OAUTH_PROFILE = {
  id: 'codex-oauth',
  name: 'Codex OAuth',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'gpt-5.6-sol, gpt-5.6-terra',
}

/** An API-key profile that DOES route: the guard must never fire for a model
 * this serves. */
const ZAI_APIKEY_PROFILE = {
  id: 'zai-key',
  name: 'Z.AI',
  provider: 'openai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  model: 'glm-5.3',
  apiKey: 'test-key-abc123',
}

/** Codex/OAuth provider env as resolveProviderProfileEnv emits it (phase-2
 * path): a spawn carrying this bypasses the guard entirely. */
const CODEX_PROVIDER_ENV: Record<string, string> = {
  OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  OPENAI_MODEL: 'codexplan',
  CODEX_CREDENTIAL_SOURCE: 'oauth',
  CHATGPT_ACCOUNT_ID: 'a'.repeat(36),
  CLAUDE_CODE_USE_OPENAI: '1',
}

let actualConfig: ConfigModule | undefined
let actualProviders: ProvidersModule | undefined
let actualSettings: SettingsModule | undefined
let actualLayoutManager: TeammateLayoutManagerModule | undefined
let actualTeamHelpers: TeamHelpersModule | undefined
let actualMailbox: TeammateMailboxModule | undefined
let actualRegistry: RegistryModule | undefined
let actualPaneWatchdog: PaneWatchdogModule | undefined
let actualTaskFramework: TaskFrameworkModule | undefined
let actualExecFile: ExecFileModule | undefined

let capturedCommands: string[] = []
let registerTaskCalls: number = 0

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/shared/spawnMultiAgent.spawnGuard.test.ts',
  )
  process.env[TEAMMATE_COMMAND_ENV_VAR] = SENTINEL_BINARY
  capturedCommands = []
  registerTaskCalls = 0
})

afterEach(() => {
  try {
    delete process.env[TEAMMATE_COMMAND_ENV_VAR]
    mock.restore()
    if (actualConfig) {
      mock.module('../../utils/config.js', () => ({ ...actualConfig! }))
    }
    if (actualProviders) {
      mock.module('../../utils/model/providers.js', () => ({
        ...actualProviders!,
      }))
    }
    if (actualSettings) {
      mock.module('../../utils/settings/settings.js', () => ({
        ...actualSettings!,
      }))
    }
    if (actualLayoutManager) {
      mock.module(
        '../../utils/swarm/teammateLayoutManager.js',
        () => ({ ...actualLayoutManager! }),
      )
    }
    if (actualTeamHelpers) {
      mock.module('../../utils/swarm/teamHelpers.js', () => ({
        ...actualTeamHelpers!,
      }))
    }
    if (actualMailbox) {
      mock.module('../../utils/teammateMailbox.js', () => ({
        ...actualMailbox!,
      }))
    }
    if (actualRegistry) {
      mock.module('../../utils/swarm/backends/registry.js', () => ({
        ...actualRegistry!,
      }))
    }
    if (actualPaneWatchdog) {
      mock.module('../../utils/swarm/backends/paneTeammateWatchdog.js', () => ({
        ...actualPaneWatchdog!,
      }))
    }
    if (actualTaskFramework) {
      mock.module('../../utils/task/framework.js', () => ({
        ...actualTaskFramework!,
      }))
    }
    if (actualExecFile) {
      mock.module('../../utils/execFileNoThrow.js', () => ({
        ...actualExecFile!,
      }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importSpawnMultiAgentWithMocks(options: {
  provider?: string
  profiles?: unknown[]
  agentModels?: Record<string, unknown>
}): Promise<SpawnMultiAgentModule> {
  const nonce = `${Date.now()}-${Math.random()}`
  actualConfig ??= await import(
    `../../utils/config.ts?spawnGuardActual=${nonce}`
  )
  actualProviders ??= await import(
    `../../utils/model/providers.ts?spawnGuardActual=${nonce}`
  )
  actualSettings ??= await import(
    `../../utils/settings/settings.ts?spawnGuardActual=${nonce}`
  )
  actualLayoutManager ??= await import(
    `../../utils/swarm/teammateLayoutManager.ts?spawnGuardActual=${nonce}`
  )
  actualTeamHelpers ??= await import(
    `../../utils/swarm/teamHelpers.ts?spawnGuardActual=${nonce}`
  )
  actualMailbox ??= await import(
    `../../utils/teammateMailbox.ts?spawnGuardActual=${nonce}`
  )
  actualRegistry ??= await import(
    `../../utils/swarm/backends/registry.ts?spawnGuardActual=${nonce}`
  )
  actualPaneWatchdog ??= await import(
    `../../utils/swarm/backends/paneTeammateWatchdog.ts?spawnGuardActual=${nonce}`
  )
  actualTaskFramework ??= await import(
    `../../utils/task/framework.ts?spawnGuardActual=${nonce}`
  )
  actualExecFile ??= await import(
    `../../utils/execFileNoThrow.ts?spawnGuardActual=${nonce}`
  )

  const provider = options.provider ?? 'firstParty'
  const teamFiles = new Map<string, TeamFile>()

  mock.module('../../utils/config.js', () => ({
    ...actualConfig!,
    getGlobalConfig: () =>
      ({
        providerProfiles: options.profiles ?? [CODEX_OAUTH_PROFILE],
      }) as unknown as ReturnType<ConfigModule['getGlobalConfig']>,
  }))
  mock.module('../../utils/model/providers.js', () => ({
    ...actualProviders!,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => provider === 'firstParty',
    isFirstPartyAnthropicProvider: () => provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettings!,
    getInitialSettings: () =>
      ({
        ...(options.agentModels ? { agentModels: options.agentModels } : {}),
      }) as unknown as ReturnType<SettingsModule['getInitialSettings']>,
  }))
  mock.module('../../utils/swarm/teammateLayoutManager.js', () => ({
    ...actualLayoutManager!,
    isInsideTmux: async () => false,
    createTeammatePaneInSwarmView: async () => ({
      paneId: '%1',
      isFirstTeammate: false,
    }),
    enablePaneBorderStatus: async () => {},
    sendCommandToPane: async (
      _paneId: string,
      command: string,
      _useSocket: boolean,
    ) => {
      capturedCommands.push(command)
    },
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
  mock.module('../../utils/teammateMailbox.js', () => ({
    ...actualMailbox!,
    writeToMailbox: async () => {},
  }))
  mock.module('../../utils/swarm/backends/registry.js', () => ({
    ...actualRegistry!,
    detectAndGetBackend: async () => ({
      backend: { type: 'tmux' },
      needsIt2Setup: false,
    }),
    isInProcessEnabled: () => false,
  }))
  mock.module('../../utils/swarm/backends/paneTeammateWatchdog.js', () => ({
    ...actualPaneWatchdog!,
    armPaneTeammateWatchdog: () => ({ scan: async () => {}, dispose: () => {} }),
  }))
  mock.module('../../utils/task/framework.js', () => ({
    ...actualTaskFramework!,
    registerTask: () => {
      registerTaskCalls++
    },
  }))
  mock.module('../../utils/execFileNoThrow.js', () => ({
    ...actualExecFile!,
    execFileNoThrow: async (
      _command: string,
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args[0] === 'send-keys') {
        const candidate = args[3]
        if (typeof candidate === 'string' && candidate.includes(' && env ')) {
          capturedCommands.push(candidate)
        }
      }
      return { code: 0, stdout: args[0] === 'new-window' ? '%42' : '', stderr: '' }
    },
  }))

  return import(`./spawnMultiAgent.ts?spawnGuard=${nonce}`)
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

test('guard fires: model-only spawn of a model an OAuth codex profile lists is refused before any pane or task exists', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({})

  const promise = spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-probe',
      prompt: 'smoke test',
      team_name: 'codex-team',
      model: 'gpt-5.6-sol',
    },
    makeToolUseContext(),
  )

  await expect(promise).rejects.toThrow(
    "Model 'gpt-5.6-sol' is served by provider profile 'Codex OAuth' (OAuth), which model-only routing cannot use — OAuth profiles have no API key to route with. Bind it explicitly with provider_profile, or configure agentModels routing to an API-key provider. On this session's provider the model would 404 on its first request.",
  )
  // Loud AND early: no pane command sent, no task row registered.
  expect(capturedCommands).toHaveLength(0)
  expect(registerTaskCalls).toBe(0)
})

test('guard silent: a Claude-family model spawns untouched', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({})

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'claude-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      model: 'claude-opus-5',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(registerTaskCalls).toBe(1)
})

test('guard silent: a non-first-party session spawns the model untouched', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    provider: 'openai',
  })

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-probe',
      prompt: 'smoke test',
      team_name: 'codex-team',
      model: 'gpt-5.6-sol',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
})

test('guard silent: a model with a valid API-key profile route spawns untouched', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    profiles: [ZAI_APIKEY_PROFILE, CODEX_OAUTH_PROFILE],
  })

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'glm-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      model: 'glm-5.3',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
})

test('guard silent: a spawn carrying providerEnv (provider_profile) bypasses entirely', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({})

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-probe',
      prompt: 'smoke test',
      team_name: 'codex-team',
      model: 'gpt-5.6-sol',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
})

test('guard silent: an agentModels entry for the model spawns untouched', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    agentModels: {
      'gpt-5.6-sol': {
        model: 'gpt-5.6-sol',
        baseURL: 'https://gw.example.test/v1',
        apiKey: 'sk-gw-test',
      },
    },
  })

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-probe',
      prompt: 'smoke test',
      team_name: 'codex-team',
      model: 'gpt-5.6-sol',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
})

test('guard fires for the separate-window spawn path too', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({})

  const promise = spawnMultiAgent.handleSpawnSeparateWindow(
    {
      name: 'codex-probe',
      prompt: 'smoke test',
      team_name: 'codex-team',
      model: 'gpt-5.6-sol',
    },
    makeToolUseContext(),
  )

  await expect(promise).rejects.toThrow('provider profile')
  expect(capturedCommands).toHaveLength(0)
  expect(registerTaskCalls).toBe(0)
})
