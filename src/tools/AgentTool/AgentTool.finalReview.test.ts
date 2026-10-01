import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getCwd } from '../../utils/cwd.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { readFinalReview } from '../../utils/finalReviews.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { listTasks } from '../../utils/tasks.js'
import { FINAL_REVIEWER_AGENT } from './built-in/finalReviewerAgent.js'
import { FINAL_REVIEW_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Phase 4 wiring through the real AgentTool.call path: the final reviewer
// only runs as a subagent with review_commit, in a clean detached worktree
// of the resolved sha that is removed when the run ends (also on a throw),
// and its report is self-checked and recorded.
// Harness modelled on AgentTool.verificationVerdict.test.ts.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('./runAgent.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')
type AgentToolModule = typeof import('./AgentTool.js')

const LIST = 'agent-tool-final-review-list'

let actualPromptsModule: PromptsModule | undefined
let actualRunAgentModule: RunAgentModule | undefined
let actualSettingsModule: SettingsModule | undefined
let settingsForTest: SettingsJson = {}
let configDir: string | undefined
let previousListId: string | undefined
let repo: string
let first: string

const ROUTE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_TEAMMATE_PROFILE_ID',
] as const
const savedRouteEnv: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>> =
  {}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()
}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.finalReview.test.ts')
  for (const key of ROUTE_ENV_KEYS) {
    savedRouteEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-agent-final-review-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  resetSettingsCache()
  actualSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentFinalReviewSettingsActual=${Date.now()}-${Math.random()}`
  )
  settingsForTest = { teammateDispatch: { mode: 'off' } } as SettingsJson
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsModule!,
    getInitialSettings: () => settingsForTest,
    getSettings_DEPRECATED: () => settingsForTest,
  }))

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'openclaude-agent-review-repo-')))
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  first = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'second')
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n')
})

afterEach(() => {
  try {
    mock.restore()
    if (actualPromptsModule) {
      mock.module('../../constants/prompts.js', () => ({ ...actualPromptsModule! }))
    }
    if (actualRunAgentModule) {
      mock.module('./runAgent.js', () => ({ ...actualRunAgentModule! }))
    }
    if (actualSettingsModule) {
      mock.module('../../utils/settings/settings.js', () => ({ ...actualSettingsModule! }))
    }
    resetSettingsCache()
    settingsForTest = {}
  } finally {
    if (previousListId === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
    rmSync(repo, { recursive: true, force: true })
    for (const key of ROUTE_ENV_KEYS) {
      const saved = savedRouteEnv[key]
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    releaseSharedMutationLock()
  }
})

type Seen = { cwd: string; head: string; status: string; files: string[] }
type Script = {
  // Final text from what the run saw (its cwd and that checkout's HEAD).
  report?: (seen: Seen) => string
  throwBeforeOutput?: Error
}

async function importAgentTool(script: Script): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  seen: Seen[]
}> {
  actualPromptsModule ??= await import(
    `../../constants/prompts.ts?agentFinalReviewActual=${Date.now()}-${Math.random()}`
  )
  actualRunAgentModule ??= await import(
    `./runAgent.ts?agentFinalReviewActual=${Date.now()}-${Math.random()}`
  )
  const seen: Seen[] = []
  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule!,
    enhanceSystemPromptWithEnvDetails: mock(async (prompts: string[]) => prompts),
  }))
  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule!,
    runAgent: mock(async function* () {
      const cwd = getCwd()
      const entry: Seen = {
        cwd,
        head: git(cwd, 'rev-parse', 'HEAD'),
        status: git(cwd, 'status', '--short'),
        files: execFileSync('ls', ['-A', cwd], { encoding: 'utf-8' }).trim().split('\n'),
      }
      seen.push(entry)
      if (script.throwBeforeOutput) throw script.throwBeforeOutput
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: script.report?.(entry) ?? 'nothing' }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }
    }),
  }))
  const { AgentTool } = await import(
    `./AgentTool.js?agentFinalReview=${Date.now()}-${Math.random()}`
  )
  return { AgentTool, seen }
}

function createToolUseContext(activeAgents: AgentDefinition[]): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] as Array<{ name: string }> },
    todos: {},
    tasks: {},
    speculation: { status: 'idle' },
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'parent-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents, allAgents: activeAgents },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    messages: [],
    getAppState: () => appState,
    setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      appState = f(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

const GOOD_REPORT = (s: Seen) =>
  `REVIEW CWD: ${s.cwd}\nREVIEW HEAD: ${s.head}\nAll delivered.\nFINAL REVIEW: DONE`

async function callReviewer(
  AgentTool: AgentToolModule['AgentTool'],
  input: Record<string, unknown>,
  onProgress?: () => void,
) {
  const result = await AgentTool.call(
    {
      description: 'Final review',
      prompt: 'Add a --json flag to the CLI.',
      subagent_type: FINAL_REVIEW_AGENT_TYPE,
      cwd: repo,
      ...input,
    } as never,
    createToolUseContext([FINAL_REVIEWER_AGENT]),
    mock(async () => ({ behavior: 'allow' })) as never,
    { message: { id: 'parent-message' } } as never,
    onProgress as never,
  )
  const data = result.data as { status: string; agentId: string }
  const block = AgentTool.mapToolResultToToolResultBlockParam(
    result.data as never,
    'toolu_review',
  )
  return { data, trailer: JSON.stringify(block.content) }
}

test('refuses a final reviewer without review_commit', async () => {
  const { AgentTool, seen } = await importAgentTool({ report: GOOD_REPORT })
  await expect(callReviewer(AgentTool, {})).rejects.toThrow(/requires review_commit/)
  expect(seen).toHaveLength(0)
})

test.each([
  ['name', { name: 'reviewer' }],
  ['team_name', { team_name: 'some-team' }],
])('refuses a final reviewer spawned with %s (it must be a subagent)', async (_label, extra) => {
  const { AgentTool, seen } = await importAgentTool({ report: GOOD_REPORT })
  await expect(
    callReviewer(AgentTool, { review_commit: 'HEAD', ...extra }),
  ).rejects.toThrow(/must run as a subagent: omit name and team_name/)
  expect(seen).toHaveLength(0)
})

test('refuses review_commit for any other agent', async () => {
  const { AgentTool } = await importAgentTool({ report: GOOD_REPORT })
  const other = { ...FINAL_REVIEWER_AGENT, agentType: 'other-agent' } as AgentDefinition
  await expect(
    AgentTool.call(
      { description: 'x', prompt: 'x', subagent_type: 'other-agent', review_commit: 'HEAD' } as never,
      createToolUseContext([other]),
      mock(async () => ({ behavior: 'allow' })) as never,
      { message: { id: 'parent-message' } } as never,
    ),
  ).rejects.toThrow(/review_commit is only valid with the built-in final reviewer/)
})

test('runs in a clean detached checkout of the resolved sha, records DONE, and removes the checkout', async () => {
  const { AgentTool, seen } = await importAgentTool({ report: GOOD_REPORT })
  const { data, trailer } = await callReviewer(AgentTool, { review_commit: 'HEAD~1' })

  expect(data.status).toBe('completed')
  expect(seen).toHaveLength(1)
  const run = seen[0]!
  expect(run.cwd).not.toBe(repo)
  expect(run.head).toBe(first)
  expect(run.status).toBe('')
  expect(run.files.sort()).toEqual(['.git', 'a.txt'])
  expect(existsSync(run.cwd)).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)

  const record = await readFinalReview(data.agentId, LIST)
  expect(record).toMatchObject({ result: 'DONE', commit: first })
  expect(trailer).toContain(`finalReview: DONE (recorded for this agentId at commit ${first}`)
  expect(trailer).toContain(`metadata.finalReviewedBy: '${data.agentId}'`)
})

test('a report echoing the wrong HEAD is recorded as MISSING', async () => {
  const { AgentTool } = await importAgentTool({
    report: s => `REVIEW CWD: ${s.cwd}\nREVIEW HEAD: ${'0'.repeat(40)}\nFINAL REVIEW: DONE`,
  })
  const { data, trailer } = await callReviewer(AgentTool, { review_commit: 'HEAD~1' })
  const record = await readFinalReview(data.agentId, LIST)
  expect(record?.result).toBe('MISSING')
  expect(record?.reason).toContain('is not the reviewed commit')
  expect(trailer).toContain('finalReview: MISSING')
})

test('a report echoing the caller repo as CWD is recorded as MISSING', async () => {
  const { AgentTool } = await importAgentTool({
    report: s => `REVIEW CWD: ${repo}\nREVIEW HEAD: ${s.head}\nFINAL REVIEW: DONE`,
  })
  const { data } = await callReviewer(AgentTool, { review_commit: 'HEAD~1' })
  expect((await readFinalReview(data.agentId, LIST))?.reason).toContain(
    'is not the review checkout',
  )
})

test('GAPS files each GAP as a task exactly once and lists the ids', async () => {
  const { AgentTool } = await importAgentTool({
    report: s =>
      `REVIEW CWD: ${s.cwd}\nREVIEW HEAD: ${s.head}\nGAP-001 | severity=major | requirement=--json flag | expected=JSON output | observed=no flag | evidence=cli.ts\nFINAL REVIEW: GAPS`,
  })
  const { data, trailer } = await callReviewer(AgentTool, { review_commit: 'HEAD' })
  const gapTasks = (await listTasks(LIST)).filter(t => t.metadata?.gapOf === data.agentId)
  expect(gapTasks).toHaveLength(1)
  expect(gapTasks[0]!.subject).toBe('GAP-001: --json flag')
  expect(trailer).toContain(`GAP tasks: #${gapTasks[0]!.id}`)
})

test('the checkout is removed when the run throws', async () => {
  const { AgentTool, seen } = await importAgentTool({
    throwBeforeOutput: new Error('provider exploded'),
  })
  await expect(callReviewer(AgentTool, { review_commit: 'HEAD' })).rejects.toThrow(
    'provider exploded',
  )
  expect(seen).toHaveLength(1)
  expect(existsSync(seen[0]!.cwd)).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
})

test('the checkout is removed when the call throws before the run loop starts', async () => {
  const { AgentTool, seen } = await importAgentTool({ report: GOOD_REPORT })
  const worktreesBefore = git(repo, 'worktree', 'list')
  await expect(
    callReviewer(AgentTool, { review_commit: 'HEAD' }, () => {
      throw new Error('progress consumer exploded')
    }),
  ).rejects.toThrow('progress consumer exploded')
  expect(seen).toHaveLength(0)
  expect(git(repo, 'worktree', 'list')).toBe(worktreesBefore)
})

async function takeTaskNotification(agentId: string): Promise<string> {
  const matches = (cmd: { value: unknown; mode?: string }) =>
    cmd.mode === 'task-notification' &&
    typeof cmd.value === 'string' &&
    cmd.value.includes(`<task-id>${agentId}</task-id>`)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = dequeueAllMatching(matches as never)
    if (found.length > 0) return String(found[0]!.value)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`no task notification for ${agentId}`)
}

test('a background run records, reports, and removes the checkout when it ends', async () => {
  const { AgentTool, seen } = await importAgentTool({ report: GOOD_REPORT })
  const { data } = await callReviewer(AgentTool, {
    review_commit: 'HEAD~1',
    run_in_background: true,
  })
  expect(data.status).toBe('async_launched')
  const notification = await takeTaskNotification(data.agentId)
  expect(notification).toContain(`finalReview: DONE (recorded for this agentId at commit ${first}`)
  expect((await readFinalReview(data.agentId, LIST))?.result).toBe('DONE')
  const deadline = Date.now() + 5_000
  while (existsSync(seen[0]!.cwd) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(existsSync(seen[0]!.cwd)).toBe(false)
}, 30_000)
