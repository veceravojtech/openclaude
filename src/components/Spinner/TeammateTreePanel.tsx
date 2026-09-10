import * as React from 'react'
import { isTerminalTaskStatus } from '../../Task.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { getAllInProcessTeammateTasks } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { evictTerminalTask } from '../../utils/task/framework.js'
import { isRetainedOrWithinGrace } from '../../utils/task/retention.js'
import { TeammateSpinnerTree } from './TeammateSpinnerTree.js'

/**
 * The teammates tree's own mount: one stable slot in the REPL, above the prompt
 * input, for as long as the toggle is on.
 *
 * The tree used to be a branch of the SPINNER, which made it disappear in three
 * ways the user could not predict: the spinner itself unmounts once the lead is
 * idle with no running teammate, two of the three mounts also required a running
 * teammate, and the tree answered `null` at zero rows. The user's rule is the
 * opposite — "the teammates tree must be visible every time it is enabled, even
 * when no teammates are available" — so visibility is now exactly one condition,
 * checked here: the toggle is on and Agent Teams are enabled. Nothing about the
 * spinner's own text or timing is involved any more.
 *
 * This component is deliberately NOT react-compiler output: it is the gate plus
 * one timer, and keeping it hand-written means there are no cache slots here to
 * fall out of step with the 61-slot map inside TeammateSpinnerTree.
 */
export function TeammateTreePanel(): React.ReactNode {
  const expandedView = useAppState(s => s.expandedView)
  const tasks = useAppState(s => s.tasks)
  const selectedIndex = useAppState(s => s.selectedIPAgentIndex)
  const isInSelectionMode = useAppState(
    s => s.viewSelectionMode === 'selecting-agent',
  )
  const setAppState = useSetAppState()

  // "Everyone still working has parked" — over RUNNING teammates only. A row in
  // its grace window is finished, not idle, and counting it here would turn the
  // live rows' text past-tense while real work is still going on.
  const allIdle = React.useMemo(() => {
    const running = getAllInProcessTeammateTasks(tasks).filter(
      t => t.status === 'running',
    )
    return running.length > 0 && running.every(t => t.isIdle)
  }, [tasks])

  // The earliest moment a row currently on screen stops being in grace, or
  // undefined when nothing is in grace.
  const nextDeadline = React.useMemo(() => {
    let earliest: number | undefined
    for (const task of getAllInProcessTeammateTasks(tasks)) {
      if (!isTerminalTaskStatus(task.status)) continue
      const deadline = task.evictAfter
      if (deadline === undefined || !isRetainedOrWithinGrace(task)) continue
      if (earliest === undefined || deadline < earliest) earliest = deadline
    }
    return earliest
  }, [tasks])

  // ONE timeout for that ONE deadline — not a poll and not a second collector.
  // It calls the SAME evictTerminalTask both GC paths are built on (and the same
  // call the coordinator panel's tick makes for local agents), which can only
  // collect what the shared retain/grace rule already allows.
  //
  // Why the deadline has to become an AppState change rather than a bare
  // repaint: TeammateSpinnerTree is react-compiler output whose memo is keyed on
  // `tasks` ($[7]), so a re-render that leaves `tasks` untouched serves the
  // cached rows and an expired row would stay on screen. Evicting also keeps
  // AppState from holding finished teammates until the lead's next turn, which
  // is the only other time the lazy GC runs.
  React.useEffect(() => {
    if (nextDeadline === undefined) return
    // +1ms: the rule is `evictAfter > now`, so the row survives its deadline
    // instant itself.
    const delay = Math.max(0, nextDeadline - Date.now()) + 1
    const timer = setTimeout(() => {
      const now = Date.now()
      for (const task of getAllInProcessTeammateTasks(tasks)) {
        if (!isTerminalTaskStatus(task.status)) continue
        if (isRetainedOrWithinGrace(task, now)) continue
        evictTerminalTask(task.id, setAppState)
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [nextDeadline, tasks, setAppState])

  // Gate last, after every hook: the Rules of Hooks stay satisfied whichever way
  // the toggle goes, and the panel costs one subscription set while it is off.
  if (expandedView !== 'teammates' || !isAgentSwarmsEnabled()) {
    return null
  }

  // No leaderVerb / leaderIdleText / leaderTokenCount: those are the SPINNER's
  // values (a per-mount verb sample and its response-length ref), and the
  // spinner still draws them one row above this panel. Feeding a live token
  // count in here would also make the empty panel render differently depending
  // on whether the lead happens to be mid-turn.
  return (
    <TeammateSpinnerTree
      selectedIndex={selectedIndex}
      isInSelectionMode={isInSelectionMode}
      allIdle={allIdle}
    />
  )
}
