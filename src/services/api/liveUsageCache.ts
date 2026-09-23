/**
 * Process-wide cache of the plan-usage figures a Usage tool `refresh: true`
 * fetched. Written only by the Usage report (src/tools/UsageTool/report.ts),
 * read by it and by the teammate dispatcher's route-usage reader
 * (smartRouting/routeUsage.ts). Nothing here fetches.
 */
import type { CodexUsageData } from './codexUsage.js'
import type { MiniMaxUsageData } from './minimaxUsage/types.js'
import type { Utilization } from './usage.js'

export type CachedLiveUsage =
  | { kind: 'codex'; data: CodexUsageData; fetchedAt: string }
  | { kind: 'minimax'; data: MiniMaxUsageData; fetchedAt: string }

/** Live fetches for providers that are not keyed by account. */
export const liveUsageCache = new Map<string, CachedLiveUsage>()

/**
 * Live first-party fetches, keyed by the account they were fetched FOR:
 * currentAccountUsageKey() read at fetch time, so unattributed API-key traffic
 * lands on the reserved NO_ACCOUNT_USAGE_KEY slot like everywhere else. One
 * slot per account rather than one for the whole process, because a second
 * account's fetch used to overwrite the first's and the user then read one
 * account's figures under every account's name.
 */
export const claudeLiveUsageCache = new Map<
  string,
  { data: Utilization; fetchedAt: string }
>()

/** Test-only: drop cached live fetches between cases. */
export function clearLiveUsageCache(): void {
  liveUsageCache.clear()
  claudeLiveUsageCache.clear()
}

/** The Codex plan usage the last refresh fetched, if any. Passive. */
export function getCachedCodexUsage():
  | { data: CodexUsageData; fetchedAt: string }
  | undefined {
  const cached = liveUsageCache.get('codex')
  return cached?.kind === 'codex'
    ? { data: cached.data, fetchedAt: cached.fetchedAt }
    : undefined
}

/** The first-party plan usage the last refresh fetched FOR this account, if any. Passive. */
export function getCachedClaudeUtilization(
  accountKey: string,
): { data: Utilization; fetchedAt: string } | undefined {
  return claudeLiveUsageCache.get(accountKey)
}
