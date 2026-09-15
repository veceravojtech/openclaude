/**
 * An account switch has to move TWO mirrors, and getting either wrong fails
 * silently rather than loudly.
 *
 * Token side: every reader resolves through `claudeAiOauth`, so a switch that
 * only moved `claudeAiOauthActive` would keep handing out the previous
 * account's access token — the CLI would report the switch as successful and
 * carry on spending the old subscription.
 *
 * Identity side: `getOauthAccountInfo` reads `config.oauthAccount`, and
 * nothing else re-points it, so a switch that skipped it would leave the
 * status line naming the account the user just left.
 *
 * These tests assert the observable end of both: what a reader returns after
 * the switch, not what the switch wrote.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OAuthTokens } from '../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import * as realSecureStorage from './secureStorage/index.js'
import type { SecureStorageData } from './secureStorage/index.js'

const HOUR = 60 * 60 * 1000

function tokensFor(who: 'work' | 'personal'): OAuthTokens {
  return {
    accessToken: `${who}-access`,
    refreshToken: `${who}-refresh`,
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
    tokenAccount: {
      uuid: `uuid-${who}`,
      emailAddress: `${who}@example.com`,
    },
  }
}

describe('switching the active account moves both mirrors', () => {
  let tmpRoot: string
  let store: SecureStorageData

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/accountSwitch.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-account-switch-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: {
        'uuid-work': tokensFor('work'),
        'uuid-personal': { ...tokensFor('personal'), label: 'side project' },
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-test-storage',
        read: () => store,
        readAsync: async () => store,
        update: (next: SecureStorageData) => {
          store = next
          return { success: true }
        },
      }),
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => realSecureStorage)
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('a token reader returns the new account immediately after the switch', async () => {
    const { switchAccount } = await import('./accountSwitch.js')
    const { getClaudeAIOAuthTokens, clearOAuthTokenCache } = await import(
      './auth.js'
    )

    // Seed the memoized reader with the OLD account, so this also pins the
    // cache invalidation and not just the write.
    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('work-access')

    expect((await switchAccount('uuid-personal')).success).toBe(true)

    // The assertion that matters: what a caller actually gets.
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('personal-access')
    // And the stored mirror it resolved through.
    expect(store.claudeAiOauthActive).toBe('uuid-personal')
    expect(store.claudeAiOauth?.accessToken).toBe('personal-access')
    // The account we left keeps its own refresh token.
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'work-refresh',
    )
  })

  test('the config identity mirror follows the switch', async () => {
    const { switchAccount } = await import('./accountSwitch.js')
    const { getGlobalConfig, saveGlobalConfig } = await import('./config.js')

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'uuid-work',
        emailAddress: 'work@example.com',
      },
      oauthAccounts: {
        'uuid-work': {
          accountUuid: 'uuid-work',
          emailAddress: 'work@example.com',
        },
        'uuid-personal': {
          accountUuid: 'uuid-personal',
          emailAddress: 'personal@example.com',
        },
      },
    }))

    expect((await switchAccount('uuid-personal')).success).toBe(true)

    expect(getGlobalConfig().oauthAccount?.emailAddress).toBe(
      'personal@example.com',
    )
  })

  test('switching to an unknown key changes nothing', async () => {
    const { switchAccount } = await import('./accountSwitch.js')

    await expect(switchAccount('uuid-nobody')).rejects.toThrow(
      /No stored Claude account/,
    )
    expect(store.claudeAiOauthActive).toBe('uuid-work')
    expect(store.claudeAiOauth?.accessToken).toBe('work-access')
  })
})

describe('resolving what the user typed to an account', () => {
  const accounts = [
    {
      key: 'uuid-work',
      emailAddress: 'work@example.com',
      label: 'day job',
      isActive: true,
    },
    {
      key: 'uuid-personal',
      emailAddress: 'personal@example.com',
      label: 'side project',
      isActive: false,
    },
  ]

  test('matches on key, label and email', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    expect(resolveAccountKey(accounts, 'uuid-personal')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
    expect(resolveAccountKey(accounts, 'side project')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
    expect(resolveAccountKey(accounts, 'PERSONAL@example.com')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
  })

  test('reports an ambiguous query instead of guessing', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    const shared = [
      { key: 'a', label: 'shared', isActive: true },
      { key: 'b', label: 'shared', isActive: false },
    ]
    expect(resolveAccountKey(shared, 'shared').type).toBe('ambiguous')
  })

  test('an unknown or empty query resolves to nothing', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    expect(resolveAccountKey(accounts, 'nobody@example.com').type).toBe(
      'unknown',
    )
    expect(resolveAccountKey(accounts, '   ').type).toBe('unknown')
  })
})
