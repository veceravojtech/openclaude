/**
 * A login must ADD an account, never replace the set of them.
 *
 * `installOAuthTokens` used to open with `performLogout()` to "clear old
 * state". That call wiped the whole accounts map seventeen lines before
 * `saveOAuthTokensIfNeeded` merged the new account into it, so every login
 * started from an empty map — and `/account add`, which is a login, destroyed
 * every stored account while reporting "Account added and activated."
 *
 * The regression is silent by construction: the command succeeds, the new
 * account works, and the loss is only visible the next time the user looks for
 * an account they did not touch. So the assertion below is deliberately about
 * the accounts nobody asked about.
 *
 * Only the network edges are stubbed. The account-storage path — the part that
 * used to be preceded by a wipe — runs for real, which is what makes this go
 * red if the wipe ever comes back.
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

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }

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

describe('installing OAuth tokens for a second account', () => {
  let tmpRoot: string
  let store: SecureStorageData
  let deleteCalls: number

  beforeEach(async () => {
    await acquireSharedMutationLock('cli/handlers/auth.installTokens.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-install-tokens-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    deleteCalls = 0
    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: { 'uuid-work': tokensFor('work') },
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

    // Network edges only. Everything that touches stored accounts stays real.
    mock.module('../../services/oauth/getOauthProfile.js', () => ({
      getOauthProfileFromOauthToken: async () => null,
    }))
    mock.module('../../services/api/firstTokenDate.js', () => ({
      fetchAndStoreClaudeCodeFirstTokenDate: async () => {},
    }))
    const realClient = await import('../../services/oauth/client.js')
    mock.module('../../services/oauth/client.js', () => ({
      ...realClient,
      fetchAndStoreUserRoles: async () => {},
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/secureStorage/index.js', () => ({ ...pristineRealSecureStorage }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('keeps the account already stored and activates the new one', async () => {
    const { installOAuthTokens } = await import('./auth.js')
    const { getClaudeAIOAuthTokens, clearOAuthTokenCache } = await import(
      '../../utils/auth.js'
    )

    await installOAuthTokens(tokensFor('personal'))

    // The account nobody asked about is still there, with its own refresh
    // token — not merely a surviving key pointing at the new credentials.
    expect(Object.keys(store.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'work-refresh',
    )
    // Nothing here is a logout, so the teardown must not have run.
    expect(deleteCalls).toBe(0)

    // And the login did what it was for: the new account is the active one.
    expect(store.claudeAiOauthActive).toBe('uuid-personal')
    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('personal-access')
  })

  test('drops a stored API key, because an OAuth login supersedes it', async () => {
    const { installOAuthTokens } = await import('./auth.js')
    const { getGlobalConfig, saveGlobalConfig } = await import(
      '../../utils/config.js'
    )

    saveGlobalConfig(current => ({ ...current, primaryApiKey: 'sk-ant-old' }))

    await installOAuthTokens(tokensFor('personal'))

    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
  })
})
