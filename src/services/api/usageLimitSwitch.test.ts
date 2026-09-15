import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AccountSummary } from '../../utils/authAccounts.js'
import {
  chooseSwitchCandidate,
  clearAccountSwitchEffects,
  getAccountSwitchEpoch,
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

  test('picks the first non-active, non-tried account in stored order', () => {
    expect(chooseSwitchCandidate([a, b, c], new Set())).toMatchObject({ key: 'b' })
  })

  test('never considers the active account — it is the one that hit the limit', () => {
    expect(chooseSwitchCandidate([b, a], new Set())).toMatchObject({ key: 'b' })
  })

  test('skips accounts already tried in this request', () => {
    expect(chooseSwitchCandidate([a, b, c], new Set(['b']))).toEqual(c)
    // The bound: once every other account is tried, there is no candidate.
    expect(chooseSwitchCandidate([a, b, c], new Set(['b', 'c']))).toBeUndefined()
  })

  test('single-account store has no candidate', () => {
    expect(chooseSwitchCandidate([a], new Set())).toBeUndefined()
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

  const deps = (accounts: AccountSummary[], succeed = true) => ({
    readAccounts: () => accounts,
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

  test('skips: background-source for a teammate query source', async () => {
    const d = deps(accountsWith('a'))
    expect(
      await switchToNextAccountOnUsageLimit(
        { ...eligible, querySource: 'agent:custom', triedKeys: new Set() },
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
