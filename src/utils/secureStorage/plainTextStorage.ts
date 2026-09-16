import { chmodSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageReadResult,
} from './index.js'

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

/**
 * Read the file, reporting WHY it produced nothing.
 *
 * ENOENT is the only condition that means "nothing is stored". EACCES, EIO, a
 * directory where the file should be, and a payload that no longer parses all
 * mean the credentials may still be there and we could not see them — which is
 * not something a writer may reconcile over.
 */
function readFileResult(): SecureStorageReadResult {
  // sync IO: called from sync context (SecureStorage interface)
  const { storagePath } = getStoragePath()
  let data: string
  try {
    data = getFsImplementation().readFileSync(storagePath, {
      encoding: 'utf8',
    })
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'ENOENT') {
      return { status: 'absent' }
    }
    return {
      status: 'unreadable',
      reason: 'the credentials file could not be read',
    }
  }

  let parsed: SecureStorageData | null | undefined
  try {
    parsed = jsonParse(data)
  } catch {
    return {
      status: 'unreadable',
      reason: 'the credentials file is not valid JSON',
    }
  }
  if (parsed === null || parsed === undefined) {
    return {
      status: 'unreadable',
      reason: 'the credentials file parsed to nothing',
    }
  }
  return { status: 'ok', data: parsed }
}

export const plainTextStorage = {
  name: 'plaintext',
  // Exact projection of `readFileResult`, `null` for a miss AND for a failure;
  // the distinction lives on `readResult` alone. See the note on
  // `SecureStorage.readResult` for why this contract is kept lossy.
  read(): SecureStorageData | null {
    const result = readFileResult()
    return result.status === 'ok' ? result.data : null
  },
  readResult: readFileResult,
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    // Declared out here only so the catch can clean it up: `update` must keep
    // reporting failure through its return value and never throw, so nothing
    // that can raise may move out of the try.
    let tmpPath: string | undefined
    try {
      const { storageDir, storagePath } = getStoragePath()
      // Write to a sibling temp file and rename over the target. A crash or a
      // concurrent reader then sees either the whole old file or the whole new
      // one, never a half-written one — losing every stored credential to a
      // truncated write is the worst failure this file has.
      tmpPath = `${storagePath}.tmp-${process.pid}-${Date.now().toString(36)}`
      try {
        getFsImplementation().mkdirSync(storageDir)
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      writeFileSync_DEPRECATED(tmpPath, jsonStringify(data), {
        encoding: 'utf8',
        mode: 0o600,
        // fsync before the rename, so the rename cannot land ahead of the
        // bytes it is supposed to publish.
        flush: true,
      })
      // `mode` above is subject to umask; chmod makes 0600 unconditional, and
      // it happens before the file is reachable under its real name.
      chmodSync(tmpPath, 0o600)
      getFsImplementation().renameSync(tmpPath, storagePath)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      if (tmpPath !== undefined) {
        try {
          getFsImplementation().unlinkSync(tmpPath)
        } catch {
          // Best effort: the temp file may never have been created.
        }
      }
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
