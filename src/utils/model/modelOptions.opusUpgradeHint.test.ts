import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realModel from './model.js'
import * as realProviders from './providers.js'

// The "Newer version available" hint used to gate on a `claude-opus-4`
// substring, so it was silently dead for the whole 5.x line: a user pinned to
// an older Opus was never told a newer one existed. The gate is version-parsed
// now, so these cases must hold for 5.x AND for an Opus that does not exist
// yet — if a future major re-breaks this, the 6.x case fails.

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'USER_TYPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/model/modelOptions.opusUpgradeHint.test.ts',
  )
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    mock.restore()
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/**
 * Build the picker with `pinned` as the user's saved model and `defaultOpus`
 * as whatever the `opus` alias currently resolves to.
 */
async function importFresh(opts: { pinned: string; defaultOpus: string }) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
    isFirstPartyAnthropicProvider: () => true,
    isCustomAnthropicProvider: () => false,
  }))
  mock.module('./model.js', () => ({
    ...realModel,
    getUserSpecifiedModelSetting: () => opts.pinned,
    getDefaultOpusModel: () => opts.defaultOpus,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return (await import(
    `./modelOptions.js?ts=${nonce}`
  )) as typeof import('./modelOptions.js')
}

async function optionFor(opts: { pinned: string; defaultOpus: string }) {
  const { getModelOptions } = await importFresh(opts)
  return getModelOptions().find(o => o.value === opts.pinned)
}

describe('Opus "newer version available" hint', () => {
  test('offers the upgrade when pinned to 4.5 and the default is 5.5', async () => {
    const option = await optionFor({
      pinned: 'claude-opus-4-5',
      defaultOpus: 'claude-opus-5-5',
    })
    expect(option).toBeDefined()
    expect(option!.label).toBe('Opus 4.5')
    expect(option!.description).toContain('Newer version available')
    expect(option!.description).toContain('Opus 5.5')
  })

  test('offers the upgrade when pinned WITHIN the 5.x line (5 → 5.5)', async () => {
    // The exact case the old `claude-opus-4` substring silently dropped.
    const option = await optionFor({
      pinned: 'claude-opus-5',
      defaultOpus: 'claude-opus-5-5',
    })
    expect(option).toBeDefined()
    expect(option!.label).toBe('Opus 5')
    expect(option!.description).toContain('Newer version available')
    expect(option!.description).toContain('Opus 5.5')
  })

  test('keeps working for an Opus major that does not exist yet (5.5 → 6)', async () => {
    // Proves the gate is version-parsed, not re-pinned to a known id list.
    const option = await optionFor({
      pinned: 'claude-opus-5-5',
      defaultOpus: 'claude-opus-6',
    })
    expect(option).toBeDefined()
    expect(option!.label).toBe('Opus 5.5')
    expect(option!.description).toContain('Newer version available')
    expect(option!.description).toContain('Opus 6')
  })

  test('shows no upgrade hint when the pinned model IS the default', async () => {
    const option = await optionFor({
      pinned: 'claude-opus-5-5',
      defaultOpus: 'claude-opus-5-5',
    })
    expect(option).toBeDefined()
    expect(option!.label).toBe('Opus 5.5')
    expect(option!.description).not.toContain('Newer version available')
  })

  test('does not treat Claude 3 Opus as an upgradeable family member', async () => {
    // `claude-3-opus-*` has no modern alias to upgrade to; parseOpusVersion
    // rejects it, so it must fall through to the plain custom-model row.
    const option = await optionFor({
      pinned: 'claude-3-opus-20240229',
      defaultOpus: 'claude-opus-5-5',
    })
    expect(option).toBeDefined()
    expect(option!.description).not.toContain('Newer version available')
  })
})
