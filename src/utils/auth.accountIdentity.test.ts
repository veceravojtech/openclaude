/**
 * Account identity has to survive the WRITE, not just the read.
 *
 * `applyTokensToAccounts` rebuilt the blob it persists field by field and
 * dropped `tokenAccount` and `profile` — the only two carriers of account
 * identity — even though it is the sole production writer of the accounts map
 * and its mirror. Identity therefore never reached disk: `/account` listed raw
 * UUIDs, `/account <email>` could not match anything, and the anti-clobber
 * defence in `migrateAndReconcile` (which must key off the mirror's OWN
 * identity, never the active key) silently degraded to exactly the key its
 * comment forbids.
 *
 * Every pre-existing fixture in this repo builds tokens that ALREADY carry
 * `tokenAccount` and then asserts on a READER, so ~24 green tests exercised the
 * readers with data the writer never actually produced. That is precisely why
 * none of them caught this. These tests therefore drive the real writer,
 * `saveOAuthTokensUnlocked`, through the real plaintext storage backend and
 * assert against the JSON that lands ON DISK — reading the file back rather
 * than trusting an in-memory return value.
 *
 * All fixture credentials here are obviously fake strings.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  OAuthProfileResponse,
  OAuthTokens,
} from '../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { accountDisplayName } from './accountSwitch.js'
import { listAccounts, migrateAndReconcile } from './authAccounts.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import * as realSecureStorage from './secureStorage/index.js'
import type { SecureStorageData } from './secureStorage/index.js'
import { plainTextStorage } from './secureStorage/plainTextStorage.js'

const HOUR = 60 * 60 * 1000

function profileFor(who: string): OAuthProfileResponse {
  return {
    account: { uuid: `uuid-${who}`, email: `${who}@example.com` },
    organization: { uuid: `org-${who}` },
  }
}

/** Tokens as the login flow produces them: identity included. */
function tokensFor(who: string, overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: `fake-access-${who}`,
    refreshToken: `fake-refresh-${who}`,
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
    tokenAccount: {
      uuid: `uuid-${who}`,
      emailAddress: `${who}@example.com`,
    },
    ...overrides,
  }
}

/**
 * Tokens as a REFRESH response frequently produces them: no `account` block,
 * so no identity at all. This is the shape the writer used to reduce every
 * token to.
 */
function identitylessTokens(who: string): OAuthTokens {
  return {
    accessToken: `fake-access-${who}`,
    refreshToken: `fake-refresh-${who}`,
    expiresAt: Date.now() + HOUR,
    scopes: ['user:inference'],
  }
}

describe('the writer persists account identity', () => {
  let tmpRoot: string
  let configDir: string

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/auth.accountIdentity.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-account-identity-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    // Every read and write below is confined to this temp config home; the
    // real credential store is never opened.
    setClaudeConfigHomeDirForTesting(configDir)

    // The REAL plaintext backend, so `update` performs a genuine atomic write
    // into the temp home and the assertions can read the file back.
    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => plainTextStorage,
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

  /** The credentials file as it actually exists on disk. */
  function readFromDisk(): SecureStorageData {
    return JSON.parse(
      readFileSync(join(configDir, '.credentials.json'), { encoding: 'utf8' }),
    ) as SecureStorageData
  }

  async function save(tokens: OAuthTokens): Promise<void> {
    const { saveOAuthTokensUnlocked } = await import('./auth.js')
    const result = saveOAuthTokensUnlocked(tokens)
    expect(result.success).toBe(true)
  }

  test('a login writes tokenAccount into both the account entry and the mirror', async () => {
    await save(tokensFor('work'))

    const onDisk = readFromDisk()

    // The account entry.
    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    // And the legacy mirror, which older builds authenticate from.
    expect(onDisk.claudeAiOauth?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    expect(onDisk.claudeAiOauthActive).toBe('uuid-work')
  })

  test('a login carrying a profile keeps it on disk too', async () => {
    await save(tokensFor('work', { profile: profileFor('work') }))

    const onDisk = readFromDisk()

    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.profile).toEqual(
      profileFor('work'),
    )
    expect(onDisk.claudeAiOauth?.profile).toEqual(profileFor('work'))
  })

  /**
   * D1: with identity on disk, `emailForTokens` has something to read, so the
   * display name is the email the user recognises instead of the raw UUID that
   * `/account <email>` can never match.
   */
  test('a freshly written account displays as its email, not its UUID', async () => {
    await save(tokensFor('work'))

    const accounts = listAccounts(migrateAndReconcile(readFromDisk()).data)

    expect(accounts).toHaveLength(1)
    expect(accountDisplayName(accounts[0]!)).toBe('work@example.com')
    expect(accountDisplayName(accounts[0]!)).not.toBe('uuid-work')
  })

  /**
   * A refresh response usually omits `account`. Identity must then fall back to
   * the stored value rather than being clobbered with `undefined` — the same
   * precedent `subscriptionType` and `rateLimitTier` already set, and the same
   * account the key chain falls back to, so blob and key stay coherent.
   */
  test('a refresh without identity keeps the stored identity instead of erasing it', async () => {
    await save(tokensFor('work'))
    await save(identitylessTokens('work-refreshed'))

    const onDisk = readFromDisk()

    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    expect(onDisk.claudeAiOauth?.tokenAccount).toEqual({
      uuid: 'uuid-work',
      emailAddress: 'work@example.com',
    })
    // The refreshed access token still landed.
    expect(onDisk.claudeAiOauth?.accessToken).toBe('fake-access-work-refreshed')
    // And the account is still displayable by email after a refresh.
    const accounts = listAccounts(migrateAndReconcile(onDisk).data)
    expect(accountDisplayName(accounts[0]!)).toBe('work@example.com')
  })

  test('identity does not leak across accounts: a second login keys its own entry', async () => {
    await save(tokensFor('work'))
    await save(tokensFor('personal'))

    const onDisk = readFromDisk()

    expect(Object.keys(onDisk.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    // The first account keeps its OWN identity and its own refresh token.
    expect(
      onDisk.claudeAiOauthAccounts?.['uuid-work']?.tokenAccount?.emailAddress,
    ).toBe('work@example.com')
    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'fake-refresh-work',
    )
    expect(onDisk.claudeAiOauthActive).toBe('uuid-personal')
  })

  /**
   * D3 AT THE WRITER TIER — DEFERRED, PINNED HERE, deliberately GREEN.
   *
   * An identity-less blob (reachable via `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` when
   * the refresh response omits `account`) still keys off `claudeAiOauthActive`
   * and still overwrites that account's tokens, destroying its refresh token.
   * That is TRUE, CURRENT behaviour of `applyTokensToAccounts`, which is the
   * only thing this test enters — it calls `saveOAuthTokensUnlocked` directly.
   *
   * It did NOT move when D3's login route was closed, and could not: `8cd672c7`
   * fixed `installOAuthTokens` one tier ABOVE this test
   * (`src/cli/handlers/auth.ts:99-111` attaches the fetched profile and a
   * `tokenAccount` derived from it), and this entry point never calls it. The
   * residual that close leaves — a login whose profile fetch fails, so the blob
   * is anonymous again — is pinned in
   * `src/cli/handlers/auth.d3RefreshClobber.test.ts`.
   *
   * The other half of the old note, "refuse to merge an unidentified blob onto
   * a stored account", is REFUTED by execution rather than merely deferred:
   * prototyped verbatim it breaks the legitimate identity-less rotation
   * asserted at :177 in this file, whose last assertion requires the rotated
   * access token to LAND. A routine refresh and a foreign blob reach this
   * writer byte-shape-identical, so no predicate over its input separates them.
   *
   * The sequenced path that lets a writer guard land safely: FIRST make the
   * refresh path attach the stored identity (`src/utils/auth.ts:1656`), so no
   * production caller is anonymous any more; THEN the guard is simply
   * "identity-less blob + existing account -> refuse", needing no `refreshToken`
   * comparison at all. Guard LAST, never first.
   *
   * A red day here therefore does not mean the handler changed — it means
   * `applyTokensToAccounts` itself changed. Confirm that was deliberate.
   */
  test('PINS DEFERRED D3: an identity-less blob still overwrites the active account tokens', async () => {
    await save(tokensFor('work'))

    // Belongs to nobody the store can identify, yet merges onto whoever is active.
    await save(identitylessTokens('stranger'))

    const onDisk = readFromDisk()

    // DEFERRED DEFECT: work's refresh token is gone, replaced by the stranger's.
    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'fake-refresh-stranger',
    )
    expect(onDisk.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).not.toBe(
      'fake-refresh-work',
    )
    // No new account was created for it, so the loss is in-place.
    expect(Object.keys(onDisk.claudeAiOauthAccounts ?? {})).toEqual(['uuid-work'])

    // What this change DOES guarantee: the entry stays self-consistent — it is
    // stored under uuid-work and still says it is uuid-work, so the mirror
    // repair in `migrateAndReconcile` keys off real identity rather than
    // degrading to the active key its comment forbids.
    expect(onDisk.claudeAiOauth?.tokenAccount?.uuid).toBe('uuid-work')
  })
})
