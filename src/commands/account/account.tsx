import chalk from 'chalk'
import figures from 'figures'
import React, { useEffect } from 'react'

import type { LocalJSXCommandContext } from '../../commands.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  accountDisplayName,
  readAccounts,
  resolveAccountKey,
  switchAccount,
} from '../../utils/accountSwitch.js'
import type { AccountSummary } from '../../utils/authAccounts.js'
import {
  mutateAccountsLocked,
  removeAccount,
} from '../../utils/authAccounts.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { applyAccountSwitchEffects } from '../applyAccountSwitchEffects.js'
import { Login } from '../login/login.js'
import { clearAuthRelatedCaches } from '../logout/logout.js'

type AccountMessageProps = {
  message: string
  args: string
  onDone: () => void
}

function AccountMessage({
  message,
  args,
  onDone,
}: AccountMessageProps): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor={true}>
        {figures.pointer} /account {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

function describe(account: AccountSummary): string {
  const name = accountDisplayName(account)
  return account.label && account.label !== name
    ? `${name} ${chalk.dim(`(${account.label})`)}`
    : name
}

function formatList(accounts: AccountSummary[]): string {
  if (accounts.length === 0) {
    return 'No Claude accounts stored. Use /login to add one.'
  }
  const lines = accounts.map(account => {
    const marker = account.isActive ? chalk.green(figures.tick) : ' '
    const name = describe(account)
    return `${marker} ${account.isActive ? chalk.bold(name) : name}`
  })
  return [
    ...lines,
    chalk.dim('· /account <email> to switch · /account add · /account remove <email>'),
  ].join('\n')
}

/** Resolve a query to a key, or to the message explaining why it didn't. */
function resolveOrExplain(
  accounts: AccountSummary[],
  query: string,
): { key: string } | { error: string } {
  const resolution = resolveAccountKey(accounts, query)
  if (resolution.type === 'ok') {
    return { key: resolution.key }
  }
  if (resolution.type === 'ambiguous') {
    return {
      error: `${chalk.bold(query)} matches more than one account:\n${formatList(
        resolution.matches,
      )}`,
    }
  }
  return {
    error: `No stored account matches ${chalk.bold(query)}.\n${formatList(accounts)}`,
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const argv = (args ?? '').trim()
  const done = (message: string) => (
    <AccountMessage message={message} args={argv} onDone={() => onDone(message)} />
  )
  const accounts = readAccounts()

  if (!argv) {
    return done(formatList(accounts))
  }

  const [verb, ...rest] = argv.split(/\s+/)
  const target = rest.join(' ')

  if (verb === 'add') {
    // Adding an account IS a login — reuse the OAuth flow rather than growing
    // a second one. The token save routes through the accounts map already,
    // so the new account is stored beside the existing ones, not over them.
    return (
      <Login
        onDone={async result => {
          if (result.type === 'cancel') {
            onDone('Did not add an account.')
            return
          }
          if (result.type === 'provider-setup') {
            onDone(result.message, { display: 'system' })
            return
          }
          applyAccountSwitchEffects(context)
          onDone('Account added and activated.')
        }}
      />
    )
  }

  if (verb === 'remove') {
    if (!target) {
      return done('Usage: /account remove <email>')
    }
    const resolved = resolveOrExplain(accounts, target)
    if ('error' in resolved) {
      return done(resolved.error)
    }
    const { key } = resolved
    const wasActive = accounts.find(a => a.key === key)?.isActive === true

    const result = await mutateAccountsLocked(data => removeAccount(data, key))
    if (!result.success) {
      return done(result.warning ?? 'Failed to remove the account.')
    }
    saveGlobalConfig(current => {
      const identities = { ...(current.oauthAccounts ?? {}) }
      delete identities[key]
      return { ...current, oauthAccounts: identities }
    })

    if (!wasActive) {
      return done(`Removed ${chalk.bold(target)}.`)
    }

    // `removeAccount` promotes a survivor rather than leaving the CLI logged
    // out, so the session is now running as a different account and owes the
    // same reset a deliberate switch would do.
    const promoted = readAccounts().find(a => a.isActive)
    if (promoted) {
      await switchAccount(promoted.key)
      applyAccountSwitchEffects(context)
      return done(
        `Removed ${chalk.bold(target)}. Now using ${chalk.bold(describe(promoted))}.`,
      )
    }

    // Nobody left. The identity mirror has to be cleared explicitly — nothing
    // else re-points it, so the status line would otherwise keep naming the
    // account that was just removed.
    saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
    await clearAuthRelatedCaches()
    applyAccountSwitchEffects(context)
    return done(`Removed ${chalk.bold(target)}. No accounts left — /login to add one.`)
  }

  if (verb === 'switch' && !target) {
    return done('Usage: /account switch <email>')
  }

  // Spelling the verb out is a reasonable thing to type, so `/account switch
  // <email>` is the same switch as the bare `/account <email>` the hint line
  // documents — only the query differs. Without this the literal word `switch`
  // fell through to account resolution and was reported as an account the user
  // does not have.
  const query = verb === 'switch' ? target : argv

  const resolved = resolveOrExplain(accounts, query)
  if ('error' in resolved) {
    return done(resolved.error)
  }
  const { key } = resolved
  if (accounts.find(a => a.key === key)?.isActive) {
    return done(`Already using ${chalk.bold(query)}.`)
  }

  const result = await switchAccount(key)
  if (!result.success) {
    return done(result.warning ?? 'Failed to switch account.')
  }
  applyAccountSwitchEffects(context)
  return done(`Now using ${chalk.bold(query)}.`)
}
