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
