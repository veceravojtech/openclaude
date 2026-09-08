/**
 * Opus version parsing shared by the model capability gates.
 *
 * Every gate used to be a hand-maintained substring chain
 * (`includes('opus-4-8') || includes('opus-4-7') || …`). That silently treats
 * any Opus the chain does not know about — including whatever the dynamic
 * "latest Opus" resolver hands back after the next launch — as a legacy model
 * with no adaptive thinking, no effort control, and a 200K window. Parsing the
 * version once and comparing numerically keeps newer Opus releases on the
 * modern code paths without another launch-day edit.
 */

export type OpusVersion = { major: number; minor: number }

// Matches `opus-4-8`, `opus-4.8`, `opus_4_8`, `opus-5`, `opus-5-1` inside any
// first-party, Bedrock, Vertex, or gateway-prefixed id. Major and minor are
// capped at two digits and must not be followed by another digit, so date
// suffixes (`claude-opus-4-20250514`, `claude-opus-4-1-20250805`) and the
// Claude 3 era (`claude-3-opus-20240229`) never parse as a version.
const OPUS_VERSION_RE = /opus[-_.](\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/

export function parseOpusVersion(model: string): OpusVersion | null {
  const match = OPUS_VERSION_RE.exec(model.toLowerCase())
  if (!match) {
    return null
  }
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
  }
}

export function compareOpusVersions(a: OpusVersion, b: OpusVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor
}

/** True when `model` is an Opus id at or above `major.minor` (e.g. 4.6). */
export function isOpusAtLeast(
  model: string,
  major: number,
  minor = 0,
): boolean {
  const version = parseOpusVersion(model)
  return version !== null && compareOpusVersions(version, { major, minor }) >= 0
}

/** `claude-opus-5`, `claude-opus-5-1` — the canonical first-party id shape. */
export function canonicalOpusId(version: OpusVersion): string {
  return version.minor === 0
    ? `claude-opus-${version.major}`
    : `claude-opus-${version.major}-${version.minor}`
}

/** `Opus 5`, `Opus 5.1`, `Opus 4.8` — the public marketing name shape. */
export function formatOpusMarketingName(version: OpusVersion): string {
  return version.minor === 0
    ? `Opus ${version.major}`
    : `Opus ${version.major}.${version.minor}`
}
