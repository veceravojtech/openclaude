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
  accountKeyForTokens,
  addAccount,
  getActiveAccount,
  LEGACY_ACCOUNT_KEY,
  listAccounts,
  migrateAndReconcile,
  mutateAccountsLocked,
  removeAccount,
  setActiveAccount,
  vouchableAccountKeys,
  vouchForAccount,
} from './authAccounts.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { plainTextStorage } from './secureStorage/plainTextStorage.js'
import type {
  SecureStorageData,
  StoredClaudeAccount,
} from './secureStorage/index.js'

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

describe('vouchForAccount', () => {
  /** Fixed clock: a hidden `Date.now()` would make the boundary case flake. */
  const NOW = 1_800_000_000_000
  const HOUR_MS = 60 * 60 * 1000

  /**
   * Refreshable, unexpired and nameable — the only shape the client may move a
   * user onto automatically. Token values are obvious fakes.
   */
  function healthy(uuid: string): StoredClaudeAccount {
    return tokensFor(uuid, { expiresAt: NOW + HOUR_MS })
  }

  test('vouches for a refreshable, unexpired, nameable account', () => {
    expect(vouchForAccount(healthy('uuid-work'), NOW)).toBeUndefined()
  })

  describe('condition 1 — the client could not obtain a credential', () => {
    const absent = [
      ['undefined', undefined],
      ['null', null],
      ["the empty string, which a bare `!== undefined` check would accept", ''],
    ] as const

    for (const [label, refreshToken] of absent) {
      test(`reports 'no-refresh-token' when refreshToken is ${label}`, () => {
        const account: StoredClaudeAccount = {
          ...healthy('uuid-work'),
          refreshToken,
        }

        expect(vouchForAccount(account, NOW)).toBe('no-refresh-token')
        // Isolation: restoring the one missing field makes the same fixture
        // vouchable, so this case can only fail on condition 1.
        expect(
          vouchForAccount({ ...account, refreshToken: 'refresh-work' }, NOW),
        ).toBeUndefined()
      })
    }
  })

  describe('condition 2 — no live access token', () => {
    /** A legacy blob whose JSON simply has no `expiresAt` key. */
    function withoutExpiry(): StoredClaudeAccount {
      const { expiresAt: _expiresAt, ...rest } = healthy('uuid-work')
      return rest as StoredClaudeAccount
    }

    const cases: readonly (readonly [string, StoredClaudeAccount])[] = [
      ['null', { ...healthy('uuid-work'), expiresAt: null }],
      // `expiresAt` is declared required, so an `=== null` implementation
      // typechecks clean and lets exactly this shape through as vouchable.
      ['absent from the stored JSON entirely', withoutExpiry()],
      ['in the past', { ...healthy('uuid-work'), expiresAt: NOW - 1 }],
      ['exactly now', { ...healthy('uuid-work'), expiresAt: NOW }],
    ]

    for (const [label, account] of cases) {
      test(`reports 'expired' when expiresAt is ${label}`, () => {
        expect(vouchForAccount(account, NOW)).toBe('expired')
        // Isolation: a future expiry on the same fixture is vouchable.
        expect(
          vouchForAccount({ ...account, expiresAt: NOW + HOUR_MS }, NOW),
        ).toBeUndefined()
      })
    }

    test('one millisecond past `now` is still live — the boundary is `<= now`', () => {
      expect(
        vouchForAccount({ ...healthy('uuid-work'), expiresAt: NOW + 1 }, NOW),
      ).toBeUndefined()
      expect(
        vouchForAccount({ ...healthy('uuid-work'), expiresAt: NOW }, NOW),
      ).toBe('expired')
    })
  })

  describe('condition 3 — the client cannot say whose account it is', () => {
    test("reports 'unnameable' for an entry with neither tokenAccount nor profile", () => {
      // The observed `default` entry: usable-looking tokens, no identity.
      const account: StoredClaudeAccount = tokens({ expiresAt: NOW + HOUR_MS })

      expect(account.tokenAccount).toBeUndefined()
      expect(account.profile).toBeUndefined()
      expect(vouchForAccount(account, NOW)).toBe('unnameable')
      // Isolation: identity is the only thing this fixture lacks.
      expect(
        vouchForAccount(
          {
            ...account,
            tokenAccount: {
              uuid: 'uuid-work',
              emailAddress: 'uuid-work@example.com',
            },
          },
          NOW,
        ),
      ).toBeUndefined()
    })

    test('a tokenAccount alone is enough to name an account', () => {
      const account = healthy('uuid-work')

      expect(account.profile).toBeUndefined()
      expect(vouchForAccount(account, NOW)).toBeUndefined()
    })

    test('a profile alone is enough to name an account', () => {
      // "Neither", not "not both": reading it the other way would exclude
      // every account identified by profile alone.
      const account: StoredClaudeAccount = tokens({
        expiresAt: NOW + HOUR_MS,
        profile: {
          account: { uuid: 'uuid-work', email: 'uuid-work@example.com' },
          organization: { uuid: 'org-work' },
        },
      })

      expect(account.tokenAccount).toBeUndefined()
      expect(vouchForAccount(account, NOW)).toBeUndefined()
    })
  })

  describe('the check order is fixed, so each reason stays diagnostic', () => {
    test('an account failing everything reports the refresh token first', () => {
      const account: StoredClaudeAccount = tokens({
        refreshToken: '',
        expiresAt: NOW - 1,
      })

      expect(vouchForAccount(account, NOW)).toBe('no-refresh-token')
    })

    test('an unnameable AND expired account reports expiry first', () => {
      const account: StoredClaudeAccount = tokens({ expiresAt: NOW - 1 })

      expect(vouchForAccount(account, NOW)).toBe('expired')
    })
  })
})

describe('vouchableAccountKeys', () => {
  const NOW = 1_800_000_000_000
  const HOUR_MS = 60 * 60 * 1000

  function healthy(uuid: string): StoredClaudeAccount {
    return tokensFor(uuid, { expiresAt: NOW + HOUR_MS })
  }

  test('keeps only the keys that pass every condition', () => {
    const data: SecureStorageData = {
      claudeAiOauthAccounts: {
        'uuid-work': healthy('uuid-work'),
        'uuid-personal': healthy('uuid-personal'),
        // One entry per failing condition, so a predicate that dropped any
        // one of the three would still fail this.
        [LEGACY_ACCOUNT_KEY]: tokens({ expiresAt: NOW + HOUR_MS }),
        'uuid-stale': tokensFor('uuid-stale', { expiresAt: NOW - 1 }),
        'uuid-tokenless': tokensFor('uuid-tokenless', {
          expiresAt: NOW + HOUR_MS,
          refreshToken: null,
        }),
      },
      claudeAiOauthActive: 'uuid-work',
    }

    expect([...vouchableAccountKeys(data, NOW)].sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
  })

  test('a blob with no accounts map yields an empty set, not undefined', () => {
    const keys = vouchableAccountKeys({}, NOW)

    expect(keys).toBeInstanceOf(Set)
    expect(keys.size).toBe(0)
  })

  test('reads without mutating the blob it was given', () => {
    const data: SecureStorageData = {
      claudeAiOauthAccounts: {
        'uuid-work': healthy('uuid-work'),
        [LEGACY_ACCOUNT_KEY]: tokens({ expiresAt: NOW + HOUR_MS }),
      },
      claudeAiOauthActive: 'uuid-work',
    }
    const before = JSON.stringify(data)

    expect([...vouchableAccountKeys(data, NOW)]).toEqual(['uuid-work'])
    // The unvouchable entry is left exactly as it is: this guard makes an
    // account unselectable, it never prunes or re-keys one.
    expect(JSON.stringify(data)).toBe(before)
    expect(data.claudeAiOauthAccounts?.[LEGACY_ACCOUNT_KEY]).toBeDefined()
  })

  test('a `default` key that reconciliation itself created is not vouchable', () => {
    // `migrateAndReconcile` is where an identity-less `default` entry comes
    // from in the first place — LEGACY_ACCOUNT_KEY is its last fallback — so
    // the predicate has to be asked about reconciled data, not just fixtures.
    const { data } = migrateAndReconcile({
      claudeAiOauth: tokens({ expiresAt: NOW + HOUR_MS }),
    })

    expect(Object.keys(data.claudeAiOauthAccounts ?? {})).toEqual([
      LEGACY_ACCOUNT_KEY,
    ])
    expect([...vouchableAccountKeys(data, NOW)]).toEqual([])
  })

  test('a mirror carrying identity reconciles into a vouchable account', () => {
    // The contrast that keeps the test above honest: reconciliation is not
    // what makes an entry unvouchable — missing identity is.
    const { data } = migrateAndReconcile({
      claudeAiOauth: healthy('uuid-work'),
    })

    expect(Object.keys(data.claudeAiOauthAccounts ?? {})).toEqual(['uuid-work'])
    expect([...vouchableAccountKeys(data, NOW)]).toEqual(['uuid-work'])
  })
})

/**
 * The cost of the guard, pinned deliberately.
 *
 * An account that is nameable and holds a real refresh token, whose access
 * token has merely gone stale, is EXCLUDED — and on this client that is the
 * common shape, not a corner case: a stored account is never refreshed while
 * it is inactive (every refresh-path read resolves through the active mirror),
 * so any account left idle past its access-token lifetime looks exactly like
 * this. Such a user gets the usage-limit wait instead of an auto-switch.
 *
 * That is the conservative direction on purpose. Switching onto an account
 * whose only usable credential is a stored refresh token makes the client
 * present that token, and refresh-token-rotation reuse detection is a live
 * hypothesis for the revocations this guard was written in response to.
 * Widening the guard and widening that exposure are the same act.
 *
 * This test exists so the cost is asserted rather than latent. It is the one
 * to flip — condition 2 becomes "expired AND no refresh token" — once the
 * reuse-detection question is settled. If it fails, someone has relaxed the
 * expiry rule; that may well be right, but it must be a decision, not a drift.
 */
describe('the deliberate over-correction', () => {
  const NOW = 1_800_000_000_000
  const HOUR_MS = 60 * 60 * 1000

  test('an idle but refreshable account is excluded, and only on expiry', () => {
    const idle = tokensFor('uuid-work', { expiresAt: NOW - 24 * HOUR_MS })

    // Nameable and refreshable: it fails on nothing but the stale clock.
    expect(idle.refreshToken).toBeTruthy()
    expect(accountKeyForTokens(idle)).toBe('uuid-work')
    expect(vouchForAccount(idle, NOW)).toBe('expired')

    // And the proof that expiry is the ONLY thing excluding it: the same
    // account, refreshed, is vouchable.
    expect(
      vouchForAccount({ ...idle, expiresAt: NOW + HOUR_MS }, NOW),
    ).toBeUndefined()
  })

  test('a store whose only alternative is idle offers no auto-switch target', () => {
    const data = {
      claudeAiOauthAccounts: {
        'uuid-personal': tokensFor('uuid-personal', { expiresAt: NOW + HOUR_MS }),
        'uuid-work': tokensFor('uuid-work', { expiresAt: NOW - 24 * HOUR_MS }),
      },
      claudeAiOauthActive: 'uuid-personal',
    }

    // The active account is vouchable; the idle alternative is not. A 429 on
    // `uuid-personal` therefore finds no target and falls through to the wait.
    expect([...vouchableAccountKeys(data, NOW)]).toEqual(['uuid-personal'])
  })
})
