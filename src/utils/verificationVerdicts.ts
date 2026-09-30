/**
 * Code-enforced verification verdicts (task-list-aware API).
 *
 * The built-in verification agent must end its report with a literal
 * `VERDICT: PASS|FAIL|PARTIAL` line. This module parses that line and
 * persists it per verifier agentId so a task flagged `requiresVerification`
 * can only be completed when its `verifiedBy` verifier recorded PASS. The
 * gate itself is enforced inside the locked write in `tasks.ts`
 * (`updateTask`), which throws `VerificationGateError`.
 *
 * Verdicts are stored as files (not in memory) because pane teammates run in
 * other processes and must be able to read a verdict recorded by the leader,
 * and vice versa. Layout and parsing rules live in `verificationVerdictStore.ts`:
 * `<tasksDir>/.verdicts/<sanitized agentId>-<hash of agentId>.json`.
 *
 * Limits: this is a guardrail against mistakes, not a security boundary. The
 * `requiresVerification` flag can be removed in a separate, earlier update;
 * one PASS can be cited by more than one task; and anything with file-write
 * access to the tasks directory could forge a record.
 */
import { getTaskListId, getTasksDir } from './tasks.js'
import {
  clearVerdictIn,
  type ParsedVerdict,
  readVerdictIn,
  type VerdictRecord,
  verdictPathIn,
  verdictsDirIn,
  writeVerdictIn,
} from './verificationVerdictStore.js'

export {
  parseVerdict,
  type ParsedVerdict,
  type RecordedVerdict,
  VerificationGateError,
  type VerdictRecord,
} from './verificationVerdictStore.js'

export function getVerdictsDir(taskListId: string = getTaskListId()): string {
  return verdictsDirIn(getTasksDir(taskListId))
}

export function getVerdictPath(
  agentId: string,
  taskListId: string = getTaskListId(),
): string {
  return verdictPathIn(getTasksDir(taskListId), agentId)
}

/**
 * Atomically writes `{agentId, verdict, recordedAt}` for a verifier run.
 * A later record for the same agentId (e.g. a resumed verifier) replaces it.
 * Rejects when the write fails.
 */
export async function recordVerdict(
  { agentId, verdict }: { agentId: string; verdict: ParsedVerdict },
  taskListId: string = getTaskListId(),
): Promise<VerdictRecord> {
  return writeVerdictIn(getTasksDir(taskListId), agentId, verdict)
}

/**
 * Deletes the record for a verifier agentId. A missing record is fine; any
 * other failure rejects.
 */
export async function clearVerdict(
  agentId: string,
  taskListId: string = getTaskListId(),
): Promise<void> {
  return clearVerdictIn(getTasksDir(taskListId), agentId)
}

/**
 * Reads the recorded verdict for a verifier agentId, or undefined when none
 * was recorded (or the file is unreadable, malformed, or embeds a different
 * agentId).
 */
export async function readVerdict(
  agentId: string,
  taskListId: string = getTaskListId(),
): Promise<VerdictRecord | undefined> {
  return readVerdictIn(getTasksDir(taskListId), agentId)
}
