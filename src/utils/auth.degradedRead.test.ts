/**
 * A read that FAILED and a store that is EMPTY used to be the same value.
 *
 * `createFallbackStorage`'s `read` ends `secondary.read() || {}` and every leaf
 * backend returns `null` for both a miss and a failure, so
 * `saveOAuthTokensUnlocked` — which does a whole-blob read-modify-write —
 * received `{}` from a keyring that had merely gone away, keyed the incoming
 * tokens onto that empty blob and wrote it over the real one. One locked
 * keyring or one D-Bus hiccup erased every stored account plus `codex`,
 * `mcpOAuth` and `pluginSecrets`, AND reported success to its caller.
 *
 * These tests pin the distinction at the writer: UNREADABLE aborts the write,
 * ABSENT still writes (a first run must not become an error), and a storage
 * that cannot classify its own read keeps the behaviour it had before the
 * distinction existed.
 *
 * Every fixture credential is an obviously fake string, storage is stubbed
 * in-memory, and the config home is a fresh temp dir — the real credential
 * store is never opened and no credentials file is ever written.
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
import type {
  SecureStorageData,
  SecureStorageReadResult,
} from './secureStorage/index.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }
const pristineRealOAuthClient = { ...realOAuthClient }
const pristineRealKeychainHelpers = { ...realKeychainHelpers }

const HOUR = 60 * 60 * 1000

/** The active account's stored tokens: expired, so a refresh is due. */
function storedWorkTokens(): OAuthTokens {
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

/** A second logged-in account, the one a clobbering write strands. */
function storedPersonalTokens(): OAuthTokens {
  return {
    accessToken: 'fake-personal-access',
    refreshToken: 'fake-personal-refresh',
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    tokenAccount: { uuid: 'uuid-personal', emailAddress: 'home@example.com' },
  }
}

/**
 * Two accounts plus the non-Claude entries that share the blob. `codex` and
 * `pluginSecrets` are here because the writer replaces the WHOLE object: they
 * go down with the accounts, and nothing else in the suite would notice.
 */
function storedTwoAccountBlob(): SecureStorageData {
  return {
    claudeAiOauth: storedWorkTokens(),
    claudeAiOauthAccounts: {
      'uuid-work': { ...storedWorkTokens(), label: 'work' },
      'uuid-personal': { ...storedPersonalTokens(), label: 'personal' },
    },
    claudeAiOauthActive: 'uuid-work',
    codex: { accessToken: 'fake-codex-access' },
    pluginSecrets: { 'fake-plugin': { apiKey: 'fake-plugin-secret' } },
  }
}

/**
 * A refresh response as the endpoint frequently produces it: no `account`
 * block and no profile, so no identity of its own.
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

describe('a read that failed is not an empty store', () => {
  let tmpRoot: string
  let configDir: string
  let store: SecureStorageData
  /** Every blob handed to `update`, newest last. Stays empty on an abort. */
  let written: SecureStorageData[]
  /** Flipped by the refresh mock to model a keyring that went away mid-refresh. */
  let syncReadUnreadable: boolean
  let keychainCacheClears: number
  /** `keychainCacheClears` sampled the instant the token endpoint answered. */
  let clearsWhenRefreshReturned: number

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/auth.degradedRead.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-degraded-read-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    store = storedTwoAccountBlob()
    written = []
    syncReadUnreadable = false
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

  /** `update` succeeds and the store moves, as a healthy keyring behaves. */
  function recordingUpdate(next: SecureStorageData) {
    written.push(next)
    store = next
    return { success: true }
  }

  /**
   * In-memory storage that CAN classify its read, as the composed
   * `createFallbackStorage` does after this change.
   *
   * `read` keeps returning `null` for the unreadable case on purpose: that is
   * the projection every existing caller still sees, and
   * `createFallbackStorage`'s `update` reads it to decide whether to delete the
   * primary entry. Only `readResult` carries the new distinction.
   */
  function mockClassifyingStorage(
    update: (next: SecureStorageData) => { success: boolean; warning?: string },
  ) {
    const readResult = (): SecureStorageReadResult =>
      syncReadUnreadable
        ? { status: 'unreadable', reason: 'test: the keyring refused the lookup' }
        : { status: 'ok', data: store }

    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-test-storage',
        read: () => {
          const result = readResult()
          return result.status === 'ok' ? result.data : null
        },
        readResult,
        // The refresh path's own read, taken under the lock, still answers —
        // the writer's later sync read is the one that fails.
        readAsync: async () => store,
        update,
        delete: () => true,
      }),
    }))
  }

  /** A storage with an EMPTY store, classified as such: a first run. */
  function mockAbsentStorage() {
    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-absent-storage',
        read: () => null,
        readResult: (): SecureStorageReadResult => ({ status: 'absent' }),
        readAsync: async () => null,
        update: recordingUpdate,
        delete: () => true,
      }),
    }))
  }

  /**
   * A storage from before the distinction existed: it implements `read` only.
   * Its `null` must keep meaning what it has always meant, or every backend
   * that cannot classify its read yet would start refusing writes.
   */
  function mockLegacyStorage() {
    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-legacy-storage',
        read: () => null,
        readAsync: async () => null,
        update: recordingUpdate,
        delete: () => true,
      }),
    }))
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

  /** Counts `clearKeychainCache`, one of the two clears an aborted write must skip. */
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
   * THE HEADLINE PROOF. The keyring answers the refresh path's own read, then
   * stops answering the writer's — the shape of a `ksecretd` restart landing
   * between the two lookups. Before this change the writer read that failure as
   * an empty store, reconciled the refreshed tokens onto `{}` and wrote the
   * result over both accounts, `codex` and `pluginSecrets`, then told its caller
   * the refresh had succeeded.
   */
  test('a refresh whose writer-side read failed keeps every stored account and reports failure', async () => {
    mockKeychainHelpers()
    mockClassifyingStorage(recordingUpdate)
    mockRefresh(() => {
      syncReadUnreadable = true
      return identitylessRefreshResponse()
    })

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()
    const refreshed = await checkAndRefreshOAuthTokenIfNeeded()

    // Nothing was erased: both accounts, and the entries that share the blob.
    expect(Object.keys(store.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    expect(store.codex?.accessToken).toBe('fake-codex-access')
    expect(store.pluginSecrets?.['fake-plugin']?.apiKey).toBe(
      'fake-plugin-secret',
    )
    // No anonymous entry was invented for the blob that never got written.
    expect(store.claudeAiOauthAccounts?.default).toBeUndefined()
    // The refresh REPORTED FAILURE rather than claiming a write that never
    // landed: the token the caller goes on to present is the stored one.
    expect(refreshed).toBe(false)
    // The write was never attempted at all — this is an abort, not a failed
    // `update` that happened to leave the store alone.
    expect(written).toHaveLength(0)
    // The stored refresh token is untouched, so the next attempt can still
    // rotate from it.
    expect(store.claudeAiOauth?.refreshToken).toBe('fake-stale-refresh')
    expect(store.claudeAiOauth?.accessToken).toBe('fake-stale-access')
    // No cache was cleared after the token endpoint answered: clearing them
    // would send the next read back to a store that was never updated.
    expect(clearsWhenRefreshReturned).toBeGreaterThanOrEqual(0)
    expect(keychainCacheClears).toBe(clearsWhenRefreshReturned)
  })

  /**
   * The writer's own contract, without the refresh path around it: a store that
   * could not be read must not be reconciled onto. The tokens here carry no
   * identity, which is what made the clobbering blob key itself as the legacy
   * `default` account.
   */
  test('the writer refuses to reconcile onto an empty blob when the store could not be read', async () => {
    mockClassifyingStorage(recordingUpdate)
    const { saveOAuthTokensUnlocked } = await importAuthFresh()

    syncReadUnreadable = true
    const result = saveOAuthTokensUnlocked(identitylessRefreshResponse())

    expect(result.success).toBe(false)
    expect(result.warning).toBeTruthy()
    expect(written).toHaveLength(0)
    // The populated store is exactly as it was: no `default` key, both
    // accounts, stale tokens still stale.
    expect(Object.keys(store.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    expect(store.claudeAiOauthAccounts?.default).toBeUndefined()
    expect(store.claudeAiOauthActive).toBe('uuid-work')
    expect(store.claudeAiOauth?.refreshToken).toBe('fake-stale-refresh')
  })

  /**
   * THE OVER-CORRECTION GUARD. Refusing to write when the store cannot be read
   * must not turn a first run into an error: an ABSENT store has nothing to
   * lose, and a login that cannot write its tokens is as broken as a refresh
   * that erases them.
   */
  test('a genuinely empty store is still written on a first run', async () => {
    mockAbsentStorage()
    const { saveOAuthTokensUnlocked } = await importAuthFresh()

    const result = saveOAuthTokensUnlocked(identitylessRefreshResponse())

    expect(result.success).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.claudeAiOauth?.accessToken).toBe('fake-fresh-access')
    expect(written[0]?.claudeAiOauth?.refreshToken).toBe('fake-fresh-refresh')
  })

  /**
   * Back-compatibility. `readResult` is optional, and a backend that does not
   * implement it says nothing about WHY its read was empty — so `read`'s `null`
   * keeps its pre-existing meaning and the write proceeds exactly as before.
   * Reading a missing classifier as a failure would have refused every write on
   * macOS and Windows, where the primary backend does not classify yet.
   */
  test('a storage that cannot classify its read still writes, as it always did', async () => {
    mockLegacyStorage()
    const { saveOAuthTokensUnlocked } = await importAuthFresh()

    const result = saveOAuthTokensUnlocked(identitylessRefreshResponse())

    expect(result.success).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.claudeAiOauth?.accessToken).toBe('fake-fresh-access')
  })
})
