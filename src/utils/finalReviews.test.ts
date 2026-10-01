import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import {
  checkFinalReviewGateIn,
  finalReviewersOf,
} from './finalReviewStore.js'
import {
  clearFinalReview,
  fileGapTasks,
  type FinalReviewGap,
  FinalReviewGateError,
  getFinalReviewPath,
  getFinalReviewsDir,
  parseFinalReview,
  parseReviewIdentity,
  readFinalReview,
  recordFinalReview,
} from './finalReviews.js'
import {
  cancelTask,
  createTask,
  getTask,
  getTasksDir,
  listTasks,
  TaskCancelError,
  updateTask,
} from './tasks.js'
import { recordVerdict, VerificationGateError } from './verificationVerdicts.js'

const GAP1 =
  'GAP-001 | severity=critical | requirement=CLI flag --json | expected=prints JSON | observed=prints text | evidence=src/cli.ts:10'
const GAP2 =
  'GAP-002 | severity=minor | requirement=docs | expected=README section | observed=missing | evidence=README.md has no section'

describe('parseFinalReview', () => {
  test('DONE with no GAP lines', () => {
    expect(
      parseFinalReview('REVIEW CWD: /x\nREVIEW HEAD: abc\nAll good.\nFINAL REVIEW: DONE\n\n'),
    ).toEqual({ result: 'DONE' })
  })

  test('GAPS with valid GAP lines, fields trimmed, pipes allowed in evidence', () => {
    const evidence =
      'GAP-003 | severity=major | requirement=tests | expected=pass | observed=fail | evidence=bun test | tail: 2 fail'
    const parsed = parseFinalReview(
      `Summary\n${GAP1}\n${GAP2}\n${evidence}\nFINAL REVIEW: GAPS  \r\n`,
    )
    expect(parsed.result).toBe('GAPS')
    if (parsed.result !== 'GAPS') return
    expect(parsed.gaps.map(g => g.id)).toEqual(['GAP-001', 'GAP-002', 'GAP-003'])
    expect(parsed.gaps[0]).toEqual({
      id: 'GAP-001',
      severity: 'critical',
      requirement: 'CLI flag --json',
      expected: 'prints JSON',
      observed: 'prints text',
      evidence: 'src/cli.ts:10',
    })
    expect(parsed.gaps[2]!.evidence).toBe('bun test | tail: 2 fail')
  })

  test.each([
    ['empty text', ''],
    ['no final line', `${GAP1}\nsummary only`],
    ['DONE together with a GAP line', `${GAP1}\nFINAL REVIEW: DONE`],
    ['DONE together with a bulleted GAP line', `- ${GAP1}\nFINAL REVIEW: DONE`],
    ['GAPS with zero GAP lines', 'found problems\nFINAL REVIEW: GAPS'],
    ['GAP line missing a field', 'GAP-001 | severity=major | requirement=x | expected=y | observed=z\nFINAL REVIEW: GAPS'],
    ['GAP line with an empty field', 'GAP-001 | severity=major | requirement=  | expected=y | observed=z | evidence=e\nFINAL REVIEW: GAPS'],
    ['GAP line with invalid severity', 'GAP-001 | severity=blocker | requirement=x | expected=y | observed=z | evidence=e\nFINAL REVIEW: GAPS'],
    ['GAP line with a bad id', 'GAP-1 | severity=major | requirement=x | expected=y | observed=z | evidence=e\nFINAL REVIEW: GAPS'],
    ['GAP line with fields out of order', 'GAP-001 | requirement=x | severity=major | expected=y | observed=z | evidence=e\nFINAL REVIEW: GAPS'],
    ['indented GAP line', `  ${GAP1}\nFINAL REVIEW: GAPS`],
    ['a valid GAP plus a malformed one', `${GAP1}\n* GAP-002 something\nFINAL REVIEW: GAPS`],
    ['duplicate GAP ids', `${GAP1}\n${GAP1.replace('critical', 'minor')}\nFINAL REVIEW: GAPS`],
    ['bold final line', '**FINAL REVIEW: DONE**'],
    ['backticked final line', '`FINAL REVIEW: DONE`'],
    ['final line with punctuation', 'FINAL REVIEW: DONE.'],
    ['lowercase final line', 'final review: done'],
    ['indented final line', '  FINAL REVIEW: DONE'],
    ['final line with extra text', 'FINAL REVIEW: DONE (all good)'],
    ['DONE not on the last non-empty line', 'FINAL REVIEW: DONE\nthanks'],
  ])('%s is MISSING', (_label, text) => {
    const parsed = parseFinalReview(text)
    expect(parsed.result).toBe('MISSING')
    if (parsed.result === 'MISSING') expect(parsed.reason.length).toBeGreaterThan(0)
  })

  test('parseReviewIdentity collects every REVIEW CWD / REVIEW HEAD line', () => {
    expect(
      parseReviewIdentity(
        'REVIEW CWD: /tmp/a\nx\nREVIEW HEAD: abc  \nREVIEW HEAD: def\n REVIEW CWD: /no',
      ),
    ).toEqual({ cwds: ['/tmp/a'], heads: ['abc', 'def'] })
  })
})

const LIST = 'final-review-list'
const REVIEWER = 'a0000reviewer01'
const OLD_REVIEWER = 'a0000reviewer00'
const VERIFIER = 'a0000verifier01'
const SHA = 'a'.repeat(40)

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/finalReviews.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-final-review-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function gap(id: string, requirement = 'req'): FinalReviewGap {
  return {
    id,
    severity: 'major',
    requirement,
    expected: 'e',
    observed: 'o',
    evidence: 'ev',
  }
}

async function record(
  agentId: string,
  result: 'DONE' | 'GAPS' | 'MISSING',
  gaps: FinalReviewGap[] = [],
) {
  return recordFinalReview(
    {
      agentId,
      result,
      gaps,
      commit: SHA,
      ...(result === 'MISSING' ? { reason: 'no final line' } : {}),
    },
    LIST,
  )
}

async function flaggedTask(metadata: Record<string, unknown> = {}) {
  return createTask(LIST, {
    subject: 'Deliver the request',
    description: '',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
    metadata: { requiresFinalReview: true, ...metadata },
  })
}

async function complete(id: string, metadata?: Record<string, unknown>) {
  const existing = await getTask(LIST, id)
  return updateTask(LIST, id, {
    status: 'completed',
    ...(metadata ? { metadata: { ...(existing?.metadata ?? {}), ...metadata } } : {}),
  })
}

describe('final review store', () => {
  test('round-trips a record, keyed by agentId, and clears it', async () => {
    const written = await recordFinalReview(
      {
        agentId: REVIEWER,
        result: 'GAPS',
        gaps: [gap('GAP-001')],
        commit: SHA,
        model: 'some-model',
      },
      LIST,
    )
    expect(getFinalReviewPath(REVIEWER, LIST).startsWith(getFinalReviewsDir(LIST))).toBe(true)
    expect(getFinalReviewsDir(LIST)).toBe(join(getTasksDir(LIST), '.final-reviews'))
    expect(await readFinalReview(REVIEWER, LIST)).toEqual(written)
    expect(written).toMatchObject({ result: 'GAPS', commit: SHA, model: 'some-model' })
    expect(typeof written.recordedAt).toBe('string')
    await clearFinalReview(REVIEWER, LIST)
    expect(await readFinalReview(REVIEWER, LIST)).toBeUndefined()
    await clearFinalReview(REVIEWER, LIST) // missing is fine
  })

  test('a record embedding a different agentId, or malformed, is ignored', async () => {
    mkdirSync(getFinalReviewsDir(LIST), { recursive: true })
    writeFileSync(
      getFinalReviewPath(REVIEWER, LIST),
      JSON.stringify({ agentId: 'someone-else', result: 'DONE', gaps: [], commit: SHA, recordedAt: 'x' }),
    )
    expect(await readFinalReview(REVIEWER, LIST)).toBeUndefined()
    writeFileSync(getFinalReviewPath(REVIEWER, LIST), '{not json')
    expect(await readFinalReview(REVIEWER, LIST)).toBeUndefined()
  })
})

describe('final review gate (updateTask)', () => {
  test('DONE allows completion', async () => {
    const id = await flaggedTask()
    await record(REVIEWER, 'DONE')
    const done = await complete(id, { finalReviewedBy: REVIEWER })
    expect(done?.status).toBe('completed')
  })

  test.each([
    ['GAPS', async () => record(REVIEWER, 'GAPS', [gap('GAP-001')]), /recorded GAPS \(GAP-001\)/],
    ['MISSING', async () => record(REVIEWER, 'MISSING'), /recorded MISSING \(no final line\)/],
    ['an unknown reviewer id', async () => {}, /no final review was recorded for reviewer/],
  ])('%s blocks completion and writes nothing', async (_label, setup, message) => {
    const id = await flaggedTask()
    await setup()
    const error = await complete(id, { finalReviewedBy: REVIEWER }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
    expect(String(error.message)).toMatch(message)
    expect(String(error.message)).toContain('subagent_type="final-reviewer"')
    expect((await getTask(LIST, id))?.status).toBe('in_progress')
  })

  test('a missing finalReviewedBy blocks completion', async () => {
    const id = await flaggedTask()
    await record(REVIEWER, 'DONE')
    const error = await complete(id).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
    expect(error.message).toContain('metadata.finalReviewedBy is not set')
  })

  test('an unflagged task is unaffected', async () => {
    const id = await createTask(LIST, {
      subject: 'plain',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    expect((await complete(id))?.status).toBe('completed')
  })

  test('clearing the flag in the completing write does not bypass the gate', async () => {
    const id = await flaggedTask()
    const error = await updateTask(LIST, id, {
      status: 'completed',
      metadata: {},
    }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
  })

  test('the flag added only in the completing write is honoured too', async () => {
    const id = await createTask(LIST, {
      subject: 'plain',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const error = await updateTask(LIST, id, {
      status: 'completed',
      metadata: { requiresFinalReview: true },
    }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
  })

  test('an open gapOf task of an earlier reviewer blocks completion even with a DONE review; resolving it allows completion', async () => {
    const id = await flaggedTask()
    await record(OLD_REVIEWER, 'GAPS', [gap('GAP-001', 'the flag')])
    const [gapTask] = await fileGapTasks(OLD_REVIEWER, [gap('GAP-001', 'the flag')], LIST)
    await record(REVIEWER, 'DONE')

    const error = await complete(id, { finalReviewedBy: REVIEWER }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
    expect(error.message).toContain(`#${gapTask} (GAP-001: the flag)`)
    expect((await getTask(LIST, id))?.status).toBe('in_progress')

    await updateTask(LIST, gapTask!, { status: 'completed' })
    expect((await complete(id, { finalReviewedBy: REVIEWER }))?.status).toBe('completed')
  })

  test('a cancelled gapOf task counts as resolved', async () => {
    const id = await flaggedTask()
    const [gapTask] = await fileGapTasks(OLD_REVIEWER, [gap('GAP-001')], LIST)
    await record(REVIEWER, 'DONE')
    await cancelTask(LIST, gapTask!)
    expect((await complete(id, { finalReviewedBy: REVIEWER }))?.status).toBe('completed')
  })

  test('removing finalReviewers in the completing write does not hide open GAP tasks', async () => {
    const id = await flaggedTask()
    await fileGapTasks(OLD_REVIEWER, [gap('GAP-001')], LIST)
    await record(REVIEWER, 'DONE')
    const error = await updateTask(LIST, id, {
      status: 'completed',
      metadata: { requiresFinalReview: true, finalReviewedBy: REVIEWER },
    }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
  })

  test('finalReviewersOf unions stored and resulting metadata', () => {
    expect(
      finalReviewersOf(
        { finalReviewers: ['a', 'b'], finalReviewedBy: 'c' },
        { finalReviewers: ['b', 'd'], finalReviewedBy: ' ' },
      ).sort(),
    ).toEqual(['a', 'b', 'c', 'd'])
  })

  test('the gate check alone (no flag) returns undefined', async () => {
    expect(await checkFinalReviewGateIn(getTasksDir(LIST), {}, {})).toBeUndefined()
  })
})

describe('combined completion gates', () => {
  async function bothFlagged() {
    return flaggedTask({ requiresVerification: true })
  }

  test('verification is checked first', async () => {
    const id = await bothFlagged()
    await record(REVIEWER, 'DONE')
    const error = await complete(id, { finalReviewedBy: REVIEWER }).catch(e => e)
    expect(error).toBeInstanceOf(VerificationGateError)
  })

  test('a PASS verdict alone is not enough when final review is also required', async () => {
    const id = await bothFlagged()
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    const error = await complete(id, { verifiedBy: VERIFIER }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
  })

  test('PASS + DONE completes', async () => {
    const id = await bothFlagged()
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    await record(REVIEWER, 'DONE')
    const done = await complete(id, { verifiedBy: VERIFIER, finalReviewedBy: REVIEWER })
    expect(done?.status).toBe('completed')
  })
})

describe('fileGapTasks', () => {
  test('files one task per GAP, blocks every open flagged task, and is idempotent', async () => {
    const flaggedA = await flaggedTask()
    const flaggedB = await flaggedTask()
    const done = await flaggedTask()
    await record(OLD_REVIEWER, 'DONE')
    await updateTask(LIST, done, {
      status: 'completed',
      metadata: { requiresFinalReview: true, finalReviewedBy: OLD_REVIEWER },
    })
    const unflagged = await createTask(LIST, {
      subject: 'other',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    const gaps = [gap('GAP-001', 'one'), gap('GAP-002', 'two')]
    const ids = await fileGapTasks(REVIEWER, gaps, LIST)
    expect(ids).toHaveLength(2)
    const first = await getTask(LIST, ids[0]!)
    expect(first).toMatchObject({
      subject: 'GAP-001: one',
      status: 'pending',
      metadata: {
        gapOf: REVIEWER,
        gapId: 'GAP-001',
        severity: 'major',
        source: 'final-review',
      },
    })
    expect(first?.description).toContain('Expected: e')
    expect(first?.blocks.sort()).toEqual([flaggedA, flaggedB].sort())
    for (const flagged of [flaggedA, flaggedB]) {
      const task = await getTask(LIST, flagged)
      expect(task?.blockedBy.sort()).toEqual([...ids].sort())
      expect(task?.metadata?.finalReviewers).toEqual([REVIEWER])
    }
    expect((await getTask(LIST, done))?.blockedBy).toEqual([])
    expect((await getTask(LIST, unflagged))?.blockedBy).toEqual([])

    // Re-recording the same review files nothing new.
    const again = await fileGapTasks(REVIEWER, gaps, LIST)
    expect(again).toEqual(ids)
    const gapTasks = (await listTasks(LIST)).filter(t => t.metadata?.gapOf === REVIEWER)
    expect(gapTasks).toHaveLength(2)
    expect((await getTask(LIST, flaggedA))?.metadata?.finalReviewers).toEqual([REVIEWER])
  })
})

describe('cancel / supersede inheritance', () => {
  test('the replacement inherits requiresFinalReview and finalReviewers, not finalReviewedBy', async () => {
    const old = await flaggedTask({ finalReviewedBy: REVIEWER })
    const [gapTask] = await fileGapTasks(OLD_REVIEWER, [gap('GAP-001')], LIST)
    const replacement = await createTask(LIST, {
      subject: 'redo',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    await cancelTask(LIST, old, { supersededBy: replacement })
    const task = await getTask(LIST, replacement)
    expect(task?.metadata?.requiresFinalReview).toBe(true)
    expect(task?.metadata?.finalReviewers).toEqual([OLD_REVIEWER])
    expect(task?.metadata?.finalReviewedBy).toBeUndefined()

    // The old reviewer's open GAP still blocks the replacement.
    await record(REVIEWER, 'DONE')
    const error = await complete(replacement, { finalReviewedBy: REVIEWER }).catch(e => e)
    expect(error).toBeInstanceOf(FinalReviewGateError)
    await updateTask(LIST, gapTask!, { status: 'completed' })
    expect((await complete(replacement, { finalReviewedBy: REVIEWER }))?.status).toBe('completed')
  })

  test('superseding by an unreviewed completed task is refused', async () => {
    const old = await flaggedTask()
    const replacement = await createTask(LIST, {
      subject: 'already done',
      description: '',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    const error = await cancelTask(LIST, old, { supersededBy: replacement }).catch(e => e)
    expect(error).toBeInstanceOf(TaskCancelError)
    expect(error.message).toContain('requires final review')
    expect(error.message).toContain('Final-review check on the replacement:')
    expect((await getTask(LIST, old))?.status).toBe('in_progress')
  })

  test('superseding by a completed task with a DONE review is allowed', async () => {
    const old = await flaggedTask()
    await record(REVIEWER, 'DONE')
    const replacement = await createTask(LIST, {
      subject: 'already done',
      description: '',
      status: 'completed',
      blocks: [],
      blockedBy: [],
      metadata: { finalReviewedBy: REVIEWER },
    })
    const cancelled = await cancelTask(LIST, old, { supersededBy: replacement })
    expect(cancelled.status).toBe('cancelled')
  })
})
