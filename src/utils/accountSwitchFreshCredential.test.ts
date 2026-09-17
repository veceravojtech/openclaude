import { describe, expect, test } from 'bun:test'
import type { SecureStorageData } from './secureStorage/index.js'
import {
  type FreshCredentialSwitchDeps,
  refreshableAccountKeys,
  switchToAccountWithFreshCredential,
} from './accountSwitchFreshCredential.js'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'access-test',
    refreshToken: 'refresh-test',
    expiresAt: NOW - 5 * HOUR,
    scopes: ['user:inference'],
    ...overrides,
  }
}

function store(accounts: Record<string, unknown>): SecureStorageData {
  return { claudeAiOauthAccounts: accounts } as unknown as SecureStorageData
}

describe('refreshableAccountKeys', () => {
  test('an expired account with a refresh token and an identity is refreshable', () => {
    const data = store({
      'uuid-blob': tokens({ tokenAccount: { uuid: 'uuid-blob', emailAddress: 'blob@example.com' } }),
      'uuid-config': tokens(),
    })
    expect(
      [...refreshableAccountKeys(data, NOW, {
        'uuid-config': { emailAddress: 'config@example.com' },
      })].sort(),
    ).toEqual(['uuid-blob', 'uuid-config'])
  })

  test('no refresh token, no identity anywhere, or a still-valid token are not refreshable', () => {
    const data = store({
      'uuid-no-refresh': tokens({ refreshToken: null, tokenAccount: { uuid: 'uuid-no-refresh' } }),
      default: tokens(),
      'uuid-valid': tokens({ expiresAt: NOW + HOUR, tokenAccount: { uuid: 'uuid-valid' } }),
    })
    expect([...refreshableAccountKeys(data, NOW)]).toEqual([])
  })
})

describe('switchToAccountWithFreshCredential', () => {
  function deps(live: boolean | 'throws'): FreshCredentialSwitchDeps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      switchAccount: async key => {
        calls.push(`switch:${key}`)
        return { success: true }
      },
      refreshActiveToken: async () => {
        calls.push('refresh')
        if (live === 'throws') throw new Error('refresh failed')
      },
      activeTokenIsLive: async () => live === true,
    }
  }

  test('keeps the switch when the refresh yields a live token', async () => {
    const d = deps(true)
    expect(await switchToAccountWithFreshCredential('b', 'a', d)).toEqual({ success: true })
    expect(d.calls).toEqual(['switch:b', 'refresh'])
  })

  test('switches back when the refresh yields no live token', async () => {
    const d = deps(false)
    const result = await switchToAccountWithFreshCredential('b', 'a', d)
    expect(result.success).toBe(false)
    expect(result.warning).toContain('stayed on the current account')
    expect(d.calls).toEqual(['switch:b', 'refresh', 'switch:a'])
  })

  test('switches back when the refresh throws', async () => {
    const d = deps('throws')
    expect((await switchToAccountWithFreshCredential('b', 'a', d)).success).toBe(false)
    expect(d.calls).toEqual(['switch:b', 'refresh', 'switch:a'])
  })

  test('a switch that fails outright is reported as is, with no refresh', async () => {
    const d = deps(true)
    d.switchAccount = async key => {
      d.calls.push(`switch:${key}`)
      return { success: false, warning: 'locked' }
    }
    expect(await switchToAccountWithFreshCredential('b', 'a', d)).toEqual({
      success: false,
      warning: 'locked',
    })
    expect(d.calls).toEqual(['switch:b'])
  })
})
