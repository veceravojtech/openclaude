import { describe, expect, test } from 'bun:test'
import {
  applyExperimentalBetasDefault,
  EXPERIMENTAL_BETAS_DEFAULTED_ENV,
  isToolSearchExemptFromDefaultedBetasSwitch,
} from './experimentalBetasDefault.js'

describe('applyExperimentalBetasDefault', () => {
  test('turns experimental betas off and marks that OpenClaude did it', () => {
    const env: NodeJS.ProcessEnv = {}
    applyExperimentalBetasDefault(env)

    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('true')
    expect(env[EXPERIMENTAL_BETAS_DEFAULTED_ENV]).toBe('1')
  })

  test('a value the user set is left alone and never marked as a default', () => {
    for (const value of ['true', 'false', '']) {
      const env: NodeJS.ProcessEnv = {
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: value,
      }
      applyExperimentalBetasDefault(env)

      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe(value)
      expect(env[EXPERIMENTAL_BETAS_DEFAULTED_ENV]).toBeUndefined()
    }
  })
})

describe('isToolSearchExemptFromDefaultedBetasSwitch', () => {
  const defaulted = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    applyExperimentalBetasDefault(env)
    return env
  }

  test("exempts tool search from OpenClaude's default on Anthropic's own API", () => {
    expect(
      isToolSearchExemptFromDefaultedBetasSwitch(defaulted(), 'firstParty'),
    ).toBe(true)
    expect(
      isToolSearchExemptFromDefaultedBetasSwitch(
        { ...defaulted(), ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        'firstParty',
      ),
    ).toBe(true)
  })

  test('never exempts a switch the user set themselves', () => {
    expect(
      isToolSearchExemptFromDefaultedBetasSwitch(
        { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true' },
        'firstParty',
      ),
    ).toBe(false)
  })

  test('never exempts behind a custom base URL', () => {
    expect(
      isToolSearchExemptFromDefaultedBetasSwitch(
        { ...defaulted(), ANTHROPIC_BASE_URL: 'https://llm-gateway.example.com' },
        'firstParty',
      ),
    ).toBe(false)
  })

  test('never exempts another Anthropic-wire provider', () => {
    for (const provider of ['bedrock', 'vertex', 'foundry', 'minimax']) {
      expect(
        isToolSearchExemptFromDefaultedBetasSwitch(defaulted(), provider),
      ).toBe(false)
    }
  })
})
