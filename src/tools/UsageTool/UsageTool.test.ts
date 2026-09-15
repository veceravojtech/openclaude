import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Utilization } from '../../services/api/usage.js'
import type { CodexUsageData } from '../../services/api/codexUsage.js'
import {
  captureRateLimitHeaders,
  clearProviderUsageRegistry,
} from '../../services/api/providerUsageRegistry.js'
import { buildUsageReport, clearUsageReportCache, renderUsageReport } from './report.js'
import { UsageTool, type Output } from './UsageTool.js'

// The report resolves the active provider from process.env; snapshot every
// key that can influence route resolution so each case starts clean.
const MANAGED_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'OPENAI_MODEL',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'NVIDIA_NIM',
  'GEMINI_BASE_URL',
  'MINIMAX_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
] as const

const originalEnv = new Map(
  MANAGED_ENV_KEYS.map(key => [key, process.env[key]] as const),
)

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key]
  clearProviderUsageRegistry()
  clearUsageReportCache()
})

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  clearProviderUsageRegistry()
  clearUsageReportCache()
})

const CLAUDE_LIVE: Utilization = {
  five_hour: { utilization: 42, resets_at: '2026-09-15T14:00:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-09-19T00:00:00Z' },
}

const CODEX_LIVE: CodexUsageData = {
  planType: 'plus',
  snapshots: [
    {
      limitName: 'codex',
      primary: {
        usedPercent: 61,
        windowMinutes: 300,
        resetsAt: '2026-09-15T15:00:00Z',
      },
    },
  ],
}

function noFetchers() {
  return {
    fetchClaudeUtilization: async () => null,
    fetchCodexUsage: async () => CODEX_LIVE,
    fetchMiniMaxUsage: async () => {
      throw new Error('unexpected minimax fetch')
    },
  }
}

test('claude default: honest unknown when nothing was captured, no network', async () => {
  const report = await buildUsageReport({ fetchers: noFetchers() })
  expect(report.providers.length).toBe(1)
  const section = report.providers[0]
  expect(section.provider).toBe('firstParty')
  expect(section.isActive).toBe(true)
  expect(section.capability).toBe('supported')
  expect(section.rows).toBeUndefined()
  expect(section.note).toContain('no utilization headers captured yet')

  const text = renderUsageReport(report)
  expect(text).toContain('unknown')
  expect(text).not.toContain('% used')
  expect(text).toContain('Session:')
})

test('claude refresh stores live fetch, then serves it cached by default', async () => {
  let fetchCount = 0
  const fetchers = {
    ...noFetchers(),
    fetchClaudeUtilization: async () => {
      fetchCount++
      return CLAUDE_LIVE
    },
  }

  const refreshed = await buildUsageReport({ refresh: true, fetchers })
  const section = refreshed.providers[0]
  expect(fetchCount).toBe(1)
  expect(section.lastUpdated).toBeTruthy()
  const fiveHour = section.rows?.find(row => row.label === '5h window')
  expect(fiveHour).toMatchObject({
    kind: 'window',
    usedPercent: 42,
    resetsAt: '2026-09-15T14:00:00Z',
    source: 'live fetch',
  })

  const text = renderUsageReport(refreshed)
  expect(text).toContain('5h window: 42% used')
  expect(text).toContain('[live fetch]')
  expect(text).toContain('last updated:')

  // Default follow-up call: cached, no second network fetch.
  const cached = await buildUsageReport({ fetchers })
  expect(fetchCount).toBe(1)
  expect(cached.providers[0].rows?.find(r => r.label === '5h window')).toMatchObject({
    usedPercent: 42,
    source: 'live fetch',
  })
})

test('codex active: live fetch rows and plan type, honest note before first fetch', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
  process.env.OPENAI_MODEL = 'gpt-5.2-codex'
  process.env.OPENAI_API_KEY = 'test-key'

  const beforeFetch = await buildUsageReport({ fetchers: noFetchers() })
  expect(beforeFetch.providers[0].provider).toBe('codex')
  expect(beforeFetch.providers[0].note).toContain(
    'no cached Codex usage yet; call with refresh: true',
  )
  expect(renderUsageReport(beforeFetch)).toContain('unknown')

  const fetched = await buildUsageReport({ refresh: true, fetchers: noFetchers() })
  const section = fetched.providers[0]
  expect(section.rows?.[0]).toMatchObject({
    kind: 'window',
    usedPercent: 61,
    source: 'live fetch',
  })
  expect(section.planType).toBe('Plus')

  const text = renderUsageReport(fetched)
  expect(text).toContain('61% used')
  expect(text).toContain('plan: Plus')
})

test('generic openai-compatible active: captured x-ratelimit values with timestamps', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  captureRateLimitHeaders({
    providerKey: 'host:example.test',
    providerLabel: 'example.test',
    model: 'test-model',
    headers: new Headers({
      'x-ratelimit-remaining-requests': '118',
      'x-ratelimit-limit-requests': '120',
      'x-ratelimit-reset-requests': '6m0s',
    }),
    now: () => new Date('2026-09-15T10:00:00Z').getTime(),
  })

  const report = await buildUsageReport({ fetchers: noFetchers() })
  const active = report.providers.find(section => section.isActive)
  expect(active?.rateLimits).toMatchObject({
    remainingRequests: 118,
    limitRequests: 120,
    resetRequests: '6m0s',
  })
  expect(active?.lastUpdated).toBe('2026-09-15T10:00:00.000Z')

  const text = renderUsageReport(report)
  expect(text).toContain('requests 118/120')
  expect(text).toContain('requests reset in 6m0s')
  expect(text).toContain('last updated: 2026-09-15T10:00:00.000Z')
})

test('vendor without usage metadata reports not exposed by provider (GLM case)', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  const report = await buildUsageReport({ fetchers: noFetchers() })
  const section = report.providers[0]
  expect(section.capability).toBe('not exposed by provider')
  expect(section.rateLimits).toBeUndefined()
  expect(section.note).toContain('no usage endpoint')

  const text = renderUsageReport(report)
  expect(text).toContain('not exposed by provider')
  expect(text).not.toContain('% used')
})

test('provider filter narrows sections and unknown filter matches nothing', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  captureRateLimitHeaders({
    providerKey: 'zai',
    providerLabel: 'Z.ai',
    headers: new Headers({ 'x-ratelimit-remaining-requests': '5' }),
    now: () => new Date('2026-09-15T10:00:00Z').getTime(),
  })

  const zaiOnly = await buildUsageReport({
    providerFilter: 'zai',
    fetchers: noFetchers(),
  })
  expect(zaiOnly.providers.length).toBe(1)
  expect(zaiOnly.providers[0].provider).toBe('zai')
  expect(zaiOnly.providers[0].isActive).toBe(false)

  const none = await buildUsageReport({
    providerFilter: 'no-such-provider',
    fetchers: noFetchers(),
  })
  expect(none.providers.length).toBe(0)
})

test('tool call renders the report through the tool result block', async () => {
  const result = await UsageTool.call({})
  const block = UsageTool.mapToolResultToToolResultBlockParam(
    result.data as Output,
    'tu-usage-1',
  )
  const text = block.content as string
  expect(text).toContain('Session:')
  expect(text).toContain('Anthropic')
})
