import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'

import { asAgentId } from '../types/ids.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  enqueuePendingNotification,
  getCommandsByMaxPriority,
  isSlashCommand,
  resetCommandQueue,
} from '../utils/messageQueueManager.js'

// The command queue is a process-global singleton. Three drain sites read it
// and all three route by `agentId`:
//
//   src/query.ts (mid-turn gate)          — main thread: agentId === undefined
//                                           subagent:    mode === 'task-notification'
//                                                        && agentId === toolUseContext.agentId
//   src/cli/print.ts (headless)           — agentId === undefined
//   src/utils/handlePromptSubmit.ts       — agentId === undefined
//
// Addressing a background agent's completion to its spawner therefore needs NO
// change at any drain site — which is exactly the claim this file pins. The
// predicates below mirror query.ts's filter (its own is a closure inside
// query(), not exported, and driving the whole loop is not hermetic); the last
// test guards the mirror by asserting the real rule is still in the source.

const TEAMMATE_AGENT_ID = asAgentId('researcher@my-team')
const OTHER_AGENT_ID = asAgentId('reviewer@my-team')

/** query.ts:3010-3020, main-thread branch. Also print.ts and handlePromptSubmit. */
function coordinatorDrain(cmd: QueuedCommand): boolean {
  if (isSlashCommand(cmd)) return false
  return cmd.agentId === undefined
}

/** query.ts:3010-3020, subagent branch. */
function subagentDrain(
  cmd: QueuedCommand,
  currentAgentId: string | undefined,
): boolean {
  if (isSlashCommand(cmd)) return false
  return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
}

function drain(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  return getCommandsByMaxPriority('next').filter(predicate)
}

/** A realistic queue: one addressed completion, one unaddressed, one prompt. */
function seedQueue(): void {
  enqueuePendingNotification({
    value: '<task-notification>\n<status>completed</status>\n</task-notification>',
    mode: 'task-notification',
    agentId: TEAMMATE_AGENT_ID,
    priority: 'next',
  })
  enqueuePendingNotification({
    value: '<task-notification>\n<status>failed</status>\n</task-notification>',
    mode: 'task-notification',
    priority: 'next',
  })
  enqueuePendingNotification({
    value: 'what is the status?',
    mode: 'prompt',
    priority: 'next',
  })
}

describe('task-notification drain routing by agentId', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  test('a teammate drains its own addressed notification', () => {
    seedQueue()

    const drained = drain(cmd => subagentDrain(cmd, TEAMMATE_AGENT_ID))

    expect(drained).toHaveLength(1)
    expect(drained[0]!.agentId).toBe(TEAMMATE_AGENT_ID)
    expect(String(drained[0]!.value)).toContain('<status>completed</status>')
  })

  test("the coordinator's drain does not see it", () => {
    seedQueue()

    const drained = drain(coordinatorDrain)

    // Only the unaddressed completion and the user's prompt.
    expect(drained.map(cmd => cmd.agentId)).toEqual([undefined, undefined])
    expect(drained.map(cmd => cmd.mode)).toEqual(['task-notification', 'prompt'])
  })

  test('another agent does not see it either', () => {
    seedQueue()

    expect(drain(cmd => subagentDrain(cmd, OTHER_AGENT_ID))).toHaveLength(0)
  })

  test('a subagent never takes an unaddressed completion or a user prompt', () => {
    // The two halves are complementary: an unaddressed notification is the
    // coordinator's, and `mode === 'task-notification'` keeps prompts on the
    // main thread even if something stamps an agentId on one.
    resetCommandQueue()
    enqueuePendingNotification({
      value: 'unaddressed completion',
      mode: 'task-notification',
      priority: 'next',
    })
    enqueuePendingNotification({
      value: 'a prompt addressed to the teammate',
      mode: 'prompt',
      agentId: TEAMMATE_AGENT_ID,
      priority: 'next',
    })

    expect(drain(cmd => subagentDrain(cmd, TEAMMATE_AGENT_ID))).toHaveLength(0)
    expect(drain(coordinatorDrain).map(cmd => String(cmd.value))).toEqual([
      'unaddressed completion',
    ])
  })

  test('every addressed notification is claimed by exactly one drain', () => {
    seedQueue()

    const all = getCommandsByMaxPriority('next')
    for (const cmd of all) {
      const claims = [
        coordinatorDrain(cmd),
        subagentDrain(cmd, TEAMMATE_AGENT_ID),
        subagentDrain(cmd, OTHER_AGENT_ID),
      ].filter(Boolean)
      expect(claims).toHaveLength(1)
    }
  })

  test('the mirrored rules are still the ones in the source', () => {
    // Guards the mirror above: if a drain site's rule changes, this fails here
    // rather than silently letting the mirror drift from query.ts.
    const read = (relative: string): string =>
      readFileSync(join(import.meta.dir, '..', relative), 'utf8').replace(
        /\s+/g,
        ' ',
      )

    expect(read('query.ts')).toContain(
      "return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId",
    )
    expect(read('query.ts')).toContain(
      'if (isMainThread) return cmd.agentId === undefined',
    )
    expect(read('cli/print.ts')).toContain(
      'const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined',
    )
    expect(read('utils/handlePromptSubmit.ts')).toContain(
      'command.agentId === undefined',
    )
  })
})
