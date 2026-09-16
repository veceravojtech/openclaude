import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getContentText } from '../messages.js'
import * as realShellToolUtils from '../shell/shellToolUtils.js'
import * as realResolveDefaultShell from '../shell/resolveDefaultShell.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the live
// namespace object in place, so re-importing the specifier later hands back the
// stub — the previous restore here re-registered the stub as if it were real.
const pristineRealShellToolUtils = { ...realShellToolUtils }
const pristineRealResolveDefaultShell = { ...realResolveDefaultShell }

// Force bash routing regardless of platform/env — processBashCommand
// consults isPowerShellToolEnabled() and resolveDefaultShell() at the
// top, and may route to PowerShellTool on Windows which defeats our
// BashTool.call stub.  mock.module is process-global in bun, so this
// must run BEFORE the import of processBashCommand.
// The pristine spread keeps SHELL_TOOL_NAMES defined for every later file.
mock.module('../shell/shellToolUtils.js', () => ({
  ...pristineRealShellToolUtils,
  isPowerShellToolEnabled: mock(() => false),
}))
mock.module('../shell/resolveDefaultShell.js', () => ({
  ...pristineRealResolveDefaultShell,
  resolveDefaultShell: mock((): 'bash' | 'powershell' => 'bash'),
}))
import { processBashCommand } from './processBashCommand.js'

const originalCall = BashTool.call

beforeEach(async () => {
  await acquireSharedMutationLock('utils/processUserInput/processBashCommand.test.tsx')
})

afterEach(() => {
  try {
    BashTool.call = originalCall
  } finally {
    releaseSharedMutationLock()
  }
})

// Both registrations are module-scope, so they are torn down once, at the end
// of the file — an afterEach teardown would strip the bash pin from every test
// after the first.
afterAll(() => {
  mock.module('../shell/shellToolUtils.js', () => ({
    ...pristineRealShellToolUtils,
  }))
  mock.module('../shell/resolveDefaultShell.js', () => ({
    ...pristineRealResolveDefaultShell,
  }))
})

function makeContext() {
  return {
    abortController: new AbortController(),
    options: {
      verbose: false,
      isNonInteractiveSession: false,
    },
    getAppState() {
      return {
        toolPermissionContext: getEmptyToolPermissionContext(),
      }
    },
  } as never
}

test('processBashCommand returns successful shell output as visible bash stdout', async () => {
  BashTool.call = (async () => ({
    data: {
      stdout: 'visible-1265\n',
      stderr: '',
      interrupted: false,
    },
  })) as unknown as typeof BashTool.call

  const result = await processBashCommand(
    'printf visible-1265',
    [],
    [],
    makeContext(),
    () => {},
  )

  expect(result.shouldQuery).toBe(false)

  const visibleText = result.messages
    .filter(message => message.type === 'user' && !message.isMeta)
    .map(message => getContentText(message.message.content))
    .join('\n')

  expect(visibleText).toContain('<bash-input>printf visible-1265</bash-input>')
  expect(visibleText).toContain('<bash-stdout>visible-1265')
})

test('processBashCommand preserves background task metadata', async () => {
  BashTool.call = (async () => ({
    data: {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: 'bg-review-1',
      backgroundedByUser: true,
    },
  })) as unknown as typeof BashTool.call

  const result = await processBashCommand(
    'sleep 60',
    [],
    [],
    makeContext(),
    () => {},
  )

  expect(result.shouldQuery).toBe(false)

  const visibleText = result.messages
    .filter(message => message.type === 'user' && !message.isMeta)
    .map(message => getContentText(message.message.content))
    .join('\n')

  expect(visibleText).toContain('Command was manually backgrounded by user')
  expect(visibleText).toContain('bg-review-1')
  expect(visibleText).toContain('Output is being written to:')
})
