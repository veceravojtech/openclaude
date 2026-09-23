import { afterEach, describe, expect, test } from 'bun:test'
import { currentAccountUsageKey } from '../../claudeAiLimits.js'
import {
  claudeLiveUsageCache,
  clearLiveUsageCache,
  liveUsageCache,
} from '../liveUsageCache.js'
import {
  captureRateLimitHeaders,
  clearProviderUsageRegistry,
} from '../providerUsageRegistry.js'
import { formatRouteUsage, readRouteUsage } from './routeUsage.js'

afterEach(() => {
  clearLiveUsageCache()
  clearProviderUsageRegistry()
})

describe('readRouteUsage', () => {
  test('a route with nothing captured is unknown', () => {
    expect(readRouteUsage('zai')).toEqual({ route: 'zai', level: 'unknown' })
    expect(readRouteUsage('codex').level).toBe('unknown')
    expect(formatRouteUsage(readRouteUsage('deepseek'))).toBe('deepseek unknown')
  })

  test('codex: the highest cached plan window, as a 0..1 fraction', () => {
    liveUsageCache.set('codex', {
      kind: 'codex',
      fetchedAt: new Date().toISOString(),
      data: {
        planType: 'plus',
        snapshots: [
          {
            limitName: 'codex',
            primary: { usedPercent: 12, windowMinutes: 300 },
            secondary: { usedPercent: 67, windowMinutes: 10080 },
          },
        ],
      },
    })
    const usage = readRouteUsage('codex')
    expect(usage).toEqual({ route: 'codex', level: 0.67, window: '7d', source: 'cached fetch' })
    expect(formatRouteUsage(usage)).toBe('codex at 67% (7d)')
  })

  test('anthropic: the cached plan fetch for the active account, in percent', () => {
    claudeLiveUsageCache.set(currentAccountUsageKey(), {
      fetchedAt: new Date().toISOString(),
      data: {
        five_hour: { utilization: 20, resets_at: null },
        seven_day: { utilization: 92, resets_at: null },
      },
    })
    const usage = readRouteUsage('anthropic')
    expect(usage.level).toBe(0.92)
    expect(usage.window).toBe('7d')
    expect(formatRouteUsage(usage)).toBe('anthropic at 92% (7d)')
  })

  test('other routes: x-ratelimit headers, utilization = 1 - remaining/limit', () => {
    captureRateLimitHeaders({
      providerKey: 'deepseek',
      headers: new Headers({
        'x-ratelimit-remaining-requests': '10',
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-tokens': 'Infinity',
      }),
    })
    expect(readRouteUsage('deepseek')).toEqual({ route: 'deepseek', level: 0.9, window: 'requests', source: 'headers' })
    captureRateLimitHeaders({
      providerKey: 'zai',
      headers: new Headers({ 'x-ratelimit-reset-requests': '6m0s' }),
    })
    expect(readRouteUsage('zai').level).toBe('unknown')
  })
})
