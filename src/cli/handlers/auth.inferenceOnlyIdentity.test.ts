/**
 * The GitHub-App flow must not write its inference-only token into the local
 * credential store.
 *
 * `OAuthFlowStep` mints a ONE-YEAR, `user:inference`-only token whose sole
 * consumer is the `CLAUDE_CODE_OAUTH_TOKEN` repository secret that
 * `setupGitHubActions` pushes with `gh secret set`. Nothing in that flow ever
 * reads the token back out of secure storage. It nevertheless handed the blob
 * to `saveOAuthTokensIfNeeded`, and the comment at that call explains only why
 * it avoids `performLogout` — not why it writes at all.
 *
 * `shouldPersistTokens` does NOT skip it: `shouldUseClaudeAIAuth` is satisfied
 * by `user:inference` alone, and the flow asks for `expiresIn` explicitly, so
 * the refresh-token and `expiresAt` checks pass too. The blob therefore reaches
 * `applyTokensToAccounts`, which either merges it onto the account named by its
 * own `tokenAccount` — replacing that account's full-scope session with an
 * inference-only one — or, when the token exchange omitted its `account` block,
 * keys off `claudeAiOauthActive` and lands on whoever happens to be signed in.
 *
 * The first describe pins those writer consequences, which are the reason the
 * caller must not write. The second drives the component end to end against an
 * in-memory store and asserts the signed-in account comes out byte-identical.
 *
 * `ConsoleOAuthFlow` in `setup-token` mode mints the same kind of token for the
 * same purpose and deliberately does not persist it; this aligns the two.
 *
 * Every credential string here is an obviously fake fixture, and every read and
 * write is confined to an in-memory stub under a temp config home.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as realSecureStorage from '../../utils/secureStorage/index.js'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealSecureStorage = { ...realSecureStorage }
const realOAuthService = await import('../../services/oauth/index.js')
const pristineRealOAuthService = { ...realOAuthService }

const HOUR = 60 * 60 * 1000
const YEAR = 365 * 24 * HOUR

/** The full-scope session a signed-in user already has on disk. */
function signedInTokens(): OAuthTokens {
  return {
    accessToken: 'fake-access-signed-in',
    refreshToken: 'fake-refresh-signed-in',
    expiresAt: Date.now() + HOUR,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    subscriptionType: 'max',
    tokenAccount: {
      uuid: 'uuid-signed-in',
      emailAddress: 'signed-in@example.com',
    },
  }
}

/**
 * What `startOAuthFlow({ inferenceOnly: true })` hands back. `formatTokens`
 * fills `profile` from `fetchProfileInfo`, which cannot succeed without
 * `user:profile`, and `tokenAccount` only when the exchange response carried an
 * `account` block. `withAccount` covers the branch where it did.
 */
function inferenceOnlyTokens(
  withAccount?: { uuid: string; emailAddress: string },
): OAuthTokens {
  return {
    accessToken: 'fake-access-gha',
    refreshToken: 'fake-refresh-gha',
    expiresAt: Date.now() + YEAR,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
    profile: undefined,
    tokenAccount: withAccount,
  }
}

let tmpRoot: string
let configDir: string
let store: SecureStorageData

function mockStorage(): void {
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
    }),
  }))
}

beforeEach(async () => {
  await acquireSharedMutationLock('cli/handlers/auth.inferenceOnlyIdentity.test.ts')
  mock.restore()
  tmpRoot = mkdtempSync(join(tmpdir(), 'openclaude-inference-only-identity-'))
  configDir = join(tmpRoot, 'config')
  mkdirSync(configDir)
  // Every credential read and write below is confined to this temp config home
  // and to the in-memory stub above; the real credential store is never opened.
  setClaudeConfigHomeDirForTesting(configDir)

  store = {
    claudeAiOauth: signedInTokens(),
    claudeAiOauthActive: 'uuid-signed-in',
    claudeAiOauthAccounts: { 'uuid-signed-in': signedInTokens() },
  }
  mockStorage()
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../../utils/secureStorage/index.js', () => ({ ...pristineRealSecureStorage }))
    mock.module('../../services/oauth/index.js', () => ({ ...pristineRealOAuthService }))
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(tmpRoot, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

/**
 * Characterisation of the writer as it stands, and the whole reason the caller
 * below must not reach it. These assert what `applyTokensToAccounts` DOES with
 * an inference-only blob, not what it should do.
 *
 * If a writer-side identity guard ever lands, the first test here goes red.
 * That is the guard arriving, not a regression in this caller — re-point it at
 * the guard's refusal and leave the caller assertions alone.
 */
describe('persisting a one-year inference-only token', () => {
  test('is not skipped: the blob reaches the accounts map', async () => {
    const { saveOAuthTokensIfNeeded } = await import('../../utils/auth.js')

    const before = JSON.stringify(store)
    const result = await saveOAuthTokensIfNeeded(inferenceOnlyTokens())

    expect(result.success).toBe(true)
    // `shouldPersistTokens` lets it through — `user:inference` alone satisfies
    // `shouldUseClaudeAIAuth`, and the flow's explicit `expiresIn` gives it a
    // refresh token and an `expiresAt`. The write is real, not a no-op.
    expect(JSON.stringify(store)).not.toBe(before)
  })

  test('replaces the signed-in account refresh token when the blob names nobody', async () => {
    const { saveOAuthTokensIfNeeded } = await import('../../utils/auth.js')

    await saveOAuthTokensIfNeeded(inferenceOnlyTokens())

    // `accountKeyForTokens` returns undefined, so the key falls back to
    // `claudeAiOauthActive` and the GitHub-Actions credentials land on the
    // signed-in user's entry. A refresh token that is gone cannot be recovered
    // without logging in again.
    expect(store.claudeAiOauthAccounts?.['uuid-signed-in']?.refreshToken).toBe(
      'fake-refresh-gha',
    )
    expect(Object.keys(store.claudeAiOauthAccounts ?? {})).toEqual([
      'uuid-signed-in',
    ])
  })

  test('downgrades the signed-in account to inference-only when the blob names them', async () => {
    const { saveOAuthTokensIfNeeded } = await import('../../utils/auth.js')

    await saveOAuthTokensIfNeeded(
      inferenceOnlyTokens({
        uuid: 'uuid-signed-in',
        emailAddress: 'signed-in@example.com',
      }),
    )

    // Identity on the blob does NOT make this safe. It routes the write to the
    // user's own entry, and `applyTokensToAccounts` copies `scopes` across with
    // no fallback — so the interactive session's scopes collapse to the
    // inference-only set and its refresh token is replaced by the CI one.
    const entry = store.claudeAiOauthAccounts?.['uuid-signed-in']
    expect(entry?.scopes).toEqual(['user:inference'])
    expect(entry?.refreshToken).toBe('fake-refresh-gha')
  })
})

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return { stdout, stdin, getOutput: () => output }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for the GitHub-App OAuth step')
}

describe('the GitHub-App OAuth step', () => {
  /**
   * Drives the real component: the only stub is the network edge
   * (`OAuthService`), so the component's own save decision runs for real
   * against the in-memory store seeded above.
   */
  async function runOAuthFlowStep(): Promise<{
    tokenHandedOn: string | undefined
    startOptions: Record<string, unknown> | undefined
  }> {
    let startOptions: Record<string, unknown> | undefined
    mock.module('../../services/oauth/index.js', () => ({
      ...realOAuthService,
      OAuthService: class {
        async startOAuthFlow(
          authURLHandler: (url: string) => Promise<void>,
          options?: Record<string, unknown>,
        ): Promise<OAuthTokens> {
          startOptions = options
          await authURLHandler('https://claude.ai/oauth/authorize?fake=1')
          return inferenceOnlyTokens()
        }
        cleanup(): void {}
      },
    }))

    const { OAuthFlowStep } = await import(
      '../../commands/install-github-app/OAuthFlowStep.js'
    )
    const { createRoot } = await import('../../ink.js')
    // The step reads app state the way it does under the real CLI; without the
    // provider its hooks throw before the save decision is ever reached.
    const { AppStateProvider } = await import('../../state/AppState.js')

    let tokenHandedOn: string | undefined
    const streams = createTestStreams()
    const root = await createRoot({
      stdout: streams.stdout as unknown as NodeJS.WriteStream,
      stdin: streams.stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    root.render(
      React.createElement(
        AppStateProvider,
        null,
        React.createElement(OAuthFlowStep, {
          onSuccess: (token: string) => {
            tokenHandedOn = token
          },
          onCancel: () => {},
        }),
      ),
    )

    try {
      await waitForCondition(() => tokenHandedOn !== undefined)
    } finally {
      root.unmount()
      streams.stdin.end()
      streams.stdout.end()
      await Bun.sleep(0)
    }

    return { tokenHandedOn, startOptions }
  }

  test('leaves the signed-in account credentials byte-identical', async () => {
    const before = JSON.stringify(store)

    await runOAuthFlowStep()

    // The minted token belongs in a repository secret, not in this machine's
    // credential store. Nothing in the install flow reads it back from there,
    // and writing it can only overwrite a session the user still needs.
    expect(JSON.stringify(store)).toBe(before)
  }, 20000)

  test('still mints an inference-only token and hands it to the caller', async () => {
    const { tokenHandedOn, startOptions } = await runOAuthFlowStep()

    // Guards the fix against the cheap version of itself: not writing the token
    // is only correct while the flow still produces one for the GitHub secret.
    expect(tokenHandedOn).toBe('fake-access-gha')
    expect(startOptions?.inferenceOnly).toBe(true)
    expect(startOptions?.expiresIn).toBe(365 * 24 * 60 * 60)
  }, 20000)
})

export {}
