import type { OAuthTokens } from '../../services/oauth/types.js'
import { createFallbackStorage } from './fallbackStorage.js'
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

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}

const unavailableSecureStorage: SecureStorage = {
  name: 'unavailable-secure-storage',
  read: () => null,
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
