import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realProviders from '../model/providers.js'

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/teammateModel.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshTeammateModelModule(provider = 'mistral') {
  mock.module('../model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => true,
    isFirstPartyAnthropicProvider: () => provider === 'firstParty',
    isCustomAnthropicProvider: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./teammateModel.js?ts=${nonce}`)
}

test('getHardcodedTeammateModelFallback returns a Mistral fallback in mistral mode', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule()

  expect(getHardcodedTeammateModelFallback()).toBe('devstral-latest')
})

test('getHardcodedTeammateModelFallback returns the current default Opus for first party', async () => {
  // Regression for #1769: the fallback hardcoded Opus 4.6 while the default Opus
  // had moved on, so new teammates spawned on an older model. First-party now
  // follows the `opus` alias; with nothing resolved that is the pinned Opus 5.
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('firstParty')

  expect(getHardcodedTeammateModelFallback()).toBe('claude-opus-5')
})

test('getHardcodedTeammateModelFallback is provider-aware (Bedrock gets the Opus 4.8 Bedrock id)', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('bedrock')

  expect(getHardcodedTeammateModelFallback()).toBe(
    'us.anthropic.claude-opus-4-8-v1',
  )
})

test('getHardcodedTeammateModelFallback returns the Codex default (GPT-5.6 Sol) for codex', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('codex')

  expect(getHardcodedTeammateModelFallback()).toBe('gpt-5.6-sol')
})

test('getHardcodedTeammateModelFallback inherits the leader model on OpenAI-compatible providers', async () => {
  // getAPIProvider() collapses every OpenAI-compatible endpoint (Z.AI/GLM,
  // DeepSeek, Ollama, vLLM, custom) onto the `openai` key, whose table entry is
  // 'gpt-4o'. Spawning a teammate against Z.AI therefore sent 'gpt-4o' to the
  // GLM endpoint and was rejected with code 1211 "Unknown Model". The session's
  // own model is the only id we know that endpoint accepts.
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('openai')

  expect(getHardcodedTeammateModelFallback('glm-5.3')).toBe('glm-5.3')
})

test('getHardcodedTeammateModelFallback keeps the table entry for openai when no leader model is known', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('openai')

  expect(getHardcodedTeammateModelFallback()).toBe('gpt-4o')
  expect(getHardcodedTeammateModelFallback(null)).toBe('gpt-4o')
})

test('getHardcodedTeammateModelFallback ignores the leader model on dedicated providers', async () => {
  // Only the `openai` bucket is ambiguous. Dedicated categories carry a real id
  // for that one provider, so a leader model must not override them.
  const firstParty = await importFreshTeammateModelModule('firstParty')
  expect(firstParty.getHardcodedTeammateModelFallback('glm-5.3')).toBe(
    'claude-opus-5',
  )

  const bedrock = await importFreshTeammateModelModule('bedrock')
  expect(bedrock.getHardcodedTeammateModelFallback('glm-5.3')).toBe(
    'us.anthropic.claude-opus-4-8-v1',
  )

  const mistral = await importFreshTeammateModelModule('mistral')
  expect(mistral.getHardcodedTeammateModelFallback('glm-5.3')).toBe(
    'devstral-latest',
  )
})
