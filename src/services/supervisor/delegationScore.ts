/**
 * The supervisor's delegation score.
 *
 * Soft supervision leaves every tool in the supervisor's hands, so nothing
 * structural stops it from doing the work itself. This is the feedback that
 * does: a running total, shown to the user in the footer and handed back to
 * the model each turn, that rises when delegated work lands and falls when the
 * supervisor picks up the keyboard.
 *
 * Session-scoped and in memory only. Nothing is persisted, so there is no
 * score to farm across sessions and a bad session never haunts the next one.
 *
 * What is measured is deliberately narrow, because the prompt tells the model
 * exactly this and the two must not drift (see getCoordinatorSystemPrompt):
 * a delegated run that finishes earns points, a mutating tool call on the main
 * thread costs one. Reading, searching and asking cost nothing — a supervisor
 * has to understand the work before it can brief anyone.
 */

import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { TaskType } from '../../Task.js'

/** Points for a delegated run that reported completion. */
export const DELEGATION_COMPLETED_POINTS = 3

/** Cost of one mutating tool call the supervisor made itself. */
export const SELF_WORK_POINTS = -1

/**
 * Tool calls that count as doing the work yourself. Read-only tools are
 * deliberately absent: the prompt tells the supervisor to read what it needs
 * to write a good brief, and a score that punished reading would push it to
 * delegate blind.
 */
const SELF_WORK_TOOLS = new Set([
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
])

/** Task types whose completion counts as delegated work landing. */
const DELEGATED_TASK_TYPES = new Set<TaskType>([
  'local_agent',
  'in_process_teammate',
  'remote_agent',
])

export type DelegationScore = {
  points: number
  /** Delegated runs that reported completion. */
  delegated: number
  /** Delegated runs that failed or were stopped — counted, never charged. */
  abandoned: number
  /** Mutating tool calls the supervisor made itself. */
  selfWork: number
  /** Signed change since the last time the score was rendered. */
  lastDelta: number
}

const EMPTY: DelegationScore = {
  points: 0,
  delegated: 0,
  abandoned: 0,
  selfWork: 0,
  lastDelta: 0,
}

let score: DelegationScore = { ...EMPTY }

/**
 * Whether this build and session are supervising. Indirected through a
 * variable so tests can exercise the arithmetic: isCoordinatorMode() is gated
 * on the COORDINATOR_MODE build flag, which `bun test` does not compile in, and
 * a test that silently records nothing asserts nothing.
 */
let isSupervising: () => boolean = isCoordinatorMode

/** Test seam. Pass undefined to restore the real gate. */
export function __setSupervisionGateForTesting(
  gate: (() => boolean) | undefined,
): void {
  isSupervising = gate ?? isCoordinatorMode
}

export function getDelegationScore(): DelegationScore {
  return { ...score }
}

/** Clears the score — /clear and a session switch start over. */
export function resetDelegationScore(): void {
  score = { ...EMPTY }
}

/** Zeroes the delta after it has been shown, leaving the total alone. */
export function consumeDelegationScoreDelta(): DelegationScore {
  const snapshot = { ...score }
  score = { ...score, lastDelta: 0 }
  return snapshot
}

/**
 * Record a successful tool call. `agentId` is the caller's — only the main
 * thread is the supervisor, so a teammate doing its own job never costs the
 * supervisor anything.
 */
export function recordSupervisorToolUse(
  toolName: string,
  agentId: string | undefined,
): void {
  if (!isSupervising() || agentId !== undefined) {
    return
  }
  if (!SELF_WORK_TOOLS.has(toolName)) {
    return
  }
  score = {
    ...score,
    points: score.points + SELF_WORK_POINTS,
    selfWork: score.selfWork + 1,
    lastDelta: score.lastDelta + SELF_WORK_POINTS,
  }
}

/**
 * Record a delegated run reaching a terminal state.
 *
 * A failed or stopped run is counted but not charged: the supervisor should
 * not learn that delegating is risky, only that delegating well pays. Runs
 * owned by a teammate (`ownedByMainThread: false`) belong to that teammate's
 * own supervision, not this score.
 */
export function recordDelegatedRunFinished({
  taskType,
  status,
  ownedByMainThread,
}: {
  taskType: TaskType
  status: string
  ownedByMainThread: boolean
}): void {
  if (!isSupervising() || !ownedByMainThread) {
    return
  }
  if (!DELEGATED_TASK_TYPES.has(taskType)) {
    return
  }
  if (status !== 'completed') {
    score = { ...score, abandoned: score.abandoned + 1 }
    return
  }
  score = {
    ...score,
    points: score.points + DELEGATION_COMPLETED_POINTS,
    delegated: score.delegated + 1,
    lastDelta: score.lastDelta + DELEGATION_COMPLETED_POINTS,
  }
}

/**
 * Whether this caller should see the score at all: supervision on, and the
 * main thread rather than a teammate or subagent.
 */
export function shouldShowDelegationScore(
  agentId: string | undefined,
): boolean {
  return isSupervising() && agentId === undefined
}

/** `+12` / `-3` / `0` — the form used in the footer and in the reminder. */
export function formatDelegationPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points)
}
