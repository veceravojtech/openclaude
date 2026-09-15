/**
 * Switching Claude accounts when the active one drains its usage limit.
 *
 * Companion to `usageLimitWait.ts`, which handles the fall-through case.
 * Priority when a foreground query hits a usage-limit 429:
 *
 *   1. Switch to another stored Claude account (this module) — it can
 *      unblock the request immediately.
 *   2. Wait out the reset clock on the current account (usageLimitWait).
 *   3. Report the limit (existing error path).
 *
 * Claude→Claude only, never across providers. A session is not compatible
 * across providers (different wire protocols, no shared cache or signature
 * validity), so the trigger is gated on the ACTIVE route being first-party
 * Anthropic — the same gate the limits/usage machinery uses — and candidates
 * come only from the Claude OAuth accounts map. Switching moves credentials
 * and identity, never the model or provider route.
 *
 * Two invariants make a switch safe mid-request:
 *
 * - Session effects must run with the switch (see the effects registry
 *   below). A storage-only switch leaves the status line, caches and
 *   signature-bearing blocks naming the old account, and the stale
 *   signatures get the retried request rejected outright. No registered
 *   effects, no switch.
 * - The account-switch epoch tells `queryModel` that credentials changed
 *   under an in-flight request, so its next attempt strips signature-bearing
 *   blocks from the request body (see `getAccountSwitchEpoch`).
 */

import type { QuerySource } from 'src/constants/querySource.js'
import {
  accountDisplayName,
  readAccounts,
  switchAccount,
} from '../../utils/accountSwitch.js'
import type { AccountSummary } from '../../utils/authAccounts.js'
import { isForegroundUsageLimitSource } from './usageLimitWait.js'

// -- session-effects registry ------------------------------------------------

/**
 * Bring the session in line with a credential change. Registered by the REPL
 * (it owns the reset context); invoked here immediately after a successful
 * `switchAccount`, never before.
 */
type AccountSwitchEffects = () => void

let accountSwitchEffects: AccountSwitchEffects | undefined

export function registerAccountSwitchEffects(effects: AccountSwitchEffects): void {
  accountSwitchEffects = effects
}

export function clearAccountSwitchEffects(): void {
  accountSwitchEffects = undefined
}

// -- account-switch epoch ------------------------------------------------------

/**
 * Monotonic count of in-request account switches performed by this module.
 *
 * `queryModel` snapshots this when it builds the request messages; if the
 * snapshot is stale on a later attempt, the credentials changed mid-request
 * and signature-bearing blocks in the captured message list are no longer
 * valid — they were signed by the previous account. The epoch exists because
 * the retry loop rebuilds params from a closure-captured message array that
 * REPL-side message updates cannot reach.
 */
let accountSwitchEpoch = 0

export function getAccountSwitchEpoch(): number {
  return accountSwitchEpoch
}

// -- candidate choice (pure) ---------------------------------------------------

/**
 * First switchable account in stored order, or undefined when every other
 * account has already been tried (or none exists).
 *
 * Deterministic by design: `readAccounts()` order, so the same exhausted
 * event walks the accounts the same way every time. The active account is
 * never a candidate — it is the one that just hit the limit.
 */
export function chooseSwitchCandidate(
  accounts: readonly AccountSummary[],
  triedKeys: ReadonlySet<string>,
): AccountSummary | undefined {
  return accounts.find(
    account => !account.isActive && !triedKeys.has(account.key),
  )
}

/**
 * Whether any stored account remains untried. The wait decision consumes
 * this: while an untried account exists, waiting out a reset is pointless —
 * but once every account has been tried, the wait (or the report) proceeds
 * on the currently active account's reset clock.
 *
 * A failure to enumerate accounts is reported as "no alternative": if we
 * cannot read the store, we cannot switch either, so waiting is the remedy
 * that still works.
 */
export function hasUntriedAlternativeAccount(
  triedKeys: ReadonlySet<string>,
): boolean {
  try {
    return readAccounts().some(
      account => !account.isActive && !triedKeys.has(account.key),
    )
  } catch {
    return false
  }
}

// -- executor -------------------------------------------------------------------

export type UsageLimitSwitchSkipReason =
  /** Not a usage-limit rejection at all. */
  | 'not-rate-limited'
  /**
   * The active route is not first-party Anthropic. Switching must never
   * cross providers, and other providers' 429s are ordinary limits.
   */
  | 'wrong-provider'
  /** A subagent, teammate, classifier or summariser — same gate as the wait. */
  | 'background-source'
  /** No session-effects hook is registered (no REPL owns this process). */
  | 'no-session-effects'
  /** Every other stored account was already tried in this request. */
  | 'no-candidate'
  /** Account enumeration failed; switching is impossible, waiting is not. */
  | 'read-failed'
  /** switchAccount failed (e.g. credential-lock contention). */
  | 'switch-failed'

export type UsageLimitSwitchOutcome =
  | { type: 'switched'; key: string; name: string }
  | { type: 'skipped'; reason: UsageLimitSwitchSkipReason }

type SwitchDeps = {
  readAccounts: () => AccountSummary[]
  switchAccount: (key: string) => Promise<{ success: boolean; warning?: string }>
}

// Getters, not values: ESM live bindings resolve late here, so a module
// mock (tests) or any future rebinding of accountSwitch is actually seen.
const productionSwitchDeps: SwitchDeps = {
  get readAccounts() {
    return readAccounts
  },
  get switchAccount() {
    return switchAccount
  },
}

/**
 * Attempt one account switch for a usage-limit rejection.
 *
 * `triedKeys` is the caller's per-request bound: every account considered is
 * added BEFORE the switch is attempted, so a failed attempt is never retried
 * against the same account within the request. The one-per-account budget is
 * what stops an exhausted account map from turning into a loop.
 */
export async function switchToNextAccountOnUsageLimit({
  status,
  isFirstParty,
  querySource,
  triedKeys,
}: {
  status: number | undefined
  isFirstParty: boolean
  querySource: QuerySource | undefined
  /** Caller's per-request set; mutated by this call (see docblock). */
  triedKeys: Set<string>
}, deps: SwitchDeps = productionSwitchDeps): Promise<UsageLimitSwitchOutcome> {
  // Cheap gates first, mirroring decideUsageLimitWait: no storage reads
  // before these pass.
  if (status !== 429) {
    return { type: 'skipped', reason: 'not-rate-limited' }
  }
  if (!isFirstParty) {
    return { type: 'skipped', reason: 'wrong-provider' }
  }
  if (!isForegroundUsageLimitSource(querySource)) {
    return { type: 'skipped', reason: 'background-source' }
  }
  const effects = accountSwitchEffects
  if (!effects) {
    return { type: 'skipped', reason: 'no-session-effects' }
  }

  let accounts: AccountSummary[]
  try {
    accounts = deps.readAccounts()
  } catch {
    // Never let a storage failure replace the 429 the user actually hit.
    return { type: 'skipped', reason: 'read-failed' }
  }
  // Seed the active account as tried: it is the one that just hit the limit.
  // This is what stops a switch A→B from considering A again on the next
  // 429 — after the switch, A is no longer active, so `isActive` alone can
  // no longer exclude it, and it is exhausted by definition.
  for (const account of accounts) {
    if (account.isActive) triedKeys.add(account.key)
  }
  const candidate = chooseSwitchCandidate(accounts, triedKeys)
  if (!candidate) {
    return { type: 'skipped', reason: 'no-candidate' }
  }

  // Claim before attempting (see docblock). The input set is the caller's
  // per-request state; mutation is the contract.
  triedKeys.add(candidate.key)
  const result = await deps.switchAccount(candidate.key)
  if (!result.success) {
    return { type: 'skipped', reason: 'switch-failed' }
  }

  // Credential write first, session effects immediately after — the two
  // halves of one switch. Bump the epoch last so queryModel never sees the
  // new epoch before storage is consistent.
  effects()
  accountSwitchEpoch++
  return { type: 'switched', key: candidate.key, name: accountDisplayName(candidate) }
}
