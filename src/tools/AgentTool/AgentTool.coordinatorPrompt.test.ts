import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'

// The Agent tool description must follow the REAL supervisor gate,
// isCoordinatorMode(). Supervision is on by default — CLAUDE_CODE_COORDINATOR_MODE
// is unset — so the old isEnvTruthy(env) check handed every default supervisor
// session the full, fork-heavy description instead of the slim one.

type CoordinatorModule = typeof import('../../coordinator/coordinatorMode.js')

let originalCoordinatorModule: CoordinatorModule | undefined
const SAVED_MODE = process.env.CLAUDE_CODE_COORDINATOR_MODE

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/AgentTool.coordinatorPrompt.test.ts',
  )
  delete process.env.CLAUDE_CODE_COORDINATOR_MODE
})

afterEach(() => {
  try {
    mock.restore()
    if (originalCoordinatorModule) {
      mock.module('../../coordinator/coordinatorMode.js', () => ({
        ...originalCoordinatorModule!,
      }))
    }
    if (SAVED_MODE === undefined) {
      delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    } else {
      process.env.CLAUDE_CODE_COORDINATOR_MODE = SAVED_MODE
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function renderAgentToolPrompt(coordinator: boolean): Promise<string> {
  const stamp = `${Date.now()}-${Math.random()}`
  originalCoordinatorModule ??= await import(
    `../../coordinator/coordinatorMode.ts?agentToolCoordinatorActual=${stamp}`
  )
  mock.module('../../coordinator/coordinatorMode.js', () => ({
    ...originalCoordinatorModule!,
    isCoordinatorMode: () => coordinator,
  }))
  const { AgentTool } = await import(
    `./AgentTool.js?agentToolCoordinatorPrompt=${stamp}`
  )
  return AgentTool.prompt({
    agents: [],
    tools: [],
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  } as never)
}

test('a default supervisor session (env unset) gets the slim description', async () => {
  expect(process.env.CLAUDE_CODE_COORDINATOR_MODE).toBeUndefined()
  const prompt = await renderAgentToolPrompt(true)
  expect(prompt).toContain('Launch a new agent')
  expect(prompt).not.toContain('Usage notes:')
})

test('a non-supervisor session gets the full description', async () => {
  const prompt = await renderAgentToolPrompt(false)
  expect(prompt).toContain('Usage notes:')
})
