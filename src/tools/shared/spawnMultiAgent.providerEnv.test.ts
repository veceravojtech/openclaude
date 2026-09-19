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
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { PROVIDER_PROFILE_IN_PROCESS_ERROR } from '../AgentTool/providerProfileBinding.js'

type SpawnMultiAgentModule = typeof import('./spawnMultiAgent.js')
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
type BootstrapStateModule = typeof import('../../bootstrap/state.js')
type ModelModule = typeof import('../../utils/model/model.js')

const SENTINEL_BINARY = '/opt/sentinel-openclaude-binary'

/** Codex/OAuth provider env as resolveProviderProfileEnv emits it. Contains
 * no credential material — CHATGPT_ACCOUNT_ID is a shape-only fixture. */
const CODEX_PROVIDER_ENV: Record<string, string> = {
  OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  OPENAI_MODEL: 'codexplan',
  CODEX_CREDENTIAL_SOURCE: 'oauth',
  CHATGPT_ACCOUNT_ID: 'a'.repeat(36),
  CLAUDE_CODE_USE_OPENAI: '1',
}

let actualLayoutManager: TeammateLayoutManagerModule | undefined
let actualTeamHelpers: TeamHelpersModule | undefined
let actualMailbox: TeammateMailboxModule | undefined
let actualRegistry: RegistryModule | undefined
let actualPaneWatchdog: PaneWatchdogModule | undefined
let actualTaskFramework: TaskFrameworkModule | undefined
let actualExecFile: ExecFileModule | undefined
let actualBootstrapState: BootstrapStateModule | undefined
let actualModelModule: ModelModule | undefined

/** Commands captured from every send path (pane + tmux send-keys). */
let capturedCommands: string[] = []

beforeEach(async () => {
  await acquireSharedMutationLock('tools/shared/spawnMultiAgent.providerEnv.test.ts')
  process.env[TEAMMATE_COMMAND_ENV_VAR] = SENTINEL_BINARY
  capturedCommands = []
})

afterEach(() => {
  try {
    delete process.env[TEAMMATE_COMMAND_ENV_VAR]
    mock.restore()
    if (actualLayoutManager) {
      mock.module(
        '../../utils/swarm/teammateLayoutManager.js',
        () => ({ ...actualLayoutManager! }),
      )
    }
    if (actualTeamHelpers) {
      mock.module(
        '../../utils/swarm/teamHelpers.js',
        () => ({ ...actualTeamHelpers! }),
      )
    }
    if (actualMailbox) {
      mock.module('../../utils/teammateMailbox.js', () => ({ ...actualMailbox! }))
    }
    if (actualRegistry) {
      mock.module(
        '../../utils/swarm/backends/registry.js',
        () => ({ ...actualRegistry! }),
      )
    }
    if (actualPaneWatchdog) {
      mock.module(
        '../../utils/swarm/backends/paneTeammateWatchdog.js',
        () => ({ ...actualPaneWatchdog! }),
      )
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
    if (actualBootstrapState) {
      mock.module('../../bootstrap/state.js', () => ({
        ...actualBootstrapState!,
      }))
    }
    if (actualModelModule) {
      mock.module('../../utils/model/model.js', () => ({
        ...actualModelModule!,
      }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importSpawnMultiAgentWithMocks(options?: {
  inProcessEnabled?: boolean
  /** Value for getMainLoopModelOverride, i.e. the leader's own CLI --model,
   *  which buildInheritedCliFlags propagates into every teammate's flags. */
  mainLoopModelOverride?: string
  /** Alias table for parseUserSpecifiedModel. Stubbed rather than relying on
   *  the real one because alias resolution reads global model/settings state
   *  that other suites in a full run legitimately mutate — `opus` resolved to
   *  `claude-opus-5` alone and to something else in the sweep. The guard's
   *  contract is "normalise, then judge", so the table is the part worth
   *  pinning; the resolver's own behaviour is model.ts's to test. */
  modelAliases?: Record<string, string>
}): Promise<SpawnMultiAgentModule> {
  if (options?.modelAliases) {
    actualModelModule ??= await import(
      `../../utils/model/model.ts?providerEnvActual=${Date.now()}-${Math.random()}`
    )
    const aliases = options.modelAliases
    mock.module('../../utils/model/model.js', () => ({
      ...actualModelModule!,
      parseUserSpecifiedModel: (model: string) =>
        aliases[model] ?? actualModelModule!.parseUserSpecifiedModel(model),
    }))
  }

  actualBootstrapState ??= await import(
    `../../bootstrap/state.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  // Full export shape preserved via spread: in bun a mocked module's shape is
  // frozen at first registration process-wide, so a partial stub would break
  // every later importer of bootstrap/state.
  mock.module('../../bootstrap/state.js', () => ({
    ...actualBootstrapState!,
    getMainLoopModelOverride: () => options?.mainLoopModelOverride,
  }))

  actualLayoutManager ??= await import(
    `../../utils/swarm/teammateLayoutManager.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualTeamHelpers ??= await import(
    `../../utils/swarm/teamHelpers.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualMailbox ??= await import(
    `../../utils/teammateMailbox.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualRegistry ??= await import(
    `../../utils/swarm/backends/registry.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualPaneWatchdog ??= await import(
    `../../utils/swarm/backends/paneTeammateWatchdog.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualTaskFramework ??= await import(
    `../../utils/task/framework.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )
  actualExecFile ??= await import(
    `../../utils/execFileNoThrow.ts?providerEnvActual=${Date.now()}-${Math.random()}`
  )

  const teamFiles = new Map<string, TeamFile>()

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
    isInProcessEnabled: () => options?.inProcessEnabled ?? false,
  }))

  mock.module('../../utils/swarm/backends/paneTeammateWatchdog.js', () => ({
    ...actualPaneWatchdog!,
    armPaneTeammateWatchdog: () => () => {},
  }))

  mock.module('../../utils/task/framework.js', () => ({
    ...actualTaskFramework!,
    registerTask: () => {},
  }))

  // tmux CLI adapter: has-session/new-window succeed, send-keys captured.
  mock.module('../../utils/execFileNoThrow.js', () => ({
    ...actualExecFile!,
    execFileNoThrow: async (
      command: string,
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args[0] === 'send-keys') {
        // send-keys args: ['send-keys', '-t', target, command, 'Enter']
        // Only the spawn command itself starts with `cd ... && env ...`.
        const candidate = args[3]
        if (typeof candidate === 'string' && candidate.includes(' && env ')) {
          capturedCommands.push(candidate)
        }
      }
      return { code: 0, stdout: args[0] === 'new-window' ? '%42' : '', stderr: '' }
    },
  }))

  const spawnMultiAgent: SpawnMultiAgentModule = await import(
    `./spawnMultiAgent.ts?spawnMultiAgentProviderEnv=${Date.now()}-${Math.random()}`
  )
  return spawnMultiAgent
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

/** Asserts the provider env rides AFTER the inherited allowlist in the env
 * prefix of a spawn command (later `env K=V` wins → override semantics),
 * and that the sentinel binary is the target. Uses fully-quoted fragments
 * (as buildInheritedEnvVars emits them) and lastIndexOf, because the test
 * runner's own env may legitimately carry OPENAI_* inherited entries
 * EARLIER in the same command — the override must come after them all. */
function assertProviderEnvThreaded(command: string): void {
  expect(command).toContain('env CLAUDECODE=1')
  expect(command).toContain(SENTINEL_BINARY)
  const inheritedAt = command.indexOf('CLAUDECODE=1')
  for (const [key, value] of Object.entries(CODEX_PROVIDER_ENV)) {
    const fragment = `${key}=${quote([value])}`
    expect(command).toContain(fragment)
    expect(command.lastIndexOf(fragment)).toBeGreaterThan(inheritedAt)
  }
}

test('split-pane command threads providerEnv after the inherited allowlist', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-worker',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  assertProviderEnvThreaded(capturedCommands[0]!)
})

test('separate-window command threads providerEnv after the inherited allowlist', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.spawnTeammate(
    {
      name: 'codex-window',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-window',
      use_splitpane: false,
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  assertProviderEnvThreaded(capturedCommands[0]!)
})

test('PaneBackendExecutor command threads providerEnv after the inherited allowlist', async () => {
  await importSpawnMultiAgentWithMocks()
  const { PaneBackendExecutor } = await import(
    `../../utils/swarm/backends/PaneBackendExecutor.ts?providerEnvExecutor=${Date.now()}-${Math.random()}`
  )

  const paneCommands: string[] = []
  const fakeBackend = {
    type: 'tmux' as const,
    createTeammatePaneInSwarmView: async () => ({
      paneId: '%7',
      isFirstTeammate: true,
    }),
    enablePaneBorderStatus: async () => {},
    sendCommandToPane: async (
      _paneId: string,
      command: string,
      _useSocket: boolean,
    ) => {
      paneCommands.push(command)
    },
    killPane: async () => {},
  }
  const executor = new PaneBackendExecutor(fakeBackend as never)
  executor.setContext(makeToolUseContext())

  const result = await executor.spawn({
    name: 'codex-worker',
    teamName: 'codex-team',
    prompt: 'do work',
    cwd: '/tmp/codex-worker',
    parentSessionId: 'parent-session',
    providerEnv: CODEX_PROVIDER_ENV,
  })

  expect(result.success).toBe(true)
  expect(paneCommands).toHaveLength(1)
  assertProviderEnvThreaded(paneCommands[0]!)
  // No model in the config and a binding that carries one: the child must
  // resolve from OPENAI_MODEL, so the command carries no --model.
  expect(/--model (\S+)/.exec(paneCommands[0]!)?.[1]).toBeUndefined()
})

/** EVERY `--model <value>` a spawn command carries, in order.
 *
 * All occurrences, not the first: an assertion that reads only the first
 * match cannot fail on a duplicated `--model`, which is one of the
 * regressions these tests exist to catch. */
function modelFlagsOf(command: string): string[] {
  return [...command.matchAll(/--model (\S+)/g)].map(match => match[1]!)
}

/** The single `--model` value, asserting the command carries at most one. */
function modelFlagOf(command: string): string | undefined {
  const flags = modelFlagsOf(command)
  expect(flags).not.toHaveLength(2)
  return flags[0]
}

test('profile-bound split-pane spawn with no model emits no --model', async () => {
  // The bug: with `model` omitted — the documented way to use the binding —
  // the leader's model was resolved as the default and passed as --model,
  // which beats OPENAI_MODEL. The child then asked Codex for the leader's
  // Anthropic model and died with a 400 on its first request.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  const result = await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-worker',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagOf(capturedCommands[0]!)).toBeUndefined()
  expect(capturedCommands[0]!).not.toContain('test-model')
  // The env still carries the model the child will resolve, and the roster
  // records it rather than a model nothing is running.
  expect(capturedCommands[0]!).toContain('OPENAI_MODEL=codexplan')
  expect(result.data.model).toBe('codexplan')
})

test('profile-bound separate-window spawn with no model emits no --model', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  const result = await spawnMultiAgent.spawnTeammate(
    {
      name: 'codex-window',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-window',
      use_splitpane: false,
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagOf(capturedCommands[0]!)).toBeUndefined()
  expect(result.data.model).toBe('codexplan')
})

test("profile-bound spawn with model 'inherit' emits no --model", async () => {
  // 'inherit' means "the leader's model" — the exact value the binding exists
  // to keep away from the bound provider.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-inherit',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-inherit',
      model: 'inherit',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagOf(capturedCommands[0]!)).toBeUndefined()
})

test('profile-bound spawn honours an explicit model', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-pinned',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-pinned',
      model: 'gpt-5.6-sol',
      modelWasToolSpecified: true,
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagOf(capturedCommands[0]!)).toBe('gpt-5.6-sol')
})

test('profile-bound spawn strips the --model the leader inherited from its own CLI', async () => {
  // The subtlest path in the change: buildInheritedCliFlags propagates the
  // leader's own `--model` into every teammate's flags. Emitting no new
  // --model is not enough — the inherited one has to be removed, or a leader
  // started with `--model` reintroduces the original bug verbatim.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    mainLoopModelOverride: 'claude-opus-5[1m]',
  })

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-worker',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagsOf(capturedCommands[0]!)).toEqual([])
  expect(capturedCommands[0]!).not.toContain('claude-opus-5')
})

test('unbound spawn keeps the inherited --model when the leader set one', async () => {
  // Isolation for the strip above: without a binding the inherited flag is
  // replaced by the teammate's resolved model, never dropped.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    mainLoopModelOverride: 'claude-opus-5[1m]',
  })

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'plain-worker',
      prompt: 'do work',
      team_name: 'plain-team',
      cwd: '/tmp/plain-worker',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagsOf(capturedCommands[0]!)).toHaveLength(1)
})

test('an unbound sibling spawn still gets the leader-derived --model', async () => {
  // Isolation property: suppressing --model is scoped to the binding. A plain
  // teammate must keep inheriting the leader's model exactly as before.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'codex-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/codex-worker',
      providerEnv: CODEX_PROVIDER_ENV,
    },
    makeToolUseContext(),
  )
  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'plain-worker',
      prompt: 'do work',
      team_name: 'codex-team',
      cwd: '/tmp/plain-worker',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(2)
  expect(modelFlagOf(capturedCommands[0]!)).toBeUndefined()
  expect(modelFlagOf(capturedCommands[1]!)).toBe('test-model')
})

test('profile-bound spawn refuses an explicit Anthropic model', async () => {
  // The combination applyTeammateModelFlag honours and Codex rejects: the
  // explicit model wins over OPENAI_MODEL, reaches a ChatGPT account, and
  // 400s on the first request with nothing reported.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await expect(
    spawnMultiAgent.handleSpawnSplitPane(
      {
        name: 'codex-mismatch',
        prompt: 'do work',
        team_name: 'codex-team',
        cwd: '/tmp/codex-mismatch',
        model: 'claude-opus-5[1m]',
        modelWasToolSpecified: true,
        providerEnv: CODEX_PROVIDER_ENV,
        providerProfileRef: 'Codex OAuth',
      },
      makeToolUseContext(),
    ),
  ).rejects.toThrow(/Codex \(OAuth\) provider profile 'Codex OAuth'/)

  // Refused before any pane, task or roster entry exists.
  expect(capturedCommands).toHaveLength(0)
})

test('profile-bound refusal resolves an alias before judging it', async () => {
  // `opus` is not literally an Anthropic model id, so a check on the raw
  // argument would wave it through to the same 400.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    modelAliases: { opus: 'claude-opus-5' },
  })

  await expect(
    spawnMultiAgent.handleSpawnSplitPane(
      {
        name: 'codex-alias',
        prompt: 'do work',
        team_name: 'codex-team',
        cwd: '/tmp/codex-alias',
        model: 'opus',
        modelWasToolSpecified: true,
        providerEnv: CODEX_PROVIDER_ENV,
        providerProfileRef: 'Codex OAuth',
      },
      makeToolUseContext(),
    ),
  ).rejects.toThrow(/resolves to 'claude-opus-5'/)
})

test('profile-bound spawn allows every model it cannot disprove', async () => {
  // Narrowness is the point: the profile's own default, a codex model
  // measured working on this path, and an unknown model all pass.
  for (const model of ['codexplan', 'gpt-5.6-sol', 'some-future-model']) {
    const spawnMultiAgent = await importSpawnMultiAgentWithMocks()
    capturedCommands = []

    await spawnMultiAgent.handleSpawnSplitPane(
      {
        name: `codex-ok-${model}`,
        prompt: 'do work',
        team_name: 'codex-team',
        cwd: '/tmp/codex-ok',
        model,
        modelWasToolSpecified: true,
        providerEnv: CODEX_PROVIDER_ENV,
        providerProfileRef: 'Codex OAuth',
      },
      makeToolUseContext(),
    )

    expect(capturedCommands).toHaveLength(1)
    expect(modelFlagOf(capturedCommands[0]!)).toBe(model)
  }
})

test('an Anthropic model is untouched without a binding', async () => {
  // The guard partitions on providerEnv: no binding, no refusal, so ordinary
  // Anthropic teammates are unaffected.
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'plain-opus',
      prompt: 'do work',
      team_name: 'plain-team',
      cwd: '/tmp/plain-opus',
      model: 'claude-opus-5[1m]',
      modelWasToolSpecified: true,
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  expect(modelFlagOf(capturedCommands[0]!)).toBe('claude-opus-5\\[1m\\]')
})

test('in-process spawn rejects providerEnv with the named error', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks({
    inProcessEnabled: true,
  })

  await expect(
    spawnMultiAgent.spawnTeammate(
      {
        name: 'codex-worker',
        prompt: 'do work',
        team_name: 'codex-team',
        cwd: '/tmp/codex-worker',
        providerEnv: CODEX_PROVIDER_ENV,
      },
      makeToolUseContext(),
    ),
  ).rejects.toThrow(PROVIDER_PROFILE_IN_PROCESS_ERROR)
})

test('absent providerEnv leaves no provider keys in the command', async () => {
  const spawnMultiAgent = await importSpawnMultiAgentWithMocks()

  await spawnMultiAgent.handleSpawnSplitPane(
    {
      name: 'plain-worker',
      prompt: 'do work',
      team_name: 'plain-team',
      cwd: '/tmp/plain-worker',
    },
    makeToolUseContext(),
  )

  expect(capturedCommands).toHaveLength(1)
  const command = capturedCommands[0]!
  // No extras: the env section must be byte-identical to the un-parameterized
  // seam output (spawnUtils.test.ts locks that baseline independently). The
  // runner's own env may legitimately carry OPENAI_*/CLAUDE_CODE_USE_* keys,
  // so key-absence checks are meaningless here — exact equality is the proof.
  const envSection = command.slice(
    command.indexOf('env ') + 4,
    command.indexOf(` ${quote([SENTINEL_BINARY])}`),
  )
  expect(envSection).toBe(buildInheritedEnvVars())
})
