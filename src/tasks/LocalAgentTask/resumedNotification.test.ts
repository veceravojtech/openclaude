import { beforeEach, describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState } from '../../Task.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { registerTask } from '../../utils/task/framework.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'
import { enqueueAgentNotification, registerAsyncAgent } from './LocalAgentTask.js'

// A resumed background agent re-registers under the SAME task id
// (resumeAgentBackground → registerAsyncAgent with the original agentId), and
// registerTask's merge does not carry `notified` forward — so the resumed run
// enqueues a SECOND completion notification for that id. Before the fix its
// summary was rebuilt from the description alone and came out byte-identical
// to the original run's, so the leader could only read it as a replay. These
// tests pin the discriminator: the summary wording, the <resumed> counter tag,
// and the fact that the resumed notification still carries the follow-up's own
// result.

const TASK_ID = 'agent-abc123'
const DESCRIPTION = 'Audit the retry path'

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
    prompt: 'audit it',
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

/** Enqueue a completion for `task` and return the notification text(s). */
function notify(
  task: LocalAgentTaskState,
  options: {
    finalMessage?: string
    status?: 'completed' | 'failed'
    // What agentToolUtils.ts passes as `toolUseContext.toolUseId` at each of
    // its three call sites — the sole source of the <tool-use-id> tag.
    toolUseId?: string
  } = {},
): { store: ReturnType<typeof makeStore>; messages: string[] } {
  const store = makeStore({ [TASK_ID]: task })
  enqueueAgentNotification({
    taskId: TASK_ID,
    description: DESCRIPTION,
    status: options.status ?? 'completed',
    setAppState: store.setAppState,
    finalMessage: options.finalMessage,
    toolUseId: options.toolUseId,
  })
  return {
    store,
    messages: dequeueAll().map(command => String(command.value)),
  }
}

function summaryOf(message: string): string {
  return message.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? ''
}

describe('resumed-agent completion notification', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  test('an original run keeps the unchanged summary and emits no <resumed> tag', () => {
    const { messages } = notify(agentTask())

    expect(messages).toHaveLength(1)
    expect(summaryOf(messages[0]!)).toBe(`Agent "${DESCRIPTION}" completed`)
    expect(messages[0]!).not.toContain('<resumed>')
  })

  test('resumeCount 0 is treated as an original run', () => {
    const { messages } = notify(agentTask({ resumeCount: 0 }))

    expect(summaryOf(messages[0]!)).toBe(`Agent "${DESCRIPTION}" completed`)
    expect(messages[0]!).not.toContain('<resumed>')
  })

  test('a resumed completion is distinguishable and carries the follow-up result', () => {
    const original = notify(agentTask())
    resetCommandQueue()
    const resumed = notify(agentTask({ resumeCount: 1 }), {
      finalMessage: 'Follow-up answer: the retry path is fine',
    })

    const originalMessage = original.messages[0]!
    const resumedMessage = resumed.messages[0]!

    // Same task id — this is the collision the marker has to survive.
    expect(resumedMessage).toContain(`<task-id>${TASK_ID}</task-id>`)
    expect(originalMessage).toContain(`<task-id>${TASK_ID}</task-id>`)

    expect(summaryOf(resumedMessage)).toBe(
      `Agent "${DESCRIPTION}" completed a resumed run (resume #1)`,
    )
    expect(summaryOf(resumedMessage)).not.toBe(summaryOf(originalMessage))
    expect(resumedMessage).toContain('<resumed>1</resumed>')

    // The follow-up's own output still reaches <result>, exactly as on run one.
    expect(resumedMessage).toContain(
      '<result>Follow-up answer: the retry path is fine</result>',
    )
  })

  test('the resumed marker sits next to <status> and precedes <summary>', () => {
    const { messages } = notify(agentTask({ resumeCount: 1 }), {
      finalMessage: 'done',
    })

    // The marker is still glued to <status>; <resumed-prompt> is what now sits
    // between it and <summary>, so "precedes" is asserted by position, not by
    // adjacency.
    expect(messages[0]!).toContain('<status>completed</status>\n<resumed>1</resumed>')
    expect(messages[0]!.indexOf('<resumed>')).toBeLessThan(
      messages[0]!.indexOf('<summary>'),
    )
  })

  test('the marker is a count, not a boolean — a second resume reads #2', () => {
    const { messages } = notify(agentTask({ resumeCount: 2 }), {
      finalMessage: 'second follow-up',
    })

    expect(summaryOf(messages[0]!)).toBe(
      `Agent "${DESCRIPTION}" completed a resumed run (resume #2)`,
    )
    expect(messages[0]!).toContain('<resumed>2</resumed>')
    expect(messages[0]!).toContain('<result>second follow-up</result>')
  })

  test('a resumed failure keeps the failure wording but still carries the marker', () => {
    const { messages } = notify(
      agentTask({ status: 'failed', resumeCount: 1 }),
      { status: 'failed' },
    )

    expect(summaryOf(messages[0]!)).toBe(
      `Agent "${DESCRIPTION}" failed: Unknown error`,
    )
    expect(messages[0]!).toContain('<resumed>1</resumed>')
  })

  // A user-initiated resume has no originating tool call to claim: the
  // Agent(...) call that spawned run one already owns its own tool_result, so
  // reusing its id would attach a second result to a settled call. That ruling
  // is guarded at the registration end (resumeAgent.test.ts), but the tag is
  // written here, from the toolUseId argument alone — so a regression would
  // land in this emitter, past those tests.
  test('a resumed completion with no originating tool call emits no <tool-use-id>', () => {
    const { messages } = notify(agentTask({ resumeCount: 1 }), {
      finalMessage: 'follow-up result',
    })

    expect(messages[0]!).toContain('<resumed>1</resumed>')
    // Pinned on the tag name, so a changed id value cannot mask the regression.
    expect(messages[0]!).not.toContain('<tool-use-id>')
  })

  test('an original run started by a tool call still carries its <tool-use-id>', () => {
    // The other half of the guard: the tag is absent above because no id is
    // passed on the user path, not because the emitter stopped emitting it.
    const { messages } = notify(agentTask(), {
      finalMessage: 'first result',
      toolUseId: 'toolu_original_agent',
    })

    expect(messages[0]!).toContain(
      '<tool-use-id>toolu_original_agent</tool-use-id>',
    )
  })

  test('the notified guard still suppresses a double enqueue within one run', () => {
    const store = makeStore({ [TASK_ID]: agentTask({ resumeCount: 1 }) })
    const args = {
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'completed' as const,
      setAppState: store.setAppState,
      finalMessage: 'once',
    }

    enqueueAgentNotification(args)
    enqueueAgentNotification(args)

    expect(dequeueAll()).toHaveLength(1)
    expect(store.getState().tasks[TASK_ID]!.notified).toBe(true)
  })
})

describe('resume re-registration', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  test('re-registering clears notified and keeps the incremented resumeCount', () => {
    // Run one: completed and already notified.
    const store = makeStore({
      [TASK_ID]: agentTask({ notified: true, resumeCount: 0 }),
    })

    // Run two: resumeAgentBackground re-registers the same id via registerTask.
    registerTask(
      agentTask({ status: 'running', notified: false, resumeCount: 1 }),
      store.setAppState,
    )

    const merged = store.getState().tasks[TASK_ID] as LocalAgentTaskState
    // registerTask's merge carries retain/startTime/messages/diskLoaded/
    // pendingMessages forward only — notified resets, so the resumed run is
    // free to notify again, and resumeCount from the new task wins.
    expect(merged.notified).toBe(false)
    expect(merged.resumeCount).toBe(1)

    // …and that second notification is the distinguishable one.
    enqueueAgentNotification({
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'completed',
      setAppState: store.setAppState,
      finalMessage: 'resumed result',
    })
    const messages = dequeueAll().map(command => String(command.value))
    expect(messages).toHaveLength(1)
    expect(summaryOf(messages[0]!)).toBe(
      `Agent "${DESCRIPTION}" completed a resumed run (resume #1)`,
    )
    expect(messages[0]!).toContain('<result>resumed result</result>')
  })

  test('registerAsyncAgent defaults to 0 and stores the count it is given', () => {
    const selectedAgent = {
      agentType: 'general-purpose',
      source: 'built-in',
    } as unknown as AgentDefinition
    const store = makeStore()

    const original = registerAsyncAgent({
      agentId: TASK_ID,
      description: DESCRIPTION,
      prompt: 'audit it',
      selectedAgent,
      setAppState: store.setAppState,
    })
    expect(original.resumeCount).toBe(0)

    const resumed = registerAsyncAgent({
      agentId: TASK_ID,
      description: DESCRIPTION,
      prompt: 'and now the follow-up',
      selectedAgent,
      setAppState: store.setAppState,
      resumeCount: 2,
    })
    expect(resumed.resumeCount).toBe(2)
    expect(
      (store.getState().tasks[TASK_ID] as LocalAgentTaskState).resumeCount,
    ).toBe(2)
  })
})

describe('resumed-run provenance (<resumed-prompt>)', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  const FOLLOW_UP =
    'Now read config.json and report just the value of the "port" field and nothing else.'

  test('a resumed completion carries the follow-up prompt in <resumed-prompt>', () => {
    const { messages } = notify(
      agentTask({ resumeCount: 1, prompt: FOLLOW_UP }),
      { finalMessage: '8317' },
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]!).toContain(
      `<resumed-prompt>${FOLLOW_UP}</resumed-prompt>`,
    )
  })

  test('<resumed-prompt> sits between <resumed> and <summary>', () => {
    // what run -> what was asked -> what happened -> what came back
    const { messages } = notify(
      agentTask({ resumeCount: 1, prompt: FOLLOW_UP }),
      { finalMessage: '8317' },
    )

    expect(messages[0]!).toContain(
      `<status>completed</status>\n<resumed>1</resumed>\n<resumed-prompt>${FOLLOW_UP}</resumed-prompt>\n<summary>`,
    )
  })

  test('the prompt is emitted verbatim, matching the <result> convention', () => {
    // No escaping and no truncation: <result> next door is verbatim too.
    const raw = 'Compare <a> & <b>; report "port" > 8000 — verbatim, not escaped.'
    const { messages } = notify(agentTask({ resumeCount: 1, prompt: raw }), {
      finalMessage: 'ok',
    })

    expect(messages[0]!).toContain(`<resumed-prompt>${raw}</resumed-prompt>`)
  })

  test('an original run emits no <resumed-prompt> and stays byte-identical', () => {
    const { messages } = notify(agentTask({ prompt: 'audit it' }), {
      finalMessage: '15',
    })

    expect(messages[0]!).not.toContain('<resumed-prompt')
    // Pinned against the block captured from the pre-change build.
    expect(messages[0]!).toBe(
      `<task-notification>
<task-id>${TASK_ID}</task-id>
<output-file>${getTaskOutputPath(TASK_ID)}</output-file>
<status>completed</status>
<summary>Agent "${DESCRIPTION}" completed</summary>
<result>15</result>
</task-notification>`,
    )
  })

  test('resumeCount 0 with a prompt still emits no <resumed-prompt>', () => {
    const { messages } = notify(
      agentTask({ resumeCount: 0, prompt: 'audit it' }),
      { finalMessage: '15' },
    )

    expect(messages[0]!).not.toContain('<resumed-prompt')
  })

  test('a resumed run with an empty prompt emits no empty tag', () => {
    const empty = notify(agentTask({ resumeCount: 1, prompt: '' }), {
      finalMessage: '8317',
    })
    expect(empty.messages[0]!).not.toContain('<resumed-prompt')
    expect(empty.messages[0]!).toContain('<resumed>1</resumed>\n<summary>')

    resetCommandQueue()

    // prompt is required on the state type, but a hand-built/legacy task can
    // still reach the notifier without one.
    const absent = notify(
      agentTask({ resumeCount: 1, prompt: undefined as unknown as string }),
      { finalMessage: '8317' },
    )
    expect(absent.messages[0]!).not.toContain('<resumed-prompt')
  })

  test('the prompt carried is the FOLLOW-UP run\'s, not the original run\'s', () => {
    // This is the assertion the whole design rests on: registerTask's merge
    // carries retain/startTime/messages/diskLoaded/pendingMessages forward but
    // NOT `prompt`, so re-registering run 2 replaces run 1's prompt.
    const PROMPT_A = 'Run one: count the .ts files'
    const PROMPT_B = 'Run two: report the "port" value from config.json'

    // Run one: completed, already notified, prompt A.
    const store = makeStore({
      [TASK_ID]: agentTask({
        notified: true,
        resumeCount: 0,
        prompt: PROMPT_A,
      }),
    })

    // Run two: the real registerTask, exactly as resumeAgentBackground calls it.
    registerTask(
      agentTask({
        status: 'running',
        notified: false,
        resumeCount: 1,
        prompt: PROMPT_B,
      }),
      store.setAppState,
    )

    const merged = store.getState().tasks[TASK_ID] as LocalAgentTaskState
    expect(merged.prompt).toBe(PROMPT_B)

    enqueueAgentNotification({
      taskId: TASK_ID,
      description: DESCRIPTION,
      status: 'completed',
      setAppState: store.setAppState,
      finalMessage: '8317',
    })
    const messages = dequeueAll().map(command => String(command.value))

    expect(messages).toHaveLength(1)
    expect(messages[0]!).toContain(
      `<resumed-prompt>${PROMPT_B}</resumed-prompt>`,
    )
    expect(messages[0]!).not.toContain(PROMPT_A)
  })
})
