/**
 * Moving an automatic account switch onto an account whose access token has
 * expired — refreshing its credential first, and keeping the switch only if that
 * refresh produces a live token.
 *
 * vouchForAccount refuses an expired account outright, which is right for a
 * switch that presents a token as-is. But the other account in a fallback pool
 * is by definition the one not in use, so its short-lived access token is
 * almost always expired while its refresh token is fine: with that rule alone,
 * a usage-limit fallback works only for the hour after the other account was
 * last used, and afterwards every 429 waits out the reset instead.
 *
 * Kept in its own module on purpose: usageLimitSwitch is imported across much of
 * the tree, and several tests replace accountSwitch.js and auth.js with partial
 * stubs. New named imports from those modules would fail to link wherever a stub
 * lacks them, so this module statically imports only names those stubs already
 * provide, and loads the refresh machinery lazily inside the switch.
 */

import { switchAccount } from './accountSwitch.js'
import {
  type AccountIdentities,
  accountKeyForTokens,
  migrateAndReconcile,
  vouchForAccount,
} from './authAccounts.js'
import { getGlobalConfig } from './config.js'
import {
  getSecureStorage,
  type SecureStorageData,
} from './secureStorage/index.js'

/**
 * Keys of stored accounts that fail vouching ONLY because their access token
 * has expired: they hold a refresh token, and the client can say whose account
 * each is — from the credential blob, or from the config identity map, the same
 * rule vouchableAccountKeys applies. An account with no refresh token, or one
 * nothing can name, is never a candidate.
 */
export function refreshableAccountKeys(
  data: SecureStorageData,
  now: number,
  identities: AccountIdentities = {},
): Set<string> {
  const accounts = data.claudeAiOauthAccounts ?? {}
  const refreshable = new Set<string>()
  for (const [key, account] of Object.entries(accounts)) {
    if (vouchForAccount(account, now) !== 'expired') continue
    const joined = identities[key]?.emailAddress
    const nameable =
      accountKeyForTokens(account) !== undefined ||
      (typeof joined === 'string' && joined !== '')
    if (nameable) refreshable.add(key)
  }
  return refreshable
}

/** The reading counterpart of refreshableAccountKeys — the same read and join readVouchableAccountKeys does. */
export function readRefreshableAccountKeys(now?: number): Set<string> {
  return refreshableAccountKeys(
    migrateAndReconcile(getSecureStorage().read() ?? {}).data,
    now ?? Date.now(),
    getGlobalConfig().oauthAccounts,
  )
}

export type FreshCredentialSwitchDeps = {
  switchAccount: (key: string) => Promise<{ success: boolean; warning?: string }>
  /** Refresh the ACTIVE account's token if it has expired. */
  refreshActiveToken: () => Promise<unknown>
  /** Whether the ACTIVE account now holds an unexpired access token. */
  activeTokenIsLive: () => Promise<boolean>
}

const productionDeps: FreshCredentialSwitchDeps = {
  switchAccount: key => switchAccount(key),
  refreshActiveToken: async () => {
    const { checkAndRefreshOAuthTokenIfNeeded } = await import('./auth.js')
    // Not forced: the account is expired, so the normal expiry check runs the
    // refresh. The force path's gate is deliberately left untouched.
    return checkAndRefreshOAuthTokenIfNeeded()
  },
  activeTokenIsLive: async () => {
    const { getClaudeAIOAuthTokens } = await import('./auth.js')
    const { isOAuthTokenExpired } = await import('../services/oauth/client.js')
    const tokens = getClaudeAIOAuthTokens()
    return Boolean(tokens?.accessToken) && !isOAuthTokenExpired(tokens!.expiresAt ?? null)
  },
}

/**
 * Switch to `key`, obtain a fresh credential for it through the ordinary refresh
 * path, and keep the switch only if a live token results; otherwise switch back
 * to `previousKey`, so the session never stays on an account it cannot use.
 *
 * This is what a manual `/account <email>` followed by a request already does —
 * the switch, then the normal refresh with its lock, identity-preserving write
 * and fail-fast on a revoked grant — plus the undo when the refresh does not
 * produce a live token. Success is judged by re-reading the active token rather
 * than by the refresh's return value, which is also false when another process
 * refreshed the token first.
 */
export async function switchToAccountWithFreshCredential(
  key: string,
  previousKey: string | undefined,
  deps: FreshCredentialSwitchDeps = productionDeps,
): Promise<{ success: boolean; warning?: string }> {
  const switched = await deps.switchAccount(key)
  if (!switched.success) {
    return switched
  }

  let live = false
  try {
    await deps.refreshActiveToken()
    live = await deps.activeTokenIsLive()
  } catch {
    live = false
  }
  if (live) {
    return { success: true }
  }

  if (previousKey !== undefined) {
    await deps.switchAccount(previousKey)
  }
  return {
    success: false,
    warning:
      'Could not obtain a live credential for the account to switch to; stayed on the current account.',
  }
}
