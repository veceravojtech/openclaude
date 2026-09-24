import { afterEach, expect, test } from 'bun:test'
import { getCyberMode, setCyberModeEnabled } from '../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../types/command.js'
import { call } from './cyber.js'
import { buildInheritedCliFlags, buildInheritedEnvVars } from '../utils/swarm/spawnUtils.js'

const context = {
  getAppState: () => ({ mcp: { clients: [] } }),
  setAppState: () => {},
} as unknown as LocalJSXCommandContext

afterEach(() => setCyberModeEnabled(false))

test('command enables, reports status and disables session mode', async () => {
  expect((await call('on', context))).toMatchObject({ type: 'text', value: expect.stringContaining('Cyber mode: ON') })
  expect(getCyberMode().enabled).toBe(true)
  expect((await call('status', context))).toMatchObject({ value: expect.stringContaining('scoped requests only') })
  expect((await call('off', context))).toMatchObject({ value: expect.stringContaining('Cyber mode: OFF') })
  expect(getCyberMode().enabled).toBe(false)
})

test('command rejects invalid arguments and disabled escalation', async () => {
  expect((await call('oops', context))).toMatchObject({ value: expect.stringContaining('Usage:') })
  await expect(call('escalate', context)).rejects.toThrow('Enable /cyber')
})

test('pane and profile-bound teammates inherit mode but not the lead model', () => {
  setCyberModeEnabled(true)
  expect(buildInheritedCliFlags()).not.toContain('--model glm-5.3')
  expect(buildInheritedEnvVars()).toContain('OPENCLAUDE_CYBER_MODE=1')
  expect(buildInheritedEnvVars({ OPENCLAUDE_TEAMMATE_PROFILE_ID: 'profile' })).toContain('OPENCLAUDE_CYBER_MODE=1')
  setCyberModeEnabled(false)
  expect(buildInheritedEnvVars()).toContain('OPENCLAUDE_CYBER_MODE=0')
})
