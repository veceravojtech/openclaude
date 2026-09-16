import type { OAuthTokens } from '../../services/oauth/types.js'
import { createFallbackStorage } from './fallbackStorage.js'
export { readSecureStorageResult } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { linuxSecretStorage } from './linuxSecretStorage.js'
import { windowsCredentialStorage } from './windowsCredentialStorage.js'
import { plainTextStorage } from './plainTextStorage.js'

/**
 * One logged-in Claude account: its OAuth tokens plus an optional label the
 * user can set to tell two accounts apart in the UI.
 */
export type StoredClaudeAccount = OAuthTokens & { label?: string }

export interface SecureStorageData {
  /**
   * Tokens of the account currently in use.
   *
   * This stays a mirror of `claudeAiOauthAccounts[claudeAiOauthActive]` rather
   * than being replaced by it. Every writer of this file does a whole-object
   * read-modify-write, so an older build that knows nothing about the accounts
   * map still authenticates from this field and preserves the map untouched —
   * which makes downgrading safe.
   */
  claudeAiOauth?: OAuthTokens
  /** Every logged-in Claude account, keyed by account UUID. */
  claudeAiOauthAccounts?: Record<string, StoredClaudeAccount>
  /** Key into `claudeAiOauthAccounts` naming the active account. */
  claudeAiOauthActive?: string
  codex?: {
    apiKey?: string
    accessToken: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    profileId?: string
    lastRefreshAt?: number
    lastRefreshFailureAt?: number
  }
  mcpOAuth?: Record<
    string,
    {
      serverName: string
      serverUrl: string
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scope?: string
      clientId?: string
      clientSecret?: string
      discoveryState?: {
        authorizationServerUrl: string
        resourceMetadataUrl?: string
      }
      stepUpScope?: string
    }
  >
  mcpOAuthClientConfig?: Record<string, { clientSecret: string }>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number }>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string }>
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
}

/**
 * The outcome of a synchronous read, with "nothing is stored" and "the store
 * could not be read" as SEPARATE inhabitants of the type.
 *
 * `read` collapses both into `null` and `createFallbackStorage` collapsed them
 * further into `{}`, so a writer doing a whole-blob read-modify-write could not
 * tell a first run from a keyring that had just gone away — and reconciling
 * onto `{}` writes an anonymous blob over every stored account, plus `codex`,
 * `mcpOAuth` and `pluginSecrets`, while reporting success.
 */
export type SecureStorageReadResult =
  | { status: 'ok'; data: SecureStorageData }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string }

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  /**
   * The same read as `read`, reporting WHY it produced nothing.
   *
   * Additive on purpose. `read` keeps its exact contract — `null` for a miss
   * AND for a failure — because callers depend on that lossiness: notably
   * `createFallbackStorage`'s `update`, which decides whether to delete the
   * primary entry from `primary.read() !== null` and must keep declining that
   * delete when the primary merely failed to answer. The distinction lives on
   * this channel alone; anything consuming `read` behaves as it always has.
   *
   * Optional because a backend that cannot yet tell a miss from a failure must
   * not claim it can — `readSecureStorageResult` falls back to `read` for
   * those, which preserves their pre-existing behaviour exactly.
   */
  readResult?(): SecureStorageReadResult
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}

const unavailableSecureStorage: SecureStorage = {
  name: 'unavailable-secure-storage',
  read: () => null,
  // ABSENT rather than unreadable: there is no store here to have failed, and
  // classifying it as a failure would stop callers ever reaching `update`,
  // which is the thing that explains the situation to the user.
  readResult: () => ({ status: 'absent' }),
  readAsync: async () => null,
  update: () => ({
    success: false,
    warning:
      'Secure storage is unavailable on this platform without plaintext fallback.',
  }),
  delete: () => true,
}

/**
 * Get the appropriate secure storage implementation for the current platform.
 * Prefers native OS vaults (Keychain, libsecret, Credential Locker) with a plaintext fallback.
 */
export function getSecureStorage(options?: {
  allowPlainTextFallback?: boolean
}): SecureStorage {
  const allowPlainTextFallback = options?.allowPlainTextFallback ?? true

  if (process.platform === 'darwin') {
    return allowPlainTextFallback
      ? createFallbackStorage(macOsKeychainStorage, plainTextStorage)
      : macOsKeychainStorage
  }

  if (process.platform === 'linux') {
    return allowPlainTextFallback
      ? createFallbackStorage(linuxSecretStorage, plainTextStorage)
      : linuxSecretStorage
  }

  if (process.platform === 'win32') {
    return allowPlainTextFallback
      ? createFallbackStorage(windowsCredentialStorage, plainTextStorage)
      : windowsCredentialStorage
  }

  return allowPlainTextFallback ? plainTextStorage : unavailableSecureStorage
}
