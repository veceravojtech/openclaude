/**
 * Low-level verdict store and the authoritative completion gate.
 *
 * Every function takes the task list's directory explicitly, so this module
 * never imports `./tasks.js`. That lets `tasks.ts` enforce the gate inside
 * its locked write without an import cycle. Use `./verificationVerdicts.js`
 * for the task-list-aware API (current task list by default).
 *
 * Layout: `<tasksDir>/.verdicts/<sanitized agentId>-<hash>.json`, holding
 * `{agentId, verdict, recordedAt}`. The hash is over the raw agentId, so two
 * ids that sanitize to the same text still get different files; the embedded
 * agentId is re-checked on read as a second guard.
 *
 * Limits: this is a guardrail against mistakes, not a security boundary. The
 * `requiresVerification` flag can be removed in a separate, earlier update;
 * one PASS can be cited by more than one task; and anything with file-write
 * access to the tasks directory could forge a record.
 */
import { createHash } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { VERIFICATION_AGENT_TYPE } from '../tools/AgentTool/constants.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

export type RecordedVerdict = 'PASS' | 'FAIL' | 'PARTIAL'
export type ParsedVerdict = RecordedVerdict | 'MISSING'

export type VerdictRecord = {
  agentId: string
  verdict: ParsedVerdict
  recordedAt: string
}

const VERDICT_LINE = /^VERDICT: (PASS|FAIL|PARTIAL)$/

/**
 * Returns the verdict from the LAST line that is exactly
 * `VERDICT: PASS`, `VERDICT: FAIL` or `VERDICT: PARTIAL`; no such line gives
 * MISSING.
 *
 * Matching rule: trailing whitespace (spaces, tabs, and the `\r` of CRLF
 * line endings) is tolerated. Everything else is rejected: leading
 * whitespace, markdown (`**VERDICT: PASS**`, `` `VERDICT: PASS` ``),
 * lowercase, punctuation (`VERDICT: PASS.`), or any extra text on the line.
 */
export function parseVerdict(text: string): ParsedVerdict {
  if (!text) return 'MISSING'
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = VERDICT_LINE.exec(lines[i]!.trimEnd())
    if (match) return match[1] as RecordedVerdict
  }
  return 'MISSING'
}

export function verdictsDirIn(tasksDir: string): string {
  return join(tasksDir, '.verdicts')
}

/**
 * Filename for an agentId: the sanitized id (readable) plus a short hash of
 * the raw id (unique), so ids such as `a/b` and `a:b` never share a file.
 */
export function verdictFileName(agentId: string): string {
  const readable = agentId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)
  const hash = createHash('sha256').update(agentId).digest('hex').slice(0, 12)
  return `${readable}-${hash}.json`
}

export function verdictPathIn(tasksDir: string, agentId: string): string {
  return join(verdictsDirIn(tasksDir), verdictFileName(agentId))
}

/**
 * Atomically writes `{agentId, verdict, recordedAt}` (temp file + rename, so
 * concurrent readers never see a partial file). Rejects on any write failure.
 */
export async function writeVerdictIn(
  tasksDir: string,
  agentId: string,
  verdict: ParsedVerdict,
): Promise<VerdictRecord> {
  const record: VerdictRecord = {
    agentId,
    verdict,
    recordedAt: new Date().toISOString(),
  }
  await mkdir(verdictsDirIn(tasksDir), { recursive: true })
  const finalPath = verdictPathIn(tasksDir, agentId)
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`
  try {
    await writeFile(tempPath, jsonStringify(record), {
      encoding: 'utf-8',
      flush: true,
    })
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
  return record
}

/**
 * Deletes the record for an agentId. A missing record is fine; any other
 * failure rejects, so callers never proceed believing a stale record is gone.
 */
export async function clearVerdictIn(
  tasksDir: string,
  agentId: string,
): Promise<void> {
  try {
    await unlink(verdictPathIn(tasksDir, agentId))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return
    throw error
  }
}

/**
 * Reads the record for an agentId, or undefined when none exists (or it is
 * unreadable, malformed, or embeds a different agentId).
 */
export async function readVerdictIn(
  tasksDir: string,
  agentId: string,
): Promise<VerdictRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(verdictPathIn(tasksDir, agentId), 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(
        `[verificationVerdicts] failed to read verdict for ${agentId}: ${errorMessage(error)}`,
      )
    }
    return undefined
  }
  try {
    const parsed = jsonParse(raw) as Partial<VerdictRecord> | null
    if (
      !parsed ||
      parsed.agentId !== agentId ||
      typeof parsed.recordedAt !== 'string' ||
      !['PASS', 'FAIL', 'PARTIAL', 'MISSING'].includes(parsed.verdict as string)
    ) {
      return undefined
    }
    return parsed as VerdictRecord
  } catch {
    return undefined
  }
}

/**
 * Thrown by `updateTask` when a write would complete a task flagged
 * `requiresVerification` without a PASS verdict for its `verifiedBy`.
 * Nothing is written when this is thrown.
 */
export class VerificationGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationGateError'
  }
}

/**
 * Returns why a task may not be completed, or undefined when completion is
 * allowed (including every task without the flag).
 *
 * The flag applies when set on the stored task OR on the resulting task, so
 * clearing it in the completing write cannot bypass the gate. `verifiedBy` is
 * read from the resulting metadata, so it may be supplied in that write.
 */
export async function checkVerificationGateIn(
  tasksDir: string,
  storedMetadata: Record<string, unknown> | undefined,
  resultingMetadata: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const required =
    storedMetadata?.requiresVerification === true ||
    resultingMetadata?.requiresVerification === true
  if (!required) return undefined
  const rerun = `Fix the work, re-run the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}") until it ends with "VERDICT: PASS", then complete the task with metadata.verifiedBy set to that verifier's agentId.`
  const verifiedBy = resultingMetadata?.verifiedBy
  if (typeof verifiedBy !== 'string' || verifiedBy.trim() === '') {
    return `Cannot complete task: it has requiresVerification: true but metadata.verifiedBy is not set. ${rerun}`
  }
  const record = await readVerdictIn(tasksDir, verifiedBy)
  if (!record) {
    return `Cannot complete task: requiresVerification is set but no verdict was recorded for verifier '${verifiedBy}'. ${rerun}`
  }
  if (record.verdict !== 'PASS') {
    const found =
      record.verdict === 'MISSING'
        ? 'MISSING (its report had no "VERDICT: PASS|FAIL|PARTIAL" line)'
        : record.verdict
    return `Cannot complete task: verifier '${verifiedBy}' recorded verdict ${found}; only PASS allows completion. ${rerun}`
  }
  return undefined
}
