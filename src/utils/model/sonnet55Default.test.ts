import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import claudeModels from '../../integrations/models/claude.js'
import {
  CANONICAL_ID_TO_KEY,
  CANONICAL_MODEL_IDS,
  CLAUDE_SONNET_5_5_CONFIG,
} from './configs.js'
import { getModelStrings } from './modelStrings.js'

const SONNET_5_5 = 'claude-sonnet-5-5'

// getDefaultSonnetModel branches on the active provider — the 3P branch is
// still pinned to Sonnet 4.5. Any of these left set by an earlier test file
// would route this suite down that branch, so clear them and restore
// afterwards.
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'GEMINI_MODEL',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'MISTRAL_MODEL',
  'NVIDIA_NIM',
  'OPENAI_MODEL',
] as const

const savedEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>> = {}

/**
 * `mock.module` is process-global and `mock.restore` does not undo it, so a
 * sibling file can leave `providers.js` stubbed with a non-first-party
 * provider. Reinstall the real module, then re-import model.ts against it —
 * the same restore dance model.openai-shim-providers.test.ts does.
 */
async function importFreshModelModule(): Promise<typeof import('./model.js')> {
  const nonce = `${Date.now()}-${Math.random()}`
  const actualProviders = await import(`./providers.js?restore=${nonce}`)
  mock.module('./providers.js', () => ({ ...actualProviders }))
  mock.module('src/utils/model/providers.js', () => ({ ...actualProviders }))
  return import(`./model.js?ts=${nonce}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/sonnet55Default.test.ts')
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    for (const key of PROVIDER_ENV_KEYS) {
      const saved = savedEnv[key]
      if (saved === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved
      }
    }
    resetModelStringsForTestingOnly()
  } finally {
    releaseSharedMutationLock()
  }
})

test('the first-party default Sonnet is claude-sonnet-5-5', async () => {
  const { getDefaultSonnetModel } = await importFreshModelModule()
  expect(getModelStrings().sonnet55).toBe(SONNET_5_5)
  expect(getDefaultSonnetModel()).toBe(SONNET_5_5)
})

test('Sonnet 5.5 is registered as a canonical model', () => {
  expect(CLAUDE_SONNET_5_5_CONFIG.firstParty).toBe(SONNET_5_5)
  expect(CANONICAL_MODEL_IDS).toContain(SONNET_5_5)
  expect(CANONICAL_ID_TO_KEY[SONNET_5_5]).toBe('sonnet55')
})

test('the Sonnet 5.5 catalog entry carries the 1M context window', () => {
  const entry = claudeModels.find(model => model.id === SONNET_5_5)
  expect(entry).toBeDefined()
  expect(entry?.label).toBe('Claude Sonnet 5.5')
  expect(entry?.defaultModel).toBe(SONNET_5_5)
  expect(entry?.contextWindow).toBe(1_000_000)
  expect(entry?.maxOutputTokens).toBe(128_000)
})
