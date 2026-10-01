import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import { asAgentId } from '../../types/ids.js'
import {
  AttentionSpawnBlockedError,
  createAttentionItem,
  decideAttentionItem,
} from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { AgentTool } from './AgentTool.js'
import { resumeAgentBackground } from './resumeAgent.js'

// Phase 5 spawn gate: while an attention item is undecided the ROOT lead
// cannot start new work (Agent tool, or SendMessage's auto-resume of a
// stopped agent). Subagents and teammates are never gated.

const LIST = 'attention-gate-list'
let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.attentionGate.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attn-gate-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
})

afterEach(() => {
  try {
    if (previousListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

const ITEM = 'failure-w1-0'

async function undecided(): Promise<void> {
  await createAttentionItem({
    id: ITEM,
    kind: 'failure',
    source: { taskId: 'w1', agentName: 'builder', backend: 'in_process' },
    summary: 'builder failed: boom',
    transient: false,
  })
}

function context(agentId?: string): ToolUseContext {
  const state: AppState = getDefaultAppState()
  return {
    agentId: agentId ? asAgentId(agentId) : undefined,
    getAppState: () => state,
    setAppState: () => {},
    options: { agentDefinitions: { activeAgents: [], allAgents: [] }, tools: [] },
  } as unknown as ToolUseContext
}

const canUseTool = (() => {
  throw new Error('canUseTool must not be reached')
}) as unknown as CanUseToolFn

/** The error AgentTool.call throws for a spawn of an agent type that does
 * not exist — or the gate's, which comes first. */
async function spawnError(ctx: ToolUseContext): Promise<string> {
  try {
    await AgentTool.call(
      { prompt: 'do it', description: 'd', subagent_type: 'no-such-agent-type' } as never,
      ctx,
      canUseTool,
      {} as never,
    )
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return '(no error)'
}

const asTeammate = <T>(fn: () => T): T =>
  runWithTeammateContext(
    {
      agentId: 'w@team',
      agentName: 'w',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 's',
      isInProcess: true,
      abortController: new AbortController(),
    },
    fn,
  )

describe('AgentTool.call', () => {
  test('the root lead is blocked with the item listed; deciding unblocks it', async () => {
    expect(await spawnError(context())).not.toContain('Blocked')
    await undecided()
    const blocked = await spawnError(context())
    expect(blocked).toStartWith('Blocked: 1 failure(s) need a decision before new work can be spawned: ')
    expect(blocked).toContain(`${ITEM} (failure: builder failed: boom)`)
    expect(blocked).toContain('AttentionDecide')
    await decideAttentionItem(ITEM, { choice: 'continue', reason: 'accepted' })
    expect(await spawnError(context())).not.toContain('Blocked')
  })

  test("a subagent's and a teammate's own spawns are not gated", async () => {
    await undecided()
    expect(await spawnError(context('a00000000000beef'))).not.toContain('Blocked')
    expect(await asTeammate(() => spawnError(context()))).not.toContain('Blocked')
  })
})

describe('resumeAgentBackground', () => {
  const resume = (ctx: ToolUseContext, userInitiated = false) =>
    resumeAgentBackground({
      agentId: 'a0123456789abcdef',
      prompt: 'carry on',
      toolUseContext: ctx,
      canUseTool,
      userInitiated,
    })

  test('the root lead cannot resume a stopped agent while an item is undecided', async () => {
    await undecided()
    const error = await resume(context()).catch(e => e)
    expect(error).toBeInstanceOf(AttentionSpawnBlockedError)
    expect(String(error.message)).toContain(ITEM)
  })

  test('not gated: no item, a user-initiated resume, a teammate (they fail later, on the missing transcript)', async () => {
    const noItem = await resume(context()).catch(e => e)
    expect(noItem).not.toBeInstanceOf(AttentionSpawnBlockedError)
    await undecided()
    expect(await resume(context(), true).catch(e => e)).not.toBeInstanceOf(AttentionSpawnBlockedError)
    expect(await asTeammate(() => resume(context())).catch(e => e)).not.toBeInstanceOf(AttentionSpawnBlockedError)
  })
})
