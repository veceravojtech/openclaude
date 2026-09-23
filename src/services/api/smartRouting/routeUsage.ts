/**
 * Usage level per provider route for the teammate dispatcher.
 *
 * Passive only: every figure here was already captured by the process
 * (response headers) or cached by an earlier Usage tool `refresh`. Nothing
 * in this module reaches the network. The sources are the same ones the
 * Usage tool reports from (src/tools/UsageTool/report.ts; the refresh
 * caches live in services/api/liveUsageCache.ts):
 *
 *   anthropic      anthropic-ratelimit-unified-{5h,7d} headers of the ACTIVE
 *                  account (claudeAiLimits.getRawUtilization), or the live
 *                  plan fetch cached for that account when it is fresher.
 *   codex          the Codex plan windows cached by the last Usage refresh.
 *   anything else  x-ratelimit-{remaining,limit}-{requests,tokens} headers
 *                  in providerUsageRegistry, keyed by route id
 *                  (utilization = 1 - remaining/limit).
 *
 * A route with nothing captured is `unknown`; the dispatcher treats that as
 * low. Z.AI and DeepSeek coding plans send no usable headers, so they are
 * normally unknown.
 */
import {
  currentAccountUsageKey,
  getRawUtilization,
  getRawUtilizationCapturedAt,
} from '../../claudeAiLimits.js'
import { getProviderRateLimitSnapshot } from '../providerUsageRegistry.js'
import type { RateLimitHeaderValue } from '../providerUsageRegistry.js'
import {
  getCachedClaudeUtilization,
  getCachedCodexUsage,
} from '../liveUsageCache.js'

export type RouteUsageLevel = {
  route: string
  /** Highest utilization across the route's windows, 0..1; 'unknown' when nothing was captured. */
  level: number | 'unknown'
  /** The window that carries the highest utilization, e.g. `7d`, `5h`, `weekly`, `requests`. */
  window?: string
  /** Where the figure came from. */
  source?: 'headers' | 'cached fetch'
}

type Reading = { level: number; window: string; at: number; source: RouteUsageLevel['source'] }

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function anthropicUsage(): Reading | undefined {
  let best: Reading | undefined
  const capturedAt = getRawUtilizationCapturedAt()
  if (capturedAt !== undefined) {
    const raw = getRawUtilization()
    for (const [key, label] of [
      ['five_hour', '5h'],
      ['seven_day', '7d'],
    ] as const) {
      const window = raw[key]
      if (!window || typeof window.utilization !== 'number') continue
      const level = clamp01(window.utilization)
      if (!best || level > best.level) best = { level, window: label, at: capturedAt, source: 'headers' }
    }
  }
  const live = getCachedClaudeUtilization(currentAccountUsageKey())
  if (live) {
    const at = Date.parse(live.fetchedAt)
    if (!best || (Number.isFinite(at) && at > best.at)) {
      let liveBest: Reading | undefined
      for (const [key, label] of [
        ['five_hour', '5h'],
        ['seven_day', '7d'],
        ['seven_day_opus', '7d opus'],
        ['seven_day_sonnet', '7d sonnet'],
      ] as const) {
        const window = live.data[key]
        if (!window || typeof window.utilization !== 'number') continue
        const level = clamp01(window.utilization / 100)
        if (!liveBest || level > liveBest.level) liveBest = { level, window: label, at, source: 'cached fetch' }
      }
      if (liveBest) best = liveBest
    }
  }
  return best
}

function codexUsage(): Reading | undefined {
  const cached = getCachedCodexUsage()
  if (!cached) return undefined
  const at = Date.parse(cached.fetchedAt)
  let best: Reading | undefined
  for (const snapshot of cached.data.snapshots) {
    for (const [key, window] of [
      ['primary', snapshot.primary],
      ['secondary', snapshot.secondary],
    ] as const) {
      if (!window || typeof window.usedPercent !== 'number') continue
      const level = clamp01(window.usedPercent / 100)
      const minutes = window.windowMinutes
      const label =
        minutes === undefined
          ? key
          : minutes >= 24 * 60
            ? `${Math.round(minutes / (24 * 60))}d`
            : `${Math.round(minutes / 60)}h`
      if (!best || level > best.level) best = { level, window: label, at, source: 'cached fetch' }
    }
  }
  return best
}

function ratio(remaining: RateLimitHeaderValue | undefined, limit: RateLimitHeaderValue | undefined): number | undefined {
  if (typeof remaining !== 'number' || typeof limit !== 'number' || limit <= 0) return undefined
  return clamp01(1 - remaining / limit)
}

function registryUsage(route: string): Reading | undefined {
  const snapshot = getProviderRateLimitSnapshot(route)
  if (!snapshot) return undefined
  const at = Date.parse(snapshot.capturedAt)
  let best: Reading | undefined
  for (const [label, level] of [
    ['requests', ratio(snapshot.remainingRequests, snapshot.limitRequests)],
    ['tokens', ratio(snapshot.remainingTokens, snapshot.limitTokens)],
  ] as const) {
    if (level === undefined) continue
    if (!best || level > best.level) best = { level, window: label, at, source: 'headers' }
  }
  return best
}

/**
 * The usage level of one route. Never throws; a reader that fails yields
 * `unknown`.
 */
export function readRouteUsage(route: string): RouteUsageLevel {
  let reading: Reading | undefined
  try {
    reading =
      route === 'anthropic' ? anthropicUsage()
      : route === 'codex' ? codexUsage()
      : registryUsage(route)
  } catch {
    reading = undefined
  }
  if (!reading) return { route, level: 'unknown' }
  return { route, level: reading.level, window: reading.window, source: reading.source }
}

/** `anthropic at 92% (7d)` / `zai unknown`. */
export function formatRouteUsage(usage: RouteUsageLevel): string {
  if (usage.level === 'unknown') return `${usage.route} unknown`
  return `${usage.route} at ${Math.round(usage.level * 100)}%${usage.window ? ` (${usage.window})` : ''}`
}
