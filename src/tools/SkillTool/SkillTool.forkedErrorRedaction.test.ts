import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../commands.js'
import { AbortError, isAbortError } from '../../utils/errors.js'
import { createAssistantMessage } from '../../utils/messages.js'

// A forked skill runs a sub-agent. If that agent's provider call fails, the
// thrown error carries the provider's response body and becomes the tool error
// the model sees and the lead's transcript stores. It is redacted at this
// rethrow; an abort passes through untouched so interruption handling works.

type RunAgentModule = typeof import('../AgentTool/runAgent.js')
let actualRunAgent: RunAgentModule | undefined
let thrown: unknown

const BODY = JSON.stringify({
  error: { message: 'bad', 'chatgpt-account-id': 'acct-SECRETACCT99', api_key: 'sk-SECRETOPENAIKEY12345678' },
})

beforeEach(async () => {
  actualRunAgent ??= await import(
    `../AgentTool/runAgent.ts?skillForkedActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    runAgent: async function* () {
      throw thrown
    },
  }))
})

afterEach(() => {
  mock.restore()
})

const command = {
  type: 'prompt',
  name: 'forked-skill',
  description: 'd',
  progressMessage: 'p',
  contentLength: 0,
  source: 'builtin',
  context: 'fork',
  async getPromptForCommand() {
    return [{ type: 'text', text: 'do it' }]
  },
} as unknown as Command & { type: 'prompt' }

function context(): ToolUseContext {
  const agent = {
    agentType: 'general-purpose',
    source: 'built-in',
    whenToUse: 'x',
    getSystemPrompt: () => 'You work.',
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default', alwaysAllowRules: {} } }),
    setAppState: () => {},
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [],
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [agent], allAgents: [agent] },
      mainLoopModel: 'gpt-4o',
    },
    messages: [],
  } as unknown as ToolUseContext
}

async function runForked(error: unknown) {
  thrown = error
  const { executeForkedSkill } = await import(
    `./SkillTool.ts?skillForked=${Date.now()}-${Math.random()}`
  )
  const canUseTool = (async () => ({ behavior: 'allow' })) as never
  try {
    await executeForkedSkill(
      command,
      'forked-skill',
      undefined,
      context(),
      canUseTool,
      createAssistantMessage({ content: 'run' }),
    )
  } catch (caught) {
    return caught
  }
  throw new Error('executeForkedSkill did not throw')
}

test('a forked skill whose agent throws a provider error rethrows it redacted', async () => {
  const original = new Error(`API Error: 400 ${BODY}`)
  const caught = (await runForked(original)) as Error
  expect(caught).toBeInstanceOf(Error)
  expect(caught).not.toBe(original)
  expect(caught.message).toContain('API Error: 400')
  expect(caught.message).not.toContain('SECRETACCT99')
  expect(caught.message).not.toContain('SECRETOPENAIKEY')
  expect(caught.stack).not.toContain('SECRETACCT99')
  // The original is untouched.
  expect(original.message).toContain('SECRETACCT99')
})

test('a forked skill interrupted by the user rethrows the very same abort error', async () => {
  const abort = new AbortError(`interrupted ${BODY}`)
  const caught = await runForked(abort)
  expect(caught).toBe(abort)
  expect(isAbortError(caught)).toBe(true)
})
