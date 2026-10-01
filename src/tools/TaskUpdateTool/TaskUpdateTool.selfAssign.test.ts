import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { createTask, getTask } from '../../utils/tasks.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { isTaskAssignment, readMailbox } from '../../utils/teammateMailbox.js'
import { TaskUpdateTool, type Output } from './TaskUpdateTool.js'

// A teammate that claims a task (owner = itself) used to receive a
// task_assignment message in its OWN inbox, "assigned by" itself, and spend a
// turn on it. Assigning to someone else must still notify them.

const TEAM = 'self-assign-team'

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/TaskUpdateTool/TaskUpdateTool.selfAssign.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-self-assign-'))
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

function asWorker<T>(fn: () => T): T {
  return runWithTeammateContext(
    {
      agentId: `worker@${TEAM}`,
      agentName: 'worker',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: asAgentId('a0000worker0001'),
    },
    fn,
  )
}

async function update(input: Record<string, unknown>): Promise<Output> {
  const context = {
    getAppState: () => ({ sessionHooks: new Map() }),
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model', tools: [] },
  } as unknown as ToolUseContext
  const result = await asWorker(() =>
    TaskUpdateTool.call(input as Parameters<typeof TaskUpdateTool.call>[0], context),
  )
  return (result as { data: Output }).data
}

async function assignmentsIn(inbox: string): Promise<string[]> {
  return (await readMailbox(inbox, TEAM))
    .filter(m => isTaskAssignment(m.text) !== null)
    .map(m => m.from)
}

async function seed(): Promise<string> {
  return createTask(TEAM, {
    subject: 'heartbeat work',
    description: 'loop',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
}

test('claiming a task for yourself (by name) sends no task_assignment to your own inbox', async () => {
  const id = await seed()
  const data = await update({ taskId: id, owner: 'worker', status: 'in_progress' })
  expect(data.success).toBe(true)
  expect((await getTask(TEAM, id))?.owner).toBe('worker')
  expect(await assignmentsIn('worker')).toEqual([])
})

test('claiming by your agent id is a self-assignment too', async () => {
  const id = await seed()
  const data = await update({ taskId: id, owner: `worker@${TEAM}` })
  expect(data.success).toBe(true)
  expect(await assignmentsIn('worker')).toEqual([])
  expect(await assignmentsIn(`worker@${TEAM}`)).toEqual([])
})

test('assigning a task to ANOTHER teammate still notifies that teammate', async () => {
  const id = await seed()
  const data = await update({ taskId: id, owner: 'reviewer' })
  expect(data.success).toBe(true)
  expect(await assignmentsIn('reviewer')).toEqual(['worker'])
  expect(await assignmentsIn('worker')).toEqual([])
})
