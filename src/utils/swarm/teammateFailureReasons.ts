/**
 * The fixed vocabulary a teammate uses to report a failed turn, and how each
 * kind is classified for the lead's attention items. Kept dependency-free so
 * both the teammate side (teammateInit) and the lead side (the pane watchdog,
 * attention items) can import it.
 */
export type TeammateFailureKind =
  | 'provider'
  | 'runtime'
  | 'authentication'
  | 'quota'
  | 'rate_limit'

export const TEAMMATE_FAILURE_REASONS: Record<TeammateFailureKind, string> = {
  authentication:
    'Teammate authentication failed (OAuth token revoked or invalid). Run /login for its provider, then retry.',
  quota:
    "Teammate provider quota exhausted or not enabled. Pick a model on another provider or wait for the provider's quota to reset.",
  rate_limit:
    'Teammate provider rate limit reached. Retry later or pick a model on another provider.',
  provider: 'Teammate provider request failed before completion.',
  runtime: 'Teammate runtime failed before completion.',
}

/** Kinds a plain retry can fix: the provider, not the input, was at fault. */
const TRANSIENT_KINDS: ReadonlySet<TeammateFailureKind> = new Set([
  'provider',
  'rate_limit',
  'quota',
])

export function teammateFailureKindOfReason(
  reason: string | undefined,
): TeammateFailureKind | undefined {
  if (!reason) return undefined
  for (const [kind, text] of Object.entries(TEAMMATE_FAILURE_REASONS)) {
    if (text === reason) return kind as TeammateFailureKind
  }
  return undefined
}

/**
 * Transient classification for a teammate's self-reported failure reason:
 * provider, rate_limit and quota are transient; authentication, runtime and
 * any unrecognised reason are not.
 */
export function classifyTeammateFailureReason(reason: string | undefined): {
  transient: boolean
  transientReason: string
} {
  const kind = teammateFailureKindOfReason(reason)
  if (!kind) return { transient: false, transientReason: 'unrecognised failure' }
  return { transient: TRANSIENT_KINDS.has(kind), transientReason: `failure kind ${kind}` }
}
