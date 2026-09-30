import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getCyberMode,
  getMainLoopModelOverride,
  setCyberModeEnabled,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../utils/envUtils.js'
import { recordCyberLeadModelChoice } from '../utils/model/cyberLead.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { getDefaultAppState } from './AppStateStore.js'
import { onChangeAppState } from './onChangeAppState.js'

const HERMETIC_ENV = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'OPENCLAUDE_TEAMMATE_PROFILE_ID',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
] as const

const savedEnv: Record<string, string | undefined> = {}
let configDir: string
const previousOverride = getMainLoopModelOverride()

beforeEach(async () => {
  await acquireSharedMutationLock('state/onChangeAppState.cyber.test.ts')
  for (const key of HERMETIC_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // onChangeAppState persists the model to user settings; keep it off the real config.
  configDir = mkdtempSync(join(tmpdir(), 'cyber-lead-'))
  setClaudeConfigHomeDirForTesting(configDir)
  resetSettingsCache()
})

afterEach(() => {
  try {
    setCyberModeEnabled(false)
    setMainLoopModelOverride(previousOverride)
    setClaudeConfigHomeDirForTesting(undefined)
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
    for (const key of HERMETIC_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function changeModel(from: string | null, to: string | null): void {
  const base = getDefaultAppState()
  onChangeAppState({
    oldState: { ...base, mainLoopModel: from },
    newState: { ...base, mainLoopModel: to },
  })
}

describe('onChangeAppState under Cyber mode', () => {
  test('an automatic mainLoopModel write (rate-limit fallback, /fast) never becomes an explicit lead choice', () => {
    setCyberModeEnabled(true)
    changeModel('glm-5.3', 'claude-opus-5-5')
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
    changeModel('claude-opus-5-5', 'claude-haiku-4-5')
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
  })

  test('a user entry point records the choice, and the state change keeps it', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5[1m]')
    changeModel('glm-5.3', 'claude-opus-5-5[1m]')
    expect(getCyberMode().explicitLeadModel).toBe('claude-opus-5-5[1m]')
  })

  test('/model default returns to the Cyber lead and clears the explicit choice', () => {
    setCyberModeEnabled(true)
    recordCyberLeadModelChoice('claude-opus-5-5')
    changeModel('claude-opus-5-5', null)
    expect(getMainLoopModelOverride()).toBe('glm-5.3')
    expect(getCyberMode().explicitLeadModel).toBeUndefined()
  })

  test('/model default without Cyber mode is unchanged', () => {
    changeModel('claude-opus-5-5', null)
    expect(getMainLoopModelOverride()).toBeNull()
  })
})
