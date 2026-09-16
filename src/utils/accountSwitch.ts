/**
 * Switching which stored Claude account the CLI is running as.
 *
 * The account data itself lives in two places, and a switch has to move both.
 * `authAccounts.ts` owns the secure-storage half and deliberately knows
 * nothing about the config file; this module is where the two halves are
 * brought together.
 */

import { projectActiveAccountLimits } from '../services/claudeAiLimits.js'
import type { AccountSummary } from './authAccounts.js'
import {
  listAccounts,
  migrateAndReconcile,
  mutateAccountsLocked,
  setActiveAccount,
  vouchableAccountKeys,
} from './authAccounts.js'
import { clearOAuthTokenCache } from './auth.js'
import { clearBetasCaches } from './betas.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getSecureStorage } from './secureStorage/index.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/**
 * Every stored account, reconciled, for listing and for resolving a query.
 *
 * The config identity map is joined in HERE rather than inside
 * `listAccounts`: `authAccounts.ts` is deliberately config-free, and this
 * module is where the two halves are brought together. `config.oauthAccounts`
 * is keyed by the same account UUIDs the credential map uses and already
 * holds the email, so an account written before the credential blob carried
 * identity — every account already on disk — gets its name back without
 * unlocking the keychain and without rewriting a single credential.
 *
 * Read-only, deliberately: naming an account must never write one. A backfill
 * into the credential store would be undone by the next identity-less mirror
 * write anyway, so the join stays on the read side.
 */
export function readAccounts(): AccountSummary[] {
  return listAccounts(
    migrateAndReconcile(getSecureStorage().read() ?? {}).data,
    getGlobalConfig().oauthAccounts,
  )
}

/**
 * Keys of every stored account the client can vouch for as an AUTO-switch
 * target — the subset a usage-limit 429 is allowed to move the user onto.
 *
 * The same read and the same reconcile as `readAccounts`, deliberately: an
 * entry only the other path can see could still be selected. `now` is a
 * parameter so tests can pin the expiry boundary instead of racing the clock.
 *
 * Read-only, like `readAccounts` — nothing here writes, re-keys or deletes a
 * credential entry. An entry the client cannot vouch for is left on disk
 * exactly as it is; it just stops being selectable.
 */
export function readVouchableAccountKeys(now?: number): Set<string> {
  return vouchableAccountKeys(
    migrateAndReconcile(getSecureStorage().read() ?? {}).data,
    now ?? Date.now(),
  )
}

/**
 * How an account is named in UI.
 *
 * The email is the only part a user reliably recognises; the label is a local
 * nickname that may not be set, and the key is a UUID shown only because
 * naming an account badly beats naming it wrongly.
 */
export function accountDisplayName(account: AccountSummary): string {
  return account.emailAddress ?? account.label ?? account.key
}

/**
 * How an account is named where the naming LEAVES the user's screen.
 *
 * The same resolution as `accountDisplayName` minus the email address, and
 * the omission is the whole point rather than an oversight: `Usage` output is
 * written into model transcripts and log files, where
 * `AccountSummary.emailAddress` is personal data that the user never chose to
 * publish. Do not "fix" this back to prefer the email the way
 * `accountDisplayName` does — that function names accounts on the user's own
 * screen, which is why the two resolutions differ.
 *
 * A label is the user's own nickname, so it is used as stored — except when
 * it is itself email-shaped. A value containing `@` is indistinguishable from
 * an address to every downstream reader and to any log scrubber, and cutting
 * it short would emit the local part, so such a label is skipped in favour of
 * the key.
 *
 * A UUID key is cut to its first block: eight hex characters, 2^32 of address
 * space, which is the same cut and the same ellipsis that `formatAccountRef`
 * already makes for error text — so one account reads identically wherever
 * the CLI has to name it off-screen. A key that is neither UUID- nor
 * email-shaped (the legacy pre-identity `default` entry) is shown as stored:
 * it holds nothing personal, and cutting it would only make short keys harder
 * to tell apart.
 */
export function accountUsageLabel(account: AccountSummary): string {
  // `??` alone would let a blank label through and name the section nothing.
  const label = account.label?.trim()
  if (label && !label.includes('@')) {
    return label
  }

  const key = account.key.trim()
  const isUuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key)
  if (isUuidLike || key.includes('@')) {
    return `${key.slice(0, 8)}…`
  }
  return key || 'unknown account'
}

export type AccountResolution =
  | { type: 'ok'; key: string }
  | { type: 'unknown' }
  | { type: 'ambiguous'; matches: AccountSummary[] }

/**
 * Resolve what the user typed to an account key.
 *
 * Matching is exact on key, then label, then email address, so a label that
 * happens to look like another account's email can never silently win. An
 * ambiguous query is reported rather than resolved to an arbitrary account:
 * picking wrong here means the user starts spending the wrong subscription.
 */
export function resolveAccountKey(
  accounts: AccountSummary[],
  query: string,
): AccountResolution {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return { type: 'unknown' }
  }

  for (const field of [
    (a: AccountSummary) => a.key,
    (a: AccountSummary) => a.label,
    (a: AccountSummary) => a.emailAddress,
  ]) {
    const matches = accounts.filter(a => field(a)?.toLowerCase() === needle)
    if (matches.length === 1) {
      return { type: 'ok', key: matches[0]!.key }
    }
    if (matches.length > 1) {
      return { type: 'ambiguous', matches }
    }
  }

  return { type: 'unknown' }
}

/**
 * Make `key` the active account.
 *
 * TWO mirrors move here, and both are load-bearing:
 *
 * 1. The token mirror. Every token reader resolves through `claudeAiOauth`
 *    (see `activeTokensFrom` in auth.ts), NOT through
 *    `claudeAiOauthAccounts[active]` — the mirror is the fresher side by
 *    design, because a refresh writes it alone. So moving
 *    `claudeAiOauthActive` on its own would leave every reader returning the
 *    PREVIOUS account's tokens: the switch would report success while the CLI
 *    kept spending the old account's subscription, with no error anywhere.
 *    `setActiveAccount` re-points the mirror in the same locked write.
 *
 * 2. The config identity mirror. `getOauthAccountInfo` reads
 *    `config.oauthAccount`, a mirror of `config.oauthAccounts[active]`.
 *    Nothing else re-points it, so skipping this leaves the status line and
 *    `openclaude auth status` naming the account the user just switched away
 *    from.
 */
export async function switchAccount(
  key: string,
): Promise<{ success: boolean; warning?: string }> {
  const result = await mutateAccountsLocked(data => setActiveAccount(data, key))
  if (!result.success) {
    return result
  }

  saveGlobalConfig(current => ({
    ...current,
    // Undefined when the identity record is missing — showing nothing beats
    // showing the account we just switched away from.
    oauthAccount: current.oauthAccounts?.[key],
  }))

  // The token reader is memoized and the keychain read is cached, so without
  // this the process keeps serving the old account's access token until the
  // cache happens to expire. Betas and tool schemas are account-scoped too;
  // the login path clears them via the token save, which a switch never does.
  clearOAuthTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  // Same reason as the three above, for the one piece of per-account state
  // that is a stored VALUE rather than a cache. `getRawUtilization` re-reads
  // the quota store on every call and so flips with the switch, but
  // `currentLimits` only moves when a response arrives - so without this the
  // status line keeps showing the quota of the account we just left until the
  // new one answers. The projection is total, so a switch can never fail on it.
  projectActiveAccountLimits()

  return result
}
