import { describe, expect, test } from 'bun:test'

import { deriveInitialExpandedView } from './AppStateStore.js'

/**
 * Which expandedView a fresh session starts in.
 *
 * The teammates panel is ON by default once Agent Teams are enabled — that is
 * the whole "the tree must be visible every time it is enabled" rule at startup
 * — but "hide it" is a recorded preference and must survive a restart, and a
 * persisted 'teammates' must no longer be silently downgraded because no
 * teammate happens to be running yet. All four of those live in this one pure
 * derivation.
 */

describe('deriveInitialExpandedView', () => {
  test('honours a persisted teammates panel', () => {
    expect(deriveInitialExpandedView({ showSpinnerTree: true }, true)).toBe(
      'teammates',
    )
    // Even with Agent Teams off: the user asked for this panel, and the gate
    // that actually hides it lives in the panel, not in the stored preference.
    expect(deriveInitialExpandedView({ showSpinnerTree: true }, false)).toBe(
      'teammates',
    )
  })

  test('defaults to the teammates panel on a first run with Agent Teams enabled', () => {
    expect(deriveInitialExpandedView({}, true)).toBe('teammates')
  })

  test('defaults to none on a first run with Agent Teams disabled', () => {
    expect(deriveInitialExpandedView({}, false)).toBe('none')
  })

  test('an explicit hide survives the restart instead of re-defaulting to on', () => {
    // Ctrl+T to 'none' persists showSpinnerTree: false (onChangeAppState). That
    // recorded `false` is the difference between "hidden on purpose" and "never
    // chosen", which is why the default keys on `undefined` and not on falsiness.
    expect(
      deriveInitialExpandedView(
        { showSpinnerTree: false, showExpandedTodos: false },
        true,
      ),
    ).toBe('none')
  })

  test('a persisted todo list is kept, and wins over the first-run default', () => {
    expect(
      deriveInitialExpandedView(
        { showSpinnerTree: false, showExpandedTodos: true },
        true,
      ),
    ).toBe('tasks')
    // No tree preference recorded at all, but the todo list was expanded: that
    // is still a persisted view, so it is honoured rather than replaced.
    expect(deriveInitialExpandedView({ showExpandedTodos: true }, true)).toBe(
      'tasks',
    )
  })

  test('the teammates panel wins over the todo list when both were persisted', () => {
    // Only reachable from a hand-edited config: the two booleans are written
    // together from one expandedView, so they are never both true in practice.
    expect(
      deriveInitialExpandedView(
        { showSpinnerTree: true, showExpandedTodos: true },
        true,
      ),
    ).toBe('teammates')
  })
})
