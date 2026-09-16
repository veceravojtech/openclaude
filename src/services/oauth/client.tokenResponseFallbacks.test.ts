/**
 * RFC 6749 §5.1 lets a token endpoint OMIT `scope` (when the granted scope
 * matches the request) and makes `expires_in` only RECOMMENDED. `refreshOAuthToken`
 * derived both fields with no fallback: `parseScopes(undefined)` is `[]` and
 * `Date.now() + undefined * 1000` is `NaN`.
 *
 * Neither value survives the writer. `shouldPersistTokens` declines on an empty
 * scope set (`shouldUseClaudeAIAuth` needs the inference scope) and on a falsy
 * `expiresAt` (`NaN` is falsy), and `saveOAuthTokensUnlocked` answers a decline
 * with `{ success: true }` having written nothing. The refresh has already
 * ROTATED the refresh token by then, so the one on disk is dead and the caller
 * is told the new one landed — the precondition for refresh-token reuse
 * detection to lock the account out.
 *
 * These tests drive the real refresh-and-save path against a stubbed token
 * endpoint and read the stored blob back. Asserting on `refreshOAuthToken`'s
 * return value would pass with the writer still dropping the write.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as realAxios from 'axios'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  CLAUDE_AI_PROFILE_SCOPE,
} from '../../constants/oauth.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as realSecureStorage from '../../utils/secureStorage/index.js'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'
import type { OAuthTokenExchangeResponse, OAuthTokens } from './types.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the live
// namespace object in place, so restoring from the namespace (or from a spread
// of it) would re-install the stub instead of undoing it.
const pristineRealAxios = { ...realAxios }
const pristineRealSecureStorage = { ...realSecureStorage }
const realAxiosDefault = pristineRealAxios.default

const HOUR = 60 * 60 * 1000

// The token endpoint response this run should answer with. Set per test.
let tokenResponse: Partial<OAuthTokenExchangeResponse> = {}
let tokenRequests: Array<Record<string, unknown>> = []

// Only `post` and `get` are redirected. Replacing the namespace wholesale would
// erase every other axios export for each file loaded afterwards, and
// `refreshOAuthToken`'s own catch calls `axios.isAxiosError`.
const axiosDefaultStub = Object.assign(
  function axiosStub(...args: unknown[]): unknown {
    return (realAxiosDefault as unknown as (...a: unknown[]) => unknown)(...args)
  },
  realAxiosDefault,
  {
    post: async (_url: string, body: Record<string, unknown>) => {
      tokenRequests.push(body)
      return { status: 200, statusText: 'OK', data: tokenResponse }
    },
    // The profile round-trip `refreshOAuthToken` makes when the config has no
    // cached account info. Answered so the refresh under test is the only thing
    // these cases can fail on.
    get: async () => ({
      status: 200,
      statusText: 'OK',
      data: {
        account: { uuid: 'uuid-work', email: 'work@example.com' },
        organization: { uuid: 'org-work' },
      },
    }),
  },
)

function storedTokens(): OAuthTokens {
  return {
    accessToken: 'stale-access',
    refreshToken: 'stale-refresh',
    // Already past `isOAuthTokenExpired`'s five-minute buffer, so the refresh
    // path actually runs.
    expiresAt: Date.now() - HOUR,
    scopes: [CLAUDE_AI_PROFILE_SCOPE, CLAUDE_AI_INFERENCE_SCOPE],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    tokenAccount: { uuid: 'uuid-work', emailAddress: 'work@example.com' },
  }
}

describe('a spec-compliant token response never costs the rotated refresh token', () => {
  let tmpRoot: string
  let configDir: string
  let store: SecureStorageData

  beforeEach(async () => {
    await acquireSharedMutationLock(
      'services/oauth/client.tokenResponseFallbacks.test.ts',
    )
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-token-fallbacks-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    // Every write in these tests must land in the temp root. Real credential
    // state is never read, written or deleted.
    setClaudeConfigHomeDirForTesting(configDir)
    store = { claudeAiOauth: storedTokens() }
    tokenResponse = {}
    tokenRequests = []

    mock.module('axios', () => ({
      ...pristineRealAxios,
      default: axiosDefaultStub,
    }))
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
        delete: () => true,
      }),
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/secureStorage/index.js', () => ({
        ...pristineRealSecureStorage,
      }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  afterAll(() => {
    // mock.restore() does NOT undo mock.module(); re-register from the pre-mock
    // snapshots.
    mock.module('axios', () => ({ ...pristineRealAxios }))
    mock.module('../../utils/secureStorage/index.js', () => ({
      ...pristineRealSecureStorage,
    }))
  })

  // A fresh instance per test: `getClaudeAIOAuthTokens` is memoized and the
  // refresh check dedupes concurrent callers through a module-level promise.
  async function importAuthFresh() {
    return import(`../../utils/auth.ts?ts=${Date.now()}-${Math.random()}`)
  }

  test('a response that omits `scope` still lands the rotated refresh token', async () => {
    // RFC 6749 §5.1: `scope` is OPTIONAL in the response and may be omitted
    // when the granted scope is the requested scope.
    tokenResponse = {
      access_token: 'rotated-access-no-scope',
      refresh_token: 'rotated-refresh-no-scope',
      expires_in: 28800,
    }

    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()
    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)

    // The whole point: the ROTATED value is on disk. Before the fallback, the
    // writer declined on an empty scope set, returned `{ success: true }`, and
    // left 'stale-refresh' here.
    expect(store.claudeAiOauth?.refreshToken).toBe('rotated-refresh-no-scope')
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-no-scope')
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'rotated-refresh-no-scope',
    )
    // The scopes persisted are the ones actually requested, which is what
    // keeps the stored token usable for inference on the next read.
    expect(store.claudeAiOauth?.scopes).toEqual([...CLAUDE_AI_OAUTH_SCOPES])
  })

  test('a response that omits `expires_in` still lands the rotated refresh token', async () => {
    // RFC 6749 §5.1: `expires_in` is RECOMMENDED, not required.
    tokenResponse = {
      access_token: 'rotated-access-no-expiry',
      refresh_token: 'rotated-refresh-no-expiry',
      scope: `${CLAUDE_AI_PROFILE_SCOPE} ${CLAUDE_AI_INFERENCE_SCOPE}`,
    }

    const before = Date.now()
    const { checkAndRefreshOAuthTokenIfNeeded } = await importAuthFresh()
    expect(await checkAndRefreshOAuthTokenIfNeeded()).toBe(true)

    // Before the fallback this was `Date.now() + undefined * 1000` = NaN, which
    // is falsy, so the writer declined and reported success.
    expect(store.claudeAiOauth?.refreshToken).toBe('rotated-refresh-no-expiry')
    expect(store.claudeAiOauth?.accessToken).toBe('rotated-access-no-expiry')

    const expiresAt = store.claudeAiOauth?.expiresAt
    expect(Number.isFinite(expiresAt)).toBe(true)
    // Not already expired: `isOAuthTokenExpired` treats anything inside a
    // five-minute buffer as expired, and a token that reads expired the moment
    // it is written drives an immediate refresh loop — every iteration of which
    // rotates the refresh token again.
    expect(expiresAt as number).toBeGreaterThan(before + 5 * 60 * 1000)
  })

  test('the scope fallback is the scopes requested, not a hardcoded set', async () => {
    // The non-subscriber branch of `checkAndRefreshOAuthTokenIfNeededImpl`
    // passes the stored scopes through rather than letting the default apply.
    // A fallback to `CLAUDE_AI_OAUTH_SCOPES` would silently widen those.
    const requested = [CLAUDE_AI_INFERENCE_SCOPE, 'user:sessions:claude_code']
    tokenResponse = {
      access_token: 'rotated-access-requested-scopes',
      refresh_token: 'rotated-refresh-requested-scopes',
      expires_in: 28800,
    }

    const { saveOAuthTokensIfNeeded } = await importAuthFresh()
    const { refreshOAuthToken } = await import('./client.js')

    const refreshed = await refreshOAuthToken('stale-refresh', {
      scopes: requested,
    })
    expect(tokenRequests[0]?.scope).toBe(requested.join(' '))
    expect(refreshed.scopes).toEqual(requested)

    await expect(saveOAuthTokensIfNeeded(refreshed)).resolves.toEqual({
      success: true,
    })
    expect(store.claudeAiOauth?.refreshToken).toBe(
      'rotated-refresh-requested-scopes',
    )
    expect(store.claudeAiOauth?.scopes).toEqual(requested)
  })
})
