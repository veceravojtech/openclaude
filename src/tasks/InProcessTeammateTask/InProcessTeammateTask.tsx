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
import type { Message } from '../../types/message.js';
import { logForDebugging } from '../../utils/debug.js';
import { createUserMessage } from '../../utils/messages.js';
import { killInProcessTeammateAndCascade } from '../../utils/swarm/spawnInProcess.js';
import { getParentTeamName, getSubTeamNameFor } from '../../utils/swarm/teamHelpers.js';
import { updateTaskState } from '../../utils/task/framework.js';
import type { InProcessTeammateTaskState } from './types.js';
import { appendCappedMessage, isInProcessTeammateTask } from './types.js';

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
      messages: appendCappedMessage(task.messages, message)
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
      messages: appendCappedMessage(task.messages, createUserMessage({
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
 */
export function getSubLeadPath(teamName: string): string[] {
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
    const members = byTeam.get(teammate.identity.teamName);
    if (members) {
      members.push(teammate);
    } else {
      byTeam.set(teammate.identity.teamName, [teammate]);
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
 * Get running in-process teammates in depth-first tree order (each team's
 * members by name, a sub-lead immediately followed by its sub-team).
 * Shared between TeammateSpinnerTree display, PromptInput footer selector,
 * useBackgroundTaskNavigation and — through orderTeammatesDepthFirst — the
 * BackgroundTaskStatus pill row; selectedIPAgentIndex maps into this array, so
 * all of them must agree on sort order.
 */
export function getRunningTeammatesSorted(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return orderTeammatesDepthFirst(getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running'));
}
