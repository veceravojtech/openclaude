import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { buildInheritedCliFlags, buildInheritedEnvVars } from './spawnUtils.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/spawnUtils.test.ts')
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
  } finally {
    releaseSharedMutationLock()
  }
})

test('buildInheritedEnvVars marks spawned teammates as host-managed for provider routing', () => {
  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1')
})

test('buildInheritedEnvVars forwards pooled OpenAI credentials', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).toContain('OPENAI_API_KEYS=key-a\\,key-b')
})

test('buildInheritedEnvVars forwards the supported OpenAI base URL alias', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE = 'https://api.commandcode.ai/provider/v1'
  process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'
  process.env.CMD_API_KEY = 'cmd-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('OPENAI_API_BASE=')
  expect(envVars).toContain('api.commandcode.ai/provider/v1')
  expect(envVars).toContain('CMD_API_KEY=cmd-key')
  expect(envVars).toContain('OPENAI_MODEL=deepseek/deepseek-v4-flash')
})

test('buildInheritedEnvVars forwards an LLMTR credential without inventing route state', () => {
  process.env.LLMTR_API_KEY = 'llmtr-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('LLMTR_API_KEY=llmtr-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards a Command Code credential without inventing route state', () => {
  process.env.CMD_API_KEY = 'cmd-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CMD_API_KEY=cmd-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards the official Command Code credential alias', () => {
  process.env.COMMAND_CODE_API_KEY = 'official-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('COMMAND_CODE_API_KEY=official-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards PATH for source-built teammate tool lookups', () => {
  process.env.PATH = '/custom/bin:/usr/bin'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('PATH=')
  expect(envVars).toContain('/custom/bin\\:/usr/bin')
})

test('buildInheritedEnvVars appends per-spawn extras for a provider-pinned teammate', () => {
  const envVars = buildInheritedEnvVars({
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    OPENAI_MODEL: 'codexplan',
    CHATGPT_ACCOUNT_ID: 'acct-123',
  })

  expect(envVars).toContain('OPENAI_BASE_URL=')
  expect(envVars).toContain('chatgpt.com/backend-api/codex')
  expect(envVars).toContain('OPENAI_MODEL=codexplan')
  expect(envVars).toContain('CHATGPT_ACCOUNT_ID=acct-123')
})

test('buildInheritedEnvVars lets a per-spawn extra override an inherited allowlist value', () => {
  process.env.OPENAI_MODEL = 'inherited-model'

  const envVars = buildInheritedEnvVars({ OPENAI_MODEL: 'codexplan' })

  const inheritedIndex = envVars.indexOf('OPENAI_MODEL=inherited-model')
  const extraIndex = envVars.indexOf('OPENAI_MODEL=codexplan')

  expect(inheritedIndex).toBeGreaterThanOrEqual(0)
  // `env` applies assignments left to right, so the extra must come last to win.
  expect(extraIndex).toBeGreaterThan(inheritedIndex)
})

test('buildInheritedEnvVars skips empty per-spawn extras', () => {
  const envVars = buildInheritedEnvVars({
    CHATGPT_ACCOUNT_ID: '',
    OPENAI_MODEL: 'codexplan',
  })

  expect(envVars).not.toContain('CHATGPT_ACCOUNT_ID=')
  expect(envVars).toContain('OPENAI_MODEL=codexplan')
})

test('buildInheritedEnvVars shell-quotes a per-spawn extra so a real shell reads it back intact', () => {
  const rawValue = 'a b "c" $HOME'

  const envVars = buildInheritedEnvVars({ CODEX_SPAWN_PROBE: rawValue })

  const printed = execFileSync(
    '/bin/sh',
    ['-c', `/usr/bin/env ${envVars} /usr/bin/printenv CODEX_SPAWN_PROBE`],
    { encoding: 'utf8', env: {} },
  )

  expect(printed).toBe(`${rawValue}\n`)
})

test('buildInheritedEnvVars leaves a sibling spawn untouched by another teammate extras', () => {
  process.env.OPENAI_MODEL = 'inherited-model'

  const baseline = buildInheritedEnvVars()
  const pinned = buildInheritedEnvVars({ OPENAI_MODEL: 'codexplan' })
  const sibling = buildInheritedEnvVars()

  expect(sibling).toBe(baseline)
  expect(sibling).not.toContain('codexplan')
  expect(pinned).not.toBe(baseline)
})

test('buildInheritedCliFlags preserves fullAccess mode for spawned teammates', () => {
  process.env.NODE_ENV = 'test'
  const flags = buildInheritedCliFlags({ permissionMode: 'fullAccess' })

  expect(flags).toContain('--permission-mode fullAccess')
  expect(flags).not.toContain('--dangerously-skip-permissions')
})
