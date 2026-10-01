import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Load the tool graph before agentToolUtils (see the note in
// agentToolUtils.verificationVerdict.test.ts: import-cycle TDZ otherwise).
import '../../constants/tools.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  getFinalReviewsDir,
  readFinalReview,
  recordFinalReview,
} from '../../utils/finalReviews.js'
import { createTask, getTask, listTasks } from '../../utils/tasks.js'
import {
  type AgentToolResult,
  checkFinalReviewIdentity,
  clearFinalReviewBeforeRun,
  formatFinalReviewLine,
  isBuiltInFinalReviewRun,
  recordFinalReviewIfApplicable,
} from './agentToolUtils.js'
import { FINAL_REVIEW_AGENT_TYPE } from './constants.js'

// Phase 4: a finished built-in final-reviewer run has its report parsed,
// self-checked against the checkout it was given, recorded under its
// agentId, and its GAPs filed as tasks. The hook must never throw.

const LIST = 'final-review-hook-list'
const REVIEWER_ID = 'a0000reviewer01'
const SHA = 'c'.repeat(40)
const WT = '/tmp/openclaude-final-review-x/checkout'
const TARGET = { commit: SHA, worktreePath: WT }
const IDENTITY = `REVIEW CWD: ${WT}\nREVIEW HEAD: ${SHA}\n`
const GAP1 =
  'GAP-001 | severity=critical | requirement=json flag | expected=JSON | observed=text | evidence=cli.ts:1'
const GAP2 =
  'GAP-002 | severity=minor | requirement=docs | expected=README | observed=none | evidence=README.md'

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/agentToolUtils.finalReview.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-final-review-hook-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
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
  } finally {
    releaseSharedMutationLock()
  }
})

function makeResult(
  text: string,
  agentType: string | undefined = FINAL_REVIEW_AGENT_TYPE,
): AgentToolResult {
  return {
    agentId: REVIEWER_ID,
    agentType,
    content: [{ type: 'text' as const, text }],
    totalToolUseCount: 3,
    totalDurationMs: 1000,
    totalTokens: 100,
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

const BUILT_IN = { isBuiltInAgent: true, finalReview: TARGET, resolvedAgentModel: 'review-model' }

describe('isBuiltInFinalReviewRun', () => {
  test('only the built-in final reviewer counts', () => {
    expect(isBuiltInFinalReviewRun({ agentType: FINAL_REVIEW_AGENT_TYPE, isBuiltInAgent: true })).toBe(true)
    expect(isBuiltInFinalReviewRun({ agentType: FINAL_REVIEW_AGENT_TYPE, isBuiltInAgent: false })).toBe(false)
    expect(isBuiltInFinalReviewRun({ agentType: 'verification', isBuiltInAgent: true })).toBe(false)
  })
})

describe('recordFinalReviewIfApplicable', () => {
  test('DONE with a matching checkout is recorded with commit and model', async () => {
    const result = makeResult(`${IDENTITY}All delivered.\nFINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReview).toBe('DONE')
    expect(result.finalReviewRecorded).toBe(true)
    expect(await readFinalReview(REVIEWER_ID, LIST)).toMatchObject({
      result: 'DONE',
      commit: SHA,
      model: 'review-model',
      gaps: [],
    })
    expect(formatFinalReviewLine(result)).toContain(
      `finalReview: DONE (recorded for this agentId at commit ${SHA}; to complete a task with requiresFinalReview, set metadata.finalReviewedBy: '${REVIEWER_ID}'`,
    )
    expect(await listTasks(LIST)).toEqual([])
  })

  test.each([
    ['a wrong REVIEW HEAD', `REVIEW CWD: ${WT}\nREVIEW HEAD: ${'d'.repeat(40)}\nFINAL REVIEW: DONE`, /REVIEW HEAD d+ is not the reviewed commit/],
    ['a wrong REVIEW CWD', `REVIEW CWD: /home/user/repo\nREVIEW HEAD: ${SHA}\nFINAL REVIEW: DONE`, /REVIEW CWD \/home\/user\/repo is not the review checkout/],
    ['no REVIEW HEAD line', `REVIEW CWD: ${WT}\nFINAL REVIEW: DONE`, /no "REVIEW HEAD/],
    ['no REVIEW CWD line', `REVIEW HEAD: ${SHA}\nFINAL REVIEW: DONE`, /no "REVIEW CWD/],
    ['a second, conflicting REVIEW HEAD', `${IDENTITY}REVIEW HEAD: ${'e'.repeat(40)}\nFINAL REVIEW: DONE`, /is not the reviewed commit/],
  ])('%s records MISSING with the reason, never DONE', async (_label, text, reason) => {
    const result = makeResult(text)
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReview).toBe('MISSING')
    expect(result.finalReviewReason).toMatch(reason)
    const record = await readFinalReview(REVIEWER_ID, LIST)
    expect(record?.result).toBe('MISSING')
    expect(record?.reason).toMatch(reason)
    expect(formatFinalReviewLine(result)).toContain('finalReview: MISSING (recorded for this agentId')
  })

  test('a trailing slash on REVIEW CWD is tolerated', async () => {
    const result = makeResult(`REVIEW CWD: ${WT}/\nREVIEW HEAD: ${SHA}\nFINAL REVIEW: DONE`)
    expect(checkFinalReviewIdentity(`REVIEW CWD: ${WT}/\nREVIEW HEAD: ${SHA}`, TARGET)).toBeUndefined()
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReview).toBe('DONE')
  })

  test('a run with no checkout records MISSING', async () => {
    const result = makeResult(`${IDENTITY}FINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(result, { isBuiltInAgent: true })
    expect(result.finalReview).toBe('MISSING')
    expect((await readFinalReview(REVIEWER_ID, LIST))?.reason).toContain('no review checkout')
  })

  test('a malformed report records MISSING with the parser reason', async () => {
    const result = makeResult(`${IDENTITY}${GAP1}\nFINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReview).toBe('MISSING')
    expect(result.finalReviewReason).toContain('ends with DONE but lists GAP lines')
  })

  test('GAPS files one task per GAP, blocking open flagged tasks, exactly once across re-records', async () => {
    const flagged = await createTask(LIST, {
      subject: 'the request',
      description: '',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      metadata: { requiresFinalReview: true },
    })
    const text = `${IDENTITY}${GAP1}\n${GAP2}\nFINAL REVIEW: GAPS`
    const result = makeResult(text)
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReview).toBe('GAPS')
    expect(result.finalReviewGapTaskIds).toHaveLength(2)
    const record = await readFinalReview(REVIEWER_ID, LIST)
    expect(record?.gaps.map(g => g.id)).toEqual(['GAP-001', 'GAP-002'])
    const line = formatFinalReviewLine(result)!
    for (const id of result.finalReviewGapTaskIds!) expect(line).toContain(`#${id}`)
    expect((await getTask(LIST, flagged))?.blockedBy.sort()).toEqual(
      [...result.finalReviewGapTaskIds!].sort(),
    )

    // A resumed run records the same review again: no duplicate GAP tasks.
    const again = makeResult(text)
    await recordFinalReviewIfApplicable(again, BUILT_IN)
    expect(again.finalReviewGapTaskIds).toEqual(result.finalReviewGapTaskIds)
    const gapTasks = (await listTasks(LIST)).filter(t => t.metadata?.gapOf === REVIEWER_ID)
    expect(gapTasks).toHaveLength(2)
  })

  test('a custom agent overriding the name records nothing', async () => {
    const result = makeResult(`${IDENTITY}FINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(result, { ...BUILT_IN, isBuiltInAgent: false })
    expect(result.finalReview).toBeUndefined()
    expect(await readFinalReview(REVIEWER_ID, LIST)).toBeUndefined()
    expect(formatFinalReviewLine(result)).toBeUndefined()
  })

  test('a failed write never throws and reports NOT recorded', async () => {
    mkdirSync(join(getFinalReviewsDir(LIST), '..'), { recursive: true })
    writeFileSync(getFinalReviewsDir(LIST), 'not a directory')
    const result = makeResult(`${IDENTITY}FINAL REVIEW: DONE`)
    await recordFinalReviewIfApplicable(result, BUILT_IN)
    expect(result.finalReviewRecorded).toBe(false)
    expect(formatFinalReviewLine(result)).toContain('finalReview: DONE (NOT recorded:')
  })
})

describe('clearFinalReviewBeforeRun', () => {
  test('clears a stale record for the built-in reviewer only', async () => {
    await recordFinalReview({ agentId: REVIEWER_ID, result: 'DONE', gaps: [], commit: SHA }, LIST)
    await clearFinalReviewBeforeRun(REVIEWER_ID, { agentType: 'verification', isBuiltInAgent: true })
    expect(await readFinalReview(REVIEWER_ID, LIST)).toBeDefined()
    await clearFinalReviewBeforeRun(REVIEWER_ID, { agentType: FINAL_REVIEW_AGENT_TYPE, isBuiltInAgent: true })
    expect(await readFinalReview(REVIEWER_ID, LIST)).toBeUndefined()
  })

  test('throws (refusing to run) when the stale record cannot be removed', async () => {
    // A directory where the record file should be: unlink fails with EISDIR/EPERM.
    const path = join(getFinalReviewsDir(LIST))
    mkdirSync(path, { recursive: true })
    const { getFinalReviewPath } = await import('../../utils/finalReviews.js')
    mkdirSync(join(getFinalReviewPath(REVIEWER_ID, LIST), 'x'), { recursive: true })
    await expect(
      clearFinalReviewBeforeRun(REVIEWER_ID, { agentType: FINAL_REVIEW_AGENT_TYPE, isBuiltInAgent: true }),
    ).rejects.toThrow(/Refusing to run/)
  })
})
