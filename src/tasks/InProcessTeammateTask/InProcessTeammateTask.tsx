/**
 * InProcessTeammateTask - Manages in-process teammate lifecycle
 *
 * This component implements the Task interface for in-process teammates.
 * Unlike LocalAgentTask (background agents), in-process teammates:
 * 1. Run in the same Node.js process using AsyncLocalStorage for isolation
 * 2. Have team-aware identity (agentName@teamName)
 * 3. Support plan mode approval flow
 * 4. Can be idle (waiting for work) or active (processing)
 */

import { isTerminalTaskStatus, type SetAppState, type Task, type TaskStateBase } from '../../Task.js';
import type { Message, ProgressMessage } from '../../types/message.js';
import { logForDebugging } from '../../utils/debug.js';
import { createUserMessage } from '../../utils/messages.js';
import { isEphemeralToolProgress } from '../../utils/sessionStorage.js';
import { killInProcessTeammateAndCascade } from '../../utils/swarm/spawnInProcess.js';
import { getParentTeamName, getSubTeamNameFor } from '../../utils/swarm/teamHelpers.js';
import { updateTaskState } from '../../utils/task/framework.js';
import { isRetainedOrWithinGrace } from '../../utils/task/retention.js';
import type { InProcessTeammateTaskState } from './types.js';
import { isInProcessTeammateTask, TEAMMATE_MESSAGES_UI_CAP, TEAMMATE_PROGRESS_TAIL_PER_TOOL, TEAMMATE_PROGRESS_UI_CAP } from './types.js';

/**
 * InProcessTeammateTask - Handles in-process teammate execution.
 */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    // Awaited, not fire-and-forget: TaskStop resolves through here, and a
    // teammate that leads a sub-team is only really stopped once that
    // sub-team's members are stopped and its directories are gone.
    await killInProcessTeammateAndCascade(taskId, setAppState);
  }
};

/**
 * Request shutdown for a teammate.
 *
 * The flag means "a shutdown request is in flight": it is what draws the row as
 * `stopping` (taskStatusUtils). It is NOT a record that a request was ever
 * made, which is why {@link clearTeammateShutdownRequest} exists — leaving it
 * set after the teammate has answered makes a live teammate read as stopping
 * for the rest of its life.
 */
export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' || task.shutdownRequested) {
      return task;
    }
    return {
      ...task,
      shutdownRequested: true
    };
  });
}

/**
 * Takes a teammate's shutdown request out of flight, after it has been answered
 * with a rejection: the teammate keeps working, so the row must stop reading
 * `stopping` and the next request must be able to set the flag again.
 *
 * The flag used to be set once and never cleared. Together with the
 * short-circuit that used to sit in `InProcessBackend.terminate`, that made one
 * declined request permanently silence every later one — while still reporting
 * success to the caller.
 */
export function clearTeammateShutdownRequest(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => task.shutdownRequested ? {
    ...task,
    shutdownRequested: false
  } : task);
}

/**
 * Append a message to a teammate's task.messages UI mirror. Every write to
 * that mirror goes through here rather than appendCappedMessage directly.
 *
 * The teammate view draws the mirror's non-progress entries as rows. Progress
 * is never a row: Messages.tsx joins it to its tool_use row by
 * parentToolUseID, in array order, for that row's live display. When progress
 * shared the rows' cap, a Bash tick per second or an agent_progress per inner
 * tool call of a sub-agent evicted the whole visible conversation. Rows and
 * progress are therefore capped separately, which bounds the mirror at
 *
 *   length <= TEAMMATE_MESSAGES_UI_CAP + TEAMMATE_PROGRESS_UI_CAP
 *
 * Per append:
 * 1. Progress whose tool_use is not in the mirror is dropped.
 * 2. An ephemeral tick (isEphemeralToolProgress) replaces EVERY earlier tick
 *    for the same tool call and progress type. This is intentionally stricter
 *    than REPL.tsx, which for @main replaces only the last entry: parallel
 *    tool calls interleave their ticks (A, B, A, B…), so the last entry never
 *    matches and each call would keep appending a tick per second.
 * 3. A trail (agent_progress, skill_progress, …) keeps its first entry and
 *    its last TEAMMATE_PROGRESS_TAIL_PER_TOOL entries.
 * 4. Past TEAMMATE_MESSAGES_UI_CAP rows the oldest row is evicted, together
 *    with the progress of any tool_use it carried.
 * 5. Past TEAMMATE_PROGRESS_UI_CAP progress entries, finished tools give up
 *    progress before running ones (dropProgressVictim).
 *
 * Lives here, not beside appendCappedMessage in types.ts: that file has no
 * runtime imports, and importing sessionStorage there would close the
 * cycle sessionStorage → messages → attachments → state/selectors → types.
 */
export function appendCappedTeammateMessage(prev: readonly Message[] | undefined, message: Message): Message[] {
  // Always a new array (AppState immutability); prev is never mutated.
  let next = prev ? prev.slice() : [];
  if (message.type !== 'progress') {
    next.push(message);
    return enforceProgressCeiling(evictOldestRows(next));
  }

  // 1. No row would draw it. A tool's progress never precedes its tool_use in
  // the stream, so a missing tool_use has already been evicted.
  if (!next.some(m => toolUseIDsOf(m).includes(message.parentToolUseID))) {
    return next;
  }

  // 2. BashTool, PowerShellTool, MCPTool and TaskOutputTool render only the
  // latest tick (progressMessages.at(-1)).
  if (isEphemeralToolProgress(message.data.type)) {
    next = withoutProgress(next, p => p.parentToolUseID === message.parentToolUseID && p.data.type === message.data.type);
  }
  next.push(message);

  // 3. AgentTool/UI.tsx takes the prompt from the first entry, shows
  // "Initializing…" when the trail is empty, and draws only the last few
  // inner tool uses; the middle of a long trail is never shown.
  if (isTrailProgress(message)) {
    const trail = trailIndices(next, message.parentToolUseID);
    if (trail.length > 1 + TEAMMATE_PROGRESS_TAIL_PER_TOOL) {
      next = withoutIndex(next, trail[1]);
    }
  }
  return enforceProgressCeiling(next);
}

function isProgress(message: Message): message is ProgressMessage {
  return message.type === 'progress';
}

/**
 * Progress a tool UI reads as a trail (agent_progress, skill_progress, …).
 * Ephemeral ticks are deduplicated instead, and hook_progress is counted, so
 * neither may lose single entries.
 */
function isTrailProgress(progress: ProgressMessage): boolean {
  return !isEphemeralToolProgress(progress.data.type) && progress.data.type !== 'hook_progress';
}

function toolUseIDsOf(message: Message): string[] {
  return message.type === 'assistant' ? message.message.content.flatMap(block => block.type === 'tool_use' ? [block.id] : []) : [];
}

function toolResultIDsOf(message: Message): string[] {
  return message.type === 'user' && Array.isArray(message.message.content) ? message.message.content.flatMap(block => block.type === 'tool_result' ? [block.tool_use_id] : []) : [];
}

function trailIndices(messages: readonly Message[], parentToolUseID: string): number[] {
  return messages.flatMap((m, i) => isProgress(m) && m.parentToolUseID === parentToolUseID && isTrailProgress(m) ? [i] : []);
}

function withoutProgress(messages: readonly Message[], drop: (progress: ProgressMessage) => boolean): Message[] {
  return messages.filter(m => !(isProgress(m) && drop(m)));
}

function withoutIndex(messages: readonly Message[], index: number): Message[] {
  return messages.filter((_, i) => i !== index);
}

/**
 * 4. The rows the view can draw are what the cap protects, so only rows count
 * against TEAMMATE_MESSAGES_UI_CAP. An evicted tool_use takes its progress
 * with it: nothing is left to draw that progress under.
 */
function evictOldestRows(messages: Message[]): Message[] {
  let next = messages;
  while (next.filter(m => !isProgress(m)).length > TEAMMATE_MESSAGES_UI_CAP) {
    const oldestRow = next.findIndex(m => !isProgress(m));
    const orphaned = toolUseIDsOf(next[oldestRow]);
    next = next.filter((m, i) => i !== oldestRow && !(isProgress(m) && orphaned.includes(m.parentToolUseID)));
  }
  return next;
}

/** 5. Every dropProgressVictim call removes at least one entry, so this ends. */
function enforceProgressCeiling(messages: Message[]): Message[] {
  let next = messages;
  while (next.filter(isProgress).length > TEAMMATE_PROGRESS_UI_CAP) {
    next = dropProgressVictim(next);
  }
  return next;
}

/**
 * Removes the progress the teammate view misses least. A tool is finished
 * once its tool_result is in the mirror. After that its row reads progress
 * only in transcript mode or for cosmetic counts (AgentTool/UI.tsx
 * VerboseAgentTranscript and its grouped "N tool uses"; BashTool's timeout
 * display), so finished tools lose progress before running ones.
 */
function dropProgressVictim(messages: Message[]): Message[] {
  const finished = new Set(messages.flatMap(toolResultIDsOf));
  const isFinishedProgress = (m: Message): m is ProgressMessage => isProgress(m) && finished.has(m.parentToolUseID);

  // 5.1 The oldest trail entry of a finished tool.
  const finishedTrailEntry = messages.findIndex(m => isFinishedProgress(m) && isTrailProgress(m));
  if (finishedTrailEntry !== -1) {
    return withoutIndex(messages, finishedTrailEntry);
  }

  // 5.2 A finished tool's hook_progress, as a whole group. HookProgressMessage
  // compares its count against the resolved hooks, so a partial group would
  // show hooks as still running.
  const finishedHook = messages.find((m): m is ProgressMessage => isFinishedProgress(m) && m.data.type === 'hook_progress');
  if (finishedHook) {
    return withoutProgress(messages, p => p.parentToolUseID === finishedHook.parentToolUseID && p.data.type === 'hook_progress');
  }

  // 5.3 Whatever else a finished tool still holds: its last tick.
  const finishedEntry = messages.findIndex(isFinishedProgress);
  if (finishedEntry !== -1) {
    return withoutIndex(messages, finishedEntry);
  }

  // 5.4 Every remaining tool is running. The longest trail loses its oldest
  // entry after the first (the prompt) while it has more than two, so the
  // latest entry AgentTool draws stays.
  let longestTrail: number[] = [];
  for (const parentToolUseID of new Set(messages.filter(isProgress).map(p => p.parentToolUseID))) {
    const trail = trailIndices(messages, parentToolUseID);
    if (trail.length > longestTrail.length) {
      longestTrail = trail;
    }
  }
  if (longestTrail.length > 2) {
    return withoutIndex(messages, longestTrail[1]);
  }

  // 5.5 Only hook groups, ticks and short trails are left: the tool holding
  // the oldest progress entry loses all of it, so no hook group is left
  // partial. The ceiling was exceeded, so that entry exists.
  const oldest = messages.find(isProgress);
  return oldest ? withoutProgress(messages, p => p.parentToolUseID === oldest.parentToolUseID) : messages;
}

/**
 * Append a message to a teammate's conversation history.
 * Used for zoomed view to show the teammate's conversation.
 */
export function appendTeammateMessage(taskId: string, message: Message, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    return {
      ...task,
      messages: appendCappedTeammateMessage(task.messages, message)
    };
  });
}

/**
 * Inject a user message to a teammate's pending queue.
 * Used when viewing a teammate's transcript to send typed messages to them.
 * Also adds the message to task.messages so it appears immediately in the transcript.
 */
export function injectUserMessageToTeammate(taskId: string, message: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    // Allow message injection when teammate is running or idle (waiting for input)
    // Only reject if teammate is in a terminal state
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(`Dropping message for teammate task ${taskId}: task status is "${task.status}"`);
      return task;
    }
    return {
      ...task,
      pendingUserMessages: [...task.pendingUserMessages, message],
      messages: appendCappedTeammateMessage(task.messages, createUserMessage({
        content: message
      }))
    };
  });
}

/**
 * Get teammate task by agent ID from AppState.
 * Prefers running tasks over killed/completed ones in case multiple tasks
 * with the same agentId exist.
 * Returns undefined if not found.
 */
export function findTeammateTaskByAgentId(agentId: string, tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState | undefined {
  let fallback: InProcessTeammateTaskState | undefined;
  for (const task of Object.values(tasks)) {
    if (isInProcessTeammateTask(task) && task.identity.agentId === agentId) {
      // Prefer running tasks in case old killed tasks still exist in AppState
      // alongside new running ones with the same agentId
      if (task.status === 'running') {
        return task;
      }
      // Keep first match as fallback in case no running task exists
      if (!fallback) {
        fallback = task;
      }
    }
  }
  return fallback;
}

/**
 * Get all in-process teammate tasks from AppState.
 */
export function getAllInProcessTeammateTasks(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return Object.values(tasks).filter(isInProcessTeammateTask);
}

/**
 * The sub-leads a teammate's team hangs off, outermost first: `[]` for a member
 * of a root team, `['supervisor']` for `email/supervisor`, and
 * `['supervisor', 'worker-1']` for `email/supervisor/worker-1`. Each segment
 * after the root is the name of the teammate that leads that sub-team, which is
 * what the teammate view header's path and the pill labels are made of.
 *
 * Walks up with getParentTeamName rather than splitting the name, so the
 * separator stays teamHelpers' business: the parent is always the prefix before
 * one separator character, so the segment is the remainder after it.
 *
 * An absent team name is a root team, like the empty one. The type says
 * `string`, but a hand-built or stale AppState can omit it, and a label has to
 * degrade to the bare `@name` rather than take the whole footer render down.
 */
export function getSubLeadPath(teamName: string | undefined): string[] {
  if (!teamName) {
    return [];
  }
  const path: string[] = [];
  let team = teamName;
  let parent = getParentTeamName(team);
  while (parent !== undefined) {
    path.unshift(team.slice(parent.length + 1));
    team = parent;
    parent = getParentTeamName(team);
  }
  return path;
}

/** Plain string order on the exact names — never locale-dependent. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Depth-first tree order: a team's members sorted by name, and a sub-lead
 * immediately followed by its own sub-team, recursively, before the next
 * sibling. Teams are visited in name order, which puts a sub-team right after
 * the team it hangs off (`email` sorts before `email/supervisor`).
 *
 * A sub-team whose sub-lead is not running is orphaned rather than dropped: its
 * team is never reached by the descent, so the outer loop emits it in team-name
 * order — once, at the depth its team name implies. Each team is removed from
 * the map as it is emitted, so no teammate can appear twice however the recorded
 * names relate to each other.
 */
export function orderTeammatesDepthFirst(teammates: InProcessTeammateTaskState[]): InProcessTeammateTaskState[] {
  const byTeam = new Map<string, InProcessTeammateTaskState[]>();
  for (const teammate of teammates) {
    // Same tolerance as getSubLeadPath: an identity without a team name joins
    // the root team, keyed on '' rather than on undefined — an undefined key
    // would make the team-name sort below inconsistent and could reorder the
    // complete identities around it.
    const teamName = teammate.identity.teamName ?? '';
    const members = byTeam.get(teamName);
    if (members) {
      members.push(teammate);
    } else {
      byTeam.set(teamName, [teammate]);
    }
  }
  for (const members of byTeam.values()) {
    members.sort((a, b) => compareNames(a.identity.agentName, b.identity.agentName));
  }
  const ordered: InProcessTeammateTaskState[] = [];
  const emitTeam = (teamName: string): void => {
    const members = byTeam.get(teamName);
    if (!members) {
      return;
    }
    byTeam.delete(teamName);
    for (const member of members) {
      ordered.push(member);
      const subTeam = getSubTeamNameFor(member.identity.agentId, member.identity.agentName);
      if (subTeam !== undefined) {
        emitTeam(subTeam);
      }
    }
  };
  for (const teamName of [...byTeam.keys()].sort(compareNames)) {
    emitTeam(teamName);
  }
  return ordered;
}

/**
 * Get the in-process teammates that currently have a row, in depth-first tree
 * order (each team's members by name, a sub-lead immediately followed by its
 * sub-team).
 *
 * "Has a row" is running OR terminal-but-still-inside-its-grace-window: a
 * completed/failed/killed teammate keeps its place for TEAMMATE_GRACE_MS so a
 * row can never vanish from under the cursor, drawn dimmed and reading its
 * terminal word (TeammateSpinnerLine). The composition is the same one
 * isPanelVisibleAgent uses for the coordinator panel's local agents: the
 * terminal-status check here, the retain/grace deadline in the shared predicate
 * (utils/task/retention). The row therefore leaves the order the moment the
 * deadline passes, while the task object itself survives until the next lazy GC
 * sweep — the single eviction funnel, which consults the same predicate.
 *
 * A grace row is NOT live: every spawn-cap and liveness helper keys on status or
 * isTerminalTaskStatus (countLiveInProcessTeammates / countLiveTeammatesInTeam in
 * tools/AgentTool/teammateReplicas, hasLiveTaskFor in utils/swarm/subTeamRecovery,
 * findBusySubTeamChildren in utils/swarm/inProcessRunner), so widening this order
 * cannot widen a cap.
 *
 * Shared between TeammateSpinnerTree display, PromptInput footer selector,
 * useBackgroundTaskNavigation and the BackgroundTaskStatus pill row; the
 * selection stepper walks this array, so all of them must agree on sort order —
 * which is why the widening happens HERE and not per consumer.
 *
 * `now` defaults to Date.now(); the explicit parameter keeps the grace deadline
 * testable without timers, exactly as on isRetainedOrWithinGrace and
 * isPanelVisibleAgent.
 */
export function getRunningTeammatesSorted(tasks: Record<string, TaskStateBase>, now: number = Date.now()): InProcessTeammateTaskState[] {
  return orderTeammatesDepthFirst(getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running' || isTerminalTaskStatus(t.status) && isRetainedOrWithinGrace(t, now)));
}
