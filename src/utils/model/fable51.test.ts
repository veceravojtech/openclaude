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
  CLAUDE_FABLE_5_1_CONFIG,
  CLAUDE_OPUS_5_5_CONFIG,
} from './configs.js'
import {
  isFableAtLeast,
  isModernFrontierClaude,
  isOpusAtLeast,
  modelRequiresAlwaysOnThinking,
  modelSupportsCustomTemperature,
  modelSupportsForcedToolChoice,
  parseFableVersion,
  parseOpusVersion,
} from './opusVersion.js'
import { MODEL_COSTS } from '../modelCost.js'
import { sanitizeModelName } from '../commitAttribution.js'

const FABLE_5_1 = 'claude-fable-5-1'
const FABLE_5_1_BEDROCK = 'us.anthropic.claude-fable-5-1'

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
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

// providers.js may be left stubbed by sibling files (mock.module is global);
// reinstall the real module before importing anything that reads it.
async function restoreProviders(): Promise<string> {
  const nonce = `${Date.now()}-${Math.random()}`
  const actualProviders = await import(`./providers.js?restore=${nonce}`)
  mock.module('./providers.js', () => ({ ...actualProviders }))
  mock.module('src/utils/model/providers.js', () => ({ ...actualProviders }))
  return nonce
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/fable51.test.ts')
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
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

// --- registration ------------------------------------------------------------

test('Fable 5.1 config carries the verified per-provider ids', () => {
  expect(CLAUDE_FABLE_5_1_CONFIG.firstParty).toBe(FABLE_5_1)
  // No -v1 suffix on Bedrock, unlike Opus 5.5.
  expect(CLAUDE_FABLE_5_1_CONFIG.bedrock).toBe(FABLE_5_1_BEDROCK)
  expect(CLAUDE_FABLE_5_1_CONFIG.vertex).toBe(FABLE_5_1)
  expect(CLAUDE_FABLE_5_1_CONFIG.foundry).toBe(FABLE_5_1)
  expect(CANONICAL_MODEL_IDS).toContain(FABLE_5_1)
  expect(CANONICAL_ID_TO_KEY[FABLE_5_1]).toBe('fable51')
})

test('the Fable 5.1 catalog entry carries 1M context and 128K output', () => {
  const entry = claudeModels.find(model => model.id === FABLE_5_1)
  expect(entry).toBeDefined()
  expect(entry?.label).toBe('Claude Fable 5.1')
  expect(entry?.defaultModel).toBe(FABLE_5_1)
  expect(entry?.contextWindow).toBe(1_000_000)
  expect(entry?.maxOutputTokens).toBe(128_000)
  expect(entry?.capabilities.supportsVision).toBe(true)
  expect(entry?.capabilities.supportsReasoning).toBe(true)
})

test('Fable 5.1 is not the default model', async () => {
  const nonce = await restoreProviders()
  const { getDefaultOpusModel, getDefaultMainLoopModel } = await import(
    `./model.js?ts=${nonce}`
  )
  expect(getDefaultOpusModel()).toBe(CLAUDE_OPUS_5_5_CONFIG.firstParty)
  expect(getDefaultMainLoopModel()).not.toContain('fable')
})

test('Fable 5.1 pricing row matches the published rates', () => {
  expect(MODEL_COSTS[FABLE_5_1]).toEqual({
    inputTokens: 10,
    outputTokens: 50,
    promptCacheWriteTokens: 12.5,
    promptCacheReadTokens: 0.25,
    webSearchRequests: 0.01,
  })
})

test('Fable ids canonicalize and get public names', async () => {
  const nonce = await restoreProviders()
  const { firstPartyNameToCanonical, getPublicModelDisplayName } =
    await import(`./model.js?ts=${nonce}`)
  expect(firstPartyNameToCanonical(FABLE_5_1)).toBe(FABLE_5_1)
  expect(firstPartyNameToCanonical(FABLE_5_1_BEDROCK)).toBe(FABLE_5_1)
  expect(firstPartyNameToCanonical('global.anthropic.claude-fable-5-1')).toBe(
    FABLE_5_1,
  )
  expect(getPublicModelDisplayName(FABLE_5_1)).toBe('Fable 5.1')
  expect(sanitizeModelName(FABLE_5_1)).toBe(FABLE_5_1)
})

// --- version parsing -----------------------------------------------------------

test('parseFableVersion handles first-party, Bedrock and future ids', () => {
  expect(parseFableVersion(FABLE_5_1)).toEqual({ major: 5, minor: 1 })
  expect(parseFableVersion(FABLE_5_1_BEDROCK)).toEqual({ major: 5, minor: 1 })
  expect(parseFableVersion('claude-fable-5')).toEqual({ major: 5, minor: 0 })
  expect(parseFableVersion('claude-fable-5-2')).toEqual({ major: 5, minor: 2 })
  expect(parseFableVersion('claude-opus-5-5')).toBeNull()
})

test('the Opus parser does not match Fable and vice versa', () => {
  expect(parseOpusVersion(FABLE_5_1)).toBeNull()
  expect(isOpusAtLeast(FABLE_5_1, 4, 6)).toBe(false)
  expect(isFableAtLeast('claude-opus-5-5', 5)).toBe(false)
  expect(isModernFrontierClaude(FABLE_5_1)).toBe(true)
  expect(isModernFrontierClaude('claude-opus-5-5')).toBe(true)
  expect(isModernFrontierClaude('claude-opus-4-5')).toBe(false)
})

// --- request-shape capabilities ------------------------------------------------

test('modelSupportsForcedToolChoice is false for Fable 5.1+ only', () => {
  expect(modelSupportsForcedToolChoice('claude-opus-5-5')).toBe(true)
  expect(modelSupportsForcedToolChoice('claude-sonnet-4-6')).toBe(true)
  expect(modelSupportsForcedToolChoice('claude-haiku-4-5')).toBe(true)
  // OpenCode's claude-fable-5 is not documented as rejecting forced tool use.
  expect(modelSupportsForcedToolChoice('claude-fable-5')).toBe(true)
  expect(modelSupportsForcedToolChoice(FABLE_5_1)).toBe(false)
  expect(modelSupportsForcedToolChoice(FABLE_5_1_BEDROCK)).toBe(false)
  expect(modelSupportsForcedToolChoice('claude-fable-5-2')).toBe(false)
})

test('temperature and thinking constraints apply to Fable 5.1+ only', () => {
  expect(modelSupportsCustomTemperature('claude-opus-5-5')).toBe(true)
  expect(modelSupportsCustomTemperature(FABLE_5_1)).toBe(false)
  expect(modelSupportsCustomTemperature(FABLE_5_1_BEDROCK)).toBe(false)
  expect(modelSupportsCustomTemperature('claude-fable-5-2')).toBe(false)
  expect(modelRequiresAlwaysOnThinking('claude-opus-5-5')).toBe(false)
  expect(modelRequiresAlwaysOnThinking(FABLE_5_1)).toBe(true)
  expect(modelRequiresAlwaysOnThinking('claude-fable-5-2')).toBe(true)
})

// --- runtime capability gates ----------------------------------------------------

test('Fable 5.1 reports 1M context and 128K max output', async () => {
  const nonce = await restoreProviders()
  const { modelSupports1M, getModelMaxOutputTokens } = await import(
    `../context.js?ts=${nonce}`
  )
  for (const id of [FABLE_5_1, FABLE_5_1_BEDROCK, 'claude-fable-5-2']) {
    expect(modelSupports1M(id)).toBe(true)
    expect(getModelMaxOutputTokens(id).upperLimit).toBe(128_000)
  }
})

test('Fable 5.1 supports adaptive thinking on first party and Bedrock', async () => {
  const nonce = await restoreProviders()
  const { modelSupportsAdaptiveThinking, modelSupportsThinking } =
    await import(`../thinking.js?ts=${nonce}`)
  expect(modelSupportsAdaptiveThinking(FABLE_5_1)).toBe(true)
  expect(modelSupportsThinking(FABLE_5_1)).toBe(true)
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  expect(modelSupportsThinking(FABLE_5_1_BEDROCK)).toBe(true)
  expect(modelSupportsAdaptiveThinking(FABLE_5_1_BEDROCK)).toBe(true)
})

test('Fable 5.1 supports effort through max/xhigh with the API default', async () => {
  const nonce = await restoreProviders()
  const {
    modelSupportsEffort,
    modelSupportsMaxEffort,
    modelSupportsXHighEffort,
    getDefaultEffortForModel,
  } = await import(`../effort.js?ts=${nonce}`)
  expect(modelSupportsEffort(FABLE_5_1)).toBe(true)
  expect(modelSupportsMaxEffort(FABLE_5_1)).toBe(true)
  // Same as Opus 5.5.
  expect(modelSupportsXHighEffort(FABLE_5_1)).toBe(
    modelSupportsXHighEffort('claude-opus-5-5'),
  )
  // undefined = no effort sent, so the API default (high) applies.
  expect([undefined, 'high']).toContain(getDefaultEffortForModel(FABLE_5_1))
})
