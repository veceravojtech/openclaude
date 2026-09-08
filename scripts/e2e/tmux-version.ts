/**
 * The PURE half of the harness's tmux version gate, split out of
 * `tui-keys.ts` so it can be unit-tested.
 *
 * `tui-keys.ts` runs `main()` at module scope and must never be collected by
 * `bun test`, so nothing in it can be imported by a test. These four - the
 * floor and the two functions that decide against it - touch no process, no
 * file system and no tmux, so they live here and `scripts/e2e/tmux-version.test.ts`
 * covers them directly. `probeTmuxVersion()` stays in the harness: it spawns
 * `tmux -V`.
 */

/**
 * Lowest tmux release this harness can drive. `new-session -e KEY=VALUE` - how
 * `startCliSession()` hands the CLI its throwaway config home - landed in tmux
 * 3.2. Older tmux dies there with `unknown option -- e`, which is exactly the
 * obscure mid-run failure that the version gate in `tui-keys.ts` - `main()`'s
 * `isTmuxTooOld` skip - replaces.
 */
export const MIN_TMUX_MAJOR = 3
export const MIN_TMUX_MINOR = 2

/**
 * major.minor out of a `tmux -V` banner, or null when it names no version.
 *
 * Deliberately lenient, and deliberately one-directional about it: the first
 * `<digits>.<digits>` that starts a token (or follows a hyphen) wins, which
 * covers every shape in the wild - `tmux 3.6b`, `tmux 3.2a`, OpenBSD's bare
 * `tmux 3.4`, and the release candidates' `tmux next-3.7`. A banner naming no
 * such number (`tmux master`, a distro-patched string) is UNKNOWN, and the
 * caller PROCEEDS on unknown: refusing a working tmux over a cosmetic version
 * string would be a far worse failure than the one this gate prevents.
 */
export function parseTmuxVersion(banner: string): { major: number; minor: number } | null {
  const match = /(?:^|[\s-])(\d+)\.(\d+)/.exec(banner)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  return { major, minor }
}

/**
 * Is this parsed version older than the floor? UNKNOWN (null) is never "too
 * old" - see `parseTmuxVersion`.
 */
export function isTmuxTooOld(version: { major: number; minor: number } | null): boolean {
  if (version === null) return false
  if (version.major !== MIN_TMUX_MAJOR) return version.major < MIN_TMUX_MAJOR
  return version.minor < MIN_TMUX_MINOR
}
