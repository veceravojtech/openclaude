/**
 * The backends' side of "a read that failed is not an empty store".
 *
 * `read` answers `null` for a miss and for a failure alike, and
 * `createFallbackStorage` turned that into `{}`, so the whole chain handed a
 * writer the same value whether nothing was stored or the keyring had gone
 * away. These tests pin where each condition is classified, and — just as
 * importantly — pin that `read` itself did NOT change: `createFallbackStorage`'s
 * `update` decides whether to delete the primary entry from `primary.read()`
 * being non-null, so promoting an unreadable primary to a non-null `read` would
 * arm that delete on a store that is merely unavailable.
 *
 * No real keyring and no real filesystem: `execa` and the fs implementation are
 * both stubbed, and no credentials file is ever created.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as realExeca from 'execa'
import * as realFsOperations from '../fsOperations.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { createFallbackStorage } from './fallbackStorage.js'
import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageReadResult,
} from './index.js'
import type { linuxSecretStorage as LinuxSecretStorage } from './linuxSecretStorage.js'
import type { plainTextStorage as PlainTextStorage } from './plainTextStorage.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealExeca = { ...realExeca }
const pristineRealFsOperations = { ...realFsOperations }

type LookupOutcome = {
  exitCode?: number
  stdout?: string
  stderr?: string
  /** Set to make the spawn itself fail, as a missing secret-tool would. */
  thrown?: Error
}

/** What the next `secret-tool lookup` will do. */
let lookupOutcome: LookupOutcome = { exitCode: 0, stdout: '', stderr: '' }

/** What the next credentials-file read will do. */
let fileOutcome: { contents?: string; thrown?: Error } = {
  thrown: errnoError('ENOENT'),
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`stubbed ${code}`), { code })
}

/** A blob with enough in it to tell "the real data" from "an empty object". */
const storedBlob: SecureStorageData = {
  claudeAiOauthAccounts: {
    'uuid-work': {
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: 1,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    },
  },
  claudeAiOauthActive: 'uuid-work',
}

/** A backend from before `readResult` existed: `read` and nothing else. */
function legacyStorage(data: SecureStorageData | null): SecureStorage {
  return {
    name: 'legacy',
    read: () => data,
    readAsync: async () => data,
    update: () => ({ success: true }),
    delete: () => true,
  }
}

/** A backend that classifies its read. */
function classifyingStorage(
  result: SecureStorageReadResult,
  name = 'classifying',
): SecureStorage {
  return {
    name,
    read: () => (result.status === 'ok' ? result.data : null),
    readResult: () => result,
    readAsync: async () => (result.status === 'ok' ? result.data : null),
    update: () => ({ success: true }),
    delete: () => true,
  }
}

const UNREADABLE: SecureStorageReadResult = {
  status: 'unreadable',
  reason: 'test: backend failed',
}

describe('backends tell a miss apart from a failure', () => {
  let linuxSecretStorage: typeof LinuxSecretStorage
  let plainTextStorage: typeof PlainTextStorage

  beforeAll(async () => {
    await acquireSharedMutationLock('secureStorage/degradedRead.test.ts')
    mock.restore()
    mock.module('execa', () => ({
      ...realExeca,
      execaSync: (..._args: unknown[]) => {
        if (lookupOutcome.thrown) {
          throw lookupOutcome.thrown
        }
        return {
          exitCode: lookupOutcome.exitCode ?? 0,
          stdout: lookupOutcome.stdout ?? '',
          stderr: lookupOutcome.stderr ?? '',
        }
      },
    }))
    mock.module('../fsOperations.js', () => ({
      ...pristineRealFsOperations,
      getFsImplementation: () => ({
        // The PRISTINE snapshot, not the live namespace: mock.module() has
        // already replaced the namespace's binding with this very function, so
        // calling through it would recurse.
        ...pristineRealFsOperations.getFsImplementation(),
        readFileSync: (..._args: unknown[]) => {
          if (fileOutcome.thrown) {
            throw fileOutcome.thrown
          }
          return fileOutcome.contents ?? ''
        },
      }),
    }))

    const suffix = `?degradedReadTest=${Date.now()}-${Math.random()}`
    ;({ linuxSecretStorage } = await import(`./linuxSecretStorage.js${suffix}`))
    ;({ plainTextStorage } = await import(`./plainTextStorage.js${suffix}`))
  })

  beforeEach(() => {
    lookupOutcome = { exitCode: 0, stdout: '', stderr: '' }
    fileOutcome = { thrown: errnoError('ENOENT') }
  })

  afterEach(() => {
    mock.clearAllMocks()
  })

  afterAll(() => {
    try {
      mock.module('execa', () => ({ ...pristineRealExeca }))
      mock.module('../fsOperations.js', () => ({ ...pristineRealFsOperations }))
    } finally {
      releaseSharedMutationLock()
    }
  })

  describe('libsecret', () => {
    test('a payload that parses is the stored data', () => {
      lookupOutcome = { exitCode: 0, stdout: JSON.stringify(storedBlob) }

      expect(linuxSecretStorage.readResult?.()).toEqual({
        status: 'ok',
        data: storedBlob,
      })
      expect(linuxSecretStorage.read()).toEqual(storedBlob)
    })

    test('a silent non-zero exit is a miss, so a first run can still write', () => {
      // `secret-tool lookup` exits non-zero when there is simply no such item,
      // and prints nothing.
      lookupOutcome = { exitCode: 1, stdout: '', stderr: '' }

      expect(linuxSecretStorage.readResult?.().status).toBe('absent')
      expect(linuxSecretStorage.read()).toBeNull()
    })

    test('a non-zero exit that reported an error is UNREADABLE, not a miss', () => {
      // A locked keyring / D-Bus failure: libsecret says why on stderr.
      lookupOutcome = {
        exitCode: 1,
        stdout: '',
        stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY',
      }

      expect(linuxSecretStorage.readResult?.().status).toBe('unreadable')
      // Still null: `createFallbackStorage`'s update reads this to decide
      // whether to delete the entry, and must keep declining.
      expect(linuxSecretStorage.read()).toBeNull()
    })

    test('a truncated payload is UNREADABLE — the entry exists', () => {
      lookupOutcome = { exitCode: 0, stdout: '{"claudeAiOauthAcc' }

      expect(linuxSecretStorage.readResult?.().status).toBe('unreadable')
      expect(linuxSecretStorage.read()).toBeNull()
    })

    test('a lookup that could not be run at all is UNREADABLE', () => {
      lookupOutcome = { thrown: errnoError('ENOENT') }

      expect(linuxSecretStorage.readResult?.().status).toBe('unreadable')
      expect(linuxSecretStorage.read()).toBeNull()
    })

    test('a clean exit with nothing to print is a miss', () => {
      lookupOutcome = { exitCode: 0, stdout: '', stderr: '' }

      expect(linuxSecretStorage.readResult?.().status).toBe('absent')
      expect(linuxSecretStorage.read()).toBeNull()
    })

    test('read() stays null for every condition that is not readable data', () => {
      // The delete-on-primary-failure guard in `createFallbackStorage.update`
      // keys off exactly this, so this is a contract, not an observation.
      const nonData: LookupOutcome[] = [
        { exitCode: 1, stdout: '', stderr: '' },
        { exitCode: 1, stdout: '', stderr: 'keyring is locked' },
        { exitCode: 0, stdout: 'not json' },
        { thrown: errnoError('ENOENT') },
      ]

      for (const outcome of nonData) {
        lookupOutcome = outcome
        expect(linuxSecretStorage.read()).toBeNull()
      }
    })
  })

  describe('plaintext file', () => {
    test('a file that parses is the stored data', () => {
      fileOutcome = { contents: JSON.stringify(storedBlob) }

      expect(plainTextStorage.readResult?.()).toEqual({
        status: 'ok',
        data: storedBlob,
      })
      expect(plainTextStorage.read()).toEqual(storedBlob)
    })

    test('ENOENT is the one condition that means nothing is stored', () => {
      fileOutcome = { thrown: errnoError('ENOENT') }

      expect(plainTextStorage.readResult?.().status).toBe('absent')
      expect(plainTextStorage.read()).toBeNull()
    })

    test('a file that exists but cannot be read is UNREADABLE', () => {
      fileOutcome = { thrown: errnoError('EACCES') }

      expect(plainTextStorage.readResult?.().status).toBe('unreadable')
      expect(plainTextStorage.read()).toBeNull()
    })

    test('a corrupt file is UNREADABLE, not an empty store', () => {
      fileOutcome = { contents: '{"claudeAiOauth": ' }

      expect(plainTextStorage.readResult?.().status).toBe('unreadable')
      expect(plainTextStorage.read()).toBeNull()
    })
  })

  /**
   * The real chain — real `createFallbackStorage` over the real Linux
   * backends, stubbed only at the process and filesystem edge. This is the
   * composition `getSecureStorage()` builds on Linux, so it is where the
   * first-run guarantee and the catastrophic case both have to hold.
   */
  describe('the composition getSecureStorage builds on linux', () => {
    test('nothing stored anywhere is ABSENT, so a first login still writes', () => {
      // No such item in the keyring, no credentials file.
      lookupOutcome = { exitCode: 1, stdout: '', stderr: '' }
      fileOutcome = { thrown: errnoError('ENOENT') }

      const storage = createFallbackStorage(linuxSecretStorage, plainTextStorage)

      expect(storage.readResult?.().status).toBe('absent')
      expect(storage.read()).toEqual({})
    })

    test('a keyring that failed with no file behind it is UNREADABLE', () => {
      // The configuration this defect is worst in: libsecret is the single
      // store of record, and it did not answer.
      lookupOutcome = {
        exitCode: 1,
        stdout: '',
        stderr: 'secret-tool: org.freedesktop.Secret.Error.IsLocked',
      }
      fileOutcome = { thrown: errnoError('ENOENT') }

      const storage = createFallbackStorage(linuxSecretStorage, plainTextStorage)

      expect(storage.readResult?.().status).toBe('unreadable')
      // The legacy projection is unchanged: the same `{}` it always answered.
      expect(storage.read()).toEqual({})
    })

    test('a keyring that answered is still just the data', () => {
      lookupOutcome = { exitCode: 0, stdout: JSON.stringify(storedBlob) }

      const storage = createFallbackStorage(linuxSecretStorage, plainTextStorage)

      expect(storage.readResult?.()).toEqual({ status: 'ok', data: storedBlob })
      expect(storage.read()).toEqual(storedBlob)
    })

    test('a failed keyring over a readable file is that file', () => {
      lookupOutcome = { exitCode: 1, stdout: '', stderr: 'keyring is locked' }
      fileOutcome = { contents: JSON.stringify(storedBlob) }

      const storage = createFallbackStorage(linuxSecretStorage, plainTextStorage)

      expect(storage.readResult?.()).toEqual({ status: 'ok', data: storedBlob })
      expect(storage.read()).toEqual(storedBlob)
    })
  })
})

describe('the fallback chain never turns a failure into an empty store', () => {
  test('both backends missing is ABSENT, and read() is still {}', () => {
    const storage = createFallbackStorage(
      classifyingStorage({ status: 'absent' }, 'primary'),
      classifyingStorage({ status: 'absent' }, 'secondary'),
    )

    expect(storage.readResult?.().status).toBe('absent')
    expect(storage.read()).toEqual({})
  })

  test('an unreadable primary with a readable secondary is that data', () => {
    const storage = createFallbackStorage(
      classifyingStorage(UNREADABLE, 'primary'),
      classifyingStorage({ status: 'ok', data: storedBlob }, 'secondary'),
    )

    expect(storage.readResult?.()).toEqual({ status: 'ok', data: storedBlob })
    expect(storage.read()).toEqual(storedBlob)
  })

  test('an unreadable primary over a missing secondary stays UNREADABLE', () => {
    // The configuration this defect is worst in: one store of record, and it
    // did not answer. Calling this ABSENT is what licenses the overwrite.
    const storage = createFallbackStorage(
      classifyingStorage(UNREADABLE, 'primary'),
      classifyingStorage({ status: 'absent' }, 'secondary'),
    )

    expect(storage.readResult?.().status).toBe('unreadable')
    // Unchanged projection: the writer aborts on `readResult`, not on this.
    expect(storage.read()).toEqual({})
  })

  test('both backends failing is UNREADABLE', () => {
    const storage = createFallbackStorage(
      classifyingStorage(UNREADABLE, 'primary'),
      classifyingStorage(UNREADABLE, 'secondary'),
    )

    expect(storage.readResult?.().status).toBe('unreadable')
  })

  test('a missing primary reports the secondary failure it fell through to', () => {
    const storage = createFallbackStorage(
      classifyingStorage({ status: 'absent' }, 'primary'),
      classifyingStorage(UNREADABLE, 'secondary'),
    )

    expect(storage.readResult?.().status).toBe('unreadable')
  })

  test('a readable primary is never second-guessed by the secondary', () => {
    const storage = createFallbackStorage(
      classifyingStorage({ status: 'ok', data: storedBlob }, 'primary'),
      classifyingStorage(UNREADABLE, 'secondary'),
    )

    expect(storage.readResult?.()).toEqual({ status: 'ok', data: storedBlob })
  })

  test('backends that cannot classify keep the behaviour they had', () => {
    // macOS and Windows primaries do not implement `readResult` yet. Their
    // `null` must keep meaning "nothing to hand back" rather than becoming a
    // refusal to write.
    const storage = createFallbackStorage(
      legacyStorage(null),
      legacyStorage(null),
    )

    expect(storage.readResult?.().status).toBe('absent')
    expect(storage.read()).toEqual({})

    const withData = createFallbackStorage(
      legacyStorage(null),
      legacyStorage(storedBlob),
    )

    expect(withData.readResult?.()).toEqual({ status: 'ok', data: storedBlob })
    expect(withData.read()).toEqual(storedBlob)
  })
})
