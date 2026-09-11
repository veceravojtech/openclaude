import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Source-scan regression (same approach as REPL.queryLifecycle.test.ts) for the
// one line that arms the teammate keys' typing gate. useBackgroundTaskNavigation
// takes promptTypingSuppressionActive as an option, so its own suite can hand
// itself either value; what production does is decided here, and an option no
// caller passes is a gate that never closes. A unit test of the hook cannot
// catch that, so assert the wiring against the component source.
const source = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')

describe('REPL teammate-navigation key wiring', () => {
  test('hands the typing flag to useBackgroundTaskNavigation', () => {
    const start = source.indexOf('useBackgroundTaskNavigation({')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('});', start)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain('promptTypingSuppressionActive')
  })

  test('and it is the flag the rest of the screen already defers on', () => {
    // Same value the deferred-dialog gate reads, computed once from the shared
    // helper — not a second opinion on whether the user is typing.
    expect(source).toContain(
      'const promptTypingSuppressionActive = isPromptTypingSuppressionActive(isPromptInputActive, inputValue);',
    )
    expect(source).toContain('if (promptTypingSuppressionActive) return undefined;')
  })
})
