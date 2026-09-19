import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { quote } from '../bash/shellQuote.js'
import {
  applyTeammateModelFlag,
  buildInheritedCliFlags,
  buildInheritedEnvVars,
} from './spawnUtils.js'

/** Codex/OAuth provider env as resolveProviderProfileEnv emits it. */
const CODEX_PROVIDER_ENV = {
  OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  OPENAI_MODEL: 'codexplan',
  CLAUDE_CODE_USE_OPENAI: '1',
}

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

test('applyTeammateModelFlag replaces an inherited --model with the teammate model', () => {
  const flags = applyTeammateModelFlag(
    '--model leader-model --teammate-mode tmux',
    { model: 'glm-5.3-flash' },
  )

  expect(flags).toBe('--teammate-mode tmux --model glm-5.3-flash')
})

test('applyTeammateModelFlag emits no --model for a profile-bound spawn with no model', () => {
  // The binding's OPENAI_MODEL is the child's model. A --model on the command
  // line beats the env var, so there must be none — not even the inherited
  // one a leader started with --model would otherwise propagate.
  const flags = applyTeammateModelFlag(
    '--model claude-opus-5 --teammate-mode tmux',
    { providerEnv: CODEX_PROVIDER_ENV },
  )

  expect(flags).toBe('--teammate-mode tmux')
  expect(flags).not.toContain('--model')
})

test('applyTeammateModelFlag honours an explicit model alongside a binding', () => {
  // An explicit argument overrides the binding's default: the spawn guard's
  // remedy for an unroutable codex model is "bind it with provider_profile",
  // which requires profile + model to be a working combination.
  const flags = applyTeammateModelFlag('--teammate-mode tmux', {
    model: 'gpt-5.6-sol',
    providerEnv: CODEX_PROVIDER_ENV,
  })

  expect(flags).toBe('--teammate-mode tmux --model gpt-5.6-sol')
})

test('applyTeammateModelFlag leaves an unbound modelless spawn untouched', () => {
  const inherited = '--model leader-model --teammate-mode tmux'

  expect(applyTeammateModelFlag(inherited, {})).toBe(inherited)
  expect(
    applyTeammateModelFlag(inherited, {
      providerEnv: { OPENAI_BASE_URL: 'https://example.invalid' },
    }),
  ).toBe(inherited)
})

/** The argv a real /bin/sh produces from a flag string. */
function shellArgvOf(flags: string): string[] {
  const printed = execFileSync(
    '/bin/sh',
    ['-c', `/usr/bin/printf '%s\\n' ${flags}`],
    { encoding: 'utf8', env: {} },
  )
  return printed.split('\n').filter(line => line !== '')
}

test('applyTeammateModelFlag strips a quoted inherited model without corrupting the command', () => {
  // Regression: the strip split on ' ' and dropped ONE token after --model,
  // so a value containing a space left its tail plus an unbalanced quote
  // spliced into the spawn command. quote() emits this form for any model
  // whose value contains whitespace.
  const inherited = `--model ${quote(['my custom model'])} --teammate-mode tmux`

  const flags = applyTeammateModelFlag(inherited, {
    providerEnv: CODEX_PROVIDER_ENV,
  })

  expect(flags).toBe('--teammate-mode tmux')
  expect(flags).not.toContain('custom')
  expect(flags).not.toContain("'")
  expect(shellArgvOf(flags)).toEqual(['--teammate-mode', 'tmux'])
})

test('applyTeammateModelFlag strips every quoting shape quote() can emit', () => {
  // All four shapes, confirmed against shell-quote: bare, backslash-escaped,
  // single-quoted, double-quoted. The last three defeated the space-split.
  for (const value of [
    'plain-model',
    'claude-opus-5[1m]',
    'my custom model',
    "it's",
    'o p u s[1m]',
  ]) {
    const inherited = `--permission-mode auto --model ${quote([value])} --teammate-mode tmux`

    const flags = applyTeammateModelFlag(inherited, {
      providerEnv: CODEX_PROVIDER_ENV,
    })

    expect(flags).toBe('--permission-mode auto --teammate-mode tmux')
    expect(shellArgvOf(flags)).toEqual([
      '--permission-mode',
      'auto',
      '--teammate-mode',
      'tmux',
    ])
  }
})

test('applyTeammateModelFlag replaces a quoted inherited model with the teammate model', () => {
  const inherited = `--model ${quote(['my custom model'])} --teammate-mode tmux`

  const flags = applyTeammateModelFlag(inherited, { model: 'codex-target' })

  expect(shellArgvOf(flags)).toEqual([
    '--teammate-mode',
    'tmux',
    '--model',
    'codex-target',
  ])
  expect(flags).not.toContain('custom')
})

test('applyTeammateModelFlag leaves a non-model value containing a space intact', () => {
  // The value token is consumed positionally, so a --settings path with a
  // space must survive the strip whole.
  const inherited = `--settings ${quote(['/path with space/x.json'])} --model old-model`

  const flags = applyTeammateModelFlag(inherited, {
    providerEnv: CODEX_PROVIDER_ENV,
  })

  expect(shellArgvOf(flags)).toEqual(['--settings', '/path with space/x.json'])
})

test('applyTeammateModelFlag emits exactly one --model', () => {
  const inherited = '--model a --teammate-mode tmux --model b'

  const flags = applyTeammateModelFlag(inherited, { model: 'only-this' })

  expect(flags.match(/--model/g)).toEqual(['--model'])
  expect(shellArgvOf(flags)).toEqual([
    '--teammate-mode',
    'tmux',
    '--model',
    'only-this',
  ])
})

test('applyTeammateModelFlag shell-quotes the model it emits', () => {
  const flags = applyTeammateModelFlag('', { model: 'weird model$HOME' })

  const printed = execFileSync(
    '/bin/sh',
    ['-c', `/bin/echo ${flags.replace('--model ', '')}`],
    { encoding: 'utf8', env: {} },
  )

  expect(printed).toBe('weird model$HOME\n')
})
