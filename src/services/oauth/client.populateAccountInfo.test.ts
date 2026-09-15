import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  shouldRefreshOAuthAccountInfo,
  storeOAuthAccountInfo,
} from './client.js'

test('OAuth account info population does not refresh when Claude.ai auth is inactive', () => {
  expect(
    shouldRefreshOAuthAccountInfo({
      hasCompleteAccountInfo: false,
      isClaudeAiSubscriber: false,
      hasProfileScope: true,
    }),
  ).toBe(false)
})

test('OAuth account info population still refreshes active Claude.ai auth', () => {
  expect(
    shouldRefreshOAuthAccountInfo({
      hasCompleteAccountInfo: false,
      isClaudeAiSubscriber: true,
      hasProfileScope: true,
    }),
  ).toBe(true)
})

test('OAuth account info population skips refresh when profile scope is missing', () => {
  expect(
    shouldRefreshOAuthAccountInfo({
      hasCompleteAccountInfo: false,
      isClaudeAiSubscriber: true,
      hasProfileScope: false,
    }),
  ).toBe(false)
})

test('OAuth account info population skips refresh when account info is complete', () => {
  expect(
    shouldRefreshOAuthAccountInfo({
      hasCompleteAccountInfo: true,
      isClaudeAiSubscriber: true,
      hasProfileScope: true,
    }),
  ).toBe(false)
})

describe('storeOAuthAccountInfo', () => {
  const WORK = {
    accountUuid: 'uuid-work',
    emailAddress: 'work@example.com',
    organizationUuid: 'org-work',
  }
  const PERSONAL = {
    accountUuid: 'uuid-personal',
    emailAddress: 'personal@example.com',
    organizationUuid: undefined,
  }

  // saveGlobalConfig mutates a module-global in test mode, so both the lock and
  // an explicit reset are required to keep these cases independent.
  function resetAccountConfig(): void {
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: undefined,
      oauthAccounts: undefined,
    }))
  }

  beforeEach(async () => {
    await acquireSharedMutationLock('services/oauth/client.populateAccountInfo')
    resetAccountConfig()
  })

  afterEach(() => {
    resetAccountConfig()
    releaseSharedMutationLock()
  })

  test('stores the account under its uuid and mirrors it as the active one', () => {
    storeOAuthAccountInfo(WORK)

    const config = getGlobalConfig()
    expect(config.oauthAccount?.accountUuid).toBe('uuid-work')
    expect(Object.keys(config.oauthAccounts ?? {})).toEqual(['uuid-work'])
    expect(config.oauthAccounts?.['uuid-work']?.emailAddress).toBe(
      'work@example.com',
    )
  })

  test('backfills the accounts map when the active mirror is already correct', () => {
    // The state an upgrade from a single-slot config starts in: the identity is
    // already stored, but the per-account map has never been written. Comparing
    // only against the mirror would early-return here and never backfill.
    storeOAuthAccountInfo(WORK)
    saveGlobalConfig(current => ({ ...current, oauthAccounts: undefined }))
    expect(getGlobalConfig().oauthAccount?.accountUuid).toBe('uuid-work')
    expect(getGlobalConfig().oauthAccounts).toBeUndefined()

    storeOAuthAccountInfo(WORK)

    expect(getGlobalConfig().oauthAccounts?.['uuid-work']?.emailAddress).toBe(
      'work@example.com',
    )
  })

  test('a second account is added without evicting the first', () => {
    storeOAuthAccountInfo(WORK)
    storeOAuthAccountInfo(PERSONAL)

    const config = getGlobalConfig()
    expect(Object.keys(config.oauthAccounts ?? {}).sort()).toEqual([
      'uuid-personal',
      'uuid-work',
    ])
    expect(config.oauthAccount?.accountUuid).toBe('uuid-personal')
    expect(config.oauthAccounts?.['uuid-work']?.emailAddress).toBe(
      'work@example.com',
    )
  })

  test('re-storing an unchanged account leaves the map untouched', () => {
    storeOAuthAccountInfo(WORK)
    const before = JSON.stringify(getGlobalConfig().oauthAccounts)

    storeOAuthAccountInfo(WORK)

    expect(JSON.stringify(getGlobalConfig().oauthAccounts)).toBe(before)
  })
})
