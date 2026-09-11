import { describe, expect, test } from 'bun:test'

import { nextExpandedView } from './useGlobalKeybindings.js'

/**
 * Ctrl+T cycles none → tasks → teammates → none, at any time.
 *
 * The teammates step used to be reachable only while an in-process teammate had
 * status 'running'; without one the cycle collapsed to none ↔ tasks, so the
 * panel could not be opened before spawning a teammate — and the first press
 * silently rewrote a persisted 'teammates' to 'tasks'. The cycle is now a pure
 * function of the current view and nothing else, which is exactly what these
 * cases pin: there is no tasks argument left for a teammate count to come from.
 */

describe('nextExpandedView', () => {
  test('walks none → tasks → teammates → none', () => {
    expect(nextExpandedView('none')).toBe('tasks')
    expect(nextExpandedView('tasks')).toBe('teammates')
    expect(nextExpandedView('teammates')).toBe('none')
  })

  test('three presses return to where they started', () => {
    expect(nextExpandedView(nextExpandedView(nextExpandedView('none')))).toBe(
      'none',
    )
    expect(
      nextExpandedView(nextExpandedView(nextExpandedView('teammates'))),
    ).toBe('teammates')
  })

  test('reaches teammates from tasks with no teammate in sight', () => {
    // The whole point: no AppState, no tasks map, no count — so no teammate can
    // gate the step.
    expect(nextExpandedView.length).toBe(1)
    expect(nextExpandedView('tasks')).toBe('teammates')
  })
})

/**
 * The one thing that DOES gate the teammates step: the feature itself.
 *
 * TeammateTreePanel renders nothing at all when Agent Teams are disabled, so an
 * ungated cycle walked through a state with no pixels — one Ctrl+T did nothing
 * visible, the invisible view was persisted as `showSpinnerTree: true`, and
 * Shift+↑/↓ went to a panel that was not on screen instead of to the
 * background-tasks dialog. With the feature off the cycle is none ↔ tasks, and
 * 'teammates' is not a step it can land on from anywhere.
 */
describe('nextExpandedView with Agent Teams disabled', () => {
  test('skips the teammates step: the cycle is none ↔ tasks', () => {
    expect(nextExpandedView('none', false)).toBe('tasks')
    expect(nextExpandedView('tasks', false)).toBe('none')
  })

  test('never lands on teammates, from any starting view', () => {
    for (const from of ['none', 'tasks', 'teammates'] as const) {
      expect(nextExpandedView(from, false)).not.toBe('teammates')
    }
  })

  test('leaves a view that is already teammates, rather than parking on it', () => {
    // Reachable from a session that ran with the feature ON and persisted the
    // view; one press must take it somewhere that renders.
    expect(nextExpandedView('teammates', false)).toBe('none')
  })

  test('two presses from none return to none instead of taking three', () => {
    expect(nextExpandedView(nextExpandedView('none', false), false)).toBe('none')
  })

  test('the enabled cycle is exactly what the default argument gives', () => {
    // The parameter defaults to the full cycle, which is why every call above
    // in this file — and the single call site — keeps today's behaviour and why
    // `nextExpandedView.length` is still 1.
    for (const from of ['none', 'tasks', 'teammates'] as const) {
      expect(nextExpandedView(from, true)).toBe(nextExpandedView(from))
    }
  })
})
