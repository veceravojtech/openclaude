import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from './Tool.js'
import * as realAgentSdkTypes from './entrypoints/agentSdkTypes.js'
import * as realLspManager from './services/lsp/manager.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

let lspConnected = false
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'StreamStalled',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TeammateIdleTimeout',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

await acquireSharedMutationLock('tools.lsp.test.ts')

// Captured at module scope BEFORE any mock.module() call. Bun mutates the live
// namespace of a mocked module IN PLACE and mock.restore() does not undo
// mock.module(), so these copies are the only handle on the real exports.
const pristineRealAgentSdkTypes = { ...realAgentSdkTypes }
const pristineRealLspManager = { ...realLspManager }

// Spread the pristine namespace: overriding HOOK_EVENTS alone would make the
// other 17 exports of agentSdkTypes.js (query, tool, createSdkMcpServer, the
// session helpers, ...) undefined for every file loaded after this one.
// Both spellings are separate registry entries and both must be covered.
mock.module('./entrypoints/agentSdkTypes.js', () => ({
  ...pristineRealAgentSdkTypes,
  HOOK_EVENTS,
}))
mock.module('src/entrypoints/agentSdkTypes.js', () => ({
  ...pristineRealAgentSdkTypes,
  HOOK_EVENTS,
}))

mock.module('./services/lsp/manager.js', () => ({
  // Spread first so _resetLspManagerForTesting survives; the overrides below
  // are what this suite actually needs to control.
  ...pristineRealLspManager,
  getInitializationStatus: () => ({ status: 'success' }),
  getLspServerManager: () => undefined,
  initializeLspServerManager: async () => {},
  isLspConnected: () => lspConnected,
  reinitializeLspServerManager: () => {},
  resetLspServerManagerForTesting: () => {},
  shutdownLspServerManager: async () => {},
  waitForInitialization: async () => {},
}))

const { getAllBaseTools, getTools } = await import('./tools.js')

afterAll(() => {
  try {
    // mock.restore() does NOT undo mock.module(), so re-register every
    // specifier from the pristine snapshots, under the EXACT spellings they
    // were mocked with — each spelling is its own registry entry.
    mock.restore()
    mock.module('./entrypoints/agentSdkTypes.js', () => ({
      ...pristineRealAgentSdkTypes,
    }))
    mock.module('src/entrypoints/agentSdkTypes.js', () => ({
      ...pristineRealAgentSdkTypes,
    }))
    mock.module('./services/lsp/manager.js', () => ({
      ...pristineRealLspManager,
    }))
  } finally {
    releaseSharedMutationLock()
  }
})

beforeEach(() => {
  lspConnected = false
})

test('LSPTool is part of the base tool pool', () => {
  expect(getAllBaseTools().map(tool => tool.name)).toContain('LSP')
})

test('LSPTool is filtered from usable tools until a server is connected', () => {
  const permissionContext = getEmptyToolPermissionContext()

  expect(getTools(permissionContext).map(tool => tool.name)).not.toContain('LSP')

  lspConnected = true

  expect(getTools(permissionContext).map(tool => tool.name)).toContain('LSP')
})
