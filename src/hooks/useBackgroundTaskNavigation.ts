import { useEffect, useRef } from 'react'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import {
  type AppState,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../state/teammateViewHelpers.js'
import { getRunningTeammatesSorted } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  LEADER_SELECTION,
  orderSignature,
  resolveSurvivingSelection,
  selectedTeammateTask,
  selectionsEqual,
  stepSelection,
} from '../tasks/InProcessTeammateTask/teammateSelection.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/types.js'
import { isBackgroundTask } from '../tasks/types.js'
import {
  requestAbort,
  traceInterruptionEvent,
} from '../utils/interruptionTrace.js'
import { killInProcessTeammate } from '../utils/swarm/spawnInProcess.js'

// Step teammate selection by delta over the selectable rows — leader, then the
// teammates in depth-first tree order, then the hide row — storing the
// SELECTION it lands on rather than the position it landed at.
// First step from a collapsed tree expands it and parks on leader.
function stepTeammateSelection(
  delta: 1 | -1,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    if (prev.expandedView !== 'teammates') {
      return {
        ...prev,
        expandedView: 'teammates' as const,
        viewSelectionMode: 'selecting-agent',
        selectedTeammate: LEADER_SELECTION,
      }
    }

    // No zero-row bail: with no teammates the selectable rows are still leader
    // and hide, so the panel's own rows stay reachable when it is showing its
    // empty state. Whether Shift+Up/Down belongs to the tree at all is the
    // caller's decision (it hands the press to the background-tasks dialog when
    // there is neither a teammate nor a panel).
    const next = stepSelection(
      prev.selectedTeammate,
      getRunningTeammatesSorted(prev.tasks),
      delta,
    )
    return {
      ...prev,
      selectedTeammate: next,
      viewSelectionMode: 'selecting-agent',
    }
  })
}

/**
 * Custom hook that handles Shift+Up/Down keyboard navigation for background tasks.
 * When teammates (swarm) are present, navigates between leader and teammates.
 * When only non-teammate background tasks exist, opens the background tasks dialog.
 * Also handles Enter to confirm selection, 'f' to view transcript, and 'k' to kill.
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const expandedView = useAppState(s => s.expandedView)
  const selectedTeammate = useAppState(s => s.selectedTeammate)
  const setAppState = useSetAppState()

  // Running teammates in the one shared depth-first tree order, so Shift+Up/Down
  // walks a sub-lead straight into its own sub-team and the selection names the
  // same row TeammateSpinnerTree draws at that position.
  const teammateTasks = getRunningTeammatesSorted(tasks)
  const teammateCount = teammateTasks.length

  // Check for non-teammate background tasks (local_agent, local_bash, etc.)
  const hasNonTeammateBackgroundTasks = Object.values(tasks).some(
    t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
  )

  // The rows as they were when this effect last ran. The ROWS, not their ids:
  // the survivor rule needs each row's identity to find siblings and sub-leads.
  const prevOrderRef =
    useRef<readonly InProcessTeammateTaskState[]>(teammateTasks)

  // Changes when the ordered rows change by membership OR by position, and is
  // the survivor effect's only trigger.
  const teammateOrderSignature = orderSignature(teammateTasks)

  // Move the selection to the nearest survivor when the ordered list changes.
  //
  // Keyed on the ORDER, never on the count, which is the defect this replaced:
  // a leave+join that keeps the count unchanged never re-ran the old clamp, and
  // a row leaving above the selection shifted the highlight onto a different
  // teammate instead of being noticed at all.
  useEffect(() => {
    setAppState(prev => {
      // ONE `now` for the whole updater, so the grace deadlines cannot be read
      // two different ways inside a single decision.
      const now = Date.now()
      const nextOrder = getRunningTeammatesSorted(prev.tasks, now)
      const prevOrder = prevOrderRef.current
      // Safe inside the updater: this store calls it exactly once and
      // synchronously (state/store.ts), so this is not a React useState updater
      // that StrictMode may invoke twice.
      prevOrderRef.current = nextOrder

      const next = resolveSurvivingSelection(
        prev.selectedTeammate,
        prevOrder,
        nextOrder,
      )
      // The last teammate left while one was selected: also drop out of
      // selection mode, unless a transcript is being viewed — the user may be
      // reading a finished teammate and needs Escape to exit.
      const clearsSelectionMode =
        nextOrder.length === 0 &&
        prev.selectedTeammate?.kind === 'teammate' &&
        prev.viewSelectionMode !== 'viewing-agent'

      if (selectionsEqual(next, prev.selectedTeammate) && !clearsSelectionMode) {
        return prev
      }
      return {
        ...prev,
        selectedTeammate: next,
        ...(clearsSelectionMode && { viewSelectionMode: 'none' as const }),
      }
    })
  }, [teammateOrderSignature, setAppState])

  // Get the selected teammate's task info
  const getSelectedTeammate = (): {
    taskId: string
    task: InProcessTeammateTaskState
  } | null => {
    const task = selectedTeammateTask(selectedTeammate, teammateTasks)
    if (!task) return null

    return { taskId: task.id, task }
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    // Escape in viewing mode:
    // - If the teammate is busy on a turn: abort current work only (stops the
    //   turn, teammate stays alive). Press Escape again to return.
    // - Otherwise (idle, between turns, completed/killed/failed, or not a
    //   teammate): exit the view back to the leader.
    // A live in-process teammate keeps status 'running' for its whole life
    // (idle is a separate flag), so gating on status alone made Escape a
    // no-op for an idle teammate and the view impossible to leave by key.
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (
          isInProcessTeammateTask(task) &&
          task.status === 'running' &&
          !task.isIdle &&
          task.currentWorkAbortController
        ) {
          // Abort currentWorkAbortController (stops current turn) NOT abortController (kills teammate)
          const causalEventId = traceInterruptionEvent(
            'input.teammate_escape',
            {
              source: 'teammate_escape',
              subsystem: 'in_process_teammate',
              subagentId: task.identity.agentId,
            },
          )
          requestAbort(task.currentWorkAbortController, undefined, {
            source: 'teammate_escape',
            subsystem: 'in_process_teammate',
            controllerRole: 'subagent-turn',
            subagentId: task.identity.agentId,
            causalEventId,
          })
          return
        }
      }
      // Nothing to interrupt — exit the view
      exitTeammateView(setAppState)
      return
    }

    // Escape in selection mode: exit selection without aborting leader
    if (e.key === 'escape' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      setAppState(prev => ({
        ...prev,
        viewSelectionMode: 'none',
        selectedTeammate: null,
      }))
      return
    }

    // Shift+Up/Down for teammate transcript switching (with wrapping) over
    // leader → teammates → hide. The panel showing its empty state is reason
    // enough to step: its leader and hide rows are selectable with no teammate
    // alive. With the panel off and no teammate, the press still belongs to the
    // background-tasks dialog.
    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (teammateCount > 0 || expandedView === 'teammates') {
        stepTeammateSelection(e.key === 'down' ? 1 : -1, setAppState)
      } else if (hasNonTeammateBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      }
      return
    }

    // 'f' to view selected teammate's transcript (only in selecting mode)
    if (
      e.key === 'f' &&
      viewSelectionMode === 'selecting-agent' &&
      teammateCount > 0
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected) {
        enterTeammateView(selected.taskId, setAppState)
      }
      return
    }

    // Enter to confirm selection (only when in selecting mode)
    if (e.key === 'return' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      // Nothing selected reads as the leader row, exactly as index -1 did.
      const kind = selectedTeammate?.kind ?? 'leader'
      if (kind === 'leader') {
        exitTeammateView(setAppState)
      } else if (kind === 'hide') {
        // "Hide" row selected - collapse the spinner tree
        setAppState(prev => ({
          ...prev,
          expandedView: 'none' as const,
          viewSelectionMode: 'none',
          selectedTeammate: null,
        }))
      } else {
        const selected = getSelectedTeammate()
        if (selected) {
          enterTeammateView(selected.taskId, setAppState)
        }
      }
      return
    }

    // k to kill selected teammate (only in selecting mode).
    // The outer guard is "a row below the leader is selected" — a teammate or
    // the hide row, the same population index >= 0 covered — so k stays
    // swallowed on the hide row instead of reaching the prompt. The kill itself
    // needs a listed teammate that is still running, which is what makes k a
    // no-op on a row inside its grace window.
    if (
      e.key === 'k' &&
      viewSelectionMode === 'selecting-agent' &&
      selectedTeammate !== null &&
      selectedTeammate.kind !== 'leader'
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected && selected.task.status === 'running') {
        const causalEventId = traceInterruptionEvent('input.teammate_kill', {
          source: 'teammate_kill',
          subsystem: 'in_process_teammate',
          subagentId: selected.task.identity.agentId,
        })
        killInProcessTeammate(selected.taskId, setAppState, {
          source: 'teammate_kill',
          causalEventId,
        })
      }
      return
    }
  }

  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
