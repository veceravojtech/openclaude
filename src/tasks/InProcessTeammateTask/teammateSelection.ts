import {
  getNaturalSubLeadAgentId,
  getParentTeamName,
} from '../../utils/swarm/teamHelpers.js'
import type { InProcessTeammateTaskState } from './types.js'

/**
 * Which row of the teammates tree is selected, keyed by TASK ID rather than by
 * position.
 *
 * The selection used to be a number indexing getRunningTeammatesSorted, which
 * meant a row leaving or arriving ABOVE the selection silently slid the
 * highlight onto a different teammate — the "switching between teammates is
 * hard because it sometimes disappears" this module exists to fix. An id can
 * only ever name the teammate it named, so the highlight moves when and only
 * when that teammate's row is gone, and then only to the nearest survivor
 * (see {@link resolveSurvivingSelection}).
 *
 * `leader` and `hide` are the two synthetic rows the tree draws around the
 * teammates; they always exist, so they can never be orphaned.
 */
export type TeammateSelection =
  | { kind: 'leader' }
  | { kind: 'teammate'; taskId: string }
  | { kind: 'hide' }

/**
 * Shared singletons for the two synthetic rows. Selection lives in AppState and
 * feeds react-compiler memo dependencies, so a fresh `{ kind: 'leader' }` on
 * every step would invalidate those caches for a selection that did not change.
 */
export const LEADER_SELECTION: TeammateSelection = Object.freeze({
  kind: 'leader',
})
export const HIDE_SELECTION: TeammateSelection = Object.freeze({ kind: 'hide' })

/**
 * A byte no task id contains, so joining ids with it cannot make two different
 * orders share a signature.
 */
const ORDER_SIGNATURE_SEPARATOR = '\u0000'

/**
 * A value that changes exactly when the ordered rows change — by membership OR
 * by position. Effects key on this instead of on the row COUNT, which is what
 * made a leave+join of two different teammates invisible to the old clamp.
 */
export function orderSignature(
  order: readonly InProcessTeammateTaskState[],
): string {
  return order.map(task => task.id).join(ORDER_SIGNATURE_SEPARATOR)
}

/** Structural equality, so an unchanged selection can be returned as `prev`. */
export function selectionsEqual(
  a: TeammateSelection | null,
  b: TeammateSelection | null,
): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.kind !== b.kind) return false
  return a.kind !== 'teammate' || a.taskId === (b as { taskId: string }).taskId
}

/**
 * Where the selection goes when the ordered list changes.
 *
 * A selection whose task is STILL listed is returned untouched, whatever its
 * position now is — that is the whole point, and it covers both "a row was
 * added above" and "a row left above". A selection whose task is gone moves to
 * the nearest survivor, in this order:
 *
 *   1. the previous siblings in tree order, nearest first — a row of the same
 *      team that sits earlier in the depth-first order (any sub-tree nested
 *      between them is skipped, because those rows are not siblings);
 *   2. the sub-leads above it, nearest first — the row leading the departed
 *      row's team, then the row leading THAT team, and so on up. The lead of a
 *      team is exact rather than a guess: getNaturalSubLeadAgentId is the
 *      inverse of getSubTeamNameFor;
 *   3. the leader row.
 *
 * Never an arbitrary teammate, and never left dangling. The synthetic rows
 * (`leader`, `hide`) and "nothing selected" (`null`) pass straight through.
 *
 * The spec says "the previous sibling"; walking the siblings nearest-first is a
 * strict superset that also survives a whole block of siblings leaving in the
 * same frame, and it degenerates to the single previous sibling whenever only
 * one row leaves. Same for the parent CHAIN versus a single parent step: it is
 * what makes an entire sub-tree vanishing land somewhere sane.
 *
 * A grace row's final eviction needs no special case — the row simply leaves
 * `nextOrder` once its deadline passes, which is rule 3 like any other removal.
 */
export function resolveSurvivingSelection(
  prev: TeammateSelection | null,
  prevOrder: readonly InProcessTeammateTaskState[],
  nextOrder: readonly InProcessTeammateTaskState[],
): TeammateSelection | null {
  if (prev === null || prev.kind !== 'teammate') return prev

  const survivingIds = new Set(nextOrder.map(task => task.id))
  if (survivingIds.has(prev.taskId)) return prev

  const departedIndex = prevOrder.findIndex(task => task.id === prev.taskId)
  // The selection names a row that was not in the previous order either — a
  // stale value from before a reset. There is no neighbourhood to fall back on.
  if (departedIndex === -1) return LEADER_SELECTION

  for (const candidate of survivorCandidates(prevOrder, departedIndex)) {
    if (survivingIds.has(candidate.id)) {
      return { kind: 'teammate', taskId: candidate.id }
    }
  }
  return LEADER_SELECTION
}

/**
 * The rows that may inherit a departed row's selection, best first: previous
 * siblings nearest-first, then the sub-lead chain nearest-first. Built from the
 * PREVIOUS order, because that is the only place the departed row still has a
 * neighbourhood.
 */
function survivorCandidates(
  prevOrder: readonly InProcessTeammateTaskState[],
  departedIndex: number,
): InProcessTeammateTaskState[] {
  const departed = prevOrder[departedIndex]!
  // Same tolerance as orderTeammatesDepthFirst: an identity without a team name
  // belongs to the root team, keyed on ''.
  const team = departed.identity.teamName ?? ''
  const candidates: InProcessTeammateTaskState[] = []

  for (let index = departedIndex - 1; index >= 0; index--) {
    const row = prevOrder[index]!
    if ((row.identity.teamName ?? '') === team) candidates.push(row)
  }

  let subTeam = team
  let parentTeam = getParentTeamName(subTeam)
  while (parentTeam !== undefined) {
    const leadAgentId = getNaturalSubLeadAgentId(subTeam)
    const lead =
      leadAgentId === undefined
        ? undefined
        : prevOrder.find(row => row.identity.agentId === leadAgentId)
    if (lead !== undefined) candidates.push(lead)
    subTeam = parentTeam
    parentTeam = getParentTeamName(subTeam)
  }

  return candidates
}

/**
 * Walk a wrapping list of selectable rows by one step.
 *
 * This is the ONLY place positions still exist. The steppers move by position
 * and store the SELECTION they land on, so nothing downstream holds a number
 * that a changing list could invalidate.
 *
 * Nothing selected, and a selection naming a row that is not in this list right
 * now, both step from the leader — the same place index -1 stepped from.
 */
function stepOver(
  rows: readonly TeammateSelection[],
  current: TeammateSelection | null,
  delta: 1 | -1,
): TeammateSelection {
  const currentIndex =
    current === null ? 0 : rows.findIndex(row => selectionsEqual(row, current))
  const from = currentIndex === -1 ? 0 : currentIndex
  return rows[(from + delta + rows.length) % rows.length]!
}

function teammateRows(
  order: readonly InProcessTeammateTaskState[],
): TeammateSelection[] {
  return order.map(task => ({ kind: 'teammate' as const, taskId: task.id }))
}

/**
 * The selectable rows of the TREE, in the order Shift+Up/Down walks them: the
 * leader, then one entry per teammate in depth-first order, then the hide row.
 */
export function stepSelection(
  current: TeammateSelection | null,
  order: readonly InProcessTeammateTaskState[],
  delta: 1 | -1,
): TeammateSelection {
  return stepOver(
    [LEADER_SELECTION, ...teammateRows(order), HIDE_SELECTION],
    current,
    delta,
  )
}

/**
 * The selectable pills of the FOOTER, in the order ←/→ cycles them: the
 * leader's `main` pill, then one per teammate. The same walk as
 * {@link stepSelection} minus the hide row, which the footer has no pill for —
 * so this can never hand the footer a selection it cannot render.
 */
export function stepFooterSelection(
  current: TeammateSelection,
  order: readonly InProcessTeammateTaskState[],
  delta: 1 | -1,
): TeammateSelection {
  return stepOver([LEADER_SELECTION, ...teammateRows(order)], current, delta)
}

/** The task a selection names, or undefined when it names no listed teammate. */
export function selectedTeammateTask(
  selection: TeammateSelection | null,
  order: readonly InProcessTeammateTaskState[],
): InProcessTeammateTaskState | undefined {
  if (selection === null || selection.kind !== 'teammate') return undefined
  return order.find(task => task.id === selection.taskId)
}

/**
 * The footer pill row's index for a selection: 0 is the leader's `main` pill and
 * a teammate at position `i` is `i + 1`, matching the `[mainPill, ...teammates]`
 * array BackgroundTaskStatus stamps `idx` onto.
 *
 * -1 means "no pill highlighted" — a selection naming a teammate the footer is
 * not showing (for the one frame before the survivor rule repairs it), and the
 * `hide` row, which the footer does not have.
 */
export function footerIndexForSelection(
  selection: TeammateSelection,
  order: readonly InProcessTeammateTaskState[],
): number {
  if (selection.kind === 'leader') return 0
  if (selection.kind === 'hide') return -1
  const index = order.findIndex(task => task.id === selection.taskId)
  return index === -1 ? -1 : index + 1
}
