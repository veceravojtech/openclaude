import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { useTeammateViewAutoExit } from './useTeammateViewAutoExit.js'

/**
 * When the teammate view gives up and returns to the leader.
 *
 * Exactly one reason: the viewed task is gone from AppState. It used to eject the
 * moment the teammate's status went killed/failed, which is the other half of
 * "rows vanish under the cursor" — a teammate that finished could not be read at
 * all, because the view closed in the same tick its row would have turned dim.
 * A finished teammate now keeps its task for TEAMMATE_GRACE_MS, and the view
 * follows the task, not the status.
 */

function teammate(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: 'task-supervisor',
    type: 'in_process_teammate',
    status: 'running',
    description: 'supervisor: working',
    startTime: Date.now(),
    outputFile: '/tmp/supervisor.log',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'supervisor@email',
      agentName: 'supervisor',
      teamName: 'email',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: '',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

type Harness = {
  viewing: () => string | undefined
  update: (updater: (prev: AppState) => AppState) => void
  cleanup: () => Promise<void>
}

function Probe({
  onReady,
  onViewing,
}: {
  onReady: (update: (updater: (prev: AppState) => AppState) => void) => void
  onViewing: (id: string | undefined) => void
}): null {
  useTeammateViewAutoExit()
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  React.useEffect(() => onReady(setAppState), [setAppState, onReady])
  React.useEffect(() => onViewing(viewingAgentTaskId), [viewingAgentTaskId, onViewing])
  return null
}

async function mount(initialState: AppState): Promise<Harness> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let update: ((updater: (prev: AppState) => AppState) => void) | undefined
  let viewing: string | undefined
  root.render(
    <AppStateProvider initialState={initialState}>
      <Probe
        onReady={value => {
          update = value
        }}
        onViewing={value => {
          viewing = value
        }}
      />
    </AppStateProvider>,
  )
  for (let attempts = 0; attempts < 100 && !update; attempts++) {
    await Bun.sleep(10)
  }
  expect(update).toBeDefined()
  return {
    viewing: () => viewing,
    update: updater => update!(updater),
    async cleanup() {
      root.unmount()
      await Bun.sleep(30)
      stdin.end()
      stdout.end()
    },
  }
}

function viewingState(task: InProcessTeammateTaskState): AppState {
  return {
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    viewingAgentTaskId: task.id,
    viewSelectionMode: 'viewing-agent',
  } as AppState
}

describe('useTeammateViewAutoExit', () => {
  test.each(['completed', 'failed', 'killed'] as const)(
    'keeps the view open when the teammate goes %s but its task is still there',
    async status => {
      const task = teammate()
      const harness = await mount(viewingState(task))
      try {
        expect(harness.viewing()).toBe(task.id)
        harness.update(prev => ({
          ...prev,
          tasks: {
            [task.id]: {
              ...task,
              status,
              notified: true,
              error: status === 'failed' ? 'it blew up' : undefined,
              retain: false,
              evictAfter: Date.now() + 30_000,
            },
          },
        }))
        await Bun.sleep(60)
        // The transcript is exactly what the user wants to read at this moment.
        expect(harness.viewing()).toBe(task.id)
      } finally {
        await harness.cleanup()
      }
    },
  )

  test('returns to the leader once the task is evicted', async () => {
    const task = teammate({ status: 'killed', notified: true })
    const harness = await mount(viewingState(task))
    try {
      expect(harness.viewing()).toBe(task.id)
      harness.update(prev => ({ ...prev, tasks: {} }))
      await Bun.sleep(60)
      expect(harness.viewing()).toBeUndefined()
    } finally {
      await harness.cleanup()
    }
  })

  test('does not touch a view of something that is not a teammate', async () => {
    // A local_agent task is viewed through the same viewingAgentTaskId and is
    // retained by the panel while viewed; the old teammate-narrowed status checks
    // read `undefined` for it, and the presence check must not start ejecting it.
    const localAgent = {
      id: 'task-agent',
      type: 'local_agent',
      status: 'completed',
      description: 'a background agent',
      startTime: Date.now(),
      outputFile: '/tmp/agent.log',
      outputOffset: 0,
      notified: true,
      retain: true,
    } as unknown as InProcessTeammateTaskState
    const harness = await mount(viewingState(localAgent))
    try {
      await Bun.sleep(60)
      expect(harness.viewing()).toBe(localAgent.id)
    } finally {
      await harness.cleanup()
    }
  })
})
