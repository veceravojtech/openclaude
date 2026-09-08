/**
 * Dynamic "latest Opus" resolution for the first-party Anthropic API.
 *
 * The `opus` alias — and the Max / Team Premium default — used to be a
 * hardcoded id bumped by hand at every launch. This module mirrors tmux-cli's
 * models resolver instead: ask GET /v1/models for the newest `claude-opus*`
 * model (by created_at), persist it in the global config, and serve the cached
 * id on later startups. Every failure path (kill switch, non-first-party route,
 * no credentials, timeout, HTTP or parse error, empty list) is silent and
 * leaves the pinned fallback (`CLAUDE_OPUS_5_CONFIG`) in charge, so startup
 * never blocks on the network and a fresh install behaves exactly like the
 * static default until the first successful lookup.
 *
 * Sync consumers (getDefaultOpusModel) only ever read memory. The network call
 * runs from main.tsx's startup prefetches; its result is persisted for the
 * next startup and only adopted in-process when nothing has been resolved yet,
 * so a running session never flips its Opus id mid-conversation.
 */
import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getAnthropicApiKey, getClaudeAIOAuthTokens } from '../auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { compareOpusVersions, parseOpusVersion } from './opusVersion.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

export const DISABLE_LATEST_OPUS_RESOLUTION_ENV =
  'OPENCLAUDE_DISABLE_LATEST_OPUS_RESOLUTION'

const OPUS_ID_PREFIX = 'claude-opus'
const REQUEST_TIMEOUT_MS = 5_000
// Re-query at most this often; the cached id serves in between.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const ANTHROPIC_VERSION_HEADER = '2023-06-01'

type ModelsListEntry = { id?: unknown; created_at?: unknown }

// undefined: nothing read yet. null: read, nothing cached. string: resolved id.
let resolvedLatestOpusModel: string | null | undefined
let inflightPrefetch: Promise<void> | null = null

export function isLatestOpusResolutionEnabled(): boolean {
  if (isEnvTruthy(process.env[DISABLE_LATEST_OPUS_RESOLUTION_ENV])) {
    return false
  }
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Pure policy (no I/O): the newest `claude-opus*` id by created_at. Ties fall
 * back to the higher parsed version, then to the shorter id so an undated id
 * beats its dated twin. Undefined when no Opus id with a parseable version is
 * present.
 */
export function pickNewestOpusModel(
  models: readonly ModelsListEntry[],
): string | undefined {
  let best: { id: string; createdAt: number; version: ReturnType<typeof parseOpusVersion> } | undefined
  for (const entry of models) {
    if (typeof entry.id !== 'string' || !entry.id.startsWith(OPUS_ID_PREFIX)) {
      continue
    }
    const version = parseOpusVersion(entry.id)
    if (!version) {
      continue
    }
    const parsedCreatedAt =
      typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN
    const createdAt = Number.isNaN(parsedCreatedAt) ? -Infinity : parsedCreatedAt
    const candidate = { id: entry.id, createdAt, version }
    if (!best) {
      best = candidate
      continue
    }
    const byDate = candidate.createdAt - best.createdAt
    const byVersion =
      byDate !== 0 ? 0 : compareOpusVersions(candidate.version!, best.version!)
    const byLength =
      byDate !== 0 || byVersion !== 0 ? 0 : best.id.length - candidate.id.length
    if (byDate > 0 || byVersion > 0 || byLength > 0) {
      best = candidate
    }
  }
  return best?.id
}

function readCachedLatestOpusModel(): string | null {
  try {
    const cached = getGlobalConfig().latestOpusModelId
    return typeof cached === 'string' && cached.startsWith(OPUS_ID_PREFIX)
      ? cached
      : null
  } catch {
    // Config may not be readable yet this early in startup; try again later.
    return null
  }
}

/**
 * The newest Opus id resolved for this session, or undefined when resolution
 * is disabled, not applicable to the active provider, or nothing has been
 * cached yet. Reads memory only; the first call lazily loads the cached value.
 */
export function getResolvedLatestOpusModel(): string | undefined {
  if (!isLatestOpusResolutionEnabled()) {
    return undefined
  }
  if (resolvedLatestOpusModel === undefined) {
    const cached = readCachedLatestOpusModel()
    if (cached === null) {
      // Keep `undefined` if config wasn't readable so a later call retries.
      try {
        getGlobalConfig()
        resolvedLatestOpusModel = null
      } catch {
        return undefined
      }
    } else {
      resolvedLatestOpusModel = cached
    }
  }
  return resolvedLatestOpusModel ?? undefined
}

function getModelsApiAuth():
  | { accessToken: string }
  | { apiKey: string }
  | null {
  try {
    const apiKey = getAnthropicApiKey()
    if (apiKey) {
      return { apiKey }
    }
  } catch {
    // No configured key; fall through to OAuth.
  }
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  return accessToken ? { accessToken } : null
}

async function fetchModelsList(
  auth: { accessToken: string } | { apiKey: string },
): Promise<ModelsListEntry[]> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/v1/models?limit=1000`
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION_HEADER,
    ...('accessToken' in auth
      ? {
          Authorization: `Bearer ${auth.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      : { 'x-api-key': auth.apiKey }),
  }
  const response = await axios.get<{ data?: unknown }>(endpoint, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  })
  const data = response.data?.data
  return Array.isArray(data) ? (data as ModelsListEntry[]) : []
}

/**
 * Background refresh of the cached newest-Opus id. Never throws and never
 * blocks the caller on the network; call it with `void`.
 */
export async function prefetchLatestOpusModel(): Promise<void> {
  if (!isLatestOpusResolutionEnabled() || isEssentialTrafficOnly()) {
    return
  }
  if (inflightPrefetch) {
    return inflightPrefetch
  }
  const checkedAt = getGlobalConfig().latestOpusModelCheckedAt ?? 0
  if (Date.now() - checkedAt < REFRESH_INTERVAL_MS) {
    logForDebugging('Skipping latest Opus lookup, checked recently')
    return
  }
  const auth = getModelsApiAuth()
  if (!auth) {
    logForDebugging('Skipping latest Opus lookup, no credentials')
    return
  }

  inflightPrefetch = (async () => {
    try {
      const newest = pickNewestOpusModel(await fetchModelsList(auth))
      if (!newest) {
        logForDebugging('Latest Opus lookup returned no claude-opus model')
        return
      }
      const previous = readCachedLatestOpusModel()
      saveGlobalConfig(current => ({
        ...current,
        latestOpusModelId: newest,
        latestOpusModelCheckedAt: Date.now(),
      }))
      if (resolvedLatestOpusModel === undefined) {
        resolvedLatestOpusModel = newest
      }
      logForDebugging(
        previous === newest
          ? `Latest Opus unchanged: ${newest}`
          : `Latest Opus resolved to ${newest} (was ${previous ?? 'unset'}); applies from the next startup`,
      )
    } catch (error) {
      // Credentials never reach this message: axios errors carry the URL and
      // status, not request headers.
      logForDebugging(`Latest Opus lookup failed, keeping fallback: ${error}`, {
        level: 'error',
      })
    } finally {
      inflightPrefetch = null
    }
  })()
  return inflightPrefetch
}

export function resetLatestOpusModelStateForTesting(): void {
  resolvedLatestOpusModel = undefined
  inflightPrefetch = null
}
