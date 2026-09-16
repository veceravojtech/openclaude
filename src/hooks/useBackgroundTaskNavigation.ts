import { useEffect, useRef } from 'react'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
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
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
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
  /**
   * REPL's own "the user is typing" flag (isPromptTypingSuppressionActive):
   * the prompt buffer is non-empty. 'f' and 'k' are ordinary letters, so while
   * it is set they stay text.
   */
  promptTypingSuppressionActive?: boolean
  /**
   * REPL's raw isSearchingHistory. Enter is not a printable character the way
   * 'f' and 'k' are: it must stay live while the prompt merely HOLDS TEXT, and
   * stand down only while useHistorySearch owns the key through its
   * historySearch:execute binding. That is why this is its own option and not
   * promptTypingSuppressionActive: gating the Enter branch on the collapsed
   * typing flag kills Enter outright in selecting-agent, because PromptInput's
   * onSubmit already returns early in that mode — nothing would resolve the
   * selection and nothing would submit.
   */
  historySearchActive?: boolean
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const expandedView = useAppState(s => s.expandedView)
  const selectedTeammate = useAppState(s => s.selectedTeammate)
  const setAppState = useSetAppState()

  // "A dialog owns the keyboard right now" — the overlay contract's own modal
  // predicate, and the question nearly every branch below actually needs
  // answered. The named options above cannot answer it for the surface that
  // matters most:
  //
  // with HISTORY_PICKER on, Ctrl+R renders the MODAL HistorySearchDialog rather
  // than useHistorySearch's inline search. That dialog keeps its query in its
  // own state and never writes the prompt, so isPromptInputActive, inputValue
  // and isSearchingHistory are ALL false while the user types into it — and
  // isPromptTypingSuppressionActive, which is built from exactly those three,
  // returns false. So 'k' destroys the selected teammate mid-search, and every
  // other branch here fires under a dialog it was never aimed at.
  //
  // A dialog CANNOT stop this from its side, which is why the question has to
  // be asked here. App's input loop emits 'input' to every useInput subscriber
  // — this hook's bridge among them — and only then calls
  // dispatchKeyboardEvent, which builds a DIFFERENT event object for the DOM
  // onKeyDown path. FuzzyPicker's stopImmediatePropagation list lives on that
  // second path, so it runs on the wrong object after this hook has already
  // acted; it protects the dialog's own subtree, never this subscriber. The
  // arrow and tab keys in its list only look covered here because this hook has
  // no branch for a plain arrow or a tab.
  //
  // Asking the CONTRACT rather than adding a fourth named flag is what makes
  // this hold for the other dialogs too: every one of them registers itself
  // through useRegisterOverlay on mount, so QuickOpenDialog and
  // GlobalSearchDialog are covered by the same question without naming either.
  //
  // MODAL, not useIsOverlayActive: NON_MODAL_OVERLAYS holds 'autocomplete', and
  // during autocomplete the user is typing into the prompt for real, so
  // promptTypingSuppressionActive already stands the letters down there.
  // Gating on the wider predicate would only duplicate that.
  //
  // Escape is gated too, and that is safe rather than a trap because the exit
  // comes out LAYERED: the press that a dialog is up for dismisses the dialog
  // (every registered overlay has its own cancel path — use-select-input
  // registers 'select' ONLY when onCancel exists), and the next press is
  // ordinary Escape again. One extra press, in a state that otherwise destroys
  // an in-flight turn the user never aimed at.
  //
  // NOT applied to the Enter branch, which is NOT a claim that Enter is safe:
  // it fires on this surface too, for the same reason as the rest. Its
  // stand-down condition is the narrower historySearchActive, and changing that
  // is deliberately out of this change — see that option's doc for why the two
  // conditions are not one.
  const isModalOverlayActive = useIsModalOverlayActive()

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
    //   turn, teammate stays alive). Press Escape again to return: the second
    //   press sees the turn controller already aborted and falls through to the
    //   exit below, so the view always leaves in two presses — one when the
    //   turn was already interrupted and the runner has not cleared it yet.
    // - Otherwise (idle, between turns, completed/killed/failed, or not a
    //   teammate): exit the view back to the leader.
    // A live in-process teammate keeps status 'running' for its whole life
    // (idle is a separate flag), so gating on status alone made Escape a
    // no-op for an idle teammate and the view impossible to leave by key.
    //
    // While a modal overlay is up the press belongs to that dialog, and this
    // branch is the one that ABORTS THE TEAMMATE'S CURRENT TURN — the same
    // defect class as k with a smaller blast radius. Standing down costs the
    // user one extra press and no work.
    if (
      e.key === 'escape' &&
      !isModalOverlayActive &&
      viewSelectionMode === 'viewing-agent'
    ) {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (
          isInProcessTeammateTask(task) &&
          task.status === 'running' &&
          !task.isIdle &&
          task.currentWorkAbortController &&
          !task.currentWorkAbortController.signal.aborted
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

    // Escape in selection mode: exit selection without aborting leader. Stands
    // down under a modal overlay for the same reason as the branch above —
    // otherwise the press that closes a dialog also throws away the selection
    // the user built to get there.
    if (
      e.key === 'escape' &&
      !isModalOverlayActive &&
      viewSelectionMode === 'selecting-agent'
    ) {
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
    //
    // 'teammates' only counts while Agent Teams are ENABLED, because that is
    // the same condition TeammateTreePanel gates its own render on: with the
    // feature off the panel draws nothing, so stepping here would move a
    // selection nobody can see and would swallow the press that should open the
    // background-tasks dialog. The view itself is no longer reachable with the
    // feature off (nextExpandedView skips the step, deriveInitialExpandedView
    // boots it as 'none'); this is the third of those three gates, and the one
    // that decides what the key actually does.
    // The overlay term is the fourth of those gates, and it is what keeps the
    // selection from DRIFTING under a dialog: the k guard stops the kill while
    // the dialog is up, but a selection moved during the dialog outlives its
    // dismissal, so the next k — legitimately typed, no dialog, guard satisfied
    // — would land on a row the user never chose.
    if (
      e.shift &&
      !isModalOverlayActive &&
      (e.key === 'up' || e.key === 'down')
    ) {
      e.preventDefault()
      if (
        teammateCount > 0 ||
        (expandedView === 'teammates' && isAgentSwarmsEnabled())
      ) {
        stepTeammateSelection(e.key === 'down' ? 1 : -1, setAppState)
      } else if (hasNonTeammateBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      }
      return
    }

    // 'f' to view selected teammate's transcript (only in selecting mode, only
    // while the prompt is idle — see the option's doc — and only while no modal
    // overlay owns the keyboard, which is the state an open dialog leaves every
    // one of those options blind to).
    if (
      e.key === 'f' &&
      !options?.promptTypingSuppressionActive &&
      !isModalOverlayActive &&
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

    // Enter to confirm selection (only when in selecting mode, and only while
    // useHistorySearch does not own the key — see the option's doc). Unlike f
    // and k this does NOT stand down for a prompt that merely holds text.
    if (
      e.key === 'return' &&
      !options?.historySearchActive &&
      viewSelectionMode === 'selecting-agent'
    ) {
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

    // k to kill selected teammate (only in selecting mode, and only while the
    // prompt is idle — see the option's doc; selection mode itself survives
    // typing, so without that gate the letter destroys the selected teammate).
    // The overlay check is the same gate for the dialogs that type WITHOUT
    // touching the prompt: this is the data-loss key, so it stands down
    // whenever anything modal owns the keyboard.
    // The outer guard is "a row below the leader is selected" — a teammate or
    // the hide row, the same population index >= 0 covered. The kill itself
    // needs a listed teammate that is still running, which is what makes k a
    // no-op on a row inside its grace window.
    if (
      e.key === 'k' &&
      !options?.promptTypingSuppressionActive &&
      !isModalOverlayActive &&
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
  //
  // preventDefault() below marks the KeyboardEvent built HERE, which nothing
  // outside this hook reads — BaseTextInput is a sibling useInput subscriber and
  // is handed the InputEvent — so on this path a printable key reaches the
  // prompt whatever this hook decides. That is why f and k ask whether the user
  // is typing.
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
