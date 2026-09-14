import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import {
  initialPermissionModeFromCLI,
  isImplicitBypassPermissionsAvailable,
} from './permissionSetup.js'

const SAVED = {
  OPENCLAUDE_DEFAULT_YOLO: process.env.OPENCLAUDE_DEFAULT_YOLO,
  CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
}

beforeEach(() => {
  // Isolate user settings: a real ~/.openclaude/settings.json with
  // permissions.defaultMode would outrank the implicit default under test.
  setClaudeConfigHomeDirForTesting(mkdtempSync(join(tmpdir(), 'oc-perm-')))
})

afterEach(() => {
  setClaudeConfigHomeDirForTesting(undefined)
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('an unconfigured session defaults to bypassPermissions', () => {
  expect(isImplicitBypassPermissionsAvailable({})).toBe(true)

  expect(
    initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    }).mode,
  ).toBe('bypassPermissions')
})

test('an explicit mode still wins over the implicit default', () => {
  // The implicit bypass is the LAST candidate, so every explicit choice — the
  // one that asks for prompts back — outranks it.
  for (const cli of ['default', 'plan', 'acceptEdits'] as const) {
    expect(
      initialPermissionModeFromCLI({
        permissionModeCli: cli,
        dangerouslySkipPermissions: undefined,
      }).mode,
    ).toBe(cli)
  }
})

test('OPENCLAUDE_DEFAULT_YOLO=0 restores prompting', () => {
  for (const off of ['0', 'false', 'no', 'off'] as const) {
    expect(
      isImplicitBypassPermissionsAvailable({ OPENCLAUDE_DEFAULT_YOLO: off }),
    ).toBe(false)
  }
  expect(
    isImplicitBypassPermissionsAvailable({ OPENCLAUDE_DEFAULT_YOLO: '1' }),
  ).toBe(true)

  process.env.OPENCLAUDE_DEFAULT_YOLO = '0'
  expect(
    initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    }).mode,
  ).toBe('default')
})

test('remote sessions never get the implicit bypass', () => {
  // CLAUDE_CODE_REMOTE already refuses a bypassPermissions defaultMode from
  // settings; the implicit one must not walk in behind it.
  expect(
    isImplicitBypassPermissionsAvailable({ CLAUDE_CODE_REMOTE: '1' }),
  ).toBe(false)

  process.env.CLAUDE_CODE_REMOTE = '1'
  expect(
    initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    }).mode,
  ).toBe('default')
})

test('root without a sandbox keeps prompting instead of exiting at startup', () => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return
  }
  const realGetuid = process.getuid.bind(process)
  // setup.ts exits the process when a bypass mode is active as root, so the
  // implicit default must stand down there — only an explicit --yolo earns
  // that error.
  process.getuid = () => 0
  try {
    expect(isImplicitBypassPermissionsAvailable({})).toBe(false)
    expect(isImplicitBypassPermissionsAvailable({ IS_SANDBOX: '1' })).toBe(true)
    expect(
      isImplicitBypassPermissionsAvailable({ CLAUDE_CODE_BUBBLEWRAP: '1' }),
    ).toBe(true)
  } finally {
    process.getuid = realGetuid
  }
})
