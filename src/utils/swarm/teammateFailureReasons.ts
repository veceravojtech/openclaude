/**
 * The fixed vocabulary a teammate uses to report a failed turn, and how each
 * kind is classified for the lead's attention items. Kept dependency-free so
 * both the teammate side (teammateInit) and the lead side (the pane watchdog,
 * attention items) can import it. Its only import is the pure redaction
 * helper.
 */
import { redactLikelySecrets, redactUrlForDisplay } from '../redaction.js'

export type TeammateFailureKind =
  | 'provider'
  | 'runtime'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'refusal'

export const TEAMMATE_FAILURE_REASONS: Record<TeammateFailureKind, string> = {
  authentication:
    'Teammate authentication failed (OAuth token revoked or invalid). Run /login for its provider, then retry.',
  quota:
    "Teammate provider quota exhausted or not enabled. Pick a model on another provider or wait for the provider's quota to reset.",
  rate_limit:
    'Teammate provider rate limit reached. Retry later or pick a model on another provider.',
  refusal:
    "Teammate request was refused by the model provider's usage policy. Rephrase the task or retry on another model.",
  provider: 'Teammate provider request failed before completion.',
  runtime: 'Teammate runtime failed before completion.',
}

/** Kinds a plain retry can fix: the provider, not the input, was at fault. */
const TRANSIENT_KINDS: ReadonlySet<TeammateFailureKind> = new Set([
  'provider',
  'rate_limit',
  'quota',
])

/**
 * Provider error text is untrusted: it can carry API keys, bearer tokens,
 * proxy URLs with embedded credentials or secret query parameters. Everything
 * that is written to a mailbox or an attention item goes through here first.
 */
export function redactFailureDetail(text: string): string {
  // Named fields (any escaping depth), header values, URLs and well-known
  // token prefixes: the shared scrubber.
  let redacted = redactLikelySecrets(text).replace(
    /https?:\/\/[^\s"'<>)\\]+/g,
    url => redactUrlForDisplay(url),
  )
  // Final sweep for values that sit outside any named field, so they are
  // caught wherever they appear: account ids, JWTs, and token prefixes.
  redacted = redacted
    .replace(/(?<![A-Za-z0-9_-])acct[-_][A-Za-z0-9_-]{6,}/gi, '[REDACTED_ACCOUNT_ID]')
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '[REDACTED_TOKEN]')
    .replace(/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{6,}/g, '[REDACTED_API_KEY]')
    .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{16,}/g, '[REDACTED_GCP_KEY]')
  return redacted
}

/** Separates the fixed reason text from the provider's own error text. */
const DETAIL_SEPARATOR = '\n\nProvider message: '
const MAX_DETAIL_CHARS = 1_000

/**
 * The lead-facing failure reason for `kind`: the fixed text, followed by the
 * original error text when there is one, so the lead sees what actually
 * happened and not only a category. `teammateFailureKindOfReason` still
 * recognises the result.
 */
export function formatTeammateFailureReason(
  kind: TeammateFailureKind,
  detail?: string,
): string {
  const text = TEAMMATE_FAILURE_REASONS[kind]
  const trimmed = detail?.trim() ? redactFailureDetail(detail.trim()) : ''
  if (!trimmed) return text
  const clipped =
    trimmed.length > MAX_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
      : trimmed
  return `${text}${DETAIL_SEPARATOR}${clipped}`
}

export function teammateFailureKindOfReason(
  reason: string | undefined,
): TeammateFailureKind | undefined {
  if (!reason) return undefined
  for (const [kind, text] of Object.entries(TEAMMATE_FAILURE_REASONS)) {
    if (text === reason || reason.startsWith(text + DETAIL_SEPARATOR)) {
      return kind as TeammateFailureKind
    }
  }
  return undefined
}

/**
 * Map a terminal API-error message to a fixed failure category. Prefers the
 * structured signal (`apiError`/`errorCode`) and falls back to the message
 * text. Only the category leaves this function — never the raw text.
 */
export function classifyTeammateApiError(
  errorCode: string | undefined,
  text: string | undefined,
  apiError?: string,
): Exclude<TeammateFailureKind, 'runtime'> {
  if (
    apiError === 'refusal' ||
    (text !== undefined &&
      /unable to respond to this request, which appears to violate our Usage Policy/i.test(
        text,
      ))
  ) {
    return 'refusal'
  }
  if (
    errorCode === 'authentication_failed' ||
    (text !== undefined && /OAuth token (has been )?revoked|Please run \/login/i.test(text))
  ) {
    return 'authentication'
  }
  if (text !== undefined && /quota exhausted|insufficient_quota|exceeded your current quota|usage limit has been reached/i.test(text)) {
    return 'quota'
  }
  if (errorCode === 'rate_limit' || (text !== undefined && /rate limit|429/i.test(text))) {
    return 'rate_limit'
  }
  return 'provider'
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
