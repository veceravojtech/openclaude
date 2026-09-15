import * as React from 'react';
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import {
  accountDisplayName,
  readAccounts,
  switchAccount
} from '../../utils/accountSwitch.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import type { AccountSummary } from '../../utils/authAccounts.js';
import {
  mutateAccountsLocked,
  removeAccount
} from '../../utils/authAccounts.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';
import { applyAccountSwitchEffects } from '../applyAccountSwitchEffects.js';
/** What a logout did: signed the session out entirely, or moved it on. */
export type LogoutOutcome =
  | { signedOut: true }
  | { signedOut: false; promoted: AccountSummary };

/**
 * Sign the ACTIVE Claude account out — one account, not every account.
 *
 * `removeAccount` promotes a survivor when there is one, so a user with
 * several accounts stays logged in as the next of them and the process keeps
 * running. Only when the account signed out was the last one does this become
 * the full teardown it used to unconditionally be.
 *
 * That distinction reaches further than /logout. `installOAuthTokens` used to
 * call this to "clear old state" before saving new credentials, which wiped
 * every stored account on every login — so adding a second account silently
 * destroyed the first while reporting success.
 */
export async function performLogout({
  clearOnboarding = false
}): Promise<LogoutOutcome> {
  await removeApiKey();

  const active = readAccounts().find(a => a.isActive);
  if (active) {
    await mutateAccountsLocked(data => removeAccount(data, active.key));
    // The config identity record lives in a separate store and nothing else
    // drops it, so skipping this accumulates records describing accounts
    // whose tokens are already gone.
    saveGlobalConfig(current => {
      const identities = {
        ...(current.oauthAccounts ?? {})
      };
      delete identities[active.key];
      return {
        ...current,
        oauthAccounts: identities
      };
    });
  }

  // `removeAccount` has already promoted a survivor and re-pointed the token
  // mirror inside its lock. Routing that promotion back through
  // `switchAccount` re-points the config identity mirror and clears the
  // account-scoped caches — the two things every other switch owes — rather
  // than growing a second copy of them here.
  const promoted = readAccounts().find(a => a.isActive);
  if (promoted) {
    await switchAccount(promoted.key);
    return {
      signedOut: false,
      promoted
    };
  }

  // Nobody left. This is the teardown /logout has always performed, kept as
  // it was: the whole secure-storage blob goes, which is broader than the
  // Claude half — it also holds MCP server tokens, plugin secrets and a
  // second provider's credentials. The bug being fixed here is that this ran
  // on paths that were not a full logout, not that a full logout does too much.
  const secureStorage = getSecureStorage();
  secureStorage.delete();
  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = {
      ...current
    };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: []
        };
      }
    }
    updated.oauthAccount = undefined;
    return updated;
  });
  return {
    signedOut: true
  };
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.();
  clearTrustedDeviceTokenCache();
  clearBetasCaches();
  clearToolSchemaCache();

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache();

  // Clear policy limits cache
  await clearPolicyLimitsCache();
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const outcome = await performLogout({
    clearOnboarding: true
  });

  // Another account took over, so the session is still authenticated and must
  // NOT be shut down. It is running as a different identity now and owes the
  // same reset a deliberate switch does.
  if (!outcome.signedOut) {
    applyAccountSwitchEffects(context);
    onDone(`Signed out. Now using ${accountDisplayName(outcome.promoted)}.`);
    return null;
  }

  const message = <Text>Successfully logged out from your Anthropic account.</Text>;
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);
  return message;
}
