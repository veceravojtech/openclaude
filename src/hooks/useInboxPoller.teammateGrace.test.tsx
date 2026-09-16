import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../ink.js'
import {
  type AppState,
  AppStateProvider,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getRunningTeammatesSorted } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { evictTerminalTask, TEAMMATE_GRACE_MS } from '../utils/task/framework.js'
import type { TeammateMessage } from '../utils/teammateMailbox.js'
import { useInboxPoller } from './useInboxPoller.js'

/**
 * S3: an out-of-process (tmux/iTerm2) teammate's row must get the same 30s
 * grace every in-process teammate gets.
 *
 * `spawnMultiAgent` registers an `in_process_teammate` task for a PANE teammate
 * too, so such a teammate does appear in the teammates tree and the pill row —
 * and this poller's shutdown-approval branch is its ONLY terminal transition.
 * It wrote `status: 'completed'` with no `retain`/`evictAfter`, so the row
 * vanished the instant the teammate shut down (nothing to keep it in the shared
 * order) and carried no deadline for the lazy GC to collect it by either.
 */

const MAILBOX_MODULE = '../utils/teammateMailbox.js'
const LEAD_AGENT_ID = 'lead-agent'
const TEAMMATE_AGENT_ID = 'supervisor-agent'

let actualMailbox: typeof import('../utils/teammateMailbox.js')

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useInboxPoller.teammateGrace.test.tsx')
  // Capture the real module first and restore it afterwards, so only the two
  // functions that would touch the inbox on disk are replaced — the shutdown
  // message below is parsed by the REAL isShutdownApproved.
  actualMailbox = await import(`${MAILBOX_MODULE}?actual=${Date.now()}`)
})

afterEach(() => {
  mock.module(MAILBOX_MODULE, () => ({ ...actualMailbox }))
  releaseSharedMutationLock()
})

function paneTeammateTask(): InProcessTeammateTaskState {
  return {
    id: 'task-supervisor',
    type: 'in_process_teammate',
    status: 'running',
    description: 'supervisor: working',
    startTime: 1_700_000_000_000,
    outputFile: '/tmp/supervisor.log',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: TEAMMATE_AGENT_ID,
      agentName: 'supervisor',
      teamName: 'email',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: 'prompt of supervisor',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function shutdownApproval(): TeammateMessage {
  return {
    id: 'msg-1',
    from: 'supervisor',
    // No paneId/backendType: the pane-killing branch needs a real backend
    // registry and is not what this case is about.
    text: JSON.stringify({
      type: 'shutdown_approved',
      requestId: 'req-1',
      from: 'supervisor',
      timestamp: new Date().toISOString(),
    }),
    timestamp: new Date().toISOString(),
  } as unknown as TeammateMessage
}

function leadState(task: InProcessTeammateTaskState): AppState {
  return {
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    teamContext: {
      // Empty on purpose: with no team name the branch skips the team-file
      // write and the task unassignment, both of which are disk work that has
      // nothing to do with the row's retention marker.
      teamName: '',
      teamFilePath: '',
      leadAgentId: LEAD_AGENT_ID,
      teammates: {
        [LEAD_AGENT_ID]: {
          name: 'team-lead',
          tmuxSessionName: 's',
          tmuxPaneId: '%0',
          cwd: '/tmp',
          spawnedAt: 1_700_000_000_000,
        },
        [TEAMMATE_AGENT_ID]: {
          name: 'supervisor',
          tmuxSessionName: 's',
          tmuxPaneId: '%1',
          cwd: '/tmp',
          spawnedAt: 1_700_000_000_000,
        },
      },
    },
  }
}

function Harness({
  onTasks,
  onSetAppState,
}: {
  onTasks: (tasks: Record<string, InProcessTeammateTaskState>) => void
  onSetAppState: (
    setAppState: (updater: (prev: AppState) => AppState) => void,
  ) => void
}): React.ReactNode {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: () => true,
  })
  const tasks = useAppState(s => s.tasks)
  const setAppState = useSetAppState()
  React.useEffect(
    () => onTasks(tasks as Record<string, InProcessTeammateTaskState>),
    [tasks, onTasks],
  )
  React.useEffect(
    () => onSetAppState(setAppState),
    [setAppState, onSetAppState],
  )
  return null
}

async function pollOnce(initialState: AppState): Promise<{
  tasks: () => Record<string, InProcessTeammateTaskState>
  setAppState: (updater: (prev: AppState) => AppState) => void
  cleanup: () => Promise<void>
}> {
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
  let latest: Record<string, InProcessTeammateTaskState> = {}
  let setAppState:
    | ((updater: (prev: AppState) => AppState) => void)
    | undefined
  root.render(
    <AppStateProvider initialState={initialState}>
      <Harness
        onTasks={next => {
          latest = next
        }}
        onSetAppState={next => {
          setAppState = next
        }}
      />
    </AppStateProvider>,
  )
  for (let attempt = 0; attempt < 60; attempt++) {
    await Bun.sleep(25)
    if (latest['task-supervisor']?.status === 'completed') break
  }
  expect(setAppState).toBeDefined()
  return {
    tasks: () => latest,
    setAppState: updater => setAppState!(updater),
    async cleanup() {
      root.unmount()
      await Bun.sleep(30)
      stdin.end()
      stdout.end()
    },
  }
}

test('a pane teammate shutting down keeps its row for the grace window', async () => {
  let delivered = false
  mock.module(MAILBOX_MODULE, () => ({
    ...actualMailbox,
    readUnreadMessages: async () => {
      if (delivered) return []
      delivered = true
      return [shutdownApproval()]
    },
    markMessagesAsRead: async () => {},
  }))

  const before = Date.now()
  const polled = await pollOnce(leadState(paneTeammateTask()))
  try {
    const task = polled.tasks()['task-supervisor']
    expect(task?.status).toBe('completed')
    // The marker pair, exactly as the three in-process terminal writers set it.
    expect(task?.retain).toBe(false)
    expect(task?.evictAfter).toBeGreaterThanOrEqual(before + TEAMMATE_GRACE_MS)
    expect(task?.evictAfter).toBeLessThanOrEqual(
      Date.now() + TEAMMATE_GRACE_MS,
    )

    // …which is what keeps the row in the ONE shared order every surface reads,
    // and takes it out again the moment the deadline passes. This is the part
    // that was broken: with no marker the row left the order immediately.
    const tasks = polled.tasks()
    expect(
      getRunningTeammatesSorted(tasks, task!.evictAfter! - 1).map(t => t.id),
    ).toEqual(['task-supervisor'])
    expect(
      getRunningTeammatesSorted(tasks, task!.evictAfter! + 1),
    ).toHaveLength(0)
  } finally {
    await polled.cleanup()
  }
})

test('…and the task is then COLLECTED once the deadline passes, instead of sitting in AppState for the session', async () => {
  // The other half of the marker. Both evictors bail on `!task.notified`, so
  // writing status/retain/evictAfter without it meant the row left the shared
  // order at the deadline and the task object stayed behind for the rest of the
  // session. The completion IS delivered — the same updater appends the
  // `teammate_terminated` system message the lead reads — so this transition
  // owes no further notification and the flag is honest.
  let delivered = false
  mock.module(MAILBOX_MODULE, () => ({
    ...actualMailbox,
    readUnreadMessages: async () => {
      if (delivered) return []
      delivered = true
      return [shutdownApproval()]
    },
    markMessagesAsRead: async () => {},
  }))

  const polled = await pollOnce(leadState(paneTeammateTask()))
  try {
    const task = polled.tasks()['task-supervisor']
    expect(task?.status).toBe('completed')
    expect(task?.notified).toBe(true)

    // Inside the window the shared retain/grace rule still holds the task, so
    // the eager collector refuses it — the row is still on screen.
    evictTerminalTask('task-supervisor', polled.setAppState)
    await Bun.sleep(30)
    expect(polled.tasks()['task-supervisor']).toBeDefined()

    // Past the deadline it goes. The clock is mocked across the one synchronous
    // updater rather than waiting 30s; evictTerminalTask reads Date.now()
    // through isRetainedOrWithinGrace, which takes no `now` from its callers.
    const nowSpy = spyOn(Date, 'now').mockReturnValue(
      task!.evictAfter! + 1_000,
    )
    try {
      evictTerminalTask('task-supervisor', polled.setAppState)
    } finally {
      nowSpy.mockRestore()
    }
    await Bun.sleep(30)
    expect(polled.tasks()['task-supervisor']).toBeUndefined()
  } finally {
    await polled.cleanup()
  }
})
