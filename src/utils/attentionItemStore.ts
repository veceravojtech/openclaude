/**
 * Low-level attention-item store (Phase 5: forced decisions on failures).
 *
 * An attention item is a failure the root lead must act on: a failed worker
 * run (`failure`), a verifier whose verdict was not PASS (`verdict`), or a
 * final review that found GAPs (`gap`). Each item is resolved by exactly one
 * recorded decision — retry (transient failures only), patch, continue or
 * abort — or superseded by the system (a pane teammate's late completion).
 * While any item is undecided the lead cannot spawn new work.
 *
 * Every function takes the task list's directory explicitly, so this module
 * never imports `./tasks.js` (tasks.ts reads holds through it inside
 * `claimTask`). Use `./attentionItems.js` for the task-list-aware API.
 *
 * Layout: `<tasksDir>/.attention/<sanitized id>-<hash>.json`. Ids are
 * deterministic (`failure-<taskId>-<runSeq>`, `verdict-<verifierAgentId>`,
 * `gap-<reviewerAgentId>`), so every hook that sees the same failure computes
 * the same id and only the first create wins: creation is exactly-once via a
 * hard link of a fully written temp file (EEXIST = already created, no-op).
 *
 * A decision is written under a lock on the item file: re-read, require
 * `undecided`, write atomically (temp + rename). Malformed files are skipped
 * on read, never fatal.
 *
 * Limits: a guardrail, not a security boundary — anything with write access
 * to the tasks directory can forge or delete an item.
 */
import { createHash } from 'crypto'
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import * as lockfile from './lockfile.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

export type AttentionKind = 'failure' | 'verdict' | 'gap'
export type AttentionStatus = 'undecided' | 'decided' | 'superseded'
export type AttentionChoice = 'retry' | 'patch' | 'continue' | 'abort'
export type AttentionRootCause =
  | 'scope'
  | 'spec'
  | 'method'
  | 'environment'
  | 'unknown'
export type AttentionBackend = 'in_process' | 'pane' | 'local_agent'

export const ATTENTION_CHOICES: readonly AttentionChoice[] = [
  'retry',
  'patch',
  'continue',
  'abort',
]
export const ATTENTION_ROOT_CAUSES: readonly AttentionRootCause[] = [
  'scope',
  'spec',
  'method',
  'environment',
  'unknown',
]

export type AttentionSource = {
  /** Background task id (AppState) of the failed run. */
  taskId?: string
  agentId?: string
  agentName?: string
  teamName?: string
  backend?: AttentionBackend
  /**
   * Task-list task ids linked to this item: for a failure, the tasks the
   * failed worker released and this item holds; for a verdict or gap, the
   * work under review.
   */
  taskListTaskIds?: string[]
  /**
   * The task list the held tasks live in, when it is not the list this item
   * is stored in (an in-process root-team member releases its tasks in the
   * lead session's list; the item lives in the lead's current list).
   */
  heldTaskListId?: string
}

export type AttentionDecisionRecord = {
  choice: AttentionChoice
  reason: string
  rootCause?: AttentionRootCause
  decidedAt: string
}

export type AttentionItem = {
  id: string
  kind: AttentionKind
  status: AttentionStatus
  createdAt: string
  source: AttentionSource
  summary: string
  detail?: string
  transient: boolean
  transientReason?: string
  /**
   * Identity the retry cap is counted on: the same key may be retried once.
   * `task:<taskId>` for a local agent (a resume keeps it), `agent:<agentId>`
   * for a teammate (a respawn under the same name keeps it).
   */
  retryKey?: string
  decision?: AttentionDecisionRecord
  supersededReason?: string
}

export type NewAttentionItem = Omit<
  AttentionItem,
  'status' | 'createdAt' | 'decision' | 'supersededReason'
>

export const ATTENTION_GUIDANCE =
  'Fix the earliest wrong input — the scope, the spec or the method you gave — not the symptom. A retry only helps when the failure was transient.'

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}

export function failureItemId(taskId: string, runSeq: number | string): string {
  return `failure-${taskId}-${runSeq}`
}
export function verdictItemId(verifierAgentId: string): string {
  return `verdict-${verifierAgentId}`
}
export function gapItemId(reviewerAgentId: string): string {
  return `gap-${reviewerAgentId}`
}

export function attentionDirIn(tasksDir: string): string {
  return join(tasksDir, '.attention')
}

/** Sanitized id (readable) plus a short hash of the raw id (unique). */
export function attentionFileName(id: string): string {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 12)
  return `${readable}-${hash}.json`
}

export function attentionPathIn(tasksDir: string, id: string): string {
  return join(attentionDirIn(tasksDir), attentionFileName(id))
}

function tempPathFor(finalPath: string): string {
  return `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`
}

async function writeAtomically(path: string, item: AttentionItem): Promise<void> {
  const temp = tempPathFor(path)
  try {
    await writeFile(temp, jsonStringify(item), { encoding: 'utf-8', flush: true })
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

const KINDS = new Set(['failure', 'verdict', 'gap'])
const STATUSES = new Set(['undecided', 'decided', 'superseded'])

function parseItem(raw: string, expectedId?: string): AttentionItem | undefined {
  try {
    const item = jsonParse(raw) as Partial<AttentionItem> | null
    if (
      !item ||
      typeof item.id !== 'string' ||
      (expectedId !== undefined && item.id !== expectedId) ||
      !KINDS.has(item.kind as string) ||
      !STATUSES.has(item.status as string) ||
      typeof item.summary !== 'string' ||
      typeof item.transient !== 'boolean' ||
      typeof item.createdAt !== 'string' ||
      typeof item.source !== 'object' ||
      item.source === null
    ) {
      return undefined
    }
    return item as AttentionItem
  } catch {
    return undefined
  }
}

/** The item with this id, or undefined (missing, unreadable or malformed). */
export async function readAttentionItemIn(
  tasksDir: string,
  id: string,
): Promise<AttentionItem | undefined> {
  let raw: string
  try {
    raw = await readFile(attentionPathIn(tasksDir, id), 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(
        `[attentionItems] failed to read ${id}: ${errorMessage(error)}`,
      )
    }
    return undefined
  }
  return parseItem(raw, id)
}

/**
 * Every readable item, oldest first. One readdir; [] when the directory does
 * not exist. Malformed or half-written files are skipped.
 */
export async function listAttentionItemsIn(
  tasksDir: string,
  filter?: { status?: AttentionStatus },
): Promise<AttentionItem[]> {
  let files: string[]
  try {
    files = await readdir(attentionDirIn(tasksDir))
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(
        `[attentionItems] failed to list items: ${errorMessage(error)}`,
      )
    }
    return []
  }
  const items = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        try {
          return parseItem(
            await readFile(join(attentionDirIn(tasksDir), f), 'utf-8'),
          )
        } catch {
          return undefined
        }
      }),
  )
  return items
    .filter((i): i is AttentionItem => i !== undefined)
    .filter(i => !filter?.status || i.status === filter.status)
    .sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
}

export async function listUndecidedAttentionItemsIn(
  tasksDir: string,
): Promise<AttentionItem[]> {
  return listAttentionItemsIn(tasksDir, { status: 'undecided' })
}

/**
 * Creates the item exactly once. The record is fully written to a temp file
 * and then hard-linked into place, so a reader never sees a partial file and
 * a concurrent or repeated create of the same id is a no-op
 * (`created: false`, with the existing item when readable).
 *
 * The retry cap is applied here: a transient item whose `retryKey` already
 * had a `retry` decision is created non-transient.
 */
export async function createAttentionItemIn(
  tasksDir: string,
  input: NewAttentionItem,
): Promise<{ created: boolean; item: AttentionItem | undefined }> {
  const dir = attentionDirIn(tasksDir)
  await mkdir(dir, { recursive: true })
  const path = attentionPathIn(tasksDir, input.id)
  let transient = input.transient
  let transientReason = input.transientReason
  if (transient && input.retryKey) {
    const retried = (await listAttentionItemsIn(tasksDir)).find(
      i =>
        i.id !== input.id &&
        i.retryKey === input.retryKey &&
        i.decision?.choice === 'retry',
    )
    if (retried) {
      transient = false
      transientReason = `retry already used once for this worker (${retried.id}); fix the input instead`
    }
  }
  const item: AttentionItem = {
    ...input,
    transient,
    ...(transientReason !== undefined ? { transientReason } : {}),
    status: 'undecided',
    createdAt: new Date().toISOString(),
  }
  const temp = tempPathFor(path)
  try {
    await writeFile(temp, jsonStringify(item), { encoding: 'utf-8', flush: true })
    try {
      await link(temp, path)
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST') {
        return { created: false, item: await readAttentionItemIn(tasksDir, input.id) }
      }
      throw error
    }
    return { created: true, item }
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/** Thrown when a decision or supersede cannot be applied. */
export class AttentionDecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttentionDecisionError'
  }
}

/**
 * Runs `fn` on the current item under the item-file lock and writes back
 * what it returns (null = no change). Throws AttentionDecisionError when the
 * item does not exist.
 */
export async function mutateAttentionItemIn(
  tasksDir: string,
  id: string,
  fn: (current: AttentionItem) => AttentionItem | null,
): Promise<AttentionItem> {
  const path = attentionPathIn(tasksDir, id)
  if (!(await readAttentionItemIn(tasksDir, id))) {
    throw new AttentionDecisionError(`No attention item '${id}'.`)
  }
  const release = await lockfile.lock(path, LOCK_OPTIONS)
  try {
    const current = await readAttentionItemIn(tasksDir, id)
    if (!current) throw new AttentionDecisionError(`No attention item '${id}'.`)
    const next = fn(current)
    if (!next) return current
    await writeAtomically(path, next)
    return next
  } finally {
    await release()
  }
}

/**
 * Records the one decision for an undecided item. Rejects an item that is
 * already decided ("already decided: <choice>") or superseded, a retry of a
 * non-transient item, a patch without a root cause, and a retry whose
 * `retryKey` was already retried by another item.
 */
export async function decideAttentionItemIn(
  tasksDir: string,
  id: string,
  decision: {
    choice: AttentionChoice
    reason: string
    rootCause?: AttentionRootCause
  },
): Promise<AttentionItem> {
  if (!ATTENTION_CHOICES.includes(decision.choice)) {
    throw new AttentionDecisionError(`Unknown decision '${decision.choice}'.`)
  }
  if (!decision.reason || decision.reason.trim() === '') {
    throw new AttentionDecisionError('A decision needs a non-empty reason.')
  }
  if (decision.choice === 'patch' && !decision.rootCause) {
    throw new AttentionDecisionError(
      'A patch decision needs root_cause (scope, spec, method, environment or unknown): name the earliest wrong input you are fixing.',
    )
  }
  if (decision.rootCause && !ATTENTION_ROOT_CAUSES.includes(decision.rootCause)) {
    throw new AttentionDecisionError(`Unknown root_cause '${decision.rootCause}'.`)
  }
  const others =
    decision.choice === 'retry' ? await listAttentionItemsIn(tasksDir) : []
  return mutateAttentionItemIn(tasksDir, id, current => {
    if (current.status === 'decided') {
      throw new AttentionDecisionError(
        `Attention item '${id}' is already decided: ${current.decision?.choice ?? 'unknown'}.`,
      )
    }
    if (current.status === 'superseded') {
      throw new AttentionDecisionError(
        `Attention item '${id}' was superseded (${current.supersededReason ?? 'no reason'}); nothing to decide.`,
      )
    }
    if (decision.choice === 'retry') {
      if (!current.transient) {
        throw new AttentionDecisionError(
          `Cannot retry '${id}': it is not a transient failure${current.transientReason ? ` (${current.transientReason})` : ''}. Decide patch (fix the earliest wrong input), continue or abort.`,
        )
      }
      const retried = current.retryKey
        ? others.find(
            o =>
              o.id !== id &&
              o.retryKey === current.retryKey &&
              o.decision?.choice === 'retry',
          )
        : undefined
      if (retried) {
        throw new AttentionDecisionError(
          `Cannot retry '${id}': this worker was already retried once (${retried.id}). Decide patch, continue or abort.`,
        )
      }
    }
    return {
      ...current,
      status: 'decided',
      decision: {
        choice: decision.choice,
        reason: decision.reason.trim(),
        ...(decision.rootCause ? { rootCause: decision.rootCause } : {}),
        decidedAt: new Date().toISOString(),
      },
    }
  })
}

/**
 * Marks an UNDECIDED item superseded. A decided (or already superseded) item
 * is never touched. Returns whether this call superseded it; a missing item
 * is false.
 */
export async function supersedeAttentionItemIn(
  tasksDir: string,
  id: string,
  reason: string,
): Promise<boolean> {
  if (!(await readAttentionItemIn(tasksDir, id))) return false
  let changed = false
  await mutateAttentionItemIn(tasksDir, id, current => {
    if (current.status !== 'undecided') return null
    changed = true
    return { ...current, status: 'superseded', supersededReason: reason }
  })
  return changed
}

/** Adds task-list task ids to the item's `source.taskListTaskIds`. */
export async function addHeldTaskIdsIn(
  tasksDir: string,
  id: string,
  taskIds: readonly string[],
  heldTaskListId?: string,
): Promise<void> {
  if (taskIds.length === 0) return
  await mutateAttentionItemIn(tasksDir, id, current => {
    const existing = current.source.taskListTaskIds ?? []
    const merged = [...new Set([...existing, ...taskIds])]
    const listChanged =
      heldTaskListId !== undefined &&
      current.source.heldTaskListId !== heldTaskListId
    if (merged.length === existing.length && !listChanged) return null
    return {
      ...current,
      source: {
        ...current.source,
        taskListTaskIds: merged,
        ...(heldTaskListId !== undefined ? { heldTaskListId } : {}),
      },
    }
  })
}

/**
 * Whether `metadata.attentionHold` still holds a task: only while the item
 * it names exists and is undecided. A hold whose item is decided,
 * superseded, missing or malformed is void, so a hold can never strand a
 * task even if its release write was lost.
 */
export async function isHoldActiveIn(
  tasksDir: string,
  metadata: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const hold = metadata?.attentionHold
  if (typeof hold !== 'string' || hold === '') return undefined
  const item = await readAttentionItemIn(tasksDir, hold)
  return item?.status === 'undecided' ? hold : undefined
}

/**
 * Transient classification for a free-text failure (a local agent's error):
 * provider rate limits and quota are transient; authentication and anything
 * unrecognised are not.
 */
export function classifyFailureText(text: string | undefined): {
  transient: boolean
  transientReason: string
} {
  const t = text ?? ''
  if (/OAuth token (has been )?revoked|Please run \/login|authentication/i.test(t)) {
    return { transient: false, transientReason: 'authentication failure' }
  }
  if (/quota exhausted|insufficient_quota|exceeded your current quota/i.test(t)) {
    return { transient: true, transientReason: 'provider quota' }
  }
  if (/rate limit|\b429\b/i.test(t)) {
    return { transient: true, transientReason: 'provider rate limit' }
  }
  return { transient: false, transientReason: 'unrecognised error' }
}
