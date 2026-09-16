import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageReadResult,
} from './index.js'

/**
 * Read a storage on the channel that distinguishes a miss from a failure,
 * falling back to `read` for a backend that does not implement one.
 *
 * The fallback is what keeps this additive: a backend without `readResult`
 * says nothing about WHY its read was empty, so its `null` keeps meaning what
 * it has always meant. Reading a missing classifier as a failure instead would
 * refuse every write on the platforms whose primary backend cannot classify
 * yet.
 */
export function readSecureStorageResult(
  storage: SecureStorage,
): SecureStorageReadResult {
  if (storage.readResult) {
    return storage.readResult()
  }
  const data = storage.read()
  return data === null || data === undefined
    ? { status: 'absent' }
    : { status: 'ok', data }
}

/**
 * Creates a fallback storage that tries to use the primary storage first,
 * and if that fails, falls back to the secondary storage
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  function composedReadResult(): SecureStorageReadResult {
    const primaryResult = readSecureStorageResult(primary)
    if (primaryResult.status === 'ok') {
      return primaryResult
    }

    const secondaryResult = readSecureStorageResult(secondary)
    if (secondaryResult.status === 'ok') {
      return secondaryResult
    }

    // Neither backend produced data, and which reason wins decides whether a
    // writer may reconcile onto an empty blob. A failure anywhere in the chain
    // keeps the whole read UNREADABLE: calling it ABSENT would turn one locked
    // keyring into a licence to overwrite the credentials it is still holding.
    // Both ABSENT stays ABSENT, so a genuine first run still writes.
    return primaryResult.status === 'unreadable'
      ? primaryResult
      : secondaryResult
  }

  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,
    // Left EXACTLY as it was, rather than re-derived from
    // `composedReadResult`, so that every existing caller — and `update`
    // below, which reads the primary through this same lossy contract to
    // decide whether to delete its entry — keeps the behaviour it was written
    // against. `{}` here still means a miss AND a failure; only `readResult`
    // separates them, and `update` keeps declining to delete a primary that
    // merely failed to answer precisely because that failure still reads as
    // `null` to it.
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    readResult: composedReadResult,
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      return (await secondary.readAsync()) || {}
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Capture state before update
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        // Delete secondary when migrating to primary for the first time
        // This preserves credentials when sharing .claude between host and containers
        // See: https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        // Primary write failed but primary may still hold an *older* valid
        // entry. read() prefers primary whenever it returns non-null, so that
        // stale entry would shadow the fresh data we just wrote to secondary —
        // e.g. a refresh token the server has already rotated away, causing a
        // /login loop (#30337). Best-effort delete; if this also fails the
        // user's keychain is in a bad state we can't fix from here.
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      return primarySuccess || secondarySuccess
    },
  }
}
