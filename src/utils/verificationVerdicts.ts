/**
 * Code-enforced verification verdicts.
 *
 * The built-in verification agent must end its report with a literal
 * `VERDICT: PASS|FAIL|PARTIAL` line. This module parses that line and
 * persists it per verifier agentId so TaskUpdate can refuse to complete a
 * task flagged `requiresVerification` unless its `verifiedBy` verifier
 * recorded PASS.
 *
 * Verdicts are stored as files (not in memory) because pane teammates run in
 * other processes and must be able to read a verdict recorded by the leader,
 * and vice versa. Layout: `<tasksDir>/.verdicts/<sanitized agentId>.json`.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import {
  getTaskListId,
  getTasksDir,
  sanitizePathComponent,
} from './tasks.js'

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
 * `VERDICT: PASS|FAIL|PARTIAL` (trailing whitespace ignored). Markdown,
 * lowercase, or punctuated variants do not count. No match gives MISSING.
 */
export function parseVerdict(text: string): ParsedVerdict {
  if (!text) return 'MISSING'
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = VERDICT_LINE.exec(lines[i]!.trimEnd())
    if (match) return match[1] as RecordedVerdict
  }
  return 'MISSING'
}

export function getVerdictsDir(taskListId: string = getTaskListId()): string {
  return join(getTasksDir(taskListId), '.verdicts')
}

export function getVerdictPath(
  agentId: string,
  taskListId: string = getTaskListId(),
): string {
  return join(getVerdictsDir(taskListId), `${sanitizePathComponent(agentId)}.json`)
}

/**
 * Atomically writes `{agentId, verdict, recordedAt}` for a verifier run
 * (temp file + rename, so concurrent readers never see a partial file).
 * A later record for the same agentId (e.g. a resumed verifier) replaces it.
 */
export async function recordVerdict(
  { agentId, verdict }: { agentId: string; verdict: ParsedVerdict },
  taskListId: string = getTaskListId(),
): Promise<VerdictRecord> {
  const record: VerdictRecord = {
    agentId,
    verdict,
    recordedAt: new Date().toISOString(),
  }
  const dir = getVerdictsDir(taskListId)
  await mkdir(dir, { recursive: true })
  const finalPath = getVerdictPath(agentId, taskListId)
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
 * Reads the recorded verdict for a verifier agentId, or undefined when none
 * was recorded (or the file is unreadable, malformed, or belongs to a
 * different agentId that sanitized to the same filename).
 */
export async function readVerdict(
  agentId: string,
  taskListId: string = getTaskListId(),
): Promise<VerdictRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(getVerdictPath(agentId, taskListId), 'utf-8')
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
