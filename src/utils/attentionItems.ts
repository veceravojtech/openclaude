/**
 * Attention items (task-list-aware API). See attentionItemStore.ts for the
 * model, the file layout and the exactly-once / decide-once rules.
 *
 * Only the ROOT lead sees, gates on and decides items, so every item lives in
 * the root lead's task list (`getTaskListId()` on the lead, which is the root
 * team's name — the same list an in-process root-team member resolves to).
 *
 * Holds: tasks a failed worker releases get `metadata.attentionHold: <item
 * id>` in the same locked write that unassigns them (`unassignTeammateTasks`
 * with `attentionHold`). The item is always created BEFORE that write, and a
 * hold only counts while its item exists and is undecided
 * (`isHoldActiveIn`), so a hold can never be orphaned: deciding, superseding
 * or a lost item voids it even if the metadata clean-up below never ran.
 */
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDirOverrideForTesting } from './envUtils.js'
import { errorMessage } from './errors.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import {
  addHeldTaskIdsIn,
  ATTENTION_GUIDANCE,
  type AttentionBackend,
  type AttentionChoice,
  type AttentionItem,
  type AttentionRootCause,
  classifyFailureText,
  createAttentionItemIn,
  failureItemId,
  decideAttentionItemIn,
  listAttentionItemsIn,
  listUndecidedAttentionItemsIn,
  mutateAttentionItemIn,
  type NewAttentionItem,
  readAttentionItemIn,
  supersedeAttentionItemIn,
} from './attentionItemStore.js'
import { fileGapTasks, readFinalReview } from './finalReviews.js'
import {
  cancelTask,
  getTaskListId,
  getTasksDir,
  isTaskResolved,
  listTasks,
  type Task,
  TaskCancelError,
  updateTaskWith,
} from './tasks.js'

export {
  ATTENTION_CHOICES,
  ATTENTION_GUIDANCE,
  ATTENTION_ROOT_CAUSES,
  AttentionDecisionError,
  type AttentionItem,
  classifyFailureText,
  failureItemId,
  gapItemId,
  verdictItemId,
} from './attentionItemStore.js'

import { ATTENTION_DECIDE_TOOL_NAME } from '../tools/AttentionDecideTool/constants.js'

export { ATTENTION_DECIDE_TOOL_NAME }

export function getAttentionTasksDir(
  taskListId: string = getTaskListId(),
): string {
  return getTasksDir(taskListId)
}

export async function createAttentionItem(
  input: NewAttentionItem,
  taskListId: string = getTaskListId(),
): Promise<{ created: boolean; item: AttentionItem | undefined }> {
  return createAttentionItemIn(getTasksDir(taskListId), input)
}

export async function readAttentionItem(
  id: string,
  taskListId: string = getTaskListId(),
): Promise<AttentionItem | undefined> {
  return readAttentionItemIn(getTasksDir(taskListId), id)
}

export async function listAttentionItems(
  taskListId: string = getTaskListId(),
): Promise<AttentionItem[]> {
  return listAttentionItemsIn(getTasksDir(taskListId))
}

export async function listUndecidedAttentionItems(
  taskListId: string = getTaskListId(),
): Promise<AttentionItem[]> {
  return listUndecidedAttentionItemsIn(getTasksDir(taskListId))
}

/**
 * The newest undecided FAILURE item of one worker (matched by agent id, or
 * by name within its team), or undefined. Used where tasks are released
 * without a run id at hand (the ghost sweep).
 */
export async function findUndecidedFailureItemFor(
  agent: { agentId: string; name: string; teamName: string },
  taskListId: string = getTaskListId(),
): Promise<AttentionItem | undefined> {
  const matches = (await listUndecidedAttentionItems(taskListId)).filter(
    item =>
      item.kind === 'failure' &&
      (item.source.agentId === agent.agentId ||
        (item.source.agentName === agent.name &&
          item.source.teamName === agent.teamName)),
  )
  return matches.at(-1)
}

/**
 * Whether this process is the `bun test` runner. Bun sets no runner-only
 * environment variable (only NODE_ENV=test, which any shell or child process
 * can inherit), but the runner points `Bun.main` at the test file it is
 * executing — the built CLI never runs with a test file as its entry point.
 */
export function isBunTestRunner(
  main: string | undefined = (globalThis as { Bun?: { main?: string } }).Bun
    ?.main,
): boolean {
  return typeof main === 'string' && /\.(test|spec)\.[cm]?[jt]sx?$/.test(main)
}

/**
 * Under the `bun test` runner, the failure hooks write only into an isolated
 * config home (the testing override or an explicit config-dir env). Many
 * existing tests drive failed notifications without isolating it, and their
 * items would otherwise land in the developer's real ~/.openclaude task
 * lists — where an undecided item would block that developer's own spawns.
 * Keyed on the runner itself, never on NODE_ENV: a real session started with
 * NODE_ENV=test must still record its failures.
 */
export function attentionHookWritesAllowed(runnerMain?: string): boolean {
  // An undefined runnerMain falls back to the real Bun.main.
  if (!isBunTestRunner(runnerMain)) return true
  return (
    getClaudeConfigHomeDirOverrideForTesting() !== undefined ||
    Boolean(process.env.OPENCLAUDE_CONFIG_DIR) ||
    Boolean(process.env.CLAUDE_CONFIG_DIR)
  )
}

/**
 * Fire-and-forget creation for hooks that must never throw or block (the
 * notification path is synchronous). A failed write is logged at error level
 * and reported through `onLost`, so the caller can make the loss visible.
 */
export function noteAttentionItem(
  input: NewAttentionItem,
  options: { taskListId?: string; onLost?: (message: string) => void } = {},
): Promise<void> {
  if (!attentionHookWritesAllowed()) return Promise.resolve()
  let taskListId: string
  try {
    taskListId = options.taskListId ?? getTaskListId()
  } catch (error) {
    return Promise.resolve(reportLost(input.id, error, options.onLost))
  }
  const write = createAttentionItem(input, taskListId).then(
    ({ created }) => {
      if (created) {
        logForDebugging(`[attentionItems] created ${input.id} (${input.kind})`)
      }
    },
    error => reportLost(input.id, error, options.onLost),
  )
  pendingWrites.add(write)
  void write.finally(() => pendingWrites.delete(write))
  return write
}

const pendingWrites = new Set<Promise<void>>()

/** Resolves once every fire-and-forget item write started so far settled. */
export async function settleAttentionWritesForTesting(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites])
  }
}

function reportLost(
  id: string,
  error: unknown,
  onLost?: (message: string) => void,
): void {
  const message = `ATTENTION ITEM NOT RECORDED: ${id} could not be written (${errorMessage(error)}). This failure is not tracked; decide it by hand.`
  logForDebugging(`[attentionItems] ${message}`, { level: 'error' })
  try {
    onLost?.(message)
  } catch {
    // Reporting the loss must not throw either.
  }
}

/**
 * Makes a lost attention-item write visible to the lead: a notification line
 * in its next turn, in addition to the error log.
 */
export function reportLostAttentionItem(message: string): void {
  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

export type RunFailure = {
  /** Background task id (AppState) of the failed run. */
  taskId: string
  /** Distinguishes runs of the same task id (resume count). */
  runSeq: number
  description: string
  error?: string
  backend: AttentionBackend
  agentId?: string
  agentName?: string
  teamName?: string
  /** Overrides the free-text classification of `error`. */
  transient?: { transient: boolean; transientReason: string }
}

/** The attention item for a failed worker run (not yet written). */
export function runFailureItem(failure: RunFailure): NewAttentionItem {
  const who = failure.agentName ?? failure.description
  const classified = failure.transient ?? classifyFailureText(failure.error)
  return {
    id: failureItemId(failure.taskId, failure.runSeq),
    kind: 'failure',
    source: {
      taskId: failure.taskId,
      backend: failure.backend,
      ...(failure.agentId ? { agentId: failure.agentId } : {}),
      ...(failure.agentName ? { agentName: failure.agentName } : {}),
      ...(failure.teamName ? { teamName: failure.teamName } : {}),
    },
    summary: `${who} failed: ${failure.error || 'Unknown error'}`,
    ...(failure.description !== who ? { detail: failure.description } : {}),
    transient: classified.transient,
    transientReason: classified.transientReason,
    retryKey:
      failure.backend === 'local_agent'
        ? `task:${failure.taskId}`
        : `agent:${failure.agentId ?? failure.agentName ?? failure.taskId}`,
  }
}

/**
 * Fire-and-forget: record the failure item. Never throws; a lost write is
 * logged and surfaced to the lead as a notification line.
 */
export function noteRunFailure(
  failure: RunFailure,
  taskListId?: string,
): Promise<void> {
  try {
    return noteAttentionItem(runFailureItem(failure), {
      taskListId,
      onLost: reportLostAttentionItem,
    })
  } catch (error) {
    reportLost(failureItemId(failure.taskId, failure.runSeq), error, reportLostAttentionItem)
    return Promise.resolve()
  }
}

/**
 * A run failed again while its earlier failure item is still undecided: bring
 * the item up to date (latest reason, transient class, repeat count) instead of
 * raising another one, so the lead decides on what is true now. Best-effort,
 * and a no-op once the item is decided or superseded.
 */
export async function refreshFailureItem(
  failure: RunFailure,
  itemId: string,
  taskListId: string = getTaskListId(),
): Promise<void> {
  try {
    const next = runFailureItem(failure)
    await mutateAttentionItemIn(getTasksDir(taskListId), itemId, current => {
      if (current.status !== 'undecided') return null
      const repeatCount = (current.repeatCount ?? 0) + 1
      return {
        ...current,
        summary: `${next.summary} (failed again, ${repeatCount + 1} times)`,
        transient: next.transient,
        transientReason: next.transientReason,
        repeatCount,
      }
    })
  } catch (error) {
    logForDebugging(
      `[attentionItems] could not refresh ${itemId}: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Records the ids of tasks held by (or linked to) an item. Best-effort.
 * `heldTaskListId` is the list those tasks live in, when it is not the
 * item's own list.
 */
export async function linkTasksToAttentionItem(
  id: string,
  taskIds: readonly string[],
  taskListId: string = getTaskListId(),
  heldTaskListId?: string,
): Promise<void> {
  try {
    await addHeldTaskIdsIn(
      getTasksDir(taskListId),
      id,
      taskIds,
      heldTaskListId !== undefined && heldTaskListId !== taskListId
        ? heldTaskListId
        : undefined,
    )
  } catch (error) {
    logForDebugging(
      `[attentionItems] could not link tasks ${taskIds.join(', ')} to ${id}: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Removes `metadata.attentionHold` from every task still carrying this
 * item's id. Returns the ids released. A failure here is harmless: the hold
 * is already void once its item is no longer undecided.
 */
export async function releaseAttentionHolds(
  id: string,
  taskListId: string = getTaskListId(),
): Promise<string[]> {
  const released: string[] = []
  for (const list of await holdListsOf(id, taskListId)) {
    for (const task of await listTasks(list)) {
      if (task.metadata?.attentionHold !== id) continue
      try {
        await updateTaskWith(list, task.id, current => {
          if (current.metadata?.attentionHold !== id) return null
          const {
            attentionHold: _hold,
            attentionHoldList: _list,
            ...rest
          } = current.metadata
          return { metadata: rest }
        })
        released.push(task.id)
      } catch (error) {
        logForDebugging(
          `[attentionItems] could not release hold on #${task.id}: ${errorMessage(error)}`,
        )
      }
    }
  }
  return released
}

/** The item's own list plus the list its held tasks live in, if different. */
async function holdListsOf(id: string, taskListId: string): Promise<string[]> {
  const item = await readAttentionItemIn(getTasksDir(taskListId), id)
  const held = item?.source.heldTaskListId
  return held && held !== taskListId ? [taskListId, held] : [taskListId]
}

/**
 * Supersedes an UNDECIDED item (never a decided one) and releases its holds.
 * Used when the failure resolved itself (a pane teammate's late completion).
 */
export async function supersedeAttentionItem(
  id: string,
  reason: string,
  taskListId: string = getTaskListId(),
): Promise<boolean> {
  const superseded = await supersedeAttentionItemIn(
    getTasksDir(taskListId),
    id,
    reason,
  )
  if (superseded) await releaseAttentionHolds(id, taskListId)
  return superseded
}

export type AttentionDecisionOutcome = {
  item: AttentionItem
  released: string[]
  cancelled: string[]
  cancelErrors: string[]
  refiledGapTasks: string[]
  refileError?: string
  undecidedRemaining: number
}

/** Task-list tasks an abort cancels, per list: the linked ones (in the list
 * they live in), the tasks still held by the item, and (verdict) the tasks
 * citing the verifier. */
async function abortTargets(
  item: AttentionItem,
  taskListId: string,
): Promise<Map<string, Set<string>>> {
  const linkedList = item.source.heldTaskListId ?? taskListId
  const targets = new Map<string, Set<string>>()
  for (const list of new Set([taskListId, linkedList])) {
    const ids = new Set<string>(
      list === linkedList ? (item.source.taskListTaskIds ?? []) : [],
    )
    for (const task of await listTasks(list)) {
      if (task.metadata?.attentionHold === item.id) ids.add(task.id)
      if (
        item.kind === 'verdict' &&
        item.source.agentId &&
        task.metadata?.verifiedBy === item.source.agentId
      ) {
        ids.add(task.id)
      }
    }
    targets.set(list, ids)
  }
  return targets
}

/**
 * Records the one decision for an item and applies it:
 * - retry / patch / continue: release the item's holds (the tasks become
 *   claimable again). `continue` is a recorded acceptance only — it never
 *   satisfies a requiresVerification or requiresFinalReview gate.
 * - patch on a `gap` item also re-files any GAP task of that review that is
 *   missing (the recovery path for a GAPS record whose GAP tasks were lost).
 * - abort: cancel every linked non-terminal task, then release the holds.
 *   A task that cannot be cancelled (any error) is reported in
 *   `cancelErrors` and the rest are still cancelled. Nothing is killed.
 */
export async function decideAttentionItem(
  id: string,
  decision: {
    choice: AttentionChoice
    reason: string
    rootCause?: AttentionRootCause
  },
  taskListId: string = getTaskListId(),
  /** Test seam: the per-task cancel the abort applies. */
  deps: { cancelTask?: typeof cancelTask } = {},
): Promise<AttentionDecisionOutcome> {
  const tasksDir = getTasksDir(taskListId)
  const item = await decideAttentionItemIn(tasksDir, id, decision)
  const cancelled: string[] = []
  const cancelErrors: string[] = []
  let refiledGapTasks: string[] = []
  let refileError: string | undefined

  if (decision.choice === 'abort') {
    // The decision is already recorded, so nothing below may throw: a
    // half-applied abort would leave the rest of the tasks uncancelled and
    // the holds in place. Every error — a TaskCancelError or an I/O failure
    // on one task or one list — is recorded and the abort carries on.
    const cancel = deps.cancelTask ?? cancelTask
    let targets: Map<string, Set<string>> = new Map()
    try {
      targets = await abortTargets(item, taskListId)
    } catch (error) {
      cancelErrors.push(`listing the tasks to cancel: ${errorMessage(error)}`)
    }
    for (const [list, ids] of targets) {
      let byId: Map<string, Task>
      try {
        byId = new Map((await listTasks(list)).map(t => [t.id, t]))
      } catch (error) {
        cancelErrors.push(
          `task list '${list}' (${[...ids].map(i => `#${i}`).join(', ')}): ${errorMessage(error)}`,
        )
        continue
      }
      for (const taskId of ids) {
        const task = byId.get(taskId)
        if (!task || isTaskResolved(task.status)) continue
        try {
          await cancel(list, taskId)
          cancelled.push(taskId)
        } catch (error) {
          cancelErrors.push(
            `#${taskId}: ${error instanceof TaskCancelError ? error.message : errorMessage(error)}`,
          )
        }
      }
    }
  }

  if (decision.choice === 'patch' && item.kind === 'gap' && item.source.agentId) {
    try {
      const record = await readFinalReview(item.source.agentId, taskListId)
      if (record?.result === 'GAPS') {
        refiledGapTasks = await fileGapTasks(
          item.source.agentId,
          record.gaps,
          taskListId,
        )
      }
    } catch (error) {
      refileError = errorMessage(error)
    }
  }

  const released = await releaseAttentionHolds(id, taskListId)
  const undecidedRemaining = (await listUndecidedAttentionItemsIn(tasksDir))
    .length
  return {
    item,
    released,
    cancelled,
    cancelErrors,
    refiledGapTasks,
    ...(refileError ? { refileError } : {}),
    undecidedRemaining,
  }
}

function describeSource(item: AttentionItem): string {
  const s = item.source
  const who = s.agentName
    ? `${s.agentName}${s.teamName ? `@${s.teamName}` : ''}`
    : s.agentId
  return [
    who ? `worker ${who}` : undefined,
    s.backend,
    s.taskId ? `run ${s.taskId}` : undefined,
    s.taskListTaskIds?.length
      ? `${item.kind === 'failure' ? 'holding' : 'linked'} tasks ${s.taskListTaskIds.map(t => `#${t}`).join(', ')}`
      : undefined,
  ]
    .filter(Boolean)
    .join(', ')
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The per-turn reminder block for the lead (attention_items attachment). */
export function formatAttentionItemsReminder(items: readonly AttentionItem[]): string {
  const lines = items.map(item => {
    const transient = item.transient
      ? 'transient: yes (retry allowed)'
      : `transient: no${item.transientReason ? ` — ${item.transientReason}` : ''} (retry not allowed)`
    const source = describeSource(item)
    return `- ${item.id} [${item.kind}] ${oneLine(item.summary)}${source ? ` (${source})` : ''}; ${transient}`
  })
  return [
    `${items.length} failure(s) need your decision. New workers cannot be spawned (Agent tool, or resuming a stopped agent) until every item below is decided.`,
    ...lines,
    `Decide each with the ${ATTENTION_DECIDE_TOOL_NAME} tool: {id, decision, reason, root_cause?}. Decisions: retry (transient failures only, once per worker), patch (fix the input and redo; root_cause required: scope, spec, method, environment or unknown), continue (accept the outcome with a reason; it does not satisfy a verification or final-review gate), abort (cancel the linked tasks).`,
    ATTENTION_GUIDANCE,
  ].join('\n')
}

/** A spawn or resume refused by the root lead's spawn gate. */
export class AttentionSpawnBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttentionSpawnBlockedError'
  }
}

/** The error text for a blocked spawn, or undefined when nothing is pending. */
export function formatBlockedSpawnMessage(
  items: readonly AttentionItem[],
): string | undefined {
  if (items.length === 0) return undefined
  const list = items
    .map(i => `${i.id} (${i.kind}: ${oneLine(i.summary, 120)})`)
    .join('; ')
  return `Blocked: ${items.length} failure(s) need a decision before new work can be spawned: ${list}. Decide each with ${ATTENTION_DECIDE_TOOL_NAME} (retry | patch | continue | abort, with a reason). ${ATTENTION_GUIDANCE}`
}

/**
 * The root lead's spawn gate: the blocked message while any item is
 * undecided. Reading the store never throws here — an unreadable store does
 * not block (it is logged), matching the attachment, which then shows nothing.
 */
export async function checkAttentionSpawnGate(
  taskListId: string = getTaskListId(),
): Promise<string | undefined> {
  try {
    return formatBlockedSpawnMessage(
      await listUndecidedAttentionItems(taskListId),
    )
  } catch (error) {
    logForDebugging(
      `[attentionItems] spawn gate could not read items: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return undefined
  }
}
