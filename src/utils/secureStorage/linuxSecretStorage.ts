import { execa, execaSync } from 'execa'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageReadResult,
} from './index.js'

/**
 * Classify one `secret-tool lookup` run as data, a miss, or a failure.
 *
 * `secret-tool` exits non-zero BOTH when the item is simply not there and when
 * the lookup itself could not be performed — a locked keyring, a D-Bus error,
 * a secret service that restarted. The signal separating them is stderr:
 * libsecret prints the failure it hit and stays silent on a plain miss. Only
 * reading the exit code is what let a keyring that had gone away answer a
 * writer as if the store were empty.
 *
 * `reason` never carries stdout or stderr verbatim: this runs on the value of
 * a credential, and the caller may surface the reason to the user.
 */
function classifyLookup(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
): SecureStorageReadResult {
  if (exitCode === 0 && stdout) {
    let parsed: SecureStorageData | null | undefined
    try {
      parsed = jsonParse(stdout)
    } catch {
      // A truncated or garbage payload. The entry exists, so this is emphatically
      // not "nothing is stored".
      return { status: 'unreadable', reason: 'stored secret is not valid JSON' }
    }
    if (parsed === null || parsed === undefined) {
      return { status: 'unreadable', reason: 'stored secret parsed to nothing' }
    }
    return { status: 'ok', data: parsed }
  }

  if (exitCode === 0) {
    // Looked up cleanly and there was nothing to print.
    return { status: 'absent' }
  }

  if (stderr.trim() !== '') {
    return {
      status: 'unreadable',
      reason: 'the secret service reported an error',
    }
  }

  return { status: 'absent' }
}

/** Run the lookup, reporting WHY it produced nothing. */
function lookupResult(): SecureStorageReadResult {
  try {
    const username = getUsername()
    const serviceName = getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    // secret-tool lookup service [service] account [account]
    const result = execaSync(
      'secret-tool',
      ['lookup', 'service', serviceName, 'account', username],
      { reject: false },
    )

    return classifyLookup(
      result.exitCode,
      String(result.stdout ?? ''),
      String(result.stderr ?? ''),
    )
  } catch {
    // The lookup never ran: secret-tool missing, spawn refused. Nothing here
    // says the store is empty.
    return { status: 'unreadable', reason: 'secret-tool could not be run' }
  }
}

/**
 * Linux-specific secure storage implementation using the secret-tool CLI.
 * secret-tool interacts with the Secret Service API (GNOME Keyring, KWallet, etc.).
 */
export const linuxSecretStorage: SecureStorage = {
  name: 'libsecret',
  // Exact projection of `lookupResult`, `null` for a miss AND for a failure.
  // That lossiness is load-bearing elsewhere — `createFallbackStorage`'s
  // `update` declines to delete this entry when this read came back `null` —
  // so the absent/unreadable distinction stays on `readResult` alone.
  read(): SecureStorageData | null {
    const result = lookupResult()
    return result.status === 'ok' ? result.data : null
  },
  readResult: lookupResult,
  async readAsync(): Promise<SecureStorageData | null> {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const result = await execa(
        'secret-tool',
        ['lookup', 'service', serviceName, 'account', username],
        { reject: false },
      )

      if (result.exitCode === 0 && result.stdout) {
        return jsonParse(result.stdout)
      }
    } catch {
      // fall through
    }
    return null
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const payload = jsonStringify(data)
      // secret-tool store --label=[label] service [service] account [account]
      // The payload is passed via stdin
      const result = execaSync(
        'secret-tool',
        [
          'store',
          '--label',
          serviceName,
          'service',
          serviceName,
          'account',
          username,
        ],
        { input: payload, reject: false },
      )

      return { success: result.exitCode === 0 }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool clear service [service] account [account]
      const result = execaSync(
        'secret-tool',
        ['clear', 'service', serviceName, 'account', username],
        { reject: false },
      )
      return result.exitCode === 0
    } catch {
      return false
    }
  },
}
