import { describe, expect, it } from 'bun:test'

import { isPromptTypingSuppressionActive } from './replInputSuppression.js'

describe('isPromptTypingSuppressionActive', () => {
  it('suppresses dialogs when early input already exists', () => {
    expect(isPromptTypingSuppressionActive(false, 'hello')).toBe(true)
  })

  it('does not suppress dialogs for empty or whitespace-only input', () => {
    expect(isPromptTypingSuppressionActive(false, '')).toBe(false)
    expect(isPromptTypingSuppressionActive(false, '   ')).toBe(false)
  })

  it('keeps suppression active while the typing flag is set', () => {
    expect(isPromptTypingSuppressionActive(true, '')).toBe(true)
  })

  it('suppresses dialogs while the user types outside the prompt buffer', () => {
    // Ctrl+R history search: the prompt is unfocused and its buffer empty for
    // the whole search, so the first two arguments cannot see the typing.
    expect(isPromptTypingSuppressionActive(false, '', true)).toBe(true)
  })

  it('leaves the out-of-prompt flag off by default', () => {
    expect(isPromptTypingSuppressionActive(false, '')).toBe(false)
    expect(isPromptTypingSuppressionActive(false, '', false)).toBe(false)
  })
})
