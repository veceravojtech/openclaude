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

test('the default message limit scales with the model context window', () => {
  // The 200-message default was tuned for a 200k window (#1949). A 1M model
  // must not be compacted at a fifth of its budget.
  expect(scaleActiveMessageLimitToContextWindow(200, 1_000_000)).toBe(1000)
  expect(scaleActiveMessageLimitToContextWindow(200, 200_000)).toBe(200)
  expect(scaleActiveMessageLimitToContextWindow(200, 128_000)).toBe(200)
  expect(scaleActiveMessageLimitToContextWindow(200, undefined)).toBe(200)
  // A disabled limit stays disabled.
  expect(scaleActiveMessageLimitToContextWindow(0, 1_000_000)).toBe(0)
})

test('scaling applies to the implicit default only, never to a chosen value', () => {
  const oneM = { contextWindow: 1_000_000 }

  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      ...oneM,
      scaleDefault: true,
    }),
  ).toBe(1000)
  // Same '200', but the user picked it in /config: honored as written.
  expect(resolveMaxActiveMessagesLimit('200', undefined, oneM)).toBe(200)
  // 'off' leaves only the hard cap, which scales with the window.
  expect(
    resolveMaxActiveMessagesLimit('off', undefined, {
      ...oneM,
      scaleDefault: true,
    }),
  ).toBe(5000)
  // A 200k model is unchanged by either path.
  expect(
    resolveMaxActiveMessagesLimit('200', undefined, {
      contextWindow: 200_000,
      scaleDefault: true,
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
