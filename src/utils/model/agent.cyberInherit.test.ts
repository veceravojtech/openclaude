import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setCyberModeEnabled } from '../../bootstrap/state.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { getAgentModel } from './agent.js'
import { recordCyberLeadModelChoice } from './cyberLead.js'
import { captureRealModules } from '../../test/moduleMockRestore.js'

// Pinned to the real modules before every test: other suites stub these
// with mock.module(), which mock.restore() does not undo, so without the pin
// this file's outcome depended on which file ran before it in the sweep
// (e.g. a leaked ./providers.js stub reporting a non-first-party provider).
const pinRealModules = await captureRealModules(import.meta.dir, [
  './providers.js',
  './model.js',
  './check1mAccess.js',
  './modelAllowlist.js',
  '../auth.js',
])

const HERMETIC_ENV = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'OPENCLAUDE_TEAMMATE_PROFILE_ID',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  pinRealModules()
  for (const key of HERMETIC_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  setCyberModeEnabled(false)
  resetSettingsCache()
  for (const key of HERMETIC_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('subagent inherit under an explicit Cyber lead model', () => {
  test('inherit resolves to the Cyber lead instead of the lead explicit model', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5[1m]')
    expect(getAgentModel('inherit', 'claude-opus-5-5[1m]')).toBe('glm-5.3')
    expect(getAgentModel(undefined, 'claude-opus-5-5[1m]', 'inherit')).toBe('glm-5.3')
  })

  test('without an explicit choice, or with Cyber off, inherit is unchanged', () => {
    setCyberModeEnabled(true)
    expect(getAgentModel('inherit', 'glm-5.3')).toBe('glm-5.3')
    setCyberModeEnabled(false)
    // "Unchanged" = no Cyber substitution. getAgentModel still applies the
    // 1M-context preference every agent gets (preferOneMillionContext), so a
    // parent that already carries the tag must come back exactly as given.
    expect(getAgentModel('inherit', 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
  })

  test('an explicit tool model still follows the normal Cyber rules', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5')
    expect(() => getAgentModel(undefined, 'claude-opus-5-5', 'claude-opus-5-5')).toThrow(/not available/)
  })
})
