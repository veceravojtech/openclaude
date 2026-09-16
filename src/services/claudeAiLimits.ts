import { APIError } from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getOauthAccountInfo, isClaudeAISubscriber } from '../utils/auth.js'
import { getModelBetas } from '../utils/betas.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from './analytics/index.js'
import { logEvent } from './analytics/index.js'
import { getAPIMetadata } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rateLimitMocking.js'

// Re-export message functions from centralized location
export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
} from './rateLimitMessages.js'

type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type { RateLimitType }

type EarlyWarningThreshold = {
  utilization: number // 0-1 scale: trigger warning when usage >= this
  timePct: number // 0-1 scale: trigger warning when time elapsed <= this
}

type EarlyWarningConfig = {
  rateLimitType: RateLimitType
  claimAbbrev: '5h' | '7d'
  windowSeconds: number
  thresholds: EarlyWarningThreshold[]
}

// Early warning configurations in priority order (checked first to last)
// Used as fallback when server doesn't send surpassed-threshold header
// Warns users when they're consuming quota faster than the time window allows
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]

// Maps claim abbreviations to rate limit types for header-based detection
const EARLY_WARNING_CLAIM_MAP: Record<string, RateLimitType> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
  overage: 'overage',
}

const RATE_LIMIT_DISPLAY_NAMES: Record<RateLimitType, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  overage: 'extra usage limit',
}

export function getRateLimitDisplayName(type: RateLimitType): string {
  return RATE_LIMIT_DISPLAY_NAMES[type] || type
}

/**
 * Calculate what fraction of a time window has elapsed.
 * Used for time-relative early warning fallback.
 * @param resetsAt - Unix epoch timestamp in seconds when the limit resets
 * @param windowSeconds - Duration of the window in seconds
 * @returns fraction (0-1) of the window that has elapsed
 */
function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000
  const windowStart = resetsAt - windowSeconds
  const elapsed = nowSeconds - windowStart
  return Math.max(0, Math.min(1, elapsed / windowSeconds))
}

// Reason why overage is disabled/rejected
// These values come from the API's unified limiter
export type OverageDisabledReason =
  | 'overage_not_provisioned' // Overage is not provisioned for this org or seat tier
  | 'org_level_disabled' // Organization doesn't have overage enabled
  | 'org_level_disabled_until' // Organization overage temporarily disabled
  | 'out_of_credits' // Organization has insufficient credits
  | 'seat_tier_level_disabled' // Seat tier doesn't have overage enabled
  | 'member_level_disabled' // Account specifically has overage disabled
  | 'seat_tier_zero_credit_limit' // Seat tier has a zero credit limit
  | 'group_zero_credit_limit' // Resolved group limit has a zero credit limit
  | 'member_zero_credit_limit' // Account has a zero credit limit
  | 'org_service_level_disabled' // Org service specifically has overage disabled
  | 'org_service_zero_credit_limit' // Org service has a zero credit limit
  | 'no_limits_configured' // No overage limits configured for account
  | 'unknown' // Unknown reason, should not happen

export type ClaudeAILimits = {
  status: QuotaStatus
  // unifiedRateLimitFallbackAvailable is currently used to warn users that set
  // their model to Opus whenever they are about to run out of quota. It does
  // not change the actual model that is used.
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

const DEFAULT_LIMITS: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

// Exported for testing only.
//
// This is the ACTIVE account's limits view. It is still a plain module binding
// reassigned by emitStatusChange, so every existing reader (StatusLine,
// BuiltinStatusLine, useClaudeAILimits, promptSuggestion, cost, queryModel)
// keeps working untouched. applyLimitsForAccount is what decides whether a
// given response is allowed to move it: only a response attributed to the
// account that is active when it lands may do so.
export let currentLimits: ClaudeAILimits = { ...DEFAULT_LIMITS }

/**
 * Raw per-window utilization from response headers, tracked on every API
 * response (unlike currentLimits.utilization which is only set when a warning
 * threshold fires). Exposed to statusline scripts via getRawUtilization().
 */
export type RawWindowUtilization = {
  utilization: number // 0-1 fraction
  resets_at: number // unix epoch seconds
}
export type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}

/**
 * Slot key for first-party traffic that has no OAuth account behind it
 * (API-key auth, --bare, or a config without an oauthAccount). Reserved and
 * deliberately not UUID-shaped, so it can never collide with a real
 * accountUuid. Single-account API-key sessions therefore keep exactly one slot
 * and behave as they did before the store was keyed.
 */
export const NO_ACCOUNT_USAGE_KEY = 'no-oauth-account'

/**
 * Shared, frozen empty reading handed back for an account whose quota headers
 * have not been seen yet. Frozen because it is shared across every such
 * account; the capture path always assigns a fresh object instead of mutating.
 */
const EMPTY_RAW_UTILIZATION: RawUtilization = Object.freeze({})

type AccountQuotaSlot = {
  raw: RawUtilization
  /** Epoch ms of the last capture; undefined until headers are seen. */
  capturedAt: number | undefined
  limits: ClaudeAILimits
}

/**
 * Per-account first-party quota state. The unified rate-limit headers carry no
 * account identifier, so the key is supplied by the caller from the account
 * that was active when the REQUEST was built - see currentAccountUsageKey and
 * the accountKey parameter of extractQuotaStatusFromHeaders.
 *
 * Map iteration is insertion-ordered, which is the order listAccountUsageSnapshots
 * reports: first capture first.
 */
const accountQuotaSlots = new Map<string, AccountQuotaSlot>()

/**
 * The slot key for the account that is active right now.
 *
 * Reads getOauthAccountInfo().accountUuid, NOT accountKeyForTokens: that helper
 * derives its key from tokenAccount/profile on an OAuthTokens object, which
 * read-back tokens routinely come back without, so it returns undefined exactly
 * when a key is needed. accountUuid is the identity the config round-trips.
 */
export function currentAccountUsageKey(): string {
  return getOauthAccountInfo()?.accountUuid ?? NO_ACCOUNT_USAGE_KEY
}

/** Slot for a write; creates it on first use. */
function writableSlot(accountKey: string): AccountQuotaSlot {
  const existing = accountQuotaSlots.get(accountKey)
  if (existing) {
    return existing
  }
  const created: AccountQuotaSlot = {
    raw: EMPTY_RAW_UTILIZATION,
    capturedAt: undefined,
    limits: DEFAULT_LIMITS,
  }
  accountQuotaSlots.set(accountKey, created)
  return created
}

export function getRawUtilization(): RawUtilization {
  return (
    accountQuotaSlots.get(currentAccountUsageKey())?.raw ??
    EMPTY_RAW_UTILIZATION
  )
}

/**
 * When the headers behind getRawUtilization() were last seen, as epoch ms.
 * Undefined when no utilization headers have been captured this session.
 */
export function getRawUtilizationCapturedAt(): number | undefined {
  return accountQuotaSlots.get(currentAccountUsageKey())?.capturedAt
}

export type AccountUsageSnapshot = {
  /** An account UUID, or NO_ACCOUNT_USAGE_KEY for unattributed traffic. */
  accountUuid: string
  raw: RawUtilization
  capturedAt: number
}

/**
 * Every account whose first-party quota headers this process has captured.
 * Insertion-ordered (first capture first). Accounts with a slot but no capture
 * yet are omitted, so an entry always carries a real capturedAt.
 */
export function listAccountUsageSnapshots(): AccountUsageSnapshot[] {
  const snapshots: AccountUsageSnapshot[] = []
  for (const [accountUuid, slot] of accountQuotaSlots) {
    if (slot.capturedAt === undefined) {
      continue
    }
    snapshots.push({ accountUuid, raw: slot.raw, capturedAt: slot.capturedAt })
  }
  return snapshots
}

/** Test-only: drop every per-account slot and reset the active-account view. */
export function clearAccountUsageForTests(): void {
  accountQuotaSlots.clear()
  currentLimits = { ...DEFAULT_LIMITS }
}

function extractRawUtilization(headers: globalThis.Headers): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const util = headers.get(
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}

type StatusChangeListener = (limits: ClaudeAILimits) => void
export const statusListeners: Set<StatusChangeListener> = new Set()

export function emitStatusChange(limits: ClaudeAILimits) {
  currentLimits = limits
  statusListeners.forEach(listener => listener(limits))
  const hoursTillReset = Math.round(
    (limits.resetsAt ? limits.resetsAt - Date.now() / 1000 : 0) / (60 * 60),
  )

  logEvent('tengu_claudeai_limits_status_changed', {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    unifiedRateLimitFallbackAvailable: limits.unifiedRateLimitFallbackAvailable,
    hoursTillReset,
  })
}

/**
 * Store newLimits against the account the response belongs to, and fan the
 * change out only when that account is the one the user is looking at.
 *
 * A response from an account that has since been switched away from still
 * updates its own slot - that is what makes listAccountUsageSnapshots complete -
 * but it must not move currentLimits or wake the statusListeners, or a stale
 * in-flight response would repaint the new account's status line with the old
 * account's quota.
 *
 * The two guards are deliberately separate. The slot is written only when its
 * stored value actually changed, and the fan-out is deduped against what the
 * status line is ALREADY showing (currentLimits), NOT against the slot: after
 * an account switch those two disagree, and a value that matches the slot it
 * lands in is precisely the case where currentLimits would otherwise stay on
 * the account the user just left. That separation is what lets
 * projectActiveAccountLimits reuse this function as the single writer of the
 * active-account view instead of adding a second one.
 */
function applyLimitsForAccount(
  accountKey: string,
  newLimits: ClaudeAILimits,
): void {
  const slot = writableSlot(accountKey)
  if (!isEqual(slot.limits, newLimits)) {
    slot.limits = newLimits
  }
  if (accountKey !== currentAccountUsageKey()) {
    return
  }
  if (isEqual(currentLimits, newLimits)) {
    return
  }
  emitStatusChange(newLimits)
}

/**
 * Re-point the active-account view at the account that is active RIGHT NOW.
 *
 * getRawUtilization and getRawUtilizationCapturedAt are functions resolved at
 * read time, so they flip the instant a switch lands. currentLimits is a plain
 * binding that only moves when a response arrives, so without this call the
 * two views of the same account disagree for as long as it takes the new
 * account to answer, and the status line keeps showing the quota of the
 * account the user just left.
 *
 * Call it from wherever an account BECOMES active. It projects already-stored
 * state and nothing else: it captures no headers, changes no quota semantics
 * and cannot misattribute, because it reads the key from
 * currentAccountUsageKey itself rather than accepting one from a caller.
 *
 * Total by construction - a throwing status listener is logged, never
 * propagated - because an account switch must not fail on a repaint.
 */
export function projectActiveAccountLimits(): void {
  try {
    const accountKey = currentAccountUsageKey()
    // An account with nothing stored projects the DEFAULT limits, never the
    // previous account's figures: showing nothing beats showing the account we
    // just switched away from, the same rule switchAccount already applies to
    // config.oauthAccount.
    const stored = accountQuotaSlots.get(accountKey)?.limits ?? DEFAULT_LIMITS
    applyLimitsForAccount(accountKey, { ...stored })
  } catch (error) {
    logError(error as Error)
  }
}

async function makeTestQuery() {
  const model = getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 0,
    model,
    source: 'quota_check',
  })
  const messages: MessageParam[] = [{ role: 'user', content: 'quota' }]
  const betas = getModelBetas(model)
  // biome-ignore lint/plugin: quota check needs raw response access via asResponse()
  return anthropic.beta.messages
    .create({
      model,
      max_tokens: 1,
      messages,
      metadata: getAPIMetadata(),
      ...(betas.length > 0 ? { betas } : {}),
    })
    .asResponse()
}

export async function checkQuotaStatus(): Promise<void> {
  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    return
  }

  // Check if we should process rate limits (real subscriber or mock testing)
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    return
  }

  // In non-interactive mode (-p), the real query follows immediately and
  // extractQuotaStatusFromHeaders() will update limits from its response
  // headers (claude.ts), so skip this pre-check API call.
  if (getIsNonInteractiveSession()) {
    return
  }

  // Snapshot the account BEFORE the round trip, for the same reason queryModel
  // does: an account switch landing while makeTestQuery is in flight clears the
  // memoized OAuth token, so a key read after the await would file this
  // response under whichever account happens to be active by then.
  const accountKey = currentAccountUsageKey()

  try {
    // Make a minimal request to check quota
    const raw = await makeTestQuery()

    // Update limits based on the response
    extractQuotaStatusFromHeaders(raw.headers, accountKey)
  } catch (error) {
    if (error instanceof APIError) {
      extractQuotaStatusFromError(error, accountKey)
    }
  }
}

/**
 * Check if early warning should be triggered based on surpassed-threshold header.
 * Returns ClaudeAILimits if a threshold was surpassed, null otherwise.
 */
function getHeaderBasedEarlyWarning(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // Check each claim type for surpassed threshold header
  for (const [claimAbbrev, rateLimitType] of Object.entries(
    EARLY_WARNING_CLAIM_MAP,
  )) {
    const surpassedThreshold = headers.get(
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    )

    // If threshold header is present, user has crossed a warning threshold
    if (surpassedThreshold !== null) {
      const utilizationHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      )
      const resetHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      )

      const utilization = utilizationHeader
        ? Number(utilizationHeader)
        : undefined
      const resetsAt = resetHeader ? Number(resetHeader) : undefined

      return {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: rateLimitType as RateLimitType,
        utilization,
        unifiedRateLimitFallbackAvailable,
        isUsingOverage: false,
        surpassedThreshold: Number(surpassedThreshold),
      }
    }
  }

  return null
}

/**
 * Check if time-relative early warning should be triggered for a rate limit type.
 * Fallback when server doesn't send surpassed-threshold header.
 * Returns ClaudeAILimits if thresholds are exceeded, null otherwise.
 */
function getTimeRelativeEarlyWarning(
  headers: globalThis.Headers,
  config: EarlyWarningConfig,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  const { rateLimitType, claimAbbrev, windowSeconds, thresholds } = config

  const utilizationHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
  )
  const resetHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
  )

  if (utilizationHeader === null || resetHeader === null) {
    return null
  }

  const utilization = Number(utilizationHeader)
  const resetsAt = Number(resetHeader)
  const timeProgress = computeTimeProgress(resetsAt, windowSeconds)

  // Check if any threshold is exceeded: high usage early in the window
  const shouldWarn = thresholds.some(
    t => utilization >= t.utilization && timeProgress <= t.timePct,
  )

  if (!shouldWarn) {
    return null
  }

  return {
    status: 'allowed_warning',
    resetsAt,
    rateLimitType,
    utilization,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: false,
  }
}

/**
 * Get early warning limits using header-based detection with time-relative fallback.
 * 1. First checks for surpassed-threshold header (new server-side approach)
 * 2. Falls back to time-relative thresholds (client-side calculation)
 */
function getEarlyWarningFromHeaders(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // Try header-based detection first (preferred when API sends the header)
  const headerBasedWarning = getHeaderBasedEarlyWarning(
    headers,
    unifiedRateLimitFallbackAvailable,
  )
  if (headerBasedWarning) {
    return headerBasedWarning
  }

  // Fallback: Use time-relative thresholds (client-side calculation)
  // This catches users burning quota faster than sustainable
  for (const config of EARLY_WARNING_CONFIGS) {
    const timeRelativeWarning = getTimeRelativeEarlyWarning(
      headers,
      config,
      unifiedRateLimitFallbackAvailable,
    )
    if (timeRelativeWarning) {
      return timeRelativeWarning
    }
  }

  return null
}

function computeNewLimitsFromHeaders(
  headers: globalThis.Headers,
): ClaudeAILimits {
  const status =
    (headers.get('anthropic-ratelimit-unified-status') as QuotaStatus) ||
    'allowed'
  const resetsAtHeader = headers.get('anthropic-ratelimit-unified-reset')
  const resetsAt = resetsAtHeader ? Number(resetsAtHeader) : undefined
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available'

  // Headers for rate limit type and overage support
  const rateLimitType = headers.get(
    'anthropic-ratelimit-unified-representative-claim',
  ) as RateLimitType | null
  const overageStatus = headers.get(
    'anthropic-ratelimit-unified-overage-status',
  ) as QuotaStatus | null
  const overageResetsAtHeader = headers.get(
    'anthropic-ratelimit-unified-overage-reset',
  )
  const overageResetsAt = overageResetsAtHeader
    ? Number(overageResetsAtHeader)
    : undefined

  // Reason why overage is disabled (spending cap or wallet empty)
  const overageDisabledReason = headers.get(
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ) as OverageDisabledReason | null

  // Determine if we're using overage (standard limits rejected but overage allowed)
  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  // Check for early warning based on surpassed-threshold header
  // If status is allowed/allowed_warning and we find a surpassed threshold, show warning
  let finalStatus: QuotaStatus = status
  if (status === 'allowed' || status === 'allowed_warning') {
    const earlyWarning = getEarlyWarningFromHeaders(
      headers,
      unifiedRateLimitFallbackAvailable,
    )
    if (earlyWarning) {
      return earlyWarning
    }
    // No early warning threshold surpassed
    finalStatus = 'allowed'
  }

  return {
    status: finalStatus,
    resetsAt,
    unifiedRateLimitFallbackAvailable,
    ...(rateLimitType && { rateLimitType }),
    ...(overageStatus && { overageStatus }),
    ...(overageResetsAt && { overageResetsAt }),
    ...(overageDisabledReason && { overageDisabledReason }),
    isUsingOverage,
  }
}

/**
 * Cache the extra usage disabled reason from API headers.
 */
function cacheExtraUsageDisabledReason(headers: globalThis.Headers): void {
  // A null reason means extra usage is enabled (no disabled reason header)
  const reason =
    headers.get('anthropic-ratelimit-unified-overage-disabled-reason') ?? null
  const cached = getGlobalConfig().cachedExtraUsageDisabledReason
  if (cached !== reason) {
    saveGlobalConfig(current => ({
      ...current,
      cachedExtraUsageDisabledReason: reason,
    }))
  }
}

/**
 * @param accountKey - slot to attribute this response to, from
 * currentAccountUsageKey() captured when the REQUEST was built. Required on
 * purpose: an implicit undefined here is precisely the silent misattribution
 * the per-account store exists to prevent.
 */
export function extractQuotaStatusFromHeaders(
  headers: globalThis.Headers,
  accountKey: string,
): void {
  // Check if we need to process rate limits
  const isSubscriber = isClaudeAISubscriber()

  if (!shouldProcessRateLimits(isSubscriber)) {
    // If we have any rate limit state for this account, clear it
    const slot = writableSlot(accountKey)
    slot.raw = EMPTY_RAW_UTILIZATION
    slot.capturedAt = undefined
    if (slot.limits.status !== 'allowed' || slot.limits.resetsAt) {
      applyLimitsForAccount(accountKey, { ...DEFAULT_LIMITS })
    }
    return
  }

  // Process headers (applies mocks from /mock-limits command if active)
  const headersToUse = processRateLimitHeaders(headers)
  const slot = writableSlot(accountKey)
  slot.raw = extractRawUtilization(headersToUse)
  slot.capturedAt = Date.now()
  const newLimits = computeNewLimitsFromHeaders(headersToUse)

  // Cache extra usage status (persists across sessions)
  cacheExtraUsageDisabledReason(headersToUse)

  applyLimitsForAccount(accountKey, newLimits)
}

/**
 * @param accountKey - slot to attribute this error to, captured when the
 * REQUEST was built. See extractQuotaStatusFromHeaders.
 */
export function extractQuotaStatusFromError(
  error: APIError,
  accountKey: string,
): void {
  if (
    !shouldProcessRateLimits(isClaudeAISubscriber()) ||
    error.status !== 429
  ) {
    return
  }

  try {
    const slot = writableSlot(accountKey)
    // Seed from the limits already stored for THIS account, not from
    // currentLimits: a headerless 429 for a switched-away account would
    // otherwise copy the active account's figures into the other slot.
    let newLimits: ClaudeAILimits = { ...slot.limits }
    if (error.headers) {
      // Process headers (applies mocks from /mock-limits command if active)
      const headersToUse = processRateLimitHeaders(error.headers)
      slot.raw = extractRawUtilization(headersToUse)
      slot.capturedAt = Date.now()
      newLimits = computeNewLimitsFromHeaders(headersToUse)

      // Cache extra usage status (persists across sessions)
      cacheExtraUsageDisabledReason(headersToUse)
    }
    // For errors, always set status to rejected even if headers are not present.
    newLimits.status = 'rejected'

    applyLimitsForAccount(accountKey, newLimits)
  } catch (e) {
    logError(e as Error)
  }
}
