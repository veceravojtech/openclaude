import { beforeEach, expect, mock, test } from 'bun:test'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resumeAgentBackground } from './resumeAgent.js'

let mockTranscript: any = {
  messages: [],
  contentReplacements: [],
}

let mockMetadata: any = {
  agentType: 'code-reviewer',
  source: 'built-in',
}

mock.module('../../utils/sessionStorage.js', () => ({
  getAgentTranscript: async () => mockTranscript,
  readAgentMetadata: async () => mockMetadata,
  writeAgentMetadata: async () => {},
  // Used by the real registerAsyncAgent for the task-output symlink target.
  getAgentTranscriptPath: (agentId: string) => `/tmp/${agentId}.jsonl`,
}))

mock.module('./agentToolUtils.js', () => ({
  runAsyncAgentLifecycle: async () => {},
}))

beforeEach(() => {
  mockTranscript = {
    messages: [],
    contentReplacements: [],
  }
  mockMetadata = {
    agentType: 'code-reviewer',
    source: 'built-in',
  }
})

function makeToolUseContext(
  activeAgents: AgentDefinition[],
  tasks: Record<string, unknown> = {},
): ToolUseContext {
  // A real (if minimal) store: registerAsyncAgent writes the resumed task
  // back through setAppState, and that write is what the resume-counter
  // tests assert on.
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
    speculation: { status: 'idle' },
    tasks,
  }

  return {
    options: {
      agentDefinitions: { activeAgents, allAgents: activeAgents },
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
    getAppState: () => appState,
    setAppState: (f: (prev: unknown) => Record<string, unknown>) => {
      appState = f(appState)
    },
    contentReplacementState: { replacements: new Map() },
  } as unknown as ToolUseContext
}

/** The local_agent task the context's store holds for `agentId`. */
function registeredTask(
  context: ToolUseContext,
  agentId: string,
): LocalAgentTaskState | undefined {
  const tasks = (context.getAppState() as unknown as {
    tasks: Record<string, LocalAgentTaskState>
  }).tasks
  return tasks[agentId]
}

test('fails closed when resuming an unavailable agent instead of falling back', async () => {
  const context = makeToolUseContext([]) // Empty active agents list, so code-reviewer is unavailable

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: type 'code-reviewer' is unavailable or disabled in the current session."
  )
})

test('successfully resumes when agent is available', async () => {
  const codeReviewer = {
    agentType: 'code-reviewer',
    source: 'built-in',
    getSystemPrompt: () => 'review code',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([codeReviewer])

  const result = await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(result.agentId).toBe('test-agent')
})

test('rejects resume when agent definition source does not match metadata', async () => {
  mockMetadata = {
    agentType: 'code-reviewer',
    source: 'built-in', // Originally launched as a built-in
  }

  // A custom agent was added to the project that shadows the built-in name
  const customReviewer = {
    agentType: 'code-reviewer',
    source: 'projectSettings', // Different source
    getSystemPrompt: () => 'review code differently',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([customReviewer])

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: identity mismatch. Expected source 'built-in', found 'projectSettings' for type 'code-reviewer'."
  )
})

test('rejects resume when legacy metadata lacks a source', async () => {
  mockMetadata = {
    agentType: 'code-reviewer',
    // Legacy metadata lacks a source field
  }

  const codeReviewer = {
    agentType: 'code-reviewer',
    source: 'built-in',
    getSystemPrompt: () => 'review code',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([codeReviewer])

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: identity mismatch. Expected source 'undefined', found 'built-in' for type 'code-reviewer'."
  )
})

test('successfully resumes when legacy metadata lacks a source and agent is not built-in', async () => {
  mockMetadata = {
    agentType: 'custom-agent',
    // Legacy metadata lacks a source field
  }

  const customAgent = {
    agentType: 'custom-agent',
    source: 'projectSettings', // Non-built-in source
    getSystemPrompt: () => 'do custom work',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([customAgent])

  const result = await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(result.agentId).toBe('test-agent')
})

// A resume re-registers under the SAME agentId, so the resumed run's
// completion notification collides with the original's unless it carries a
// discriminator. resumeAgentBackground derives it from the prior task.
const CODE_REVIEWER = {
  agentType: 'code-reviewer',
  source: 'built-in',
  getSystemPrompt: () => 'review code',
} as unknown as AgentDefinition

function priorAgentTask(resumeCount?: number): Record<string, unknown> {
  return {
    id: 'test-agent',
    type: 'local_agent',
    status: 'completed',
    agentId: 'test-agent',
    notified: true,
    ...(resumeCount === undefined ? {} : { resumeCount }),
  }
}

test('first resume registers with resumeCount 1 when the prior run has none', async () => {
  const context = makeToolUseContext([CODE_REVIEWER], {
    'test-agent': priorAgentTask(),
  })

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.resumeCount).toBe(1)
})

test('a second resume increments the count instead of flipping a flag', async () => {
  const context = makeToolUseContext([CODE_REVIEWER], {
    'test-agent': priorAgentTask(1),
  })

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue again',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.resumeCount).toBe(2)
})

test('a third resume reaches 3', async () => {
  const context = makeToolUseContext([CODE_REVIEWER], {
    'test-agent': priorAgentTask(2),
  })

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'once more',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.resumeCount).toBe(3)
})

test('resuming with no prior task in AppState still counts as resume 1', async () => {
  const context = makeToolUseContext([CODE_REVIEWER])

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.resumeCount).toBe(1)
})

test('re-registering the resumed run clears notified so it can notify again', async () => {
  const context = makeToolUseContext([CODE_REVIEWER], {
    'test-agent': priorAgentTask(),
  })

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.notified).toBe(false)
})

// The resumed run must not claim the tool call that spawned the ORIGINAL run.
// That call already has its own tool_result, and a user-initiated resume has no
// originating tool call at all — see the comment at the registerAsyncAgent call
// in resumeAgent.ts for the two readers this protects.
test('a user-initiated resume does not inherit the original run tool_use_id', async () => {
  const context = makeToolUseContext([CODE_REVIEWER], {
    // The prior run was spawned by an Agent(...) call and still remembers it.
    'test-agent': { ...priorAgentTask(), toolUseId: 'toolu_original_agent' },
  })
  // REPL.tsx builds this context via getToolUseContext, which sets no
  // toolUseId — the resume request came from the user, not from a tool call.
  expect(context.toolUseId).toBeUndefined()

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.toolUseId).toBeUndefined()
})

test('a tool-driven resume records the resuming call, not the original run', async () => {
  // SendMessageTool passes its own execution context, and toolExecution.ts
  // injects that call's id — so the resume is attributed to SendMessage.
  const context = {
    ...makeToolUseContext([CODE_REVIEWER], {
      'test-agent': { ...priorAgentTask(1), toolUseId: 'toolu_original_agent' },
    }),
    toolUseId: 'toolu_send_message',
  } as ToolUseContext

  await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(registeredTask(context, 'test-agent')?.toolUseId).toBe(
    'toolu_send_message',
  )
})
