import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetStateForTests } from '../../bootstrap/state.js'
import claudeModels from '../../integrations/models/claude.js'
import { DISABLE_LATEST_OPUS_RESOLUTION_ENV } from './latestOpusModel.js'
import {
  CANONICAL_ID_TO_KEY,
  CANONICAL_MODEL_IDS,
  CLAUDE_OPUS_5_5_CONFIG,
} from './configs.js'
import { getModelStrings } from './modelStrings.js'

const OPUS_5_5 = 'claude-opus-5-5'

// getDefaultOpusModel branches on the active provider — the 3P branch is still
// pinned to Opus 4.7. Any of these left set by an earlier test file would route
// this suite down that branch, so clear them and restore afterwards.
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_NIM',
  'OPENAI_MODEL',
] as const

const savedEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>> = {}

/**
 * `mock.module` is process-global and `mock.restore` does not undo it, so a
 * sibling file (agent.test.ts) can leave `providers.js` stubbed with a
 * non-first-party provider. Reinstall the real module, then re-import model.ts
 * against it — the same restore dance model.openai-shim-providers.test.ts does.
 */
async function importFreshModelModule(): Promise<typeof import('./model.js')> {
  const nonce = `${Date.now()}-${Math.random()}`
  const actualProviders = await import(`./providers.js?restore=${nonce}`)
  mock.module('./providers.js', () => ({ ...actualProviders }))
  mock.module('src/utils/model/providers.js', () => ({ ...actualProviders }))
  return import(`./model.js?ts=${nonce}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/opus55Default.test.ts')
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Pin the static fallback: with resolution enabled, getDefaultOpusModel can
  // return whatever the Models API cached on a previous startup.
  process.env[DISABLE_LATEST_OPUS_RESOLUTION_ENV] = '1'
  resetStateForTests()
})

afterEach(() => {
  try {
    delete process.env[DISABLE_LATEST_OPUS_RESOLUTION_ENV]
    for (const key of PROVIDER_ENV_KEYS) {
      const saved = savedEnv[key]
      if (saved === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved
      }
    }
    resetStateForTests()
  } finally {
    releaseSharedMutationLock()
  }
})

test('the first-party default Opus is claude-opus-5-5', async () => {
  const { getDefaultOpusModel } = await importFreshModelModule()
  expect(getModelStrings().opus55).toBe(OPUS_5_5)
  expect(getDefaultOpusModel()).toBe(OPUS_5_5)
})

test('isNonCustomOpusModel accepts Opus 5.5', async () => {
  const { isNonCustomOpusModel } = await importFreshModelModule()
  expect(isNonCustomOpusModel(OPUS_5_5)).toBe(true)
  // The previous default must keep working alongside it.
  expect(isNonCustomOpusModel('claude-opus-5')).toBe(true)
})

test('Opus 5.5 is registered as a canonical model', () => {
  expect(CLAUDE_OPUS_5_5_CONFIG.firstParty).toBe(OPUS_5_5)
  expect(CANONICAL_MODEL_IDS).toContain(OPUS_5_5)
  expect(CANONICAL_ID_TO_KEY[OPUS_5_5]).toBe('opus55')
})

test('the Opus 5.5 catalog entry carries the 1M context window', () => {
  const entry = claudeModels.find(model => model.id === OPUS_5_5)
  expect(entry).toBeDefined()
  expect(entry?.label).toBe('Claude Opus 5.5')
  expect(entry?.defaultModel).toBe(OPUS_5_5)
  expect(entry?.contextWindow).toBe(1_000_000)
  expect(entry?.maxOutputTokens).toBe(128_000)
})
