/**
 * Passive, per-provider capture of OpenAI-compatible `x-ratelimit-*`
 * response headers.
 *
 * The registry is updated synchronously on every successful response that
 * flows through the OpenAI shim (see requestExecutor.ts). It never issues
 * network requests of its own — it only remembers what providers already
 * told us on responses we had to make anyway.
 *
 * Honesty rules (mirrored by the Usage tool):
 * - A field is either a value captured from a real header, or absent.
 * - Absent headers never overwrite previously captured values.
 * - `capturedAt` is the only staleness signal; consumers must surface it.
 * - Malformed header values are stored as raw strings, never dropped or
 *   coerced into fabricated numbers.
 */

export type RateLimitHeaderValue = number | string

export type ProviderRateLimitSnapshot = {
  /** Stable provider key: shim route id, or `host:<hostname>` fallback. */
  providerKey: string
  /** Human-readable label when known (route descriptor label). */
  providerLabel: string
  /** Model the captured response was served for. */
  model?: string
  /** Base URL the captured response came from. */
  baseUrl?: string
  remainingRequests?: RateLimitHeaderValue
  remainingTokens?: RateLimitHeaderValue
  limitRequests?: RateLimitHeaderValue
  limitTokens?: RateLimitHeaderValue
  /** Raw reset header value — providers send Go-style durations ("6m0s"). */
  resetRequests?: string
  resetTokens?: string
  /** ISO timestamp of the response the fields were captured from. */
  capturedAt: string
}

type HeaderReader = Pick<Headers, 'get'>

const COUNT_FIELDS = [
  { field: 'remainingRequests', header: 'x-ratelimit-remaining-requests' },
  { field: 'remainingTokens', header: 'x-ratelimit-remaining-tokens' },
  { field: 'limitRequests', header: 'x-ratelimit-limit-requests' },
  { field: 'limitTokens', header: 'x-ratelimit-limit-tokens' },
] as const satisfies readonly {
  field: keyof ProviderRateLimitSnapshot
  header: string
}[]

const RESET_FIELDS = [
  { field: 'resetRequests', header: 'x-ratelimit-reset-requests' },
  { field: 'resetTokens', header: 'x-ratelimit-reset-tokens' },
] as const satisfies readonly {
  field: keyof ProviderRateLimitSnapshot
  header: string
}[]

const registry = new Map<string, ProviderRateLimitSnapshot>()

/**
 * Parse a rate-limit count header. Returns a finite number when the value is
 * numeric ("1200"), otherwise the raw string ("Infinity") so nothing
 * providers actually send is silently discarded.
 */
function parseCountValue(raw: string): RateLimitHeaderValue {
  const trimmed = raw.trim()
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return trimmed
}

export function captureRateLimitHeaders(input: {
  providerKey: string
  providerLabel?: string
  model?: string
  baseUrl?: string
  headers: HeaderReader
  /** Injectable clock for tests. */
  now?: () => number
}): void {
  try {
    const snapshot: {
      remainingRequests?: RateLimitHeaderValue
      remainingTokens?: RateLimitHeaderValue
      limitRequests?: RateLimitHeaderValue
      limitTokens?: RateLimitHeaderValue
      resetRequests?: string
      resetTokens?: string
    } = {}
    let capturedAny = false

    for (const { field, header } of COUNT_FIELDS) {
      const raw = input.headers.get(header)
      if (raw === null || raw.trim() === '') continue
      const value = parseCountValue(raw)
      snapshot[field] = value
      capturedAny = true
    }

    for (const { field, header } of RESET_FIELDS) {
      const raw = input.headers.get(header)
      if (raw === null || raw.trim() === '') continue
      snapshot[field] = raw.trim()
      capturedAny = true
    }

    // Providers that send none of these headers (e.g. coding-plan backends)
    // must not erase previously captured data, nor create empty entries.
    if (!capturedAny) return

    const previous = registry.get(input.providerKey)
    registry.set(input.providerKey, {
      providerKey: input.providerKey,
      providerLabel:
        input.providerLabel ?? previous?.providerLabel ?? input.providerKey,
      model: input.model ?? previous?.model,
      baseUrl: input.baseUrl ?? previous?.baseUrl,
      ...snapshot,
      capturedAt: new Date((input.now ?? Date.now)()).toISOString(),
    })
  } catch {
    // A malformed header must never break the response it arrived on.
  }
}

export function getProviderRateLimitSnapshot(
  providerKey: string,
): ProviderRateLimitSnapshot | undefined {
  return registry.get(providerKey)
}

export function listProviderRateLimitSnapshots(): ProviderRateLimitSnapshot[] {
  return [...registry.values()]
}

/** Test-only: reset the registry between cases. */
export function clearProviderUsageRegistry(): void {
  registry.clear()
}
