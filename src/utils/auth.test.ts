import { afterEach, expect, mock, test } from 'bun:test'
import type { SecureStorage } from './secureStorage/index.js'

// Capture the genuine settings module once, through a query-suffixed specifier so
// the capture can never pick up an already-registered mock. A plain
// `import * as … from './settings/settings.js'` binds the LIVE namespace, which
// `mock.module()` mutates in place — restoring from it is a no-op that re-installs
// the stub. Precedent: src/utils/gitSettings.test.ts:8-10.
const realSettings = (await import(
  `./settings/settings.js?authTestRealSettings=${Date.now()}-${Math.random()}`
)) as typeof import('./settings/settings.js')

// Same capture, same reason, for the OTHER machine-state input auth.ts reads:
// the credential store. `withControlledAuthEnv` scrubs env vars, but nothing in
// an env scrub reaches secure storage, so `getSubscriptionType()` falls through
// to the stored OAuth credential and a developer box with a real libsecret entry
// answers with that entry's genuine subscriptionType — green on CI, red locally.
const realSecureStorage = (await import(
  `./secureStorage/index.js?authTestRealSecureStorage=${Date.now()}-${Math.random()}`
)) as typeof import('./secureStorage/index.js')

type MockSource =
  | 'userSettings'
  | 'projectSettings'
  | 'repositorySettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'none'

async function importAuthFresh() {
  return await import(`./auth.js?ts=${Date.now()}-${Math.random()}`)
}

// Bun's `mock.restore()` restores spyOn/function mocks only — it does NOT
// unregister a `mock.module()` registration, so the settings stub installed by
// mockSettings() would otherwise outlive this file for the rest of the runner
// process and poison every later test that reads settings. Re-register the genuine
// module first, then restore the function mocks.
// Addresses jatmn's P3 on #1731: test isolation for mock.module().
afterEach(() => {
  mock.module('./settings/settings.js', () => ({ ...realSettings }))
  restoreCredentialStore()
  mock.restore()
})

// Helper: mock settings to return the given subscriptionType from a specific
// source (or no source at all). The trusted-source helper in auth.ts reads
// from user settings only — project, local, flag, and policy settings must
// NOT propagate subscriptionType.
function mockSettings(
  subscriptionType: string | undefined,
  source: MockSource = 'userSettings',
) {
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getSettings_DEPRECATED: () => (source === 'none' ? {} : { subscriptionType }),
    getSettingsForSource: (s: string) => {
      if (source === 'none') return null
      return s === source ? { subscriptionType } : null
    },
  }))
}

// An "I am logged out" credential store. Modelling the empty case as `absent`
// (not `unreadable`) matters: `absent` is what a clean checkout actually has,
// and `unreadable` would exercise the degraded-read paths instead.
const emptyCredentialStore: SecureStorage = {
  name: 'auth-test-empty-credential-store',
  read: () => null,
  readResult: () => ({ status: 'absent' }),
  readAsync: async () => null,
  update: () => ({
    success: false,
    warning: 'auth.test.ts credential store is read-only',
  }),
  delete: () => true,
}

// Spread the whole captured namespace, exactly as mockSettings() does, so the
// stub is complete either way: `mock.module()` REPLACES a cold namespace and
// MERGES into a warm one, and a partial stub would make this file pass in only
// one import order.
function mockEmptyCredentialStore(): void {
  mock.module('./secureStorage/index.js', () => ({
    ...realSecureStorage,
    getSecureStorage: () => emptyCredentialStore,
  }))
}

function restoreCredentialStore(): void {
  mock.module('./secureStorage/index.js', () => ({ ...realSecureStorage }))
}

async function withControlledAuthEnv<T>(
  fn: () => Promise<T>,
  options: { oauthToken?: string } = {},
): Promise<T> {
  const previous = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,
    ANTHROPIC_UNIX_SOCKET: process.env.ANTHROPIC_UNIX_SOCKET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR:
      process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR,
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
    CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
    CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
    CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
    CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  }
  if (options.oauthToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.ANTHROPIC_UNIX_SOCKET
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GITHUB
  mockEmptyCredentialStore()
  try {
    return await fn()
  } finally {
    restoreCredentialStore()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withOAuthFallbackEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withControlledAuthEnv(fn, { oauthToken: 'test-oauth-token' })
}

test('isClaudeAISubscriber returns true if subscriptionType is pro in user settings', async () => {
  mockSettings('pro', 'userSettings')
  const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
  expect(isClaudeAISubscriber()).toBe(true)
  expect(getSubscriptionType()).toBe('pro')
})

test('isClaudeAISubscriber returns false if subscriptionType is free in user settings', async () => {
  mockSettings('free', 'userSettings')
  const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
  expect(isClaudeAISubscriber()).toBe(false)
  expect(getSubscriptionType()).toBe('free')
})

test('isClaudeAISubscriber returns true for OAuth fallback without a free override', async () => {
  mockSettings(undefined, 'none')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(true)
  })
})

// P2 regression: subscriptionType: "free" must short-circuit the OAuth path.
// Prior code only short-circuited non-free values, so free + valid OAuth
// returned true (the OAuth-detected subscriber state leaked through). This
// test sets a fake Claude AI OAuth token that WOULD satisfy the OAuth path,
// then asserts the free override wins.
test('isClaudeAISubscriber returns false for free override even when OAuth tokens would qualify', async () => {
  mockSettings('free', 'userSettings')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(false)
  })
})

for (const source of [
  'projectSettings',
  'repositorySettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const) {
  test(`isClaudeAISubscriber ignores subscriptionType from ${source}`, async () => {
    mockSettings('pro', source)
    await withControlledAuthEnv(async () => {
      const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
      expect(getSubscriptionType()).toBe(null)
      expect(isClaudeAISubscriber()).toBe(false)
    })
  })
}

// P2/P3 regression: when subscriptionType is 'free', isClaudeAISubscriber() returns false
// even if fallback auth conditions (OAuth/environment) are satisfied, and getSubscriptionType() returns 'free'.
test("when subscriptionType is 'free', isClaudeAISubscriber() returns false even if fallback auth conditions are satisfied, and getSubscriptionType() returns 'free'", async () => {
  mockSettings('free', 'userSettings')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(false)
    expect(getSubscriptionType()).toBe('free')
  })
})
