import { beforeEach, describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState } from '../../Task.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { asAgentId } from '../../types/ids.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'
import {
  enqueueAgentNotification,
  registerAsyncAgent,
} from './LocalAgentTask.js'

// The command queue is a process-global singleton shared by the coordinator
// and every in-process subagent/teammate, and each drain site filters it by
// `agentId`: the coordinator (query.ts, cli/print.ts, handlePromptSubmit.ts)
// takes only `agentId === undefined`, a subagent only its own id. So the stamp
// written here is the ONLY thing that decides whose context a background
// agent's completion lands in. Before this, every completion was unaddressed
// and went to the coordinator — including one a teammate had asked for.

const TASK_ID = 'agent-spawned-by-teammate'
const DESCRIPTION = 'Count the call sites'
// What a teammate's identity looks like: formatAgentId(name, team).
const TEAMMATE_AGENT_ID = asAgentId('researcher@my-team')
// What a plain subagent's turn id looks like: createAgentId().
const SUBAGENT_AGENT_ID = asAgentId('a0123456789abcdef')

function makeStore(tasks: Record<string, LocalAgentTaskState> = {}): {
  getState: () => AppState
  setAppState: SetAppState
} {
  let state = {
    tasks,
    speculation: { status: 'idle' },
  } as unknown as AppState
  return {
    getState: () => state,
    setAppState: (f => {
      state = f(state)
    }) as SetAppState,
  }
}

function agentTask(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: TASK_ID,
    type: 'local_agent',
    status: 'completed',
    description: DESCRIPTION,
    startTime: 1,
    outputFile: `/tmp/${TASK_ID}.output`,
    outputOffset: 0,
    notified: false,
    agentId: TASK_ID,
    prompt: 'count them',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as LocalAgentTaskState
}

/** Enqueue a completion for `task` and return the queued commands. */
function notify(
  task: LocalAgentTaskState,
  options: { finalMessage?: string; status?: 'completed' | 'failed' } = {},
) {
  const store = makeStore({ [TASK_ID]: task })
  enqueueAgentNotification({
    taskId: TASK_ID,
    description: DESCRIPTION,
    status: options.status ?? 'completed',
    setAppState: store.setAppState,
    finalMessage: options.finalMessage,
  })
  return dequeueAll()
}

describe('background-agent completion is addressed to its spawner', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  test('a task registered with parentAgentId enqueues with that agentId', () => {
    const commands = notify(
      agentTask({ parentAgentId: TEAMMATE_AGENT_ID }),
      { finalMessage: '17 call sites' },
    )

    expect(commands).toHaveLength(1)
    expect(commands[0]!.agentId).toBe(TEAMMATE_AGENT_ID)
    expect(commands[0]!.mode).toBe('task-notification')
  })

  test('a plain subagent turn id is carried through unchanged', () => {
    // Not a teammate: AgentTool falls back to toolUseContext.agentId, which is
    // the id the running subagent's own query.ts drain gate matches on.
    const commands = notify(agentTask({ parentAgentId: SUBAGENT_AGENT_ID }))

    expect(commands[0]!.agentId).toBe(SUBAGENT_AGENT_ID)
  })

  test('without parentAgentId the enqueued agentId is undefined', () => {
    const commands = notify(agentTask(), { finalMessage: '17 call sites' })

    expect(commands).toHaveLength(1)
    expect(commands[0]!.agentId).toBeUndefined()
  })

  test('a failure and a kill are addressed the same way as a completion', () => {
    const failed = notify(
      agentTask({ parentAgentId: TEAMMATE_AGENT_ID, status: 'failed' }),
      { status: 'failed' },
    )
    expect(failed[0]!.agentId).toBe(TEAMMATE_AGENT_ID)

    resetCommandQueue()

    const killedStore = makeStore({
      [TASK_ID]: agentTask({
        parentAgentId: TEAMMATE_AGENT_ID,
        status: 'killed',
      }),
    })
    enqueueAgentNotification({
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'killed',
      setAppState: killedStore.setAppState,
    })
    const killed = dequeueAll()
    expect(killed[0]!.agentId).toBe(TEAMMATE_AGENT_ID)
    expect(String(killed[0]!.value)).toContain('<status>killed</status>')
  })

  test('the stamp is metadata only — the notification XML is untouched', () => {
    // The envelope format is a non-goal of this change: an addressed
    // notification must read byte-identically to an unaddressed one.
    const addressed = notify(
      agentTask({ parentAgentId: TEAMMATE_AGENT_ID }),
      { finalMessage: '17' },
    )
    resetCommandQueue()
    const unaddressed = notify(agentTask(), { finalMessage: '17' })

    expect(String(addressed[0]!.value)).toBe(String(unaddressed[0]!.value))
    // …and still matches the block captured from the pre-change build.
    expect(String(addressed[0]!.value)).toBe(
      `<task-notification>
<task-id>${TASK_ID}</task-id>
<output-file>${getTaskOutputPath(TASK_ID)}</output-file>
<status>completed</status>
<summary>Agent "${DESCRIPTION}" completed</summary>
<result>17</result>
</task-notification>`,
    )
    // The addressing lives beside the payload, not inside it.
    expect(String(addressed[0]!.value)).not.toContain(TEAMMATE_AGENT_ID)
  })
})

describe('registerAsyncAgent records the spawner', () => {
  const selectedAgent = {
    agentType: 'general-purpose',
    source: 'built-in',
  } as unknown as AgentDefinition

  beforeEach(() => {
    resetCommandQueue()
  })

  test('the parameter is stored on the task state', () => {
    const store = makeStore()

    const task = registerAsyncAgent({
      agentId: TASK_ID,
      description: DESCRIPTION,
      prompt: 'count them',
      selectedAgent,
      setAppState: store.setAppState,
      parentAgentId: TEAMMATE_AGENT_ID,
    })

    expect(task.parentAgentId).toBe(TEAMMATE_AGENT_ID)
    expect(
      (store.getState().tasks[TASK_ID] as LocalAgentTaskState).parentAgentId,
    ).toBe(TEAMMATE_AGENT_ID)
  })

  test('omitting it leaves the task unaddressed, as a main-thread spawn is', () => {
    // AgentTool passes toolUseContext.agentId, which is undefined on the main
    // thread — so the coordinator keeps receiving its own agents' results.
    const store = makeStore()

    const task = registerAsyncAgent({
      agentId: TASK_ID,
      description: DESCRIPTION,
      prompt: 'count them',
      selectedAgent,
      setAppState: store.setAppState,
    })

    expect(task.parentAgentId).toBeUndefined()

    enqueueAgentNotification({
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'completed',
      setAppState: store.setAppState,
    })
    expect(dequeueAll()[0]!.agentId).toBeUndefined()
  })

  test('registration to notification is one hop: what is stored is what is stamped', () => {
    const store = makeStore()

    registerAsyncAgent({
      agentId: TASK_ID,
      description: DESCRIPTION,
      prompt: 'count them',
      selectedAgent,
      setAppState: store.setAppState,
      parentAgentId: TEAMMATE_AGENT_ID,
    })
    enqueueAgentNotification({
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'completed',
      setAppState: store.setAppState,
      finalMessage: 'done',
    })

    const commands = dequeueAll()
    expect(commands).toHaveLength(1)
    expect(commands[0]!.agentId).toBe(TEAMMATE_AGENT_ID)
    expect(String(commands[0]!.value)).toContain('<result>done</result>')
  })
})
