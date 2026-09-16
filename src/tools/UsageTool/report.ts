import {
  currentAccountUsageKey,
  listAccountUsageSnapshots,
  type AccountUsageSnapshot,
  type RawUtilization,
} from '../../services/claudeAiLimits.js'
import { fetchUtilization, type Utilization } from '../../services/api/usage.js'
import {
  buildCodexUsageRows,
  fetchCodexUsage,
  formatCodexPlanType,
  type CodexUsageData,
} from '../../services/api/codexUsage.js'
import { fetchMiniMaxUsage } from '../../services/api/minimaxUsage/fetch.js'
import { buildMiniMaxUsageRows } from '../../services/api/minimaxUsage/parse.js'
import type { MiniMaxUsageData } from '../../services/api/minimaxUsage/types.js'
import {
  listProviderRateLimitSnapshots,
  type ProviderRateLimitSnapshot,
  type RateLimitHeaderValue,
} from '../../services/api/providerUsageRegistry.js'
import {
  getUsageDescriptor,
  resolveActiveUsageId,
  type ResolvedUsageDescriptor,
} from '../../commands/usage/index.js'
import { getTotalCostUSD, getTotalInputTokens, getTotalOutputTokens } from '../../bootstrap/state.js'
import { getActiveProviderProfile } from '../../utils/providerProfiles.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { accountUsageLabel, readAccounts } from '../../utils/accountSwitch.js'
import {
  formatRelativeTime,
  formatRelativeTimeAgo,
} from '../../utils/format.js'

export type UsageCapability = 'supported' | 'not exposed by provider' | 'unknown'

export type UsageRow =
  | {
      kind: 'window'
      label: string
      usedPercent: number
      resetsAt: string | null
      extraText?: string
      source: 'response headers' | 'live fetch'
    }
  | {
      kind: 'text'
      label: string
      value: string
      source: 'response headers' | 'live fetch'
    }

export type UsageRateLimits = {
  remainingRequests?: RateLimitHeaderValue
  remainingTokens?: RateLimitHeaderValue
  limitRequests?: RateLimitHeaderValue
  limitTokens?: RateLimitHeaderValue
  resetRequests?: string
  resetTokens?: string
}

export type UsageProviderSection = {
  /** Stable id: route/vendor id, `firstParty`, or registry provider key. */
  provider: string
  label: string
  isActive: boolean
  capability: UsageCapability
  rows?: UsageRow[]
  rateLimits?: UsageRateLimits
  /** ISO timestamp of the newest data behind this section. */
  lastUpdated?: string
  planType?: string
  note?: string
}

export type UsageReport = {
  session: {
    inputTokens: number
    outputTokens: number
    costUSD: number
  }
  providers: UsageProviderSection[]
}

type CachedLiveUsage =
  | { kind: 'codex'; data: CodexUsageData; fetchedAt: string }
  | { kind: 'minimax'; data: MiniMaxUsageData; fetchedAt: string }

const liveUsageCache = new Map<string, CachedLiveUsage>()

/**
 * Live first-party fetches, keyed by the account they were fetched FOR:
 * currentAccountUsageKey() read at fetch time, so unattributed API-key traffic
 * lands on the reserved NO_ACCOUNT_USAGE_KEY slot like everywhere else. One
 * slot per account rather than one for the whole process, because a second
 * account's fetch used to overwrite the first's and the user then read one
 * account's figures under every account's name.
 */
const claudeLiveUsageCache = new Map<
  string,
  { data: Utilization; fetchedAt: string }
>()

/** Test-only: drop cached live fetches between cases. */
export function clearUsageReportCache(): void {
  liveUsageCache.clear()
  claudeLiveUsageCache.clear()
}

export type UsageReportFetchers = {
  fetchClaudeUtilization?: () => Promise<Utilization | null>
  fetchCodexUsage?: () => Promise<CodexUsageData>
  fetchMiniMaxUsage?: () => Promise<MiniMaxUsageData>
}

function capabilityFor(descriptor: ResolvedUsageDescriptor): UsageCapability {
  if (descriptor.activeKind === undefined) {
    // No vendor/gateway descriptor resolved: nothing declares an endpoint,
    // but absence of metadata is not a claim that the provider has none.
    return 'unknown'
  }
  return descriptor.supported ? 'supported' : 'not exposed by provider'
}

function hostKeyOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return `host:${new URL(baseUrl).host}`
  } catch {
    return undefined
  }
}

function isoFromEpochSeconds(epoch: number): string {
  return new Date(epoch * 1000).toISOString()
}

/** The rows one account's captured quota headers describe. */
function claudeHeaderRows(raw: RawUtilization): UsageRow[] {
  const rows: UsageRow[] = []
  for (const [key, label] of [
    ['five_hour', '5h window'],
    ['seven_day', '7d window'],
  ] as const) {
    const window = raw[key]
    if (!window) continue
    rows.push({
      kind: 'window',
      label,
      // Header utilization is a 0-1 fraction; convert to percent so all
      // providers share one scale. Unit conversion of a captured value,
      // not a fabricated one.
      usedPercent: Math.round(window.utilization * 1000) / 10,
      resetsAt: isoFromEpochSeconds(window.resets_at),
      source: 'response headers',
    })
  }
  return rows
}

/** What one first-party account has to show, and how old it is. */
type FirstPartyReading = { rows: UsageRow[]; lastUpdated: string }

/**
 * Captured quota headers by account, first capture first.
 *
 * listAccountUsageSnapshots omits an account whose slot exists but has never
 * been written, so every entry here carries a real capturedAt. An entry can
 * still describe no window at all (a response that carried the status header
 * but no utilization), which is why callers go through firstPartyReading.
 */
function accountSnapshots(): Map<string, AccountUsageSnapshot> {
  return new Map(
    listAccountUsageSnapshots().map(
      snapshot => [snapshot.accountUuid, snapshot] as const,
    ),
  )
}

/**
 * What to show for ONE account, or nothing when it has nothing to show.
 *
 * Freshest source wins and every row still carries its own source, exactly as
 * the single-slot version did - the only change is that both sources are now
 * looked up per account. `snapshot` is passed in rather than looked up here so
 * a caller can withhold captured headers (see otherFirstPartySections).
 */
function firstPartyReading(
  accountKey: string,
  snapshot: AccountUsageSnapshot | undefined,
): FirstPartyReading | undefined {
  const live = claudeLiveUsageCache.get(accountKey)
  const headerRows = snapshot ? claudeHeaderRows(snapshot.raw) : []
  const headers =
    headerRows.length > 0 && snapshot
      ? {
          rows: headerRows,
          lastUpdated: new Date(snapshot.capturedAt).toISOString(),
        }
      : undefined
  if (live && (!headers || live.fetchedAt > headers.lastUpdated)) {
    return { rows: claudeLiveRows(live.data), lastUpdated: live.fetchedAt }
  }
  return headers
}

function claudeLiveRows(data: Utilization): UsageRow[] {
  const rows: UsageRow[] = []
  const windowDefs = [
    ['five_hour', '5h window'],
    ['seven_day', '7d window'],
    ['seven_day_opus', '7d Opus window'],
    ['seven_day_sonnet', '7d Sonnet window'],
  ] as const
  for (const [key, label] of windowDefs) {
    const window = data[key]
    if (!window || window.utilization === null) continue
    rows.push({
      kind: 'window',
      label,
      usedPercent: window.utilization,
      resetsAt: window.resets_at,
      source: 'live fetch',
    })
  }
  const extra = data.extra_usage
  if (extra?.is_enabled) {
    rows.push({
      kind: 'text',
      label: 'Extra usage',
      value:
        extra.utilization !== null
          ? `${extra.utilization}% of monthly credits used`
          : 'enabled',
      source: 'live fetch',
    })
  }
  return rows
}

function codexRows(data: CodexUsageData): UsageRow[] {
  return buildCodexUsageRows(data.snapshots).map(row =>
    row.kind === 'window'
      ? {
          kind: 'window' as const,
          label: row.label,
          usedPercent: row.usedPercent,
          resetsAt: row.resetsAt ?? null,
          source: 'live fetch' as const,
        }
      : {
          kind: 'text' as const,
          label: row.label,
          value: row.value,
          source: 'live fetch' as const,
        },
  )
}

function minimaxRows(data: MiniMaxUsageData): UsageRow[] {
  return buildMiniMaxUsageRows(data.snapshots).map(row =>
    row.kind === 'window'
      ? {
          kind: 'window' as const,
          label: row.label,
          usedPercent: row.usedPercent,
          resetsAt: row.resetsAt ?? null,
          extraText: row.extraSubtext,
          source: 'live fetch' as const,
        }
      : {
          kind: 'text' as const,
          label: row.label,
          value: row.value,
          source: 'live fetch' as const,
        },
  )
}

function rateLimitsFromSnapshot(
  snapshot: ProviderRateLimitSnapshot,
): UsageRateLimits {
  return {
    remainingRequests: snapshot.remainingRequests,
    remainingTokens: snapshot.remainingTokens,
    limitRequests: snapshot.limitRequests,
    limitTokens: snapshot.limitTokens,
    resetRequests: snapshot.resetRequests,
    resetTokens: snapshot.resetTokens,
  }
}

function sectionMatchesFilter(
  section: UsageProviderSection,
  filter: string | undefined,
): boolean {
  if (!filter) return true
  const needle = filter.toLowerCase()
  return (
    section.provider.toLowerCase().includes(needle) ||
    section.label.toLowerCase().includes(needle)
  )
}

async function tryFetch<T>(
  fetcher: (() => Promise<T>) | undefined,
  section: UsageProviderSection,
): Promise<T | undefined> {
  if (!fetcher) return undefined
  try {
    return await fetcher()
  } catch (error) {
    section.note = `refresh failed: ${error instanceof Error ? error.message : String(error)}`
    return undefined
  }
}

async function buildActiveSection(options: {
  refresh: boolean
  fetchers: UsageReportFetchers
}): Promise<{
  section: UsageProviderSection
  consumedRegistryKey?: string
  /** Set only when first-party is the active route: the account this section
   *  describes, so buildUsageReport can name it and skip it when listing the
   *  other accounts. */
  firstPartyAccountKey?: string
}> {
  const { refresh, fetchers } = options
  const providerCategory = getAPIProvider()
  const activeProfile = getActiveProviderProfile()
  const activeId = resolveActiveUsageId(process.env, {
    activeProfileProvider: activeProfile?.provider,
    activeProfileBaseUrl: activeProfile?.baseUrl,
    providerCategory,
  })
  const descriptor = getUsageDescriptor(activeId)
  const capability = capabilityFor(descriptor)
  const section: UsageProviderSection = {
    provider: activeId,
    label: descriptor.activeLabel,
    isActive: true,
    capability,
  }

  if (activeId === 'firstParty') {
    // Read BEFORE the fetch is awaited: a switch that lands mid-flight must
    // not file these figures under whichever account happens to be active
    // when the response comes back. Same build-time rule the quota store
    // itself applies - see currentAccountUsageKey.
    const accountKey = currentAccountUsageKey()
    if (refresh) {
      const data = await tryFetch(fetchers.fetchClaudeUtilization, section)
      if (data && Object.keys(data).length > 0) {
        claudeLiveUsageCache.set(accountKey, {
          data,
          fetchedAt: new Date().toISOString(),
        })
      }
    }
    // Freshest source wins; every row carries its source and the section
    // the timestamp of the data actually shown.
    const reading = firstPartyReading(
      accountKey,
      accountSnapshots().get(accountKey),
    )
    if (reading) {
      section.rows = reading.rows
      section.lastUpdated = reading.lastUpdated
    } else {
      section.note =
        'no utilization headers captured yet this session; call with refresh: true to fetch plan usage'
    }
    return { section, firstPartyAccountKey: accountKey }
  }

  if (activeId === 'codex') {
    if (refresh) {
      const data = await tryFetch(fetchers.fetchCodexUsage, section)
      if (data) {
        liveUsageCache.set('codex', {
          kind: 'codex',
          data,
          fetchedAt: new Date().toISOString(),
        })
      }
    }
    const cached = liveUsageCache.get('codex')
    if (cached?.kind === 'codex') {
      section.rows = codexRows(cached.data)
      section.lastUpdated = cached.fetchedAt
      section.planType = formatCodexPlanType(cached.data.planType)
    } else if (!section.note) {
      section.note = 'no cached Codex usage yet; call with refresh: true to fetch it'
    }
    return { section }
  }

  if (activeId === 'minimax') {
    if (refresh) {
      const data = await tryFetch(fetchers.fetchMiniMaxUsage, section)
      if (data) {
        liveUsageCache.set('minimax', {
          kind: 'minimax',
          data,
          fetchedAt: new Date().toISOString(),
        })
      }
    }
    const cached = liveUsageCache.get('minimax')
    if (cached?.kind === 'minimax') {
      section.rows = minimaxRows(cached.data)
      section.lastUpdated = cached.fetchedAt
      section.planType = cached.data.planType
      if (cached.data.availability === 'unknown') {
        section.note = cached.data.message
      }
    } else if (!section.note) {
      section.note = 'no cached MiniMax usage yet; call with refresh: true to fetch it'
    }
    return { section }
  }

  // Generic OpenAI-compatible provider: the only passive source is the
  // x-ratelimit-* header registry. Match the active route id or base URL host.
  const candidateKeys = [
    activeId,
    hostKeyOf(activeProfile?.baseUrl),
    hostKeyOf(process.env.OPENAI_BASE_URL),
    hostKeyOf(process.env.OPENAI_API_BASE),
  ].filter((key): key is string => Boolean(key))
  const snapshot = candidateKeys
    .map(key => listProviderRateLimitSnapshots().find(s => s.providerKey === key))
    .find(matched => matched !== undefined)
  if (snapshot) {
    section.rateLimits = rateLimitsFromSnapshot(snapshot)
    section.lastUpdated = snapshot.capturedAt
    section.note = 'values captured from x-ratelimit-* response headers'
    return { section, consumedRegistryKey: snapshot.providerKey }
  }
  section.note =
    capability === 'not exposed by provider'
      ? 'vendor declares no usage endpoint and sent no rate-limit headers'
      : 'no rate-limit headers captured yet this session'
  return { section }
}

/**
 * Cached live usage for a provider that is not the active one. First-party
 * lives in otherFirstPartySections instead, because it is keyed by account.
 */
function cachedLiveSections(excludeProvider: string): UsageProviderSection[] {
  const sections: UsageProviderSection[] = []
  const codex = liveUsageCache.get('codex')
  if (codex?.kind === 'codex' && excludeProvider !== 'codex') {
    sections.push({
      provider: 'codex',
      label: 'Codex',
      isActive: false,
      capability: 'supported',
      rows: codexRows(codex.data),
      lastUpdated: codex.fetchedAt,
      planType: formatCodexPlanType(codex.data.planType),
    })
  }
  const minimax = liveUsageCache.get('minimax')
  if (minimax?.kind === 'minimax' && excludeProvider !== 'minimax') {
    sections.push({
      provider: 'minimax',
      label: 'MiniMax',
      isActive: false,
      capability: 'supported',
      rows: minimaxRows(minimax.data),
      lastUpdated: minimax.fetchedAt,
      planType: minimax.data.planType,
      ...(minimax.data.availability === 'unknown'
        ? { note: minimax.data.message }
        : {}),
    })
  }
  return sections
}

/**
 * Label every first-party section starts from. Matches both the anthropic
 * vendor descriptor's label and RUNTIME_USAGE_LABELS.firstParty, which is
 * what the one cached first-party section printed before this change.
 */
const FIRST_PARTY_LABEL = 'Anthropic'

/** A first-party section together with the account it describes. */
type FirstPartySection = {
  section: UsageProviderSection
  accountKey: string
}

/**
 * What this file needs in order to NAME an account.
 *
 * Deliberately narrower than AccountSummary: emailAddress is not on it, so a
 * future writer who reaches for the address in this file gets a type error
 * instead of putting a personal identifier into a transcript.
 */
type NameableAccount = { key: string; label?: string; isActive: boolean }

/**
 * Stored accounts by key, for naming only.
 *
 * Read lazily - only a report with more than one first-party account to name
 * calls this, so a single-account session still touches no credential store -
 * and defensively: Usage must not fail because that store is locked or
 * unreadable, so an account that cannot be looked up is still named, by its
 * key.
 */
function storedAccountsByKey(): Map<string, NameableAccount> {
  try {
    return new Map(
      readAccounts().map(account => [account.key, account] as const),
    )
  } catch {
    return new Map()
  }
}

/**
 * A section per first-party account OTHER than the one the active section
 * already describes.
 *
 * includeHeaderCaptures is false when first-party is not the active route,
 * where only a live fetch ever produced a non-active first-party section:
 * keeping that gate is what makes a one-account session render exactly what
 * it rendered before the report grew an account dimension. An account with
 * nothing to show gets no section - the report never invents one.
 */
function otherFirstPartySections(options: {
  activeAccountKey: string | undefined
  includeHeaderCaptures: boolean
}): FirstPartySection[] {
  const { activeAccountKey, includeHeaderCaptures } = options
  const snapshots = accountSnapshots()
  const accountKeys = new Set<string>()
  if (includeHeaderCaptures) {
    for (const accountKey of snapshots.keys()) accountKeys.add(accountKey)
  }
  for (const accountKey of claudeLiveUsageCache.keys()) {
    accountKeys.add(accountKey)
  }

  const sections: FirstPartySection[] = []
  for (const accountKey of accountKeys) {
    if (accountKey === activeAccountKey) continue
    const reading = firstPartyReading(
      accountKey,
      includeHeaderCaptures ? snapshots.get(accountKey) : undefined,
    )
    if (!reading) continue
    sections.push({
      accountKey,
      section: {
        provider: 'firstParty',
        label: FIRST_PARTY_LABEL,
        isActive: false,
        capability: 'supported',
        rows: reading.rows,
        lastUpdated: reading.lastUpdated,
      },
    })
  }
  return sections
}

/**
 * Name the account on each first-party section - but only once more than one
 * of them has figures.
 *
 * A single-account session, and every API-key session, therefore renders the
 * section header it has always rendered: the account name appears exactly when
 * it starts carrying information, which is when a second account has figures
 * of its own to tell apart.
 *
 * accountUsageLabel is the PII-safe naming (never the email address, unlike
 * accountDisplayName, which names accounts on the user's own screen). Being
 * per-account and pure it cannot promise that two accounts get two different
 * names - two UUIDs sharing their first block resolve to one string - so
 * duplicates are numbered here, where the whole list is in hand, rather than
 * by feeding more key material into the name.
 */
function nameFirstPartyAccounts(sections: FirstPartySection[]): void {
  if (sections.length < 2) return
  const stored = storedAccountsByKey()
  const names = sections.map(entry =>
    accountUsageLabel(
      stored.get(entry.accountKey) ?? {
        key: entry.accountKey,
        isActive: false,
      },
    ),
  )
  const totals = new Map<string, number>()
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1)
  const numbered = new Map<string, number>()
  sections.forEach((entry, index) => {
    const name = names[index]
    let display = name
    if ((totals.get(name) ?? 0) > 1) {
      const ordinal = (numbered.get(name) ?? 0) + 1
      numbered.set(name, ordinal)
      display = `${name} #${ordinal}`
    }
    entry.section.label = `${entry.section.label} (${display})`
  })
}

export async function buildUsageReport(options: {
  providerFilter?: string
  refresh?: boolean
  fetchers?: UsageReportFetchers
} = {}): Promise<UsageReport> {
  const fetchers: UsageReportFetchers = {
    fetchClaudeUtilization: fetchUtilization,
    fetchCodexUsage,
    fetchMiniMaxUsage,
    ...options.fetchers,
  }

  const {
    section: activeSection,
    consumedRegistryKey,
    firstPartyAccountKey,
  } = await buildActiveSection({
    refresh: options.refresh === true,
    fetchers,
  })

  const firstPartyIsActive = firstPartyAccountKey !== undefined
  const otherAccounts = otherFirstPartySections({
    activeAccountKey: firstPartyAccountKey,
    includeHeaderCaptures: firstPartyIsActive,
  })
  nameFirstPartyAccounts([
    ...(firstPartyAccountKey !== undefined
      ? [{ section: activeSection, accountKey: firstPartyAccountKey }]
      : []),
    ...otherAccounts,
  ])
  const otherAccountSections = otherAccounts.map(entry => entry.section)

  const registrySections: UsageProviderSection[] = listProviderRateLimitSnapshots()
    .filter(snapshot => snapshot.providerKey !== consumedRegistryKey)
    .map(snapshot => ({
      provider: snapshot.providerKey,
      label: snapshot.providerLabel,
      isActive: false,
      capability: 'unknown',
      rateLimits: rateLimitsFromSnapshot(snapshot),
      lastUpdated: snapshot.capturedAt,
      note: 'values captured from x-ratelimit-* response headers',
    }))

  const providers = [
    activeSection,
    // Beside the active first-party section when first-party is the active
    // route, and otherwise in the slot the one cached first-party section
    // used to occupy (after the registry), so a one-account report keeps its
    // ordering under either route.
    ...(firstPartyIsActive ? otherAccountSections : []),
    ...registrySections,
    ...(firstPartyIsActive ? [] : otherAccountSections),
    ...cachedLiveSections(activeSection.provider),
  ].filter(section => sectionMatchesFilter(section, options.providerFilter))

  return {
    session: {
      inputTokens: getTotalInputTokens(),
      outputTokens: getTotalOutputTokens(),
      costUSD: getTotalCostUSD(),
    },
    providers,
  }
}

function formatStamp(iso: string): string {
  return `${iso} (${formatRelativeTimeAgo(new Date(iso))})`
}

function formatRateLimitValue(
  value: RateLimitHeaderValue | undefined,
  total?: RateLimitHeaderValue,
): string | undefined {
  if (value === undefined) return undefined
  return total !== undefined ? `${value}/${total}` : String(value)
}

export function renderUsageReport(report: UsageReport): string {
  const lines: string[] = []
  const session = report.session
  lines.push(
    `Session: ${session.inputTokens.toLocaleString('en-US')} input tokens, ${session.outputTokens.toLocaleString('en-US')} output tokens, $${session.costUSD.toFixed(2)}`,
  )

  for (const section of report.providers) {
    lines.push('')
    const active = section.isActive ? ' — active' : ''
    lines.push(`${section.label} (${section.provider})${active} — ${section.capability}`)
    if (section.planType) {
      lines.push(`  plan: ${section.planType}`)
    }
    for (const row of section.rows ?? []) {
      if (row.kind === 'window') {
        const reset = row.resetsAt
          ? `, resets ${row.resetsAt} (${formatRelativeTime(new Date(row.resetsAt))})`
          : ', resets unknown'
        const extra = row.extraText ? ` (${row.extraText})` : ''
        lines.push(`  ${row.label}: ${row.usedPercent}% used${reset}${extra} [${row.source}]`)
      } else {
        lines.push(`  ${row.label}: ${row.value} [${row.source}]`)
      }
    }
    const rateLimits = section.rateLimits
    if (rateLimits) {
      const parts: string[] = []
      const requests = formatRateLimitValue(
        rateLimits.remainingRequests,
        rateLimits.limitRequests,
      )
      if (requests) parts.push(`requests ${requests}`)
      const tokens = formatRateLimitValue(
        rateLimits.remainingTokens,
        rateLimits.limitTokens,
      )
      if (tokens) parts.push(`tokens ${tokens}`)
      if (rateLimits.resetRequests) {
        parts.push(`requests reset in ${rateLimits.resetRequests}`)
      }
      if (rateLimits.resetTokens) {
        parts.push(`tokens reset in ${rateLimits.resetTokens}`)
      }
      if (parts.length > 0) lines.push(`  remaining: ${parts.join(', ')}`)
    }
    const hasData =
      (section.rows ?? []).length > 0 ||
      section.rateLimits !== undefined ||
      Boolean(section.planType)
    if (!hasData) {
      lines.push(
        section.capability === 'not exposed by provider'
          ? '  not exposed by provider'
          : '  unknown',
      )
    }
    if (section.lastUpdated) {
      lines.push(`  last updated: ${formatStamp(section.lastUpdated)}`)
    }
    if (section.note) {
      lines.push(`  ${section.note}`)
    }
  }

  return lines.join('\n')
}
