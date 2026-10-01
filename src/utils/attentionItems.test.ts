import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Load the tool graph first (import-cycle TDZ, as in the Phase 1/4 tests).
import '../constants/tools.js'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { ToolUseContext } from '../Tool.js'
import {
  AttentionDecideTool,
  LEAD_ONLY_ERROR,
  type Output as AttentionDecideOutput,
} from '../tools/AttentionDecideTool/AttentionDecideTool.js'
import { asAgentId } from '../types/ids.js'
import {
  attentionHookWritesAllowed,
  checkAttentionSpawnGate,
  createAttentionItem,
  decideAttentionItem,
  failureItemId,
  findUndecidedFailureItemFor,
  isBunTestRunner,
  formatAttentionItemsReminder,
  gapItemId,
  listUndecidedAttentionItems,
  readAttentionItem,
  runFailureItem,
  supersedeAttentionItem,
  verdictItemId,
} from './attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { recordFinalReview, registerFinalReviewer } from './finalReviews.js'
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
  unassignTeammateTasks,
} from './tasks.js'
import { runWithTeammateContext } from './teammateContext.js'
import { recordVerdict } from './verificationVerdicts.js'

// Phase 5: attention items through the task-list-aware API — holds on the
// tasks a failed worker released, each decision's semantics, the spawn gate
// text, the AttentionDecide tool, and the recovery path for a GAPS review
// whose GAP tasks were never filed.

const LIST = 'attention-items-list'
let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attentionItems.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-attention-'))
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

const WORKER = { agentId: 'builder@team', agentName: 'builder' }

async function newTask(
  subject: string,
  extra: { owner?: string; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  return createTask(LIST, {
    subject,
    description: subject,
    status: extra.owner ? 'in_progress' : 'pending',
    blocks: [],
    blockedBy: [],
    ...(extra.owner ? { owner: extra.owner } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  })
}

/** A failed teammate: item first, then its tasks released with the hold. */
async function failWorkerHoldingTasks(opts: {
  transient?: boolean
} = {}): Promise<{ itemId: string; taskIds: string[] }> {
  const taskIds = [
    await newTask('build parser', { owner: WORKER.agentId }),
    await newTask('build cli', { owner: WORKER.agentName }),
  ]
  const item = runFailureItem({
    taskId: 'in-proc-1',
    runSeq: 0,
    description: 'builder',
    error: 'boom',
    backend: 'in_process',
    ...WORKER,
    teamName: 'team',
    transient: {
      transient: opts.transient ?? false,
      transientReason: opts.transient ? 'failure kind provider' : 'unrecognised error',
    },
  })
  await createAttentionItem(item)
  const { unassignedTasks } = await unassignTeammateTasks(
    LIST,
    WORKER.agentId,
    WORKER.agentName,
    'failed',
    { attentionHold: item.id },
  )
  expect(unassignedTasks.map(t => t.id).sort()).toEqual([...taskIds].sort())
  return { itemId: item.id, taskIds }
}

describe('hold', () => {
  test('claimTask refuses a held task (with and without the busy check) until a decision releases it', async () => {
    const { itemId, taskIds } = await failWorkerHoldingTasks()
    const [a, b] = taskIds as [string, string]
    expect((await getTask(LIST, a))?.metadata?.attentionHold).toBe(itemId)
    expect((await getTask(LIST, a))?.owner).toBeUndefined()

    const refused = await claimTask(LIST, a, 'other@team')
    expect(refused).toMatchObject({ success: false, reason: 'held_for_decision', attentionItemId: itemId })
    const refusedBusy = await claimTask(LIST, b, 'other@team', { checkAgentBusy: true })
    expect(refusedBusy).toMatchObject({ success: false, reason: 'held_for_decision' })

    const outcome = await decideAttentionItem(itemId, {
      choice: 'patch',
      reason: 'the spec was ambiguous',
      rootCause: 'spec',
    })
    expect(outcome.released.sort()).toEqual([...taskIds].sort())
    expect(outcome.undecidedRemaining).toBe(0)
    expect((await getTask(LIST, a))?.metadata?.attentionHold).toBeUndefined()
    expect((await claimTask(LIST, a, 'other@team')).success).toBe(true)
  })

  test('a hold whose item is gone or superseded does not strand the task', async () => {
    const { itemId, taskIds } = await failWorkerHoldingTasks()
    expect(await supersedeAttentionItem(itemId, 'late-completion')).toBe(true)
    // Released by supersede…
    expect((await getTask(LIST, taskIds[0]!))?.metadata?.attentionHold).toBeUndefined()
    // …and a stale marker naming a non-undecided item would not hold anyway.
    await updateTask(LIST, taskIds[1]!, { metadata: { attentionHold: itemId } })
    expect((await claimTask(LIST, taskIds[1]!, 'other@team')).success).toBe(true)
    await updateTask(LIST, taskIds[0]!, { metadata: { attentionHold: 'failure-never-0' } })
    expect((await claimTask(LIST, taskIds[0]!, 'other@team')).success).toBe(true)
  })

  test('abort cancels the held tasks instead of releasing them; nothing else is touched', async () => {
    const { itemId, taskIds } = await failWorkerHoldingTasks()
    const bystander = await newTask('unrelated')
    const outcome = await decideAttentionItem(itemId, { choice: 'abort', reason: 'wrong approach' })
    expect(outcome.cancelled.sort()).toEqual([...taskIds].sort())
    for (const id of taskIds) expect((await getTask(LIST, id))?.status).toBe('cancelled')
    expect((await getTask(LIST, bystander))?.status).toBe('pending')
  })

  test('abort on a verdict item cancels the task citing that verifier (best-effort)', async () => {
    const cited = await newTask('feature', { metadata: { requiresVerification: true, verifiedBy: 'a0verifier1' } })
    const other = await newTask('other')
    await createAttentionItem({
      id: verdictItemId('a0verifier1'),
      kind: 'verdict',
      source: { agentId: 'a0verifier1', backend: 'local_agent' },
      summary: 'verifier a0verifier1 returned VERDICT: FAIL',
      transient: false,
    })
    const outcome = await decideAttentionItem(verdictItemId('a0verifier1'), { choice: 'abort', reason: 'drop it' })
    expect(outcome.cancelled).toEqual([cited])
    expect((await getTask(LIST, other))?.status).toBe('pending')
  })
})

describe('decisions', () => {
  test('retry: transient only, records the decision and releases the hold', async () => {
    const { itemId: nonTransient } = await failWorkerHoldingTasks({ transient: false })
    await expect(
      decideAttentionItem(nonTransient, { choice: 'retry', reason: 'again' }),
    ).rejects.toThrow(/not a transient failure/)
    await decideAttentionItem(nonTransient, { choice: 'continue', reason: 'accepted as is' })

    const item = runFailureItem({
      taskId: 'local-7',
      runSeq: 0,
      description: 'fetch docs',
      error: '429 rate limit',
      backend: 'local_agent',
    })
    expect(item.transient).toBe(true)
    await createAttentionItem(item)
    const outcome = await decideAttentionItem(item.id, { choice: 'retry', reason: 'provider hiccup' })
    expect(outcome.item.decision?.choice).toBe('retry')
    // The retry cap: the same run failing again (resume) is non-transient.
    const again = await createAttentionItem(runFailureItem({
      taskId: 'local-7',
      runSeq: 1,
      description: 'fetch docs',
      error: '429 rate limit',
      backend: 'local_agent',
    }))
    expect(again.item?.transient).toBe(false)
  })

  test('continue on a verdict item does not satisfy the verification gate', async () => {
    const task = await newTask('feature', { metadata: { requiresVerification: true } })
    await recordVerdict({ agentId: 'a0verifier2', verdict: 'FAIL' })
    await createAttentionItem({
      id: verdictItemId('a0verifier2'),
      kind: 'verdict',
      source: { agentId: 'a0verifier2', backend: 'local_agent' },
      summary: 'verifier a0verifier2 returned VERDICT: FAIL',
      transient: false,
    })
    await decideAttentionItem(verdictItemId('a0verifier2'), { choice: 'continue', reason: 'ship it anyway' })
    await expect(
      updateTask(LIST, task, { status: 'completed', metadata: { requiresVerification: true, verifiedBy: 'a0verifier2' } }),
    ).rejects.toThrow(/only PASS allows completion/)
  })
})

describe('Phase 4 fix A: a GAPS review without its GAP tasks', () => {
  async function setUpUnfiledGaps(): Promise<string> {
    const flagged = await newTask('the feature', { metadata: { requiresFinalReview: true } })
    // The review was registered and recorded, but the process died before
    // any GAP task was filed.
    expect(await registerFinalReviewer('a0gapsreview')).toEqual([flagged])
    await recordFinalReview({
      agentId: 'a0gapsreview',
      result: 'GAPS',
      gaps: [
        { id: 'GAP-001', severity: 'critical', requirement: 'json', expected: 'JSON', observed: 'text', evidence: 'cli.ts:1' },
        { id: 'GAP-002', severity: 'minor', requirement: 'docs', expected: 'README', observed: 'none', evidence: 'README.md' },
      ],
      commit: 'c'.repeat(40),
    })
    await recordFinalReview({ agentId: 'a0donereview', result: 'DONE', gaps: [], commit: 'd'.repeat(40) })
    return flagged
  }

  test("the gate refuses another reviewer's DONE while a recorded GAP has no task", async () => {
    const flagged = await setUpUnfiledGaps()
    await expect(
      updateTask(LIST, flagged, {
        status: 'completed',
        metadata: { ...(await getTask(LIST, flagged))!.metadata, finalReviewedBy: 'a0donereview' },
      }),
    ).rejects.toThrow(/GAPs that have no GAP task yet: GAP-001 \(reviewer a0gapsreview\), GAP-002/)
  })

  test('recovery: patch on the gap item re-files the missing GAP tasks, which then gate as usual', async () => {
    const flagged = await setUpUnfiledGaps()
    await createAttentionItem({
      id: gapItemId('a0gapsreview'),
      kind: 'gap',
      source: { agentId: 'a0gapsreview', backend: 'local_agent', taskListTaskIds: [flagged] },
      summary: 'final reviewer a0gapsreview found 2 GAP(s)',
      transient: false,
    })
    const outcome = await decideAttentionItem(gapItemId('a0gapsreview'), {
      choice: 'patch',
      reason: 'fix the gaps',
      rootCause: 'spec',
    })
    expect(outcome.refiledGapTasks).toHaveLength(2)
    const gapTasks = (await listTasks(LIST)).filter(t => t.metadata?.gapOf === 'a0gapsreview')
    expect(gapTasks.map(t => t.metadata?.gapId).sort()).toEqual(['GAP-001', 'GAP-002'])
    const complete = async () =>
      updateTask(LIST, flagged, {
        status: 'completed',
        metadata: { ...(await getTask(LIST, flagged))!.metadata, finalReviewedBy: 'a0donereview' },
      })
    await expect(complete()).rejects.toThrow(/GAP tasks filed by a final review are still open/)
    for (const t of gapTasks) await updateTask(LIST, t.id, { status: 'completed' })
    expect((await complete())?.status).toBe('completed')
  })
})

describe('spawn gate and reminder text', () => {
  test('blocked message lists every undecided item, the tool and the guidance; nothing pending → undefined', async () => {
    expect(await checkAttentionSpawnGate()).toBeUndefined()
    const { itemId } = await failWorkerHoldingTasks()
    const message = await checkAttentionSpawnGate()
    expect(message).toStartWith('Blocked: 1 failure(s) need a decision before new work can be spawned: ')
    expect(message).toContain(`${itemId} (failure: builder failed: boom)`)
    expect(message).toContain('AttentionDecide')
    expect(message).toContain('earliest wrong input')
    const reminder = formatAttentionItemsReminder(await listUndecidedAttentionItems())
    expect(reminder).toContain(itemId)
    expect(reminder).toContain('transient: no')
    expect(reminder).toContain('cannot be spawned')
    expect(reminder).toContain('retry (transient failures only')
    await decideAttentionItem(itemId, { choice: 'continue', reason: 'fine' })
    expect(await checkAttentionSpawnGate()).toBeUndefined()
  })
})

describe('AttentionDecide tool', () => {
  const lead = { agentId: undefined } as unknown as ToolUseContext
  // The full Tool call/validateInput signatures (buildTool narrows them).
  const tool = AttentionDecideTool as unknown as {
    call: (...args: unknown[]) => Promise<{ data: AttentionDecideOutput }>
    validateInput: (...args: unknown[]) => Promise<{ result: boolean }>
  }
  const call = (input: Record<string, unknown>, ctx: ToolUseContext = lead) =>
    tool.call(input, ctx, () => {}, {})

  test('records the decision and reports what remains', async () => {
    const { itemId } = await failWorkerHoldingTasks()
    await createAttentionItem({
      id: 'verdict-a0second',
      kind: 'verdict',
      source: { agentId: 'a0second' },
      summary: 'verifier a0second returned VERDICT: PARTIAL',
      transient: false,
    })
    const result = await call({ id: itemId, decision: 'patch', reason: 'narrow the scope', root_cause: 'scope' })
    expect(result.data).toMatchObject({ id: itemId, decision: 'patch', undecidedRemaining: 1 })
    expect(result.data.released).toHaveLength(2)
    const block = AttentionDecideTool.mapToolResultToToolResultBlockParam(result.data, 'tu1')
    expect(String(block.content)).toContain('1 undecided item(s) remain; spawning stays blocked')
    expect((await readAttentionItem(itemId))?.decision).toMatchObject({ choice: 'patch', rootCause: 'scope' })
    await expect(call({ id: itemId, decision: 'continue', reason: 'again' })).rejects.toThrow('already decided: patch')
  })

  test('validateInput: patch needs root_cause', async () => {
    const v = await tool.validateInput(
      { id: 'x', decision: 'patch', reason: 'r' } as never,
      lead,
    )
    expect(v.result).toBe(false)
    const ok = await tool.validateInput(
      { id: 'x', decision: 'patch', reason: 'r', root_cause: 'method' } as never,
      lead,
    )
    expect(ok.result).toBe(true)
    expect(AttentionDecideTool.inputSchema.safeParse({ id: 'x', decision: 'continue', reason: ' ' }).success).toBe(false)
  })

  test('lead-only: a subagent context and a teammate are refused, and nothing is decided', async () => {
    const { itemId } = await failWorkerHoldingTasks()
    await expect(
      call({ id: itemId, decision: 'continue', reason: 'x' }, { agentId: asAgentId('a00000000000beef') } as unknown as ToolUseContext),
    ).rejects.toThrow(LEAD_ONLY_ERROR)
    await expect(
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
        () => call({ id: itemId, decision: 'continue', reason: 'x' }),
      ),
    ).rejects.toThrow(LEAD_ONLY_ERROR)
    expect((await readAttentionItem(itemId))?.status).toBe('undecided')
    expect(AttentionDecideTool.shouldDefer).toBe(false)
  })
})

test('failure item ids are deterministic per task and run', () => {
  expect(failureItemId('t', 2)).toBe('failure-t-2')
  expect(runFailureItem({ taskId: 't', runSeq: 2, description: 'd', backend: 'pane', agentId: 'x@y' }).retryKey).toBe('agent:x@y')
})

describe('hardening', () => {
  test('abort: one task failing to cancel does not stop the others; holds are released and the error is reported', async () => {
    const taskIds = [
      await newTask('a', { owner: WORKER.agentId }),
      await newTask('b', { owner: WORKER.agentId }),
      await newTask('c', { owner: WORKER.agentId }),
    ]
    const item = runFailureItem({
      taskId: 'in-proc-3',
      runSeq: 0,
      description: 'builder',
      error: 'boom',
      backend: 'in_process',
      ...WORKER,
      teamName: 'team',
    })
    await createAttentionItem(item)
    await unassignTeammateTasks(LIST, WORKER.agentId, WORKER.agentName, 'failed', {
      attentionHold: item.id,
    })
    const broken = taskIds[1]!
    const { cancelTask } = await import('./tasks.js')
    const outcome = await decideAttentionItem(
      item.id,
      { choice: 'abort', reason: 'wrong approach' },
      LIST,
      {
        cancelTask: async (list, id) => {
          if (id === broken) throw new Error('injected EIO')
          return cancelTask(list, id)
        },
      },
    )
    expect(outcome.item.decision?.choice).toBe('abort')
    expect(outcome.cancelled.sort()).toEqual([taskIds[0]!, taskIds[2]!].sort())
    expect(outcome.cancelErrors).toEqual([`#${broken}: injected EIO`])
    expect((await getTask(LIST, taskIds[0]!))?.status).toBe('cancelled')
    expect((await getTask(LIST, taskIds[2]!))?.status).toBe('cancelled')
    // The one that could not be cancelled is not left held.
    const left = await getTask(LIST, broken)
    expect(left?.status).toBe('pending')
    expect(left?.metadata?.attentionHold).toBeUndefined()
    expect(outcome.released).toContain(broken)
  })

  test('hook writes are keyed on the test runner, not on NODE_ENV', async () => {
    // Bun's runner sets no runner-only env var; it points Bun.main at the
    // test file. That is what marks this process as the runner.
    expect(process.env.NODE_ENV).toBe('test')
    expect(isBunTestRunner()).toBe(true)
    expect(isBunTestRunner('/usr/lib/openclaude/dist/cli.mjs')).toBe(false)
    // Under the runner: an isolated config home allows writes (this suite
    // sets one), the real one does not.
    expect(attentionHookWritesAllowed()).toBe(true)
    setClaudeConfigHomeDirForTesting(undefined)
    const saved = {
      claude: process.env.CLAUDE_CONFIG_DIR,
      openclaude: process.env.OPENCLAUDE_CONFIG_DIR,
    }
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.OPENCLAUDE_CONFIG_DIR
    try {
      expect(attentionHookWritesAllowed()).toBe(false)
      // NODE_ENV=test without the runner marker (a session started with it):
      // writes are allowed.
      expect(attentionHookWritesAllowed('/usr/lib/openclaude/dist/cli.mjs')).toBe(true)
    } finally {
      if (saved.claude !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.claude
      if (saved.openclaude !== undefined) process.env.OPENCLAUDE_CONFIG_DIR = saved.openclaude
      setClaudeConfigHomeDirForTesting(configDir)
    }
  })

  test('a process run with NODE_ENV=test outside the runner records its failure item', async () => {
    const home = mkdtempSync(join(tmpdir(), 'openclaude-attention-home-'))
    const script = join(home, 'note.ts')
    try {
      writeFileSync(
        script,
        `import { noteAttentionItem } from ${JSON.stringify(join(import.meta.dir, 'attentionItems.ts'))}\n` +
          `await noteAttentionItem({ id: 'failure-envtest-0', kind: 'failure', source: { taskId: 'envtest' }, summary: 's', transient: false })\n`,
      )
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'CLAUDE_CONFIG_DIR' && k !== 'OPENCLAUDE_CONFIG_DIR') env[k] = v
      }
      env.NODE_ENV = 'test'
      env.HOME = home
      env.CLAUDE_CODE_TASK_LIST_ID = 'envtest-list'
      const proc = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' })
      expect(await proc.exited).toBe(0)
      const written = readdirSync(join(home, '.openclaude', 'tasks', 'envtest-list', '.attention'))
      expect(written.some(f => f.startsWith('failure-envtest-0'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  test('findUndecidedFailureItemFor matches a worker by agent id or by name in its team, undecided only', async () => {
    const mine = runFailureItem({ taskId: 'p1', runSeq: 0, description: 'w', backend: 'pane', agentId: 'w@team', agentName: 'w', teamName: 'team' })
    const other = runFailureItem({ taskId: 'p2', runSeq: 0, description: 'x', backend: 'pane', agentId: 'x@team', agentName: 'x', teamName: 'team' })
    await createAttentionItem(mine)
    await createAttentionItem(other)
    expect((await findUndecidedFailureItemFor({ agentId: 'w@team', name: 'w', teamName: 'team' }))?.id).toBe(mine.id)
    expect((await findUndecidedFailureItemFor({ agentId: 'w-other-id', name: 'w', teamName: 'team' }))?.id).toBe(mine.id)
    expect(await findUndecidedFailureItemFor({ agentId: 'w-other-id', name: 'w', teamName: 'elsewhere' })).toBeUndefined()
    await decideAttentionItem(mine.id, { choice: 'continue', reason: 'ok' })
    expect(await findUndecidedFailureItemFor({ agentId: 'w@team', name: 'w', teamName: 'team' })).toBeUndefined()
  })
})
