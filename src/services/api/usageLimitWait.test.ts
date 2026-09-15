import { describe, expect, test } from 'bun:test'
import {
  USAGE_LIMIT_WAIT_BUFFER_MS,
  decideUsageLimitWait,
  isForegroundUsageLimitSource,
} from './usageLimitWait.js'

const CAP_MS = 6 * 60 * 60 * 1000
const NOW = 1_000_000_000_000

const eligible = {
  status: 429 as const,
  isFirstParty: true,
  querySource: 'repl_main_thread' as const,
  hasCancelSignal: true,
  resetDelayMs: 60 * 60 * 1000,
  resetCapMs: CAP_MS,
  otherAccountAvailable: () => false,
  alreadyWaited: false,
  now: NOW,
}

describe('decideUsageLimitWait', () => {
  test('waits, adding the skew buffer, when every gate passes', () => {
    const decision = decideUsageLimitWait(eligible)
    expect(decision).toEqual({
      type: 'wait',
      delayMs: 60 * 60 * 1000 + USAGE_LIMIT_WAIT_BUFFER_MS,
      resumeAtMs: NOW + 60 * 60 * 1000 + USAGE_LIMIT_WAIT_BUFFER_MS,
    })
  })

  test('skips: not-rate-limited for a non-429 status', () => {
    expect(decideUsageLimitWait({ ...eligible, status: 500 })).toEqual({
      type: 'skip',
      reason: 'not-rate-limited',
    })
  })

  test('skips: wrong-provider for a non-first-party request', () => {
    expect(decideUsageLimitWait({ ...eligible, isFirstParty: false })).toEqual(
      { type: 'skip', reason: 'wrong-provider' },
    )
  })

  test('skips: background-source for a teammate query source', () => {
    expect(
      decideUsageLimitWait({ ...eligible, querySource: 'agent:custom' }),
    ).toEqual({ type: 'skip', reason: 'background-source' })
  })

  test('skips: no-cancel-signal when no abort signal reached the request', () => {
    expect(decideUsageLimitWait({ ...eligible, hasCancelSignal: false })).toEqual(
      { type: 'skip', reason: 'no-cancel-signal' },
    )
  })

  test('skips: already-waited — one wait per request, never a loop', () => {
    expect(decideUsageLimitWait({ ...eligible, alreadyWaited: true })).toEqual({
      type: 'skip',
      reason: 'already-waited',
    })
  })

  test('skips: other-account-available — switching beats waiting', () => {
    expect(
      decideUsageLimitWait({
        ...eligible,
        otherAccountAvailable: () => true,
      }),
    ).toEqual({ type: 'skip', reason: 'other-account-available' })
  })

  test('skips: no-reset-time when the header is absent or in the past', () => {
    expect(decideUsageLimitWait({ ...eligible, resetDelayMs: null })).toEqual({
      type: 'skip',
      reason: 'no-reset-time',
    })
    expect(decideUsageLimitWait({ ...eligible, resetDelayMs: 0 })).toEqual({
      type: 'skip',
      reason: 'no-reset-time',
    })
    expect(decideUsageLimitWait({ ...eligible, resetDelayMs: -5000 })).toEqual({
      type: 'skip',
      reason: 'no-reset-time',
    })
  })

  test('skips: reset-too-far when the parser clamped to the cap', () => {
    expect(decideUsageLimitWait({ ...eligible, resetDelayMs: CAP_MS })).toEqual(
      { type: 'skip', reason: 'reset-too-far' },
    )
    // One millisecond under the cap is still a wait.
    expect(
      decideUsageLimitWait({ ...eligible, resetDelayMs: CAP_MS - 1 }).type,
    ).toBe('wait')
  })
})

describe('isForegroundUsageLimitSource', () => {
  test('allows the REPL main thread and the SDK', () => {
    expect(isForegroundUsageLimitSource('repl_main_thread')).toBe(true)
    expect(isForegroundUsageLimitSource('repl_main_thread:extra')).toBe(true)
    expect(isForegroundUsageLimitSource('sdk')).toBe(true)
  })

  test('rejects teammates, subagents, and undefined', () => {
    expect(isForegroundUsageLimitSource('agent:custom')).toBe(false)
    expect(isForegroundUsageLimitSource('subagent')).toBe(false)
    expect(isForegroundUsageLimitSource(undefined)).toBe(false)
  })

  test('treats an unrecognised source as background', () => {
    expect(isForegroundUsageLimitSource('brand_new_path')).toBe(false)
  })
})
