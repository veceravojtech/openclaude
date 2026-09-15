import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Source-scan regression (same approach as REPL.queryLifecycle.test.ts) for the
// one line that arms the teammate keys' typing gate. useBackgroundTaskNavigation
// takes promptTypingSuppressionActive as an option, so its own suite can hand
// itself either value; what production does is decided here, and an option no
// caller passes is a gate that never closes. A unit test of the hook cannot
// catch that, so assert the wiring against the component source.
//
// Scanning text means commented-out code reads the same as live code, so the
// source is stripped of line comments first: the call has to be REACHED, not
// merely mentioned. The flag is required to be passed by shorthand, because
// `promptTypingSuppressionActive: false` would satisfy a substring match while
// holding the gate permanently open.
const rawSource = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')
const source = rawSource
  .split('\n')
  .filter(line => !line.trimStart().startsWith('//'))
  .join('\n')

describe('REPL teammate-navigation key wiring', () => {
  test('hands the typing flag to useBackgroundTaskNavigation', () => {
    const start = source.indexOf('useBackgroundTaskNavigation({')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('});', start)
    expect(end).toBeGreaterThan(start)
    const call = source.slice(start, end)
    expect(call).toContain('promptTypingSuppressionActive')
    // Shorthand only: a `: <literal>` here is a gate that never closes.
    expect(call).toMatch(/[\s,{]promptTypingSuppressionActive\s*(?:,|\r?\n|$)/)
  })

  test('and it is the flag the rest of the screen already defers on', () => {
    // Same value the deferred-dialog gate reads, computed once from the shared
    // helper — not a second opinion on whether the user is typing. The search
    // state is handed over as the identifier for the same reason the hook
    // option is: `, true` or `, false` here is a gate stuck open or shut.
    expect(source).toContain(
      'const promptTypingSuppressionActive = isPromptTypingSuppressionActive(isPromptInputActive, inputValue, isSearchingHistory);',
    )
    expect(source).toContain('if (promptTypingSuppressionActive) return undefined;')
  })

  test('declares isSearchingHistory above the line that reads it', () => {
    // A const in the component body read from above its own declaration sits
    // in the temporal dead zone, so REPL throws on mount — and `tsc` does not
    // catch it. Scanned rather than commented, so re-separating them goes red.
    const declaration = source.indexOf(
      'const [isSearchingHistory, setIsSearchingHistory] = useState(false);',
    )
    const use = source.indexOf(
      'isPromptTypingSuppressionActive(isPromptInputActive, inputValue, isSearchingHistory)',
    )
    expect(declaration).toBeGreaterThan(-1)
    expect(use).toBeGreaterThan(-1)
    expect(declaration).toBeLessThan(use)
  })
})
