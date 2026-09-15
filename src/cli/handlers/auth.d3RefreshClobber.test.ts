/**
 * A refresh-token login must not overwrite whoever is already logged in.
 *
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` exchanges a refresh token for a session
 * without a browser (`authLogin`, auth.ts:149-167). That grant answers with no
 * `account` block, and `refreshOAuthToken` only attaches a profile when the
 * machine does not already have one — on a logged-in machine it always does.
 * So `installOAuthTokens` is handed a blob carrying NO identity at all, for an
 * account that is NOT the active one.
 *
 * The handler then fetches that token's real profile (auth.ts:64-65) and used
 * to spend it on `storeOAuthAccountInfo` alone, passing the ORIGINAL blob to
 * `saveOAuthTokensIfNeeded`. With no identity on the blob, `accountKeyForTokens`
 * returns undefined and the write keys off `claudeAiOauthActive` — so the
 * incoming account's tokens landed on the ACTIVE account's entry and destroyed
 * its refresh token. Nothing reported an error: the login succeeded, the new
 * session worked, and the loss only surfaced later as an account that could no
 * longer refresh and had to be logged in again.
 *
 * These tests drive the handler end to end against the REAL plaintext storage
 * backend in a temp config home and assert on the JSON that lands ON DISK,
 * reading the file back rather than trusting an in-memory value. Only the
 * network edges are stubbed; the whole account-storage path runs for real.
 *
 * Every credential string here is an obviously fake fixture.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  OAuthProfileResponse,
  OAuthTokens,
} from '../../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as realSecureStorage from '../../utils/secureStorage/index.js'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'

const HOUR = 60 * 60 * 1000

function profileFor(who: string): OAuthProfileResponse {
  return {
    account: { uuid: `uuid-${who}`, email: `${who}@example.com` },
    organization: { uuid: `org-${who}` },
  }
}

/** Account A as a logged-in machine already has it stored: identity included. */
function storedTokensFor(who: string): OAuthTokens {
  return {
    accessToken: `fake-access-${who}`,
    refreshToken: `fake-refresh-${who}`,
    expiresAt: Date.now() + HOUR,
    scopes: ['user:profile', 'user:inference'],
    tokenAccount: {
      uuid: `uuid-${who}`,
      emailAddress: `${who}@example.com`,
    },
  }
}

/**
 * What the refresh-token grant hands `installOAuthTokens`: credentials for
 * account B with nothing on them that says so — no `tokenAccount`, no
 * `profile`.
 */
function identitylessTokens(who: string): OAuthTokens {
  return {
    accessToken: `fake-access-${who}`,
    refreshToken: `fake-refresh-${who}`,
    expiresAt: Date.now() + HOUR,
    scopes: ['user:profile', 'user:inference'],
  }
}

describe('a refresh-token login for a second account', () => {
  let tmpRoot: string
  let configDir: string

  beforeEach(async () => {
    await acquireSharedMutationLock('cli/handlers/auth.d3RefreshClobber.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-d3-refresh-clobber-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    // Every credential read and write below is confined to this temp config
    // home; the real credential store is never opened.
    setClaudeConfigHomeDirForTesting(configDir)

    // The REAL plaintext backend, so the handler performs a genuine atomic
    // write into the temp home and the assertions can read the file back.
    mock.module('../../utils/secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => plainTextStorage,
    }))

    // Account A is logged in and active, exactly as a machine that has been
    // used for a while has it on disk.
    const seeded: SecureStorageData = {
      claudeAiOauth: storedTokensFor('a'),
      claudeAiOauthActive: 'uuid-a',
      claudeAiOauthAccounts: { 'uuid-a': storedTokensFor('a') },
    }
    expect(plainTextStorage.update(seeded).success).toBe(true)

    // Network edges only. The profile endpoint answers for the token it is
    // given, which here is B's — that is the identity the handler holds and
    // used to discard.
    mock.module('../../services/oauth/getOauthProfile.js', () => ({
      getOauthProfileFromOauthToken: async () => profileFor('b'),
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
      mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  /** The credentials file as it actually exists on disk. */
  function readFromDisk(): SecureStorageData {
    return JSON.parse(
      readFileSync(join(configDir, '.credentials.json'), { encoding: 'utf8' }),
    ) as SecureStorageData
  }

  async function loginFromRefreshToken(who: string): Promise<void> {
    const { installOAuthTokens } = await import('./auth.js')
    await installOAuthTokens(identitylessTokens(who))
  }

  test('leaves the already-logged-in account its own refresh token', async () => {
    await loginFromRefreshToken('b')

    const onDisk = readFromDisk()

    // The whole point: A was never asked about, so A is untouched. A refresh
    // token that is gone cannot be recovered without logging in again.
    expect(onDisk.claudeAiOauthAccounts?.['uuid-a']?.refreshToken).toBe(
      'fake-refresh-a',
    )
    expect(onDisk.claudeAiOauthAccounts?.['uuid-a']?.accessToken).toBe(
      'fake-access-a',
    )
  })

  test("stores the new session under the new account's own key", async () => {
    await loginFromRefreshToken('b')

    const onDisk = readFromDisk()

    expect(Object.keys(onDisk.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-a',
      'uuid-b',
    ])
    expect(onDisk.claudeAiOauthAccounts?.['uuid-b']?.refreshToken).toBe(
      'fake-refresh-b',
    )
    // And the login did what it was for: B is the active account, mirrored.
    expect(onDisk.claudeAiOauthActive).toBe('uuid-b')
    expect(onDisk.claudeAiOauth?.accessToken).toBe('fake-access-b')
  })

  /**
   * The quieter half of the same defect. Identity on the stored blob falls back
   * to whatever the mirror holds, so an entry can end up holding one account's
   * tokens while announcing another account's email — and `/account
   * a@example.com` then switches onto the wrong session instead of failing.
   * Route the write by real identity and no entry can say that.
   */
  test('never stamps one account identity onto another account tokens', async () => {
    await loginFromRefreshToken('b')

    const onDisk = readFromDisk()

    // A's entry holds A's tokens and says it is A.
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-a']?.tokenAccount?.uuid,
    ).toBe('uuid-a')
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-a']?.tokenAccount?.emailAddress,
    ).toBe('a@example.com')

    // B's entry holds B's tokens and says it is B — not A's email attached to
    // B's session.
    expect(onDisk.claudeAiOauthAccounts?.['uuid-b']?.accessToken).toBe(
      'fake-access-b',
    )
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-b']?.tokenAccount?.uuid,
    ).toBe('uuid-b')
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-b']?.tokenAccount?.emailAddress,
    ).toBe('b@example.com')
    expect(onDisk.claudeAiOauthAccounts?.['uuid-b']?.profile?.account.uuid).toBe(
      'uuid-b',
    )

    // Stated once over the whole file, so a third account cannot reintroduce
    // it: every entry's recorded identity matches the key it is filed under.
    for (const [key, entry] of Object.entries(
      onDisk.claudeAiOauthAccounts ?? {},
    )) {
      expect(entry.tokenAccount?.uuid ?? entry.profile?.account.uuid).toBe(key)
    }

    // The mirror is the active account verbatim, identity included.
    expect(onDisk.claudeAiOauth?.tokenAccount?.uuid).toBe('uuid-b')
  })

  /**
   * PINS THE RESIDUAL THIS SUITE DOES NOT CLOSE — deliberately GREEN.
   *
   * The three tests above all take the branch where the profile endpoint
   * ANSWERS. `installOAuthTokens` fetches identity at auth.ts:63-65, and
   * `getOauthProfileFromOauthToken` swallows every error and returns
   * `undefined` (getOauthProfile.ts:50-52) — so a network blip, a 5xx, a rate
   * limit, or a `CLAUDE_CODE_OAUTH_SCOPES` value without `user:profile` all
   * arrive here as "no profile". The ternary at auth.ts:99-111 then falls
   * through to the raw blob, and the ORIGINAL D3 clobber happens unchanged.
   *
   * The handler cannot fix this from what it holds. At that point it has an
   * access token, a refresh token, and nothing else: no `account` block from
   * the grant, no `tokenAccount`, and the one call that could name the account
   * has just failed. Guessing an owner would be worse than the clobber, and
   * refusing the login is a user-visible behaviour change nobody authorised.
   *
   * Closing it is the follow-up wave 1 recommended, IN THIS ORDER: the refresh
   * path attaches the stored identity before saving (`src/utils/auth.ts:1656`),
   * and only THEN a writer guard refusing identity-less blobs — the guard LAST,
   * because landing it first breaks the legitimate identity-less rotation
   * pinned at `src/utils/auth.accountIdentity.test.ts:177`.
   *
   * GREEN means the gap is still open. Red means someone closed it: read the
   * follow-up above, confirm that is what happened, then delete this pin.
   */
  test('PINS RESIDUAL: a login whose profile fetch fails is still identity-less and still clobbers', async () => {
    // The profile endpoint fails. Production swallows the error and returns
    // undefined (getOauthProfile.ts:50-52), so undefined is the faithful shape.
    mock.module('../../services/oauth/getOauthProfile.js', () => ({
      getOauthProfileFromOauthToken: async () => undefined,
    }))

    // ...and the grant returned no account block, so the blob names nobody.
    await loginFromRefreshToken('b')

    const onDisk = readFromDisk()

    // STILL OPEN: B's tokens landed on A's entry, and A's refresh token — the
    // one thing that cannot be recovered without a fresh login — is gone.
    expect(onDisk.claudeAiOauthAccounts?.['uuid-a']?.refreshToken).toBe(
      'fake-refresh-b',
    )
    expect(onDisk.claudeAiOauthAccounts?.['uuid-a']?.accessToken).toBe(
      'fake-access-b',
    )

    // No entry of B's own was created, so the loss is in place under A's key.
    expect(Object.keys(onDisk.claudeAiOauthAccounts ?? {})).toEqual(['uuid-a'])

    // And the quieter half survives with it: that entry still announces A
    // while holding B's session, so `/account a@example.com` switches onto B.
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-a']?.tokenAccount?.emailAddress,
    ).toBe('a@example.com')
  })
})
