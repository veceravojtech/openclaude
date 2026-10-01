import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Load the tool graph first (import-cycle TDZ otherwise).
import '../constants/tools.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { FINAL_REVIEW_AGENT_TYPE } from '../tools/AgentTool/constants.js'
import { asAgentId } from '../types/ids.js'
import {
  createAttentionItem,
  decideAttentionItem,
} from './attentionItems.js'
import {
  type Attachment,
  getAttentionItemsAttachment,
  teamAttachmentsFor,
} from './attachments.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { normalizeAttachmentForAPI } from './messages.js'
import { getDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import { runWithTeammateContext } from './teammateContext.js'

// Phase 5: the attention_items attachment reaches the ROOT lead's main
// thread only, every turn, while anything is undecided. Also Phase 4 fix B:
// the final reviewer gets no team mailbox (nor team context).

const LIST = 'attention-attachment-list'
let configDir: string | undefined
let previousListId: string | undefined
let previousDynamic: ReturnType<typeof getDynamicTeamContext>

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.attention.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attn-attach-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  previousDynamic = getDynamicTeamContext()
  setDynamicTeamContext(null)
})

afterEach(() => {
  try {
    setDynamicTeamContext(previousDynamic)
    if (previousListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

const ITEM = 'failure-w7-0'
const lead = { agentId: undefined }

async function undecided(): Promise<void> {
  await createAttentionItem({
    id: ITEM,
    kind: 'failure',
    source: { taskId: 'w7', agentName: 'builder', teamName: 'team', backend: 'pane', taskListTaskIds: ['3'] },
    summary: 'builder failed: Pane exited without completing',
    transient: true,
    transientReason: 'pane exited (dead pane)',
  })
}

describe('attention_items attachment', () => {
  test('the lead sees every undecided item, with decisions, tool, guidance and the spawn block', async () => {
    await undecided()
    const [attachment, ...rest] = await getAttentionItemsAttachment(lead, 'repl_main_thread')
    expect(rest).toEqual([])
    expect(attachment).toMatchObject({ type: 'attention_items', count: 1 })
    const content = (attachment as Extract<Attachment, { type: 'attention_items' }>).content
    expect(content).toContain(`- ${ITEM} [failure] builder failed: Pane exited without completing`)
    expect(content).toContain('worker builder@team, pane, run w7, holding tasks #3')
    expect(content).toContain('transient: yes (retry allowed)')
    expect(content).toContain('New workers cannot be spawned')
    expect(content).toContain('AttentionDecide')
    expect(content).toContain('retry (transient failures only')
    expect(content).toContain('earliest wrong input')
    // SDK and a plain main-thread call (no query source) see it too.
    expect(await getAttentionItemsAttachment(lead, 'sdk')).toHaveLength(1)
    expect(await getAttentionItemsAttachment(lead)).toHaveLength(1)

    // Rendered as a system reminder for the model.
    const rendered = JSON.stringify(normalizeAttachmentForAPI(attachment!))
    expect(rendered).toContain('system-reminder')
    expect(rendered).toContain(ITEM)
  })

  test('absent when nothing is undecided', async () => {
    expect(await getAttentionItemsAttachment(lead, 'repl_main_thread')).toEqual([])
    await undecided()
    await decideAttentionItem(ITEM, { choice: 'retry', reason: 'dead pane' })
    expect(await getAttentionItemsAttachment(lead, 'repl_main_thread')).toEqual([])
  })

  test('absent for subagents, in-process teammates, a pane teammate process and forked queries', async () => {
    await undecided()
    expect(await getAttentionItemsAttachment({ agentId: asAgentId('a00000000000beef') }, 'repl_main_thread')).toEqual([])
    expect(
      await runWithTeammateContext(
        {
          agentId: 'w@team',
          agentName: 'w',
          teamName: 'team',
          planModeRequired: false,
          parentSessionId: 's',
          isInProcess: true,
          abortController: new AbortController(),
        },
        () => getAttentionItemsAttachment(lead, 'repl_main_thread'),
      ),
    ).toEqual([])
    // A pane teammate is its own process: its MAIN thread has no agentId,
    // only the dynamic team context main.tsx sets from its CLI flags.
    setDynamicTeamContext({ agentId: 'pane@team', agentName: 'pane', teamName: 'team', planModeRequired: false })
    expect(await getAttentionItemsAttachment(lead, 'repl_main_thread')).toEqual([])
    setDynamicTeamContext(null)
    expect(await getAttentionItemsAttachment(lead, 'session_memory')).toEqual([])
    expect(await getAttentionItemsAttachment(lead, 'compact' as never)).toEqual([])
  })
})

describe('Phase 4 fix B: team attachments for the final reviewer', () => {
  test('the final reviewer gets neither the team mailbox nor the team context', () => {
    expect(teamAttachmentsFor(FINAL_REVIEW_AGENT_TYPE, 'agent:builtin:final-reviewer' as never)).toEqual({
      mailbox: false,
      teamContext: false,
    })
    expect(teamAttachmentsFor('general-purpose', 'repl_main_thread')).toEqual({ mailbox: true, teamContext: true })
    expect(teamAttachmentsFor(undefined, 'session_memory')).toEqual({ mailbox: false, teamContext: true })
  })
})
