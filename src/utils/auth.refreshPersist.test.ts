/**
 * The refresh path is the one production caller that hands the writer a blob it
 * did not build from a login: `checkAndRefreshOAuthTokenIfNeededImpl` passes the
 * response of `refreshOAuthToken` straight to `saveOAuthTokensUnlocked`.
 *
 * `refreshOAuthToken` returns `tokenAccount: undefined` whenever the token
 * endpoint omits `account` (the routine case) and `profile: undefined` whenever
 * the profile round-trip was skipped, so that caller was unconditionally
 * anonymous. The merge in `applyTokensToAccounts` papers over that whenever its
 * OWN read of the store succeeds — it falls back to the stored mirror — so the
 * interesting proof is the case where that fallback has nothing to fall back
 * to.
 *
 * The same call also discarded the writer's `{ success }` and returned `true`
 * unconditionally, so a refresh whose write never landed told its caller the
 * token was refreshed while the stale refresh token was still the one on disk,
 * and cleared the caches on top so the next read re-read the store that was
 * never updated.
 *
 * Every fixture credential here is an obviously fake string, and every read and
 * write is confined to a temp config home — the real credential store is never
 * opened.
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
import * as realKeychainHelpers from './secureStorage/macOsKeychainHelpers.js'
import * as realSecureStorage from './secureStorage/index.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import type { SecureStorageData } from './secureStorage/index.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }
const pristineRealOAuthClient = { ...realOAuthClient }
const pristineRealKeychainHelpers = { ...realKeychainHelpers }

const HOUR = 60 * 60 * 1000

/** The stored mirror: expired, and carrying identity as a login leaves it. */
function storedIdentifiedTokens(): OAuthTokens {
  return {
    accessToken: 'fake-stale-access',
    refreshToken: 'fake-stale-refresh',
    expiresAt: Date.now() - HOUR,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default',
    tokenAccount: { uuid: 'uuid-work', emailAddress: 'work@example.com' },
  }
}

/**
 * A refresh response as the endpoint frequently produces it: no `account`
 * block and no profile, so no identity at all. This is the shape
 * `refreshOAuthToken` returns on a routine rotation.
 */
function identitylessRefreshResponse(): OAuthTokens {
  return {
    accessToken: 'fake-fresh-access',
    refreshToken: 'fake-fresh-refresh',
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
  }
}

describe('the refresh path persists identity and reports its own failures', () => {
  let tmpRoot: string
  let configDir: string
  let store: SecureStorageData
  /** Every blob handed to `update`, newest last. */
  let written: SecureStorageData[]
  /** Flipped by the refresh mock to model a keyring that went away mid-refresh. */
  let syncReadDegraded: boolean
  let keychainCacheClears: number
  /** `keychainCacheClears` sampled the instant the token endpoint answered. */
  let clearsWhenRefreshReturned: number

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/auth.refreshPersist.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-refresh-persist-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    store = { claudeAiOauth: storedIdentifiedTokens() }
    written = []
    syncReadDegraded = false
    keychainCacheClears = 0
    clearsWhenRefreshReturned = -1
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => ({
        ...pristineRealSecureStorage,
      }))
      mock.module('../services/oauth/client.js', () => ({
        ...pristineRealOAuthClient,
      }))
      mock.module('./secureStorage/macOsKeychainHelpers.js', () => ({
        ...pristineRealKeychainHelpers,
      }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  /**
   * In-memory storage. `read` and `readAsync` are modelled as INDEPENDENT
   * lookups because that is what they are: `linuxSecretStorage` runs one
   * `secret-tool` invocation per call (`execaSync` vs `execa`, both with
   * `reject: false`), so one can come back empty while the other succeeded.
   */
  function mockStorage(
    update: (next: SecureStorageData) => { success: boolean; warning?: string },
  ) {
    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-test-storage',
        read: () => (syncReadDegraded ? null : store),
        readAsync: async () => store,
        update,
        delete: () => true,
      }),
    }))
  }

  /** `update` succeeds and the store moves, as a healthy keyring behaves. */
  function recordingUpdate(next: SecureStorageData) {
    written.push(next)
    store = next
    return { success: true }
  }

  function mockRefresh(response: () => OAuthTokens) {
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => {
        const tokens = response()
        clearsWhenRefreshReturned = keychainCacheClears
        return tokens
      },
    }))
  }

  /** Counts `clearKeychainCache`, one of the two clears a failed persist must skip. */
  function mockKeychainHelpers() {
    mock.module('./secureStorage/macOsKeychainHelpers.js', () => ({
      ...realKeychainHelpers,
      clearKeychainCache: () => {
        keychainCacheClears++
        // The PRISTINE snapshot, not the live namespace: mock.module() has
        // already replaced the namespace's binding with this very function, so
        // calling through it would recurse.
        pristineRealKeychainHelpers.clearKeychainCache()
      },
    }))
  }

  async function importAuthFresh() {
    return import(`./auth.ts?ts=${Date.now()}-${Math.random()}`)
  }

  /**
   * A REGRESSION pin, not a fail-before proof: the merge in
   * `applyTokensToAccounts` already restores identity from the stored mirror
   * (`tokenAccount: tokens.tokenAccount ?? existingOauth?.tokenAccount`), so a
   * refresh whose writer-side read succeeds has always written identity. It is
   * kept because it is the property users actually depend on, and because
   * attaching identity upstream must not disturb it.
   */
  test('a refresh of an identified account writes identity to storage', async () => {
    mockStorage(recordingUpdate)
    mockRefresh(identitylessRefreshResponse)

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.claudeAiOauth?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    expect(
      written[0]?.claudeAiOauthAccounts?.['uuid-work']?.tokenAccount,
    ).toEqual({ uuid: 'uuid-work', emailAddress: 'work@example.com' })
    expect(written[0]?.claudeAiOauthActive).toBe('uuid-work')
  })

  /**
   * The fail-before proof. The merge can only restore identity from a read of
   * its own that succeeded; when that read comes back empty there is nothing to
   * restore from, and an anonymous blob is keyed as the legacy key — stranding
   * the real account and pointing the active slot at a phantom one.
   *
   * With the identity the refresh path already holds in `lockedTokens` attached
   * to the blob, the write stays the user's own account no matter what the
   * writer's own read returned.
   */
  test('identity from the refresh path survives a writer-side read that came back empty', async () => {
    mockStorage(recordingUpdate)
    // The keyring answers the refresh path's async read, then stops answering
    // the writer's sync one.
    mockRefresh(() => {
      syncReadDegraded = true
      return identitylessRefreshResponse()
    })

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.claudeAiOauth?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    // Keyed as the real account rather than the anonymous legacy key.
    expect(written[0]?.claudeAiOauthActive).toBe('uuid-work')
    expect(Object.keys(written[0]?.claudeAiOauthAccounts ?? {})).toEqual([
      'uuid-work',
    ])
    // The rotated token still landed — identity must not cost the rotation.
    expect(written[0]?.claudeAiOauth?.accessToken).toBe('fake-fresh-access')
  })

  /**
   * The behaviour a writer-side refusal would have broken: a routine
   * identity-less rotation of the ACTIVE account must still be written. A
   * legitimate rotation and a foreign blob reach the writer with the same keys
   * and the same `refreshToken !== stored.refreshToken`, so nothing about this
   * write may become conditional on the response carrying identity.
   */
  test('a legitimate identity-less rotation of the active account still lands', async () => {
    mockStorage(recordingUpdate)
    mockRefresh(identitylessRefreshResponse)

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(store.claudeAiOauth?.accessToken).toBe('fake-fresh-access')
    expect(store.claudeAiOauth?.refreshToken).toBe('fake-fresh-refresh')
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.accessToken).toBe(
      'fake-fresh-access',
    )
    expect(store.claudeAiOauthActive).toBe('uuid-work')
  })

  /**
   * The writer reported failure, so nothing reached the store: the caller must
   * be told the refresh did not happen, and the caches must be left alone
   * rather than cleared onto a store that was never updated.
   */
  test('a refresh whose persist failed resolves false and leaves the stored token alone', async () => {
    mockKeychainHelpers()
    // A keyring that refuses the write: `update` reports failure and the store
    // does not move, which is what a failed `secret-tool store` leaves behind.
    mockStorage(next => {
      written.push(next)
      return { success: false, warning: 'Failed to save OAuth tokens' }
    })
    mockRefresh(identitylessRefreshResponse)

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    // The write was attempted, and the stale credential is still the stored one.
    expect(written).toHaveLength(1)
    expect(store.claudeAiOauth?.refreshToken).toBe('fake-stale-refresh')
    expect(store.claudeAiOauth?.accessToken).toBe('fake-stale-access')
    // No cache was cleared after the refresh returned: clearing them would send
    // the next read back to the store that was never updated.
    expect(clearsWhenRefreshReturned).toBeGreaterThanOrEqual(0)
    expect(keychainCacheClears).toBe(clearsWhenRefreshReturned)
  })
})
