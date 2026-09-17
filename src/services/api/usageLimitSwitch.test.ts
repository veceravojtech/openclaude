import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AccountSummary } from '../../utils/authAccounts.js'
import {
  chooseSwitchCandidate,
  clearAccountSwitchEffects,
  formatDeclinedCandidatesForDebug,
  getAccountSwitchEpoch,
  hasUntriedAlternativeAccount,
  registerAccountSwitchEffects,
  switchToNextAccountOnUsageLimit,
} from './usageLimitSwitch.js'

function account(
  key: string,
  emailAddress: string,
  isActive = false,
): AccountSummary {
  return { key, emailAddress, isActive }
}

const eligible = {
  status: 429 as const,
  isFirstParty: true,
  querySource: 'repl_main_thread' as const,
}

describe('chooseSwitchCandidate', () => {
  const a = account('a', 'a@example.com', true)
  const b = account('b', 'b@example.com')
  const c = account('c', 'c@example.com')
  /** Everything vouchable, so these cases isolate the pre-existing filters. */
  const allVouchable = new Set(['a', 'b', 'c'])

  test('picks the first non-active, non-tried account in stored order', () => {
    expect(
      chooseSwitchCandidate([a, b, c], new Set(), allVouchable),
    ).toMatchObject({ key: 'b' })
  })

  test('never considers the active account — it is the one that hit the limit', () => {
    expect(chooseSwitchCandidate([b, a], new Set(), allVouchable)).toMatchObject(
      { key: 'b' },
    )
  })

  test('skips accounts already tried in this request', () => {
    expect(chooseSwitchCandidate([a, b, c], new Set(['b']), allVouchable)).toEqual(c)
    // The bound: once every other account is tried, there is no candidate.
    expect(
      chooseSwitchCandidate([a, b, c], new Set(['b', 'c']), allVouchable),
    ).toBeUndefined()
  })

  test('single-account store has no candidate', () => {
    expect(chooseSwitchCandidate([a], new Set(), allVouchable)).toBeUndefined()
  })

  test('skips an unvouchable account and walks on to the next vouchable one', () => {
    // `b` first in stored order is exactly how the user was moved onto the
    // identity-less entry: stored order alone used to decide.
    expect(
      chooseSwitchCandidate([a, b, c], new Set(), new Set(['a', 'c'])),
    ).toEqual(c)
  })

  test('no candidate when every untried account is unvouchable', () => {
    expect(
      chooseSwitchCandidate([a, b, c], new Set(), new Set(['a'])),
    ).toBeUndefined()
  })

  test('an empty vouchable set selects nothing, even from a full store', () => {
    expect(
      chooseSwitchCandidate([a, b, c], new Set(), new Set<string>()),
    ).toBeUndefined()
  })
})

describe('switchToNextAccountOnUsageLimit', () => {
  let effectsCalls: number
  let switchCalls: string[]
  let order: string[]

  const accountsWith = (activeKey: string): AccountSummary[] => [
    account('a', 'a@example.com', activeKey === 'a'),
    account('b', 'b@example.com', activeKey === 'b'),
    account('c', 'c@example.com', activeKey === 'c'),
  ]

  /**
   * `vouchable` defaults to every stored key, so the pre-existing cases below
   * keep exercising the paths they were written for; the guard cases pass an
   * explicit subset.
   */
  const deps = (
    accounts: AccountSummary[],
    succeed = true,
    vouchable?: readonly string[],
  ) => ({
    readAccounts: () => accounts,
    readVouchableKeys: (): ReadonlySet<string> =>
      new Set(vouchable ?? accounts.map(entry => entry.key)),
    switchAccount: async (key: string) => {
      switchCalls.push(key)
      order.push(`switch:${key}`)
      return { success: succeed }
    },
  })

  beforeEach(() => {
    effectsCalls = 0
    switchCalls = []
    order = []
    registerAccountSwitchEffects(() => {
      effectsCalls++
      order.push('effects')
    })
  })

  afterEach(() => {
    clearAccountSwitchEffects()
  })

  test('switches to the next account, effects after the credential write', async () => {
    const tried = new Set<string>()
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: tried },
      deps(accountsWith('a')),
    )
    expect(outcome).toEqual({
      type: 'switched',
      key: 'b',
      name: 'b@example.com',
    })
    expect(order).toEqual(['switch:b', 'effects'])
    expect([...tried].sort()).toEqual(['a', 'b'])
  })

  test('bumps the switch epoch exactly once per switch', async () => {
    const before = getAccountSwitchEpoch()
    await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps(accountsWith('a')),
    )
    expect(getAccountSwitchEpoch()).toBe(before + 1)
  })

  test('skips: not-rate-limited for a non-429 status', async () => {
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, status: 500, triedKeys: new Set() },
        d,
      ),
    ).toEqual({ type: 'skipped', reason: 'not-rate-limited' })
    expect(switchCalls).toEqual([])
  })

  test('skips: wrong-provider — Claude accounts exist but the route is not first-party Anthropic, so no switch, ever', async () => {
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, isFirstParty: false, triedKeys: new Set() },
        d,
      ),
    ).toEqual({ type: 'skipped', reason: 'wrong-provider' })
    expect(switchCalls).toEqual([])
    expect(effectsCalls).toBe(0)
  })

  test('switches for a teammate query source — the wait is the gate teammates fail, not this one', async () => {
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, querySource: 'agent:custom', triedKeys: new Set() },
        d,
      ),
    ).toEqual({ type: 'switched', key: 'b', name: 'b@example.com' })
    expect(switchCalls).toEqual(['b'])
  })

  test('a teammate-sourced switch is still filtered by vouchability, exactly like a foreground one', async () => {
    // The source gate widened; nothing downstream of it did. Unit O's guard
    // must not be reachable-around via the new source — an unvouchable entry
    // is no more switchable-to for a teammate than for the user.
    const tried = new Set<string>()
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, querySource: 'agent:custom', triedKeys: tried },
        deps(accountsWith('a'), true, /* vouchable */ ['a']),
      ),
    ).toEqual({ type: 'skipped', reason: 'no-vouchable-candidate' })
    expect(switchCalls).toEqual([])
  })

  test('skips: background-source for a source in neither allowlist', async () => {
    // The allowlist shape is the assertion here: an unrecognised path stays
    // out, so nothing acquires the ability to move the active account merely
    // by being added somewhere else in the codebase.
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, querySource: 'away_summary', triedKeys: new Set() },
        d,
      ),
    ).toEqual({ type: 'skipped', reason: 'background-source' })
    expect(switchCalls).toEqual([])
  })

  test('skips: no-session-effects when the REPL has not registered the hook — a storage-only switch is refused', async () => {
    clearAccountSwitchEffects()
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set() },
        d,
      ),
    ).toEqual({ type: 'skipped', reason: 'no-session-effects' })
    expect(switchCalls).toEqual([])
  })

  test('skips: read-failed when account enumeration throws, without masking the original error', async () => {
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set() },
        {
          readAccounts: () => {
            throw new Error('storage unreadable')
          },
          readVouchableKeys: () => new Set<string>(),
          switchAccount: deps(accountsWith('a')).switchAccount,
        },
      ),
    ).toEqual({ type: 'skipped', reason: 'read-failed' })
  })

  test('skips: switch-failed — the account stays claimed so it is never retried, and the epoch is untouched', async () => {
    const before = getAccountSwitchEpoch()
    const tried = new Set<string>()
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: tried },
        deps(accountsWith('a'), /* succeed */ false),
      ),
    ).toEqual({ type: 'skipped', reason: 'switch-failed' })
    expect(effectsCalls).toBe(0)
    expect(getAccountSwitchEpoch()).toBe(before)
    expect(tried.has('b')).toBe(true)
  })

  test('bound: a second 429 never revisits the account it just left', async () => {
    // First switch a→b. The caller then re-reads accounts with b active.
    const tried = new Set<string>()
    await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: tried },
      deps(accountsWith('a')),
    )
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: tried },
      deps(accountsWith('b')),
    )
    expect(outcome).toEqual({ type: 'switched', key: 'c', name: 'c@example.com' })
    // And when c is exhausted too, there is nothing left.
    tried.add('c')
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: tried },
        deps(accountsWith('c')),
      ),
    ).toEqual({ type: 'skipped', reason: 'no-candidate' })
    expect(switchCalls).toEqual(['b', 'c'])
  })
})

describe('switchToNextAccountOnUsageLimit: the declined switch', () => {
  let effectsCalls: number
  let switchCalls: string[]

  /** Drained active account plus one untried entry that cannot be vouched for. */
  const drainedPlusUnvouchable = (): AccountSummary[] => [
    account('a', 'a@example.com', true),
    // No email: the observable signature of the identity-less `default` entry.
    { key: 'default', isActive: false },
  ]

  const deps = (accounts: AccountSummary[], vouchable: readonly string[]) => ({
    readAccounts: () => accounts,
    readVouchableKeys: (): ReadonlySet<string> => new Set(vouchable),
    switchAccount: async (key: string) => {
      switchCalls.push(key)
      return { success: true }
    },
  })

  beforeEach(() => {
    effectsCalls = 0
    switchCalls = []
    registerAccountSwitchEffects(() => {
      effectsCalls++
    })
  })

  afterEach(() => {
    clearAccountSwitchEffects()
  })

  test("no-vouchable-candidate: nothing is switched, no effects run, the epoch stands still", async () => {
    const before = getAccountSwitchEpoch()
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps(drainedPlusUnvouchable(), ['a']),
    )
    expect(outcome).toEqual({
      type: 'skipped',
      reason: 'no-vouchable-candidate',
    })
    expect(switchCalls).toEqual([])
    expect(effectsCalls).toBe(0)
    expect(getAccountSwitchEpoch()).toBe(before)
  })

  test("no-candidate is still reported when the untried accounts simply ran out", async () => {
    // Everything vouchable, `b` already tried: ordinary exhaustion, and the
    // reason must not drift onto the new one.
    const accounts = [
      account('a', 'a@example.com', true),
      account('b', 'b@example.com'),
    ]
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set(['b']) },
        deps(accounts, ['a', 'b']),
      ),
    ).toEqual({ type: 'skipped', reason: 'no-candidate' })
    expect(switchCalls).toEqual([])
  })

  test('a single-account store is exhaustion, not a declined switch', async () => {
    // Nothing but the active account: there was never anything to decline, so
    // an unvouchable-looking empty key set must not manufacture the new reason.
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set() },
        deps([account('a', 'a@example.com', true)], []),
      ),
    ).toEqual({ type: 'skipped', reason: 'no-candidate' })
  })

  test('an unvouchable entry is stepped over, not treated as the end of the walk', async () => {
    const accounts = [
      { key: 'default', isActive: false },
      account('a', 'a@example.com', true),
      account('b', 'b@example.com'),
    ]
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps(accounts, ['a', 'b']),
    )
    expect(outcome).toEqual({ type: 'switched', key: 'b', name: 'b@example.com' })
    expect(switchCalls).toEqual(['b'])
    expect(switchCalls).not.toContain('default')
  })

  test('read-failed when readVouchableKeys throws — the 429 is never replaced by a crash', async () => {
    // Contract A3: this read is independent of readAccounts and can fail on
    // its own, so it has to sit inside the same try/catch.
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, triedKeys: new Set() },
        {
          readAccounts: () => drainedPlusUnvouchable(),
          readVouchableKeys: (): ReadonlySet<string> => {
            throw new Error('vouchable-key storage unreadable')
          },
          switchAccount: async (key: string) => {
            switchCalls.push(key)
            return { success: true }
          },
        },
      ),
    ).toEqual({ type: 'skipped', reason: 'read-failed' })
    expect(switchCalls).toEqual([])
    expect(effectsCalls).toBe(0)
  })
})

describe('hasUntriedAlternativeAccount', () => {
  const deps = (accounts: AccountSummary[], vouchable: readonly string[]) => ({
    readAccounts: () => accounts,
    readVouchableKeys: (): ReadonlySet<string> => new Set(vouchable),
    switchAccount: async () => ({ success: true }),
  })

  const healthyPair = (): AccountSummary[] => [
    account('a', 'a@example.com', true),
    account('b', 'b@example.com'),
  ]

  test('true when a vouchable untried alternative exists', () => {
    expect(
      hasUntriedAlternativeAccount(new Set(), deps(healthyPair(), ['a', 'b'])),
    ).toBe(true)
  })

  test('false once that alternative has been tried', () => {
    expect(
      hasUntriedAlternativeAccount(
        new Set(['b']),
        deps(healthyPair(), ['a', 'b']),
      ),
    ).toBe(false)
  })

  test('false when the only untried alternative is unvouchable — the wait must be told the truth', () => {
    // Contract E: withRetry feeds this to decideUsageLimitWait, which treats
    // "an alternative exists" as a reason NOT to wait. Reporting true here
    // after the selector declined the same account would withdraw both
    // remedies and leave the user with a bare limit error.
    expect(
      hasUntriedAlternativeAccount(
        new Set(),
        deps(
          [account('a', 'a@example.com', true), { key: 'default', isActive: false }],
          ['a'],
        ),
      ),
    ).toBe(false)
  })

  test('the active account alone is never an alternative', () => {
    expect(
      hasUntriedAlternativeAccount(
        new Set(),
        deps([account('a', 'a@example.com', true)], ['a']),
      ),
    ).toBe(false)
  })

  test('false when readAccounts throws — cannot read the store, cannot switch', () => {
    expect(
      hasUntriedAlternativeAccount(new Set(), {
        readAccounts: (): AccountSummary[] => {
          throw new Error('storage unreadable')
        },
        readVouchableKeys: (): ReadonlySet<string> => new Set(['b']),
        switchAccount: async () => ({ success: true }),
      }),
    ).toBe(false)
  })

  test('false when readVouchableKeys throws, rather than throwing into the retry loop', () => {
    // Contract A3, the half that matters most: this function is called from
    // decideUsageLimitWait's otherAccountAvailable() callback, so an uncaught
    // throw here escapes the retry loop and replaces the user's 429.
    expect(() =>
      hasUntriedAlternativeAccount(new Set(), {
        readAccounts: () => healthyPair(),
        readVouchableKeys: (): ReadonlySet<string> => {
          throw new Error('vouchable-key storage unreadable')
        },
        switchAccount: async () => ({ success: true }),
      }),
    ).not.toThrow()
    expect(
      hasUntriedAlternativeAccount(new Set(), {
        readAccounts: () => healthyPair(),
        readVouchableKeys: (): ReadonlySet<string> => {
          throw new Error('vouchable-key storage unreadable')
        },
        switchAccount: async () => ({ success: true }),
      }),
    ).toBe(false)
  })
})

describe('formatDeclinedCandidatesForDebug', () => {
  const LONG_KEY = '00000000-0000-4000-8000-00000000dddd'

  test('names the count and each declined key, truncated to 8 characters', () => {
    const line = formatDeclinedCandidatesForDebug([
      { key: LONG_KEY, isActive: false },
      { key: 'default', isActive: false },
    ])
    expect(line).toContain('declined 2 untried candidate(s)')
    expect(line).toContain('00000000:unvouchable')
    expect(line).toContain('default:unvouchable')
    expect(line).not.toContain(LONG_KEY)
  })

  test('never leaks an email address or a label — both sit on AccountSummary', () => {
    const line = formatDeclinedCandidatesForDebug([
      {
        key: LONG_KEY,
        emailAddress: 'leaky@example.invalid',
        label: 'work account',
        isActive: false,
      },
    ])
    expect(line).not.toContain('@')
    expect(line).not.toContain('leaky')
    expect(line).not.toContain('work account')
  })
})

describe('switchToNextAccountOnUsageLimit: an expired account is refreshed before the switch', () => {
  // Regression: the other account in a two-account pool is the one not in use,
  // so its access token had expired (~5 h) while its refresh token was fine.
  // vouchForAccount refused it, the switch reported no-vouchable-candidate, and
  // every 429 waited out the reset instead ("resuming at 21:40").
  let effectsCalls: number
  let calls: string[]

  const deps = (options: {
    accounts: AccountSummary[]
    vouchable: readonly string[]
    refreshable: readonly string[]
    refreshSucceeds: boolean
  }) => ({
    readAccounts: () => options.accounts,
    readVouchableKeys: (): ReadonlySet<string> => new Set(options.vouchable),
    switchAccount: async (key: string) => {
      calls.push(`switch:${key}`)
      return { success: true }
    },
    readRefreshableKeys: (): ReadonlySet<string> => new Set(options.refreshable),
    switchWithFreshCredential: async (key: string, previousKey: string | undefined) => {
      calls.push(`fresh:${key}<-${previousKey}`)
      return { success: options.refreshSucceeds }
    },
  })

  beforeEach(() => {
    effectsCalls = 0
    calls = []
    registerAccountSwitchEffects(() => {
      effectsCalls++
    })
  })

  afterEach(() => {
    clearAccountSwitchEffects()
  })

  test('the idle account with an expired access token is refreshed and switched to', async () => {
    const before = getAccountSwitchEpoch()
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps({
        accounts: [account('a', 'a@example.com', true), account('b', 'b@example.com')],
        vouchable: ['a'],
        refreshable: ['b'],
        refreshSucceeds: true,
      }),
    )

    expect(outcome).toEqual({ type: 'switched', key: 'b', name: 'b@example.com' })
    // Handed the account it came from, so a failed refresh can switch back.
    expect(calls).toEqual(['fresh:b<-a'])
    expect(effectsCalls).toBe(1)
    expect(getAccountSwitchEpoch()).toBe(before + 1)
  })

  test('a refresh that yields no live token keeps the session where it was, once per request', async () => {
    const before = getAccountSwitchEpoch()
    const triedKeys = new Set<string>()
    const failing = deps({
      accounts: [account('a', 'a@example.com', true), account('b', 'b@example.com')],
      vouchable: ['a'],
      refreshable: ['b'],
      refreshSucceeds: false,
    })

    const first = await switchToNextAccountOnUsageLimit({ ...eligible, triedKeys }, failing)
    expect(first).toEqual({ type: 'skipped', reason: 'switch-failed' })
    expect(effectsCalls).toBe(0)
    expect(getAccountSwitchEpoch()).toBe(before)
    expect(triedKeys.has('b')).toBe(true)

    // The next 429 in the same request does not refresh `b` again: nothing is
    // left, so the wait decision can take over.
    const second = await switchToNextAccountOnUsageLimit({ ...eligible, triedKeys }, failing)
    expect(second).toEqual({ type: 'skipped', reason: 'no-candidate' })
    expect(calls).toEqual(['fresh:b<-a'])
  })

  test('an account usable as it stands is preferred, and no refresh is attempted', async () => {
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps({
        accounts: [
          account('a', 'a@example.com', true),
          account('b', 'b@example.com'),
          account('c', 'c@example.com'),
        ],
        vouchable: ['a', 'b'],
        refreshable: ['c'],
        refreshSucceeds: true,
      }),
    )

    expect(outcome).toEqual({ type: 'switched', key: 'b', name: 'b@example.com' })
    expect(calls).toEqual(['switch:b'])
  })

  test('an account that is not refreshable is still declined as before', async () => {
    const outcome = await switchToNextAccountOnUsageLimit(
      { ...eligible, triedKeys: new Set() },
      deps({
        accounts: [account('a', 'a@example.com', true), { key: 'default', isActive: false }],
        vouchable: ['a'],
        refreshable: [],
        refreshSucceeds: true,
      }),
    )

    expect(outcome).toEqual({ type: 'skipped', reason: 'no-vouchable-candidate' })
    expect(calls).toEqual([])
  })
})
