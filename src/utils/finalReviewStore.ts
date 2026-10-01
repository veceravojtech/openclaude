/**
 * Low-level final-review store, the output parser, and the authoritative
 * final-review completion gate.
 *
 * Every function takes the task list's directory explicitly, so this module
 * never imports `./tasks.js`; `tasks.ts` can then enforce the gate inside its
 * locked write without an import cycle. Use `./finalReviews.js` for the
 * task-list-aware API (current task list by default, GAP task filing).
 *
 * Layout: `<tasksDir>/.final-reviews/<sanitized agentId>-<hash>.json`, holding
 * `{agentId, result, gaps, commit, model?, reason?, recordedAt}`. File names
 * use the same scheme as verification verdicts (`verdictFileName`).
 *
 * Limits: this is a guardrail against mistakes, not a security boundary. The
 * `requiresFinalReview` flag can be removed in a separate, earlier update;
 * one DONE can be cited by more than one task; anything with file-write
 * access to the tasks directory could forge a record; and a reviewer with
 * Bash could still read the task directory in the config home. Reviewer
 * isolation is by omission (cwd, prompt, tools), not a sandbox.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { FINAL_REVIEW_AGENT_TYPE } from '../tools/AgentTool/constants.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import {
  checkVerificationGateIn,
  VerificationGateError,
  verdictFileName,
} from './verificationVerdictStore.js'

export type FinalReviewResult = 'DONE' | 'GAPS' | 'MISSING'
export type GapSeverity = 'critical' | 'major' | 'minor'

export type FinalReviewGap = {
  id: string
  severity: GapSeverity
  requirement: string
  expected: string
  observed: string
  evidence: string
}

export type ParsedFinalReview =
  | { result: 'DONE' }
  | { result: 'GAPS'; gaps: FinalReviewGap[] }
  | { result: 'MISSING'; reason: string }

export type FinalReviewRecord = {
  agentId: string
  result: FinalReviewResult
  gaps: FinalReviewGap[]
  /** The resolved commit sha that was checked out for the reviewer. */
  commit: string
  model?: string
  /** Why the result is MISSING (parse or identity self-check failure). */
  reason?: string
  recordedAt: string
}

const FINAL_LINE = /^FINAL REVIEW: (DONE|GAPS)$/
// A line that looks like an attempt at a GAP line: optional leading
// whitespace/markdown, then `GAP-<digit>`. Every such line must be exactly
// in the strict format, or the whole report is MISSING.
const GAP_CANDIDATE = /^[^A-Za-z0-9]*GAP-[0-9]/i
const GAP_LINE =
  /^GAP-(\d{3,}) \| severity=([^|]*?) \| requirement=(.*?) \| expected=(.*?) \| observed=(.*?) \| evidence=(.*)$/
const SEVERITIES: readonly GapSeverity[] = ['critical', 'major', 'minor']

/**
 * Parses a final reviewer's report.
 *
 * The LAST non-empty line must be exactly `FINAL REVIEW: DONE` or
 * `FINAL REVIEW: GAPS` (trailing whitespace tolerated; markdown, leading
 * whitespace, punctuation or extra text are not). GAP lines have the form
 * `GAP-001 | severity=critical|major|minor | requirement=… | expected=… |
 * observed=… | evidence=…` with every field non-empty.
 *
 * Fails closed: DONE with any GAP line, GAPS with no GAP line, a malformed GAP
 * line, or a duplicate GAP id all give MISSING — never DONE.
 */
export function parseFinalReview(text: string): ParsedFinalReview {
  const lines = (text ?? '').split('\n').map(l => l.trimEnd())
  let last = lines.length - 1
  while (last >= 0 && lines[last] === '') last--
  if (last < 0) return { result: 'MISSING', reason: 'empty report' }
  const final = FINAL_LINE.exec(lines[last]!)
  if (!final) {
    return {
      result: 'MISSING',
      reason:
        'the last non-empty line is not exactly "FINAL REVIEW: DONE" or "FINAL REVIEW: GAPS"',
    }
  }
  const gaps: FinalReviewGap[] = []
  const seen = new Set<string>()
  for (let i = 0; i < last; i++) {
    const line = lines[i]!
    if (!GAP_CANDIDATE.test(line)) continue
    const match = GAP_LINE.exec(line)
    if (!match) {
      return {
        result: 'MISSING',
        reason: `malformed GAP line ${i + 1}: expected "GAP-001 | severity=critical|major|minor | requirement=… | expected=… | observed=… | evidence=…"`,
      }
    }
    const [, num, severity, requirement, expected, observed, evidence] =
      match as unknown as [string, string, string, string, string, string, string]
    const id = `GAP-${num}`
    if (!SEVERITIES.includes(severity as GapSeverity)) {
      return {
        result: 'MISSING',
        reason: `${id} has invalid severity "${severity}" (critical, major or minor)`,
      }
    }
    const fields = { requirement, expected, observed, evidence }
    for (const [name, value] of Object.entries(fields)) {
      if (value.trim() === '') {
        return { result: 'MISSING', reason: `${id} has an empty ${name}` }
      }
    }
    if (seen.has(id)) {
      return { result: 'MISSING', reason: `duplicate GAP id ${id}` }
    }
    seen.add(id)
    gaps.push({
      id,
      severity: severity as GapSeverity,
      requirement: requirement.trim(),
      expected: expected.trim(),
      observed: observed.trim(),
      evidence: evidence.trim(),
    })
  }
  if (final[1] === 'DONE') {
    if (gaps.length > 0) {
      return {
        result: 'MISSING',
        reason: 'the report ends with DONE but lists GAP lines',
      }
    }
    return { result: 'DONE' }
  }
  if (gaps.length === 0) {
    return {
      result: 'MISSING',
      reason: 'the report ends with GAPS but lists no GAP lines',
    }
  }
  return { result: 'GAPS', gaps }
}

/**
 * Values of the `REVIEW CWD: …` and `REVIEW HEAD: …` lines the reviewer must
 * echo (every occurrence, in order), for the caller's self-check.
 */
export function parseReviewIdentity(text: string): {
  cwds: string[]
  heads: string[]
} {
  const cwds: string[] = []
  const heads: string[] = []
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('REVIEW CWD: ')) cwds.push(line.slice(12).trim())
    else if (line.startsWith('REVIEW HEAD: ')) heads.push(line.slice(13).trim())
  }
  return { cwds, heads }
}

export function finalReviewsDirIn(tasksDir: string): string {
  return join(tasksDir, '.final-reviews')
}

export function finalReviewPathIn(tasksDir: string, agentId: string): string {
  return join(finalReviewsDirIn(tasksDir), verdictFileName(agentId))
}

/**
 * Atomically writes a final-review record (temp file + rename). Rejects on
 * any write failure.
 */
export async function writeFinalReviewIn(
  tasksDir: string,
  record: Omit<FinalReviewRecord, 'recordedAt'>,
): Promise<FinalReviewRecord> {
  const full: FinalReviewRecord = {
    ...record,
    recordedAt: new Date().toISOString(),
  }
  await mkdir(finalReviewsDirIn(tasksDir), { recursive: true })
  const finalPath = finalReviewPathIn(tasksDir, record.agentId)
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`
  try {
    await writeFile(tempPath, jsonStringify(full), {
      encoding: 'utf-8',
      flush: true,
    })
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
  return full
}

/**
 * Deletes the record for an agentId. A missing record is fine; any other
 * failure rejects.
 */
export async function clearFinalReviewIn(
  tasksDir: string,
  agentId: string,
): Promise<void> {
  try {
    await unlink(finalReviewPathIn(tasksDir, agentId))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return
    throw error
  }
}

/**
 * Reads the record for an agentId, or undefined when none exists (or it is
 * unreadable, malformed, or embeds a different agentId).
 */
export async function readFinalReviewIn(
  tasksDir: string,
  agentId: string,
): Promise<FinalReviewRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(finalReviewPathIn(tasksDir, agentId), 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(
        `[finalReviews] failed to read record for ${agentId}: ${errorMessage(error)}`,
      )
    }
    return undefined
  }
  try {
    const parsed = jsonParse(raw) as Partial<FinalReviewRecord> | null
    if (
      !parsed ||
      parsed.agentId !== agentId ||
      typeof parsed.recordedAt !== 'string' ||
      typeof parsed.commit !== 'string' ||
      !Array.isArray(parsed.gaps) ||
      !['DONE', 'GAPS', 'MISSING'].includes(parsed.result as string)
    ) {
      return undefined
    }
    return parsed as FinalReviewRecord
  } catch {
    return undefined
  }
}

/**
 * Thrown by `updateTask` when a write would complete a task flagged
 * `requiresFinalReview` without a DONE record for its `finalReviewedBy`, or
 * while GAP tasks filed against it are still open. Nothing is written.
 */
export class FinalReviewGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalReviewGateError'
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : []
}

/**
 * Every final-reviewer agentId associated with a task: its
 * `finalReviewedBy` plus the `finalReviewers` list that recording a GAPS
 * result appends to each flagged task (from the stored OR the resulting
 * metadata, so it cannot be dropped in the completing write).
 */
export function finalReviewersOf(
  storedMetadata: Record<string, unknown> | undefined,
  resultingMetadata: Record<string, unknown> | undefined,
): string[] {
  const ids = new Set<string>([
    ...stringList(storedMetadata?.finalReviewers),
    ...stringList(resultingMetadata?.finalReviewers),
  ])
  for (const meta of [storedMetadata, resultingMetadata]) {
    const by = meta?.finalReviewedBy
    if (typeof by === 'string' && by.trim() !== '') ids.add(by)
  }
  return [...ids]
}

type OpenGapTask = { id: string; subject: string; gapOf: string }
type GapTask = OpenGapTask & { gapId?: string; open: boolean }

/**
 * Open (not completed, not cancelled) tasks in `tasksDir` whose
 * `metadata.gapOf` is one of `reviewerIds`. Reads the task files directly so
 * this module stays independent of tasks.ts.
 */
export async function listOpenGapTasksIn(
  tasksDir: string,
  reviewerIds: readonly string[],
): Promise<OpenGapTask[]> {
  return (await listGapTasksIn(tasksDir, reviewerIds))
    .filter(t => t.open)
    .map(({ id, subject, gapOf }) => ({ id, subject, gapOf }))
}

/**
 * GAPs recorded by these reviewers that have no task at all (open or
 * resolved), as `<reviewer>/<gapId>`. A GAPS record is written before its
 * GAP tasks are filed, so a crash or a failed `fileGapTasks` in between
 * leaves GAPs that no task tracks; the gate treats them as open.
 */
export async function listUnfiledGapsIn(
  tasksDir: string,
  reviewerIds: readonly string[],
): Promise<{ reviewer: string; gapId: string }[]> {
  if (reviewerIds.length === 0) return []
  const filed = new Set(
    (await listGapTasksIn(tasksDir, reviewerIds, true)).map(
      t => `${t.gapOf}\u0000${t.gapId ?? ''}`,
    ),
  )
  const missing: { reviewer: string; gapId: string }[] = []
  for (const reviewer of reviewerIds) {
    const record = await readFinalReviewIn(tasksDir, reviewer)
    if (record?.result !== 'GAPS') continue
    for (const gap of record.gaps) {
      if (!filed.has(`${reviewer}\u0000${gap.id}`)) {
        missing.push({ reviewer, gapId: gap.id })
      }
    }
  }
  return missing
}

async function listGapTasksIn(
  tasksDir: string,
  reviewerIds: readonly string[],
  includeResolved = false,
): Promise<GapTask[]> {
  if (reviewerIds.length === 0) return []
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    return []
  }
  const wanted = new Set(reviewerIds)
  const open: GapTask[] = []
  await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async file => {
        try {
          const task = jsonParse(
            await readFile(join(tasksDir, file), 'utf-8'),
          ) as {
            id?: unknown
            subject?: unknown
            status?: unknown
            metadata?: Record<string, unknown>
          } | null
          const gapOf = task?.metadata?.gapOf
          if (!task || typeof gapOf !== 'string' || !wanted.has(gapOf)) {
            return
          }
          const isOpen =
            task.status !== 'completed' && task.status !== 'cancelled'
          if (!isOpen && !includeResolved) return
          const gapId = task.metadata?.gapId
          open.push({
            id: typeof task.id === 'string' ? task.id : file.replace(/\.json$/, ''),
            subject: typeof task.subject === 'string' ? task.subject : '',
            gapOf,
            gapId: typeof gapId === 'string' ? gapId : undefined,
            open: isOpen,
          })
        } catch {
          // Unreadable task files are not GAP tasks we can see.
        }
      }),
  )
  return open.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
}

/**
 * Returns why a task may not be completed, or undefined when completion is
 * allowed (including every task without the flag).
 *
 * The flag applies when set on the stored task OR on the resulting task, so
 * clearing it in the completing write cannot bypass the gate.
 * `finalReviewedBy` is read from the resulting metadata, so it may be
 * supplied in that write; it must name a DONE record. Completion is also
 * refused while any open task has `metadata.gapOf` equal to a reviewer
 * associated with this task (see `finalReviewersOf`) — `blockedBy` alone is
 * advisory and would not stop a completion.
 */
export async function checkFinalReviewGateIn(
  tasksDir: string,
  storedMetadata: Record<string, unknown> | undefined,
  resultingMetadata: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const required =
    storedMetadata?.requiresFinalReview === true ||
    resultingMetadata?.requiresFinalReview === true
  if (!required) return undefined
  const rerun = `Run the final reviewer (subagent_type="${FINAL_REVIEW_AGENT_TYPE}", review_commit=<the commit to review>, prompt=<the original user request verbatim>) until it ends with "FINAL REVIEW: DONE", resolve every GAP task it filed, then complete the task with metadata.finalReviewedBy set to that reviewer's agentId.`
  const reviewedBy = resultingMetadata?.finalReviewedBy
  if (typeof reviewedBy !== 'string' || reviewedBy.trim() === '') {
    return `Cannot complete task: it has requiresFinalReview: true but metadata.finalReviewedBy is not set. ${rerun}`
  }
  const record = await readFinalReviewIn(tasksDir, reviewedBy)
  if (!record) {
    return `Cannot complete task: requiresFinalReview is set but no final review was recorded for reviewer '${reviewedBy}'. ${rerun}`
  }
  if (record.result !== 'DONE') {
    const found =
      record.result === 'MISSING'
        ? `MISSING (${record.reason ?? 'no valid "FINAL REVIEW: DONE|GAPS" report'})`
        : `GAPS (${record.gaps.map(g => g.id).join(', ')})`
    return `Cannot complete task: final reviewer '${reviewedBy}' recorded ${found}; only DONE allows completion. ${rerun}`
  }
  const reviewers = finalReviewersOf(storedMetadata, resultingMetadata)
  const openGaps = await listOpenGapTasksIn(tasksDir, reviewers)
  const unfiled = await listUnfiledGapsIn(tasksDir, reviewers)
  if (unfiled.length > 0) {
    const list = unfiled.map(g => `${g.gapId} (reviewer ${g.reviewer})`).join(', ')
    return `Cannot complete task: a final review recorded GAPs that have no GAP task yet: ${list}. Re-file them with AttentionDecide (decision "patch" on the reviewer's gap item re-files missing GAP tasks), resolve each GAP task, then complete this task again.`
  }
  if (openGaps.length > 0) {
    const list = openGaps
      .map(t => `#${t.id}${t.subject ? ` (${t.subject})` : ''}`)
      .join(', ')
    return `Cannot complete task: GAP tasks filed by a final review are still open: ${list}. Resolve each one (complete it, or cancel it if it no longer applies), then complete this task again.`
  }
  return undefined
}

/**
 * Both completion gates, verification first: returns the error to throw
 * (VerificationGateError or FinalReviewGateError), or undefined when the
 * transition into 'completed' is allowed.
 */
export async function checkCompletionGatesIn(
  tasksDir: string,
  storedMetadata: Record<string, unknown> | undefined,
  resultingMetadata: Record<string, unknown> | undefined,
): Promise<VerificationGateError | FinalReviewGateError | undefined> {
  const verification = await checkVerificationGateIn(
    tasksDir,
    storedMetadata,
    resultingMetadata,
  )
  if (verification) return new VerificationGateError(verification)
  const finalReview = await checkFinalReviewGateIn(
    tasksDir,
    storedMetadata,
    resultingMetadata,
  )
  if (finalReview) return new FinalReviewGateError(finalReview)
  return undefined
}
