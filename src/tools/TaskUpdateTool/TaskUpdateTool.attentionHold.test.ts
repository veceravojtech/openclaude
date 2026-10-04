import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
// Load the tool graph first (import-cycle TDZ otherwise).
import '../../constants/tools.js'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import {
  createAttentionItem,
  decideAttentionItem,
  runFailureItem,
} from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { tryClaimNextTask } from '../../utils/swarm/inProcessRunner.js'
import {
  AttentionHoldError,
  claimTask,
  createTask,
  getTask,
  getTaskPath,
  unassignTeammateTasks,
  updateTask,
} from '../../utils/tasks.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { TaskUpdateTool, type Output } from './TaskUpdateTool.js'

// A task a failed worker released is held (metadata.attentionHold) until the
// lead decides the attention item. TaskUpdate used to write the owner (and
// auto-set it on in_progress) with a plain update, so anyone — the lead
// included — could claim a held task before the decision. The hold is now
// enforced in the locked write itself, for every caller.

const TEAM = 'attention-hold-team'
const WORKER = { agentId: `builder@${TEAM}`, agentName: 'builder' }

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/TaskUpdateTool/TaskUpdateTool.attentionHold.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attention-hold-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = TEAM
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

function asTeammate<T>(name: string, fn: () => T): T {
  return runWithTeammateContext(
    {
      agentId: `${name}@${TEAM}`,
      agentName: name,
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: asAgentId('a0000claimer001'),
    },
    fn,
  )
}

function toolContext(): ToolUseContext {
  return {
    getAppState: () => ({ sessionHooks: new Map() }),
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model', tools: [] },
  } as unknown as ToolUseContext
}

/** TaskUpdate as the lead (no teammate context). */
async function leadUpdate(input: Record<string, unknown>): Promise<Output> {
  const result = await TaskUpdateTool.call(
    input as Parameters<typeof TaskUpdateTool.call>[0],
    toolContext(),
  )
  return (result as { data: Output }).data
}

/** TaskUpdate as an in-process teammate called `claimer`. */
async function teammateUpdate(input: Record<string, unknown>): Promise<Output> {
  const result = await asTeammate('claimer', () =>
    TaskUpdateTool.call(
      input as Parameters<typeof TaskUpdateTool.call>[0],
      toolContext(),
    ),
  )
  return (result as { data: Output }).data
}

function taskFile(id: string): string {
  return readFileSync(getTaskPath(TEAM, id), 'utf-8')
}

/** A failed worker: the item first, then its task released with the hold. */
async function heldTask(
  opts: { transient?: boolean } = {},
): Promise<{ itemId: string; taskId: string }> {
  const taskId = await createTask(TEAM, {
    subject: 'build parser',
    description: 'parse it',
    status: 'in_progress',
    owner: WORKER.agentName,
    blocks: [],
    blockedBy: [],
  })
  const item = runFailureItem({
    taskId: 'in-proc-1',
    runSeq: 0,
    description: 'builder',
    error: 'boom',
    backend: 'in_process',
    ...WORKER,
    teamName: TEAM,
    transient: opts.transient
      ? { transient: true, transientReason: 'provider quota' }
      : { transient: false, transientReason: 'unrecognised error' },
  })
  await createAttentionItem(item)
  await unassignTeammateTasks(TEAM, WORKER.agentId, WORKER.agentName, 'failed', {
    attentionHold: item.id,
  })
  const task = await getTask(TEAM, taskId)
  expect(task?.metadata?.attentionHold).toBe(item.id)
  expect(task?.owner).toBeUndefined()
  expect(task?.status).toBe('pending')
  return { itemId: item.id, taskId }
}

function expectHeldRefusal(data: Output, taskId: string, itemId: string): void {
  expect(data.success).toBe(false)
  expect(data.updatedFields).toEqual([])
  expect(data.error).toContain(`Task #${taskId} is held by attention item ${itemId}`)
  expect(data.error).toContain('AttentionDecide')
}

describe('TaskUpdate on a held task, item undecided', () => {
  test('the lead cannot assign an owner; the task file is unchanged', async () => {
    const { itemId, taskId } = await heldTask()
    const before = taskFile(taskId)
    expectHeldRefusal(await leadUpdate({ taskId, owner: 'claimer' }), taskId, itemId)
    expect(taskFile(taskId)).toBe(before)
  })

  test('a teammate cannot claim it with owner=self + in_progress', async () => {
    const { itemId, taskId } = await heldTask()
    const before = taskFile(taskId)
    expectHeldRefusal(
      await teammateUpdate({ taskId, owner: 'claimer', status: 'in_progress' }),
      taskId,
      itemId,
    )
    expect(taskFile(taskId)).toBe(before)
  })

  test('in_progress with no owner (the auto-owner path) is refused', async () => {
    const { itemId, taskId } = await heldTask()
    const before = taskFile(taskId)
    expectHeldRefusal(await teammateUpdate({ taskId, status: 'in_progress' }), taskId, itemId)
    expectHeldRefusal(await leadUpdate({ taskId, status: 'in_progress' }), taskId, itemId)
    expect(taskFile(taskId)).toBe(before)
  })

  test('clearing the hold metadata by hand is refused', async () => {
    const { itemId, taskId } = await heldTask()
    const before = taskFile(taskId)
    expectHeldRefusal(
      await leadUpdate({ taskId, metadata: { attentionHold: null } }),
      taskId,
      itemId,
    )
    expect(taskFile(taskId)).toBe(before)
  })

  test('description and other field edits still work and keep the hold', async () => {
    const { itemId, taskId } = await heldTask()
    const data = await teammateUpdate({
      taskId,
      description: 'parse it, with tests',
      subject: 'build parser v2',
      metadata: { note: 'x' },
    })
    expect(data.success).toBe(true)
    const task = await getTask(TEAM, taskId)
    expect(task?.description).toBe('parse it, with tests')
    expect(task?.subject).toBe('build parser v2')
    expect(task?.metadata).toMatchObject({ attentionHold: itemId, note: 'x' })
    expect(task?.owner).toBeUndefined()
  })

  test('unassigning (empty owner) is allowed', async () => {
    const { taskId } = await heldTask()
    // A stray non-empty owner cannot be written, so plant one directly as a
    // task from before the fix would have it, then clear it through the tool.
    const raw = JSON.parse(taskFile(taskId))
    raw.owner = 'stale'
    await Bun.write(getTaskPath(TEAM, taskId), JSON.stringify(raw, null, 2))
    const data = await leadUpdate({ taskId, owner: '' })
    expect(data.success).toBe(true)
    expect((await getTask(TEAM, taskId))?.owner).toBe('')
  })

  test('completing and cancelling a held task are allowed', async () => {
    const { taskId } = await heldTask()
    expect((await leadUpdate({ taskId, status: 'completed' })).success).toBe(true)
    expect((await getTask(TEAM, taskId))?.status).toBe('completed')

    const second = await heldTask()
    expect((await leadUpdate({ taskId: second.taskId, status: 'cancelled' })).success).toBe(true)
    expect((await getTask(TEAM, second.taskId))?.status).toBe('cancelled')
  })

  test('the locked write is the authority: updateTask itself refuses', async () => {
    const { itemId, taskId } = await heldTask()
    const attempt = updateTask(TEAM, taskId, { owner: 'claimer' })
    await expect(attempt).rejects.toBeInstanceOf(AttentionHoldError)
    await expect(updateTask(TEAM, taskId, { owner: 'claimer' })).rejects.toThrow(itemId)
    expect((await getTask(TEAM, taskId))?.owner).toBeUndefined()
  })
})

describe('TaskUpdate on a held task once the item is decided', () => {
  for (const choice of ['retry', 'patch', 'continue'] as const) {
    test(`after ${choice}, owner + in_progress succeed`, async () => {
      // retry is only allowed on transient items.
      const { itemId, taskId } = await heldTask({ transient: choice === 'retry' })
      await decideAttentionItem(itemId, {
        choice,
        reason: 'decided',
        ...(choice === 'patch' ? { rootCause: 'spec' as const } : {}),
      })
      const data = await teammateUpdate({ taskId, owner: 'claimer', status: 'in_progress' })
      expect(data.success).toBe(true)
      const task = await getTask(TEAM, taskId)
      expect(task?.owner).toBe('claimer')
      expect(task?.status).toBe('in_progress')
    })
  }

  test('after abort the held task is cancelled (cancel is final, not a hold refusal)', async () => {
    const { itemId, taskId } = await heldTask()
    await decideAttentionItem(itemId, { choice: 'abort', reason: 'wrong approach' })
    expect((await getTask(TEAM, taskId))?.status).toBe('cancelled')
    const data = await leadUpdate({ taskId, status: 'in_progress' })
    expect(data.success).toBe(false)
    expect(data.error).not.toContain('held by attention item')
  })

  test('a hold naming a decided item does not refuse even if its marker remains', async () => {
    const { itemId, taskId } = await heldTask()
    await decideAttentionItem(itemId, { choice: 'continue', reason: 'accepted' })
    // The release write was lost: the marker is back, but the item is decided.
    await updateTask(TEAM, taskId, { metadata: { attentionHold: itemId } })
    const data = await teammateUpdate({ taskId, status: 'in_progress' })
    expect(data.success).toBe(true)
    expect((await getTask(TEAM, taskId))?.owner).toBe('claimer')
  })

  test('a hold naming a missing item does not refuse', async () => {
    const taskId = await createTask(TEAM, {
      subject: 'orphan',
      description: 'orphan',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: { attentionHold: 'failure-never-0' },
    })
    const data = await leadUpdate({ taskId, owner: 'claimer' })
    expect(data.success).toBe(true)
    expect((await getTask(TEAM, taskId))?.owner).toBe('claimer')
  })
})

describe('other owner-setting paths', () => {
  test('claimTask reports held_for_decision, with and without the busy check', async () => {
    const { itemId, taskId } = await heldTask()
    expect(await claimTask(TEAM, taskId, 'claimer')).toMatchObject({
      success: false,
      reason: 'held_for_decision',
      attentionItemId: itemId,
    })
    expect(
      await claimTask(TEAM, taskId, 'claimer', { checkAgentBusy: true }),
    ).toMatchObject({ success: false, reason: 'held_for_decision' })
  })

  test('the in-process auto-claim skips a held task and takes the next free one', async () => {
    const { taskId: held } = await heldTask()
    const free = await createTask(TEAM, {
      subject: 'free work',
      description: 'free',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const before = taskFile(held)
    const claimed = await tryClaimNextTask(TEAM, 'claimer')
    expect(claimed?.taskId).toBe(free)
    expect(taskFile(held)).toBe(before)
    const task = await getTask(TEAM, free)
    expect(task?.owner).toBe('claimer')
    expect(task?.status).toBe('in_progress')
  })

  test('the in-process auto-claim takes nothing when only held tasks remain, and the task after a decision', async () => {
    const { itemId, taskId } = await heldTask()
    const before = taskFile(taskId)
    expect(await tryClaimNextTask(TEAM, 'claimer')).toBeUndefined()
    expect(taskFile(taskId)).toBe(before)

    await decideAttentionItem(itemId, { choice: 'continue', reason: 'accepted' })
    expect((await tryClaimNextTask(TEAM, 'claimer'))?.taskId).toBe(taskId)
    expect((await getTask(TEAM, taskId))?.owner).toBe('claimer')
  })
})
