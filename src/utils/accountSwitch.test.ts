/**
 * An account switch has to move TWO mirrors, and getting either wrong fails
 * silently rather than loudly.
 *
 * Token side: every reader resolves through `claudeAiOauth`, so a switch that
 * only moved `claudeAiOauthActive` would keep handing out the previous
 * account's access token — the CLI would report the switch as successful and
 * carry on spending the old subscription.
 *
 * Identity side: `getOauthAccountInfo` reads `config.oauthAccount`, and
 * nothing else re-points it, so a switch that skipped it would leave the
 * status line naming the account the user just left.
 *
 * These tests assert the observable end of both: what a reader returns after
 * the switch, not what the switch wrote.
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
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import * as realSecureStorage from './secureStorage/index.js'
import type { SecureStorageData } from './secureStorage/index.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }
// Importing the REAL limits module here is deliberate as well as necessary:
// accountSwitch -> claudeAiLimits -> api/claude -> usageLimitSwitch ->
// accountSwitch is an import cycle, so loading both real modules in one
// process is what would surface a module-initialisation failure in it.
const pristineRealLimits = {
  ...(await import('../services/claudeAiLimits.js')),
}

const HOUR = 60 * 60 * 1000

function tokensFor(who: 'work' | 'personal'): OAuthTokens {
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

describe('switching the active account moves both mirrors', () => {
  let tmpRoot: string
  let store: SecureStorageData

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/accountSwitch.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-account-switch-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: {
        'uuid-work': tokensFor('work'),
        'uuid-personal': { ...tokensFor('personal'), label: 'side project' },
      },
    }

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
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => ({ ...pristineRealSecureStorage }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('a token reader returns the new account immediately after the switch', async () => {
    const { switchAccount } = await import('./accountSwitch.js')
    const { getClaudeAIOAuthTokens, clearOAuthTokenCache } = await import(
      './auth.js'
    )

    // Seed the memoized reader with the OLD account, so this also pins the
    // cache invalidation and not just the write.
    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('work-access')

    expect((await switchAccount('uuid-personal')).success).toBe(true)

    // The assertion that matters: what a caller actually gets.
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('personal-access')
    // And the stored mirror it resolved through.
    expect(store.claudeAiOauthActive).toBe('uuid-personal')
    expect(store.claudeAiOauth?.accessToken).toBe('personal-access')
    // The account we left keeps its own refresh token.
    expect(store.claudeAiOauthAccounts?.['uuid-work']?.refreshToken).toBe(
      'work-refresh',
    )
  })

  test('the config identity mirror follows the switch', async () => {
    const { switchAccount } = await import('./accountSwitch.js')
    const { getGlobalConfig, saveGlobalConfig } = await import('./config.js')

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'uuid-work',
        emailAddress: 'work@example.com',
      },
      oauthAccounts: {
        'uuid-work': {
          accountUuid: 'uuid-work',
          emailAddress: 'work@example.com',
        },
        'uuid-personal': {
          accountUuid: 'uuid-personal',
          emailAddress: 'personal@example.com',
        },
      },
    }))

    expect((await switchAccount('uuid-personal')).success).toBe(true)

    expect(getGlobalConfig().oauthAccount?.emailAddress).toBe(
      'personal@example.com',
    )
  })

  test('switching to an unknown key changes nothing', async () => {
    const { switchAccount } = await import('./accountSwitch.js')

    await expect(switchAccount('uuid-nobody')).rejects.toThrow(
      /No stored Claude account/,
    )
    expect(store.claudeAiOauthActive).toBe('uuid-work')
    expect(store.claudeAiOauth?.accessToken).toBe('work-access')
  })
})

describe('resolving what the user typed to an account', () => {
  const accounts = [
    {
      key: 'uuid-work',
      emailAddress: 'work@example.com',
      label: 'day job',
      isActive: true,
    },
    {
      key: 'uuid-personal',
      emailAddress: 'personal@example.com',
      label: 'side project',
      isActive: false,
    },
  ]

  test('matches on key, label and email', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    expect(resolveAccountKey(accounts, 'uuid-personal')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
    expect(resolveAccountKey(accounts, 'side project')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
    expect(resolveAccountKey(accounts, 'PERSONAL@example.com')).toEqual({
      type: 'ok',
      key: 'uuid-personal',
    })
  })

  test('reports an ambiguous query instead of guessing', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    const shared = [
      { key: 'a', label: 'shared', isActive: true },
      { key: 'b', label: 'shared', isActive: false },
    ]
    expect(resolveAccountKey(shared, 'shared').type).toBe('ambiguous')
  })

  test('an unknown or empty query resolves to nothing', async () => {
    const { resolveAccountKey } = await import('./accountSwitch.js')

    expect(resolveAccountKey(accounts, 'nobody@example.com').type).toBe(
      'unknown',
    )
    expect(resolveAccountKey(accounts, '   ').type).toBe('unknown')
  })
})

/**
 * Naming an account in output that leaves the user's screen.
 *
 * These tests exist for the PII property, not for the formatting: `Usage`
 * output is written into model transcripts and log files, so the assertions
 * below are deliberately about what is ABSENT from the returned string — the
 * address, its local part, and the `@` that would mark any address at all.
 * A test that only checked the happy-path label would pass while
 * `accountUsageLabel` leaked every address it was written to withhold.
 */
describe('naming an account where the naming leaves the screen', () => {
  const EMAIL = 'work@example.com'
  const LOCAL_PART = 'work'
  // Real-shaped UUIDs: distinct in their FIRST block, which is the part that
  // survives truncation, and sharing no substring with the address above.
  const KEY_A = '3f2b19ac-7d40-4c1e-9b55-0a8e6d21cf34'
  const KEY_B = 'c81d5e70-7d40-4c1e-9b55-0a8e6d21cf34'

  /** Every way the address could reach the output, checked in one place. */
  function expectNoAddress(name: string): void {
    expect(name).not.toContain(EMAIL)
    expect(name).not.toContain(LOCAL_PART)
    expect(name).not.toContain('@')
    expect(name.length).toBeGreaterThan(0)
  }

  test('an account known only by its email address is named by its key instead', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    const name = accountUsageLabel({
      key: KEY_A,
      emailAddress: EMAIL,
      isActive: true,
    })

    expectNoAddress(name)
    expect(name).toBe('3f2b19ac…')
  })

  test('a labelled account is named by its label, and still not by its email', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    const name = accountUsageLabel({
      key: KEY_A,
      emailAddress: EMAIL,
      label: 'day job',
      isActive: true,
    })

    expect(name).toBe('day job')
    expectNoAddress(name)
  })

  test('accountDisplayName still prefers the email — the on-screen naming is unchanged', async () => {
    const { accountDisplayName } = await import('./accountSwitch.js')

    // Goes red if someone "hardens" the wrong function: the account-switch UI
    // shows the user their own accounts on their own screen, where the
    // address is the only part they reliably recognise.
    expect(
      accountDisplayName({ key: KEY_A, emailAddress: EMAIL, isActive: true }),
    ).toBe(EMAIL)
    expect(
      accountDisplayName({
        key: KEY_A,
        emailAddress: EMAIL,
        label: 'day job',
        isActive: true,
      }),
    ).toBe(EMAIL)
    expect(accountDisplayName({ key: KEY_A, isActive: true })).toBe(KEY_A)
  })

  test('two unlabelled accounts keep two distinct names', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    const a = accountUsageLabel({ key: KEY_A, emailAddress: EMAIL, isActive: true })
    const b = accountUsageLabel({
      key: KEY_B,
      emailAddress: 'personal@example.com',
      isActive: false,
    })

    // Truncation that collapsed these would merge two accounts into one
    // Usage section and silently misreport both their quotas.
    expect(a).not.toBe(b)
    expectNoAddress(a)
    expect(b).not.toContain('@')
  })

  test('a label that is itself an email address is refused, not truncated', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    // Cutting this label short would emit the local part, which is exactly
    // the disclosure the function exists to prevent — so the key wins.
    const name = accountUsageLabel({
      key: KEY_A,
      emailAddress: EMAIL,
      label: EMAIL,
      isActive: true,
    })

    expect(name).toBe('3f2b19ac…')
    expectNoAddress(name)
  })

  test('a blank label names the account by its key rather than by nothing', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    expect(
      accountUsageLabel({ key: KEY_A, label: '', isActive: true }),
    ).toBe('3f2b19ac…')
    expect(
      accountUsageLabel({ key: KEY_A, label: '   ', isActive: true }),
    ).toBe('3f2b19ac…')
    expect(
      accountUsageLabel({ key: KEY_A, label: '  day job  ', isActive: true }),
    ).toBe('day job')
  })

  test('a key that is not UUID-shaped is shown as stored', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    // The legacy pre-identity entry. Truncating it would add an ellipsis that
    // promises hidden characters there are none of.
    expect(
      accountUsageLabel({
        key: 'default',
        emailAddress: EMAIL,
        isActive: true,
      }),
    ).toBe('default')
  })

  test('the same account always gets the same name', async () => {
    const { accountUsageLabel } = await import('./accountSwitch.js')

    const account = { key: KEY_A, emailAddress: EMAIL, isActive: true }
    expect(accountUsageLabel(account)).toBe(accountUsageLabel(account))
  })
})

/**
 * A switch has to move the quota view too.
 *
 * `getRawUtilization()` re-reads the per-account store on every call, so it
 * follows a switch on its own; `currentLimits` is a plain binding that only a
 * response moves. `switchAccount` is therefore where the stored state of the
 * newly active account has to be projected, for the same reason the token,
 * betas and tool-schema caches are cleared there.
 *
 * What this module owns is the WIRING — that the projection is called, once,
 * and only when a switch actually happened. What the projection then shows is
 * claudeAiLimits' own contract and is pinned in claudeAiLimits.test.ts.
 */
describe('a switch projects the new account quota view', () => {
  let tmpRoot: string
  let store: SecureStorageData
  let projections: number

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/accountSwitch.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-account-switch-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    store = {
      claudeAiOauth: tokensFor('work'),
      claudeAiOauthActive: 'uuid-work',
      claudeAiOauthAccounts: {
        'uuid-work': tokensFor('work'),
        'uuid-personal': tokensFor('personal'),
      },
    }

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

    projections = 0
    mock.module('../services/claudeAiLimits.js', () => ({
      ...pristineRealLimits,
      projectActiveAccountLimits: () => {
        projections += 1
      },
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => ({
        ...pristineRealSecureStorage,
      }))
      mock.module('../services/claudeAiLimits.js', () => ({
        ...pristineRealLimits,
      }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('a successful switch projects the new account view exactly once', async () => {
    const { switchAccount } = await import('./accountSwitch.js')

    expect(projections).toBe(0)
    expect((await switchAccount('uuid-personal')).success).toBe(true)

    // Once, not zero (the status line would keep showing the account we left)
    // and not twice (a repaint per switch, not per mirror moved).
    expect(projections).toBe(1)
  })

  test('a switch that did not happen projects nothing', async () => {
    const { switchAccount } = await import('./accountSwitch.js')

    await expect(switchAccount('uuid-nobody')).rejects.toThrow(
      /No stored Claude account/,
    )

    // Projecting here would repaint the status line for a switch the user
    // never got, and the account they are still on has not changed.
    expect(projections).toBe(0)
    expect(store.claudeAiOauthActive).toBe('uuid-work')
  })

  test('the projection runs after the identity mirror has moved', async () => {
    const { switchAccount } = await import('./accountSwitch.js')
    const { getGlobalConfig, saveGlobalConfig } = await import('./config.js')

    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'uuid-work',
        emailAddress: 'work@example.com',
      },
      oauthAccounts: {
        'uuid-work': {
          accountUuid: 'uuid-work',
          emailAddress: 'work@example.com',
        },
        'uuid-personal': {
          accountUuid: 'uuid-personal',
          emailAddress: 'personal@example.com',
        },
      },
    }))

    // The projection keys off getOauthAccountInfo(), which reads
    // config.oauthAccount. Running it before saveGlobalConfig would project
    // the account being switched AWAY from — the exact staleness it exists to
    // remove — so the order in switchAccount is load-bearing.
    let accountWhenProjected: string | undefined
    mock.module('../services/claudeAiLimits.js', () => ({
      ...pristineRealLimits,
      projectActiveAccountLimits: () => {
        accountWhenProjected = getGlobalConfig().oauthAccount?.accountUuid
      },
    }))

    expect((await switchAccount('uuid-personal')).success).toBe(true)

    expect(accountWhenProjected).toBe('uuid-personal')
  })
})

/**
 * `/account <email>` and `/account` for the accounts the user ALREADY has.
 *
 * Restoring identity on the WRITE side only helps credentials written from
 * now on. Every account already on disk is keyed by its UUID and carries no
 * identity at all, so `emailForTokens` returns undefined for it, which is
 * exactly the pair of symptoms the user reported: `accountDisplayName` prints
 * a raw UUID, and `resolveAccountKey` has no email to match so
 * `/account <email>` answers "no stored account matches".
 *
 * `readAccounts` is where the two halves meet, so it is where the identity
 * map from `config.oauthAccounts` — keyed by the SAME account UUIDs — is
 * joined in. These tests assert the observable end of both symptoms through
 * the real `readAccounts`, and that the join is read-only: naming an account
 * must never write a credential.
 */
describe('naming the accounts already on disk', () => {
  // Real-shaped, because `accountUsageLabel` truncates a UUID-shaped key and
  // the PII assertion below depends on that branch being the one taken.
  const LEGACY_UUID = '3f2b19ac-7d40-4c1e-9b55-0a8e6d21cf34'
  const EMAIL = 'legacy@example.com'

  let tmpRoot: string
  let store: SecureStorageData
  let writes: number

  /** A credential saved before identity was recorded: no tokenAccount, no profile. */
  function identitylessTokens(who: string): OAuthTokens {
    return {
      accessToken: `${who}-access`,
      refreshToken: `${who}-refresh`,
      expiresAt: Date.now() + HOUR,
      scopes: ['user:inference'],
    }
  }

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/accountSwitch.test.ts')
    mock.restore()
    tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-account-naming-'))
    const configDir = join(tmpRoot, 'config')
    mkdirSync(configDir)
    setClaudeConfigHomeDirForTesting(configDir)

    writes = 0
    store = {
      claudeAiOauth: identitylessTokens('legacy'),
      claudeAiOauthActive: LEGACY_UUID,
      claudeAiOauthAccounts: {
        [LEGACY_UUID]: identitylessTokens('legacy'),
        // The pre-identity entry, keyed by the legacy key rather than a UUID.
        default: identitylessTokens('ancient'),
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        name: 'in-memory-test-storage',
        read: () => store,
        readAsync: async () => store,
        update: (next: SecureStorageData) => {
          writes += 1
          store = next
          return { success: true }
        },
      }),
    }))

    const { saveGlobalConfig } = await import('./config.js')
    saveGlobalConfig(current => ({
      ...current,
      // The shape the real config holds: keyed by account UUID, holding the
      // non-secret identity only, and carrying no entry for `default`.
      oauthAccounts: {
        [LEGACY_UUID]: { accountUuid: LEGACY_UUID, emailAddress: EMAIL },
      },
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => ({
        ...pristineRealSecureStorage,
      }))
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(tmpRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('/account <email> resolves an account stored with no identity of its own', async () => {
    const { readAccounts, resolveAccountKey } = await import('./accountSwitch.js')

    expect(resolveAccountKey(readAccounts(), EMAIL)).toEqual({
      type: 'ok',
      key: LEGACY_UUID,
    })
    // The same match the command offers the user, case-insensitively.
    expect(resolveAccountKey(readAccounts(), 'LEGACY@Example.com')).toEqual({
      type: 'ok',
      key: LEGACY_UUID,
    })
  })

  test('/account lists the email rather than a raw UUID', async () => {
    const { readAccounts, accountDisplayName } = await import('./accountSwitch.js')

    const listed = readAccounts().find(a => a.key === LEGACY_UUID)
    expect(listed?.emailAddress).toBe(EMAIL)
    expect(accountDisplayName(listed!)).toBe(EMAIL)
  })

  test('naming an account writes no credential', async () => {
    const { readAccounts } = await import('./accountSwitch.js')
    const before = JSON.stringify(store)

    readAccounts()
    readAccounts()

    // The join is a read-side fallback: no credential write, no lock, no
    // re-keying. A backfill into the credential store would show up here.
    expect(writes).toBe(0)
    expect(JSON.stringify(store)).toBe(before)
  })

  test('the join cannot name the pre-identity `default` entry', async () => {
    const { readAccounts, accountDisplayName } = await import('./accountSwitch.js')

    // `config.oauthAccounts` is keyed by account UUID, so a `default`-keyed
    // credential — the one whose UUID was never recorded — has no entry there
    // to join against and stays named by its key. This is a structural limit
    // of the read-side join, not a gap in it.
    const fallback = readAccounts().find(a => a.key === 'default')
    expect(fallback?.emailAddress).toBeUndefined()
    expect(accountDisplayName(fallback!)).toBe('default')
  })

  test('the joined email still never reaches off-screen output', async () => {
    const { readAccounts, accountUsageLabel } = await import('./accountSwitch.js')

    // `accountUsageLabel` omits the email on purpose because its output lands
    // in transcripts and log files. The join populates `emailAddress` for
    // accounts that previously had none, so that omission has to hold for a
    // strictly wider set of accounts than before.
    const listed = readAccounts().find(a => a.key === LEGACY_UUID)
    const name = accountUsageLabel(listed!)
    expect(name).toBe('3f2b19ac…')
    expect(name).not.toContain('@')
    expect(name).not.toContain('legacy')
  })
})
