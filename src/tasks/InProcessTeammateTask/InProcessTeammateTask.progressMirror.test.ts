import { describe, expect, test } from 'bun:test'

import type { Message, ProgressMessage } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  buildMessageLookups,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createProgressMessage,
  createUserMessage,
  getProgressMessagesFromLookup,
  normalizeMessages,
} from '../../utils/messages.js'
import { appendCappedTeammateMessage } from './InProcessTeammateTask.js'
import {
  TEAMMATE_MESSAGES_UI_CAP,
  TEAMMATE_PROGRESS_TAIL_PER_TOOL,
  TEAMMATE_PROGRESS_UI_CAP,
} from './types.js'

/**
 * The teammate view renders `task.messages`, a capped mirror, and
 * Messages.tsx never draws a progress row. When every progress entry took one
 * of the mirror's slots, a long Bash command (a `bash_progress` tick per
 * second) or a long sub-agent (an `agent_progress` per inner tool call)
 * evicted the whole visible conversation. @main replaces the previous
 * ephemeral tick for the same tool call instead (REPL.tsx onQueryEvent); the
 * mirror does that too, and caps its renderable entries and its progress
 * separately.
 */

const BASH_TOOL_USE_ID = 'toolu_bash_long'
const AGENT_TOOL_USE_ID = 'toolu_agent_long'

function toolUse(id: string, name: string): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input: {} }],
  })
}

function toolResult(id: string): Message {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  })
}

/** A teammate turn of 13 renderable rows, ending on a tool call still running. */
function teammateTurn(
  runningToolUse: Message = toolUse(BASH_TOOL_USE_ID, 'Bash'),
): Message[] {
  const rows: Message[] = [
    createUserMessage({ content: 'Investigate the flaky build' }),
    createAssistantMessage({ content: 'Looking at the build scripts first.' }),
  ]
  for (let round = 0; round < 5; round++) {
    rows.push(toolUse(`toolu_read_${round}`, 'Read'))
    rows.push(toolResult(`toolu_read_${round}`))
  }
  rows.push(runningToolUse)
  return rows
}

function bashTick(
  second: number,
  parentToolUseID = BASH_TOOL_USE_ID,
): ProgressMessage {
  return createProgressMessage({
    toolUseID: `bash-progress-${second}`,
    parentToolUseID,
    data: {
      type: 'bash_progress',
      output: `line ${second}`,
      fullOutput: `line ${second}`,
      elapsedTimeSeconds: second,
      totalLines: second,
      totalBytes: second * 8,
    },
  })
}

/** AgentTool's first agent_progress for a sub-agent carries its prompt. */
function agentPromptEntry(parentToolUseID: string): ProgressMessage {
  return createProgressMessage({
    toolUseID: `agent_${parentToolUseID}`,
    parentToolUseID,
    data: {
      type: 'agent_progress',
      message: createUserMessage({ content: `prompt for ${parentToolUseID}` }),
      prompt: `prompt for ${parentToolUseID}`,
      agentId: parentToolUseID,
    },
  })
}

/**
 * Every later agent_progress forwards one inner message of the sub-agent:
 * its tool_use on even steps, that call's tool_result on odd steps.
 */
function agentInnerEntry(
  parentToolUseID: string,
  step: number,
): ProgressMessage {
  const innerId = `${parentToolUseID}_inner_${Math.floor(step / 2)}`
  return createProgressMessage({
    toolUseID: `agent_${parentToolUseID}`,
    parentToolUseID,
    data: {
      type: 'agent_progress',
      prompt: '',
      agentId: parentToolUseID,
      message:
        step % 2 === 0
          ? createAssistantMessage({
              content: [{ type: 'tool_use', id: innerId, name: 'Read', input: {} }],
            })
          : createUserMessage({
              content: [
                { type: 'tool_result', tool_use_id: innerId, content: 'ok' },
              ],
            }),
    },
  })
}

function hookEntry(parentToolUseID: string, hookName: string): ProgressMessage {
  return createProgressMessage({
    toolUseID: parentToolUseID,
    parentToolUseID,
    data: {
      type: 'hook_progress',
      hookEvent: 'PreToolUse',
      hookName,
      command: 'true',
    },
  })
}

function hookDone(parentToolUseID: string, hookName: string): Message {
  return createAttachmentMessage({
    type: 'hook_success',
    hookName,
    toolUseID: parentToolUseID,
    hookEvent: 'PreToolUse',
    content: '',
  })
}

function appendAll(prev: Message[], messages: readonly Message[]): Message[] {
  let mirror = prev
  for (const message of messages) {
    mirror = appendCappedTeammateMessage(mirror, message)
  }
  return mirror
}

function progressFor(
  mirror: readonly Message[],
  parentToolUseID: string,
  type?: string,
): ProgressMessage[] {
  return mirror.filter(
    (m): m is ProgressMessage =>
      m.type === 'progress' &&
      m.parentToolUseID === parentToolUseID &&
      (type === undefined || m.data.type === type),
  )
}

function nonProgress(mirror: readonly Message[]): Message[] {
  return mirror.filter(m => m.type !== 'progress')
}

function expectWithinBound(mirror: readonly Message[]): void {
  const progress = mirror.length - nonProgress(mirror).length
  expect(mirror.length).toBeLessThanOrEqual(
    TEAMMATE_MESSAGES_UI_CAP + TEAMMATE_PROGRESS_UI_CAP,
  )
  expect(mirror.length - progress).toBeLessThanOrEqual(TEAMMATE_MESSAGES_UI_CAP)
  expect(progress).toBeLessThanOrEqual(TEAMMATE_PROGRESS_UI_CAP)
}

describe('appendCappedTeammateMessage — ephemeral progress', () => {
  for (const seconds of [60, 180]) {
    test(`a ${seconds} s Bash command keeps every renderable row and exactly one tick`, () => {
      const turn = teammateTurn()
      let mirror = appendAll([], turn)

      let lastTick: ProgressMessage | undefined
      for (let second = 2; second < seconds + 2; second++) {
        lastTick = bashTick(second)
        mirror = appendCappedTeammateMessage(mirror, lastTick)
        expect(mirror.length).toBeLessThanOrEqual(TEAMMATE_MESSAGES_UI_CAP)
      }

      // Messages.tsx drops `progress` before building rows; everything else
      // in the mirror is what the teammate view can draw.
      const renderable = mirror.filter(m => m.type !== 'progress')
      expect(renderable.map(m => m.uuid)).toEqual(turn.map(m => m.uuid))

      const ticks = progressFor(mirror, BASH_TOOL_USE_ID)
      expect(ticks).toHaveLength(1)
      expect(ticks[0]).toBe(lastTick!)

      // The live tick still reaches the Bash row through the lookups
      // Messages.tsx builds for rendering.
      const normalized = normalizeMessages(mirror)
      const lookups = buildMessageLookups(normalized, mirror)
      const bashRow = normalized.find(
        m =>
          m.type === 'assistant' &&
          m.message.content.some(
            b => b.type === 'tool_use' && b.id === BASH_TOOL_USE_ID,
          ),
      )
      expect(bashRow).toBeDefined()
      const live = getProgressMessagesFromLookup(bashRow!, lookups)
      expect(live).toHaveLength(1)
      expect(live[0]!.data.elapsedTimeSeconds).toBe(seconds + 1)
    })
  }

  test('replacing returns a new array and leaves the previous mirror untouched', () => {
    const first = bashTick(2)
    const before = appendAll([], [...teammateTurn(), first])
    const snapshot = [...before]

    const after = appendCappedTeammateMessage(before, bashTick(3))

    expect(after).not.toBe(before)
    expect(before).toEqual(snapshot)
    expect(before.at(-1)).toBe(first)
    expect(after).toHaveLength(before.length)
  })

  test('a tick for a different tool call is appended, not replaced', () => {
    const mirror = appendAll(
      [],
      [
        toolUse(BASH_TOOL_USE_ID, 'Bash'),
        toolUse('toolu_bash_other', 'Bash'),
        bashTick(2),
        bashTick(2, 'toolu_bash_other'),
      ],
    )

    expect(mirror).toHaveLength(4)
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toHaveLength(1)
    expect(progressFor(mirror, 'toolu_bash_other')).toHaveLength(1)
  })

  test('an ephemeral tick of a different progress type is appended, not replaced', () => {
    const mcpTick = createProgressMessage({
      toolUseID: 'mcp-progress-0',
      parentToolUseID: BASH_TOOL_USE_ID,
      data: { type: 'mcp_progress', status: 'started' },
    })

    const mirror = appendAll(
      [],
      [toolUse(BASH_TOOL_USE_ID, 'Bash'), bashTick(2), mcpTick],
    )

    expect(mirror).toHaveLength(3)
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toHaveLength(2)
  })

  // Stricter than REPL.tsx, which only replaces the LAST entry: a message
  // between two ticks must not let the older tick linger, since the tool UIs
  // read only the latest one.
  test('a tick after a non-progress message replaces the earlier tick for the same tool call', () => {
    const interjection = createUserMessage({ content: 'status?' })
    const latest = bashTick(3)

    const mirror = appendAll(
      [],
      [toolUse(BASH_TOOL_USE_ID, 'Bash'), bashTick(2), interjection, latest],
    )

    expect(nonProgress(mirror)).toContain(interjection)
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toEqual([latest])
  })

  // Parallel tool calls interleave their ticks (A, B, A, B…), so the last
  // entry never matches and a last-entry replace appends every tick.
  test('interleaved ticks from parallel Bash calls keep every renderable row and one tick per call', () => {
    const turn = [...teammateTurn(), toolUse('toolu_bash_parallel', 'Bash')]
    let mirror = appendAll([], turn)

    let lastA: ProgressMessage | undefined
    let lastB: ProgressMessage | undefined
    for (let second = 2; second < 62; second++) {
      lastA = bashTick(second)
      lastB = bashTick(second, 'toolu_bash_parallel')
      mirror = appendAll(mirror, [lastA, lastB])
      expectWithinBound(mirror)
    }

    expect(nonProgress(mirror).map(m => m.uuid)).toEqual(turn.map(m => m.uuid))
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toEqual([lastA!])
    expect(progressFor(mirror, 'toolu_bash_parallel')).toEqual([lastB!])
  })

  test('progress for a tool call that is not in the mirror is dropped', () => {
    const before = appendAll([], teammateTurn())

    const after = appendCappedTeammateMessage(
      before,
      bashTick(2, 'toolu_not_in_mirror'),
    )

    expect(after).not.toBe(before)
    expect(after).toEqual(before)
  })
})

describe('appendCappedTeammateMessage — non-ephemeral progress', () => {
  // AgentTool/UI.tsx renders a sub-agent from its agent_progress trail (the
  // first entry carries the prompt); replacing it leaves the row stuck at
  // "Initializing…", which is why REPL.tsx only replaces ephemeral types.
  test('consecutive agent_progress for one tool call are all kept up to the first entry plus the tail', () => {
    const trail = [
      agentPromptEntry(AGENT_TOOL_USE_ID),
      ...Array.from({ length: TEAMMATE_PROGRESS_TAIL_PER_TOOL }, (_, step) =>
        agentInnerEntry(AGENT_TOOL_USE_ID, step),
      ),
    ]

    const mirror = appendAll([toolUse(AGENT_TOOL_USE_ID, 'Agent')], trail)

    expect(progressFor(mirror, AGENT_TOOL_USE_ID)).toEqual(trail)
  })

  test('consecutive hook_progress for one tool call are all kept', () => {
    const hooks = Array.from({ length: 3 }, (_, i) =>
      hookEntry('toolu_hooked', `hook-${i}`),
    )

    const mirror = appendAll([toolUse('toolu_hooked', 'Bash')], hooks)

    expect(progressFor(mirror, 'toolu_hooked')).toEqual(hooks)
  })

  test('a flood of agent_progress from one sub-agent keeps every renderable row, the prompt entry and the recent tail', () => {
    const turn = teammateTurn(toolUse(AGENT_TOOL_USE_ID, 'Agent'))
    const prompt = agentPromptEntry(AGENT_TOOL_USE_ID)
    let mirror = appendAll([], [...turn, prompt])

    const inner: ProgressMessage[] = []
    for (let step = 0; step < 80; step++) {
      inner.push(agentInnerEntry(AGENT_TOOL_USE_ID, step))
      mirror = appendCappedTeammateMessage(mirror, inner.at(-1)!)
    }

    expect(nonProgress(mirror).map(m => m.uuid)).toEqual(turn.map(m => m.uuid))

    const trail = progressFor(mirror, AGENT_TOOL_USE_ID)
    expect(trail[0]).toBe(prompt)
    expect(trail.slice(1)).toEqual(inner.slice(-TEAMMATE_PROGRESS_TAIL_PER_TOOL))

    // The Agent row gets that trail, prompt first, through the lookups
    // Messages.tsx builds for rendering.
    const normalized = normalizeMessages(mirror)
    const lookups = buildMessageLookups(normalized, mirror)
    const agentRow = normalized.find(
      m =>
        m.type === 'assistant' &&
        m.message.content.some(
          b => b.type === 'tool_use' && b.id === AGENT_TOOL_USE_ID,
        ),
    )
    expect(agentRow).toBeDefined()
    expect(getProgressMessagesFromLookup(agentRow!, lookups)).toEqual(trail)
  })
})

describe('appendCappedTeammateMessage — bound', () => {
  test('unbounded mixed progress keeps the mirror within TEAMMATE_MESSAGES_UI_CAP + TEAMMATE_PROGRESS_UI_CAP', () => {
    const HOOKS_PER_TOOL = 2
    const PARALLEL_AGENTS = 4
    let mirror: Message[] = []
    const push = (message: Message) => {
      mirror = appendCappedTeammateMessage(mirror, message)
      expectWithinBound(mirror)
    }

    for (let round = 0; round < 12; round++) {
      for (let row = 0; row < 20; row++) {
        push(
          row % 2 === 0
            ? createUserMessage({ content: `round ${round} row ${row}` })
            : createAssistantMessage({ content: `round ${round} row ${row}` }),
        )
      }

      const agents = Array.from(
        { length: PARALLEL_AGENTS },
        (_, k) => `toolu_agent_${round}_${k}`,
      )
      const prompts = new Map<string, ProgressMessage>()
      for (const id of agents) {
        push(toolUse(id, 'Agent'))
        for (let h = 0; h < HOOKS_PER_TOOL; h++) push(hookEntry(id, `hook-${h}`))
        for (let h = 0; h < HOOKS_PER_TOOL; h++) push(hookDone(id, `hook-${h}`))
        prompts.set(id, agentPromptEntry(id))
        push(prompts.get(id)!)
      }
      const bashA = `toolu_bash_${round}_a`
      const bashB = `toolu_bash_${round}_b`
      push(toolUse(bashA, 'Bash'))
      push(toolUse(bashB, 'Bash'))

      for (let step = 0; step < 60; step++) {
        const latest = new Map<string, ProgressMessage>()
        for (const id of agents) {
          latest.set(id, agentInnerEntry(id, step))
          push(latest.get(id)!)
        }
        latest.set(bashA, bashTick(step, bashA))
        push(latest.get(bashA)!)
        latest.set(bashB, bashTick(step, bashB))
        push(latest.get(bashB)!)

        // Every tool of this round is still running: its live display
        // survives — the latest entry, and a sub-agent's prompt entry first.
        for (const [id, entry] of latest) {
          const progress = progressFor(mirror, id)
          expect(progress.at(-1)).toBe(entry)
          if (prompts.has(id)) {
            expect(progressFor(mirror, id, 'agent_progress')[0]).toBe(
              prompts.get(id)!,
            )
          }
        }
        // hook_progress is counted per tool (HookProgressMessage.tsx), so a
        // retained tool keeps all of its entries or none.
        const hookCounts = new Map<string, number>()
        for (const m of mirror) {
          if (m.type === 'progress' && m.data.type === 'hook_progress') {
            hookCounts.set(
              m.parentToolUseID,
              (hookCounts.get(m.parentToolUseID) ?? 0) + 1,
            )
          }
        }
        for (const count of hookCounts.values()) {
          expect(count).toBe(HOOKS_PER_TOOL)
        }
      }

      // Half the sub-agents and one Bash call finish; the rest keep running
      // into the next round.
      for (const id of agents.slice(0, PARALLEL_AGENTS / 2)) push(toolResult(id))
      push(toolResult(bashA))
    }
  })

  test('a compaction replace folded through it keeps every compacted row and drops hook_progress with no tool_use', () => {
    // inProcessRunner mirrors [...buildPostCompactMessages(result), userMessage];
    // hookResults come from SessionStart hooks, whose progress uses a random
    // toolUseID that no tool_use carries.
    const sessionStartHookId = 'session-start-hook'
    const boundary = createCompactBoundaryMessage('auto', 120_000)
    const summary = createUserMessage({
      content: 'Summary of the earlier conversation',
      isCompactSummary: true,
    })
    const hookOutput = createAttachmentMessage({
      type: 'hook_success',
      hookName: 'SessionStart:compact',
      toolUseID: sessionStartHookId,
      hookEvent: 'SessionStart',
      content: '',
    })
    const nextPrompt = createUserMessage({ content: 'Carry on with the build' })
    const hookRunning = createProgressMessage({
      toolUseID: sessionStartHookId,
      parentToolUseID: sessionStartHookId,
      data: {
        type: 'hook_progress',
        hookEvent: 'SessionStart',
        hookName: 'SessionStart:compact',
        command: 'true',
      },
    })

    const compacted = [boundary, summary, hookRunning, hookOutput, nextPrompt]
    const mirror = compacted.reduce<Message[]>(
      (acc, message) => appendCappedTeammateMessage(acc, message),
      [],
    )

    expect(mirror).toEqual([boundary, summary, hookOutput, nextPrompt])
  })

  test("evicting a tool_use row also drops that tool call's progress", () => {
    let mirror = appendAll(
      [],
      [
        toolUse(BASH_TOOL_USE_ID, 'Bash'),
        bashTick(3),
        toolUse(AGENT_TOOL_USE_ID, 'Agent'),
        agentPromptEntry(AGENT_TOOL_USE_ID),
        agentInnerEntry(AGENT_TOOL_USE_ID, 0),
      ],
    )

    // One row past the cap evicts only the Bash tool_use.
    for (let row = 0; row < TEAMMATE_MESSAGES_UI_CAP - 1; row++) {
      mirror = appendCappedTeammateMessage(
        mirror,
        createUserMessage({ content: `row ${row}` }),
      )
    }

    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toHaveLength(0)
    expect(progressFor(mirror, AGENT_TOOL_USE_ID)).toHaveLength(2)
    expect(nonProgress(mirror)).toHaveLength(TEAMMATE_MESSAGES_UI_CAP)
  })

  describe('over TEAMMATE_PROGRESS_UI_CAP', () => {
    /** An in-flight sub-agent with its prompt entry and a full tail. */
    function runningAgent(id: string): Message[] {
      return [
        toolUse(id, 'Agent'),
        agentPromptEntry(id),
        ...Array.from({ length: TEAMMATE_PROGRESS_TAIL_PER_TOOL }, (_, step) =>
          agentInnerEntry(id, step),
        ),
      ]
    }

    test("a finished tool's trail is trimmed before its hook group and before a running tool's trail", () => {
      const [doneUse, ...doneTrail] = runningAgent('toolu_done')
      const finished = [
        doneUse,
        hookEntry('toolu_done', 'hook-0'),
        hookEntry('toolu_done', 'hook-1'),
        hookDone('toolu_done', 'hook-0'),
        hookDone('toolu_done', 'hook-1'),
        ...doneTrail,
        toolResult('toolu_done'),
      ]
      const running = [...runningAgent('toolu_a'), ...runningAgent('toolu_b')]

      const mirror = appendAll([], [...finished, ...running])

      expect(progressFor(mirror, 'toolu_a')).toHaveLength(
        1 + TEAMMATE_PROGRESS_TAIL_PER_TOOL,
      )
      expect(progressFor(mirror, 'toolu_b')).toHaveLength(
        1 + TEAMMATE_PROGRESS_TAIL_PER_TOOL,
      )
      expect(progressFor(mirror, 'toolu_done', 'hook_progress')).toHaveLength(2)
      expect(progressFor(mirror, 'toolu_done', 'agent_progress')).toHaveLength(
        TEAMMATE_PROGRESS_UI_CAP - 2 * (1 + TEAMMATE_PROGRESS_TAIL_PER_TOOL) - 2,
      )
    })

    test("a finished tool's last tick is dropped before a running tool's progress", () => {
      const running = Array.from({ length: 10 }, (_, i) => `toolu_bash_${i}`)
      const startRunning = (id: string) => [
        toolUse(id, 'Bash'),
        hookEntry(id, 'hook-0'),
        hookEntry(id, 'hook-1'),
        bashTick(1, id),
      ]
      // 9 running calls (27 entries), a finished call's tick (28), then the
      // 10th running call's hooks and tick tip it over.
      const mirror = appendAll(
        [],
        [
          ...running.slice(0, 9).flatMap(startRunning),
          toolUse('toolu_bash_done', 'Bash'),
          bashTick(1, 'toolu_bash_done'),
          toolResult('toolu_bash_done'),
          ...startRunning(running[9]!),
        ],
      )

      expect(progressFor(mirror, 'toolu_bash_done')).toHaveLength(0)
      for (const id of running) {
        expect(progressFor(mirror, id)).toHaveLength(3)
      }
    })

    test("a finished tool's hook_progress is dropped as a whole group", () => {
      const hooked = [
        toolUse('toolu_hooked', 'Bash'),
        hookEntry('toolu_hooked', 'hook-0'),
        hookEntry('toolu_hooked', 'hook-1'),
        hookEntry('toolu_hooked', 'hook-2'),
        hookDone('toolu_hooked', 'hook-0'),
        hookDone('toolu_hooked', 'hook-1'),
        hookDone('toolu_hooked', 'hook-2'),
        toolResult('toolu_hooked'),
      ]
      // 3 + 11 + 11 + 6 = 31 progress entries: the last one tips it over.
      const running = [
        ...runningAgent('toolu_a'),
        ...runningAgent('toolu_b'),
        ...runningAgent('toolu_c').slice(0, 7),
      ]

      const mirror = appendAll([], [...hooked, ...running])

      expect(progressFor(mirror, 'toolu_hooked')).toHaveLength(0)
      expect(progressFor(mirror, 'toolu_c')).toHaveLength(6)
    })

    test("a running sub-agent's trail is shortened but keeps its prompt entry and latest entry", () => {
      const agents = new Map(
        ['toolu_a', 'toolu_b', 'toolu_c'].map(id => [id, runningAgent(id)]),
      )

      const mirror = appendAll([], [...agents.values()].flat())

      expect(mirror.filter(m => m.type === 'progress')).toHaveLength(
        TEAMMATE_PROGRESS_UI_CAP,
      )
      for (const [id, messages] of agents) {
        const trail = progressFor(mirror, id)
        expect(trail.length).toBeLessThan(1 + TEAMMATE_PROGRESS_TAIL_PER_TOOL)
        expect(trail[0]!.uuid).toBe(messages[1]!.uuid)
        expect(trail.at(-1)!.uuid).toBe(messages.at(-1)!.uuid)
      }
    })

    test('with only running tools and no long trail left, the tool with the oldest progress loses all of it', () => {
      // 10 running Bash calls, each with 2 hook_progress and a tick = 30.
      const tools = Array.from({ length: 11 }, (_, i) => `toolu_bash_${i}`)
      let mirror: Message[] = []
      for (const id of tools.slice(0, 10)) {
        mirror = appendAll(mirror, [
          toolUse(id, 'Bash'),
          hookEntry(id, 'hook-0'),
          hookEntry(id, 'hook-1'),
          bashTick(1, id),
        ])
      }
      expect(mirror.filter(m => m.type === 'progress')).toHaveLength(30)

      const newest = tools[10]!
      mirror = appendAll(mirror, [
        toolUse(newest, 'Bash'),
        hookEntry(newest, 'hook-0'),
      ])

      expect(progressFor(mirror, tools[0]!)).toHaveLength(0)
      expect(progressFor(mirror, newest)).toHaveLength(1)
      for (const id of tools.slice(1, 10)) {
        expect(progressFor(mirror, id)).toHaveLength(3)
      }
    })
  })
})
