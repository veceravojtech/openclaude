import { setCyberModeEnabled } from '../../bootstrap/state.js'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import * as debugNs from '../../utils/debug.js'
import { markOpenAIRequestNonReplayable } from './openaiErrorClassification.js'
type ProvidersModule = typeof import('../../utils/model/providers.js')
type SleepModule = typeof import('../../utils/sleep.js')
type AuthModule = typeof import('../../utils/auth.js')
type FastModeModule = typeof import('../../utils/fastMode.js')
type AccountSwitchModule = typeof import('../../utils/accountSwitch.js')

// Helper to build a mock APIError with specific headers
function makeError(headers: Record<string, string>): APIError {
  const headersObj = new Headers(headers)
  return new APIError(
    429,
    { error: { type: 'rate_limit_error', message: 'rate limit exceeded' } },
    'rate limit exceeded',
    headersObj,
  )
}

// Save/restore env vars between tests
const originalEnv = { ...process.env }
const originalDebugModule = { ...debugNs }
let originalProvidersModule: ProvidersModule | undefined
let originalSleepModule: SleepModule | undefined
let originalAuthModule: AuthModule | undefined
let originalFastModeModule: FastModeModule | undefined
let originalAccountSwitchModule: AccountSwitchModule | undefined

const envKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_MAX_RETRIES',
  'OPENCLAUDE_MAX_RETRIES',
  'OPENCLAUDE_RETRY_DELAY_MS',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
] as const

beforeEach(async () => {
  await acquireSharedMutationLock('withRetry.test.ts')
  for (const key of envKeys) {
    delete process.env[key]
  }
})

afterEach(() => {
  setCyberModeEnabled(false)
  try {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    mock.restore()
    if (originalProvidersModule) {
      // Spread, never the namespace object itself: mock.module() mutates the
      // registration in place, so handing back the namespace re-installs the
      // stub instead of undoing it (see utils/auth.test.ts:6-7).
      mock.module('src/utils/model/providers.js', () => ({
        ...originalProvidersModule!,
      }))
    }
    // importFreshWithRetryModule() neuters sleep to keep the backoff tests
    // fast. Nothing used to put it back, so the no-op sleep escaped this file
    // and turned every later real-time backoff loop into a busy-poll.
    if (originalSleepModule) {
      mock.module('src/utils/sleep.js', () => ({ ...originalSleepModule! }))
    }
    // auth, fastMode and accountSwitch were stubbed but never put back, so
    // they escaped this file too: the accountSwitch stub made readAccounts()
    // serve this file's fixture to every later suite, and the auth stub made
    // getClaudeAIOAuthTokens() hand out a mock token.
    if (originalAuthModule) {
      mock.module('src/utils/auth.js', () => ({ ...originalAuthModule! }))
    }
    if (originalFastModeModule) {
      mock.module('src/utils/fastMode.js', () => ({ ...originalFastModeModule! }))
    }
    if (originalAccountSwitchModule) {
      mock.module('src/utils/accountSwitch.js', () => ({
        ...originalAccountSwitchModule!,
      }))
    }
    mock.module('src/utils/debug.js', () => originalDebugModule)
  } finally {
    releaseSharedMutationLock()
  }
})

async function importActualProviders(): Promise<ProvidersModule> {
  return import(
    `../../utils/model/providers.ts?withRetryActual=${Date.now()}-${Math.random()}`
  )
}

async function importActualSleep(): Promise<SleepModule> {
  return import(
    `../../utils/sleep.ts?withRetryActual=${Date.now()}-${Math.random()}`
  )
}

async function importActualAuth(): Promise<AuthModule> {
  return import(
    `../../utils/auth.ts?withRetryActual=${Date.now()}-${Math.random()}`
  )
}

async function importActualFastMode(): Promise<FastModeModule> {
  return import(
    `../../utils/fastMode.ts?withRetryActual=${Date.now()}-${Math.random()}`
  )
}

async function importActualAccountSwitch(): Promise<AccountSwitchModule> {
  return import(
    `../../utils/accountSwitch.ts?withRetryActual=${Date.now()}-${Math.random()}`
  )
}

async function importFreshWithRetryModule(
  provider:
    | 'firstParty'
    | 'openai'
    | 'github'
    | 'bedrock'
    | 'vertex'
    | 'gemini'
    | 'codex'
    | 'foundry' = 'firstParty',
  options: {
    logForDebugging?: ReturnType<typeof mock>
    forceFastMode?: boolean
    /** Partial stub over utils/auth.js, installed before withRetry imports it. */
    auth?: Record<string, unknown>
  } = {},
) {
  mock.restore()
  originalProvidersModule ??= await importActualProviders()
  originalSleepModule ??= await importActualSleep()
  mock.module('src/utils/sleep.js', () => ({
    sleep: async () => undefined,
  }))
  if (options?.logForDebugging) {
    mock.module('src/utils/debug.js', () => ({
      ...originalDebugModule,
      logForDebugging: options.logForDebugging!,
    }))
  }
  mock.module('src/utils/model/providers.js', () => ({
    ...originalProvidersModule!,
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => provider === 'firstParty',
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  if (options.forceFastMode) {
    originalFastModeModule ??= await importActualFastMode()
    mock.module('src/utils/fastMode.js', () => ({
      ...originalFastModeModule!,
      isFastModeEnabled: () => true,
    }))
  }
  if (options.auth) {
    // Spread the real module: withRetry also pulls clearApiKeyHelperCache and
    // the subscriber predicates from it. Nothing here reaches real credentials
    // — the stub answers before any keychain or network access would happen.
    // Capture through a cache-busted specifier: a plain import would hand back
    // the live namespace, which mock.module() mutates in place, so a later
    // restore would re-install the stub instead of undoing it.
    originalAuthModule ??= await importActualAuth()
    mock.module('src/utils/auth.js', () => ({
      ...originalAuthModule!,
      ...options.auth,
    }))
  }
  return import(`./withRetry.js?ts=${Date.now()}-${Math.random()}`)
}

async function drainAsyncGenerator<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const result = await generator.next()
    if (result.done) return result.value
  }
}

describe('cyber retry enforcement', () => {
  test('exhausted retries select scoped fallback models', async () => {
    const { withRetry, FallbackTriggeredError } = await importFreshWithRetryModule('openai')
    setCyberModeEnabled(true)
    for (const [model, fallback] of [['glm-5.3', 'claude-opus-4-8'], ['claude-opus-4-6', 'deepseek-v4-pro']]) {
      let attempts = 0
      try {
        await drainAsyncGenerator(withRetry(async () => ({} as Anthropic), async () => {
          attempts++
          throw new APIConnectionError({ message: 'connection failed' })
        }, { model: model!, maxRetries: 1, thinkingConfig: { type: 'disabled' } }))
        throw new Error('expected fallback')
      } catch (error) {
        expect(error).toBeInstanceOf(FallbackTriggeredError)
        expect((error as InstanceType<typeof FallbackTriggeredError>).fallbackModel).toBe(fallback!)
      }
      expect(attempts).toBe(2)
    }
  })

  test('last-line policy blocks a forbidden model before operation', async () => {
    const { withRetry } = await importFreshWithRetryModule('openai')
    setCyberModeEnabled(true)
    let called = false
    await expect(drainAsyncGenerator(withRetry(async () => ({} as Anthropic), async () => {
      called = true
    }, { model: 'glm-5.3-flash', maxRetries: 0, thinkingConfig: { type: 'disabled' } }))).rejects.toThrow()
    expect(called).toBe(false)
  })
})

describe('retry configuration', () => {
  test('uses default retry attempts when env var is absent', async () => {
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(10)
  })

  test('reads retry attempts from OPENCLAUDE_MAX_RETRIES', async () => {
    process.env.OPENCLAUDE_MAX_RETRIES = '4'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(4)
  })

  test('allows zero retry attempts', async () => {
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(0)
  })

  test('falls back to legacy CLAUDE_CODE_MAX_RETRIES when new env var is absent', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '0'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(0)
  })

  test('prefers OPENCLAUDE_MAX_RETRIES over legacy CLAUDE_CODE_MAX_RETRIES', async () => {
    process.env.OPENCLAUDE_MAX_RETRIES = '3'
    process.env.CLAUDE_CODE_MAX_RETRIES = '0'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(3)
  })

  test('falls back to default retry attempts for invalid values', async () => {
    process.env.OPENCLAUDE_MAX_RETRIES = 'nope'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(10)
  })

  test('caps retry attempts to a bounded value', async () => {
    process.env.OPENCLAUDE_MAX_RETRIES = '1000'
    const { getDefaultMaxRetries } = await importFreshWithRetryModule()
    expect(getDefaultMaxRetries()).toBe(100)
  })

  test('uses default retry delay when env var is absent', async () => {
    const { getDefaultRetryDelayMs } = await importFreshWithRetryModule()
    expect(getDefaultRetryDelayMs()).toBe(500)
  })

  test('reads retry delay from OPENCLAUDE_RETRY_DELAY_MS', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1500'
    const { getDefaultRetryDelayMs } = await importFreshWithRetryModule()
    expect(getDefaultRetryDelayMs()).toBe(1500)
  })

  test('falls back to default retry delay for invalid values', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '-1'
    const { getDefaultRetryDelayMs } = await importFreshWithRetryModule()
    expect(getDefaultRetryDelayMs()).toBe(500)
  })

  test('uses configured retry delay as exponential backoff base', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '2000'
    const originalRandom = Math.random
    Math.random = () => 0
    try {
      const { getRetryDelay } = await importFreshWithRetryModule()
      expect(getRetryDelay(1)).toBe(2000)
      expect(getRetryDelay(2)).toBe(4000)
    } finally {
      Math.random = originalRandom
    }
  })

  test('retry-after header takes precedence over configured delay', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '2000'
    const { getRetryDelay } = await importFreshWithRetryModule()
    expect(getRetryDelay(1, '3')).toBe(3000)
  })
})

describe('abort retry classification', () => {
  test('does not retry or error-log expected side task aborts', async () => {
    const debugLog = mock(
      (_message: string, _options?: { level?: string }) => {},
    )
    const { CannotRetryError, withRetry } = await importFreshWithRetryModule(
      'firstParty',
      { logForDebugging: debugLog },
    )
    const controller = new AbortController()
    let attempts = 0

    await expect(
      drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            controller.abort('agent-summary-superseded')
            throw new APIUserAbortError()
          },
          {
            maxRetries: 2,
            model: 'test-model',
            thinkingConfig: { type: 'disabled' },
            signal: controller.signal,
            querySource: 'agent_summary',
          },
        ),
      ),
    ).rejects.toBeInstanceOf(CannotRetryError)

    expect(attempts).toBe(1)
    expect(
      debugLog.mock.calls.some(([message, options]) => {
        return (
          String(message).startsWith('API error (attempt') &&
          (options as { level?: string } | undefined)?.level === 'error'
        )
      }),
    ).toBe(false)
    expect(
      debugLog.mock.calls.some(([message, options]) => {
        return (
          String(message).includes('Expected side-task API abort') &&
          String(message).includes('agent-summary-superseded') &&
          (options as { level?: string } | undefined)?.level !== 'error'
        )
      }),
    ).toBe(true)
  })

  test('still logs and retries real retryable API errors', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const debugLog = mock(
      (_message: string, _options?: { level?: string }) => {},
    )
    const { withRetry } = await importFreshWithRetryModule('firstParty', {
      logForDebugging: debugLog,
    })
    const retryableError = APIError.generate(
      500,
      undefined,
      'internal server error',
      new Headers(),
    )
    let attempts = 0

    const result = await drainAsyncGenerator(
      withRetry(
        async () => ({} as Anthropic),
        async () => {
          attempts++
          if (attempts === 1) {
            throw retryableError
          }
          return { ok: true }
        },
        {
          maxRetries: 2,
          model: 'test-model',
          thinkingConfig: { type: 'disabled' },
          querySource: 'repl_main_thread',
        },
      ),
    )

    expect(result).toEqual({ ok: true })
    expect(attempts).toBe(2)
    expect(
      debugLog.mock.calls.some(([message, options]) => {
        return (
          String(message).startsWith('API error (attempt 1/3)') &&
          String(message).includes('500 internal server error') &&
          (options as { level?: string } | undefined)?.level === 'error'
        )
      }),
    ).toBe(true)
  })
})

describe('OpenAI-compatible retry classification', () => {
  test('does not retry request timeouts marked as non-replayable', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai')
    const error = markOpenAIRequestNonReplayable(
      APIError.generate(
        0,
        undefined,
        'OpenAI API transport error: no response headers [openai_category=request_timeout,host=slow.example.test]',
        new Headers(),
      ),
    )
    let attempts = 0

    let caught: unknown
    try {
      await drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            throw error
          },
          {
            maxRetries: 2,
            model: 'gpt-4o-mini',
            thinkingConfig: { type: 'disabled' },
          },
        ),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as { originalError?: unknown }).originalError).toBe(error)
    expect(attempts).toBe(1)
  })

  test('does not retry marked non-retryable auth failures', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai')
    const error = APIError.generate(
      401,
      undefined,
      'OpenAI API error 401: Unauthorized [openai_category=auth_invalid,host=api.z.ai] Hint: Authentication failed.',
      new Headers(),
    )
    let attempts = 0

    await expect(
      drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            throw error
          },
          {
            maxRetries: 2,
            model: 'glm-5.1',
            thinkingConfig: { type: 'disabled' },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(CannotRetryError)

    expect(attempts).toBe(1)
  })

  test('does not retry quota/allotment exhaustion failures', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai')
    const error = APIError.generate(
      402,
      undefined,
      'OpenAI API error 402: Payment Required [openai_category=quota_exhausted,host=opencode.ai] Hint: Provider quota or usage allotment has run out.',
      new Headers(),
    )
    let attempts = 0

    let caught: unknown
    try {
      await drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            throw error
          },
          {
            maxRetries: 2,
            model: 'glm-5.1',
            thinkingConfig: { type: 'disabled' },
          },
        ),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as { originalError?: unknown }).originalError).toBe(error)
    expect(attempts).toBe(1)
  })

  test('preserves the OpenCode Go quota message through the retry loop instead of the generic guard', async () => {
    // Regression for #1749: the early isQuotaExhausted guard used to wrap an
    // OpenCode Go FreeUsageLimitError in the generic "API quota exhausted or
    // not enabled" message, clobbering the actionable subscribe guidance.
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai')
    const { getAssistantMessageFromError, OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE } =
      await import('./errors.js')
    const error = APIError.generate(
      429,
      undefined,
      JSON.stringify({
        error: { type: 'FreeUsageLimitError', message: 'free usage limit reached' },
      }),
      new Headers({
        'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages',
      }),
    )
    let attempts = 0

    let caught: unknown
    try {
      await drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            throw error
          },
          {
            maxRetries: 2,
            model: 'glm-5.1',
            thinkingConfig: { type: 'disabled' },
          },
        ),
      )
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(CannotRetryError)
    // Terminal — no wasteful retries against an exhausted quota.
    expect(attempts).toBe(1)
    // The original APIError survives so the specific OpenCode Go assistant
    // message is recoverable, not the generic billing guidance.
    const original = (caught as { originalError?: unknown }).originalError
    expect(original).toBe(error)
    const message = getAssistantMessageFromError(original as APIError, 'glm-5.1')
    const text = message.message.content[0]
    expect(
      typeof text === 'object' && text && 'text' in text ? text.text : '',
    ).toBe(OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE)
    expect((caught as Error).message).not.toContain(
      'API quota exhausted or not enabled',
    )
  })

  test('terminates OpenCode Go quota 429 immediately in fast mode (no fast-mode retry/cooldown)', async () => {
    // Regression for #1749 (CodeRabbit): the OpenCode Go terminal throw must run
    // BEFORE the fast-mode 429 fallback, otherwise fast mode retries/cooldowns a
    // quota-exhausted subscription instead of surfacing the quota message.
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai', { forceFastMode: true })
    const error = APIError.generate(
      429,
      undefined,
      JSON.stringify({
        error: { type: 'GoUsageLimitError', message: 'subscription limit reached' },
      }),
      new Headers({
        'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages',
      }),
    )
    let attempts = 0

    let caught: unknown
    try {
      await drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async () => {
            attempts++
            throw error
          },
          {
            maxRetries: 2,
            model: 'glm-5.1',
            thinkingConfig: { type: 'disabled' },
            fastMode: true,
          },
        ),
      )
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(CannotRetryError)
    // Fired exactly once — fast mode did not retry or enter cooldown.
    expect(attempts).toBe(1)
    expect((caught as { originalError?: unknown }).originalError).toBe(error)
  })

  test('keeps parseable 402 affordability errors on the max_tokens retry path', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { withRetry } = await importFreshWithRetryModule('openai')
    const error = APIError.generate(
      402,
      undefined,
      'OpenAI API error 402: Payment Required [openai_category=unknown,host=openrouter.ai] ' +
        'This request requires more credits, or fewer max_tokens. ' +
        'You requested up to 32000 tokens, but can only afford 27342. To increase, visit ...',
      new Headers(),
    )
    const originalConsoleError = console.error
    const consoleError = mock(() => {})
    const observedMaxTokensOverrides: Array<number | undefined> = []
    let attempts = 0

    console.error = consoleError
    try {
      const result = await drainAsyncGenerator(
        withRetry(
          async () => ({} as Anthropic),
          async (_client, _attempt, context) => {
            attempts++
            observedMaxTokensOverrides.push(context.maxTokensOverride)
            if (attempts === 1) throw error
            return { ok: true }
          },
          {
            maxRetries: 2,
            model: 'openrouter/test-model',
            thinkingConfig: { type: 'disabled' },
          },
        ),
      )

      expect(result).toEqual({ ok: true })
    } finally {
      console.error = originalConsoleError
    }

    expect(attempts).toBe(2)
    expect(observedMaxTokensOverrides).toEqual([undefined, 27342])
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  test('does not keep retrying repeated 402 affordability errors after one max_tokens adjustment', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { CannotRetryError, withRetry } =
      await importFreshWithRetryModule('openai')
    const error = APIError.generate(
      402,
      undefined,
      'OpenAI API error 402: Payment Required [openai_category=unknown,host=openrouter.ai] ' +
        'This request requires more credits, or fewer max_tokens. ' +
        'You requested up to 32000 tokens, but can only afford 27342. To increase, visit ...',
      new Headers(),
    )
    const originalConsoleError = console.error
    const consoleError = mock(() => {})
    let attempts = 0

    console.error = consoleError
    try {
      await expect(
        drainAsyncGenerator(
          withRetry(
            async () => ({} as Anthropic),
            async () => {
              attempts++
              throw error
            },
            {
              maxRetries: 2,
              model: 'openrouter/test-model',
              thinkingConfig: { type: 'disabled' },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(CannotRetryError)
    } finally {
      console.error = originalConsoleError
    }

    expect(attempts).toBe(2)
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  test('keeps parseable marked context-overflow errors on the max_tokens retry path', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    const { withRetry } = await importFreshWithRetryModule('openai')
    const error = APIError.generate(
      400,
      undefined,
      'OpenAI API error 400: Bad Request [openai_category=context_overflow,host=api.z.ai] ' +
        'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
      new Headers(),
    )
    const observedMaxTokensOverrides: Array<number | undefined> = []
    let attempts = 0

    const result = await drainAsyncGenerator(
      withRetry(
        async () => ({} as Anthropic),
        async (_client, _attempt, context) => {
          attempts++
          observedMaxTokensOverrides.push(context.maxTokensOverride)
          if (attempts === 1) throw error
          return { ok: true }
        },
        {
          maxRetries: 2,
          model: 'glm-5.1',
          thinkingConfig: { type: 'disabled' },
        },
      ),
    )

    expect(result).toEqual({ ok: true })
    expect(attempts).toBe(2)
    expect(observedMaxTokensOverrides).toEqual([undefined, 10941])
  })
})

// --- parseOpenAIDuration ---
describe('parseOpenAIDuration', () => {
  test('parses seconds: "1s" → 1000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1s')).toBe(1000)
  })

  test('parses minutes+seconds: "6m0s" → 360000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('6m0s')).toBe(360000)
  })

  test('parses hours+minutes+seconds: "1h30m0s" → 5400000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1h30m0s')).toBe(5400000)
  })

  test('parses milliseconds: "500ms" → 500', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('500ms')).toBe(500)
  })

  test('parses minutes only: "2m" → 120000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('2m')).toBe(120000)
  })

  test('returns null for empty string', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('')).toBeNull()
  })

  test('returns null for unrecognized format', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('invalid')).toBeNull()
  })
})

// --- getRateLimitResetDelayMs ---
describe('getRateLimitResetDelayMs - Anthropic (firstParty)', () => {
  test('reads anthropic-ratelimit-unified-reset Unix timestamp', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const futureUnixSec = Math.floor(Date.now() / 1000) + 60
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(futureUnixSec),
    })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).not.toBeNull()
    expect(delay!).toBeGreaterThan(50_000)
    expect(delay!).toBeLessThanOrEqual(60_000)
  })

  test('returns null when header absent', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null when reset is in the past', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const pastUnixSec = Math.floor(Date.now() / 1000) - 10
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(pastUnixSec),
    })
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

describe('getRateLimitResetDelayMs - OpenAI provider', () => {
  test('reads x-ratelimit-reset-requests duration string', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({ 'x-ratelimit-reset-requests': '30s' })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(30_000)
  })

  test('reads x-ratelimit-reset-tokens and picks the larger delay', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '1m0s',
    })
    // Should use the larger of the two so we don't retry before both reset
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(60_000)
  })

  test('returns null when no openai rate limit headers present', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('works for github provider too', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('github')
    const error = makeError({ 'x-ratelimit-reset-requests': '5s' })
    expect(getRateLimitResetDelayMs(error)).toBe(5_000)
  })
})

describe('getRateLimitResetDelayMs - providers without reset headers', () => {
  test('returns null for bedrock', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('bedrock')
    const error = makeError({ 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 60) })
    // Bedrock doesn't use this header — should still return null
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null for vertex', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('vertex')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

// Regression for #1125 — OpenRouter 402 (credits-vs-max_tokens mismatch)
// carries the affordable cap in the message. The retry loop should adjust
// max_tokens to that cap once instead of bubbling a confusing 402 to the user.
describe('parseOpenRouterAffordableMaxTokensError (#1125)', () => {
  function make402(message: string): APIError {
    return {
      headers: new Headers(),
      status: 402,
      message,
      name: 'APIError',
      error: {},
    } as unknown as APIError
  }

  test('parses the affordable max_tokens out of OpenRouter 402 body', async () => {
    const { parseOpenRouterAffordableMaxTokensError } =
      await importFreshWithRetryModule('openai')
    const err = make402(
      'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 27342. To increase, visit ...',
    )
    expect(parseOpenRouterAffordableMaxTokensError(err)).toEqual({
      requestedMaxTokens: 32000,
      affordableMaxTokens: 27342,
    })
  })

  test('returns undefined when status is not 402', async () => {
    const { parseOpenRouterAffordableMaxTokensError } =
      await importFreshWithRetryModule('openai')
    const err = {
      headers: new Headers(),
      status: 429,
      message: 'You requested up to 32000 tokens, but can only afford 27342',
      name: 'APIError',
      error: {},
    } as unknown as APIError
    expect(parseOpenRouterAffordableMaxTokensError(err)).toBeUndefined()
  })

  test('returns undefined when message does not match expected shape', async () => {
    const { parseOpenRouterAffordableMaxTokensError } =
      await importFreshWithRetryModule('openai')
    const err = make402('Payment required. Top up your account.')
    expect(parseOpenRouterAffordableMaxTokensError(err)).toBeUndefined()
  })

  test('returns undefined when affordable_max_tokens is zero', async () => {
    const { parseOpenRouterAffordableMaxTokensError } =
      await importFreshWithRetryModule('openai')
    const err = make402(
      'You requested up to 32000 tokens, but can only afford 0',
    )
    expect(parseOpenRouterAffordableMaxTokensError(err)).toBeUndefined()
  })

  test('shouldRetry returns true for parseable 402', async () => {
    const { shouldRetry } = (await importFreshWithRetryModule('openai')) as {
      shouldRetry?: (e: APIError) => boolean
    }
    if (!shouldRetry) return // shouldRetry is internal; skip when not exported
    const err = make402(
      'You requested up to 32000 tokens, but can only afford 27342',
    )
    expect(shouldRetry(err)).toBe(true)
  })
})

describe('persistent retry cap', () => {
  test('persistent retries stop after 100 retryable 429s', async () => {
    // Drive the real persistent retry gate — no runtime override. The
    // UNATTENDED_RETRY feature must be enabled via `bun test --feature=UNATTENDED_RETRY`
    // (see package.json), and the env var must be truthy, otherwise
    // isPersistentRetryEnabled() returns false and the cap never triggers.
    process.env.CLAUDE_CODE_UNATTENDED_RETRY = '1'
    const retryModule = await importFreshWithRetryModule('firstParty')
        const { CannotRetryError, withRetry, _PERSISTENT_MAX_ATTEMPTS_FOR_TEST, isPersistentRetryEnabled } = retryModule
    expect(_PERSISTENT_MAX_ATTEMPTS_FOR_TEST).toBe(100)

    const retryableRateLimit = makeError({ 'retry-after': '1' })
            const operation = mock(async () => {
      throw retryableRateLimit
    })

            const runRetries = async () => {
      for await (const _ of withRetry(
        async () => ({} as never),
        operation,
        {
          maxRetries: 0,
          model: 'claude-sonnet-4-6',
          thinkingConfig: { type: 'disabled' },
        },
      )) {
        void _
      }
    }

    await expect(runRetries()).rejects.toBeInstanceOf(CannotRetryError)
    // isPersistentRetryEnabled() checks the real Bun compile-time feature gate.
    // Without --feature=UNATTENDED_RETRY, it returns false and only 1 call is made.
    // With the flag and CLAUDE_CODE_UNATTENDED_RETRY=1, the cap triggers after 101 calls.
    const expectedCalls = isPersistentRetryEnabled() ? 101 : 1
    expect(operation).toHaveBeenCalledTimes(expectedCalls)
  })
})

describe('usage-limit account switch', () => {
  type AccountSummary = import('../../utils/authAccounts.js').AccountSummary

  // The accounts map the mocked accountSwitch module serves. Mutable so a
  // "switch" can move the active marker, exactly like the real storage
  // write does.
  let accounts: AccountSummary[]
  const events: string[] = []
  const notices: { switchedAccountTo?: string; resumeAtMs?: number }[] = []

  async function importWithAccountSwitch(
    provider: 'firstParty' | 'openai' = 'firstParty',
  ) {
    const retryModule = await importFreshWithRetryModule(provider)
    originalAccountSwitchModule ??= await importActualAccountSwitch()
    mock.module('src/utils/accountSwitch.js', () => ({
      ...originalAccountSwitchModule!,
      readAccounts: () => accounts,
      // The guard reads vouchability through this module too, so the mock has
      // to serve it from the SAME fixture. Left to the real implementation it
      // reads the machine's actual store, which can never contain these
      // fixture keys, and every candidate is filtered out — auto-switching
      // silently stops instead of being tested.
      readVouchableAccountKeys: () => new Set(accounts.map(entry => entry.key)),
      switchAccount: async (key: string) => {
        events.push(`switch:${key}`)
        accounts = accounts.map(account => ({
          ...account,
          isActive: account.key === key,
        }))
        return { success: true }
      },
    }))
    const switchModule = await import('./usageLimitSwitch.js')
    switchModule.clearAccountSwitchEffects()
    switchModule.registerAccountSwitchEffects(() => events.push('effects'))
    return { retryModule, switchModule }
  }

  afterEach(async () => {
    events.length = 0
    notices.length = 0
    // A successful switch leaves a breadcrumb in errors.js so a 401 seconds
    // later can say the account was not the user's choice. It outlives the
    // test that caused it — the TTL is 60s — and the next describe's first
    // test has not run its own afterEach yet, so the describe that sets it is
    // the one that has to clear it. Latent until a test here actually
    // switched; every "does not switch" case left it clean by accident.
    const errors = await import('./errors.js')
    errors.clearUsageLimitAccountSwitch()
  })

  async function runWithRetry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withRetry: any,
    operation: () => Promise<string>,
    overrides: Record<string, unknown> = {},
  ): Promise<{ result: unknown; threw: unknown }> {
    const generator = withRetry(
      async () => ({}) as never,
      operation,
      {
        maxRetries: 2,
        model: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' },
        querySource: 'repl_main_thread',
        signal: new AbortController().signal,
        ...overrides,
      } as never,
    )
    try {
      while (true) {
        const step = await generator.next()
        if (step.done) return { result: step.value, threw: null }
        if (step.value?.subtype === 'api_error') notices.push(step.value)
      }
    } catch (error) {
      return { result: null, threw: error }
    }
  }

  test('switches to the other account, fires session effects, and retries the in-flight request', async () => {
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
    ]
    const { retryModule } = await importWithAccountSwitch()
    const { withRetry } = retryModule

    let calls = 0
    const operation = mock(async () => {
      calls++
      events.push(`operation:${calls}`)
      if (calls === 1) throw makeError({})
      return 'recovered'
    })

    const { result, threw } = await runWithRetry(withRetry, operation as never)
    expect(threw).toBeNull()
    expect(result).toBe('recovered')
    // The request retried and completed under the new account.
    expect(calls).toBe(2)
    // Credential write first, session effects immediately after, then the
    // retried operation — the two halves of the switch stay together.
    expect(events).toEqual([
      'operation:1',
      'switch:b',
      'effects',
      'operation:2',
    ])
    // Exactly one notice for the whole switch, naming the account.
    expect(notices).toHaveLength(1)
    expect(notices[0].switchedAccountTo).toBe('b@example.com')
  })

  test('all accounts exhausted: each is tried once, never revisited, then the error surfaces', async () => {
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
      { key: 'c', emailAddress: 'c@example.com', isActive: false },
    ]
    const { retryModule } = await importWithAccountSwitch()
    const { withRetry, CannotRetryError } = retryModule

    const operation = mock(async () => {
      throw makeError({})
    })
    const { threw } = await runWithRetry(withRetry, operation as never)
    expect(threw).toBeInstanceOf(CannotRetryError)
    // a is never switched to (it started active), b and c exactly once each,
    // across every subsequent 429 — the bound.
    expect(events.filter(e => e.startsWith('switch:'))).toEqual([
      'switch:b',
      'switch:c',
    ])
    expect(events.filter(e => e === 'effects')).toHaveLength(2)
    // One notice per switch, no more once the map is exhausted.
    expect(
      notices.map(notice => notice.switchedAccountTo),
    ).toEqual(['b@example.com', 'c@example.com'])
  })

  test('falls through to the auto-wait once every account is exhausted', async () => {
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
    ]
    const { retryModule } = await importWithAccountSwitch()
    const { withRetry } = retryModule

    const resetAt = Math.floor(Date.now() / 1000) + 60
    let calls = 0
    const operation = mock(async () => {
      calls++
      if (calls <= 2) {
        throw makeError({
          'anthropic-ratelimit-unified-reset': String(resetAt),
        })
      }
      return 'recovered'
    })
    const { result, threw } = await runWithRetry(withRetry, operation as never)
    expect(threw).toBeNull()
    expect(result).toBe('recovered')
    // a→b switch first; b's 429 has no candidate left, so the wait takes
    // over with its own single notice.
    expect(events).toEqual(['switch:b', 'effects'])
    expect(notices).toHaveLength(2)
    expect(notices[0].switchedAccountTo).toBe('b@example.com')
    expect(notices[1].resumeAtMs).toBeDefined()
    expect(notices[1].switchedAccountTo).toBeUndefined()
  })

  test('suspends the query watchdog for exactly the auto-wait, and resumes it once', async () => {
    // Regression: the wait yields one notice and then sleeps for the whole delay,
    // so the lead's QueryGuard saw no activity and aborted the query as idle
    // after five minutes ("Query timed out before completion") long before the
    // resume time.
    accounts = [{ key: 'a', emailAddress: 'a@example.com', isActive: true }]
    const { retryModule } = await importWithAccountSwitch()
    const { withRetry } = retryModule

    const watchdog: string[] = []
    const queryActivity = {
      beginUserInteraction: () => {
        watchdog.push('suspend')
        return () => {
          watchdog.push('resume')
        }
      },
    }
    const resetAt = Math.floor(Date.now() / 1000) + 60
    let calls = 0
    const operation = mock(async () => {
      calls++
      if (calls === 1) {
        throw makeError({
          'anthropic-ratelimit-unified-reset': String(resetAt),
        })
      }
      watchdog.push('retried')
      return 'recovered'
    })

    const { result, threw } = await runWithRetry(withRetry, operation as never, {
      queryActivity,
    })

    expect(threw).toBeNull()
    expect(result).toBe('recovered')
    expect(notices).toHaveLength(1)
    expect(notices[0].resumeAtMs).toBeDefined()
    // Suspended for the wait, resumed before the retried request runs.
    expect(watchdog).toEqual(['suspend', 'resume', 'retried'])
  })

  test('switches for a teammate query source, and still never sleeps for one', async () => {
    // Both halves of the gate split in one run, because the two are only
    // correct together. A teammate used to share the wait's allowlist and so
    // had NO recovery at all; it now takes the instant remedy and is still
    // refused the multi-hour one, which would hold its claimed task hostage.
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
    ]
    const { retryModule } = await importWithAccountSwitch()
    const { withRetry } = retryModule

    // A reset header IS present, so the only thing keeping the teammate off
    // the wait is the wait's own source gate — not a missing reset clock.
    const resetAt = Math.floor(Date.now() / 1000) + 60
    const operation = mock(async () => {
      throw makeError({ 'anthropic-ratelimit-unified-reset': String(resetAt) })
    })
    await runWithRetry(withRetry, operation as never, {
      querySource: 'agent:custom',
    })
    // Switched: the credential write and its session effects, in that order.
    expect(events).toEqual(['switch:b', 'effects'])
    // Did not sleep: exactly one notice, and it names the switch. A wait would
    // have added a second carrying `resumeAtMs` once `b` ran out too.
    expect(notices).toHaveLength(1)
    expect(notices[0].switchedAccountTo).toBe('b@example.com')
    expect(notices[0].resumeAtMs).toBeUndefined()
  })

  test('never switches on a non-Anthropic route, even with Claude accounts stored', async () => {
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
    ]
    const { retryModule } = await importWithAccountSwitch('openai')
    const { withRetry } = retryModule

    const operation = mock(async () => {
      throw makeError({})
    })
    await runWithRetry(withRetry, operation as never)
    // Claude→Claude only: a GLM/OpenAI-compatible 429 must not touch the
    // Claude accounts map.
    expect(events).toEqual([])
    expect(notices).toEqual([])
  })

  test('does not switch when no session-effects hook is registered (SDK host)', async () => {
    accounts = [
      { key: 'a', emailAddress: 'a@example.com', isActive: true },
      { key: 'b', emailAddress: 'b@example.com', isActive: false },
    ]
    const { retryModule, switchModule } = await importWithAccountSwitch()
    switchModule.clearAccountSwitchEffects()
    const { withRetry } = retryModule

    const operation = mock(async () => {
      throw makeError({})
    })
    await runWithRetry(withRetry, operation as never)
    // Storage-only switching is refused outright.
    expect(events).toEqual([])
    expect(notices).toEqual([])
  })
})

describe('revoked OAuth grant is terminal', () => {
  // The body the gateway actually returned. Its shape is the whole point:
  // status 401 (not 403) and the word "access" inside the message, which is
  // what the old 403-only substring predicate missed on both counts.
  const REVOKED_401_BODY =
    '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}'

  function revoked401(): APIError {
    return new APIError(
      401,
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'OAuth access token has been revoked.',
        },
      },
      REVOKED_401_BODY,
      new Headers(),
    )
  }

  function expired401(): APIError {
    return new APIError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'OAuth token expired' },
      },
      '{"type":"error","error":{"type":"authentication_error","message":"OAuth token expired"}}',
      new Headers(),
    )
  }

  function runOptions(overrides: Record<string, unknown> = {}) {
    return {
      maxRetries: 10,
      model: 'claude-sonnet-4-6',
      thinkingConfig: { type: 'disabled' },
      querySource: 'repl_main_thread',
      ...overrides,
    }
  }

  test('a revoked 401 stops on the first response: one attempt, no refresh', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    // Fails the test loudly if the terminal path ever reaches the refresh:
    // an unrefreshable grant must not be re-presented to the auth server.
    const handleOAuth401Error = mock(async () => false)
    const { withRetry, CannotRetryError } = await importFreshWithRetryModule(
      'firstParty',
      {
        auth: {
          handleOAuth401Error,
          getClaudeAIOAuthTokens: () => ({
            accessToken: 'mock-access-token-not-a-real-credential',
          }),
        },
      },
    )

    const operation = mock(async () => {
      throw revoked401()
    })

    await expect(
      drainAsyncGenerator(
        withRetry(async () => ({}) as Anthropic, operation, runOptions()),
      ),
    ).rejects.toBeInstanceOf(CannotRetryError)

    // The whole point of the fix: not "fewer than 10" — exactly one. maxRetries
    // is 10, so the pre-fix behaviour would be 11 calls across ~8.5 minutes of
    // exponential backoff (500ms * 2^(n-1), capped at 32s).
    expect(operation).toHaveBeenCalledTimes(1)
    expect(handleOAuth401Error).toHaveBeenCalledTimes(0)
  })

  test('an expired-but-refreshable 401 still refreshes and retries', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    // The regression the narrow fix exists to protect: a merely expired token
    // must keep its refresh-once-and-retry behaviour.
    const handleOAuth401Error = mock(async () => true)
    const { withRetry } = await importFreshWithRetryModule('firstParty', {
      auth: {
        handleOAuth401Error,
        getClaudeAIOAuthTokens: () => ({
          accessToken: 'mock-access-token-not-a-real-credential',
        }),
      },
    })

    let calls = 0
    const operation = mock(async () => {
      calls++
      if (calls === 1) throw expired401()
      return { ok: true }
    })

    const result = await drainAsyncGenerator(
      withRetry(async () => ({}) as Anthropic, operation, runOptions()),
    )

    expect(result).toEqual({ ok: true })
    expect(operation).toHaveBeenCalledTimes(2)
    expect(handleOAuth401Error).toHaveBeenCalledTimes(1)
  })

  test('a 401 whose forced refresh fails is terminal without a second request', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    // The secondary signal: the message shape is unremarkable, but the refresh
    // came back false, so the grant cannot produce a working token.
    const handleOAuth401Error = mock(async () => false)
    const { withRetry, CannotRetryError } = await importFreshWithRetryModule(
      'firstParty',
      {
        auth: {
          handleOAuth401Error,
          getClaudeAIOAuthTokens: () => ({
            accessToken: 'mock-access-token-not-a-real-credential',
          }),
        },
      },
    )

    const operation = mock(async () => {
      throw expired401()
    })

    await expect(
      drainAsyncGenerator(
        withRetry(async () => ({}) as Anthropic, operation, runOptions()),
      ),
    ).rejects.toBeInstanceOf(CannotRetryError)

    // One failed refresh, and the request is not re-issued against the dead
    // grant: the second attempt stops before the operation runs.
    expect(handleOAuth401Error).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('transient failures are untouched: a network error still retries', async () => {
    process.env.OPENCLAUDE_RETRY_DELAY_MS = '1'
    // The APIConnectionError branch had no coverage at all, so the "transient
    // paths unchanged" claim had nothing to rest on for the network case.
    const { withRetry } = await importFreshWithRetryModule('firstParty')

    let calls = 0
    const operation = mock(async () => {
      calls++
      if (calls === 1) {
        throw new APIConnectionError({ message: 'Connection error.' })
      }
      return { ok: true }
    })

    const result = await drainAsyncGenerator(
      withRetry(async () => ({}) as Anthropic, operation, runOptions()),
    )

    expect(result).toEqual({ ok: true })
    expect(operation).toHaveBeenCalledTimes(2)
  })
})

describe('revoked-grant user-facing message', () => {
  // The rendered string is an acceptance criterion in its own right: it must
  // name the remedy, identify the account, explain a switch the user never
  // made, and never carry an email address.
  const EMAIL_PATTERN = /[^\s"']+@[^\s"']+\.[^\s"']+/

  async function importErrorsModule() {
    return import('./errors.js')
  }

  afterEach(async () => {
    const errors = await importErrorsModule()
    errors.clearUsageLimitAccountSwitch()
  })

  test('plain revocation keeps the existing wording in both session modes', async () => {
    const errors = await importErrorsModule()
    const state = await import('../../bootstrap/state.js')
    const wasInteractive = state.getIsInteractive()
    try {
      state.setIsInteractive(true)
      expect(errors.getTokenRevokedErrorMessage()).toBe(
        errors.TOKEN_REVOKED_ERROR_MESSAGE,
      )
      state.setIsInteractive(false)
      expect(errors.getTokenRevokedErrorMessage()).toBe(
        'Your account does not have access to Claude. Please login again or contact your administrator.',
      )
    } finally {
      state.setIsInteractive(wasInteractive)
    }
  })

  test('after a usage-limit auto-switch the message explains the move and names the remedy', async () => {
    const errors = await importErrorsModule()
    const state = await import('../../bootstrap/state.js')
    const wasInteractive = state.getIsInteractive()
    try {
      state.setIsInteractive(true)
      // The account the auto-switch actually landed on: the legacy,
      // identity-less entry whose key is literally `default`.
      errors.noteUsageLimitAccountSwitch('default')
      const message = errors.getTokenRevokedErrorMessage()

      expect(message).toBe(
        'OAuth token revoked · This session was switched to account "default" automatically after the previous account hit its usage limit, and that account\'s saved credentials have been revoked · Run /login to re-authenticate it, or /account to switch to a different account',
      )
      // Reads sensibly for a nameless account, and still carries all three
      // facts: the automatic move, the dead credentials, the remedy.
      expect(message).toContain('"default"')
      expect(message).toContain('automatically')
      expect(message).toContain('/login')

      state.setIsInteractive(false)
      expect(errors.getTokenRevokedErrorMessage()).toContain(
        'contact your administrator',
      )
    } finally {
      state.setIsInteractive(wasInteractive)
    }
  })

  test('no email address reaches the message, whatever the account key holds', async () => {
    const errors = await importErrorsModule()
    const state = await import('../../bootstrap/state.js')
    const wasInteractive = state.getIsInteractive()
    try {
      state.setIsInteractive(true)
      for (const key of [
        'default',
        '9f3c1a2b-77de-4a10-9c31-2f0e5b8a6d44',
        'person.name@example.com',
      ]) {
        errors.noteUsageLimitAccountSwitch(key)
        const message = errors.getTokenRevokedErrorMessage()
        expect(message).not.toMatch(EMAIL_PATTERN)
        state.setIsInteractive(false)
        expect(errors.getTokenRevokedErrorMessage()).not.toMatch(EMAIL_PATTERN)
        state.setIsInteractive(true)
      }
      // A UUID key is truncated rather than printed whole.
      errors.noteUsageLimitAccountSwitch('9f3c1a2b-77de-4a10-9c31-2f0e5b8a6d44')
      expect(errors.getTokenRevokedErrorMessage()).toContain('"9f3c1a2b…"')
    } finally {
      state.setIsInteractive(wasInteractive)
    }
  })

  test('the breadcrumb is cleared once a request succeeds under the new account', async () => {
    const errors = await importErrorsModule()
    errors.noteUsageLimitAccountSwitch('default')
    errors.clearUsageLimitAccountSwitch()
    const state = await import('../../bootstrap/state.js')
    const wasInteractive = state.getIsInteractive()
    try {
      state.setIsInteractive(true)
      expect(errors.getTokenRevokedErrorMessage()).toBe(
        errors.TOKEN_REVOKED_ERROR_MESSAGE,
      )
    } finally {
      state.setIsInteractive(wasInteractive)
    }
  })
})

describe('isOAuthGrantRevokedError', () => {
  test('matches both spellings on both statuses, and nothing unrelated', async () => {
    const { isOAuthGrantRevokedError, isOAuthGrantRevokedMessage } =
      await import('./errors.js')

    const make = (status: number, message: string) =>
      new APIError(status, undefined, message, new Headers())

    // The observed failure, and the legacy 403 the old predicate caught.
    expect(
      isOAuthGrantRevokedError(
        make(401, 'OAuth access token has been revoked.'),
      ),
    ).toBe(true)
    expect(
      isOAuthGrantRevokedError(make(403, 'OAuth token has been revoked')),
    ).toBe(true)
    expect(
      isOAuthGrantRevokedError(make(401, 'OAuth token has been revoked')),
    ).toBe(true)

    // Not every 401 is a revocation — that is the over-correction the narrow
    // predicate exists to avoid.
    expect(isOAuthGrantRevokedError(make(401, 'Unauthorized'))).toBe(false)
    // Adjacent OAuth failures are classified elsewhere and must not be eaten.
    expect(
      isOAuthGrantRevokedError(
        make(
          401,
          'OAuth authentication is currently not allowed for this organization',
        ),
      ),
    ).toBe(false)
    // Right message, wrong status: still not this error.
    expect(
      isOAuthGrantRevokedError(make(500, 'OAuth token has been revoked')),
    ).toBe(false)
    expect(isOAuthGrantRevokedError(new Error('OAuth token has been revoked'))).toBe(
      false,
    )

    // The message half is what http.ts and fastMode.ts adopt; it must stay
    // usable on a raw response body with no status in hand.
    expect(isOAuthGrantRevokedMessage('OAuth token has been revoked')).toBe(true)
    expect(isOAuthGrantRevokedMessage('OAuth access token has been revoked.')).toBe(
      true,
    )
    expect(isOAuthGrantRevokedMessage(undefined)).toBe(false)
    expect(isOAuthGrantRevokedMessage('some other oauth failure')).toBe(false)
  })
})

describe('revoked-grant message survives on screen', () => {
  // AMEND-3 / F2b: the api_error slot is transient — messages.ts replaces a
  // trailing api_error in place and keeps only the last one, so the "switching
  // to default" notice lived 537-705ms. The wording therefore has to ride the
  // PERSISTENT assistant message that getAssistantMessageFromError builds, and
  // the terminal 401 has to actually reach that renderer. This pins the whole
  // chain rather than asserting it.
  //
  // The config home is redirected to a throwaway temp dir for the duration, so
  // the credential reads on the way to the revoked branch (isClaudeAISubscriber,
  // getOauthAccountInfo) resolve against an empty store and never touch the
  // user's real accounts.
  let tempDir: string

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { setClaudeConfigHomeDirForTesting } = await import(
      '../../utils/envUtils.js'
    )
    const { clearOAuthTokenCache } = await import('../../utils/auth.js')
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-revoked-grant-test-'))
    setClaudeConfigHomeDirForTesting(tempDir)
    clearOAuthTokenCache()
  })

  afterEach(async () => {
    const { rmSync } = await import('node:fs')
    const { setClaudeConfigHomeDirForTesting } = await import(
      '../../utils/envUtils.js'
    )
    const { clearOAuthTokenCache } = await import('../../utils/auth.js')
    const errors = await import('./errors.js')
    errors.clearUsageLimitAccountSwitch()
    setClaudeConfigHomeDirForTesting(undefined)
    clearOAuthTokenCache()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  function firstText(message: { message: { content: unknown } }): string {
    const content = message.message.content
    const first = Array.isArray(content) ? content[0] : undefined
    if (!first || typeof first !== 'object' || !('text' in first)) return ''
    const { text } = first as { text?: unknown }
    return typeof text === 'string' ? text : ''
  }

  function revoked401(): APIError {
    return new APIError(
      401,
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'OAuth access token has been revoked.',
        },
      },
      '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
      new Headers(),
    )
  }

  test('the terminal 401 renders the persistent revoked message, not the generic auth error', async () => {
    const errors = await import('./errors.js')
    const state = await import('../../bootstrap/state.js')
    const wasInteractive = state.getIsInteractive()
    try {
      state.setIsInteractive(true)
      errors.noteUsageLimitAccountSwitch('default')

      const message = errors.getAssistantMessageFromError(
        revoked401(),
        'claude-sonnet-4-6',
      )
      const text = firstText(message)

      expect(message.isApiErrorMessage).toBe(true)
      expect(text).toBe(errors.getTokenRevokedErrorMessage())
      expect(text).toBe(
        'OAuth token revoked · This session was switched to account "default" automatically after the previous account hit its usage limit, and that account\'s saved credentials have been revoked · Run /login to re-authenticate it, or /account to switch to a different account',
      )
      // The terminus the chain used to land on: the generic 401 branch, which
      // says nothing about the account or the automatic switch.
      expect(text).not.toContain('Authentication failed (status 401)')
    } finally {
      state.setIsInteractive(wasInteractive)
    }
  })

  test('the revoked 401 classifies as token_revoked rather than auth_error', async () => {
    const { classifyAPIError } = await import('./errors.js')
    expect(classifyAPIError(revoked401())).toBe('token_revoked')
  })

  test('a CannotRetryError unwraps to the original error the renderer classifies', async () => {
    // claude.ts:3397 unwraps CannotRetryError.originalError before calling
    // getAssistantMessageFromError. If that ever stops happening the message
    // silently degrades to the generic branch, so pin the property here.
    const { withRetry, CannotRetryError } = await importFreshWithRetryModule(
      'firstParty',
      {
        auth: {
          handleOAuth401Error: async () => false,
          getClaudeAIOAuthTokens: () => ({
            accessToken: 'mock-access-token-not-a-real-credential',
          }),
        },
      },
    )
    const errors = await import('./errors.js')

    let thrown: unknown
    try {
      await drainAsyncGenerator(
        withRetry(
          async () => ({}) as Anthropic,
          async () => {
            throw revoked401()
          },
          {
            maxRetries: 10,
            model: 'claude-sonnet-4-6',
            thinkingConfig: { type: 'disabled' },
            querySource: 'repl_main_thread',
          },
        ),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    const original = (thrown as InstanceType<typeof CannotRetryError>)
      .originalError
    expect(errors.isOAuthGrantRevokedError(original)).toBe(true)
    expect(errors.classifyAPIError(original)).toBe('token_revoked')
  })
})
