import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
// Load the tool graph first (import-cycle TDZ otherwise).
import '../../constants/tools.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import {
  decideAttentionItem,
  listAttentionItems,
  readAttentionItem,
} from '../attentionItems.js'
import { getAttentionItemsAttachment } from '../attachments.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { resetCommandQueue } from '../messageQueueManager.js'
import { claimTask, createTask, getTask } from '../tasks.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

// Phase 5, in-process teammates: their failure path never reaches
// enqueueAgentNotification, so the runner's catch creates the attention item
// itself, before releasing (and holding) the teammate's tasks. Ends with the
// done-when walk: failure → item → spawn blocked → reminder → decision
// unblocks → a second decision is refused.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type RunnerModule = typeof import('./inProcessRunner.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined
let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/inProcessRunner.attention.test.ts')
  resetCommandQueue()
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-inproc-attention-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    resetCommandQueue()
    mock.restore()
    // Spread copies: a factory returning the namespace itself is a no-op.
    if (actualPrompts) mock.module('../../constants/prompts.js', () => ({ ...actualPrompts! }))
    if (actualRunAgent) mock.module('../../tools/AgentTool/runAgent.js', () => ({ ...actualRunAgent! }))
    if (actualMailbox) mock.module('../teammateMailbox.js', () => ({ ...actualMailbox! }))
    if (actualSleep) mock.module('../sleep.js', () => ({ ...actualSleep! }))
    if (actualDiskOutput) mock.module('../task/diskOutput.js', () => ({ ...actualDiskOutput! }))
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

async function runnerWhoseTurnThrows(beforeThrow?: () => void): Promise<RunnerModule> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(`../../constants/prompts.ts?attnActual=${stamp}`)
  actualRunAgent ??= await import(`../../tools/AgentTool/runAgent.ts?attnActual=${stamp}`)
  actualMailbox ??= await import(`../teammateMailbox.ts?attnActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?attnActual=${stamp}`)
  actualDiskOutput ??= await import(`../task/diskOutput.ts?attnActual=${stamp}`)
  mock.module('../../constants/prompts.js', () => ({
    ...actualPrompts!,
    getSystemPrompt: async () => ['system prompt'],
  }))
  mock.module('../../tools/AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    // biome-ignore lint/correctness/useYield: the turn dies before yielding
    runAgent: async function* () {
      beforeThrow?.()
      throw new Error('provider exploded mid-turn')
    },
  }))
  mock.module('../teammateMailbox.js', () => ({
    ...actualMailbox!,
    readMailbox: async () => [],
    writeToMailbox: async () => {},
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))),
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))
  return import(`./inProcessRunner.ts?attention=${stamp}`)
}

type Run = {
  taskId: string
  agentId: string
  getState: () => AppState
  heldTask: string
  /** The list the runner claims from and releases into (the lead session's
   * for a root-team member, the sub-team's own for a sub-team member). */
  heldList: string
}

async function runFailingTeammate(
  teamName: string,
  options: { killFirst?: boolean } = {},
): Promise<Run> {
  let state: AppState = getDefaultAppState()
  const getState = (): AppState => state
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  let taskId = ''
  const runner = await runnerWhoseTurnThrows(
    options.killFirst
      ? () => {
          setAppState(prev => ({
            ...prev,
            tasks: { ...prev.tasks, [taskId]: { ...prev.tasks[taskId]!, status: 'killed' } },
          }))
        }
      : undefined,
  )
  const spawn = await spawnInProcessTeammate(
    { name: 'builder', teamName, planModeRequired: false },
    { setAppState, getAppState: () => state },
  )
  if (!spawn.success || !spawn.taskId || !spawn.teammateContext || !spawn.abortController) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  taskId = spawn.taskId
  const heldList = teamName.includes('/') ? teamName : spawn.teammateContext.parentSessionId
  const heldTask = await createTask(heldList, {
    subject: 'build the parser',
    description: 'd',
    status: 'in_progress',
    owner: spawn.agentId,
    blocks: [],
    blockedBy: [],
  })
  const result = await runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: 'builder',
      teamName,
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    prompt: 'build it',
    description: 'build the parser',
    teammateContext: spawn.teammateContext,
    toolUseContext: {
      options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
      abortController: spawn.abortController,
      messages: [],
      readFileState: new Map(),
      getAppState: getState,
      setAppState,
    } as unknown as ToolUseContext,
    abortController: spawn.abortController,
  })
  expect(result.success).toBe(false)
  return { taskId, agentId: spawn.agentId, getState, heldTask, heldList }
}

const leadContext = (): ToolUseContext =>
  ({
    agentId: undefined,
    getAppState: () => getDefaultAppState(),
    setAppState: () => {},
    options: { agentDefinitions: { activeAgents: [], allAgents: [] }, tools: [] },
  }) as unknown as ToolUseContext

const canUseTool = (() => {
  throw new Error('canUseTool must not be reached')
}) as unknown as CanUseToolFn

async function spawnError(): Promise<string> {
  try {
    await AgentTool.call(
      { prompt: 'retry it', description: 'd', subagent_type: 'no-such-agent-type' } as never,
      leadContext(),
      canUseTool,
      {} as never,
    )
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return '(no error)'
}

test('done when: a failed in-process teammate is an item that blocks spawning until decided, exactly once', async () => {
  const TEAM = 'attn-root'
  process.env.CLAUDE_CODE_TASK_LIST_ID = TEAM
  try {
    const run = await runFailingTeammate(TEAM)
    const itemId = `failure-${run.taskId}-0`

    // (a) the item exists, with the released task held for it
    const items = await listAttentionItems(TEAM)
    expect(items.map(i => i.id)).toEqual([itemId])
    expect(items[0]).toMatchObject({
      kind: 'failure',
      status: 'undecided',
      transient: false,
      source: {
        backend: 'in_process',
        agentId: run.agentId,
        agentName: 'builder',
        teamName: TEAM,
        taskListTaskIds: [run.heldTask],
        heldTaskListId: run.heldList,
      },
    })
    expect(items[0]!.summary).toContain('provider exploded mid-turn')
    const held = await getTask(run.heldList, run.heldTask)
    expect(held).toMatchObject({
      status: 'pending',
      metadata: { attentionHold: itemId, attentionHoldList: TEAM },
    })
    expect(held?.owner).toBeUndefined()
    expect((await claimTask(run.heldList, run.heldTask, 'other@attn-root')).reason).toBe('held_for_decision')

    // (b) spawn is blocked
    expect(await spawnError()).toContain(`Blocked: 1 failure(s) need a decision before new work can be spawned: ${itemId}`)

    // (c) the lead's reminder lists it
    const [reminder] = await getAttentionItemsAttachment({ agentId: undefined }, 'repl_main_thread')
    expect(JSON.stringify(reminder)).toContain(itemId)

    // (d) a decision unblocks spawning and releases the hold
    await decideAttentionItem(itemId, { choice: 'patch', reason: 'split the parser work', rootCause: 'scope' })
    expect(await spawnError()).not.toContain('Blocked')
    expect(await getAttentionItemsAttachment({ agentId: undefined }, 'repl_main_thread')).toEqual([])
    expect((await getTask(run.heldList, run.heldTask))?.metadata?.attentionHold).toBeUndefined()
    expect((await claimTask(run.heldList, run.heldTask, 'other@attn-root')).success).toBe(true)

    // (e) a second decision is refused
    await expect(
      decideAttentionItem(itemId, { choice: 'abort', reason: 'second thoughts' }),
    ).rejects.toThrow('already decided: patch')
    expect((await readAttentionItem(itemId))?.decision?.choice).toBe('patch')
  } finally {
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
  }
})

test('a killed in-process teammate creates no item and holds nothing', async () => {
  const TEAM = 'attn-killed'
  const run = await runFailingTeammate(TEAM, { killFirst: true })
  expect(await listAttentionItems(TEAM)).toEqual([])
  expect((await getTask(run.heldList, run.heldTask))?.metadata?.attentionHold).toBeUndefined()
})

test("a sub-team member's failure creates no item for the root lead", async () => {
  const TEAM = 'attn-root2/lead'
  const run = await runFailingTeammate(TEAM)
  expect(await listAttentionItems(TEAM)).toEqual([])
  expect(await listAttentionItems('attn-root2')).toEqual([])
  expect((await getTask(run.heldList, run.heldTask))?.metadata?.attentionHold).toBeUndefined()
})
