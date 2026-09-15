/**
 * `performLogout` signs ONE account out, not every account.
 *
 * That distinction is load-bearing twice over. On /logout it is the difference
 * between a multi-account user losing the account they asked to leave and
 * losing all of them. And `installOAuthTokens` used to call this function to
 * "clear old state" before saving new credentials, which made every login a
 * full wipe — adding a second account destroyed the first while reporting
 * success.
 *
 * So these tests pin both ends of the branch. The promoted branch must leave
 * the survivor's tokens readable and the process logged in; the last-account
 * branch must still perform the full teardown, because the secure-storage blob
 * also holds MCP server tokens, plugin secrets and a second provider's
 * credentials, and a real logout is meant to take those with it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as realSecureStorage from '../../utils/secureStorage/index.js'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'

const HOUR = 60 * 60 * 1000

function tokensFor(who: string): OAuthTokens {
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

describe('signing out of one account among several', () => {
  let tmpRoot: string
  let store: SecureStorageData
  let deleteCalls: number

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/logout/logout.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-logout-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    deleteCalls = 0
    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: {
        'uuid-work': tokensFor('work'),
        'uuid-personal': tokensFor('personal'),
      },
      // Not a Claude account, and the reason the last-account teardown still
      // calls delete(): a real logout is expected to drop these too.
      mcpOAuth: {
        'some-server': {
          serverName: 'some-server',
          serverUrl: 'https://mcp.example.com',
          accessToken: 'mcp-token',
          expiresAt: Date.now() + HOUR,
        },
      },
    }

    mock.module('../../utils/secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-test-storage',
        read: () => store,
        readAsync: async () => store,
        update: (next: SecureStorageData) => {
          store = next
          return { success: true }
        },
        delete: () => {
          deleteCalls += 1
          store = {}
          return true
        },
      }),
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('promotes the survivor and keeps the session authenticated', async () => {
    const { performLogout } = await import('./logout.js')
    const { getClaudeAIOAuthTokens, clearOAuthTokenCache } = await import(
      '../../utils/auth.js'
    )
    const { saveGlobalConfig, getGlobalConfig } = await import(
      '../../utils/config.js'
    )

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { accountUuid: 'uuid-work', emailAddress: 'work@example.com' },
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

    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('work-access')

    const outcome = await performLogout({ clearOnboarding: true })

    expect(outcome).toMatchObject({
      signedOut: false,
      promoted: { key: 'uuid-personal' },
    })
    // Still logged in — as the other account, resolved through the reader
    // callers actually use rather than through the stored mirror.
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('personal-access')
    expect(Object.keys(store.claudeAiOauthAccounts ?? {})).toEqual([
      'uuid-personal',
    ])
    // The teardown is for the last account only; everything else in the blob
    // survives a partial logout.
    expect(deleteCalls).toBe(0)
    expect(store.mcpOAuth).toBeDefined()
    // Both config mirrors move: the departing identity record goes, and the
    // active-identity pointer follows the promotion.
    expect(Object.keys(getGlobalConfig().oauthAccounts ?? {})).toEqual([
      'uuid-personal',
    ])
    expect(getGlobalConfig().oauthAccount?.emailAddress).toBe(
      'personal@example.com',
    )
  })

  test('tears the whole store down when the last account goes', async () => {
    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: { 'uuid-work': tokensFor('work') },
      mcpOAuth: {
        'some-server': {
          serverName: 'some-server',
          serverUrl: 'https://mcp.example.com',
          accessToken: 'mcp-token',
          expiresAt: Date.now() + HOUR,
        },
      },
    }

    const { performLogout } = await import('./logout.js')
    const { getClaudeAIOAuthTokens, clearOAuthTokenCache } = await import(
      '../../utils/auth.js'
    )
    const { saveGlobalConfig, getGlobalConfig } = await import(
      '../../utils/config.js'
    )

    saveGlobalConfig(current => ({
      ...current,
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: 'uuid-work', emailAddress: 'work@example.com' },
      oauthAccounts: {
        'uuid-work': {
          accountUuid: 'uuid-work',
          emailAddress: 'work@example.com',
        },
      },
    }))

    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('work-access')

    const outcome = await performLogout({ clearOnboarding: true })

    expect(outcome).toEqual({ signedOut: true })
    expect(getClaudeAIOAuthTokens()).toBeNull()
    // The blob goes as a whole — including the credentials that are not
    // Claude accounts at all.
    expect(deleteCalls).toBe(1)
    expect(store.mcpOAuth).toBeUndefined()
    expect(getGlobalConfig().oauthAccount).toBeUndefined()
    expect(getGlobalConfig().oauthAccounts ?? {}).toEqual({})
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(false)
  })

  test('leaves onboarding alone when the caller did not ask for it', async () => {
    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: { 'uuid-work': tokensFor('work') },
    }

    const { performLogout } = await import('./logout.js')
    const { saveGlobalConfig, getGlobalConfig } = await import(
      '../../utils/config.js'
    )
    saveGlobalConfig(current => ({ ...current, hasCompletedOnboarding: true }))

    expect(await performLogout({ clearOnboarding: false })).toEqual({
      signedOut: true,
    })
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(true)
  })
})
