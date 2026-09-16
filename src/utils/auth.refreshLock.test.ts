/**
 * The refresh path holds the credential lock across its whole read-modify-write,
 * and `proper-lockfile` is not reentrant. A saver that took the lock again from
 * in there would burn its ELOCKED retries and throw on EVERY token refresh —
 * silently, because the refresh swallows the error and just reports failure.
 *
 * That is why `saveOAuthTokensUnlocked` exists and why
 * `checkAndRefreshOAuthTokenIfNeededImpl` calls it instead of the locked
 * `saveOAuthTokensIfNeeded`. These tests pin that split from the outside: they
 * assert the refresh actually persists, and that the locked saver really is the
 * one that would deadlock.
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
import * as realOAuthClient from '../services/oauth/client.js'
import * as realSecureStorage from './secureStorage/index.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import type { SecureStorageData } from './secureStorage/index.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }
const pristineRealOAuthClient = { ...realOAuthClient }

const HOUR = 60 * 60 * 1000

function expiredTokens(): OAuthTokens {
  return {
    accessToken: 'stale-access',
    refreshToken: 'stale-refresh',
    expiresAt: Date.now() - HOUR,
    scopes: ['user:inference'],
    tokenAccount: { uuid: 'uuid-work', emailAddress: 'work@example.com' },
  }
}

function freshTokens(): OAuthTokens {
  return {
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
    tokenAccount: { uuid: 'uuid-work', emailAddress: 'work@example.com' },
  }
}

describe('token refresh persists through the non-reentrant credential lock', () => {
  let tmpRoot: string
  let configDir: string
  let store: SecureStorageData

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/auth.refreshLock.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-refresh-lock-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    store = { claudeAiOauth: expiredTokens() }
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => ({ ...pristineRealSecureStorage }))
      mock.module('../services/oauth/client.js', () => ({ ...pristineRealOAuthClient }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  function mockStorage() {
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
  }

  async function importAuthFresh() {
    return import(`./auth.ts?ts=${Date.now()}-${Math.random()}`)
  }

  test('an expired token is refreshed and the new one is written', async () => {
    mockStorage()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => freshTokens(),
    }))

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    // Fails if the refresh path ever takes the credential lock a second time:
    // the inner acquisition throws CredentialLockError, the refresh swallows it,
    // and this comes back false with the stale token still on disk.
    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(store.claudeAiOauth?.accessToken).toBe('fresh-access')
    expect(store.claudeAiOauth?.refreshToken).toBe('fresh-refresh')
    // The refreshed tokens land in the accounts map under the real account key,
    // not a phantom `default` entry.
    expect(store.claudeAiOauthActive).toBe('uuid-work')
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.accessToken).toBe(
      'fresh-access',
    )
  })

  test('the refresh releases the credential lock it took', async () => {
    mockStorage()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => freshTokens(),
    }))

    const { checkAndRefreshOAuthTokenIfNeeded, saveOAuthTokensIfNeeded } =
      await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)

    // A leaked lock would strand every later writer. The locked saver is the
    // cheapest real prover: it acquires the same config-directory lock, so it
    // only succeeds if the refresh gave it back.
    store.claudeAiOauth = expiredTokens()
    await expect(saveOAuthTokensIfNeeded(freshTokens())).resolves.toEqual({
      success: true,
    })
    expect(store.claudeAiOauth?.accessToken).toBe('fresh-access')
  })

  test('inference-only tokens are not persisted', async () => {
    mockStorage()
    const { saveOAuthTokensIfNeeded } = await importAuthFresh()

    // The GitHub App flow mints tokens with no refresh token. They write
    // nothing, and the guard that decides so runs before the lock is taken so
    // a no-op save can never fail on a contended lock.
    expect(
      await saveOAuthTokensIfNeeded({
        accessToken: 'inference-only',
        refreshToken: null,
        expiresAt: null,
        scopes: ['user:inference'],
      } as unknown as OAuthTokens),
    ).toEqual({ success: true })

    expect(store.claudeAiOauth?.accessToken).toBe('stale-access')
    expect(store.claudeAiOauthAccounts).toBeUndefined()
  })
})
