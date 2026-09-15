/**
 * Switching which stored Claude account the CLI is running as.
 *
 * The account data itself lives in two places, and a switch has to move both.
 * `authAccounts.ts` owns the secure-storage half and deliberately knows
 * nothing about the config file; this module is where the two halves are
 * brought together.
 */

import type { AccountSummary } from './authAccounts.js'
import {
  listAccounts,
  migrateAndReconcile,
  mutateAccountsLocked,
  setActiveAccount,
} from './authAccounts.js'
import { clearOAuthTokenCache } from './auth.js'
import { clearBetasCaches } from './betas.js'
import { saveGlobalConfig } from './config.js'
import { getSecureStorage } from './secureStorage/index.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** Every stored account, reconciled, for listing and for resolving a query. */
export function readAccounts(): AccountSummary[] {
  return listAccounts(migrateAndReconcile(getSecureStorage().read() ?? {}).data)
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

  return result
}
