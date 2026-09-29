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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
  const envKeys = ['CLAUDE_CODE_USE_OPENAI', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY', 'OPENCLAUDE_TEAMMATE_PROFILE_ID', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/auth.refreshLock.test.ts')
    mock.restore()
    savedEnv = { ...process.env }
    for (const key of envKeys) delete process.env[key]
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-refresh-lock-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    store = { claudeAiOauth: expiredTokens() }
  })

  afterEach(() => {
    try {
      mock.restore()
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
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

  test('native vault changes invalidate the memoized token despite unchanged fallback mtime', async () => {
    mockStorage()
    writeFileSync(join(configDir, '.credentials.json'), '{}')
    store = { claudeAiOauth: freshTokens() }
    const auth = await importAuthFresh()
    await auth.checkAndRefreshOAuthTokenIfNeeded()
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('fresh-access')
    store = { claudeAiOauth: { ...freshTokens(), accessToken: 'sibling-access' } }
    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now + 31_000)
    try {
      await auth.checkAndRefreshOAuthTokenIfNeeded()
      expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('sibling-access')
    } finally { clock.mockRestore() }
  })

  test('revocation recovery adopts only a different unexpired stored token', async () => {
    mockStorage()
    const auth = await importAuthFresh()
    store = { claudeAiOauth: freshTokens() }
    expect(await auth.recoverRotatedOAuthToken('fresh-access')).toBe(false)
    expect(await auth.recoverRotatedOAuthToken('old-access')).toBe(true)
    store = { claudeAiOauth: expiredTokens() }
    expect(await auth.recoverRotatedOAuthToken('old-access')).toBe(false)
  })

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

  // A fake token endpoint with the property that bit the teammate burst: the
  // refresh token ROTATES on use, and presenting one that was already spent
  // gets the request refused as revoked.
  function rotatingEndpoint() {
    const state = { validRefresh: 'stale-refresh', calls: 0, rejected: 0 }
    const refreshOAuthToken = async (refreshToken: string) => {
      state.calls++
      const n = state.calls
      await new Promise(resolve => setTimeout(resolve, 60))
      if (refreshToken !== state.validRefresh) {
        state.rejected++
        throw new Error('OAuth access token has been revoked.')
      }
      state.validRefresh = `rotated-refresh-${n}`
      return {
        ...freshTokens(),
        accessToken: `rotated-access-${n}`,
        refreshToken: state.validRefresh,
      }
    }
    return { state, refreshOAuthToken }
  }

  const PROCESSES = 8

  test('a burst of processes on an expired token refreshes exactly once', async () => {
    mockStorage()
    const endpoint = rotatingEndpoint()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: endpoint.refreshOAuthToken,
    }))

    // Each fresh import is its own module instance, so the in-process dedup
    // (`pendingRefreshCheck`) and the memoized token cache are NOT shared —
    // the only thing they have in common is the disk and its lock, exactly
    // like N `openclaude --agent-id ...` processes.
    const procs = await Promise.all(
      Array.from({ length: PROCESSES }, () => importAuthFresh()),
    )
    await Promise.all(procs.map(p => p.checkAndRefreshOAuthTokenIfNeeded()))

    expect(endpoint.state.calls).toBe(1)
    expect(endpoint.state.rejected).toBe(0)
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-1')
    expect(store.claudeAiOauth?.refreshToken).toBe('rotated-refresh-1')
    for (const p of procs) {
      expect(p.getClaudeAIOAuthTokens()?.accessToken).toBe('rotated-access-1')
    }
  }, 30_000)

  test('a burst of forced 401 recoveries refreshes once and all report a usable token', async () => {
    mockStorage()
    const endpoint = rotatingEndpoint()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: endpoint.refreshOAuthToken,
    }))

    const procs = await Promise.all(
      Array.from({ length: PROCESSES }, () => importAuthFresh()),
    )
    // Every process was rejected with the same stale access token. The losers
    // find the winner's token on disk after the lock; that must read as
    // "recovered" (true), not as a dead grant (false) — withRetry stops the
    // request on false.
    const results = await Promise.all(
      procs.map(p => p.handleOAuth401Error('stale-access')),
    )

    expect(results).toEqual(Array(PROCESSES).fill(true))
    expect(endpoint.state.calls).toBe(1)
    expect(endpoint.state.rejected).toBe(0)
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-1')
  }, 30_000)

  test('a forced refresh replaces a locally-valid token the server rejected', async () => {
    mockStorage()
    store = { claudeAiOauth: { ...freshTokens(), accessToken: 'server-rejected' } }
    const endpoint = rotatingEndpoint()
    endpoint.state.validRefresh = 'fresh-refresh'
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: endpoint.refreshOAuthToken,
    }))

    const { handleOAuth401Error } = await importAuthFresh()

    expect(await handleOAuth401Error('server-rejected')).toBe(true)
    expect(endpoint.state.calls).toBe(1)
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-1')
  })

  test('a forced refresh refreshes a different-but-expired token instead of adopting it', async () => {
    mockStorage()
    store = {
      claudeAiOauth: {
        ...expiredTokens(),
        accessToken: 'different-expired-access',
      },
    }
    const endpoint = rotatingEndpoint()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: endpoint.refreshOAuthToken,
    }))

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    // The disk token differs from the rejected one, so the force branch would
    // otherwise adopt it — but it is also expired, so it must be refreshed.
    expect(
      await checkAndRefreshOAuthTokenIfNeeded(0, true, 'server-rejected'),
    ).toBe(true)
    expect(endpoint.state.calls).toBe(1)
    expect(endpoint.state.rejected).toBe(0)
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-1')
    expect(store.claudeAiOauth?.refreshToken).toBe('rotated-refresh-1')
  })

  test('a forced refresh still adopts a different unexpired token without a network call', async () => {
    mockStorage()
    store = {
      claudeAiOauth: { ...freshTokens(), accessToken: 'different-fresh-access' },
    }
    const endpoint = rotatingEndpoint()
    endpoint.state.validRefresh = 'fresh-refresh'
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: endpoint.refreshOAuthToken,
    }))

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(
      await checkAndRefreshOAuthTokenIfNeeded(0, true, 'server-rejected'),
    ).toBe(true)
    expect(endpoint.state.calls).toBe(0)
    expect(store.claudeAiOauth?.accessToken).toBe('different-fresh-access')
  })

  test('a forced refresh rejected as revoked does not adopt the same rejected token', async () => {
    mockStorage()
    store = {
      claudeAiOauth: { ...freshTokens(), accessToken: 'server-rejected' },
    }
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => {
        throw new Error('OAuth access token has been revoked.')
      },
    }))

    const { handleOAuth401Error } = await importAuthFresh()

    expect(await handleOAuth401Error('server-rejected')).toBe(false)
    expect(store.claudeAiOauth?.accessToken).toBe('server-rejected')
  })

  test('a revoked refresh re-reads the disk and adopts a token a sibling wrote meanwhile', async () => {
    mockStorage()
    let calls = 0
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => {
        calls++
        // A writer that does not take our lock lands its token while our
        // request is in flight; our own request is then refused.
        store = { claudeAiOauth: freshTokens() }
        throw new Error('OAuth access token has been revoked.')
      },
    }))

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)
    expect(calls).toBe(1)
    expect(store.claudeAiOauth?.accessToken).toBe('fresh-access')
  })

  test('a revoked refresh with nothing new on disk reports failure and keeps the store', async () => {
    mockStorage()
    mock.module('../services/oauth/client.js', () => ({
      ...realOAuthClient,
      refreshOAuthToken: async () => {
        throw new Error('OAuth access token has been revoked.')
      },
    }))

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()

    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    expect(store.claudeAiOauth?.accessToken).toBe('stale-access')
  })
})
