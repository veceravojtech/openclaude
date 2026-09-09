import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { DISABLE_AGENT_TEAMS_ENV, isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

const ENV_KEYS = [
  DISABLE_AGENT_TEAMS_ENV,
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'USER_TYPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/agentSwarmsEnabled.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('Agent Teams are on by default, with no env var or flag', () => {
  expect(isAgentSwarmsEnabled()).toBe(true)
})

test('CLAUDE_CODE_DISABLE_AGENT_TEAMS turns them off, even for ant builds', () => {
  process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
  expect(isAgentSwarmsEnabled()).toBe(false)
  process.env.USER_TYPE = 'ant'
  expect(isAgentSwarmsEnabled()).toBe(false)
})

test('a falsy opt-out value leaves them on', () => {
  process.env[DISABLE_AGENT_TEAMS_ENV] = '0'
  expect(isAgentSwarmsEnabled()).toBe(true)
  process.env[DISABLE_AGENT_TEAMS_ENV] = 'false'
  expect(isAgentSwarmsEnabled()).toBe(true)
})

test('the former opt-in env var is accepted and changes nothing', () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  expect(isAgentSwarmsEnabled()).toBe(true)
  process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
  expect(isAgentSwarmsEnabled()).toBe(false)
})
