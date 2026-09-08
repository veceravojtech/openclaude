import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { isBilledAsExtraUsage } from './extraUsage.js'

// Capture the genuine auth module through a query-suffixed specifier: a plain
// `import * as realAuth from './auth.js'` binds the LIVE namespace, which
// `mock.module()` mutates in place, so re-registering it in the teardown
// re-installs the stub instead of restoring the real module.
// Precedent: src/utils/auth.test.ts:8-10.
const realAuth = (await import(
  `./auth.js?extraUsageTestRealAuth=${Date.now()}-${Math.random()}`
)) as typeof import('./auth.js')

beforeEach(async () => {
  await acquireSharedMutationLock('utils/extraUsage.test.ts')
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  mock.module('./auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => true,
  }))
})

afterEach(() => {
  try {
    // Re-register the genuine module BEFORE mock.restore(): Bun's
    // `mock.restore()` never unregisters a `mock.module()` registration, so an
    // un-restored stub here would pin `isClaudeAISubscriber` to `true` for the
    // rest of the runner process.
    mock.module('./auth.js', () => ({ ...realAuth }))
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

// Regression for #1769: the default Opus is now 4.8 (4.7 is the 3P default), so
// the extra-usage label must cover opus-4-8/4-7 1M variants, not just 4.6.
test('1M Opus 4.8/4.7 variants are billed as extra usage', () => {
  expect(isBilledAsExtraUsage('claude-opus-4-8[1m]', false, false)).toBe(true)
  expect(isBilledAsExtraUsage('claude-opus-4-7[1m]', false, false)).toBe(true)
  expect(isBilledAsExtraUsage('opus[1m]', false, false)).toBe(true)
  expect(isBilledAsExtraUsage('claude-opus-4-6[1m]', false, false)).toBe(true)
})

test('1M Opus is not billed as extra when the Opus 1M merge is enabled', () => {
  expect(isBilledAsExtraUsage('claude-opus-4-8[1m]', false, true)).toBe(false)
  expect(isBilledAsExtraUsage('claude-opus-4-7[1m]', false, true)).toBe(false)
  expect(isBilledAsExtraUsage('opus[1m]', false, true)).toBe(false)
})

test('non-1M models are not billed as extra usage', () => {
  expect(isBilledAsExtraUsage('claude-opus-4-8', false, false)).toBe(false)
})
