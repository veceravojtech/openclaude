import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearRegisteredHooks,
  getRegisteredHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { createTask, getTask, type Task } from '../../utils/tasks.js'
import {
  type ParsedVerdict,
  recordVerdict,
} from '../../utils/verificationVerdicts.js'
import { TaskUpdateTool, type Output } from './TaskUpdateTool.js'

// Phase 1: a task flagged requiresVerification can only be completed when
// metadata.verifiedBy names a verifier whose recorded verdict is PASS.

const LIST = 'verification-gate-list'
const VERIFIER = 'a0000verifier01'

let configDir: string | undefined
let previousListId: string | undefined
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TaskUpdateTool/TaskUpdateTool.verificationGate.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-verdict-gate-'))
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
    getAppState: () => ({}),
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model', tools: [] },
  } as unknown as ToolUseContext
}

async function seedTask(metadata?: Record<string, unknown>): Promise<string> {
  return createTask(LIST, {
    subject: 'ship the feature',
    description: 'the work',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
    ...(metadata ? { metadata } : {}),
  })
}

async function complete(
  taskId: string,
  extra: { metadata?: Record<string, unknown>; subject?: string } = {},
): Promise<Output> {
  const result = await TaskUpdateTool.call(
    { taskId, status: 'completed', ...extra },
    makeContext(),
  )
  return (result as { data: Output }).data
}

function resultText(data: Output): string {
  const block = TaskUpdateTool.mapToolResultToToolResultBlockParam(
    data,
    'tool-use-id',
  )
  return String(block.content)
}

async function expectUnchanged(taskId: string, before: Task | null) {
  expect(await getTask(LIST, taskId)).toEqual(before)
}

describe('TaskUpdate verification gate', () => {
  test('PASS verdict allows completion', async () => {
    const id = await seedTask({ requiresVerification: true, verifiedBy: VERIFIER })
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)

    const data = await complete(id)

    expect(data.success).toBe(true)
    expect(data.statusChange).toEqual({ from: 'in_progress', to: 'completed' })
    expect((await getTask(LIST, id))?.status).toBe('completed')
  })

  test.each([
    ['FAIL', /recorded verdict FAIL/],
    ['PARTIAL', /recorded verdict PARTIAL/],
    ['MISSING', /recorded verdict MISSING/],
  ] as const)(
    '%s verdict blocks completion and writes nothing',
    async (verdict, pattern) => {
      const id = await seedTask({
        requiresVerification: true,
        verifiedBy: VERIFIER,
      })
      await recordVerdict({ agentId: VERIFIER, verdict: verdict as ParsedVerdict }, LIST)
      const before = await getTask(LIST, id)

      // Also try to sneak another field change into the blocked call.
      const data = await complete(id, { subject: 'renamed' })

      expect(data.success).toBe(false)
      expect(data.updatedFields).toEqual([])
      expect(data.error).toMatch(pattern)
      expect(data.error).toMatch(/re-run the verification agent/)
      expect(resultText(data)).toBe(data.error!)
      await expectUnchanged(id, before)
    },
  )

  test('unknown verifier agentId blocks completion', async () => {
    const id = await seedTask({
      requiresVerification: true,
      verifiedBy: 'never-ran',
    })
    const before = await getTask(LIST, id)

    const data = await complete(id)

    expect(data.success).toBe(false)
    expect(data.error).toMatch(/no verdict was recorded for verifier 'never-ran'/)
    await expectUnchanged(id, before)
  })

  test('missing verifiedBy blocks completion', async () => {
    const id = await seedTask({ requiresVerification: true })
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    const before = await getTask(LIST, id)

    const data = await complete(id)

    expect(data.success).toBe(false)
    expect(data.error).toMatch(/metadata\.verifiedBy is not set/)
    await expectUnchanged(id, before)
  })

  test('clearing verifiedBy (null) in the same call blocks completion', async () => {
    const id = await seedTask({ requiresVerification: true, verifiedBy: VERIFIER })
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    const before = await getTask(LIST, id)

    const data = await complete(id, { metadata: { verifiedBy: null } })

    expect(data.success).toBe(false)
    expect(data.error).toMatch(/metadata\.verifiedBy is not set/)
    await expectUnchanged(id, before)
  })

  test.each([[null], [false]] as const)(
    'clearing requiresVerification (%p) in the completing call cannot bypass the gate',
    async value => {
      const id = await seedTask({ requiresVerification: true })
      const before = await getTask(LIST, id)

      const data = await complete(id, {
        metadata: { requiresVerification: value },
      })

      expect(data.success).toBe(false)
      expect(data.error).toMatch(/metadata\.verifiedBy is not set/)
      await expectUnchanged(id, before)
    },
  )

  test('an unflagged task completes exactly as before', async () => {
    const id = await seedTask()

    const data = await complete(id)

    expect(data.success).toBe(true)
    expect(data.updatedFields).toEqual(['status'])
    expect((await getTask(LIST, id))?.status).toBe('completed')
  })

  test('requiresVerification: false is treated as unflagged', async () => {
    const id = await seedTask({ requiresVerification: false })
    expect((await complete(id)).success).toBe(true)
  })

  test('verifiedBy supplied in the same call is honoured', async () => {
    const id = await seedTask({ requiresVerification: true })
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)

    const data = await complete(id, { metadata: { verifiedBy: VERIFIER } })

    expect(data.success).toBe(true)
    const task = await getTask(LIST, id)
    expect(task?.status).toBe('completed')
    expect(task?.metadata).toEqual({
      requiresVerification: true,
      verifiedBy: VERIFIER,
    })
  })

  test('requiresVerification set in the same call is enforced', async () => {
    const id = await seedTask()
    const before = await getTask(LIST, id)

    const blocked = await complete(id, {
      metadata: { requiresVerification: true },
    })
    expect(blocked.success).toBe(false)
    await expectUnchanged(id, before)

    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    const allowed = await complete(id, {
      metadata: { requiresVerification: true, verifiedBy: VERIFIER },
    })
    expect(allowed.success).toBe(true)
    expect((await getTask(LIST, id))?.status).toBe('completed')
  })

  test('a FAIL followed by a re-verification PASS from a new verifier allows completion', async () => {
    const id = await seedTask({ requiresVerification: true, verifiedBy: VERIFIER })
    await recordVerdict({ agentId: VERIFIER, verdict: 'FAIL' }, LIST)
    expect((await complete(id)).success).toBe(false)

    await recordVerdict({ agentId: 'a0000verifier02', verdict: 'PASS' }, LIST)
    const data = await complete(id, {
      metadata: { verifiedBy: 'a0000verifier02' },
    })
    expect(data.success).toBe(true)
  })

  test('non-completion status changes are not gated', async () => {
    const id = await seedTask({ requiresVerification: true })
    const result = await TaskUpdateTool.call(
      { taskId: id, status: 'pending' },
      makeContext(),
    )
    expect((result as { data: Output }).data.success).toBe(true)
    expect((await getTask(LIST, id))?.status).toBe('pending')
  })
})
