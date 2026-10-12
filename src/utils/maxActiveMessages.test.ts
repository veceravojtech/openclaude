import { afterEach, expect, test } from 'bun:test'

import {
  getMaxActiveMessagesHardCap,
  isAboveMaxActiveMessagesLimit,
  resolveMaxActiveMessagesLimit,
  scaleActiveMessageLimitToContextWindow,
  shouldCompactActiveMessageHistory,
} from './maxActiveMessages.js'

const SAVED_ENV = {
  OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP:
    process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP,
}

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('invalid hard cap override falls back to the default safety cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '100O'

  expect(getMaxActiveMessagesHardCap()).toBe(1000)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(true)
})

test('explicit zero hard cap disables only the hard cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'

  expect(getMaxActiveMessagesHardCap()).toBe(0)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(false)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(resolveMaxActiveMessagesLimit('off', '5')).toBe(5)
  expect(resolveMaxActiveMessagesLimit(undefined, '5')).toBe(5)
})

test('configured and hard cap combine by choosing the tighter positive limit', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '500'

  expect(resolveMaxActiveMessagesLimit('1000', undefined)).toBe(500)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(isAboveMaxActiveMessagesLimit(501)).toBe(true)
  expect(isAboveMaxActiveMessagesLimit(500)).toBe(false)
})

test('teammate transcript compaction triggers on message count before token pressure', () => {
  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1001,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(true)

  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1000,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(false)
})

test('a built-in message limit scales with the model context window', () => {
  // Used for the hard cap: tuned for a 200k window (#1949), proportionally
  // larger above it.
  expect(scaleActiveMessageLimitToContextWindow(1000, 1_000_000)).toBe(5000)
  expect(scaleActiveMessageLimitToContextWindow(1000, 200_000)).toBe(1000)
  expect(scaleActiveMessageLimitToContextWindow(1000, 128_000)).toBe(1000)
  expect(scaleActiveMessageLimitToContextWindow(1000, undefined)).toBe(1000)
  expect(scaleActiveMessageLimitToContextWindow(1000, Infinity)).toBe(1000)
  // A disabled limit stays disabled.
  expect(scaleActiveMessageLimitToContextWindow(0, 1_000_000)).toBe(0)
})

test('above a 200k window the implicit default yields to the hard cap', () => {
  // Regression: the 200-message default scaled linearly to 1000 on a 1M
  // window, and 1000 transcript records (~400 tokens each) force-compacted a
  // [1m] session at ~400k tokens.
  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      contextWindow: 1_000_000,
      implicitDefault: true,
    }),
  ).toBe(5000)
  // Any window above the baseline, not just 1M.
  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      contextWindow: 272_000,
      implicitDefault: true,
    }),
  ).toBe(1360)
  // 'off' leaves only the hard cap, as before.
  expect(
    resolveMaxActiveMessagesLimit('off', undefined, {
      contextWindow: 1_000_000,
      implicitDefault: true,
    }),
  ).toBe(5000)
})

test('the implicit default still applies at or below a 200k window', () => {
  for (const contextWindow of [200_000, 128_000, undefined]) {
    expect(
      resolveMaxActiveMessagesLimit('200', undefined, {
        contextWindow,
        implicitDefault: true,
      }),
    ).toBe(200)
  }
})

test('a chosen message limit is honored as written on every window', () => {
  // The user picked '200' or '1000' in /config: no window changes it.
  for (const limit of ['200', '1000'] as const) {
    expect(
      resolveMaxActiveMessagesLimit(limit, undefined, {
        contextWindow: 1_000_000,
      }),
    ).toBe(Number(limit))
  }
  // Legacy env override, with the setting unset.
  expect(
    resolveMaxActiveMessagesLimit(undefined, '300', {
      contextWindow: 1_000_000,
    }),
  ).toBe(300)
})

test('a disabled hard cap leaves no count limit for the implicit default on a large window', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'

  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      contextWindow: 1_000_000,
      implicitDefault: true,
    }),
  ).toBe(0)
  // At the baseline the default still applies.
  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      contextWindow: 200_000,
      implicitDefault: true,
    }),
  ).toBe(200)
})

test('the hard cap scales with the window unless it is set explicitly', () => {
  expect(getMaxActiveMessagesHardCap({}, 1_000_000)).toBe(5000)
  expect(getMaxActiveMessagesHardCap({}, 200_000)).toBe(1000)
  expect(getMaxActiveMessagesHardCap({})).toBe(1000)

  expect(
    getMaxActiveMessagesHardCap(
      { OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '300' },
      1_000_000,
    ),
  ).toBe(300)
  expect(
    getMaxActiveMessagesHardCap(
      { OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '0' },
      1_000_000,
    ),
  ).toBe(0)
})
