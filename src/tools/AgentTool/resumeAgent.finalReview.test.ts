import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { readFinalReview, recordFinalReview } from '../../utils/finalReviews.js'
import * as realSessionStorage from '../../utils/sessionStorage.js'
import * as realAgentToolUtils from './agentToolUtils.js'
import { FINAL_REVIEWER_AGENT } from './built-in/finalReviewerAgent.js'
import { FINAL_REVIEW_AGENT_TYPE } from './constants.js'
import { resumeAgentBackground } from './resumeAgent.js'

// Phase 4: resuming a built-in final reviewer clears its old record, runs it
// in a NEW clean detached checkout of the commit it was spawned for, hands
// that checkout to the record hook, and removes it when the run ends.
// Mock layout follows resumeAgent.verificationVerdict.test.ts.

const pristineRealSessionStorage = { ...realSessionStorage }
const pristineRealAgentToolUtils = { ...realAgentToolUtils }

const LIST = 'resume-final-review-list'
const AGENT_ID = 'a0000reviewer01'

type Lifecycle = {
  metadata: { finalReview?: { commit: string; worktreePath: string } }
  getWorktreeResult: () => Promise<unknown>
}

let mockMetadata: Record<string, unknown> = {}
let onLifecycle: ((p: Lifecycle & { cwd: string }) => Promise<void>) | undefined

mock.module('../../utils/sessionStorage.js', () => ({
  ...pristineRealSessionStorage,
  getAgentTranscript: async () => ({ messages: [], contentReplacements: [] }),
  readAgentMetadata: async () => mockMetadata,
  writeAgentMetadata: async () => {},
  getAgentTranscriptPath: (agentId: string) => `/tmp/${agentId}.jsonl`,
}))

mock.module('./agentToolUtils.js', () => ({
  ...pristineRealAgentToolUtils,
  runAsyncAgentLifecycle: async (params: Lifecycle) => {
    await onLifecycle?.({ ...params, cwd: getCwd() })
  },
}))

afterAll(() => {
  mock.module('../../utils/sessionStorage.js', () => ({
    ...pristineRealSessionStorage,
  }))
  mock.module('./agentToolUtils.js', () => ({ ...pristineRealAgentToolUtils }))
})

let configDir: string | undefined
let previousListId: string | undefined
let repo: string
let first: string

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
  await acquireSharedMutationLock('tools/AgentTool/resumeAgent.finalReview.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-resume-final-review-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'openclaude-resume-review-repo-')))
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  first = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'second')
  mockMetadata = {
    agentType: FINAL_REVIEW_AGENT_TYPE,
    source: 'built-in',
    cwd: repo,
    reviewCommit: first,
  }
  onLifecycle = undefined
})

afterEach(() => {
  try {
    if (previousListId === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
    rmSync(repo, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

function makeToolUseContext(): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
    speculation: { status: 'idle' },
    tasks: {},
  }
  const agents = [FINAL_REVIEWER_AGENT]
  return {
    options: {
      agentDefinitions: { activeAgents: agents, allAgents: agents },
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
    getAppState: () => appState,
    setAppState: (f: (prev: unknown) => Record<string, unknown>) => {
      appState = f(appState)
    },
    contentReplacementState: { replacements: new Map() },
  } as unknown as ToolUseContext
}

function resume() {
  return resumeAgentBackground({
    agentId: AGENT_ID,
    prompt: 'check again',
    toolUseContext: makeToolUseContext(),
    canUseTool: async () => ({ behavior: 'allow' }) as never,
  })
}

test('a resumed final reviewer runs in a new checkout of its commit, which is removed when it ends', async () => {
  await recordFinalReview(
    { agentId: AGENT_ID, result: 'DONE', gaps: [], commit: first },
    LIST,
  )
  const seen = new Promise<{
    cwd: string
    head: string
    target?: { commit: string; worktreePath: string }
    recordAtStart: unknown
  }>(resolve => {
    onLifecycle = async params => {
      resolve({
        cwd: params.cwd,
        head: git(params.cwd, 'rev-parse', 'HEAD'),
        target: params.metadata.finalReview,
        recordAtStart: await readFinalReview(AGENT_ID, LIST),
      })
      await params.getWorktreeResult()
    }
  })

  await resume()
  const run = await seen

  expect(run.recordAtStart).toBeUndefined()
  expect(run.cwd).not.toBe(repo)
  expect(run.head).toBe(first)
  expect(run.target).toEqual({ commit: first, worktreePath: run.cwd })
  const deadline = Date.now() + 5_000
  while (existsSync(run.cwd) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(existsSync(run.cwd)).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
})

test('resume refuses when the reviewed commit was not recorded', async () => {
  mockMetadata = { agentType: FINAL_REVIEW_AGENT_TYPE, source: 'built-in', cwd: repo }
  let started = false
  onLifecycle = async () => {
    started = true
  }
  await expect(resume()).rejects.toThrow(/the commit it reviewed was not recorded/)
  expect(started).toBe(false)
})
