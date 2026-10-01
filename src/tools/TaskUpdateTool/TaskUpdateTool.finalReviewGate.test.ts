import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { fileGapTasks, recordFinalReview } from '../../utils/finalReviews.js'
import { createTask, getTask, updateTask } from '../../utils/tasks.js'
import { recordVerdict } from '../../utils/verificationVerdicts.js'
import { TaskUpdateTool, type Output } from './TaskUpdateTool.js'

// Phase 4: a task flagged requiresFinalReview can only be completed through
// TaskUpdate when metadata.finalReviewedBy names a final reviewer that
// recorded DONE and no GAP task filed against it is still open.

const LIST = 'final-review-gate-list'
const REVIEWER = 'a0000reviewer01'
const SHA = 'b'.repeat(40)

let configDir: string | undefined
let previousListId: string | undefined
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TaskUpdateTool/TaskUpdateTool.finalReviewGate.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-final-review-gate-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
})

afterEach(() => {
  try {
    clearRegisteredHooks()
    if (previousRegisteredHooks) registerHookCallbacks(previousRegisteredHooks)
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

function makeContext(): ToolUseContext {
  return {
    getAppState: () => ({ sessionHooks: new Map() }),
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model', tools: [] },
  } as unknown as ToolUseContext
}

async function seedTask(metadata?: Record<string, unknown>): Promise<string> {
  return createTask(LIST, {
    subject: 'deliver the request',
    description: 'the work',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
    ...(metadata ? { metadata } : {}),
  })
}

async function complete(
  taskId: string,
  metadata?: Record<string, unknown>,
): Promise<Output> {
  const result = await TaskUpdateTool.call(
    { taskId, status: 'completed', ...(metadata ? { metadata } : {}) },
    makeContext(),
  )
  return (result as { data: Output }).data
}

function done(agentId = REVIEWER) {
  return recordFinalReview(
    { agentId, result: 'DONE', gaps: [], commit: SHA },
    LIST,
  )
}

describe('TaskUpdate final-review gate', () => {
  test('DONE allows completion, finalReviewedBy set in the same call', async () => {
    const id = await seedTask({ requiresFinalReview: true })
    await done()
    const data = await complete(id, { finalReviewedBy: REVIEWER })
    expect(data.success).toBe(true)
    expect((await getTask(LIST, id))?.status).toBe('completed')
  })

  test('GAPS blocks completion and writes nothing', async () => {
    const id = await seedTask({ requiresFinalReview: true })
    await recordFinalReview(
      {
        agentId: REVIEWER,
        result: 'GAPS',
        gaps: [
          {
            id: 'GAP-001',
            severity: 'major',
            requirement: 'r',
            expected: 'e',
            observed: 'o',
            evidence: 'v',
          },
        ],
        commit: SHA,
      },
      LIST,
    )
    const before = await getTask(LIST, id)
    const data = await complete(id, { finalReviewedBy: REVIEWER })
    expect(data.success).toBe(false)
    expect(data.error).toContain('recorded GAPS (GAP-001)')
    expect(data.updatedFields).toEqual([])
    expect(await getTask(LIST, id)).toEqual(before)
  })

  test('an open GAP task blocks completion with a DONE review', async () => {
    const id = await seedTask({ requiresFinalReview: true })
    const [gapId] = await fileGapTasks(
      'a0000reviewer00',
      [
        {
          id: 'GAP-001',
          severity: 'critical',
          requirement: 'flag',
          expected: 'e',
          observed: 'o',
          evidence: 'v',
        },
      ],
      LIST,
    )
    await done()
    const data = await complete(id, { finalReviewedBy: REVIEWER })
    expect(data.success).toBe(false)
    expect(data.error).toContain(`#${gapId} (GAP-001: flag)`)

    await updateTask(LIST, gapId!, { status: 'completed' })
    expect((await complete(id, { finalReviewedBy: REVIEWER })).success).toBe(true)
  })

  test('clearing the flag in the completing call does not bypass it', async () => {
    const id = await seedTask({ requiresFinalReview: true })
    const data = await complete(id, { requiresFinalReview: null })
    expect(data.success).toBe(false)
    expect(data.error).toContain('metadata.finalReviewedBy is not set')
  })

  test('both gates: verification reported first, then final review', async () => {
    const id = await seedTask({
      requiresVerification: true,
      requiresFinalReview: true,
    })
    await done()
    const first = await complete(id, { finalReviewedBy: REVIEWER })
    expect(first.error).toContain('metadata.verifiedBy is not set')
    await recordVerdict({ agentId: 'v1', verdict: 'PASS' }, LIST)
    const second = await complete(id, { verifiedBy: 'v1' })
    expect(second.error).toContain('metadata.finalReviewedBy is not set')
    const third = await complete(id, {
      verifiedBy: 'v1',
      finalReviewedBy: REVIEWER,
    })
    expect(third.success).toBe(true)
  })

  test('a TaskCompleted hook that adds the flag mid-completion is caught by the locked write', async () => {
    const previousInteractive = getIsInteractive()
    const previousSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
    setIsInteractive(false)
    delete process.env.CLAUDE_CODE_SIMPLE
    try {
      const id = await seedTask()
      let hookRan = false
      registerHookCallbacks({
        TaskCompleted: [
          {
            hooks: [
              {
                type: 'callback',
                callback: async () => {
                  hookRan = true
                  await updateTask(LIST, id, {
                    metadata: { requiresFinalReview: true },
                  })
                  return {}
                },
              },
            ],
          },
        ],
      })
      const data = await complete(id)
      expect(hookRan).toBe(true)
      expect(data.success).toBe(false)
      expect(data.error).toContain('metadata.finalReviewedBy is not set')
      expect((await getTask(LIST, id))?.status).toBe('in_progress')
    } finally {
      setIsInteractive(previousInteractive)
      if (previousSimpleEnv === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = previousSimpleEnv
      }
    }
  })
})
