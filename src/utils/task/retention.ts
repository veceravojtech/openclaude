/**
 * The ONE retain/grace rule.
 *
 * "A terminal panel task stays alive while the UI is holding it (`retain`) or
 * while it is still inside its eviction grace window (`evictAfter` in the
 * future)." This rule used to be written three times — once in the panel
 * visibility gate (isPanelVisibleAgent, tasks/LocalAgentTask/LocalAgentTask)
 * and once in each of the two GC paths (evictTerminalTask and
 * applyTaskOffsetsAndEvictions, ./framework) — where they agreed only by
 * convention. They now share this definition, so the panel and the collectors
 * cannot drift apart: whatever the panel considers visible, neither evictor
 * may GC, or the UI holds a task that has been deleted from under it.
 *
 * This module is deliberately dependency-free (types only, no framework, no
 * React/Ink): framework.ts and LocalAgentTask.tsx both import IT, never the
 * other way round.
 */

/**
 * The two fields the rule reads. Structural on purpose — LocalAgentTaskState
 * (the only task type that declares them) lives in a .tsx module, and this
 * util must not reach into the UI layer to describe two primitives.
 */
type RetainableTask = {
  retain: boolean
  evictAfter?: number
}

/**
 * Is this task retained by the UI, or still inside its eviction grace window?
 *
 * The three checks do different jobs, and all three are needed:
 *   - `'retain' in task` is the TYPE narrow — a property PRESENCE check that
 *     narrows to LocalAgentTaskState (the only task type carrying the field).
 *     It must stay a presence check on `retain`: `evictAfter` is optional, so
 *     narrowing on `'evictAfter' in task` instead would miss panel tasks that
 *     haven't had a deadline set yet. Task shapes without the field at all
 *     (shell/monitor/remote/workflow) never get the panel grace period.
 *   - `task.retain === true` is the VALUE check — the UI is actively holding
 *     this task, which is an independent reason to stay visible (and so to
 *     survive GC) regardless of the eviction deadline. Without it a retained
 *     task with a past evictAfter is a visible panel row the evictors would
 *     happily delete.
 *   - `(task.evictAfter ?? Infinity) > now` is the grace window — an unset
 *     deadline means "no deadline yet", not "expired".
 *
 * This predicate is only the retain/grace half of the panel gate. The terminal
 * status check, the `evictAfter === 0` dismissal check and isPanelAgentTask
 * belong to the panel gate alone; folding them in here would change what the
 * GC paths collect.
 *
 * `now` defaults to Date.now(); the explicit parameter keeps the eviction
 * deadline testable without timers.
 */
export function isRetainedOrWithinGrace(
  task: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof task !== 'object' || task === null || !('retain' in task)) {
    return false
  }
  const { retain, evictAfter } = task as RetainableTask
  return retain === true || (evictAfter ?? Infinity) > now
}
