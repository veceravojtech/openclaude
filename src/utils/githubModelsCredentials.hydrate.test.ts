/**
 * Hydrate tests live in a separate file with no static import of
 * githubModelsCredentials so Bun's mock.module can replace secureStorage
 * before that module is first loaded.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

type GithubModelsCredentialsModule =
  typeof import('./githubModelsCredentials.js')
type SecureStorageModule = typeof import('./secureStorage/index.js')

/**
 * The real namespace, through a specifier nothing mocks. Bun fixes a mocked
 * specifier's export SHAPE at the first registration, so a stub that omits an
 * export makes that name permanently unresolvable for the rest of the process,
 * and any later file importing it dies at link time with
 * `SyntaxError: Export named '...' not found`. Spreading this into each stub
 * below keeps the shape complete.
 */
async function importActualSecureStorage(): Promise<SecureStorageModule> {
  return import(
    `./secureStorage/index.ts?githubModelsHydrateActual=${Date.now()}-${Math.random()}`
  )
}

let pristineSecureStorage: SecureStorageModule | undefined

function importFreshGithubModelsCredentials(
  cacheKey: string,
): Promise<GithubModelsCredentialsModule> {
  return import(
    `./githubModelsCredentials.js?${cacheKey}`
  ) as Promise<GithubModelsCredentialsModule>
}

function getEnvValue(name: string): string | undefined {
  return process.env[name]
}

describe('hydrateGithubModelsTokenFromSecureStorage', () => {
  const orig = {
    CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
    GITHUB_COPILOT_KEY: process.env.GITHUB_COPILOT_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    CLAUDE_CODE_GITHUB_TOKEN_HYDRATED:
      process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  }

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/githubModelsCredentials.hydrate.test.ts')
    pristineSecureStorage ??= await importActualSecureStorage()
  })

  afterEach(() => {
    try {
      mock.restore()
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) {
          delete process.env[k as keyof typeof orig]
        } else {
          process.env[k as keyof typeof orig] = v
        }
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('sets GITHUB_TOKEN from secure storage when USE_GITHUB and env token empty', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('./secureStorage/index.js', () => ({
      ...pristineSecureStorage,
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=sets-token')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_TOKEN')).toBe('stored-secret')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBe('1')
  })

  test('sets GITHUB_COPILOT_KEY when secure storage contains a direct Copilot key', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'shell-token'
    delete process.env.GITHUB_COPILOT_KEY
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('./secureStorage/index.js', () => ({
      ...pristineSecureStorage,
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: 'stored-enterprise-key',
            credentialType: 'copilot_key',
          },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=sets-copilot-key')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_COPILOT_KEY')).toBe('stored-enterprise-key')
    expect(getEnvValue('GITHUB_TOKEN')).toBe('shell-token')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBe('1')
  })

  test('does not override existing GITHUB_TOKEN', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'already'
    delete process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED

    mock.module('./secureStorage/index.js', () => ({
      ...pristineSecureStorage,
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=preserve-existing')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_TOKEN')).toBe('already')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBeUndefined()
  })
})
