import { feature } from 'bun:bundle'

import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../commands.js'
// Use the cost-tracker wrapper (not the raw bootstrap reset) so the routing
// tally is cleared alongside cost counters on an account switch.
import { resetCostState } from '../cost-tracker.js'
import { refreshGrowthBookAfterAuthChange } from '../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../services/remoteManagedSettings/index.js'
import { stripSignatureBlocks } from '../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../utils/user.js'

/**
 * Bring session state in line with a credential change.
 *
 * `/login` and `/account` both end up here on purpose. The identity the
 * session is running under has changed in exactly the same way whether the
 * user authenticated a new account or picked an existing one, so the two
 * commands must share one reset path — a second copy would drift, and the
 * half that fell behind would leave the session holding another account's
 * cost totals, entitlements or permission grants.
 *
 * Also invoked by the usage-limit auto-switch (usageLimitSwitch.ts) through
 * the hook the REPL registers: a mid-request switch must apply the same
 * resets or the session diverges from the new credentials. Hence the
 * deliberately narrow context type — the API layer can supply these four
 * fields without owning a full command context.
 *
 * The caller is responsible for the credential write itself; this only deals
 * with the in-process consequences.
 */
export type AccountSwitchEffectsContext = Pick<
  LocalJSXCommandContext,
  'onChangeAPIKey' | 'setMessages' | 'getAppState' | 'setAppState'
>

export function applyAccountSwitchEffects(
  context: AccountSwitchEffectsContext,
): void {
  context.onChangeAPIKey()
  // Signature-bearing blocks (thinking, connector_text) are bound to the
  // API key. Strip them so the new key doesn't reject stale signatures.
  context.setMessages(stripSignatureBlocks)

  // Post-login refresh logic. Keep in sync with onboarding in
  // src/interactiveHelpers.tsx.
  resetCostState()
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  // Clear any stale trusted device token from a previous account before
  // re-enrolling to avoid sending the old token while enrollment is
  // in flight.
  clearTrustedDeviceToken()
  void enrollTrustedDevice()

  resetBypassPermissionsCheck()
  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }

  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
}
