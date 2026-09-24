import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearCyberEscalation,
  getCyberMode,
  getMainLoopModelOverride,
  setCyberModeEnabled,
  setMainLoopModelOverride,
  unlockCyberEscalation,
} from '../../bootstrap/state.js'
import { isModelAllowed } from './modelAllowlist.js'
import { setSessionSettingsCache, resetSettingsCache } from '../settings/settingsCache.js'
import { cyberModelId, isCyberModelAllowed, withCyberScope } from './cyber.js'

const previous = getMainLoopModelOverride()
afterEach(() => {
  setCyberModeEnabled(false)
  setMainLoopModelOverride(previous)
  resetSettingsCache()
})

describe('cyber policy', () => {
  test('intersects organization restrictions and isolates async scopes', async () => {
    setCyberModeEnabled(true)
    setSessionSettingsCache({ settings: { availableModels: ['glm-5.3', 'claude-opus-4-8', 'sonnet'] }, errors: [] })
    expect(isModelAllowed('glm-5.3')).toBe(true)
    expect(isModelAllowed('deepseek-v4-pro')).toBe(false)
    expect(isModelAllowed('sonnet')).toBe(false)
    unlockCyberEscalation('async-a', 'reason')
    const allowed = await withCyberScope('async-a', async () => {
      await Promise.resolve()
      return isModelAllowed('claude-opus-4-8')
    })
    expect(allowed).toBe(true)
    expect(isModelAllowed('claude-opus-4-8')).toBe(false)
  })
  test('restores the session override and clears escalation on off', () => {
    setMainLoopModelOverride('original-model')
    setCyberModeEnabled(true)
    expect(getMainLoopModelOverride()).toBe('glm-5.3')
    setCyberModeEnabled(true)
    unlockCyberEscalation('agent-a', 'uncertain about the solution')
    setCyberModeEnabled(false)
    expect(getMainLoopModelOverride()).toBe('original-model')
    expect(getCyberMode().escalationScopes.size).toBe(0)
  })

  test('matches exact gateway catalog descriptors', () => {
    expect(cyberModelId('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8')
    expect(cyberModelId('anthropic/claude-opus-4-6')).toBe('claude-opus-4-6')
    for (const model of ['deepseek-ai/deepseek-v4-pro', 'accounts/fireworks/models/deepseek-v4-pro', 'deepseek-v4-pro:cloud']) {
      expect(cyberModelId(model)).toBe('deepseek-v4-pro')
    }
    expect(cyberModelId('glm-5.3-flash')).toBeUndefined()
    expect(cyberModelId('claude-opus-4-60')).toBeUndefined()
    expect(cyberModelId('opus')).toBeUndefined()
  })

  test('escalation never unlocks another request or the session', () => {
    setCyberModeEnabled(true)
    expect(isCyberModelAllowed('glm-5.3-flash')).toBe(false)
    expect(isCyberModelAllowed('claude-opus-4-6')).toBe(true)
    unlockCyberEscalation('request-a', 'need stronger reasoning')
    expect(isCyberModelAllowed('claude-opus-4-8', 'request-a')).toBe(true)
    expect(isCyberModelAllowed('claude-opus-4-8', 'request-b')).toBe(false)
    expect(isCyberModelAllowed('claude-opus-4-8')).toBe(false)
    clearCyberEscalation('request-a')
    expect(isCyberModelAllowed('claude-opus-4-8', 'request-a')).toBe(false)
  })
})
