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
  readVouchableAccountKeys,
  switchAccount,
} from '../../utils/accountSwitch.js'
import type { AccountSummary } from '../../utils/authAccounts.js'
import { logForDebugging } from '../../utils/debug.js'
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
 * First switchable account in stored order, or undefined when no other
 * account is both untried and vouchable (or none exists at all).
 *
 * Deterministic by design: `readAccounts()` order, so the same exhausted
 * event walks the accounts the same way every time. The active account is
 * never a candidate — it is the one that just hit the limit.
 *
 * `vouchableKeys` is REQUIRED, not optional, on purpose: an optional filter
 * can be forgotten at a call site, and a forgotten filter is the bug this
 * parameter exists to prevent — a 429 moving the user onto a stored entry the
 * client cannot obtain a live credential for, or even name.
 */
export function chooseSwitchCandidate(
  accounts: readonly AccountSummary[],
  triedKeys: ReadonlySet<string>,
  vouchableKeys: ReadonlySet<string>,
): AccountSummary | undefined {
  return accounts.find(
    account =>
      !account.isActive &&
      !triedKeys.has(account.key) &&
      vouchableKeys.has(account.key),
  )
}

/**
 * Whether any stored account remains untried AND vouchable. The wait decision
 * consumes this: while a usable untried account exists, waiting out a reset is
 * pointless — but once none is left, the wait (or the report) proceeds on the
 * currently active account's reset clock.
 *
 * It applies the SAME vouchability filter as `chooseSwitchCandidate`, and that
 * coupling is load-bearing. `usageLimitWait` treats "another account is
 * available" as a reason NOT to wait. Filter the selector alone and a declined
 * switch also suppresses the wait: the user loses both remedies and gets a bare
 * limit error. Filtering both is what makes the fall-through honest.
 *
 * `deps` is defaulted explicitly rather than left unbound, so the production
 * path goes through the same filtered reads the tests exercise. Callers pass
 * one argument (`withRetry.ts`); the second exists for injection only.
 *
 * A failure to enumerate accounts is reported as "no alternative": if we
 * cannot read the store, we cannot switch either, so waiting is the remedy
 * that still works.
 */
export function hasUntriedAlternativeAccount(
  triedKeys: ReadonlySet<string>,
  deps: SwitchDeps = productionSwitchDeps,
): boolean {
  try {
    // BOTH reads inside the try: `readVouchableKeys` performs its own,
    // independent secure-storage read and can fail on its own. Left outside,
    // that failure would stop being a handled "no alternative" and become an
    // uncaught throw out of `decideUsageLimitWait`'s `otherAccountAvailable()`
    // callback — replacing the user's 429 with a crash.
    const accounts = deps.readAccounts()
    const vouchableKeys = deps.readVouchableKeys()
    return accounts.some(
      account =>
        !account.isActive &&
        !triedKeys.has(account.key) &&
        vouchableKeys.has(account.key),
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
  /**
   * Untried other accounts DO exist, but not one of them survived the vouch
   * filter — no live credential obtainable, or no identity to name it by.
   * Distinct from `no-candidate` on purpose: that one means nothing was left
   * to consider, this one means something was there and the client refused to
   * vouch for it. Collapsing them discards the only fact that separates this
   * incident from ordinary exhaustion.
   */
  | 'no-vouchable-candidate'
  /** Account enumeration failed; switching is impossible, waiting is not. */
  | 'read-failed'
  /** switchAccount failed (e.g. credential-lock contention). */
  | 'switch-failed'

export type UsageLimitSwitchOutcome =
  | { type: 'switched'; key: string; name: string }
  | { type: 'skipped'; reason: UsageLimitSwitchSkipReason }

type SwitchDeps = {
  readAccounts: () => AccountSummary[]
  readVouchableKeys: () => ReadonlySet<string>
  switchAccount: (key: string) => Promise<{ success: boolean; warning?: string }>
}

// Getters, not values: ESM live bindings resolve late here, so a module
// mock (tests) or any future rebinding of accountSwitch is actually seen.
const productionSwitchDeps: SwitchDeps = {
  get readAccounts() {
    return readAccounts
  },
  get readVouchableKeys() {
    return readVouchableAccountKeys
  },
  get switchAccount() {
    return switchAccount
  },
}

/**
 * One debug line for a declined switch, emitted on `no-vouchable-candidate`
 * only — the case where the client had somewhere to go and refused to go
 * there. Keys are truncated to 8 characters and nothing else about an account
 * is named: no email address, no label, no token, ever.
 *
 * Wrapped like `logRefreshWarning` in `mcp/refreshLock.ts`: the switch
 * decision must not depend on diagnostics, and a throw from here would
 * propagate out of the retry loop in place of the user's 429.
 */
export function formatDeclinedCandidatesForDebug(
  declined: readonly AccountSummary[],
): string {
  // Only the key, and only its first 8 characters. `emailAddress` and `label`
  // sit right there on AccountSummary, so the redaction is worth a test that
  // does not need the logger mocked to run.
  const keys = declined
    .map(account => `${account.key.slice(0, 8)}:unvouchable`)
    .join(', ')
  return `[usage-limit-switch] declined ${declined.length} untried candidate(s), none vouchable [${keys}] — no auto-switch`
}

function logDeclinedCandidates(declined: readonly AccountSummary[]): void {
  try {
    logForDebugging(formatDeclinedCandidatesForDebug(declined), {
      level: 'warn',
    })
  } catch {
    // Diagnostics must never change the outcome of the switch decision.
  }
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
  let vouchableKeys: ReadonlySet<string>
  try {
    accounts = deps.readAccounts()
    // `readAccounts()` and `readVouchableKeys()` each read secure storage
    // separately, so a concurrent writer can make the two disagree; a key in
    // one set but not the other is declined, which fails SAFE — a note, not a
    // defect. Both calls sit inside this try because the second read is its
    // own independent read and can fail on its own; outside it, that failure
    // would replace the user's 429 with an uncaught throw.
    vouchableKeys = deps.readVouchableKeys()
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
  const candidate = chooseSwitchCandidate(accounts, triedKeys, vouchableKeys)
  if (!candidate) {
    // `candidate` is undefined exactly when no untried non-active account is
    // vouchable, so every untried non-active account left IS a declined one.
    // Non-empty therefore means "something was there and the client refused to
    // vouch for it"; empty means "nothing was left to consider". The two
    // branches partition on the same predicate that produced the undefined, so
    // neither can report the other's reason.
    const declined = accounts.filter(
      account =>
        !account.isActive &&
        !triedKeys.has(account.key) &&
        !vouchableKeys.has(account.key),
    )
    if (declined.length === 0) {
      return { type: 'skipped', reason: 'no-candidate' }
    }
    logDeclinedCandidates(declined)
    return { type: 'skipped', reason: 'no-vouchable-candidate' }
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
