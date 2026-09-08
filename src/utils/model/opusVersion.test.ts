import { describe, expect, test } from 'bun:test'
import {
  canonicalOpusId,
  formatOpusMarketingName,
  isOpusAtLeast,
  parseOpusVersion,
} from './opusVersion.js'

describe('parseOpusVersion', () => {
  test('parses first-party, provider-prefixed and gateway ids', () => {
    expect(parseOpusVersion('claude-opus-4-8')).toEqual({ major: 4, minor: 8 })
    expect(parseOpusVersion('claude-opus-4-8[1m]')).toEqual({ major: 4, minor: 8 })
    expect(parseOpusVersion('us.anthropic.claude-opus-4-8-v1')).toEqual({ major: 4, minor: 8 })
    expect(parseOpusVersion('anthropic/claude-opus-4.8')).toEqual({ major: 4, minor: 8 })
    expect(parseOpusVersion('opencode-claude-opus-4-7')).toEqual({ major: 4, minor: 7 })
    expect(parseOpusVersion('CLAUDE-OPUS-4_6')).toEqual({ major: 4, minor: 6 })
  })

  test('parses major-only and future point releases', () => {
    expect(parseOpusVersion('claude-opus-5')).toEqual({ major: 5, minor: 0 })
    expect(parseOpusVersion('claude-opus-5-1')).toEqual({ major: 5, minor: 1 })
    expect(parseOpusVersion('claude-opus-6-2')).toEqual({ major: 6, minor: 2 })
  })

  test('ignores date suffixes and the Claude 3 naming scheme', () => {
    expect(parseOpusVersion('claude-opus-4-20250514')).toEqual({ major: 4, minor: 0 })
    expect(parseOpusVersion('claude-opus-4-1-20250805')).toEqual({ major: 4, minor: 1 })
    expect(parseOpusVersion('claude-opus-4-5@20251101')).toEqual({ major: 4, minor: 5 })
    expect(parseOpusVersion('claude-3-opus-20240229')).toBeNull()
    expect(parseOpusVersion('claude-3-opus-latest')).toBeNull()
  })

  test('returns null for aliases and non-Opus models', () => {
    expect(parseOpusVersion('opus')).toBeNull()
    expect(parseOpusVersion('opusplan')).toBeNull()
    expect(parseOpusVersion('claude-sonnet-4-6')).toBeNull()
    expect(parseOpusVersion('gpt-5.6-sol')).toBeNull()
    expect(parseOpusVersion('')).toBeNull()
  })
})

describe('isOpusAtLeast', () => {
  test('compares major then minor numerically', () => {
    expect(isOpusAtLeast('claude-opus-4-6', 4, 6)).toBe(true)
    expect(isOpusAtLeast('claude-opus-4-8', 4, 6)).toBe(true)
    expect(isOpusAtLeast('claude-opus-5', 4, 6)).toBe(true)
    expect(isOpusAtLeast('claude-opus-5-1', 5, 0)).toBe(true)
    expect(isOpusAtLeast('claude-opus-4-5', 4, 6)).toBe(false)
    expect(isOpusAtLeast('claude-opus-4-1-20250805', 4, 6)).toBe(false)
    expect(isOpusAtLeast('claude-opus-4-20250514', 4, 1)).toBe(false)
    // A two-digit minor must not be read as a decimal fraction.
    expect(isOpusAtLeast('claude-opus-4-10', 4, 9)).toBe(true)
  })

  test('is false for anything without a parseable Opus version', () => {
    expect(isOpusAtLeast('opus', 4, 6)).toBe(false)
    expect(isOpusAtLeast('claude-sonnet-4-6', 4, 6)).toBe(false)
    expect(isOpusAtLeast('claude-3-opus-20240229', 3, 0)).toBe(false)
  })
})

describe('canonicalOpusId / formatOpusMarketingName', () => {
  test('omit a zero minor version', () => {
    expect(canonicalOpusId({ major: 5, minor: 0 })).toBe('claude-opus-5')
    expect(canonicalOpusId({ major: 5, minor: 1 })).toBe('claude-opus-5-1')
    expect(formatOpusMarketingName({ major: 5, minor: 0 })).toBe('Opus 5')
    expect(formatOpusMarketingName({ major: 5, minor: 1 })).toBe('Opus 5.1')
    expect(formatOpusMarketingName({ major: 4, minor: 8 })).toBe('Opus 4.8')
  })
})
