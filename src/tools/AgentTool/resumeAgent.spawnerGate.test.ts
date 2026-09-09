import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { enqueueAgentNotification } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import {
  getAgentId,
  getDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import {
  createTeammateContext,
  isInProcessTeammate,
  runWithTeammateContext,
} from '../../utils/teammateContext.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Who a background agent's completion is addressed to is decided by ONE
// expression at each spawn site, and the gate on it is `isInProcessTeammate()`
// — AsyncLocalStorage — not "getAgentId() resolved to something".
//
// The difference is a whole backend. A pane/tmux teammate is a separate claude
// process launched with `--agent-id <name@team>` (PaneBackendExecutor.ts), and
// main.tsx turns those flags into a dynamicTeamContext, so getAgentId() answers
// `name@team` on that process's MAIN thread. Nothing there ever drains an
// addressed command: every main-thread drain requires `agentId === undefined`
// (query.ts, cli/print.ts, queueProcessor.ts, handlePromptSubmit.ts) and only an
// in-process teammate runs the poll loop that takes its own id. Stamping the
// pane teammate's identity would therefore orphan the very notification the
// stamp exists to deliver — and inside tmux the pane backend is the default
// (swarm/backends/registry.ts).
//
// No other test in the suite populates dynamicTeamContext, so this file is the
// only thing standing between that gate and a silent regression.

type ResumeAgentModule = typeof import('./resumeAgent.js')
type SessionStorageModule = typeof import('../../utils/sessionStorage.js')
type AgentToolUtilsModule = typeof import('./agentToolUtils.js')

let originalSessionStorageModule: SessionStorageModule | undefined
let originalAgentToolUtilsModule: AgentToolUtilsModule | undefined
let previousDynamicTeamContext: ReturnType<typeof getDynamicTeamContext>

const AGENT_ID = 'test-agent'
const DESCRIPTION = 'resumed run'
// A pane/tmux teammate's identity, as main.tsx stores it from the CLI flags.
const PANE_AGENT_ID = 'pane-worker@some-team'
// An in-process teammate's identity: formatAgentId(name, team), the same field
// its own poll loop matches on.
const IN_PROCESS_AGENT_ID = asAgentId('researcher@my-team')

const CODE_REVIEWER = {
  agentType: 'code-reviewer',
  source: 'built-in',
  getSystemPrompt: () => 'review code',
} as unknown as AgentDefinition

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/resumeAgent.spawnerGate.test.ts',
  )
  previousDynamicTeamContext = getDynamicTeamContext()
  setDynamicTeamContext(null)
  resetCommandQueue()
})

afterEach(async () => {
  try {
    mock.restore()
    if (originalSessionStorageModule) {
      mock.module(
        '../../utils/sessionStorage.js',
        () => originalSessionStorageModule!,
      )
    }
    if (originalAgentToolUtilsModule) {
      mock.module('./agentToolUtils.js', () => originalAgentToolUtilsModule!)
    }
    // Process-global: leaving it set would hand every later test in the run a
    // teammate identity it never asked for.
    setDynamicTeamContext(previousDynamicTeamContext ?? null)
    resetCommandQueue()
  } finally {
    releaseSharedMutationLock()
  }
})

async function importActualSessionStorage(): Promise<SessionStorageModule> {
  return import(
    `../../utils/sessionStorage.ts?spawnerGateActual=${Date.now()}-${Math.random()}`
  )
}

async function importActualAgentToolUtils(): Promise<AgentToolUtilsModule> {
  return import(
    `./agentToolUtils.ts?spawnerGateActual=${Date.now()}-${Math.random()}`
  )
}

/**
 * Load resumeAgent with the transcript reader and the lifecycle runner stubbed:
 * the resume must reach registerAsyncAgent without touching disk or launching
 * a real agent.
 */
async function importResumeAgent(): Promise<ResumeAgentModule> {
  originalSessionStorageModule ??= await importActualSessionStorage()
  originalAgentToolUtilsModule ??= await importActualAgentToolUtils()

  mock.module('../../utils/sessionStorage.js', () => ({
    ...originalSessionStorageModule!,
    getAgentTranscript: async () => ({
      messages: [],
      contentReplacements: [],
    }),
    readAgentMetadata: async () => ({
      agentType: 'code-reviewer',
      source: 'built-in',
    }),
    writeAgentMetadata: async () => {},
    getAgentTranscriptPath: (agentId: string) => `/tmp/${agentId}.jsonl`,
  }))
  mock.module('./agentToolUtils.js', () => ({
    ...originalAgentToolUtilsModule!,
    runAsyncAgentLifecycle: async () => {},
  }))

  return import(`./resumeAgent.js?spawnerGate=${Date.now()}-${Math.random()}`)
}

/** A real (if minimal) store — registerAsyncAgent writes the task back into it. */
function makeToolUseContext(): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
    speculation: { status: 'idle' },
    tasks: {},
  }

  return {
    options: {
      agentDefinitions: {
        activeAgents: [CODE_REVIEWER],
        allAgents: [CODE_REVIEWER],
      },
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

function registeredTask(
  context: ToolUseContext,
  agentId: string,
): LocalAgentTaskState | undefined {
  const tasks = (
    context.getAppState() as unknown as {
      tasks: Record<string, LocalAgentTaskState>
    }
  ).tasks
  return tasks[agentId]
}

async function resume(context: ToolUseContext): Promise<void> {
  const { resumeAgentBackground } = await importResumeAgent()
  await resumeAgentBackground({
    agentId: AGENT_ID,
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' }) as never,
  })
}

/** Push the registered task's completion onto the queue and read it back. */
function notify(context: ToolUseContext) {
  enqueueAgentNotification({
    taskId: AGENT_ID,
    description: DESCRIPTION,
    status: 'completed',
    setAppState: context.setAppState,
  })
  return dequeueAll()
}

describe('the spawner stamp is gated on the in-process context, not on any id', () => {
  test('a pane/tmux teammate main thread leaves the completion unaddressed', async () => {
    setDynamicTeamContext({
      agentId: PANE_AGENT_ID,
      agentName: 'pane-worker',
      teamName: 'some-team',
      planModeRequired: false,
    })
    // The trap, stated: an identity IS resolvable here, so an ungated
    // `getAgentId()` would stamp it — but this is a plain main thread.
    expect(getAgentId()).toBe(PANE_AGENT_ID)
    expect(isInProcessTeammate()).toBe(false)

    const context = makeToolUseContext()
    await resume(context)

    expect(registeredTask(context, AGENT_ID)?.parentAgentId).toBeUndefined()

    const commands = notify(context)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.mode).toBe('task-notification')
    // Unaddressed — so this process's own REPL drain takes it, as it did
    // before background completions were addressed at all.
    expect(commands[0]!.agentId).toBeUndefined()
  })

  test('an in-process teammate is still addressed by its stable id', async () => {
    // The other half of the gate: it must not simply have turned the stamp
    // off. Inside a teammate's turn the poll loop is there to drain it.
    const context = makeToolUseContext()
    const teammate = createTeammateContext({
      agentId: IN_PROCESS_AGENT_ID,
      agentName: 'researcher',
      teamName: 'my-team',
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    })

    await runWithTeammateContext(teammate, async () => {
      expect(isInProcessTeammate()).toBe(true)
      await resume(context)
    })

    expect(registeredTask(context, AGENT_ID)?.parentAgentId).toBe(
      IN_PROCESS_AGENT_ID,
    )
    expect(notify(context)[0]!.agentId).toBe(IN_PROCESS_AGENT_ID)
  })

  test('a lead main thread with no team context is unchanged', async () => {
    expect(getAgentId()).toBeUndefined()

    const context = makeToolUseContext()
    await resume(context)

    expect(registeredTask(context, AGENT_ID)?.parentAgentId).toBeUndefined()
    expect(notify(context)[0]!.agentId).toBeUndefined()
  })

  test('the fresh-spawn site in AgentTool carries the same gate', () => {
    // AgentTool's async branch sits inside the tool's call() generator, which
    // no test drives; the expression is asserted at the source instead, in the
    // style of query/taskNotificationDrain.test.ts. Both spawn sites must move
    // together — a gate on only one of them still orphans half the paths.
    const source = readFileSync(
      join(import.meta.dir, 'AgentTool.tsx'),
      'utf8',
    ).replace(/\s+/g, ' ')

    expect(source).toContain(
      'const spawnerAgentId = isInProcessTeammate() ? getAgentId() : undefined',
    )
    // The fallback below it is deliberately untouched: a plain subagent still
    // gets its own turn id.
    expect(source).toContain(
      'parentAgentId: spawnerAgentId ? asAgentId(spawnerAgentId) : toolUseContext.agentId',
    )
  })
})
