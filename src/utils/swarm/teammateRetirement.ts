import { randomUUID } from 'crypto'
import type { AppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { jsonStringify } from '../slowOperations.js'
import { TEAMMATE_GRACE_MS } from '../task/framework.js'

/**
 * Retire a teammate from the LEAD's own view of the team.
 *
 * Two callers reach this with the same intent and the same state shape: the
 * inbox poller, when a teammate's shutdown approval arrives and its pane has
 * been killed, and the pane watchdog, when it finds a roster member whose pane
 * is gone (a ghost nobody would ever clean up). They were written as one
 * inline block inside the poller's message loop; living here keeps the shape
 * of the retirement — which fields a retired teammate's task row must carry —
 * in one place instead of two.
 *
 * What it does NOT do is the part that differs between the two: killing a pane
 * (the poller's case, it has the pane id from the approval) or deciding that a
 * teammate is unreachable at all (the watchdog's case, it has a dead pane
 * probe). Both of those are the caller's judgement; this is only the bookkeeping
 * that follows from it.
 *
 * It removes the teammate from `teamContext.teammates` and force-completes the
 * task rows that were keeping it on screen. Nothing else transitions an
 * out-of-process (tmux/iTerm2) teammate's row — only in-process teammates have
 * a runner that writes 'completed' — so without this an out-of-process
 * teammate's row stays status:'running' forever and the roster count never
 * returns to zero.
 *
 * The `notified: true` marker is deliberate: the completion IS delivered, as
 * the `teammate_terminated` system message this function appends to the lead's
 * inbox, so the transition owes no further notification. Leaving it unset made
 * BOTH evictors bail on `!task.notified`, so the row sat in AppState for the
 * rest of the session after its row left at the deadline. Nothing else reads
 * the flag for a teammate: the per-type notification helpers that use it as a
 * claim are local_agent/shell/remote only.
 *
 * `retain: false` + `evictAfter` is the same retention marker every in-process
 * terminal transition writes. Without it an out-of-process teammate's row
 * vanished the instant it shut down instead of keeping its place for the grace
 * window, and carried no deadline for the lazy GC to collect it by.
 *
 * Guarded on the teammate still being in `teamContext.teammates`, unchanged
 * from the poller's original block: a team context that never held this
 * teammate is not a map this function should be rewriting, and a second
 * retirement of the same teammate is a no-op rather than a second system
 * message.
 */
export function retireTeammateFromLeaderView({
  teammateId,
  notificationMessage,
  setAppState,
  now = Date.now,
}: {
  teammateId: string
  notificationMessage: string
  setAppState: (updater: (prev: AppState) => AppState) => void
  /** Injectable clock, so tests can pin the retention window. */
  now?: () => number
}): void {
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev
    if (!(teammateId in prev.teamContext.teammates)) return prev

    const { [teammateId]: _retired, ...remainingTeammates } =
      prev.teamContext.teammates

    const updatedTasks = { ...prev.tasks }
    for (const [tid, task] of Object.entries(updatedTasks)) {
      if (
        isInProcessTeammateTask(task) &&
        task.identity.agentId === teammateId
      ) {
        const at = now()
        updatedTasks[tid] = {
          ...task,
          status: 'completed' as const,
          notified: true,
          endTime: at,
          retain: false,
          evictAfter: at + TEAMMATE_GRACE_MS,
        }
      }
    }

    return {
      ...prev,
      tasks: updatedTasks,
      teamContext: {
        ...prev.teamContext,
        teammates: remainingTeammates,
      },
      inbox: {
        messages: [
          ...prev.inbox.messages,
          {
            id: randomUUID(),
            from: 'system',
            text: jsonStringify({
              type: 'teammate_terminated',
              message: notificationMessage,
            }),
            timestamp: new Date().toISOString(),
            status: 'pending' as const,
          },
        ],
      },
    }
  })
}
