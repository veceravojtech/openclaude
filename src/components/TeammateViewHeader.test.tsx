import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'

import { Box, createRoot, Text } from '../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../state/AppState.js'
import { getRegisteredAgentName } from '../state/teammateViewHelpers.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { AgentId } from '../types/ids.js'
import { TeammateViewHeader } from './TeammateViewHeader.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
// Rendered as a sibling so "nothing viewed" still produces a frame to assert
// on — the header itself returns null there and emits no output of its own.
const SENTINEL = 'HEADER-HARNESS-READY'

function taskBase(id: string) {
  return {
    id,
    status: 'running' as const,
    description: `description of ${id}`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: false,
  }
}

function agentTask(
  id: string,
  overrides?: Partial<LocalAgentTaskState>,
): LocalAgentTaskState {
  return {
    ...taskBase(id),
    type: 'local_agent',
    agentId: id,
    prompt: `prompt of ${id}`,
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: true,
    diskLoaded: false,
    ...overrides,
  }
}

function teammateTask(id: string): InProcessTeammateTaskState {
  return {
    ...taskBase(id),
    type: 'in_process_teammate',
    identity: {
      agentId: `${id}@team`,
      agentName: id,
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: `prompt of ${id}`,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function stateWith(
  tasks: TaskState[],
  overrides?: Partial<AppState>,
): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
    ...overrides,
  }
}

function registry(entries: Array<[string, string]>): Map<string, AgentId> {
  return new Map(entries.map(([name, id]) => [name, id as AgentId]))
}

// Non-TTY stdout emits one DEC-synchronized frame per render; reading the raw
// buffer yields concatenated duplicates, so pull the last complete frame out.
function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return stripAnsi(lastFrame ?? output)
}

async function mountHeader(state: AppState) {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider initialState={state}>
      <Box flexDirection="column">
        <TeammateViewHeader />
        <Text>{SENTINEL}</Text>
      </Box>
    </AppStateProvider>,
  )

  async function waitForFrame(
    predicate: (frame: string) => boolean,
  ): Promise<string> {
    const startedAt = Date.now()
    let frame = ''
    while (Date.now() - startedAt < 2500) {
      frame = extractLastFrame(output)
      if (predicate(frame)) return frame
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for header frame:\n${frame}`)
  }

  return {
    waitForFrame,
    async cleanup() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('components/TeammateViewHeader.test.tsx')
})

afterEach(() => {
  releaseSharedMutationLock()
})

describe('TeammateViewHeader rendering', () => {
  // Regression guard for the local-agent branch added alongside it: the
  // in-process teammate path must render exactly as it did before.
  test('renders the viewed in-process teammate name and prompt', async () => {
    const teammate = teammateTask('scout')
    const harness = await mountHeader(
      stateWith([teammate], {
        viewingAgentTaskId: teammate.id,
        viewSelectionMode: 'viewing-agent',
      }),
    )
    try {
      const frame = await harness.waitForFrame(f => f.includes(SENTINEL))
      expect(frame).toContain('Viewing @scout')
      expect(frame).toContain('esc')
      expect(frame).toContain('prompt of scout')
    } finally {
      await harness.cleanup()
    }
  })

  test('renders a viewed local agent registered name as a handle', async () => {
    const agent = agentTask('agent-1')
    const harness = await mountHeader(
      stateWith([agent], {
        viewingAgentTaskId: agent.id,
        viewSelectionMode: 'viewing-agent',
        agentNameRegistry: registry([['researcher', agent.id]]),
      }),
    )
    try {
      const frame = await harness.waitForFrame(f => f.includes(SENTINEL))
      expect(frame).toContain('Viewing @researcher')
      expect(frame).toContain('esc')
      expect(frame).toContain('prompt of agent-1')
    } finally {
      await harness.cleanup()
    }
  })

  test('renders an unregistered local agent description without an @ handle', async () => {
    // No prompt either, so the description is the only thing there is to show —
    // the header must not print it twice, and must not dress it up as a handle.
    const agent = agentTask('agent-2', { prompt: '' })
    const harness = await mountHeader(
      stateWith([agent], {
        viewingAgentTaskId: agent.id,
        viewSelectionMode: 'viewing-agent',
        agentNameRegistry: registry([['someone-else', 'a-different-task']]),
      }),
    )
    try {
      const frame = await harness.waitForFrame(f => f.includes(SENTINEL))
      expect(frame).toContain('Viewing description of agent-2')
      expect(frame).toContain('esc')
      expect(frame).not.toContain('@')
      // Description shown once (first line), not duplicated on a detail line.
      expect(frame.split('description of agent-2').length - 1).toBe(1)
    } finally {
      await harness.cleanup()
    }
  })

  test('renders nothing when no agent is being viewed', async () => {
    const agent = agentTask('agent-3')
    const harness = await mountHeader(stateWith([agent]))
    try {
      const frame = await harness.waitForFrame(f => f.includes(SENTINEL))
      expect(frame).not.toContain('Viewing')
      expect(frame).not.toContain('description of agent-3')
      expect(frame).not.toContain('prompt of agent-3')
    } finally {
      await harness.cleanup()
    }
  })
})

describe('getRegisteredAgentName', () => {
  test('returns the name registered for the task id', () => {
    const state = {
      agentNameRegistry: registry([
        ['scout', 'task-a'],
        ['builder', 'task-b'],
      ]),
    }
    expect(getRegisteredAgentName(state, 'task-b')).toBe('builder')
  })

  test('returns undefined when no entry points at the task id', () => {
    const state = { agentNameRegistry: registry([['scout', 'task-a']]) }
    expect(getRegisteredAgentName(state, 'task-z')).toBeUndefined()
  })

  test('returns undefined for an empty registry', () => {
    expect(getRegisteredAgentName({ agentNameRegistry: registry([]) }, 'task-a'))
      .toBeUndefined()
  })

  // The registry is Map<name, taskId>, so the lookup runs name <- taskId.
  // Passing a *name* must miss: that would be the reversed direction.
  test('looks up by task id, not by name', () => {
    const state = { agentNameRegistry: registry([['scout', 'task-a']]) }
    expect(getRegisteredAgentName(state, 'scout')).toBeUndefined()
    expect(getRegisteredAgentName(state, 'task-a')).toBe('scout')
  })

  test('first matching entry wins when several names share a task id', () => {
    const state = {
      agentNameRegistry: registry([
        ['first', 'task-a'],
        ['second', 'task-a'],
      ]),
    }
    expect(getRegisteredAgentName(state, 'task-a')).toBe('first')
  })
})
