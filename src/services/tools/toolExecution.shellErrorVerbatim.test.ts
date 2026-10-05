import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { ShellError } from '../../utils/errors.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { formatError } from '../../utils/toolErrors.js'
import { runToolUse } from './toolExecution.js'

// Generic tool output is not provider text. A failing command's stdout/stderr
// (a test run, a compiler error, a stack trace) must reach the model exactly as
// the command produced it: scrubbing names that look like secrets would hide
// the very text the model needs to fix the failure, and would protect nothing
// (the same output from a command that exits 0 is not scrubbed either).
// Provider text is redacted where it enters a tool error, not in this catch.

const FAILING_OUTPUT = [
  "NameError: name 'acct_number' is not defined",
  'at /srv/acct-service/config/app.yaml:12',
  'Cannot find module node_modules/sk-learn-wrapper-thing/index.js',
  'src/client.ts(14,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  '14 |     headers: { Authorization: `Bearer ${token}` },',
  '  Expected: {"password": "hunter2"}',
  '  Received: {"password": "hunter3"}',
  'GET http://Example.COM:80/a/../b?x=1 -> 500',
].join('\n')

const inputSchema = z.object({ command: z.string() })

function failingBashTool(error: Error) {
  return buildTool({
    name: BASH_TOOL_NAME,
    inputSchema,
    maxResultSizeChars: Infinity,
    async description() {
      return 'Run a command'
    },
    async prompt() {
      return ''
    },
    async call() {
      throw error
    },
    mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseID, content }
    },
    renderToolUseMessage() {
      return null
    },
    renderToolResultMessage() {
      return null
    },
  })
}

function contextFor(tool: ReturnType<typeof failingBashTool>): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      sessionHooks: new Map(),
      settings: {},
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [tool],
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      mainLoopModel: 'gpt-4o',
    },
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

test('a failing Bash command reaches the model and the transcript exactly as formatError renders it', async () => {
  const error = new ShellError(FAILING_OUTPUT, 'stderr: AWS_PROFILE=acct-prod-account', 1, false)
  const tool = failingBashTool(error)
  const toolUse = {
    type: 'tool_use',
    id: 'toolu_shell',
    name: BASH_TOOL_NAME,
    input: { command: 'npm test' },
  } as ToolUseBlock
  const canUseTool: CanUseToolFn = async (_tool, input) => ({
    behavior: 'allow',
    updatedInput: input,
  })
  const updates: Array<{ message?: { type: string; message: { content: unknown[] }; toolUseResult?: unknown } }> = []
  for await (const update of runToolUse(
    toolUse,
    createAssistantMessage({ content: 'run' }),
    canUseTool,
    contextFor(tool),
  )) {
    updates.push(update as never)
  }
  const result = updates
    .map(update => update.message)
    .find(message => message?.type === 'user' && JSON.stringify(message).includes('"is_error":true'))
  expect(result).toBeDefined()

  const expected = formatError(error)
  // The fixture is the raw text, so the equality below is not vacuous.
  for (const fragment of ['acct_number', 'acct-service', 'sk-learn-wrapper-thing', 'Bearer ${token}', 'hunter2', 'hunter3', 'Example.COM:80/a/../b?x=1']) {
    expect(expected).toContain(fragment)
  }
  const block = result!.message.content[0] as { content: string }
  expect(block.content).toBe(expected)
  expect(result!.toolUseResult).toBe(`Error: ${expected}`)
})
