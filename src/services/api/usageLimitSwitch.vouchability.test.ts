/**
 * Auto-switch vouchability: the client must never move a user onto a stored
 * account it cannot vouch for.
 *
 * Written against the Unit O seam contract BEFORE the implementation existed,
 * by an author who is not implementing it, and kept separate from
 * `usageLimitSwitch.test.ts` on purpose: the acceptance criteria should not be
 * editable by the code they judge.
 *
 * The incident being pinned down. A usage-limit 429 auto-switched onto an entry
 * keyed `default` — no identity record, never validated, no refresh path — four
 * times, each followed by a revoked-401 within 0.5-0.7s. Measured against the
 * pre-guard code, `chooseSwitchCandidate` returned that entry even with a
 * healthy UUID account in the same store, and
 * `switchToNextAccountOnUsageLimit` returned
 * `{ type: 'switched', key: 'default', name: 'default' }` — the value that
 * reaches the user as `switchedAccountTo: "default"` (withRetry.ts:513-519).
 * That `name` is itself the proof of unnameability: `accountDisplayName` falls
 * through email -> label -> key, so an entry rendering as the bare key has
 * neither.
 *
 * Every test here drives real code and asserts an observed outcome. None
 * asserts that a type exists, that a function is defined, or that a call does
 * not throw — this roadmap has twice shipped changes that typechecked green
 * and were wrong.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  listAccounts,
  vouchForAccount,
  vouchableAccountKeys,
} from '../../utils/authAccounts.js'
import type {
  SecureStorageData,
  StoredClaudeAccount,
} from '../../utils/secureStorage/index.js'
import {
  clearAccountSwitchEffects,
  getAccountSwitchEpoch,
  hasUntriedAlternativeAccount,
  registerAccountSwitchEffects,
  switchToNextAccountOnUsageLimit,
} from './usageLimitSwitch.js'

// -- fixtures ----------------------------------------------------------------

/** Fixed clock. `Date.now()` here would make the expiry boundary case flake. */
const NOW = 1_800_000_000_000
const HOUR_MS = 60 * 60 * 1000

const ACTIVE_UUID = '00000000-0000-4000-8000-00000000aaaa'
const HEALTHY_UUID = '00000000-0000-4000-8000-00000000bbbb'
const THIRD_UUID = '00000000-0000-4000-8000-00000000cccc'
/** The key a credential with no recoverable account UUID lands on. */
const LEGACY_KEY = 'default'

/**
 * An account the client can vouch for: a refresh token it could present, an
 * unexpired access token, and an identity that lets it say whose account this
 * is. Token values are obvious fakes; nothing here comes off a real machine.
 */
function healthyAccount(uuid: string, tag: string): StoredClaudeAccount {
  return {
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    expiresAt: NOW + HOUR_MS,
    scopes: ['user:inference'],
    tokenAccount: { uuid, emailAddress: `${tag}@example.invalid` },
  }
}

/**
 * The observed `default` entry: tokens present and unexpired, but carrying
 * neither `tokenAccount` nor `profile`, so the client cannot name it.
 *
 * Deliberately modelled as failing ONLY the identity condition. Whether the
 * real entry also lacks a refresh token is unknown — its contents have never
 * been read — and assuming it does would let a guard that checked nothing but
 * `refreshToken` pass the headline test while leaving the actual defect in.
 */
function identitylessAccount(): StoredClaudeAccount {
  return {
    accessToken: 'access-legacy',
    refreshToken: 'refresh-legacy',
    expiresAt: NOW + HOUR_MS,
    scopes: ['user:inference'],
  }
}

/** Nameable through `profile` instead of `tokenAccount` — also a real shape. */
function profileOnlyAccount(uuid: string, tag: string): StoredClaudeAccount {
  const { tokenAccount: _tokenAccount, ...rest } = healthyAccount(uuid, tag)
  return {
    ...rest,
    profile: {
      account: { uuid, email: `${tag}@example.invalid` },
      organization: { uuid: `org-${tag}` },
    },
  }
}

/** Insertion order is the stored order `listAccounts` walks. */
function storageWith(
  entries: readonly (readonly [string, StoredClaudeAccount])[],
  activeKey: string,
): SecureStorageData {
  return {
    claudeAiOauthAccounts: Object.fromEntries(entries),
    claudeAiOauthActive: activeKey,
  }
}

/** The active-and-drained account plus one alternative under test. */
function storeWithCandidate(candidate: StoredClaudeAccount): SecureStorageData {
  return storageWith(
    [
      [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
      [HEALTHY_UUID, candidate],
    ],
    ACTIVE_UUID,
  )
}

// -- harness -----------------------------------------------------------------

let switchCalls: string[]
let effectsCalls: number

/**
 * Deps derived from the fixture map through the REAL predicate, so every
 * assertion exercises both halves of the guard. A hand-written key set here
 * would agree with a broken predicate and prove nothing.
 */
function depsFor(data: SecureStorageData) {
  return {
    readAccounts: () => listAccounts(data),
    readVouchableKeys: () => vouchableAccountKeys(data, NOW),
    switchAccount: async (key: string) => {
      switchCalls.push(key)
      return { success: true }
    },
  }
}

const eligible = {
  status: 429 as const,
  isFirstParty: true,
  querySource: 'repl_main_thread' as const,
}

beforeEach(() => {
  switchCalls = []
  effectsCalls = 0
  // Process-global registry: a switch is refused outright without it, so every
  // "did not switch" assertion below would otherwise pass for the wrong reason.
  registerAccountSwitchEffects(() => {
    effectsCalls++
  })
})

afterEach(() => {
  clearAccountSwitchEffects()
})

// -- 1. the headline ---------------------------------------------------------

describe('the switch never lands on an account the client cannot vouch for', () => {
  test('a healthy UUID account is chosen over an identity-less `default` stored ahead of it', async () => {
    // `default` FIRST: stored order alone selected it before the guard, which
    // is precisely how the user was moved onto it four times.
    const data = storageWith(
      [
        [LEGACY_KEY, identitylessAccount()],
        [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
        [HEALTHY_UUID, healthyAccount(HEALTHY_UUID, 'b')],
      ],
      ACTIVE_UUID,
    )

    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(data),
    )

    expect(outcome).toEqual({
      type: 'switched',
      key: HEALTHY_UUID,
      name: 'b@example.invalid',
    })
    expect(switchCalls).toEqual([HEALTHY_UUID])
    expect(switchCalls).not.toContain(LEGACY_KEY)
    // A bare `default` as the rendered name is the observable signature of the
    // bug: it means the entry had neither an email nor a label.
    const name = outcome.type === 'switched' ? outcome.name : undefined
    expect(name).not.toBe(LEGACY_KEY)
  })
})

// -- 2. exclusion condition 1, alone -----------------------------------------

describe('excluded: no refresh token (nameable and unexpired otherwise)', () => {
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ["the empty string — a real shape a truthiness check would pass", ''],
  ] as const

  for (const [label, value] of cases) {
    test(`reports 'no-refresh-token' for ${label}, and the account is not selected`, async () => {
      const candidate: StoredClaudeAccount = {
        ...healthyAccount(HEALTHY_UUID, 'b'),
        refreshToken: value,
      }
      expect(vouchForAccount(candidate, NOW)).toBe('no-refresh-token')
      // Isolation: restore the one missing field and the same fixture passes,
      // so this case can only ever fail on condition 1.
      expect(
        vouchForAccount({ ...candidate, refreshToken: 'refresh-b' }, NOW),
      ).toBeUndefined()

      const data = storeWithCandidate(candidate)
      expect(vouchableAccountKeys(data, NOW).has(HEALTHY_UUID)).toBe(false)
      const outcome = await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set<string>() },
        depsFor(data),
      )
      expect(outcome).toEqual({
        type: 'skipped',
        reason: 'no-vouchable-candidate',
      })
      expect(switchCalls).toEqual([])
    })
  }
})

// -- 3. exclusion condition 2, alone -----------------------------------------

describe('excluded: expired or unknown expiry (nameable and refreshable otherwise)', () => {
  const withExpiry = (expiresAt: number | null): StoredClaudeAccount => ({
    ...healthyAccount(HEALTHY_UUID, 'b'),
    expiresAt,
  })

  /** A legacy blob whose JSON simply has no `expiresAt` — a real on-disk shape. */
  function withoutExpiry(): StoredClaudeAccount {
    const { expiresAt: _expiresAt, ...rest } = healthyAccount(HEALTHY_UUID, 'b')
    return rest as StoredClaudeAccount
  }

  const cases = [
    ['null', withExpiry(null)],
    ['absent entirely', withoutExpiry()],
    ['in the past', withExpiry(NOW - 1)],
    ['exactly now — the boundary counts as expired', withExpiry(NOW)],
  ] as const

  for (const [label, candidate] of cases) {
    test(`reports 'expired' when expiresAt is ${label}, and the account is not selected`, async () => {
      expect(vouchForAccount(candidate, NOW)).toBe('expired')
      // Isolation: a future expiry on the same fixture is vouchable.
      expect(
        vouchForAccount({ ...candidate, expiresAt: NOW + HOUR_MS }, NOW),
      ).toBeUndefined()

      const data = storeWithCandidate(candidate)
      expect(vouchableAccountKeys(data, NOW).has(HEALTHY_UUID)).toBe(false)
      const outcome = await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set<string>() },
        depsFor(data),
      )
      expect(outcome).toEqual({
        type: 'skipped',
        reason: 'no-vouchable-candidate',
      })
      expect(switchCalls).toEqual([])
    })
  }
})

// -- 4. exclusion condition 3, alone -----------------------------------------

describe('excluded: unnameable — neither tokenAccount nor profile', () => {
  test("reports 'unnameable' for an otherwise healthy entry, and it is not selected", async () => {
    const candidate = identitylessAccount()
    expect(vouchForAccount(candidate, NOW)).toBe('unnameable')
    // Isolation: identity is the ONLY thing this fixture is missing.
    expect(
      vouchForAccount(
        { ...candidate, tokenAccount: { uuid: HEALTHY_UUID, emailAddress: 'b@example.invalid' } },
        NOW,
      ),
    ).toBeUndefined()

    const data = storeWithCandidate(candidate)
    expect(vouchableAccountKeys(data, NOW).has(HEALTHY_UUID)).toBe(false)
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(data),
    )
    expect(outcome).toEqual({
      type: 'skipped',
      reason: 'no-vouchable-candidate',
    })
    expect(switchCalls).toEqual([])
  })

  test('a profile-only account IS nameable, and is still switched to', async () => {
    // The condition is "neither", not "not both". Reading it as "not both"
    // would exclude every account identified by profile alone.
    const candidate = profileOnlyAccount(HEALTHY_UUID, 'b')
    expect(vouchForAccount(candidate, NOW)).toBeUndefined()

    const data = storeWithCandidate(candidate)
    expect(vouchableAccountKeys(data, NOW).has(HEALTHY_UUID)).toBe(true)
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(data),
    )
    expect(outcome).toEqual({
      type: 'switched',
      key: HEALTHY_UUID,
      name: 'b@example.invalid',
    })
    expect(switchCalls).toEqual([HEALTHY_UUID])
  })

  test('a tokenAccount-only account IS nameable, and is still switched to', async () => {
    const candidate = healthyAccount(HEALTHY_UUID, 'b')
    expect(candidate.profile).toBeUndefined()
    expect(vouchForAccount(candidate, NOW)).toBeUndefined()

    const data = storeWithCandidate(candidate)
    expect(vouchableAccountKeys(data, NOW).has(HEALTHY_UUID)).toBe(true)
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(data),
    )
    expect(outcome).toEqual({
      type: 'switched',
      key: HEALTHY_UUID,
      name: 'b@example.invalid',
    })
    expect(switchCalls).toEqual([HEALTHY_UUID])
  })
})

// -- 5. the no-surviving-candidate decision ----------------------------------

describe('when nothing survives the filter, the switch is declined — not faked', () => {
  const drainedPlusUnvouchable = (): SecureStorageData =>
    storageWith(
      [
        [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
        [LEGACY_KEY, identitylessAccount()],
      ],
      ACTIVE_UUID,
    )

  test("returns 'no-vouchable-candidate', calls switchAccount zero times, and moves nothing", async () => {
    const epochBefore = getAccountSwitchEpoch()
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(drainedPlusUnvouchable()),
    )

    expect(outcome).toEqual({
      type: 'skipped',
      reason: 'no-vouchable-candidate',
    })
    expect(switchCalls).toEqual([])
    // No credential write means no session effects and no epoch bump: a
    // stripped-signature rebuild on a switch that never happened would be a
    // second bug wearing the first one's clothes.
    expect(effectsCalls).toBe(0)
    expect(getAccountSwitchEpoch()).toBe(epochBefore)
  })

  test("is NOT collapsed into the pre-existing 'no-candidate' exhaustion reason", async () => {
    const declined = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(drainedPlusUnvouchable()),
    )
    expect(declined).not.toEqual({ type: 'skipped', reason: 'no-candidate' })

    // And the contrast that proves the two reasons are really distinct rather
    // than one renamed: a store whose only vouchable alternative is already
    // tried is ordinary exhaustion.
    const exhausted = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set([HEALTHY_UUID]) },
      depsFor(
        storageWith(
          [
            [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
            [HEALTHY_UUID, healthyAccount(HEALTHY_UUID, 'b')],
          ],
          ACTIVE_UUID,
        ),
      ),
    )
    expect(exhausted).toEqual({ type: 'skipped', reason: 'no-candidate' })
    expect(switchCalls).toEqual([])
  })
})

// -- 6. the honesty coupling -------------------------------------------------

describe('the wait decision is told the truth about alternatives', () => {
  // withRetry.ts feeds this to decideUsageLimitWait as `otherAccountAvailable`.
  // If the filter were applied to selection alone, the switch would be declined
  // AND the wait declined too, and the user would lose both remedies.
  test('reports no alternative when the only other account is unvouchable', () => {
    const data = storageWith(
      [
        [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
        [LEGACY_KEY, identitylessAccount()],
      ],
      ACTIVE_UUID,
    )
    expect(hasUntriedAlternativeAccount(new Set<string>(), depsFor(data))).toBe(
      false,
    )
  })

  test('reports an alternative when a genuinely healthy untried account exists', () => {
    const data = storageWith(
      [
        [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
        [LEGACY_KEY, identitylessAccount()],
        [HEALTHY_UUID, healthyAccount(HEALTHY_UUID, 'b')],
      ],
      ACTIVE_UUID,
    )
    expect(hasUntriedAlternativeAccount(new Set<string>(), depsFor(data))).toBe(
      true,
    )
    // ...and stops reporting one once that account has been tried.
    expect(
      hasUntriedAlternativeAccount(new Set([HEALTHY_UUID]), depsFor(data)),
    ).toBe(false)
  })
})

// -- 7. the over-correction guard --------------------------------------------

describe('ordinary auto-switching still works', () => {
  const healthyStoreWith = (activeKey: string): SecureStorageData =>
    storageWith(
      [
        [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
        [HEALTHY_UUID, healthyAccount(HEALTHY_UUID, 'b')],
        [THIRD_UUID, healthyAccount(THIRD_UUID, 'c')],
      ],
      activeKey,
    )

  test('a healthy multi-account store switches, and the epoch advances', async () => {
    const epochBefore = getAccountSwitchEpoch()
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set<string>() },
      depsFor(
        storageWith(
          [
            [ACTIVE_UUID, healthyAccount(ACTIVE_UUID, 'a')],
            [HEALTHY_UUID, healthyAccount(HEALTHY_UUID, 'b')],
          ],
          ACTIVE_UUID,
        ),
      ),
    )
    expect(outcome).toEqual({
      type: 'switched',
      key: HEALTHY_UUID,
      name: 'b@example.invalid',
    })
    expect(effectsCalls).toBe(1)
    expect(getAccountSwitchEpoch()).toBe(epochBefore + 1)
  })

  test('the walk survives: a second 429 moves on and never revisits the account it left', async () => {
    const tried = new Set<string>()
    const first = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: tried },
      depsFor(healthyStoreWith(ACTIVE_UUID)),
    )
    expect(first).toMatchObject({ type: 'switched', key: HEALTHY_UUID })

    const second = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: tried },
      depsFor(healthyStoreWith(HEALTHY_UUID)),
    )
    expect(second).toMatchObject({ type: 'switched', key: THIRD_UUID })

    expect(switchCalls).toEqual([HEALTHY_UUID, THIRD_UUID])
    expect(switchCalls).not.toContain(ACTIVE_UUID)
    expect([...tried].sort()).toEqual(
      [ACTIVE_UUID, HEALTHY_UUID, THIRD_UUID].sort(),
    )
  })
})
