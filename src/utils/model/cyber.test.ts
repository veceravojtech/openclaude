import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearCyberEscalation,
  getCyberMode,
  getMainLoopModelOverride,
  setCyberExplicitLeadModel,
  setCyberModeEnabled,
  setMainLoopModelOverride,
  unlockCyberEscalation,
} from '../../bootstrap/state.js'
import { isModelAllowed } from './modelAllowlist.js'
import { setSessionSettingsCache, resetSettingsCache } from '../settings/settingsCache.js'
import { assertCyberModelAllowed, cyberModelId, isCyberLeadQuerySource, isCyberModelAllowed, recordCyberLeadModelChoice, withCyberScope } from './cyber.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../teammate.js'

const isSpawnAllowed = (model: string) => isModelAllowed(model, undefined, { allowEscalationModel: true })

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

  test('a direct spawn may pin the escalation model without a scope', () => {
    setCyberModeEnabled(true)
    // Spawn allowance admits the escalation model, but nothing else.
    expect(isCyberModelAllowed('claude-opus-4-8', undefined, true)).toBe(true)
    expect(isSpawnAllowed('claude-opus-4-8')).toBe(true)
    expect(isSpawnAllowed('claude-opus-4-6')).toBe(true)
    expect(() => assertCyberModelAllowed('claude-opus-4-8', undefined, true)).not.toThrow()
    // The main-loop check (no scope, no spawn allowance) still blocks it.
    expect(isCyberModelAllowed('claude-opus-4-8')).toBe(false)
    expect(() => assertCyberModelAllowed('claude-opus-4-8')).toThrow()
    // Non-cyber models stay blocked even with the spawn allowance.
    expect(isCyberModelAllowed('claude-opus-5-5', undefined, true)).toBe(false)
    expect(isSpawnAllowed('claude-opus-5-5')).toBe(false)
  })

  test('spawn allowance is inert when Cyber mode is off', () => {
    setCyberModeEnabled(false)
    expect(isSpawnAllowed('claude-opus-4-8')).toBe(true)
    expect(isSpawnAllowed('claude-opus-5-5')).toBe(true)
  })
})

const HERMETIC_ENV = ['CLAUDE_CODE_USE_OPENAI', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY', 'OPENCLAUDE_TEAMMATE_PROFILE_ID'] as const

describe('explicit lead model in Cyber mode', () => {
  const savedEnv: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const key of HERMETIC_ENV) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    // Other suites can leave an availableModels allowlist in the session cache.
    setSessionSettingsCache({ settings: {}, errors: [] })
  })
  afterEach(() => {
    for (const key of HERMETIC_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    clearDynamicTeamContext()
  })
  const leadCheck = (model: string) => isCyberModelAllowed(model, undefined, false, { leadQuery: true })

  test('without an explicit choice a non-Cyber model stays blocked for the lead', () => {
    setCyberModeEnabled(true)
    expect(leadCheck('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-opus-5-5', undefined, { leadQuery: true })).toBe(false)
    expect(() => assertCyberModelAllowed('claude-opus-5-5', undefined, false, { leadQuery: true })).toThrow(/choose it explicitly with \/model/)
  })

  test('an explicit choice unlocks that model (with or without [1m]) for the lead main loop', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5[1m]')
    expect(getCyberMode().explicitLeadModel).toBe('claude-opus-5-5[1m]')
    expect(leadCheck('claude-opus-5-5')).toBe(true)
    expect(leadCheck('claude-opus-5-5[1m]')).toBe(true)
    expect(isModelAllowed('claude-opus-5-5', undefined, { leadQuery: true })).toBe(true)
    expect(() => assertCyberModelAllowed('claude-opus-5-5[1m]', undefined, false, { leadQuery: true })).not.toThrow()
    // Without the lead-query flag (side calls, generic checks) it is still blocked.
    expect(isCyberModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
  })

  test('the explicit choice does not unlock a different non-Cyber model', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5')
    expect(leadCheck('claude-opus-5-50')).toBe(false)
    expect(leadCheck('claude-sonnet-5-5')).toBe(false)
    expect(leadCheck('claude-opus-4-8')).toBe(false)
  })

  test('spawn query sources and teammates ignore the lead choice', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5')
    expect(isCyberLeadQuerySource('repl_main_thread')).toBe(true)
    expect(isCyberLeadQuerySource('sdk')).toBe(true)
    expect(isCyberLeadQuerySource('agent:custom')).toBe(false)
    expect(isCyberLeadQuerySource('compact')).toBe(false)
    // Spawn checks never pass leadQuery, so the choice is inert for them.
    expect(isCyberModelAllowed('claude-opus-5-5', undefined, true)).toBe(false)
    expect(isSpawnAllowed('claude-opus-5-5')).toBe(false)
    // Even a forced leadQuery flag is ignored inside a teammate process.
    setDynamicTeamContext({ agentId: 'a@t', agentName: 'a', teamName: 't', planModeRequired: false })
    expect(isCyberLeadQuerySource('repl_main_thread')).toBe(false)
    expect(leadCheck('claude-opus-5-5')).toBe(false)
  })

  test('choosing the Cyber lead model or the default clears the explicit choice', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5')
    recordCyberLeadModelChoice('glm-5.3')
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
    recordCyberLeadModelChoice('claude-opus-5-5')
    recordCyberLeadModelChoice(null)
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
  })

  test('explicitChoice accepts any model while choosing, but availableModels still applies', () => {
    setCyberModeEnabled(true)
    expect(isModelAllowed('claude-opus-5-5', undefined, { explicitChoice: true })).toBe(true)
    setSessionSettingsCache({ settings: { availableModels: ['glm-5.3'] }, errors: [] })
    expect(isModelAllowed('claude-opus-5-5', undefined, { explicitChoice: true })).toBe(false)
  })

  test('turning Cyber off or on again drops the explicit choice; off is unchanged', () => {
    setCyberModeEnabled(true)
    setCyberExplicitLeadModel('claude-opus-5-5')
    setCyberModeEnabled(false)
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
    expect(leadCheck('claude-opus-5-5')).toBe(true)
    // Recording is a no-op while Cyber is off.
    recordCyberLeadModelChoice('claude-opus-5-5')
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
    setCyberModeEnabled(true)
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
  })
})
