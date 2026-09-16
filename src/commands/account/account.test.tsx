import { stripVTControlCharacters } from 'node:util'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import * as actualAccountSwitch from '../../utils/accountSwitch.js'
import type { AccountResolution } from '../../utils/accountSwitch.js'
import type { AccountSummary } from '../../utils/authAccounts.js'

/**
 * Argument parsing for `/account`.
 *
 * Deliberately scoped to WHICH TOKENS the command reads as a verb and which it
 * forwards as an account query: the stored-account plumbing
 * (`readAccounts`/`resolveAccountKey`/`switchAccount`) is stubbed out, so these
 * tests stay valid however that layer resolves or names an account.
 */

const ACCOUNTS: AccountSummary[] = [
  { key: 'key-active', emailAddress: 'active@example.com', isActive: true },
  { key: 'key-other', emailAddress: 'other@example.com', isActive: false },
]

/** Queries that actually reached account resolution, in order. */
let resolvedQueries: string[] = []
/** Keys `switchAccount` was asked to activate, in order. */
let switchedKeys: string[] = []

function LoginStub(): React.ReactNode {
  return null
}

async function importFreshAccountCommandModule(): Promise<
  typeof import('./account.js')
> {
  resolvedQueries = []
  switchedKeys = []

  mock.module('../../utils/accountSwitch.js', () => ({
    ...actualAccountSwitch,
    accountDisplayName: (account: AccountSummary) =>
      account.emailAddress ?? account.label ?? account.key,
    readAccounts: () => ACCOUNTS,
    resolveAccountKey: (
      accounts: AccountSummary[],
      query: string,
    ): AccountResolution => {
      resolvedQueries.push(query)
      const match = accounts.find(
        account => account.emailAddress === query || account.key === query,
      )
      return match ? { type: 'ok', key: match.key } : { type: 'unknown' }
    },
    switchAccount: async (key: string) => {
      switchedKeys.push(key)
      return { success: true }
    },
  }))
  mock.module('../applyAccountSwitchEffects.js', () => ({
    applyAccountSwitchEffects: () => {},
  }))
  mock.module('../login/login.js', () => ({
    Login: LoginStub,
  }))

  return import(`./account.js?ts=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./account.js')
  >
}

async function runAccountCommand(args: string): Promise<React.ReactNode> {
  const { call } = await importFreshAccountCommandModule()
  return call(mock(() => {}) as never, {} as never, args)
}

/** The message an `AccountMessage` result carries, without colour codes. */
function messageOf(node: React.ReactNode): string {
  if (!React.isValidElement(node)) {
    throw new Error('expected /account to return an element')
  }
  const { message } = node.props as { message?: unknown }
  if (typeof message !== 'string') {
    throw new Error('expected /account to return an AccountMessage')
  }
  return stripVTControlCharacters(message)
}

beforeEach(() => {
  resolvedQueries = []
  switchedKeys = []
})

afterEach(() => {
  mock.restore()
})

describe('/account argument parsing', () => {
  test('bare `switch` prints the switch usage instead of being read as an account name', async () => {
    const message = messageOf(await runAccountCommand('switch'))

    expect(message).toBe('Usage: /account switch <email>')
    expect(message).not.toContain('No stored account matches')
    // The verb never reaches account resolution at all.
    expect(resolvedQueries).toEqual([])
    expect(switchedKeys).toEqual([])
  })

  test('`switch <email>` switches, forwarding only the target to resolution', async () => {
    const message = messageOf(await runAccountCommand('switch other@example.com'))

    expect(resolvedQueries).toEqual(['other@example.com'])
    expect(switchedKeys).toEqual(['key-other'])
    expect(message).toBe('Now using other@example.com.')
  })

  test('`switch <active-email>` reports the account is already active', async () => {
    const message = messageOf(await runAccountCommand('switch active@example.com'))

    expect(resolvedQueries).toEqual(['active@example.com'])
    expect(switchedKeys).toEqual([])
    expect(message).toBe('Already using active@example.com.')
  })

  test('`switch <unknown-email>` names the target, not the verb', async () => {
    const message = messageOf(await runAccountCommand('switch nobody@example.com'))

    expect(resolvedQueries).toEqual(['nobody@example.com'])
    expect(message).toContain('No stored account matches nobody@example.com.')
    expect(message).not.toContain('matches switch')
  })

  test('bare `/account <email>` still switches', async () => {
    const message = messageOf(await runAccountCommand('other@example.com'))

    expect(resolvedQueries).toEqual(['other@example.com'])
    expect(switchedKeys).toEqual(['key-other'])
    expect(message).toBe('Now using other@example.com.')
  })

  test('bare `/account` still lists the stored accounts', async () => {
    const message = messageOf(await runAccountCommand(''))

    expect(message).toContain('active@example.com')
    expect(message).toContain('other@example.com')
    expect(message).toContain('/account <email> to switch')
    expect(resolvedQueries).toEqual([])
    expect(switchedKeys).toEqual([])
  })

  test('`add` still opens the login flow', async () => {
    const node = await runAccountCommand('add')

    expect(React.isValidElement(node)).toBe(true)
    expect((node as React.ReactElement).type).toBe(LoginStub)
    expect(resolvedQueries).toEqual([])
  })

  test('bare `remove` still prints its own usage line', async () => {
    const message = messageOf(await runAccountCommand('remove'))

    expect(message).toBe('Usage: /account remove <email>')
    expect(resolvedQueries).toEqual([])
  })

  test('`remove <unknown-email>` still reports the unknown account', async () => {
    const message = messageOf(await runAccountCommand('remove nobody@example.com'))

    expect(resolvedQueries).toEqual(['nobody@example.com'])
    expect(message).toContain('No stored account matches nobody@example.com.')
  })
})
