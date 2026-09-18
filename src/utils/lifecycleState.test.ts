import { afterEach, describe, expect, test } from 'bun:test'

import {
  isProcessWindingDown,
  markProcessWindingDown,
  resetLifecycleStateForTesting,
} from './lifecycleState.js'

describe('lifecycleState', () => {
  afterEach(() => {
    resetLifecycleStateForTesting()
  })

  test('starts not winding down', () => {
    expect(isProcessWindingDown()).toBe(false)
  })

  test('markProcessWindingDown sets the flag', () => {
    markProcessWindingDown()
    expect(isProcessWindingDown()).toBe(true)
  })

  test('resetLifecycleStateForTesting clears the flag', () => {
    markProcessWindingDown()
    resetLifecycleStateForTesting()
    expect(isProcessWindingDown()).toBe(false)
  })
})
