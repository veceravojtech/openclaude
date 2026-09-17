import { describe, expect, test } from 'bun:test'

import type { Message } from '../../types/message.js'
import {
  buildMessageLookups,
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
  getProgressMessagesFromLookup,
  normalizeMessages,
} from '../../utils/messages.js'
import { appendCappedTeammateMessage } from './InProcessTeammateTask.js'
import { TEAMMATE_MESSAGES_UI_CAP } from './types.js'

/**
 * The teammate view renders `task.messages`, a mirror capped at
 * TEAMMATE_MESSAGES_UI_CAP. Bash yields a `bash_progress` tick every second,
 * and Messages.tsx never draws a progress row — so when every tick took a
 * slot, one command running for about a minute evicted the whole visible
 * conversation. @main replaces the previous ephemeral tick for the same tool
 * call instead (REPL.tsx onQueryEvent); the mirror has to do the same.
 */

const BASH_TOOL_USE_ID = 'toolu_bash_long'

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

/** A teammate turn of 13 renderable rows, ending on a Bash call still running. */
function teammateTurn(): Message[] {
  const rows: Message[] = [
    createUserMessage({ content: 'Investigate the flaky build' }),
    createAssistantMessage({ content: 'Looking at the build scripts first.' }),
  ]
  for (let round = 0; round < 5; round++) {
    rows.push(toolUse(`toolu_read_${round}`, 'Read'))
    rows.push(toolResult(`toolu_read_${round}`))
  }
  rows.push(toolUse(BASH_TOOL_USE_ID, 'Bash'))
  return rows
}

function bashTick(
  second: number,
  parentToolUseID = BASH_TOOL_USE_ID,
): Message {
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

function appendAll(prev: Message[], messages: readonly Message[]): Message[] {
  let mirror = prev
  for (const message of messages) {
    mirror = appendCappedTeammateMessage(mirror, message)
  }
  return mirror
}

function progressFor(mirror: readonly Message[], parentToolUseID: string) {
  return mirror.filter(
    m => m.type === 'progress' && m.parentToolUseID === parentToolUseID,
  )
}

describe('appendCappedTeammateMessage — ephemeral progress', () => {
  for (const seconds of [60, 180]) {
    test(`a ${seconds} s Bash command keeps every renderable row and exactly one tick`, () => {
      const turn = teammateTurn()
      let mirror = appendAll([], turn)

      let lastTick: Message | undefined
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
      [bashTick(2), bashTick(2, 'toolu_bash_other')],
    )

    expect(mirror).toHaveLength(2)
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toHaveLength(1)
    expect(progressFor(mirror, 'toolu_bash_other')).toHaveLength(1)
  })

  test('an ephemeral tick of a different progress type is appended, not replaced', () => {
    const mcpTick = createProgressMessage({
      toolUseID: 'mcp-progress-0',
      parentToolUseID: BASH_TOOL_USE_ID,
      data: { type: 'mcp_progress', status: 'started' },
    })

    const mirror = appendAll([], [bashTick(2), mcpTick])

    expect(mirror).toHaveLength(2)
  })

  test('a tick after a non-progress message is appended, not replaced', () => {
    const interjection = createUserMessage({ content: 'status?' })

    const mirror = appendAll([], [bashTick(2), interjection, bashTick(3)])

    expect(mirror).toHaveLength(3)
    expect(mirror[1]).toBe(interjection)
    expect(progressFor(mirror, BASH_TOOL_USE_ID)).toHaveLength(2)
  })
})

describe('appendCappedTeammateMessage — non-ephemeral progress', () => {
  // AgentTool/UI.tsx renders a sub-agent from its whole agent_progress trail
  // (the first entry carries the prompt); replacing it leaves the row stuck
  // at "Initializing…", which is why REPL.tsx only replaces ephemeral types.
  test('consecutive agent_progress for one tool call are all kept', () => {
    const trail = Array.from({ length: 5 }, (_, i) =>
      createProgressMessage({
        toolUseID: `agent-progress-${i}`,
        parentToolUseID: 'toolu_agent',
        data: { type: 'agent_progress', prompt: 'sub-task', agentId: 'a1' },
      }),
    )

    const mirror = appendAll([], trail)

    expect(mirror).toHaveLength(trail.length)
    expect(mirror.map(m => m.uuid)).toEqual(trail.map(m => m.uuid))
  })

  test('consecutive hook_progress for one tool call are all kept', () => {
    const hooks = Array.from({ length: 3 }, (_, i) =>
      createProgressMessage({
        toolUseID: `hook-progress-${i}`,
        parentToolUseID: 'toolu_hooked',
        data: {
          type: 'hook_progress',
          hookEvent: 'PreToolUse',
          hookName: `hook-${i}`,
          command: 'true',
        },
      }),
    )

    const mirror = appendAll([], hooks)

    expect(mirror.map(m => m.uuid)).toEqual(hooks.map(m => m.uuid))
  })
})
