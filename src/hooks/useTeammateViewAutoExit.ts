import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'

/**
 * Auto-exits teammate viewing mode when the viewed task is gone from AppState.
 *
 * That is the ONE reason left. A finished teammate (completed, failed or killed)
 * keeps its task — and its row — for TEAMMATE_GRACE_MS so the user can open and
 * read its transcript; ejecting on the status change instead, which is what this
 * hook used to do, made exactly that impossible. Once the grace window closes
 * the lazy GC deletes the task and the branch below takes the view back to the
 * leader, so the view still never outlives what it is showing.
 *
 * Local agents are unaffected: they are viewed through the same
 * viewingAgentTaskId and were never subject to the status ejections (the checks
 * were teammate-narrowed), and they are retained by enterTeammateView while
 * viewed, so they cannot be evicted from under the view either.
 */
export function useTeammateViewAutoExit(): void {
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // Select only whether the viewed task still exists, not the full tasks map —
  // otherwise every streaming update from any teammate re-renders this hook.
  const taskExists = useAppState(s =>
    s.viewingAgentTaskId ? s.tasks[s.viewingAgentTaskId] !== undefined : false,
  )

  useEffect(() => {
    // Not viewing any teammate
    if (!viewingAgentTaskId) {
      return
    }

    // Task no longer exists in the map — evicted out from under us. Keyed on the
    // raw presence of the task, never on its type: a local_agent task exists but
    // would narrow to undefined, which used to eject the view immediately.
    if (!taskExists) {
      exitTeammateView(setAppState)
    }
  }, [viewingAgentTaskId, taskExists, setAppState])
}
