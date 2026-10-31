import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { ToolUseContext } from '../../Tool.js'

// Captured before any mock.module call, and spread rather than handed back as
// the namespace object itself: mock.module mutates the registration in place,
// so returning the namespace would re-install the stub instead of undoing it.
const realSessionStorage = {
  ...(await import('../../utils/sessionStorage.js')),
}
const realQuery = { ...(await import('../../query.js')) }

// Track how many times each storage function is called
let metadataWriteCount = 0
let transcriptWriteCount = 0

beforeEach(() => {
  metadataWriteCount = 0
  transcriptWriteCount = 0
})

afterEach(() => {
  mock.restore()
  // mock.restore() does not undo mock.module(): without this the stubs below
  // stayed installed for every later file in the sweep, so a later suite that
  // imported getProjectDir from sessionStorage failed to link.
  mock.module('../../utils/sessionStorage.js', () => ({
    ...realSessionStorage,
  }))
  mock.module('../../query.js', () => ({ ...realQuery }))
})

async function importRunAgentWithMocks() {
  const sessionStorageMock = {
    writeAgentMetadata: async () => {
      metadataWriteCount++
      throw new Error('Simulated disk error during metadata write')
    },
    recordSidechainTranscript: async () => {
      transcriptWriteCount++
    },
    getAgentMetadataPath: () => '/mock/path',
  }

  const queryMock = {
    query: async function* () {
      yield {
        type: 'assistant',
        uuid: 'msg-1',
        message: { role: 'assistant', content: 'test' },
      }
      yield {
        reason: 'done',
      }
    },
  }

  // Override only what this test observes; runAgent imports more than these
  // from both modules (e.g. getProjectDir), so a bare stub failed to link.
  mock.module('../../utils/sessionStorage.js', () => ({
    ...realSessionStorage,
    ...sessionStorageMock,
  }))
  mock.module('../../query.js', () => ({ ...realQuery, ...queryMock }))

  const module = await import(`./runAgent.js?persistence=${Date.now()}-${Math.random()}`)
  return module.runAgent
}

test('skips transcript write if identity metadata fails to persist', async () => {
  const runAgent = await importRunAgentWithMocks()

  const agentDefinition: AgentDefinition = {
    agentType: 'code-reviewer',
    source: 'built-in',
  } as AgentDefinition

  const toolUseContext = {
    options: {
      mainLoopModel: 'test-model',
      agentDefinitions: { activeAgents: [agentDefinition] },
      tools: [],
    },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map() },
    }),
    setAppState: () => {},
  } as unknown as ToolUseContext

  const runParams = {
    agentId: 'test-agent' as any,
    agentDefinition,
    prompt: 'review this',
    promptMessages: [{ role: 'user', content: 'review this' }],
    toolUseContext,
    override: {
      abortController: new AbortController(),
    },
    querySource: 'subagent',
    canUseTool: async () => ({ behavior: 'allow' } as any),
    availableTools: [],
    allowedTools: undefined,
  } as any

  const iterator = runAgent(runParams)
  let chunkCount = 0
  for await (const _ of iterator) {
    chunkCount++
  }

  // The generator should still produce output despite the storage error
  expect(chunkCount).toBeGreaterThan(0)

  // We should have attempted to write metadata and failed
  expect(metadataWriteCount).toBe(1)

  // The transcript writes should have been skipped to prevent an orphaned transcript
  expect(transcriptWriteCount).toBe(0)
})
