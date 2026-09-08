import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realAuth from '../auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { pickNewestOpusModel } from './latestOpusModel.js'
import * as realProviders from './providers.js'

const KILL_SWITCH = 'OPENCLAUDE_DISABLE_LATEST_OPUS_RESOLUTION'

function clearCachedOpus(): void {
  saveGlobalConfig(current => ({
    ...current,
    latestOpusModelId: undefined,
    latestOpusModelCheckedAt: undefined,
  }))
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/latestOpusModel.test.ts')
  clearCachedOpus()
})

afterEach(() => {
  try {
    mock.restore()
    delete process.env[KILL_SWITCH]
    clearCachedOpus()
  } finally {
    releaseSharedMutationLock()
  }
})

type FreshOptions = {
  provider?: string
  firstPartyBaseUrl?: boolean
  apiKey?: string | null
  oauthToken?: string | null
  models?: unknown[]
  failRequest?: boolean
}

async function importFresh(opts: FreshOptions = {}) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => opts.provider ?? 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => opts.firstPartyBaseUrl ?? true,
  }))
  mock.module('../auth.js', () => ({
    ...realAuth,
    getAnthropicApiKey: () =>
      opts.apiKey === undefined ? 'sk-ant-test' : opts.apiKey,
    getClaudeAIOAuthTokens: () =>
      opts.oauthToken ? { accessToken: opts.oauthToken } : null,
  }))
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  mock.module('axios', () => ({
    default: {
      get: async (url: string, config: { headers: Record<string, string> }) => {
        requests.push({ url, headers: config.headers })
        if (opts.failRequest) {
          throw new Error('boom')
        }
        return { data: { data: opts.models ?? [] } }
      },
      isAxiosError: () => false,
    },
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const mod = (await import(
    `./latestOpusModel.js?ts=${nonce}`
  )) as typeof import('./latestOpusModel.js')
  return { mod, requests }
}

const MODELS = [
  { id: 'claude-sonnet-5', created_at: '2026-09-01T00:00:00Z' },
  { id: 'claude-opus-4-8', created_at: '2026-06-15T00:00:00Z' },
  { id: 'claude-opus-5', created_at: '2026-08-20T00:00:00Z' },
  { id: 'claude-opus-4-7', created_at: '2026-03-01T00:00:00Z' },
  { id: 'claude-3-opus-20240229', created_at: '2024-02-29T00:00:00Z' },
]

describe('pickNewestOpusModel', () => {
  test('returns the newest claude-opus id by created_at', () => {
    expect(pickNewestOpusModel(MODELS)).toBe('claude-opus-5')
  })

  test('ignores non-Opus ids and ids without a parseable version', () => {
    expect(
      pickNewestOpusModel([
        { id: 'claude-sonnet-5', created_at: '2027-01-01T00:00:00Z' },
        { id: 'claude-3-opus-20240229', created_at: '2027-01-01T00:00:00Z' },
        { id: 'claude-opus-latest', created_at: '2027-01-01T00:00:00Z' },
        { id: 'claude-opus-4-6', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe('claude-opus-4-6')
  })

  test('breaks created_at ties by version, then prefers the undated id', () => {
    expect(
      pickNewestOpusModel([
        { id: 'claude-opus-4-8', created_at: '2026-06-15T00:00:00Z' },
        { id: 'claude-opus-5', created_at: '2026-06-15T00:00:00Z' },
      ]),
    ).toBe('claude-opus-5')
    expect(
      pickNewestOpusModel([
        { id: 'claude-opus-5-20260820', created_at: '2026-08-20T00:00:00Z' },
        { id: 'claude-opus-5', created_at: '2026-08-20T00:00:00Z' },
      ]),
    ).toBe('claude-opus-5')
  })

  test('tolerates missing or malformed created_at and empty lists', () => {
    expect(pickNewestOpusModel([])).toBeUndefined()
    expect(pickNewestOpusModel([{ id: 'claude-opus-5' }])).toBe('claude-opus-5')
    expect(
      pickNewestOpusModel([
        { id: 'claude-opus-5', created_at: 'not-a-date' },
        { id: 'claude-opus-4-8', created_at: '2026-06-15T00:00:00Z' },
      ]),
    ).toBe('claude-opus-4-8')
    expect(pickNewestOpusModel([{ id: 42 }, {}])).toBeUndefined()
  })
})

describe('getResolvedLatestOpusModel', () => {
  test('returns the cached id for first-party sessions', async () => {
    saveGlobalConfig(current => ({ ...current, latestOpusModelId: 'claude-opus-5-1' }))
    const { mod } = await importFresh()
    expect(mod.getResolvedLatestOpusModel()).toBe('claude-opus-5-1')
  })

  test('returns undefined when nothing is cached', async () => {
    const { mod } = await importFresh()
    expect(mod.getResolvedLatestOpusModel()).toBeUndefined()
  })

  test('ignores cached values that are not claude-opus ids', async () => {
    saveGlobalConfig(current => ({ ...current, latestOpusModelId: 'gpt-5.6-sol' }))
    const { mod } = await importFresh()
    expect(mod.getResolvedLatestOpusModel()).toBeUndefined()
  })

  test('is disabled by the kill switch and off the first-party route', async () => {
    saveGlobalConfig(current => ({ ...current, latestOpusModelId: 'claude-opus-5-1' }))
    process.env[KILL_SWITCH] = '1'
    expect((await importFresh()).mod.getResolvedLatestOpusModel()).toBeUndefined()
    delete process.env[KILL_SWITCH]
    expect(
      (await importFresh({ provider: 'bedrock' })).mod.getResolvedLatestOpusModel(),
    ).toBeUndefined()
    expect(
      (await importFresh({ firstPartyBaseUrl: false })).mod.getResolvedLatestOpusModel(),
    ).toBeUndefined()
  })
})

describe('prefetchLatestOpusModel', () => {
  test('queries /v1/models with the API key and persists the newest Opus', async () => {
    const { mod, requests } = await importFresh({ models: MODELS })
    await mod.prefetchLatestOpusModel()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toMatch(/\/v1\/models\?limit=1000$/)
    expect(requests[0]!.headers['x-api-key']).toBe('sk-ant-test')
    expect(requests[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(getGlobalConfig().latestOpusModelId).toBe('claude-opus-5')
    expect(getGlobalConfig().latestOpusModelCheckedAt).toBeGreaterThan(0)
    // Nothing had been resolved for this session yet, so the fresh value is adopted.
    expect(mod.getResolvedLatestOpusModel()).toBe('claude-opus-5')
  })

  test('uses the OAuth bearer token with the oauth beta header when no key is set', async () => {
    const { mod, requests } = await importFresh({
      apiKey: null,
      oauthToken: 'oauth-token',
      models: MODELS,
    })
    await mod.prefetchLatestOpusModel()

    expect(requests[0]!.headers.Authorization).toBe('Bearer oauth-token')
    expect(requests[0]!.headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER)
    expect(requests[0]!.headers['x-api-key']).toBeUndefined()
  })

  test('persists for the next startup without changing an already-resolved session', async () => {
    saveGlobalConfig(current => ({ ...current, latestOpusModelId: 'claude-opus-4-8' }))
    const { mod } = await importFresh({ models: MODELS })
    expect(mod.getResolvedLatestOpusModel()).toBe('claude-opus-4-8')

    await mod.prefetchLatestOpusModel()

    expect(getGlobalConfig().latestOpusModelId).toBe('claude-opus-5')
    expect(mod.getResolvedLatestOpusModel()).toBe('claude-opus-4-8')
  })

  test('skips the network without credentials, when checked recently, or when disabled', async () => {
    const noCreds = await importFresh({ apiKey: null, oauthToken: null, models: MODELS })
    await noCreds.mod.prefetchLatestOpusModel()
    expect(noCreds.requests).toHaveLength(0)

    saveGlobalConfig(current => ({ ...current, latestOpusModelCheckedAt: Date.now() }))
    const recent = await importFresh({ models: MODELS })
    await recent.mod.prefetchLatestOpusModel()
    expect(recent.requests).toHaveLength(0)
    clearCachedOpus()

    process.env[KILL_SWITCH] = 'true'
    const disabled = await importFresh({ models: MODELS })
    await disabled.mod.prefetchLatestOpusModel()
    expect(disabled.requests).toHaveLength(0)
    delete process.env[KILL_SWITCH]

    const thirdParty = await importFresh({ provider: 'vertex', models: MODELS })
    await thirdParty.mod.prefetchLatestOpusModel()
    expect(thirdParty.requests).toHaveLength(0)
  })

  test('leaves the cache untouched on request failure or an empty list', async () => {
    saveGlobalConfig(current => ({ ...current, latestOpusModelId: 'claude-opus-4-8' }))
    const failing = await importFresh({ failRequest: true })
    await failing.mod.prefetchLatestOpusModel()
    expect(getGlobalConfig().latestOpusModelId).toBe('claude-opus-4-8')
    expect(getGlobalConfig().latestOpusModelCheckedAt).toBeUndefined()

    const empty = await importFresh({ models: [{ id: 'claude-sonnet-5' }] })
    await empty.mod.prefetchLatestOpusModel()
    expect(getGlobalConfig().latestOpusModelId).toBe('claude-opus-4-8')
  })
})
