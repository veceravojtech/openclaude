/**
 * Shared utilities for displaying task status across different task types.
 */

import figures from 'figures';
import type { TaskStatus } from 'src/Task.js';
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js';
import { isPanelAgentTask, isPanelVisibleAgent } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { summarizeRecentActivities } from 'src/utils/collapseReadSearch.js';
import { isAgentViewDisabled } from 'src/utils/envUtils.js';

/**
 * Returns true if the given task status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

/**
 * Returns the appropriate icon for a task based on status and state flags.
 */
export function getTaskStatusIcon(status: TaskStatus, options?: {
  isIdle?: boolean;
  awaitingApproval?: boolean;
  hasError?: boolean;
  shutdownRequested?: boolean;
}): string {
  const {
    isIdle,
    awaitingApproval,
    hasError,
    shutdownRequested
  } = options ?? {};
  if (hasError) return figures.cross;
  if (awaitingApproval) return figures.questionMarkPrefix;
  if (shutdownRequested) return figures.warning;
  if (status === 'running') {
    if (isIdle) return figures.ellipsis;
    return figures.play;
  }
  if (status === 'completed') return figures.tick;
  if (status === 'failed' || status === 'killed') return figures.cross;
  return figures.bullet;
}

/**
 * Returns the appropriate semantic color for a task based on status and state flags.
 */
export function getTaskStatusColor(status: TaskStatus, options?: {
  isIdle?: boolean;
  awaitingApproval?: boolean;
  hasError?: boolean;
  shutdownRequested?: boolean;
}): 'success' | 'error' | 'warning' | 'background' {
  const {
    isIdle,
    awaitingApproval,
    hasError,
    shutdownRequested
  } = options ?? {};
  if (hasError) return 'error';
  if (awaitingApproval) return 'warning';
  if (shutdownRequested) return 'warning';
  if (isIdle) return 'background';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'warning';
  return 'background';
}

/**
 * Derives a human-readable activity string for an in-process teammate,
 * accounting for shutdown/approval/idle states and falling back through
 * recent-activity summary → last activity description → 'working'.
 */
export function describeTeammateActivity(t: DeepImmutable<InProcessTeammateTaskState>): string {
  if (t.shutdownRequested) return 'stopping';
  if (t.awaitingPlanApproval) return 'awaiting approval';
  if (t.isIdle) return 'idle';
  return (t.progress?.recentActivities && summarizeRecentActivities(t.progress.recentActivities)) ?? t.progress?.lastActivity?.activityDescription ?? 'working';
}

export function countVisibleBackgroundTasks(tasks: {
  [taskId: string]: TaskState;
}): number {
  let backgroundTaskCount = 0;
  for (const task of Object.values(tasks)) {
    if (isBackgroundTask(task)) {
      backgroundTaskCount += 1;
    }
  }
  return backgroundTaskCount;
}

/**
 * Returns true when a task earns a pill in the background-task footer.
 *
 * The pill and the CoordinatorTaskPanel must never double-list the same agent,
 * so a panel row (isPanelAgentTask + isPanelVisibleAgent) gives up its pill —
 * but only while the panel actually exists. CLAUDE_CODE_DISABLE_AGENT_VIEW
 * leaves the panel unmounted, and an agent excluded from both surfaces would be
 * invisible in the footer entirely, so the exclusion is gated on the opt-out
 * being unset.
 *
 * The env read is intentionally at call time, not cached: isAgentViewDisabled
 * documents that contract (src/utils/envUtils.ts), and tests set and unset the
 * variable around individual cases.
 *
 * This body deliberately diverges from upstream 2.1.263's `$6` predicate,
 * `isBackgroundTask && type !== 'local_workflow' && !ambientMonitor &&
 * !(panelFlag() && (panelAgent || type === 'in_process_teammate'))`, read off
 * that bundle rather than guessed. Three differences, all kept on purpose:
 * - upstream folds `in_process_teammate` into its panel-agent set; here
 *   isPanelAgentTask (LocalAgentTask.tsx) matches only `local_agent`, so a
 *   running teammate keeps its pill (BackgroundTaskStatus.test.tsx:76);
 * - upstream has no visible-row narrowing; isPanelVisibleAgent is what hands
 *   the pill back to an agent dismissed from the panel with `x`,
 *   evictAfter === 0 (BackgroundTaskStatus.test.tsx:92);
 * - upstream's extra `local_workflow`/ambient-monitor exclusions are not
 *   ported; those pills are wanted here (BackgroundTaskStatus.test.tsx:80).
 * Upstream's panel gate is a remote feature flag defaulting to true, not an env
 * read; `panelActive` below is the fork-local port of that gate.
 */
export function isPillTask(t: TaskState): boolean {
  if (!isBackgroundTask(t)) return false;
  const panelActive = !isAgentViewDisabled();
  return !(panelActive && isPanelAgentTask(t) && isPanelVisibleAgent(t));
}

/**
 * Returns true when BackgroundTaskStatus would render nothing because the
 * spinner tree is active and every visible background task is an in-process
 * teammate (teammates are shown in the spinner tree instead).
 *
 * Filters on bare isBackgroundTask — running/pending and not foregrounded —
 * i.e. the same population as countVisibleBackgroundTasks, and deliberately
 * NOT the panel-aware isPillTask above. Both footer call sites AND this gate
 * against that count (PromptInput.tsx `tasksFooterVisible`,
 * PromptInputFooterLeftSide.tsx `tasksPart` via `hasBackgroundTasks`), so it
 * has to score the same tasks the count does; narrowing it to pill tasks would
 * let the footer slot and the count that reserves it disagree.
 *
 * So this is not a mirror of what BackgroundTaskStatus renders: that component
 * filters with isPillTask and already returns null on its own when the filter
 * comes up empty, which is why the pill narrowing is not needed here.
 */
export function shouldHideTasksFooter(tasks: {
  [taskId: string]: TaskState;
}, showSpinnerTree: boolean): boolean {
  if (!showSpinnerTree) return false;
  let hasVisibleTask = false;
  for (const t of Object.values(tasks) as TaskState[]) {
    if (!isBackgroundTask(t)) {
      continue;
    }
    hasVisibleTask = true;
    if (t.type !== 'in_process_teammate') return false;
  }
  return hasVisibleTask;
}
