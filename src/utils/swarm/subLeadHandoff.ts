/**
 * Handing a sub-team from one sub-lead to a fresh successor — the
 * `supervisor:fresh` analog for an in-process sub-lead.
 *
 * A sub-lead that has run out of usable context cannot simply stop: every
 * deliberate ending it has today either takes its sub-team down with it
 * (kill, TaskStop, TeamDelete, idle self-shutdown — all funnelling into
 * `cleanupTeamTree`) or leaves the team unled and announced as broken (the
 * failure path's `orphanedLead` record, U9). A handoff is the fifth ending:
 * the outgoing lead writes down what it knows, retires through the ordinary
 * completion tail, and a successor with the SAME identity opens on that file
 * and inherits the sub-team's members, task list and inboxes untouched.
 *
 * This module holds the halves that neither spawn nor kill:
 *
 * - the handoff document — where it goes under the team directory, and what
 *   it says ({@link writeSubLeadHandoffFile}, {@link formatHandoffDocument}),
 * - the one-shot request registry that carries "this run is ending to be
 *   replaced" from whoever decided it to the runner's completion tail, which
 *   is the only place that can spawn the successor safely
 *   ({@link armSubLeadHandoff} / {@link takeSubLeadHandoff}),
 * - the first message the successor reads
 *   ({@link formatSuccessorHandoffMessage}).
 *
 * Keeping the spawn out of here is what lets `inProcessRunner.ts` import it
 * without a cycle — the same split U9 made between `subTeamRecovery.ts` and
 * `respawnSubLead.ts`.
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { listTasks, type Task } from '../tasks.js'
import { getTeamDir } from './teamHelpers.js'

/**
 * Pseudo-sender for the first message a successor sub-lead reads, following
 * the `idle-timeout-hook` convention: the message is not written by any agent
 * that could be addressed back, so it is not attributed to one.
 */
export const SUB_LEAD_HANDOFF_SENDER = 'handoff'

/**
 * Names of the still-running members of `teamName` — the roster a handoff
 * document records, and the members a successor inherits. Read from the live
 * tasks rather than the team file because that is what a running teammate
 * actually carries.
 */
export function liveSubTeamMemberNames(
  tasks: AppState['tasks'],
  teamName: string,
): string[] {
  const names: string[] = []
  for (const task of Object.values(tasks)) {
    if (task.type !== 'in_process_teammate') continue
    if (task.identity.teamName !== teamName) continue
    if (isTerminalTaskStatus(task.status)) continue
    names.push(task.identity.agentName)
  }
  return names
}

/** Directory the handoff documents of one sub-team live in. */
const HANDOFF_DIR_NAME = 'handoffs'

/** What asked for the handoff, recorded in the document. */
export type SubLeadHandoffSource = 'tool' | 'idle-timeout-hook'

/** A handoff that has been decided but not yet performed. */
export type PendingSubLeadHandoff = {
  /** The sub-team being handed over, `<parentTeam>/<lead name>`. */
  subTeamName: string
  /** The retiring lead — and the successor: a handoff keeps the identity. */
  leadAgentId: string
  /** Absolute path of the handoff document the successor opens on. */
  handoffPath: string
  /** What asked for the handoff. */
  source: SubLeadHandoffSource
  /** Why, in the words of whoever asked. */
  reason?: string
  /** What the successor should do first, beyond reading the document. */
  firstInstruction?: string
}

/**
 * Handoffs decided but not yet performed, keyed by the retiring lead's agent
 * id.
 *
 * In memory on purpose: a handoff is an operation between one runner and one
 * tool call in the SAME process, over the few awaits between "this run is
 * ending" and "the successor is up". A disk marker would outlive the process
 * that meant it and would need its own cleanup and staleness rules.
 */
const pendingHandoffs = new Map<string, PendingSubLeadHandoff>()

/**
 * Records that the run of `request.leadAgentId` is ending in order to be
 * replaced. Read exactly once, by {@link takeSubLeadHandoff}.
 */
export function armSubLeadHandoff(request: PendingSubLeadHandoff): void {
  pendingHandoffs.set(request.leadAgentId, request)
}

/**
 * The armed handoff for `leadAgentId`, removed as it is read.
 *
 * Delete-on-read is what keeps a handoff from firing twice, and what lets the
 * runner's failure path discard one that never happened: a run that crashed
 * mid-handoff is an orphan (recoverable with `RecoverTeam`), not a handoff.
 */
export function takeSubLeadHandoff(
  leadAgentId: string,
): PendingSubLeadHandoff | undefined {
  const pending = pendingHandoffs.get(leadAgentId)
  if (pending) pendingHandoffs.delete(leadAgentId)
  return pending
}

/** Directory the handoff documents of `subTeamName` live in. */
export function getHandoffDir(subTeamName: string): string {
  return join(getTeamDir(subTeamName), HANDOFF_DIR_NAME)
}

/**
 * Path for a handoff document written now.
 *
 * Timestamped rather than fixed, so a chain of successors leaves a readable
 * history instead of overwriting its own predecessor, and in a subdirectory
 * of the team directory so it can never collide with `config.json` or the
 * `inboxes/` tree. Nothing removes these: they go with the team directory
 * through `cleanupTeamTree`, which stays the only teardown funnel.
 */
export function getHandoffFilePath(subTeamName: string): string {
  const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-')
  return join(getHandoffDir(subTeamName), `handoff-${stamp}.md`)
}

/** What the hook route puts where the outgoing lead's prose would be. */
const HOOK_ROUTE_SYNTHESIS =
  'This handoff was requested by the TeammateIdleTimeout hook, not written by the ' +
  'sub-lead itself, so there is no narrative synthesis. The task list and the members ' +
  'below are the whole record: read them, then take stock with your members before ' +
  'starting anything new.'

function formatTaskLine(task: Task): string {
  const owner = task.owner ? ` (owner: ${task.owner})` : ''
  return `- [${task.status}] #${task.id} ${task.subject}${owner}`
}

function formatList(lines: string[], empty: string): string {
  return lines.length > 0 ? lines.join('\n') : empty
}

/**
 * The handoff document: everything a successor with no context needs, and
 * nothing it would have to take on trust.
 *
 * The task-list and member snapshots are taken by the caller rather than
 * asserted by the outgoing lead, so the two halves of the document have
 * different authorities — prose from the agent, state from disk.
 */
export function formatHandoffDocument(params: {
  subTeamName: string
  leadAgentId: string
  source: SubLeadHandoffSource
  writtenAt: number
  reason?: string
  synthesis?: string
  openItems?: string[]
  tasks: Task[]
  members: string[]
}): string {
  const {
    subTeamName,
    leadAgentId,
    source,
    writtenAt,
    reason,
    synthesis,
    openItems,
    tasks,
    members,
  } = params
  const sourceLabel =
    source === 'tool'
      ? 'the sub-lead itself (HandoffTeam)'
      : 'the TeammateIdleTimeout hook'
  return [
    `# Handoff — ${subTeamName}`,
    '',
    `- From: ${leadAgentId}`,
    `- Successor: ${leadAgentId} (the same identity: you inherit this sub-team's members, task list and inboxes)`,
    `- Written: ${new Date(writtenAt).toISOString()}`,
    `- Requested by: ${sourceLabel}`,
    `- Reason: ${reason?.trim() || 'not given'}`,
    '',
    '## Synthesis so far',
    '',
    synthesis?.trim() || HOOK_ROUTE_SYNTHESIS,
    '',
    '## Open items',
    '',
    formatList(
      (openItems ?? []).map(item => `- ${item}`),
      'None recorded.',
    ),
    '',
    '## Sub-team task list at handoff',
    '',
    formatList(tasks.map(formatTaskLine), 'The task list was empty.'),
    '',
    '## Members at handoff',
    '',
    formatList(
      members.map(name => `- ${name}`),
      'No members were running.',
    ),
    '',
  ].join('\n')
}

/**
 * Writes the handoff document for `subTeamName` and returns its absolute
 * path. The sub-team's task list is snapshotted here so both routes record it
 * the same way; a task list that cannot be read yields an empty snapshot
 * rather than failing the handoff.
 */
export async function writeSubLeadHandoffFile(params: {
  subTeamName: string
  leadAgentId: string
  source: SubLeadHandoffSource
  reason?: string
  synthesis?: string
  openItems?: string[]
  members: string[]
}): Promise<string> {
  let tasks: Task[] = []
  try {
    tasks = await listTasks(params.subTeamName)
  } catch (err) {
    logForDebugging(
      `[subLeadHandoff] Could not read the task list of ${params.subTeamName}: ${errorMessage(err)}`,
    )
  }
  const path = getHandoffFilePath(params.subTeamName)
  await mkdir(getHandoffDir(params.subTeamName), { recursive: true })
  await writeFile(
    path,
    formatHandoffDocument({ ...params, writtenAt: Date.now(), tasks }),
    'utf-8',
  )
  return path
}

/**
 * The first message the successor reads, written into its own inbox before
 * its runner starts so the first poll round already carries it.
 *
 * It points at the document by absolute path rather than quoting it: the
 * successor reads the file with its own tools, and the handoff stays one
 * durable artefact instead of two copies that can drift.
 */
export function formatSuccessorHandoffMessage(
  handoff: PendingSubLeadHandoff,
): string {
  const lines = [
    `You are the new lead of sub-team "${handoff.subTeamName}". Your predecessor handed the team over and has retired; you carry the same identity (${handoff.leadAgentId}) and inherit its members, its task list and its inboxes — nothing was stopped or reassigned.`,
    `Read the handoff notes first: ${handoff.handoffPath}`,
  ]
  if (handoff.reason?.trim()) {
    lines.push(`Reason for the handoff: ${handoff.reason.trim()}`)
  }
  if (handoff.firstInstruction?.trim()) {
    lines.push(`Your predecessor asks you to start with: ${handoff.firstInstruction.trim()}`)
  }
  lines.push(
    "Then take stock before starting anything new: read the sub-team's task list and your inbox, work out where each member got to, and carry on coordinating from there.",
  )
  return lines.join('\n')
}
