import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OAuthTokens } from '../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  addAccount,
  getActiveAccount,
  LEGACY_ACCOUNT_KEY,
  listAccounts,
  migrateAndReconcile,
  mutateAccountsLocked,
  removeAccount,
  setActiveAccount,
} from './authAccounts.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { plainTextStorage } from './secureStorage/plainTextStorage.js'
import type { SecureStorageData } from './secureStorage/index.js'

const PLAINTEXT_WARNING = 'Warning: Storing credentials in plaintext.'

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 1_700_000_000_000,
    scopes: ['user:inference'],
    ...overrides,
  }
}

function tokensFor(uuid: string, overrides: Partial<OAuthTokens> = {}) {
  return tokens({
    tokenAccount: { uuid, emailAddress: `${uuid}@example.com` },
    ...overrides,
  })
}

describe('migrateAndReconcile', () => {
  test('migrates a legacy single-slot credential into the accounts map', () => {
    const legacy: SecureStorageData = {
      claudeAiOauth: tokensFor('uuid-work'),
      trustedDeviceToken: 'unrelated-field-must-survive',
    }

    const { data, changed } = migrateAndReconcile(legacy)

    expect(changed).toBe(true)
    expect(Object.keys(data.claudeAiOauthAccounts ?? {})).toEqual(['uuid-work'])
    expect(data.claudeAiOauthActive).toBe('uuid-work')
    // The mirror is preserved verbatim so an older build still authenticates.
    expect(data.claudeAiOauth).toEqual(legacy.claudeAiOauth!)
    expect(data.trustedDeviceToken).toBe('unrelated-field-must-survive')
  })

  test('falls back to the legacy key when the token carries no identity', () => {
    const { data, changed } = migrateAndReconcile({ claudeAiOauth: tokens() })

    expect(changed).toBe(true)
    expect(Object.keys(data.claudeAiOauthAccounts ?? {})).toEqual([
      LEGACY_ACCOUNT_KEY,
    ])
    expect(data.claudeAiOauthActive).toBe(LEGACY_ACCOUNT_KEY)
  })

  test('leaves an empty store empty', () => {
    const { data, changed } = migrateAndReconcile({})

    expect(changed).toBe(false)
    expect(data.claudeAiOauth).toBeUndefined()
    expect(data.claudeAiOauthAccounts).toBeUndefined()
    expect(data.claudeAiOauthActive).toBeUndefined()
  })

  test('does not clobber an existing map that is already consistent', () => {
    const work = tokensFor('uuid-work')
    const personal = tokensFor('uuid-personal')
    const data: SecureStorageData = {
      claudeAiOauth: work,
      claudeAiOauthAccounts: {
        'uuid-work': { ...work, label: 'Work' },
        'uuid-personal': { ...personal, label: 'Personal' },
      },
      claudeAiOauthActive: 'uuid-work',
    }

    const result = migrateAndReconcile(data)

    expect(result.changed).toBe(false)
    expect(Object.keys(result.data.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    expect(result.data.claudeAiOauthAccounts?.['uuid-personal']).toEqual({
      ...personal,
      label: 'Personal',
    })
  })

  test('heals the active entry from the mirror, keeping the label', () => {
    // A token refresh (or an older build) writes only the mirror, so the
    // mirror is the fresher of the two and must win.
    const stale = tokensFor('uuid-work', { accessToken: 'stale' })
    const refreshed = tokensFor('uuid-work', { accessToken: 'refreshed' })
    const personal = tokensFor('uuid-personal')
    const data: SecureStorageData = {
      claudeAiOauth: refreshed,
      claudeAiOauthAccounts: {
        'uuid-work': { ...stale, label: 'Work' },
        'uuid-personal': { ...personal, label: 'Personal' },
      },
      claudeAiOauthActive: 'uuid-work',
    }

    const result = migrateAndReconcile(data)

    expect(result.changed).toBe(true)
    expect(result.data.claudeAiOauthAccounts?.['uuid-work']).toEqual({
      ...refreshed,
      label: 'Work',
    })
    // The inactive account is never touched by reconciliation.
    expect(result.data.claudeAiOauthAccounts?.['uuid-personal']).toEqual({
      ...personal,
      label: 'Personal',
    })
  })

  test('a stale active key cannot let one mirror overwrite another account', () => {
    // The downgrade path: an older build logs in as work, writes only the
    // mirror, and leaves `claudeAiOauthActive` pointing at personal. The
    // mirror's own identity — not the stale active key — says whose tokens
    // these are.
    const work = tokensFor('uuid-work', { refreshToken: 'work-refresh' })
    const personal = tokensFor('uuid-personal', {
      refreshToken: 'personal-refresh',
    })
    const data: SecureStorageData = {
      claudeAiOauth: work,
      claudeAiOauthAccounts: {
        'uuid-work': { ...tokensFor('uuid-work', { refreshToken: 'stale' }) },
        'uuid-personal': { ...personal, label: 'Personal' },
      },
      claudeAiOauthActive: 'uuid-personal',
    }

    const result = migrateAndReconcile(data)

    expect(
      result.data.claudeAiOauthAccounts?.['uuid-personal']?.refreshToken,
    ).toBe('personal-refresh')
    expect(result.data.claudeAiOauthAccounts?.['uuid-work']).toEqual(work)
    expect(result.data.claudeAiOauthActive).toBe('uuid-work')
  })
})

describe('account mutations keep the mirror in sync', () => {
  const work = tokensFor('uuid-work')
  const personal = tokensFor('uuid-personal')

  function twoAccounts(): SecureStorageData {
    return addAccount(
      addAccount({}, 'uuid-work', work, { label: 'Work' }),
      'uuid-personal',
      personal,
      { label: 'Personal' },
    )
  }

  test('adding an account activates it and re-points the mirror', () => {
    const data = twoAccounts()

    expect(data.claudeAiOauthActive).toBe('uuid-personal')
    expect(data.claudeAiOauth).toEqual(personal)
    // The mirror stays a plain OAuthTokens — the label lives only in the map.
    expect('label' in (data.claudeAiOauth as object)).toBe(false)
    expect(listAccounts(data)).toEqual([
      {
        key: 'uuid-work',
        label: 'Work',
        emailAddress: 'uuid-work@example.com',
        isActive: false,
      },
      {
        key: 'uuid-personal',
        label: 'Personal',
        emailAddress: 'uuid-personal@example.com',
        isActive: true,
      },
    ])
  })

  test('switching the active account re-points the mirror', () => {
    const data = setActiveAccount(twoAccounts(), 'uuid-work')

    expect(data.claudeAiOauthActive).toBe('uuid-work')
    expect(data.claudeAiOauth).toEqual(work)
    expect(getActiveAccount(data)).toEqual({
      key: 'uuid-work',
      account: { ...work, label: 'Work' },
    })
  })

  test('switching to an unknown account throws rather than logging out', () => {
    expect(() => setActiveAccount(twoAccounts(), 'uuid-missing')).toThrow(
      /No stored Claude account/,
    )
  })

  test('removing the active account promotes a survivor', () => {
    const data = removeAccount(twoAccounts(), 'uuid-personal')

    expect(data.claudeAiOauthActive).toBe('uuid-work')
    expect(data.claudeAiOauth).toEqual(work)
    expect(Object.keys(data.claudeAiOauthAccounts ?? {})).toEqual(['uuid-work'])
  })

  test('removing the last account clears the map and the mirror', () => {
    const data = removeAccount(
      removeAccount(twoAccounts(), 'uuid-personal'),
      'uuid-work',
    )

    expect(data.claudeAiOauth).toBeUndefined()
    expect(data.claudeAiOauthAccounts).toBeUndefined()
    expect(data.claudeAiOauthActive).toBeUndefined()
    expect(getActiveAccount(data)).toBeNull()
  })
})

describe('locked, atomic credential writes', () => {
  let tmpRoot: string
  let configDir: string

  beforeEach(async () => {
    await acquireSharedMutationLock('authAccounts.test.ts')
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-accounts-'))
    configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
  })

  afterEach(() => {
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(tmpRoot, { recursive: true, force: true })
    releaseSharedMutationLock()
  })

  test('concurrent writers do not lose each other updates', async () => {
    await Promise.all([
      mutateAccountsLocked(
        data =>
          addAccount(data, 'uuid-work', tokensFor('uuid-work'), {
            label: 'Work',
          }),
        { storage: plainTextStorage },
      ),
      mutateAccountsLocked(
        data =>
          addAccount(data, 'uuid-personal', tokensFor('uuid-personal'), {
            label: 'Personal',
          }),
        { storage: plainTextStorage },
      ),
    ])

    const stored = plainTextStorage.read()
    expect(Object.keys(stored?.claudeAiOauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    // The mirror always points at whichever write landed last, and carries no
    // label of its own.
    const active = stored?.claudeAiOauthActive
    expect(active).toBeDefined()
    expect(stored?.claudeAiOauth?.tokenAccount?.uuid).toBe(active!)
    expect('label' in (stored?.claudeAiOauth as object)).toBe(false)
  })

  test('an update leaves no temp file behind and the file stays 0600', () => {
    const result = plainTextStorage.update({
      claudeAiOauth: tokensFor('uuid-work'),
    })

    expect(result).toEqual({ success: true, warning: PLAINTEXT_WARNING })

    const entries = readdirSync(configDir)
    expect(entries.filter(entry => entry.includes('.tmp-'))).toEqual([])
    expect(entries).toContain('.credentials.json')
    expect(
      statSync(join(configDir, '.credentials.json')).mode & 0o777,
    ).toBe(0o600)
    expect(plainTextStorage.read()?.claudeAiOauth?.accessToken).toBe(
      'access-token',
    )
  })
})
