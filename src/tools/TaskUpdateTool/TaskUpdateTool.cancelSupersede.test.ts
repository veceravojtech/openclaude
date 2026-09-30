import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
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
import {
  cancelTask,
  claimTask,
  createTask,
  deleteTask,
  getTask,
  getTaskPath,
  getTasksDir,
  listTasks,
  type Task,
  TaskCancelError,
  TaskTransitionError,
  unassignTeammateTasks,
  updateTask,
} from '../../utils/tasks.js'
import { recordVerdict } from '../../utils/verificationVerdicts.js'
import { TaskListTool, type Output as ListOutput } from '../TaskListTool/TaskListTool.js'
import { TaskUpdateTool, type Output } from './TaskUpdateTool.js'

// Phase 2: replacing a task must not silently unblock downstream work.
// Cancel keeps the task (status 'cancelled') and releases its dependents;
// supersede re-points them to the replacement so they stay blocked.

const LIST = 'cancel-supersede-list'
const VERIFIER = 'a0000verifier02'

let configDir: string | undefined
let previousListId: string | undefined
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TaskUpdateTool/TaskUpdateTool.cancelSupersede.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-cancel-supersede-'))
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

async function seed(
  subject: string,
  extra: Partial<Omit<Task, 'id' | 'subject'>> = {},
): Promise<string> {
  return createTask(LIST, {
    subject,
    description: subject,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...extra,
  })
}

/** a blocks b (b waits on a), written the same way TaskUpdate does it. */
async function link(blocker: string, blocked: string): Promise<void> {
  const data = await update({ taskId: blocked, addBlockedBy: [blocker] })
  expect(data.success).toBe(true)
}

async function update(input: Record<string, unknown>): Promise<Output> {
  const result = await TaskUpdateTool.call(
    input as Parameters<typeof TaskUpdateTool.call>[0],
    makeContext(),
  )
  return (result as { data: Output }).data
}

async function task(id: string): Promise<Task> {
  const t = await getTask(LIST, id)
  expect(t).not.toBeNull()
  return t!
}

/** Raw bytes of every file in the list directory (task files, no lock dirs). */
function snapshotFiles(): Map<string, string> {
  const dir = getTasksDir(LIST)
  const files = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.set(entry.name, readFileSync(join(dir, entry.name), 'utf-8'))
    }
  }
  return files
}

async function openBlockers(id: string): Promise<string[]> {
  const result = await TaskListTool.call()
  const { tasks } = (result as { data: ListOutput }).data
  return tasks.find(t => t.id === id)!.blockedBy
}

describe('cancel without supersede', () => {
  test('keeps the task, clears the owner and unblocks dependents', async () => {
    const a = await seed('old plan', { owner: 'worker-1', status: 'in_progress' })
    const b = await seed('downstream')
    const c = await seed('other downstream')
    await link(a, b)
    await link(a, c)
    expect(await openBlockers(b)).toEqual([a])

    const data = await update({ taskId: a, status: 'cancelled' })

    expect(data.success).toBe(true)
    expect(data.statusChange).toEqual({ from: 'in_progress', to: 'cancelled' })
    const cancelled = await task(a)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.owner).toBeUndefined()
    expect(cancelled.supersededBy).toBeUndefined()
    expect((await task(b)).blockedBy).toEqual([])
    expect((await task(c)).blockedBy).toEqual([])
    expect(await openBlockers(b)).toEqual([])

    const claim = await claimTask(LIST, b, 'worker-2')
    expect(claim.success).toBe(true)
  })

  test('also drops the id from the blocks list of its own blockers', async () => {
    const pre = await seed('prerequisite')
    const a = await seed('old plan')
    await link(pre, a)

    expect((await update({ taskId: a, status: 'cancelled' })).success).toBe(true)

    expect((await task(pre)).blocks).toEqual([])
  })
})

describe('supersede', () => {
  test('re-points dependents to the replacement; they stay blocked until it completes', async () => {
    const a = await seed('old plan')
    const x = await seed('new plan')
    const b = await seed('downstream')
    const c = await seed('downstream 2')
    await link(a, b)
    await link(a, c)
    // c already waits on x too: the re-point must not duplicate it.
    await link(x, c)

    const data = await update({ taskId: a, status: 'cancelled', supersededBy: x })

    expect(data.success).toBe(true)
    expect(data.updatedFields).toEqual(['status', 'supersededBy'])
    const old = await task(a)
    expect(old.status).toBe('cancelled')
    expect(old.supersededBy).toBe(x)
    expect(old.owner).toBeUndefined()
    expect((await task(b)).blockedBy).toEqual([x])
    expect((await task(c)).blockedBy).toEqual([x])
    expect([...(await task(x)).blocks].sort()).toEqual([b, c].sort())

    // Still blocked, by the replacement.
    expect(await openBlockers(b)).toEqual([x])
    const blocked = await claimTask(LIST, b, 'worker-2')
    expect(blocked.success).toBe(false)
    expect(blocked.reason).toBe('blocked')
    expect(blocked.blockedByTasks).toEqual([x])

    expect((await update({ taskId: x, status: 'completed' })).success).toBe(true)

    expect(await openBlockers(b)).toEqual([])
    expect((await claimTask(LIST, b, 'worker-2')).success).toBe(true)
  })

  test('the replacement inherits the verification gate (but not verifiedBy)', async () => {
    const a = await seed('gated old plan', {
      metadata: { requiresVerification: true, verifiedBy: VERIFIER },
    })
    const x = await seed('unflagged new plan')
    const b = await seed('downstream')
    await link(a, b)
    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)

    expect(
      (await update({ taskId: a, status: 'cancelled', supersededBy: x })).success,
    ).toBe(true)
    const replacement = await task(x)
    expect(replacement.metadata).toEqual({ requiresVerification: true })
    expect(replacement.blocks).toEqual([b])

    // Without a verdict of its own, X cannot complete.
    const blocked = await update({ taskId: x, status: 'completed' })
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/metadata\.verifiedBy is not set/)
    expect((await task(x)).status).toBe('pending')

    const done = await update({
      taskId: x,
      status: 'completed',
      metadata: { verifiedBy: VERIFIER },
    })
    expect(done.success).toBe(true)
    expect(await openBlockers(b)).toEqual([])
  })

  test('a one-sided A.blocks → B edge is re-pointed too', async () => {
    const x = await seed('new plan')
    const b = await seed('downstream')
    // Only A records the edge; B.blockedBy does not mention A.
    const a = await seed('old plan', { blocks: [b] })

    expect(
      (await update({ taskId: a, status: 'cancelled', supersededBy: x })).success,
    ).toBe(true)

    expect((await task(b)).blockedBy).toEqual([x])
    expect((await task(x)).blocks).toEqual([b])
    expect(await openBlockers(b)).toEqual([x])
    expect((await task(a)).blocks).toEqual([])
  })

  test('a one-sided B.blockedBy → A edge is stripped on plain cancel', async () => {
    const a = await seed('old plan')
    const pre = await seed('prerequisite')
    // Only A records that it waits on pre; pre.blocks does not mention A.
    const b = await seed('downstream', { blockedBy: [a] })
    await updateTask(LIST, a, { blockedBy: [pre] })

    expect((await update({ taskId: a, status: 'cancelled' })).success).toBe(true)

    expect((await task(b)).blockedBy).toEqual([])
    expect((await task(pre)).blocks).toEqual([])
  })

  test('TaskList shows the replacement for a superseded task', async () => {
    const a = await seed('old plan')
    const x = await seed('new plan')
    await update({ taskId: a, status: 'cancelled', supersededBy: x })

    const result = await TaskListTool.call()
    const block = TaskListTool.mapToolResultToToolResultBlockParam(
      (result as { data: ListOutput }).data,
      'tool-use-id',
    )
    expect(String(block.content)).toContain(
      `#${a} [cancelled] old plan (superseded by #${x})`,
    )
  })

  test.each([
    ['a missing target', 'missing', /replacement task #999 not found/],
    ['itself', 'self', /cannot be superseded by itself/],
    ['a cancelled target', 'cancelled', /replacement task #\d+ is cancelled/],
    ['a target that depends on a dependent (cycle)', 'cycle', /dependency cycle/],
    ['a target that is itself a dependent (cycle)', 'direct-cycle', /dependency cycle/],
  ] as const)(
    'rejects %s and leaves every task file byte-for-byte unchanged',
    async (_label, kind, pattern) => {
      const a = await seed('old plan', { owner: 'worker-1' })
      const b = await seed('downstream')
      const x = await seed('candidate replacement')
      await link(a, b)
      let target: string = x
      if (kind === 'missing') target = '999'
      if (kind === 'self') target = a
      if (kind === 'cancelled') {
        expect((await update({ taskId: x, status: 'cancelled' })).success).toBe(true)
      }
      if (kind === 'cycle') {
        // b blocks x: re-pointing b to wait on x would close x → b → x.
        await link(b, x)
      }
      if (kind === 'direct-cycle') {
        // x waits on a: superseding a with x would make x wait on itself.
        await link(a, x)
      }
      const before = snapshotFiles()

      const data = await update({ taskId: a, status: 'cancelled', supersededBy: target })

      expect(data.success).toBe(false)
      expect(data.updatedFields).toEqual([])
      expect(data.error).toMatch(pattern)
      expect(snapshotFiles()).toEqual(before)
    },
  )

  test('cancelTask throws TaskCancelError directly for the library API', async () => {
    const a = await seed('old plan')
    const before = snapshotFiles()
    await expect(cancelTask(LIST, a, { supersededBy: a })).rejects.toBeInstanceOf(
      TaskCancelError,
    )
    await expect(cancelTask(LIST, '404')).rejects.toThrow(/Task #404 not found/)
    expect(snapshotFiles()).toEqual(before)
  })

  test('supersededBy without status cancelled is rejected', async () => {
    const a = await seed('old plan')
    const x = await seed('new plan')
    const before = snapshotFiles()

    for (const status of [undefined, 'completed', 'in_progress', 'deleted']) {
      const data = await update({
        taskId: a,
        supersededBy: x,
        ...(status ? { status } : {}),
      })
      expect(data.success).toBe(false)
      expect(data.error).toMatch(/supersededBy can only be set together with status "cancelled"/)
    }
    expect(snapshotFiles()).toEqual(before)
  })
})

describe('cancelled tasks', () => {
  test('are never claimable', async () => {
    const a = await seed('dropped')
    await update({ taskId: a, status: 'cancelled' })

    for (const checkAgentBusy of [false, true]) {
      const result = await claimTask(LIST, a, 'worker-1', { checkAgentBusy })
      expect(result.success).toBe(false)
      expect(result.reason).toBe('cancelled')
    }
    expect((await task(a)).owner).toBeUndefined()
  })

  test('are not open work for busy checks, agent status or unassign', async () => {
    // Seed the cancelled task file directly (createTask writes it as given)
    // so a stale owner survives: busy checks must still ignore it.
    const a = await seed('dropped', { owner: 'worker-1', status: 'cancelled' })
    const b = await seed('next')

    const claim = await claimTask(LIST, b, 'worker-1', { checkAgentBusy: true })
    expect(claim.success).toBe(true)

    const result = await unassignTeammateTasks(LIST, 'worker-1', 'worker-1', 'shutdown')
    expect(result.unassignedTasks.map(t => t.id)).toEqual([b])
    // A cancelled task is not reopened to 'pending' by unassign.
    expect((await task(a)).status).toBe('cancelled')
  })

  test('cannot be cancelled again', async () => {
    const a = await seed('dropped')
    await update({ taskId: a, status: 'cancelled' })
    const before = snapshotFiles()

    const data = await update({ taskId: a, status: 'cancelled' })

    expect(data.success).toBe(false)
    expect(data.error).toMatch(/already cancelled/)
    expect(snapshotFiles()).toEqual(before)
  })

  test.each(['completed', 'pending', 'in_progress'] as const)(
    'is terminal: cannot be moved to %s (TaskUpdate and updateTask)',
    async target => {
      const a = await seed('dropped', { metadata: { requiresVerification: true } })
      await update({ taskId: a, status: 'cancelled' })
      const before = snapshotFiles()

      const data = await update({ taskId: a, status: target })
      expect(data.success).toBe(false)
      expect(data.error).toMatch(
        new RegExp(`is cancelled and cannot be moved to '${target}'`),
      )

      await expect(
        updateTask(LIST, a, { status: target }),
      ).rejects.toBeInstanceOf(TaskTransitionError)
      expect(snapshotFiles()).toEqual(before)
    },
  )

  test('can only be entered through cancelTask, not updateTask', async () => {
    const a = await seed('old plan', { owner: 'worker-1' })
    const b = await seed('downstream')
    await link(a, b)
    const before = snapshotFiles()

    await expect(
      updateTask(LIST, a, { status: 'cancelled' }),
    ).rejects.toThrow(/can only be cancelled through cancelTask/)
    expect(snapshotFiles()).toEqual(before)
  })

  test('non-status edits to a cancelled task still work', async () => {
    const a = await seed('dropped', { status: 'cancelled' })
    expect((await updateTask(LIST, a, { description: 'why' }))?.status).toBe(
      'cancelled',
    )
  })
})

describe('cancel interactions', () => {
  test('cancelling a completed task is rejected', async () => {
    const a = await seed('done')
    await update({ taskId: a, status: 'completed' })
    const before = snapshotFiles()

    const data = await update({ taskId: a, status: 'cancelled' })

    expect(data.success).toBe(false)
    expect(data.error).toMatch(/already completed and cannot be cancelled/)
    expect(snapshotFiles()).toEqual(before)
  })

  test('the verification gate does not block a cancel', async () => {
    const a = await seed('gated', {
      status: 'in_progress',
      metadata: { requiresVerification: true },
    })
    const x = await seed('gated replacement', {
      metadata: { requiresVerification: true },
    })

    const data = await update({ taskId: a, status: 'cancelled', supersededBy: x })

    expect(data.success).toBe(true)
    expect((await task(a)).status).toBe('cancelled')
  })

  test('the replacement stays gated by verification', async () => {
    const a = await seed('old')
    const x = await seed('gated replacement', {
      metadata: { requiresVerification: true },
    })
    const b = await seed('downstream')
    await link(a, b)
    await update({ taskId: a, status: 'cancelled', supersededBy: x })

    const blocked = await update({ taskId: x, status: 'completed' })
    expect(blocked.success).toBe(false)
    expect(await openBlockers(b)).toEqual([x])

    await recordVerdict({ agentId: VERIFIER, verdict: 'PASS' }, LIST)
    const done = await update({
      taskId: x,
      status: 'completed',
      metadata: { verifiedBy: VERIFIER },
    })
    expect(done.success).toBe(true)
    expect(await openBlockers(b)).toEqual([])
  })

  test('cancel cannot be combined with an owner or new dependencies', async () => {
    const a = await seed('old')
    const b = await seed('other')
    const before = snapshotFiles()

    for (const extra of [
      { owner: 'worker-1' },
      { addBlocks: [b] },
      { addBlockedBy: [b] },
    ]) {
      const data = await update({ taskId: a, status: 'cancelled', ...extra })
      expect(data.success).toBe(false)
    }
    expect(snapshotFiles()).toEqual(before)
  })

  test('a concurrent delete and cancel never resurrect the deleted task', async () => {
    // Both take the list lock, so either order is serialized: delete first
    // → cancel re-reads without B; cancel first → delete then removes B.
    // Before the fix, cancel could re-read B, delete could unlink it, and
    // cancel's rename brought it back.
    for (let round = 0; round < 10; round++) {
      const a = await seed(`old ${round}`)
      const x = await seed(`new ${round}`)
      const b = await seed(`downstream ${round}`)
      await link(a, b)

      const [deleted, cancelled] = await Promise.allSettled([
        deleteTask(LIST, b),
        cancelTask(LIST, a, { supersededBy: x }),
      ])

      expect(deleted).toEqual({ status: 'fulfilled', value: true })
      expect(cancelled.status).toBe('fulfilled')
      expect(await getTask(LIST, b)).toBeNull()
      expect(existsSync(getTaskPath(LIST, b))).toBe(false)
      expect((await task(x)).blocks).not.toContain(b)
    }
    // No temp files are left behind.
    expect(
      [...snapshotFiles().keys()].filter(name => name.includes('cancel-tmp')),
    ).toEqual([])
  })

  test('delete still removes the task and strips it from dependents', async () => {
    const a = await seed('created by mistake')
    const b = await seed('downstream')
    await link(a, b)

    const data = await update({ taskId: a, status: 'deleted' })

    expect(data.success).toBe(true)
    expect(data.statusChange).toEqual({ from: 'pending', to: 'deleted' })
    expect(await getTask(LIST, a)).toBeNull()
    expect((await task(b)).blockedBy).toEqual([])
    expect((await listTasks(LIST)).map(t => t.id)).toEqual([b])
  })
})
