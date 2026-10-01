import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
// Load the tool graph before agentToolUtils (import-cycle TDZ otherwise).
import '../../constants/tools.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { listAttentionItems } from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { recordFinalReview } from '../../utils/finalReviews.js'
import { dequeueAll } from '../../utils/messageQueueManager.js'
import * as tasksModule from '../../utils/tasks.js'
import { createTask, getTask, getTasksDir, listTasks, updateTask } from '../../utils/tasks.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import {
  type AgentToolResult,
  formatFinalReviewLine,
  formatVerificationVerdictLine,
  recordFinalReviewIfApplicable,
  recordVerificationVerdictIfApplicable,
} from './agentToolUtils.js'
import { FINAL_REVIEW_AGENT_TYPE, VERIFICATION_AGENT_TYPE } from './constants.js'

// Phase 5 hooks on the Phase 1/4 recorders: a verdict other than PASS and a
// GAPS review each become an attention item for the root lead. Also Phase 4
// fix A: the reviewer is listed on the flagged tasks before (and whether or
// not) its GAP tasks get filed.

const LIST = 'attention-hooks-list'
const SHA = 'e'.repeat(40)
const WT = '/tmp/openclaude-attn-review/checkout'
const TARGET = { commit: SHA, worktreePath: WT }
const IDENTITY = `REVIEW CWD: ${WT}\nREVIEW HEAD: ${SHA}\n`
const GAP1 =
  'GAP-001 | severity=critical | requirement=json flag | expected=JSON | observed=text | evidence=cli.ts:1'
let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/agentToolUtils.attention.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attn-hooks-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
})

afterEach(() => {
  try {
    dequeueAll()
    if (previousListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function result(agentId: string, agentType: string, text: string): AgentToolResult {
  return {
    agentId,
    agentType,
    content: [{ type: 'text' as const, text }],
    totalToolUseCount: 1,
    totalDurationMs: 1,
    totalTokens: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  }
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

describe('verdict items', () => {
  test.each([
    ['FAIL', 'Broken.\nVERDICT: FAIL', 'returned VERDICT: FAIL'],
    ['PARTIAL', 'Half.\nVERDICT: PARTIAL', 'returned VERDICT: PARTIAL'],
    ['MISSING', 'I looked around.', 'gave no verdict'],
  ])('%s creates one verdict item', async (_verdict, text, summary) => {
    const r = result('a0verif0001', VERIFICATION_AGENT_TYPE, text)
    await recordVerificationVerdictIfApplicable(r, { isBuiltInAgent: true })
    const items = await listAttentionItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'verdict-a0verif0001',
      kind: 'verdict',
      transient: false,
      source: { agentId: 'a0verif0001' },
    })
    expect(items[0]!.summary).toContain(summary)
  })

  test('PASS creates none; a non-built-in verifier creates none; a teammate verifier creates none', async () => {
    await recordVerificationVerdictIfApplicable(result('a0verif0002', VERIFICATION_AGENT_TYPE, 'VERDICT: PASS'), { isBuiltInAgent: true })
    await recordVerificationVerdictIfApplicable(result('a0verif0003', VERIFICATION_AGENT_TYPE, 'VERDICT: FAIL'), { isBuiltInAgent: false })
    await asTeammate(() =>
      recordVerificationVerdictIfApplicable(result('a0verif0004', VERIFICATION_AGENT_TYPE, 'VERDICT: FAIL'), { isBuiltInAgent: true }),
    )
    expect(await listAttentionItems()).toEqual([])
  })

  test('a lost item write is visible: a line on the verdict and a notification', async () => {
    mkdirSync(getTasksDir(LIST), { recursive: true })
    writeFileSync(join(getTasksDir(LIST), '.attention'), 'not a directory')
    const r = result('a0verif0005', VERIFICATION_AGENT_TYPE, 'VERDICT: FAIL')
    await recordVerificationVerdictIfApplicable(r, { isBuiltInAgent: true })
    expect(r.verificationVerdictRecorded).toBe(true)
    expect(formatVerificationVerdictLine(r)).toContain('ATTENTION ITEM NOT RECORDED: verdict-a0verif0005')
    expect(dequeueAll().some(c => String(c.value).includes('ATTENTION ITEM NOT RECORDED'))).toBe(true)
  })
})

describe('gap items and Phase 4 fix A', () => {
  async function flaggedTask(): Promise<string> {
    return createTask(LIST, {
      subject: 'the feature',
      description: 'd',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      metadata: { requiresFinalReview: true },
    })
  }

  test('GAPS creates one gap item linked to the flagged tasks; DONE creates none', async () => {
    const flagged = await flaggedTask()
    const r = result('a0review001', FINAL_REVIEW_AGENT_TYPE, `${IDENTITY}${GAP1}\nFINAL REVIEW: GAPS`)
    await recordFinalReviewIfApplicable(r, { isBuiltInAgent: true, finalReview: TARGET })
    const items = await listAttentionItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'gap-a0review001',
      kind: 'gap',
      source: { agentId: 'a0review001', taskListTaskIds: [flagged] },
    })
    expect(items[0]!.summary).toContain('GAP-001 json flag')
    const done = result('a0review002', FINAL_REVIEW_AGENT_TYPE, `${IDENTITY}FINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(done, { isBuiltInAgent: true, finalReview: TARGET })
    expect(await listAttentionItems()).toHaveLength(1)
  })

  test('when filing GAP tasks fails, the reviewer is still listed and the GAPS result still gates completion', async () => {
    const flagged = await flaggedTask()
    const spy = spyOn(tasksModule, 'createTask').mockImplementation(async () => {
      throw new Error('disk full')
    })
    let r: AgentToolResult
    try {
      r = result('a0review003', FINAL_REVIEW_AGENT_TYPE, `${IDENTITY}${GAP1}\nFINAL REVIEW: GAPS`)
      await recordFinalReviewIfApplicable(r, { isBuiltInAgent: true, finalReview: TARGET })
    } finally {
      spy.mockRestore()
    }
    expect(r.finalReviewRecorded).toBe(true)
    expect(r.finalReviewGapTaskError).toContain('disk full')
    expect((await listTasks(LIST)).filter(t => t.metadata?.gapOf)).toEqual([])
    expect((await getTask(LIST, flagged))?.metadata?.finalReviewers).toEqual(['a0review003'])
    expect(formatFinalReviewLine(r)).toContain('GAP tasks could NOT all be filed')

    // A different reviewer's DONE cannot complete the task past the
    // unfiled GAP.
    await recordFinalReview({ agentId: 'a0review004', result: 'DONE', gaps: [], commit: SHA })
    await expect(
      updateTask(LIST, flagged, {
        status: 'completed',
        metadata: { ...(await getTask(LIST, flagged))!.metadata, finalReviewedBy: 'a0review004' },
      }),
    ).rejects.toThrow(/no GAP task yet: GAP-001 \(reviewer a0review003\)/)
  })

  test('a GAPS review inside a teammate still lists the reviewer but creates no item', async () => {
    const flagged = await flaggedTask()
    const r = result('a0review005', FINAL_REVIEW_AGENT_TYPE, `${IDENTITY}${GAP1}\nFINAL REVIEW: GAPS`)
    await asTeammate(() => recordFinalReviewIfApplicable(r, { isBuiltInAgent: true, finalReview: TARGET }))
    expect(await listAttentionItems()).toEqual([])
    expect((await getTask(LIST, flagged))?.metadata?.finalReviewers).toEqual(['a0review005'])
  })
})
