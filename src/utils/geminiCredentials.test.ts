import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

type MockStorageData = Record<string, unknown>
type SecureStorageModule = typeof import('./secureStorage/index.js')

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
let storageState: MockStorageData = {}

/**
 * The real namespace, fetched through a specifier nothing mocks. The stub
 * below replaces the module with `getSecureStorage` ALONE, dropping every
 * other export — including the `readSecureStorageResult` re-export at
 * secureStorage/index.ts:3. `mock.restore()` does not undo `mock.module()`,
 * so without the restore in afterEach that partial stub outlives this file and
 * any later file importing a dropped export dies at import time with
 * `SyntaxError: Export named '...' not found`.
 */
async function importActualSecureStorage(): Promise<SecureStorageModule> {
  return import(
    `./secureStorage/index.ts?geminiCredentialsActual=${Date.now()}-${Math.random()}`
  )
}

let pristineSecureStorage: SecureStorageModule | undefined

async function importFreshModule() {
  pristineSecureStorage ??= await importActualSecureStorage()
  mock.module('./secureStorage/index.js', () => ({
    // Spread the real namespace so the stub keeps every export this module
    // has. Bun fixes a mocked specifier's export SHAPE at the first
    // registration, so a stub that omits an export makes it permanently
    // unresolvable for the rest of the process - a later restore cannot widen
    // it back, and any file importing the dropped name dies at link time.
    ...pristineSecureStorage,
    getSecureStorage: () => ({
      name: 'mock-secure-storage',
      read: () => storageState,
      readAsync: async () => storageState,
      update: (next: MockStorageData) => {
        storageState = next
        return { success: true }
      },
      delete: () => {
        storageState = {}
        return true
      },
    }),
  }))

  return import(`./geminiCredentials.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/geminiCredentials.test.ts')
  pristineSecureStorage ??= await importActualSecureStorage()
  process.env = { ...originalEnv }
  delete process.env.CLAUDE_CODE_SIMPLE
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageState = {}
})

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    storageState = {}
    mock.restore()
    if (pristineSecureStorage) {
      mock.module('./secureStorage/index.js', () => ({
        ...pristineSecureStorage!,
      }))
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('saveGeminiAccessToken stores and reads back the token', async () => {
  const {
    readGeminiAccessToken,
    saveGeminiAccessToken,
  } = await importFreshModule()

  const result = saveGeminiAccessToken('token-123')
  expect(result.success).toBe(true)
  expect(readGeminiAccessToken()).toBe('token-123')
})

test('clearGeminiAccessToken removes the stored token', async () => {
  const {
    clearGeminiAccessToken,
    readGeminiAccessToken,
    saveGeminiAccessToken,
  } = await importFreshModule()

  expect(saveGeminiAccessToken('token-123').success).toBe(true)
  expect(clearGeminiAccessToken().success).toBe(true)
  expect(readGeminiAccessToken()).toBeUndefined()
})
