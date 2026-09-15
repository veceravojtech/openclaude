import { beforeEach, expect, test } from 'bun:test'
import {
  captureRateLimitHeaders,
  clearProviderUsageRegistry,
  getProviderRateLimitSnapshot,
  listProviderRateLimitSnapshots,
} from './providerUsageRegistry.js'

const FIXED_NOW = new Date('2026-09-15T10:00:00Z').getTime()

beforeEach(() => {
  clearProviderUsageRegistry()
})

test('captures every x-ratelimit field with a capturedAt stamp', () => {
  captureRateLimitHeaders({
    providerKey: 'zai',
    providerLabel: 'Z.ai',
    model: 'glm-5.3',
    baseUrl: 'https://api.z.ai/v1',
    headers: new Headers({
      'x-ratelimit-remaining-requests': '118',
      'x-ratelimit-remaining-tokens': '89999',
      'x-ratelimit-limit-requests': '120',
      'x-ratelimit-limit-tokens': '100000',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-reset-tokens': '1h0m0s',
    }),
    now: () => FIXED_NOW,
  })

  const snapshot = getProviderRateLimitSnapshot('zai')
  expect(snapshot).toBeDefined()
  expect(snapshot?.remainingRequests).toBe(118)
  expect(snapshot?.remainingTokens).toBe(89999)
  expect(snapshot?.limitRequests).toBe(120)
  expect(snapshot?.limitTokens).toBe(100000)
  expect(snapshot?.resetRequests).toBe('6m0s')
  expect(snapshot?.resetTokens).toBe('1h0m0s')
  expect(snapshot?.providerLabel).toBe('Z.ai')
  expect(snapshot?.model).toBe('glm-5.3')
  expect(snapshot?.capturedAt).toBe('2026-09-15T10:00:00.000Z')
})

test('malformed and absent headers never throw or create phantom data', () => {
  expect(() =>
    captureRateLimitHeaders({
      providerKey: 'malformed',
      headers: new Headers({
        'x-ratelimit-remaining-requests': 'not-a-number',
        'x-ratelimit-remaining-tokens': '   ',
        'x-ratelimit-limit-requests': '12.5',
      }),
      now: () => FIXED_NOW,
    }),
  ).not.toThrow()

  const snapshot = getProviderRateLimitSnapshot('malformed')
  // The unparseable value is kept as the raw string; nothing is coerced.
  expect(snapshot?.remainingRequests).toBe('not-a-number')
  // A blank value is treated as absent, not as phantom data.
  expect(snapshot?.remainingTokens).toBeUndefined()
  expect(snapshot?.resetRequests).toBeUndefined()

  expect(() =>
    captureRateLimitHeaders({
      providerKey: 'absent',
      headers: new Headers({ 'content-type': 'application/json' }),
      now: () => FIXED_NOW,
    }),
  ).not.toThrow()
  // A provider that sends none of the headers leaves no empty entry behind.
  expect(getProviderRateLimitSnapshot('absent')).toBeUndefined()
  expect(listProviderRateLimitSnapshots().length).toBe(1)
})

test('per-provider keying does not cross-contaminate', () => {
  captureRateLimitHeaders({
    providerKey: 'zai',
    headers: new Headers({ 'x-ratelimit-remaining-requests': '5' }),
    now: () => FIXED_NOW,
  })
  captureRateLimitHeaders({
    providerKey: 'host:api.example.com',
    headers: new Headers({ 'x-ratelimit-remaining-requests': '50' }),
    now: () => FIXED_NOW,
  })

  expect(getProviderRateLimitSnapshot('zai')?.remainingRequests).toBe(5)
  expect(getProviderRateLimitSnapshot('host:api.example.com')?.remainingRequests).toBe(50)
  expect(listProviderRateLimitSnapshots().length).toBe(2)
})

test('a header-less response does not erase previously captured values', () => {
  captureRateLimitHeaders({
    providerKey: 'zai',
    headers: new Headers({ 'x-ratelimit-remaining-requests': '118' }),
    now: () => FIXED_NOW,
  })

  captureRateLimitHeaders({
    providerKey: 'zai',
    headers: new Headers({ 'content-type': 'application/json' }),
    now: () => FIXED_NOW + 60_000,
  })

  const snapshot = getProviderRateLimitSnapshot('zai')
  expect(snapshot?.remainingRequests).toBe(118)
  // Staleness is conveyed by capturedAt, which the empty capture leaves alone.
  expect(snapshot?.capturedAt).toBe('2026-09-15T10:00:00.000Z')
})

test('non-integer sentinels are kept as raw strings', () => {
  captureRateLimitHeaders({
    providerKey: 'openrouter',
    headers: new Headers({
      'x-ratelimit-remaining-requests': 'Infinity',
    }),
    now: () => FIXED_NOW,
  })

  expect(getProviderRateLimitSnapshot('openrouter')?.remainingRequests).toBe(
    'Infinity',
  )
})
