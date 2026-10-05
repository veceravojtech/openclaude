/**
 * Centralized credential redaction utility.
 *
 * Primary source of truth for redacting secrets (API keys, tokens, passwords)
 * from strings, JSON values, URLs, filesystem paths, and structured
 * diagnostic objects that flow into logs, bug reports, transcript shares,
 * /status output, doctor reports, and other public-safe surfaces. The
 * regex sets and credential-name lists live here; call sites for diagnostic
 * and logging paths should prefer these over forking their own patterns.
 *
 * Specialized scanners (e.g. team-memory pre-upload scanning in
 * secretScanner.ts, OAuth token redaction in xaa.ts) maintain their own
 * rules for domain-specific needs and different threat models. Those are
 * intentional exceptions, not drift.
 *
 * Surface map:
 *
 *   Logs / bug reports / transcript shares
 *     redactSensitiveInfo(text)             free-form string scrub
 *     jsonRedactor(key, value)             JSON.stringify replacer
 *
 *   URL display
 *     redactUrlForDisplay(url)              masks userinfo + sensitive query params
 *     shouldRedactUrlQueryParam(name)       predicate for external callers
 *
 *   /status output
 *     redactUrlForStatus(url)               redactUrlForDisplay + drop fragment
 *     redactPathForStatus(path)             ~-redact $HOME prefix
 *
 *   Diagnostic reports (doctor / issue export)
 *     collectProviderSecretEnvVars()        list known env var names
 *     summarizeSecretEnvPresence(env)       [{name, present}] summary
 *     redactDiagnosticObject(value)         recursive walk; [set] / [redacted]
 *     redactDiagnosticUrl(url)              url redacted + trailing / stripped
 *     redactHomePath(value)                 $HOME → ~
 *     redactLikelySecrets(value)            free-form text scrub
 *
 * Provider coverage is generated from two sources:
 * - `getKnownProviderSecretEnvKeys()` for env-var name patterns, so a new
 *   provider added via the descriptor registry is covered automatically.
 * - Hard-coded prefix patterns for the well-known token formats (sk-ant-...,
 *   AIza..., ghp_..., etc.) which show up outside of env-var contexts.
 */

import { homedir } from "node:os";
import { getKnownProviderSecretEnvKeys } from "./providerSecrets.js";

// Anthropic API keys (sk-ant...)
// Boundary class is `[A-Za-z0-9_-]` (not `[A-Za-z0-9]`) so a raw key
// embedded in a JSON string value `"sk-ant-..."` is still caught — the
// leading `"` is the start of the string, not a key character.
const ANTHROPIC_KEY_PATTERN =
  /(?<![A-Za-z0-9_-])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g;

// OpenAI / Codex / OpenRouter API keys (sk-..., sk-proj-..., sk-or-v1-...)
const OPENAI_KEY_PATTERN =
  /(?<![A-Za-z0-9_-])(sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{5,})(?![A-Za-z0-9_-])/g;

// AWS access keys
const AWS_ACCESS_KEY_PATTERN = /(AKIA[A-Z0-9]{16})/g;

// Google Cloud / Gemini API keys (AIza...) — 35-char suffix matches real GCP
// keys which are typically 39 chars total. The diagnostics module uses {10,}
// because it sees values out of context; here we only flag clearly-shaped keys.
const GCP_KEY_PATTERN =
  /(?<![A-Za-z0-9_-])(AIza[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g;

// Vertex AI service account emails
const GCP_SERVICE_ACCOUNT_PATTERN =
  /(?<![A-Za-z0-9])([a-z0-9-]{1,128}@[a-z0-9-]{1,128}\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g;

// GitHub personal access tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_)
const GITHUB_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_-])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}(?![A-Za-z0-9_-])/g;

// "AWS key: \"AKIA...\"" — provider-specific debug-message wrapping
const AWS_KEY_LABELED_PATTERN = /AWS key:\s*"(AWS[A-Z0-9]{20,})"/g;

// ---------------------------------------------------------------------------
// Field patterns that tolerate escaped JSON.
//
// Provider errors embed request/response bodies as JSON strings inside JSON
// strings, so a credential field arrives as `"k":"v"`, `\"k\":\"v\"`,
// `\\\"k\\\":\\\"v\\\"`, with `\u0022` instead of a quote, ... Every
// field-name pattern below matches all of them, keeps the surrounding text and
// keeps the closing quote with its escaping.
//
// A field is found in two steps, both linear:
//   1. a regex finds `name [quote] <sep>` (the "head"). It has no
//      back-references and nothing that re-scans a backslash run: a quote
//      before the name is not matched at all (it is only ever written back
//      unchanged, and matching it would re-scan the run from every start
//      position inside it -- quadratic), and OPT_QUOTE after the name is only
//      reached once the name has matched.
//   2. the value is read by `scanQuotedValue` / a sticky regex, once.
// A quoted value ends at the quote that closes its opening quote: a quote
// preceded by MORE backslashes than the opening quote is part of the value, so
// `\"pw\":\"a\\\"b\"` redacts `a\\\"b` whole.
// ---------------------------------------------------------------------------

/** A quote after a field name: `"`, `'`, `\"`, `\\\"`, `\u0022`, ... */
const OPT_QUOTE = String.raw`(?:\\*["']|\\+u00(?:22|27))?`;

// Unquoted values stop at their delimiters.
const SECRET_VALUE = String.raw`(?:[^"',\n&#;\\]|\\+(?![\\"']))+`;
const ENV_VALUE = String.raw`(?:[^"',\s)}\]&#;\\]|\\+(?![\\"']))+`;
const COOKIE_VALUE = String.raw`(?:[^"'\n&\\]|\\+(?![\\"']))+`;

type FieldSpec = {
  /** Global; `[lookbehind] name OPT_QUOTE \s* [:=] \s*`, no capture groups. */
  head: RegExp;
  /** Sticky; text between the opening quote and the value, e.g. `Bearer `. */
  after?: RegExp;
  /** Sticky; an unquoted value. */
  unquoted: RegExp;
  /**
   * Rejects a head by its text. A rejected head is skipped WITHOUT reading its
   * value, and scanning resumes right after the head, so a field inside that
   * value (`Error: AWS_SECRET_ACCESS_KEY=...` -- head `Error: `) is still found.
   */
  keep?: (head: string) => boolean;
};

type FieldParts = {
  match: string;
  /** `name [quote] <sep>`, up to (not including) the value's opening quote. */
  head: string;
  /** The value's opening quote with its escaping; empty for unquoted values. */
  open: string;
  /** Text between the opening quote and the value (e.g. `Bearer `). */
  after: string;
  value: string;
};

function fieldSpec(o: {
  lookbehind?: string;
  /** Name, optional quote and separator; no capture groups. */
  head: string;
  after?: string;
  unquoted: string;
  keep?: (head: string) => boolean;
}): FieldSpec {
  return {
    head: new RegExp(`${o.lookbehind ?? ""}${o.head}`, "gi"),
    ...(o.after ? { after: new RegExp(o.after, "iy") } : {}),
    unquoted: new RegExp(o.unquoted, "y"),
    ...(o.keep ? { keep: o.keep } : {}),
  };
}

const OPENING_QUOTE = /\\*["']|\\+u00(?:22|27)/y;
const BACKSLASH = 92;

/**
 * How a candidate closing quote is judged against the opening quote.
 *
 * Nested JSON doubles every backslash per level and adds one per quote
 * escape, so for an opening quote preceded by `depth` backslashes a closing
 * quote is preceded by `depth + k * period` of them, where `k` is the number
 * of literal backslashes that end the value and `period` is what one such
 * backslash becomes: `2 * (depth + 1)` for `"`/`\"`/`\\\"` quotes,
 * `2 * depth` for `\u0022` quotes. Any other run is a quote INSIDE the value.
 */
function closesValue(
  run: number,
  depth: number,
  openUnicode: boolean,
  candidateUnicode: boolean,
): boolean {
  if (run < depth) return true; // an outer string ended: stop
  if (openUnicode !== candidateUnicode) return run <= depth; // mixed forms
  const period = openUnicode ? 2 * depth : 2 * (depth + 1);
  return period === 0 ? run === depth : (run - depth) % period === 0;
}

/**
 * End (exclusive) of a quoted value that starts at `from`, opened by the quote
 * character `quoteChar` (34 `"` or 39 `'`), escaped with `depth` backslashes.
 * The value ends only at that same quote character (raw, backslash-escaped or
 * `\u00XX`), or at a newline: the other quote character is ordinary content
 * (`"don't"`). Single pass.
 */
function scanQuotedValue(
  text: string,
  from: number,
  depth: number,
  quoteChar: number,
  openUnicode: boolean,
): number {
  const length = text.length;
  let i = from;
  while (i < length) {
    const c = text.charCodeAt(i);
    if (c === 10) return i;
    if (c === 34 || c === 39) {
      if (c === quoteChar) return i; // a raw closing quote
      i++;
      continue;
    }
    if (c !== BACKSLASH) {
      i++;
      continue;
    }
    let j = i;
    while (j < length && text.charCodeAt(j) === BACKSLASH) j++;
    const run = j - i;
    const next = text.charCodeAt(j);
    let candidate = 0;
    let candidateLength = 0;
    let candidateUnicode = false;
    if (next === 34 || next === 39) {
      candidate = next;
      candidateLength = 1;
    } else if (
      next === 117 /* u */ &&
      text.startsWith("u00", j) &&
      (text.startsWith("22", j + 3) || text.startsWith("27", j + 3))
    ) {
      candidate = text.startsWith("22", j + 3) ? 34 : 39;
      candidateLength = 5;
      candidateUnicode = true;
    }
    if (candidateLength === 0) {
      i = j; // backslashes inside the value (a path, a password)
      continue;
    }
    if (candidate === quoteChar && closesValue(run, depth, openUnicode, candidateUnicode)) {
      // The quote and its `depth` escaping backslashes stay in the output; the
      // backslashes before them are the value's own (it ends in a backslash).
      return i + Math.max(0, run - depth);
    }
    i = j + candidateLength; // a quote inside the value
  }
  return i;
}

function matchAt(re: RegExp, text: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(text)?.[0];
}

function replaceFields(
  text: string,
  spec: FieldSpec,
  render: (parts: FieldParts) => string,
): string {
  const { head, after, unquoted, keep } = spec;
  let out = "";
  let copied = 0;
  head.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text)) !== null) {
    const start = m.index;
    const headText = m[0];
    if (headText.length === 0) {
      head.lastIndex = start + 1;
      continue;
    }
    const valueStart = start + headText.length;
    if (keep && !keep(headText)) {
      // Not ours: step over the head only, so the value is scanned for heads.
      head.lastIndex = valueStart;
      continue;
    }
    let open = "";
    let afterText = "";
    let value = "";
    let end = -1;

    const quote = matchAt(OPENING_QUOTE, text, valueStart);
    if (quote !== undefined) {
      let p = valueStart + quote.length;
      const a = after ? (matchAt(after, text, p) ?? "") : "";
      p += a.length;
      const openUnicode = quote.endsWith("u0022") || quote.endsWith("u0027");
      const depth = quote.length - (openUnicode ? 5 : 1);
      const quoteChar = openUnicode
        ? quote.endsWith("u0022") ? 34 : 39
        : quote.charCodeAt(quote.length - 1);
      const valueEnd = scanQuotedValue(text, p, depth, quoteChar, openUnicode);
      if (valueEnd > p) {
        open = quote;
        afterText = a;
        value = text.slice(p, valueEnd);
        end = valueEnd;
      }
    }
    if (end < 0) {
      let p = valueStart;
      const a = after ? (matchAt(after, text, p) ?? "") : "";
      p += a.length;
      const v = matchAt(unquoted, text, p);
      if (v !== undefined && v.length > 0) {
        afterText = a;
        value = v;
        end = p + v.length;
      }
    }
    if (end < 0) {
      head.lastIndex = start + 1;
      continue;
    }
    out +=
      text.slice(copied, start) +
      render({
        match: text.slice(start, end),
        head: headText,
        open,
        after: afterText,
        value,
      });
    copied = end;
    head.lastIndex = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// Generic x-api-key header redaction
const X_API_KEY_PATTERN = fieldSpec({
  head: `x-api-key${OPT_QUOTE}\\s*[:=]\\s*`,
  unquoted: SECRET_VALUE,
});

// Authorization header / Bearer token redaction
const AUTHORIZATION_PATTERN = fieldSpec({
  head: `authorization${OPT_QUOTE}\\s*[:=]\\s*`,
  after: String.raw`bearer\s+`,
  unquoted: SECRET_VALUE,
});

// Groups: 1 = name, quote and separator; 2 = the value's opening quote, if any.
const PEM_HEAD = new RegExp(
  `(private[-_]?key${OPT_QUOTE}\\s*[:=]\\s*)(\\\\*["']|\\\\+u00(?:22|27))?-{3,}BEGIN`,
  "gi",
);
const PEM_END = /END/gi;
const PEM_END_TAIL = /\s+(?:\w+\s+)?PRIVATE\s+KEY-{3,}/iy;

/**
 * Index of the first blank line (`\n` + optional spaces + `\n`, either with an
 * optional `\r`) in `text[from, limit)`, or -1. Looks at the span only, so a
 * caller that resumes at `limit` reads each character once.
 */
function findBlankLine(text: string, from: number, limit: number): number {
  let i = text.indexOf("\n", from);
  while (i !== -1 && i < limit) {
    let j = i + 1;
    while (j < limit && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (j < limit && text.charCodeAt(j) === 13 /* \r */) j++;
    if (j < limit && text.charCodeAt(j) === 10) {
      return i > from && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
    }
    i = text.indexOf("\n", i + 1);
  }
  return -1;
}

/**
 * `private_key: -----BEGIN ... PRIVATE KEY-----` blocks, redacted whole.
 * Single forward scan: each `BEGIN` looks for the first valid `-----END ...
 * PRIVATE KEY-----` after it, and once one search finds none, no later `BEGIN`
 * can either, so a text with many BEGINs and no END is read once, not once per
 * BEGIN (a lazy `[\s\S]*?` made that quadratic).
 *
 * A key that is cut off (a BEGIN with no END, e.g. a truncated log line) is
 * redacted from its BEGIN to the first blank line, or to the end of the text:
 * leaving the body would leak the key. Real keys keep exactly the old output.
 */
function redactPemBlocks(text: string): string {
  let out = "";
  let copied = 0;
  let noEndAnywhere = false;
  PEM_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEM_HEAD.exec(text)) !== null) {
    const from = m.index + m[0].length;
    let end = -1;
    if (!noEndAnywhere) {
      PEM_END.lastIndex = from;
      let e: RegExpExecArray | null;
      while ((e = PEM_END.exec(text)) !== null) {
        let k = e.index;
        while (k > from && text.charCodeAt(k - 1) === 45 /* - */) k--;
        if (e.index - k < 3) continue;
        PEM_END_TAIL.lastIndex = e.index + 3;
        const tail = PEM_END_TAIL.exec(text);
        if (tail) {
          end = e.index + 3 + tail[0].length;
          break;
        }
      }
      // No END after this BEGIN, so none after any later one.
      if (end < 0) noEndAnywhere = true;
    }
    if (end < 0) {
      // A key inside a quoted (possibly escaped) JSON string ends at that
      // string's own closing quote: escaped `\\n` never forms a blank line.
      let limit = text.length;
      const quote = m[2];
      if (quote !== undefined) {
        const unicode = quote.endsWith("u0022") || quote.endsWith("u0027");
        const depth = quote.length - (unicode ? 5 : 1);
        const quoteChar = unicode
          ? quote.endsWith("u0022") ? 34 : 39
          : quote.charCodeAt(quote.length - 1);
        limit = scanQuotedValue(text, from, depth, quoteChar, unicode);
        // The scanner also stops at a raw newline. A raw multi-line quoted
        // string (YAML/TOML style) is not bounded by its first line break, so
        // that stop says nothing about where the key ends: use the blank-line
        // rule instead. A real closing quote keeps the bound.
        if (limit < text.length && text.charCodeAt(limit) === 10) {
          limit = text.length;
        }
      }
      const blank = findBlankLine(text, from, limit);
      end = blank >= 0 ? blank : limit;
    }
    out += text.slice(copied, m.index) + m[1] + (m[2] ?? "") + "[REDACTED]";
    copied = end;
    PEM_HEAD.lastIndex = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// Bare Bearer token (without preceding key name)
const BARE_BEARER_PATTERN =
  /(?<![A-Za-z0-9_-])Bearer\s+[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9_-])/gi;

// JWT tokens (three base64url segments, 8+ chars each)
const JWT_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

// AWS_* / GOOGLE_* / provider-prefixed env var redaction. The whole name is
// matched once, from a word start, and kept only when it contains an `AWS_`/
// `GOOGLE_` segment (`AWS_X`, `STAGING_AWS_SECRET_ACCESS_KEY`, `DEV_GOOGLE_...`):
// trying every `AWS_` inside a long word as a start would be quadratic, and a
// lookbehind that skips prefixed names would leak exactly the names CI uses.
const PROVIDER_PREFIXED_NAME = /(?:^|[_-])(?:AWS|GOOGLE)[_-]/i;
const PROVIDER_PREFIXED_ENV_PATTERN = fieldSpec({
  lookbehind: "(?<![A-Za-z0-9_-])",
  head: `[A-Za-z0-9_-]+${OPT_QUOTE}\\s*[:=]\\s*`,
  unquoted: ENV_VALUE,
  keep: (head) => PROVIDER_PREFIXED_NAME.test(head),
});

// Generic credential env var names (*_API_KEY, *_SECRET, *_TOKEN, *_PASSWORD)
// with strict negative lookarounds so we don't redact normal text that
// happens to contain "API_KEY=" mid-sentence.
const GENERIC_CREDENTIAL_ENV_PATTERN = fieldSpec({
  lookbehind: "(?<![A-Za-z0-9_-])",
  head: `(?:[A-Za-z0-9_]*_)?(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)${OPT_QUOTE}\\s*[:=]\\s*`,
  unquoted: SECRET_VALUE,
});

// Header-style key-value: x-api-key, authorization, bearer, api_key, token,
// access_token, refresh_token, secret, password, cookie, set-cookie, id_token,
// private_key. This is the catch-all for "the secret sits next to a known
// field name in arbitrary text" — header dumps, log lines, error payloads.
const GENERIC_HEADER_FIELD_PATTERN = fieldSpec({
  head: `(?:x-api-key|x[-_]?auth|authorization|auth|bearer|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|cookie|set[-_]?cookie|id[-_]?token|exchanged[-_]?api[-_]?key|trusted[-_]?device[-_]?token|private[-_]?key|chatgpt[-_]?account[-_]?id)${OPT_QUOTE}\\s*[:=]\\s*`,
  // Skipped over, not kept: only the value is redacted.
  after: String.raw`bearer\s+`,
  unquoted: SECRET_VALUE,
});

// Cookie/Set-Cookie header values — scoped to header-shaped text only (not URL
// query params) via negative lookbehind on ? or &. Uses a permissive value
// character class that allows `;` and `,` so semicolon-delimited attributes
// (e.g. `sessionKey=abc123; Path=/; Secure`) and comma-joined multi-cookie
// values (e.g. `sid=one, refresh=two`) are fully redacted. This runs first in
// redactSensitiveInfo so the generic pattern below (which stops at `;`) never
// sees partial cookie values.
const COOKIE_PATTERN = fieldSpec({
  lookbehind: "(?<![?&;])",
  head: `(?:set[-_]?cookie|(?<!set[-_])cookie)${OPT_QUOTE}\\s*[:=]\\s*`,
  unquoted: COOKIE_VALUE,
});

// Substrings that flag a JSON field name as a credential container, used by
// `jsonRedactor`. Normalized keys (lowercased, dashes/underscores stripped)
// are checked against this list. `privatekey` is here so a JSON object
// like `{ "private_key": "..." }` (or `{ "privateKey": "..." }`) gets its
// value collapsed to `'[REDACTED]'` regardless of value shape — the
// header-field regex below handles the same key in inline key=value text.
const SENSITIVE_FIELD_SUBSTRINGS = [
  "token",
  "apikey",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "bearer",
  "privatekey",
] as const;

// Bare auth-style header keys that should be matched exactly (not as a
// substring) to avoid false positives like "author", "oauthProvider",
// "authenticationMode".
const AUTH_WHOLE_WORDS = new Set(["auth", "xauth"]);

/**
 * Build a regex matching a known credential env-var name on the left side of
 * an `=` or `:` assignment, e.g. `OPENAI_API_KEY=...` or `GITHUB_TOKEN: ...`.
 * Generated from `getKnownProviderSecretEnvKeys()` so a new provider added
 * to the descriptor registry is automatically covered.
 */
function buildKnownEnvVarPattern(): FieldSpec {
  const keys = getKnownProviderSecretEnvKeys();
  if (keys.length === 0) {
    // Should never happen in practice (FALLBACK_SECRET_ENV_KEYS is non-empty),
    // but returning a non-matching pattern keeps the call site branchless.
    return fieldSpec({ head: "(?!)", unquoted: "(?!)" });
  }
  // Sort longest-first so OPENAI_API_KEY is tried before API_KEY would be.
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return fieldSpec({
    lookbehind: "(?<![A-Za-z0-9_])",
    head: `(?:${escaped.join("|")})${OPT_QUOTE}\\s*[:=]\\s*`,
    unquoted: ENV_VALUE,
  });
}

let cachedEnvVarPattern: FieldSpec | null = null;
function getKnownEnvVarPattern(): FieldSpec {
  if (cachedEnvVarPattern === null) {
    cachedEnvVarPattern = buildKnownEnvVarPattern();
  }
  return cachedEnvVarPattern;
}

/**
 * Reset the cached env-var pattern. Test-only escape hatch; production code
 * should not need this.
 * @internal
 */
export function _resetRedactionCacheForTesting(): void {
  cachedEnvVarPattern = null;
}

/**
 * Redact known secret values from a free-form string.
 *
 * Applies a fixed sequence of regexes covering well-known credential
 * formats (Anthropic, OpenAI, AWS, GCP, GitHub) plus generic env-var and
 * header-field patterns. Safe to call inline on log lines or error
 * messages; cost is one pass per pattern.
 */
export function redactSensitiveInfo(text: string): string {
  let redacted = text;

  // Anthropic API keys (sk-ant...)
  redacted = redacted.replace(ANTHROPIC_KEY_PATTERN, "[REDACTED_API_KEY]");

  // OpenAI / Codex / OpenRouter API keys
  redacted = redacted.replace(OPENAI_KEY_PATTERN, "[REDACTED_OPENAI_KEY]");

  // AWS access keys (AKIA...) and labeled debug output ("AWS key: \"...\"")
  redacted = redacted.replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED_AWS_KEY]");
  redacted = redacted.replace(
    AWS_KEY_LABELED_PATTERN,
    'AWS key: "[REDACTED_AWS_KEY]"',
  );

  // Google Cloud / Gemini API keys
  redacted = redacted.replace(GCP_KEY_PATTERN, "[REDACTED_GCP_KEY]");

  // Vertex AI service account emails
  redacted = redacted.replace(
    GCP_SERVICE_ACCOUNT_PATTERN,
    "[REDACTED_GCP_SERVICE_ACCOUNT]",
  );

  // GitHub tokens
  redacted = redacted.replace(GITHUB_TOKEN_PATTERN, "[REDACTED_GITHUB_TOKEN]");

  // x-api-key header values
  redacted = replaceFields(
    redacted,
    X_API_KEY_PATTERN,
    (f) => `${f.head}${f.open}[REDACTED_API_KEY]`,
  );

  // Authorization: Bearer ... headers
  redacted = replaceFields(
    redacted,
    AUTHORIZATION_PATTERN,
    (f) => `${f.head}${f.open}${f.after}[REDACTED_TOKEN]`,
  );

  // Bare Bearer token (no preceding key name) — runs before env-var patterns
  // so OPENAI_AUTH_HEADER_VALUE=Bearer secret-value is caught by the Bearer
  // pattern (the env-var regex stops at the first space in multi-word values).
  redacted = redacted.replace(BARE_BEARER_PATTERN, "[REDACTED_TOKEN]");

  // Bare JWT token (three base64url segments)
  redacted = redacted.replace(JWT_TOKEN_PATTERN, "[REDACTED_TOKEN]");

  // AWS_*/GOOGLE_* env vars
  redacted = replaceFields(
    redacted,
    PROVIDER_PREFIXED_ENV_PATTERN,
    (f) => `${f.head}${f.open}[REDACTED]`,
  );

  // Known provider env vars (from descriptor registry)
  redacted = replaceFields(
    redacted,
    getKnownEnvVarPattern(),
    (f) => `${f.head}${f.open}[REDACTED]`,
  );

  // Generic *_API_KEY / *_SECRET / *_TOKEN / *_PASSWORD env vars
  redacted = replaceFields(
    redacted,
    GENERIC_CREDENTIAL_ENV_PATTERN,
    (f) => `${f.head}${f.open}[REDACTED]`,
  );

  // PEM private keys — the generic header-field pattern below only captures
  // up to the first whitespace, so a value like
  // `private_key: -----BEGIN RSA PRIVATE KEY-----\n...` would redact only
  // the `-----BEGIN` prefix and leak the rest. This pass consumes the full
  // multi-line PEM block before the generic regex touches it.
  redacted = redactPemBlocks(redacted);

  // Cookie/Set-Cookie header values — permissive `;`-allowing pass runs
  // before GENERIC_HEADER_FIELD_PATTERN (which stops at `;`) so
  // semicolon-delimited cookie attributes are fully redacted.
  redacted = replaceFields(
    redacted,
    COOKIE_PATTERN,
    (f) => `${f.head}${f.open}[REDACTED]`,
  );

  // Catch-all: any of the standard credential field names with a value
  redacted = replaceFields(redacted, GENERIC_HEADER_FIELD_PATTERN, (f) => {
    // Only bypass if the value is EXACTLY the canonical placeholder
    // "[REDACTED]" produced by this generic pattern. Reject any other
    // variation like "[REDACTED_API_KEY]" or "[REDACTED_actual_secret]"
    // which may carry a real secret suffix.
    if (f.value === "[REDACTED]") return f.match;
    return `${f.head}${f.open}[REDACTED]`;
  });

  // URLs embedded in free-form text or serialized objects
  redacted = redacted.replace(
    /\/\/[^/@\s?#]+(?::[^/@\s?]*)?@/g,
    "//redacted@",
  );

  // Post-processing: absorb any trailing brackets, parens, or braces that may
  // remain after a value capture consumed part of a bracketed value. This is a
  // safety net for edge cases where a delimiter-based match ends before a
  // closing delimiter.
  redacted = redacted.replace(
    /\[REDACTED\](?:\[[^\]]*\]|[)\]}])+/g,
    "[REDACTED]",
  );

  // Redact sensitive query params in `https?://` and protocol-relative `//`
  // URLs embedded in free-form text, log lines, and error messages. This
  // catches query params like `signature=SECRET123` that the generic key-value
  // patterns don't cover, even when another param was already redacted by a
  // generic pattern (e.g. `api_key=XXX` matched by GENERIC_HEADER_FIELD_PATTERN).
  redacted = redacted.replace(
    /(?:https?:)?\/\/[^\s"',)}>\\]+/gi,
    (url) => redactUrlForDisplay(url),
  );

  // Post-processing: absorb any `&<text>` or `;<text>` segments that trail a
  // redacted placeholder. These appear only in non-URL contexts (URL redaction
  // above converts `[REDACTED]` → `redacted` before this pass runs), so safe
  // URL query params like `&mode=test` are preserved and non-URL value
  // continuations like `DATABASE_PASSWORD=correct&horse=battery` are collapsed.
  redacted = redacted.replace(
    /(\[REDACTED(?:_[A-Z_]+)?\])([&;][^\s"'&;]+)*/g,
    "$1",
  );

  return redacted;
}

/**
 * `JSON.stringify` replacer that redacts credential-shaped values.
 *
 * - If the key looks like a credential field (token, api_key, password,
 *   etc.), the value is replaced with `'[REDACTED]'` regardless of its
 *   type — preventing accidentally-unredacted objects from slipping
 *   through.
 * - Otherwise, string values are passed through `redactSensitiveInfo`
 *   so secrets embedded in free-form text are still caught.
 */
export function jsonRedactor(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");

  // Allow token usage fields through — they contain "token" but are not
  // secrets. Non-numeric values under these keys could be credential
  // containers (e.g. tokens: ["opaque-secret"]) so only numbers pass through;
  // string/array/object values are collapsed to "[REDACTED]".
  const EXCLUDED_KEYS = [
    "inputtokens",
    "outputtokens",
    "tokens",
    "cachereadinputtokens",
    "cachecreationinputtokens",
    "maxtokens",
    "tokensremaining",
    "tokencount",
    "totaltokens",
    "prompttokens",
    "completiontokens",
  ];
  if (EXCLUDED_KEYS.includes(normalizedKey)) {
    if (typeof value === "number") return value;
    return "[REDACTED]";
  }

  // Exact-match for auth-style keys to avoid false positives (e.g. "author").
  if (AUTH_WHOLE_WORDS.has(normalizedKey)) {
    return "[REDACTED]";
  }

  if (SENSITIVE_FIELD_SUBSTRINGS.some((s) => normalizedKey.includes(s))) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    // Route URL-shaped strings through the URL redaction helper first so
    // signed-URL query params (signature, sig, etc.) that redactSensitiveInfo
    // doesn't cover are still masked. Covers both https:// and protocol-relative
    // //host URLs. Non-URL strings pass through unchanged to avoid the fallback
    // path in redactUrlForDisplay treating # as a fragment delimiter on ordinary
    // text.
    const urlRedacted = /^(?:https?:)?\/\//i.test(value)
      ? redactUrlForDisplay(value)
      : value;
    return redactSensitiveInfo(urlRedacted);
  }

  return value;
}

// ---------------------------------------------------------------------------
//                             URL redaction
// ---------------------------------------------------------------------------

const SENSITIVE_URL_QUERY_PARAM_TOKENS = [
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "refresh_token",
  "signature",
  "sig",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "cookie",
  "set-cookie",
] as const;

/**
 * Single source of truth for "which query-param names look like
 * credentials". Used by `redactUrlForDisplay` and by external callers
 * (notably `openaiShim.redactUrlForDiagnostics`) that need the same
 * coverage as `redactUrlForDisplay` instead of forking a copy that
 * drifts.
 *
 * The same list also drives the malformed-URL fallback regex
 * `MALFORMED_URL_PARAM_PATTERN` below — both paths must agree on
 * which parameter names are sensitive. Any addition to this list
 * automatically extends the fallback coverage.
 */
export function shouldRedactUrlQueryParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_URL_QUERY_PARAM_TOKENS.some((token) =>
    lower.includes(token),
  );
}

/**
 * Per-query-param redaction for the malformed-URL fallback path.
 *
 * `shouldRedactUrlQueryParam` uses substring semantics: any param
 * whose name contains a sensitive token (e.g. `my_api_key`,
 * `x_access_token`) is matched. The function below iterates over the
 * URL's `?…&…` segment and substitutes each value, mirroring the
 * primary path's `parsed.searchParams.keys()` loop.
 *
 * Fragments are always dropped to prevent credential leaks, matching
 * the valid-URL path which sets `parsed.hash = ''`.
 */
function redactMalformedQuery(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf("#");
  const noFragment = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
  const queryStart = noFragment.indexOf("?");
  if (queryStart === -1) return noFragment;
  const prefix = noFragment.slice(0, queryStart + 1);
  const query = noFragment.slice(queryStart + 1);
  const redacted = redactSensitiveQuerySegments(query);
  return prefix + redacted;
}

/**
 * Post-process a URL string to redact sensitive query parameters that
 * were delimited by `;` instead of `&`.  `URLSearchParams` doesn't split
 * on `;` (it treats the entire span between two `&` as one key-value
 * pair), so keys like `token` or `api_key` inside `;`-delimited segments
 * are invisible to the standard `parsed.searchParams` loop.
 *
 * This function is applied as a final pass on both the valid-URL and
 * fallback paths so that the behavior is consistent regardless of how
 * the URL was originally parsed.
 */
function redactSensitiveQuerySegments(query: string): string {
  return query.replace(
    /(^|[&;])([^&=;]+)(?:=([^&;]*))?/g,
    (match, delim, rawKey) => {
      let key: string;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        key = rawKey;
      }
      if (shouldRedactUrlQueryParam(key)) {
        return `${delim}${rawKey}=redacted`;
      }
      return match;
    },
  );
}

function redactSemicolonQueryParams(urlStr: string): string {
  if (!urlStr.includes(";")) return urlStr;
  const qs = urlStr.indexOf("?");
  if (qs === -1) return urlStr;
  const prefix = urlStr.slice(0, qs + 1);
  const hashIdx = urlStr.indexOf("#", qs);
  const queryEnd = hashIdx === -1 ? urlStr.length : hashIdx;
  const query = urlStr.slice(qs + 1, queryEnd);
  const suffix = hashIdx === -1 ? "" : urlStr.slice(hashIdx);

  const cleaned = redactSensitiveQuerySegments(query);
  if (cleaned === query) return urlStr;
  return prefix + cleaned + suffix;
}

export function redactUrlForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) {
      parsed.username = "redacted";
    }
    if (parsed.password) {
      parsed.password = "redacted";
    }

    // Pre-redact semicolon-delimited sensitive query params from the raw
    // query string. URLSearchParams percent-encodes `;` as `%3B`, so the
    // post-process pass (redactSemicolonQueryParams) cannot find
    // `;token=SECRET` after parsed.toString() reserializes the URL.
    // Only consider `?` that appears before any `#` — a `?` inside a
    // fragment is not a query separator.
    const hashIdx = rawUrl.indexOf("#");
    const qsStart = rawUrl.indexOf("?");
    if (qsStart !== -1 && (hashIdx === -1 || qsStart < hashIdx)) {
      const rawQuery =
        hashIdx === -1
          ? rawUrl.slice(qsStart + 1)
          : rawUrl.slice(qsStart + 1, hashIdx);
      parsed.search = redactSensitiveQuerySegments(rawQuery);
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    const hashIdx = rawUrl.indexOf("#");
    let userinfoRedacted: string;

    if (hashIdx !== -1) {
      const afterHash = rawUrl.slice(hashIdx + 1);
      const atInFragment = afterHash.indexOf("@");

      if (atInFragment !== -1) {
        const afterAt = afterHash.slice(atInFragment + 1);
        const hostEnd = afterAt.search(/[/?#]/);
        const hostCandidate = hostEnd === -1 ? afterAt : afterAt.slice(0, hostEnd);
        const hostname = hostCandidate.split(":")[0];

        // If the part before # already contains a valid host (with dot,
        // localhost, IPv6, or port), then # is a fragment delimiter and
        // any @ after it is fragment content, not userinfo.
        const beforeHash = rawUrl.slice(0, hashIdx);
        const hostPart = beforeHash.startsWith("//") ? beforeHash.slice(2) : beforeHash;
        const fragmentBeforeAt = afterHash.slice(0, atInFragment);
        const hasValidHostBeforeHash =
          hostPart.includes(".") ||
          hostPart === "localhost" ||
          /^\[/.test(hostPart) ||
          /:[0-9]+$/.test(hostPart) ||
          (!hostPart.includes(":") &&
            hostPart.length > 0 &&
            /[=/?&]/.test(fragmentBeforeAt));

        if (
          !hasValidHostBeforeHash &&
          (hostname.includes(".") ||
            hostname === "localhost" ||
            /^\[/.test(hostname) ||
            hostEnd !== -1 ||
            // Bare hostname (no dot, no path) — e.g. "host" or "host:443"
            // Only apply if there's no valid host before the #
            /^[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(hostCandidate))
        ) {
          // @ after # followed by hostname-like → # is in password or username
          userinfoRedacted = rawUrl.replace(
            /\/\/[^/@\s?]+@/g,
            "//redacted@",
          );
        } else {
          // @ is fragment content → strip fragment first
          const noFragment = rawUrl.slice(0, hashIdx);
          userinfoRedacted = noFragment.replace(
            /\/\/[^/@\s?#]+(?::[^/@\s?#]*)?@/g,
            "//redacted@",
          );
        }
      } else {
        const noFragment = rawUrl.slice(0, hashIdx);
        userinfoRedacted = noFragment.replace(
          /\/\/[^/@\s?#]+(?::[^/@\s?#]*)?@/g,
          "//redacted@",
        );
      }
    } else {
      userinfoRedacted = rawUrl.replace(
        /\/\/[^/@\s?#]+(?::[^/@\s?#]*)?@/g,
        "//redacted@",
      );
    }

    return redactSemicolonQueryParams(redactMalformedQuery(userinfoRedacted));
  }
}

// ---------------------------------------------------------------------------
//                             Status redaction
// ---------------------------------------------------------------------------

/**
 * Redact a URL for /status and other public-safe diagnostic surfaces.
 *
 * Wraps `redactUrlForDisplay` (which masks user/password and sensitive
 * query params) and additionally drops the fragment, which can carry tokens
 * or session IDs and is not useful when debugging proxy/TLS issues.
 *
 * Returned URLs are safe to paste in public issues or screenshots.
 */
export function redactUrlForStatus(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  const redacted = redactUrlForDisplay(rawUrl);

  // Drop the fragment. On the well-formed path (new URL succeeded) the
  // produced string contains at most one '#', which is the fragment
  // delimiter. On the malformed/regex-fallback path there is normally no
  // '#' (userinfo containing '#' broke URL parsing and the regex consumed
  // it); slicing at a stray '#' there would only shorten already-safe
  // output, never expose a secret.
  const hashIndex = redacted.indexOf("#");
  return hashIndex === -1 ? redacted : redacted.slice(0, hashIndex);
}

/**
 * Redact a filesystem path for /status and other public-safe diagnostic
 * surfaces. Replaces a leading $HOME segment with `~` so absolute paths
 * (e.g. mTLS cert/key, CA bundle) stay useful without leaking usernames
 * or home directory layout.
 */
export function redactPathForStatus(rawPath: string): string {
  if (!rawPath) return rawPath;

  const stripTrailingSep = (path: string) => path.replace(/[\\/]+$/, "");
  const isWindowsLike = (path: string) =>
    /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
  const normalizeForCompare = (path: string) =>
    isWindowsLike(path) ? path.toLowerCase() : path;
  const normalizedRawPath = stripTrailingSep(rawPath);
  const rawPathForCompare = normalizeForCompare(normalizedRawPath);

  // Cover POSIX (`HOME`), Windows (`USERPROFILE`), and containers where
  // neither is set (`os.homedir()` reads the OS passwd db). Check each
  // candidate; redact on the first prefix match. Filter out root-like
  // candidates so a misconfigured homedir never causes mass over-redaction.
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    homedir(),
  ].filter((value): value is string =>
    Boolean(
      value && stripTrailingSep(value) && stripTrailingSep(value) !== "/",
    ),
  );

  for (const candidate of candidates) {
    const normalizedCandidate = stripTrailingSep(candidate);
    if (normalizeForCompare(normalizedCandidate) === rawPathForCompare) {
      return "~";
    }
    // Boundary check: the candidate must be followed by a path
    // separator (`/` or `\`) so `/home/alice` doesn't match
    // `/home/alice2/project`. The exact-length comparison above
    // already handles the equality case; this branch handles the
    // prefix case.
    const normalizedCandidateForCompare =
      normalizeForCompare(normalizedCandidate);
    if (
      rawPathForCompare.length > normalizedCandidateForCompare.length &&
      rawPathForCompare.startsWith(normalizedCandidateForCompare) &&
      (rawPathForCompare[normalizedCandidateForCompare.length] === "/" ||
        rawPathForCompare[normalizedCandidateForCompare.length] === "\\")
    ) {
      const suffix = normalizedRawPath.slice(normalizedCandidate.length);
      return `~${suffix}`;
    }
  }

  return rawPath;
}

// ---------------------------------------------------------------------------
//                          Diagnostic redaction
// ---------------------------------------------------------------------------

// Substrings that flag a JSON field name as a credential container, used by
// `redactDiagnosticObject`. Matches the union already defined above as
// `SENSITIVE_FIELD_SUBSTRINGS` — re-exported under the diagnostics alias
// for the existing test surface.
const DIAGNOSTIC_SECRET_KEY_PATTERN =
  /(?:api[_-]?key|auth(?:orization)?|bearer|cookie|password|passwd|pwd|private[_-]?key|refresh[_-]?token|secret|token)/i;

type SecretValuePattern = {
  pattern: RegExp;
  replacement: string;
};

const LIKELY_SECRET_VALUE_PATTERNS = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{10,}\b/g, replacement: "[redacted]" },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    replacement: "[redacted]",
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, replacement: "[redacted]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, replacement: "[redacted]" },
  {
    pattern:
      /\b((?:MISTRAL_API_KEY|mistral(?:\s+api)?\s+key)(?:\s*[:=]\s*|\s+)["']?)[A-Za-z0-9._~+/=-]{12,}(?=$|[\s"',;)\]}])/gi,
    replacement: "$1[redacted]",
  },
] satisfies SecretValuePattern[];

export type SecretEnvPresence = {
  name: string;
  present: boolean;
};

function unique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function collectProviderSecretEnvVars(): string[] {
  return unique(getKnownProviderSecretEnvKeys());
}

export function summarizeSecretEnvPresence(
  env: NodeJS.ProcessEnv,
  envVars: readonly string[] = collectProviderSecretEnvVars(),
): SecretEnvPresence[] {
  return unique(envVars).map((name) => ({
    name,
    present: Boolean(env[name]?.trim()),
  }));
}

export function redactDiagnosticUrl(
  rawUrl: string | undefined,
): string | undefined {
  if (!rawUrl) return undefined;
  const rendered = redactUrlForDisplay(rawUrl);

  // Use the URL parser on the already-redacted output to locate the precise
  // authority boundary. Both mutations are scoped exactly:
  //
  //   1. Userinfo strip — only the `scheme://[userinfo@]host:port` prefix.
  //      Path content (including any literal `//redacted@` in a proxy route)
  //      is never touched.
  //
  //   2. Trailing-slash trim — only when pathname === "/" (the bare root
  //      slash URL serialization appends when there is no real path).
  //      Meaningful paths like `/v1/` or `//proxy` are preserved as-is.
  try {
    const parsed = new URL(rendered);
    let result = rendered;

    // 1. Strip userinfo: find the `@` that belongs to the authority by
    //    searching backwards from just before the pathname starts. This
    //    avoids matching `@` characters that appear in path segments.
    if (parsed.username || parsed.password) {
      const schemeLen = parsed.protocol.length + 2; // "https://".length
      const pathStart = result.indexOf(parsed.pathname, schemeLen);
      if (pathStart !== -1) {
        const atIdx = result.lastIndexOf("@", pathStart - 1);
        if (atIdx >= schemeLen) {
          result = result.slice(0, schemeLen) + result.slice(atIdx + 1);
        }
      }
    }

    // 2. Trim the bare root slash only when pathname is exactly "/".
    //    Re-parse after the userinfo strip to get an accurate pathStart.
    if (parsed.pathname === "/") {
      const schemeLen = parsed.protocol.length + 2;
      const reparsed = new URL(result);
      const pathIdx = result.indexOf(reparsed.pathname, schemeLen);
      if (pathIdx !== -1) {
        const nextChar = result[pathIdx + 1];
        if (nextChar === undefined || nextChar === "?" || nextChar === "#") {
          result = result.slice(0, pathIdx) + result.slice(pathIdx + 1);
        }
      }
    }

    return result;
  } catch {
    // Fallback for protocol-relative and other URLs the parser rejects.
    // Scope the userinfo strip to the first `//…@host` segment only.
    const schemeEnd = rendered.indexOf("//");
    if (schemeEnd === -1) return rendered;
    const afterSlashes = rendered.slice(schemeEnd + 2);
    const slashAfterHost = afterSlashes.search(/[/?#]/);
    const hostPart =
      slashAfterHost === -1 ? afterSlashes : afterSlashes.slice(0, slashAfterHost);
    const atInHost = hostPart.indexOf("@");
    let result =
      atInHost === -1
        ? rendered
        : rendered.slice(0, schemeEnd + 2) + afterSlashes.slice(atInHost + 1);
    // Trim bare root slash for `//host/` form (no real path).
    result = result.replace(/(\/\/[^/]+)\/+$/, "$1");
    return result;
  }
}

export function redactHomePath(value: string, homeDir = homedir()): string {
  if (!value || !homeDir) return value;
  const normalizedHome = homeDir.replace(/[/\\]+$/, "");
  if (!normalizedHome) return value;
  const isWindowsLike =
    /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
  const flags = isWindowsLike ? "gi" : "g";
  return value.replace(
    new RegExp(`${escapeRegExp(normalizedHome)}(?=$|[/\\\\])`, flags),
    "~",
  );
}

export function redactLikelySecrets(value: string): string {
  // Run redactSensitiveInfo first for comprehensive coverage of all
  // well-known credential patterns (AKIA keys, x-api-key, Authorization,
  // PEM private keys, generic *_API_KEY env vars, etc.), then apply
  // LIKELY_SECRET_VALUE_PATTERNS as a catch-all for patterns that
  // redactSensitiveInfo doesn't cover (e.g. bare Bearer tokens in
  // free-form text, Mistral-specific key patterns).
  const firstPass = redactSensitiveInfo(value);
  return LIKELY_SECRET_VALUE_PATTERNS.reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, replacement),
    firstPass,
  );
}

function isDiagnosticSecretKey(key: string): boolean {
  return DIAGNOSTIC_SECRET_KEY_PATTERN.test(key);
}

function isEnvPresenceKey(key: string): boolean {
  return (
    /^[A-Z0-9_]+$/.test(key) &&
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)/.test(key)
  );
}

export function redactDiagnosticObject(value: unknown): unknown {
  return redactDiagnosticObjectInternal(value);
}

function redactDiagnosticObjectInternal(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;

  // If the parent key is a credential-sensitive name, mask the entire value
  // regardless of its type — an object under { auth: { ... } } would
  // otherwise descend and leak the inner keys. Objects under non-sensitive
  // keys (e.g. "credential" metadata in issue reports) are recursed into.
  // Preserve absent/falsey values: null and undefined are already returned
  // above; false, 0, and "" indicate the value is unset and should not be
  // misrepresented as "[set]" or "[redacted]".
  if (key && isDiagnosticSecretKey(key)) {
    if (value === false || value === "" || value === 0) return value;
    return isEnvPresenceKey(key) ? "[set]" : "[redacted]";
  }

  if (typeof value === "string") {
    return redactLikelySecrets(redactHomePath(value));
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticObjectInternal(item));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactDiagnosticObjectInternal(entryValue, entryKey);
    }
    return output;
  }

  return String(value);
}

/**
 * Try to extract the first complete JSON object from a string that may
 * contain trailing garbage after a valid JSON value.  Returns the parsed
 * object and the remaining text on success, or null on failure.
 *
 * Handles nested braces, escaped quotes inside string values, and unicode
 * escapes in keys/values (which `JSON.parse` resolves natively).
 */
function tryParseFirstJsonObject(text: string): { before: string; parsed: unknown; rest: string } | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = text.slice(start, i + 1);
          try {
            return { before: text.slice(0, start), parsed: JSON.parse(jsonStr), rest: text.slice(i + 1) };
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Redact a raw JSONL transcript string by parsing each line as JSON,
 * applying {@link jsonRedactor} as the `JSON.stringify` replacer, and
 * reassembling.  Lines that fail to parse are handled by extracting the
 * first valid JSON object, redacting it key-awarably, and preserving any
 * trailing garbage so that key-based secrets in malformed lines (e.g.
 * `{"auth":"plain-secret"} broken`) are still caught.
 */
export function redactJsonLines(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      try {
        return JSON.stringify(JSON.parse(trimmed), jsonRedactor);
      } catch {
        const extracted = tryParseFirstJsonObject(line);
        if (extracted) {
          const redacted = JSON.stringify(extracted.parsed, jsonRedactor);
          // Preserve any non-JSON prefix (e.g. log level labels) and
          // trailing garbage — both are redacted before concatenation.
          if (extracted.before || extracted.rest) {
            return (
              redactSensitiveInfo(extracted.before) +
              redacted +
              redactSensitiveInfo(extracted.rest)
            );
          }
          return redacted;
        }
        return redactSensitiveInfo(line);
      }
    })
    .join("\n");
}
