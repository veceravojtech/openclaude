/**
 * Code-enforced final reviews (task-list-aware API).
 *
 * The built-in final reviewer sees only the original request and a clean,
 * detached worktree of one commit, and must end its report with a literal
 * `FINAL REVIEW: DONE` or `FINAL REVIEW: GAPS` line. This module persists the
 * parsed result per reviewer agentId so a task flagged `requiresFinalReview`
 * can only be completed when its `finalReviewedBy` reviewer recorded DONE and
 * no GAP task filed by a reviewer of that task is still open. The gate itself
 * is enforced inside the locked write in `tasks.ts` (`updateTask`), which
 * throws `FinalReviewGateError`.
 *
 * Every GAP of a GAPS result becomes a task (`metadata.gapOf` = reviewer
 * agentId) that blocks every open flagged task; see `fileGapTasks`.
 *
 * Layout and parsing rules live in `finalReviewStore.ts`. Limits: see there.
 */
import {
  blockTask,
  createTask,
  getTaskListId,
  getTasksDir,
  isTaskResolved,
  listTasks,
  updateTaskWith,
} from './tasks.js'
import {
  clearFinalReviewIn,
  type FinalReviewGap,
  type FinalReviewRecord,
  finalReviewPathIn,
  finalReviewsDirIn,
  readFinalReviewIn,
  writeFinalReviewIn,
} from './finalReviewStore.js'

export {
  checkCompletionGatesIn,
  type FinalReviewGap,
  FinalReviewGateError,
  type FinalReviewRecord,
  type FinalReviewResult,
  parseFinalReview,
  parseReviewIdentity,
  type ParsedFinalReview,
} from './finalReviewStore.js'

export function getFinalReviewsDir(
  taskListId: string = getTaskListId(),
): string {
  return finalReviewsDirIn(getTasksDir(taskListId))
}

export function getFinalReviewPath(
  agentId: string,
  taskListId: string = getTaskListId(),
): string {
  return finalReviewPathIn(getTasksDir(taskListId), agentId)
}

/**
 * Atomically writes the record for a final reviewer run. A later record for
 * the same agentId (e.g. a resumed reviewer) replaces it. Rejects when the
 * write fails.
 */
export async function recordFinalReview(
  record: Omit<FinalReviewRecord, 'recordedAt'>,
  taskListId: string = getTaskListId(),
): Promise<FinalReviewRecord> {
  return writeFinalReviewIn(getTasksDir(taskListId), record)
}

export async function clearFinalReview(
  agentId: string,
  taskListId: string = getTaskListId(),
): Promise<void> {
  return clearFinalReviewIn(getTasksDir(taskListId), agentId)
}

export async function readFinalReview(
  agentId: string,
  taskListId: string = getTaskListId(),
): Promise<FinalReviewRecord | undefined> {
  return readFinalReviewIn(getTasksDir(taskListId), agentId)
}

function gapDescription(gap: FinalReviewGap, agentId: string): string {
  return [
    `Severity: ${gap.severity}`,
    `Expected: ${gap.expected}`,
    `Observed: ${gap.observed}`,
    `Evidence: ${gap.evidence}`,
    '',
    `Filed by final reviewer ${agentId}. Tasks with requiresFinalReview cannot be completed while this task is open.`,
  ].join('\n')
}

/**
 * Turns each GAP into a pending task (`metadata: {gapOf: agentId, gapId,
 * severity, source: 'final-review'}`) and makes it block every open task
 * flagged `requiresFinalReview`, whose `metadata.finalReviewers` also gains
 * `agentId` so the gate can find these GAP tasks even after the flagged task
 * is superseded or cites a different reviewer.
 *
 * Idempotent per (agentId, gapId): a GAP that already has a task is not filed
 * again. Returns the ids of every GAP task of this reviewer for these gaps,
 * in GAP order (existing and newly created).
 */
export async function fileGapTasks(
  agentId: string,
  gaps: readonly FinalReviewGap[],
  taskListId: string = getTaskListId(),
): Promise<string[]> {
  const before = await listTasks(taskListId)
  const existing = new Map<string, string>()
  for (const task of before) {
    if (
      task.metadata?.gapOf === agentId &&
      typeof task.metadata.gapId === 'string'
    ) {
      existing.set(task.metadata.gapId, task.id)
    }
  }
  const ids: string[] = []
  for (const gap of gaps) {
    const already = existing.get(gap.id)
    if (already) {
      ids.push(already)
      continue
    }
    const id = await createTask(taskListId, {
      subject: `${gap.id}: ${gap.requirement}`,
      description: gapDescription(gap, agentId),
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: {
        gapOf: agentId,
        gapId: gap.id,
        severity: gap.severity,
        source: 'final-review',
      },
    })
    existing.set(gap.id, id)
    ids.push(id)
  }

  const flagged = (await listTasks(taskListId)).filter(
    t =>
      t.metadata?.requiresFinalReview === true &&
      !isTaskResolved(t.status) &&
      typeof t.metadata?.gapOf !== 'string',
  )
  for (const task of flagged) {
    await updateTaskWith(taskListId, task.id, current => {
      const reviewers = Array.isArray(current.metadata?.finalReviewers)
        ? (current.metadata.finalReviewers as unknown[])
        : []
      if (reviewers.includes(agentId)) return null
      return {
        metadata: {
          ...(current.metadata ?? {}),
          finalReviewers: [...reviewers, agentId],
        },
      }
    })
    for (const gapTaskId of ids) {
      await blockTask(taskListId, gapTaskId, task.id)
    }
  }
  return ids
}
