import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import type {
  PaneLiveness,
  PanePresence,
} from '../../utils/swarm/backends/types.js'
import type { AppState } from '../../state/AppState.js'
import {
  ensureTeamSweeper,
  getTeamSweeper,
  PANE_FAILURE_TAIL_LINES,
  PANE_GONE_LINE,
  type PaneTeammateWatchdogDeps,
  type PaneTeammateWatchdogHandle,
  type TeamSweeperHandle,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import type {
  PaneWatchdogMailboxMessage,
  PaneWatchdogTeamFile,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  cancelFailedTeammateReap,
  hasPendingFailedTeammateReap,
  scheduleFailedTeammateReap,
  resetFailedTeammateReapsForTesting,
  type ReaperTimers,
} from '../../utils/swarm/failedTeammateReaper.js'
import { TEAMMATE_GRACE_MS } from '../../utils/task/framework.js'
import { getTaskPath, listTasks } from '../../utils/tasks.js'
import type { Message } from '../../types/message.js'
import {
  createIdleNotification,
  getTeammateTurnReport,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { unescapeXml } from '../../utils/xml.js'
import * as spawnMod from './spawnMultiAgent.js'

/**
 * First-contact watchdog for out-of-process (pane) teammates.
 *
 * Drives `registerOutOfProcessTeammateTask` — the real registration path a
 * tmux/iTerm2 spawn takes — with every boundary injected: clock, lead
 * mailbox, team file, pane probe and timers. No tmux, no filesystem team
 * state, no real panes are touched.
 *
 * The scenarios map to the incident these tests exist for: a pane child
 * whose route does not resolve dies on its first turn with no signal at
 * all (query.ts skips Stop hooks on API-error turns), leaving a task row
 * status:'running' forever while the pane's shell keeps the pane alive.
 */

type World = {
  state: { tasks: Record<string, Record<string, unknown>> } & Record<
    string,
    unknown
  >
  setAppState: (updater: (prev: AppState) => AppState) => void
  mailbox: PaneWatchdogMailboxMessage[]
  teamFile: Omit<PaneWatchdogTeamFile, 'members'> & {
    members: Array<{ name: string; isActive?: boolean }>
  }
  probes: PaneLiveness[]
  probeCalls: number
  /**
   * Pane presence answers for the ghost sweep, keyed by pane id, plus the
   * panes it was asked about — the sweep probes OTHER members' panes, so it
   * answers from a table instead of the single-file `probes` queue above.
   */
  memberPresence: Map<string, PanePresence>
  memberPresenceCalls: string[]
  /** What the injected pane capture answers (null: pane gone/unreadable). */
  paneTail: string | null
  /** Every unassign the watchdog's failure path asked for. */
  unassignCalls: Array<{ teamName: string; agentId: string; name: string }>
  nowMs: number
  handles: PaneTeammateWatchdogHandle[]
  taskId: () => string | undefined
  notifications: () => string[]
}

const FIRST_CONTACT_TIMEOUT_MS = 60_000
const PROGRESS_TIMEOUT_MS = 600_000
const UNKNOWN_RETRY_DELAY_MS = 1_000
const MAX_UNKNOWN_RETRIES = 3

function idleNotification(
  from: string,
  nowMs: number,
  idleReason?: 'available' | 'interrupted' | 'failed' | 'parked' | 'waiting_for_children',
  summary?: string,
  failureReason?: string,
): PaneWatchdogMailboxMessage {
  return {
    from,
    text: JSON.stringify({
      type: 'idle_notification',
      from,
      timestamp: new Date(nowMs).toISOString(),
      idleReason,
      summary,
      failureReason,
    }),
    timestamp: new Date(nowMs).toISOString(),
  }
}

test('delegated waiting does not complete or timeout, then quiet completes', async () => {
  const world = makeWorld()
  registerTeammate(world)
  const handle = world.handles[0]!
  world.mailbox.push(idleNotification('worker', world.nowMs, 'waiting_for_children'))
  world.probes.push('alive', 'alive')
  await handle.scan()
  expect(world.state.tasks[world.taskId()!]!.status).toBe('running')
  world.nowMs += PROGRESS_TIMEOUT_MS * 2
  await handle.scan()
  expect(world.state.tasks[world.taskId()!]!.status).toBe('running')
  expect(world.notifications()).toHaveLength(0)
  world.mailbox.push(idleNotification('worker', world.nowMs, 'available'))
  await handle.scan()
  // The quiet transition marks the living pane idle but keeps it running —
  // the pane is alive and resumable, not finished-for-good.
  expect(world.state.tasks[world.taskId()!]!.status).toBe('running')
  expect(world.state.tasks[world.taskId()!]!.isIdle).toBe(true)
  expect(world.notifications()).toHaveLength(1)
  expect(world.notifications()[0]).toContain('<status>completed</status>')
})

test('an available notice leaves a living pane idle and resumable, delivering the result exactly once', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'available', 'first turn done'),
  )
  await world.handles[0]!.scan()

  // Not terminal: the pane is alive at its prompt and addressable.
  expect(taskStatus(world)).toBe('running')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.isIdle).toBe(true)

  // The first-turn result reached the lead exactly once.
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<status>completed</status>')
  expect(notifications[0]).toContain('first turn done')

  // A re-scan (watchdog now disarmed) neither fails nor re-notifies.
  world.nowMs += PROGRESS_TIMEOUT_MS * 2
  world.probes = ['alive']
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(world.notifications().length).toBe(1)
})

test('delegated waiting still detects a dead pane', async () => {
  const world = makeWorld()
  registerTeammate(world)
  world.mailbox.push(idleNotification('worker', world.nowMs, 'waiting_for_children'))
  world.probes.push('dead')
  await world.handles[0]!.scan()
  expect(world.state.tasks[world.taskId()!]!.status).toBe('failed')
})

test('new self-active turn invalidates stale delegated waiting', async () => {
  const world = makeWorld()
  registerTeammate(world)
  world.mailbox.push(idleNotification('worker', world.nowMs, 'waiting_for_children'))
  world.probes.push('alive')
  await world.handles[0]!.scan()
  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  world.probes.push('alive')
  await world.handles[0]!.scan()
  expect(world.state.tasks[world.taskId()!]!.status).toBe('failed')
})

function makeWorld(teammateName = 'worker'): World {
  const world: World = {
    state: {
      tasks: {},
      // abortSpeculation (inside enqueueAgentNotification) reads this.
      speculation: { status: 'idle' },
    },
    setAppState: () => {},
    mailbox: [],
    teamFile: {
      leadAgentId: 'team-lead@team',
      members: [
        { name: 'team-lead' },
        { name: teammateName, isActive: undefined },
      ],
    },
    probes: [],
    probeCalls: 0,
    memberPresence: new Map(),
    memberPresenceCalls: [],
    paneTail: null,
    unassignCalls: [],
    nowMs: 1_000_000,
    handles: [],
    taskId: () => Object.keys(world.state.tasks)[0],
    notifications: () => [],
  }
  world.setAppState = (updater => {
    world.state = updater(world.state as unknown as AppState) as unknown as typeof world.state
  }) as World['setAppState']
  world.notifications = () =>
    getCommandQueue()
      .map(cmd => String(cmd.value))
      .filter(text => {
        const taskId = world.taskId()
        return taskId !== undefined && text.includes(taskId)
      })
  return world
}

function watchdogDeps(world: World): PaneTeammateWatchdogDeps {
  return {
    now: () => world.nowMs,
    currentSessionId: SESSION,
    readLeadMailbox: async () => world.mailbox,
    readTeamFile: async () => world.teamFile,
    probePane: async () => {
      world.probeCalls++
      return world.probes.shift() ?? 'unknown'
    },
    probeMemberPanePresence: async (_backendType, paneId) => {
      world.memberPresenceCalls.push(paneId)
      // Defaults to a present pane: a sweep test has to say which pane is absent.
      return world.memberPresence.get(paneId) ?? 'present'
    },
    // Hermetic discovery: one reachable socket, and a no-op backfill write, so
    // socket-less members resolve through the injected presence map instead of
    // touching the real /tmp/tmux-$UID directory.
    discoverReachableSockets: async () => ['default'],
    recordMemberSocket: () => true,
    // Hermetic failure path: no real tmux capture, no real tasks dir.
    capturePaneTail: async () => world.paneTail,
    unassignMemberTasks: async (teamName, member) => {
      world.unassignCalls.push({ teamName, ...member })
      return ''
    },
    scanIntervalMs: null,
    firstContactTimeoutMs: FIRST_CONTACT_TIMEOUT_MS,
    progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    unknownRetryDelayMs: UNKNOWN_RETRY_DELAY_MS,
    maxUnknownRetries: MAX_UNKNOWN_RETRIES,
  }
}

function registerTeammate(
  world: World,
  teammateName = 'worker',
  deps: PaneTeammateWatchdogDeps = watchdogDeps(world),
): void {
  const register = (
    spawnMod as unknown as Record<string, unknown>
  ).registerOutOfProcessTeammateTask as
    | ((
        setAppState: World['setAppState'],
        options: Record<string, unknown>,
        deps?: PaneTeammateWatchdogDeps,
      ) => PaneTeammateWatchdogHandle | undefined)
    | undefined
  if (typeof register !== 'function') {
    throw new Error(
      'registerOutOfProcessTeammateTask is not exported — watchdog not wired',
    )
  }
  const handle = register(
    world.setAppState,
    {
      teammateId: `${teammateName}@team`,
      sanitizedName: teammateName,
      teamName: 'team',
      teammateColor: 'cyan',
      prompt: 'do the thing',
      plan_mode_required: false,
      paneId: '%42',
      insideTmux: true,
      backendType: 'tmux',
      toolUseId: 'toolu-1',
    },
    deps,
  )
  if (!handle || typeof handle.scan !== 'function') {
    throw new Error(
      'registerOutOfProcessTeammateTask returned no watchdog handle — watchdog not armed',
    )
  }
  world.handles.push(handle)
}

function taskStatus(world: World): string | undefined {
  const taskId = world.taskId()
  const task = taskId ? world.state.tasks[taskId] : undefined
  return task?.status as string | undefined
}

afterEach(() => {
  for (const handle of worldToDispose) handle.dispose()
  worldToDispose.length = 0
  // The team sweeper is a module-level singleton keyed by team; without this a
  // later test would inherit the previous test's sweeper (and its deps).
  getTeamSweeper('team')?.dispose()
  resetFailedTeammateReapsForTesting()
})

const worldToDispose: PaneTeammateWatchdogHandle[] = []

test('a pane child that never reports is marked failed and the lead is notified', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  // Nothing booted, nothing messaged: the first-contact deadline is what
  // fires, and a dead pane is named as a dead pane.
  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.error).toBe('Pane exited without completing')
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<task-notification>')
  expect(notifications[0]).toContain('<status>failed</status>')

  // Terminal is terminal: no second notification, no status churn.
  world.nowMs += PROGRESS_TIMEOUT_MS
  await world.handles[0]!.scan()
  expect(world.notifications().length).toBe(1)
  expect(taskStatus(world)).toBe('failed')
})

test('a booted child that goes silent — the incident — fails with a no-progress error, not a pane-exit claim', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  // Boot signal seen: the child wrote isActive:true at its first turn start.
  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()

  // …and then nothing, forever. The pane is still alive (shell foreground),
  // which is exactly why pane liveness alone could never catch this.
  world.probes = ['alive']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  // Exact shape, pinned: deadline named, never a death claim on an alive pane.
  expect(task.error).toBe(
    'Teammate emitted no lifecycle signal within 600s (pane alive but unresponsive)',
  )
  expect(world.notifications().length).toBe(1)
  expect(world.notifications()[0]).toContain('<status>failed</status>')
})

/** An idle notification carrying the teammate's last text (item 2's field). */
function idleWithText(
  from: string,
  nowMs: number,
  idleReason: 'waiting_for_children' | 'parked',
  lastAssistantText: string,
): PaneWatchdogMailboxMessage {
  const timestamp = new Date(nowMs).toISOString()
  return {
    from,
    text: JSON.stringify({
      type: 'idle_notification',
      from,
      timestamp,
      idleReason,
      lastAssistantText,
    }),
    timestamp,
  }
}

/** The `<result>` text as a reader sees it (the builder XML-escapes it). */
function resultOf(notification: string): string | undefined {
  const raw = notification.match(/<result>([\s\S]*)<\/result>/)?.[1]
  return raw === undefined ? undefined : unescapeXml(raw)
}

test("a watchdog failure's <result> carries the teammate's last text and the pane tail", async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.paneTail = 'Running tests...\nError: provider 400\n$ '
  world.mailbox.push(
    idleWithText('worker', world.nowMs, 'waiting_for_children', 'LAST: halfway through the fix'),
  )
  world.probes = ['dead']
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<status>failed</status>')
  const result = resultOf(notifications[0]!)
  expect(result).toBe(
    [
      'Pane exited while waiting for descendants',
      'Last assistant text:\nLAST: halfway through the fix',
      `Last ~${PANE_FAILURE_TAIL_LINES} lines of the pane:\nRunning tests...\nError: provider 400\n$ `,
    ].join('\n\n'),
  )
})

test('a deadline failure on a gone pane still notifies, saying no output could be captured', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.paneTail = null
  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(resultOf(notifications[0]!)).toBe(
    `Pane exited without completing\n\n${PANE_GONE_LINE}`,
  )
})

test('a pane capture that throws is reported as gone, never thrown out of the scan', async () => {
  const world = makeWorld()
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    capturePaneTail: async () => {
      throw new Error('tmux exploded')
    },
  })
  worldToDispose.push(...world.handles)

  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(resultOf(notifications[0]!)).toContain(PANE_GONE_LINE)
})

test("a dead-pane failure unassigns the teammate's tasks, once", async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()
  expect(world.unassignCalls).toEqual([])

  world.probes = ['dead']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  // No agentId on this roster row: the name is the owner key it falls back to.
  expect(world.unassignCalls).toEqual([
    { teamName: 'team', agentId: 'worker', name: 'worker' },
  ])

  // Later scans (still watching for a late completion) do not repeat it.
  world.nowMs += PROGRESS_TIMEOUT_MS
  await world.handles[0]!.scan()
  expect(world.unassignCalls.length).toBe(1)
})

test('an alive-pane timeout keeps the teammate\'s tasks: a slow child may still complete', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()
  world.paneTail = 'still compiling...'
  world.probes = ['alive']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  expect(world.unassignCalls).toEqual([])
  // The lead is still told, with the pane tail.
  expect(world.notifications().length).toBe(1)
  expect(resultOf(world.notifications()[0]!)).toContain('still compiling...')
})

test('an unknown-pane timeout keeps the teammate\'s tasks too', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  // Every probe answers unknown: the bounded deferral runs out, then fails.
  for (let i = 0; i <= MAX_UNKNOWN_RETRIES + 1; i++) {
    await world.handles[0]!.scan()
    world.nowMs += UNKNOWN_RETRY_DELAY_MS
  }
  expect(taskStatus(world)).toBe('failed')
  expect(world.unassignCalls).toEqual([])
  expect(world.notifications().length).toBe(1)
})

test('a completion that lands while the failure capture is pending wins: no failure, no unassign, no disarm race', async () => {
  const world = makeWorld()
  let releaseCapture: (tail: string | null) => void = () => {}
  const capture = new Promise<string | null>(resolve => {
    releaseCapture = resolve
  })
  let captureStarted = false
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    capturePaneTail: () => {
      captureStarted = true
      return capture
    },
  })
  worldToDispose.push(...world.handles)

  // The dead pane's failure awaits the capture. Nothing is committed yet:
  // the failed state is written only once the failure owns finalization.
  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const failing = world.handles[0]!.scanUnserialized()
  await waitUntil(() => captureStarted, 'captureStarted')
  expect(taskStatus(world)).toBe('running')

  // Meanwhile an overlapping scan sees the real completion and finalizes it.
  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE after all' }),
  )
  await world.handles[0]!.scanUnserialized()
  expect(world.handles[0]!.disposed).toBe(true)

  // Now the capture returns; the failure finds the watchdog disarmed and
  // leaves no trace.
  releaseCapture('late tail')
  await failing

  expect(taskStatus(world)).toBe('running')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.isIdle).toBe(true)
  expect(task.notified).toBe(true)
  expect(world.unassignCalls).toEqual([])
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<status>completed</status>')
  expect(resultOf(notifications[0]!)).toBe('DONE after all')
  expect(notifications.some(n => n.includes('<status>failed</status>'))).toBe(false)
})

/** Wait (yielding to timers and I/O) until `cond` holds; fail fast instead of hanging. */
async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let queued microtasks and timers run, so a waiting scan gets its chance. */
async function yieldTurns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

for (const scanMode of ['scan', 'scanUnserialized'] as const) {
test(`[${scanMode}] a completion that arrives while the dead-pane unassign is in flight waits: the failure commits whole, then the completion follows`, async () => {
  const world = makeWorld()
  let releaseUnassign: () => void = () => {}
  const unassignGate = new Promise<void>(resolve => {
    releaseUnassign = resolve
  })
  let unassignInFlight = false
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    // Gated INSIDE the task updates, where claims are being released.
    unassignMemberTasks: async (teamName, member) => {
      world.unassignCalls.push({ teamName, ...member })
      unassignInFlight = true
      await unassignGate
      return ''
    },
  })
  worldToDispose.push(...world.handles)

  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const failingScan = world.handles[0]!.scan()
  await waitUntil(() => unassignInFlight, 'unassignInFlight')

  // The completion lands mid-unassign. It must wait for the failure to finish.
  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE late' }),
  )
  const completionScan = world.handles[0]![scanMode]()
  await yieldTurns()
  expect(taskStatus(world)).toBe('failed')
  expect(world.notifications()).toEqual([])

  releaseUnassign()
  await failingScan
  await completionScan

  // (a): the failure committed whole, then the late-after-commit rule ran.
  expect(world.unassignCalls.length).toBe(1)
  expect(taskStatus(world)).toBe('completed')
  const notifications = world.notifications()
  expect(notifications.map(n => n.match(/<status>([^<]+)</)?.[1])).toEqual([
    'failed',
    'completed',
  ])
  expect(resultOf(notifications[1]!)).toBe('DONE late')
})
}

test('a completion after the failure fully committed: completed, notified after the failure, claims not restored', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  expect(world.unassignCalls.length).toBe(1)
  expect(world.notifications().length).toBe(1)

  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE much later' }),
  )
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('completed')
  const notifications = world.notifications()
  expect(notifications.map(n => n.match(/<status>([^<]+)</)?.[1])).toEqual([
    'failed',
    'completed',
  ])
  // The <result> is the completion alone; the separator is only in the file.
  expect(resultOf(notifications[1]!)).toBe('DONE much later')
  // Claims are not restored: nothing re-assigns, and unassign ran once.
  expect(world.unassignCalls.length).toBe(1)
})

test('an overlapping scan that read the mailbox before the failure committed delivers the completion by the late rule: never completed-over-failed, notified taken by the right outcome', async () => {
  const world = makeWorld()
  let mailReads = 0
  let releaseMail: (messages: PaneWatchdogMailboxMessage[]) => void = () => {}
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    readLeadMailbox: async () => {
      mailReads++
      // Scan B parks here with a running-task snapshot; scan A sails through.
      if (mailReads === 1) {
        return new Promise<PaneWatchdogMailboxMessage[]>(resolve => {
          releaseMail = resolve
        })
      }
      return world.mailbox
    },
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanB = handle.scanUnserialized()
  await waitUntil(() => mailReads === 1, 'scan B parked on the mailbox')
  await handle.scanUnserialized() // scan A: the dead pane fails the task, fully
  expect(taskStatus(world)).toBe('failed')
  expect(world.notifications().length).toBe(1)

  releaseMail([
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE overlapping' }),
  ])
  await scanB

  // B decided inside the lock from the fresh state (failed by this watchdog),
  // so it took the late-after-commit path: the task is completed, not left
  // failed under a completed notification, and `notified` was re-armed for it.
  expect(taskStatus(world)).toBe('completed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.notified).toBe(true)
  const notifications = world.notifications()
  expect(notifications.map(n => n.match(/<status>([^<]+)</)?.[1])).toEqual([
    'failed',
    'completed',
  ])
  expect(resultOf(notifications[1]!)).toBe('DONE overlapping')
  expect(world.unassignCalls.length).toBe(1)
})

test('an overlapping failure that loses does not disarm: the late completion is still delivered', async () => {
  const world = makeWorld()
  registerTeammate(world)
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  // Two scans both see the expired deadline and both go to failTask.
  world.probes = ['alive', 'alive']
  world.nowMs += PROGRESS_TIMEOUT_MS * 2
  await Promise.all([handle.scanUnserialized(), handle.scanUnserialized()])

  expect(taskStatus(world)).toBe('failed')
  expect(world.notifications().length).toBe(1)
  // The loser must not have disposed: the late-completion watch is promised.
  expect(handle.disposed).toBe(false)

  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE after the double failure' }),
  )
  await handle.scan()

  expect(taskStatus(world)).toBe('completed')
  const notifications = world.notifications()
  expect(notifications.map(n => n.match(/<status>([^<]+)</)?.[1])).toEqual([
    'failed',
    'completed',
  ])
})

test('scan is single-flight: a call during a running scan does not start a second, and queued calls coalesce', async () => {
  const world = makeWorld()
  let mailReads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    readLeadMailbox: async () => {
      mailReads++
      if (mailReads === 1) await gate
      return []
    },
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  const first = handle.scan()
  await waitUntil(() => mailReads === 1, 'first scan parked')
  const second = handle.scan()
  const third = handle.scan()
  await yieldTurns()
  expect(mailReads).toBe(1) // neither started while the first is in flight
  expect(second).toBe(third) // coalesced into one follow-up

  release()
  await first
  await second
  expect(mailReads).toBe(2) // exactly one follow-up ran
})

test('a scan that throws does not block later scans', async () => {
  const world = makeWorld()
  let mailReads = 0
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    readLeadMailbox: async () => {
      mailReads++
      if (mailReads === 1) throw new Error('mailbox unreadable')
      return []
    },
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  await expect(handle.scan()).rejects.toThrow('mailbox unreadable')
  await handle.scan()
  expect(mailReads).toBe(2)
})

test('an interval tick during an in-flight scan is skipped, not queued', async () => {
  const world = makeWorld()
  let mailReads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const TICK_MS = 777_001
  const ticks: Array<() => void> = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    if (ms !== TICK_MS) return realSetInterval(fn, ms)
    // Capture the watchdog's tick; hand back an inert real timer to clear.
    ticks.push(fn)
    return realSetInterval(() => {}, 1_000_000)
  }) as unknown as typeof setInterval
  try {
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      scanIntervalMs: TICK_MS,
      readLeadMailbox: async () => {
        mailReads++
        if (mailReads === 1) await gate
        return []
      },
    })
  } finally {
    globalThis.setInterval = realSetInterval
  }
  worldToDispose.push(...world.handles)
  // The team sweeper arms on the same interval; fire every captured tick.
  expect(ticks.length).toBeGreaterThanOrEqual(1)
  const tick = () => {
    for (const fn of ticks) fn()
  }

  tick() // starts the scan, which parks on the gate
  await waitUntil(() => mailReads === 1, 'tick scan parked')
  tick() // overlapping ticks: skipped
  tick()
  await yieldTurns()
  expect(mailReads).toBe(1)

  release()
  await yieldTurns()
  tick() // free again: the next tick scans
  await waitUntil(() => mailReads === 2, 'next tick scanned')
})

function dmFrom(from: string, nowMs: number): PaneWatchdogMailboxMessage {
  const timestamp = new Date(nowMs).toISOString()
  return {
    from,
    text: JSON.stringify({ type: 'permission_request', from, tool: 'Bash' }),
    timestamp,
  }
}

type Gated = { started: () => boolean; release: () => void }

/** A dep that parks on a gate once, then answers `value`. */
function gatedDep<T>(value: T): { dep: () => Promise<T>; gate: Gated } {
  let started = false
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  return {
    dep: async () => {
      started = true
      await gate
      return value
    },
    gate: { started: () => started, release },
  }
}

function statusesOf(world: World): Array<string | undefined> {
  return world.notifications().map(n => n.match(/<status>([^<]+)</)?.[1])
}

for (const awaiting of ['probe', 'capture'] as const) {
  test(`a DM that lands during the failure ${awaiting} aborts the deadline failure with no side effects and restarts the deadline`, async () => {
    const world = makeWorld()
    const probe = gatedDep<'alive'>('alive')
    const capture = gatedDep<string | null>(null)
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      probePane: awaiting === 'probe' ? probe.dep : async () => 'alive',
      capturePaneTail: awaiting === 'capture' ? capture.dep : async () => null,
    })
    const handle = world.handles[0]!
    worldToDispose.push(handle)
    const gate = awaiting === 'probe' ? probe.gate : capture.gate

    world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
    const scanning = handle.scan()
    await waitUntil(gate.started, `${awaiting} started`)
    const dmAt = world.nowMs
    world.mailbox.push(dmFrom('worker', dmAt))
    gate.release()
    await scanning

    expect(taskStatus(world)).toBe('running')
    expect(world.notifications()).toEqual([])
    expect(world.unassignCalls).toEqual([])
    expect(handle.disposed).toBe(false)

    // The deadline restarted from the DM, held by the watchdog itself: even if
    // the message is gone from the mailbox (the lead consumed it), nothing
    // fails right after it...
    world.mailbox.length = 0
    world.nowMs += 1
    world.probes = ['alive']
    await handle.scan()
    expect(taskStatus(world)).toBe('running')
    // ...and a full silent window after it fails again, once.
    world.nowMs = dmAt + PROGRESS_TIMEOUT_MS + 1
    await handle.scan()
    expect(taskStatus(world)).toBe('failed')
    expect(statusesOf(world)).toEqual(['failed'])
  })
}

test('a watchdog disposed during the failure capture commits nothing', async () => {
  const world = makeWorld()
  const capture = gatedDep<string | null>(null)
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    probePane: async () => 'dead',
    capturePaneTail: capture.dep,
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanning = handle.scan()
  await waitUntil(capture.gate.started, 'capture started')
  handle.dispose() // abort signal, or a self-reported outcome of another holder
  capture.gate.release()
  await scanning

  expect(taskStatus(world)).toBe('running')
  expect(world.unassignCalls).toEqual([])
  expect(world.notifications()).toEqual([])
})

test('an idle report that lands during the failure capture is completed once through the normal path, never failed first', async () => {
  const world = makeWorld()
  const capture = gatedDep<string | null>(null)
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    probePane: async () => 'alive',
    capturePaneTail: capture.dep,
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanning = handle.scan()
  await waitUntil(capture.gate.started, 'capture started')
  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE during capture' }),
  )
  capture.gate.release()
  await scanning
  // Aborted, not failed: the report is left for the next scan, unread.
  expect(taskStatus(world)).toBe('running')
  expect(world.notifications()).toEqual([])

  await handle.scan()
  await handle.scan() // a second scan must not process the same report again
  expect(statusesOf(world)).toEqual(['completed'])
  expect(resultOf(world.notifications()[0]!)).toBe('DONE during capture')
})

test('an unchanged mailbox does not abort: a message the scan already counted is not fresh progress', async () => {
  const world = makeWorld()
  registerTeammate(world)
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  const dmAt = world.nowMs
  world.mailbox.push(dmFrom('worker', dmAt))
  world.nowMs = dmAt + PROGRESS_TIMEOUT_MS + 1
  world.probes = ['alive']
  await handle.scan()

  expect(taskStatus(world)).toBe('failed')
  expect(statusesOf(world)).toEqual(['failed'])
})

test('a dead pane still fails after a non-idle signal (a DM does not un-kill it), but an idle report that landed first wins', async () => {
  const dead = makeWorld()
  const probe = gatedDep<'dead'>('dead')
  registerTeammate(dead, 'worker', { ...watchdogDeps(dead), probePane: probe.dep })
  worldToDispose.push(dead.handles[0]!)
  dead.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanning = dead.handles[0]!.scan()
  await waitUntil(probe.gate.started, 'probe started')
  dead.mailbox.push(dmFrom('worker', dead.nowMs))
  probe.gate.release()
  await scanning
  expect(taskStatus(dead)).toBe('failed')
  expect(dead.unassignCalls.length).toBe(1)
  expect(statusesOf(dead)).toEqual(['failed'])

  // An idle report written before the pane exited does win: no failure, no unassign.
  const done = makeWorld()
  const probe2 = gatedDep<'dead'>('dead')
  registerTeammate(done, 'worker', { ...watchdogDeps(done), probePane: probe2.dep })
  worldToDispose.push(done.handles[0]!)
  done.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanning2 = done.handles[0]!.scan()
  await waitUntil(probe2.gate.started, 'probe 2 started')
  done.mailbox.push(idleWithReport('worker', done.nowMs, { lastAssistantText: 'DONE then exited' }))
  probe2.gate.release()
  await scanning2
  expect(done.unassignCalls).toEqual([])
  expect(statusesOf(done)).toEqual([])
  await done.handles[0]!.scan()
  expect(statusesOf(done)).toEqual(['completed'])
})

test('a non-idle signal after a committed failure does not revive the task; a later idle report repairs it', async () => {
  const world = makeWorld()
  registerTeammate(world)
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  world.probes = ['alive']
  await handle.scan()
  expect(taskStatus(world)).toBe('failed')

  world.mailbox.push(dmFrom('worker', world.nowMs + 1))
  world.nowMs += 5
  await handle.scan()
  // Rule (a): the failure stands; the signal neither reverts it nor notifies.
  expect(taskStatus(world)).toBe('failed')
  expect(statusesOf(world)).toEqual(['failed'])
  expect(handle.disposed).toBe(false)

  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { lastAssistantText: 'DONE eventually' }),
  )
  await handle.scan()
  expect(taskStatus(world)).toBe('completed')
  expect(statusesOf(world)).toEqual(['failed', 'completed'])
})

function untimestampedDm(from: string): PaneWatchdogMailboxMessage {
  return { from, text: JSON.stringify({ type: 'permission_request', from, tool: 'Read' }) }
}

test('an untimestamped message absorbed before the deadline is not fresh progress: the failure commits once', async () => {
  const world = makeWorld()
  registerTeammate(world)
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  const seenAt = world.nowMs
  world.mailbox.push(untimestampedDm('worker'))
  await handle.scan() // absorbed here, at seenAt
  expect(taskStatus(world)).toBe('running')

  // One full silent window later the same durable entry is still in the
  // mailbox. Re-reading it must not look like progress at the later time.
  world.nowMs = seenAt + PROGRESS_TIMEOUT_MS + 1
  world.probes = ['alive']
  await handle.scan()

  expect(taskStatus(world)).toBe('failed')
  expect(statusesOf(world)).toEqual(['failed'])
})

for (const awaiting of ['probe', 'capture'] as const) {
  test(`a NEW untimestamped message during the failure ${awaiting} aborts once; the same entry re-read later does not keep aborting`, async () => {
    const world = makeWorld()
    const probe = gatedDep<'alive'>('alive')
    const capture = gatedDep<string | null>(null)
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      probePane: awaiting === 'probe' ? probe.dep : async () => 'alive',
      capturePaneTail: awaiting === 'capture' ? capture.dep : async () => null,
    })
    const handle = world.handles[0]!
    worldToDispose.push(handle)
    const gate = awaiting === 'probe' ? probe.gate : capture.gate

    world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
    const scanning = handle.scan()
    await waitUntil(gate.started, `${awaiting} started`)
    const arrivedAt = world.nowMs
    world.mailbox.push(untimestampedDm('worker'))
    gate.release()
    await scanning
    expect(taskStatus(world)).toBe('running')
    expect(world.notifications()).toEqual([])
    expect(handle.disposed).toBe(false)

    // The entry stays in the mailbox. A later silent window fails once.
    world.nowMs = arrivedAt + PROGRESS_TIMEOUT_MS + 1
    await handle.scan()
    expect(taskStatus(world)).toBe('failed')
    expect(statusesOf(world)).toEqual(['failed'])
  })
}

for (const awaiting of ['probe', 'capture'] as const) {
  test(`isActive flipping to true during the failure ${awaiting} (alive pane, no mail) aborts the first-contact failure and restarts the clock`, async () => {
    const world = makeWorld()
    const probe = gatedDep<'alive'>('alive')
    const capture = gatedDep<string | null>(null)
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      probePane: awaiting === 'probe' ? probe.dep : async () => 'alive',
      capturePaneTail: awaiting === 'capture' ? capture.dep : async () => null,
    })
    const handle = world.handles[0]!
    worldToDispose.push(handle)
    const gate = awaiting === 'probe' ? probe.gate : capture.gate

    world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
    const scanning = handle.scan()
    await waitUntil(gate.started, `${awaiting} started`)
    const flippedAt = world.nowMs
    world.teamFile.members[1]!.isActive = true
    gate.release()
    await scanning

    expect(taskStatus(world)).toBe('running')
    expect(world.notifications()).toEqual([])
    expect(world.unassignCalls).toEqual([])
    expect(handle.disposed).toBe(false)

    // Booted now, with the progress clock restarted at the flip: nothing fails
    // soon after, and one silent progress window later it fails once.
    world.nowMs = flippedAt + PROGRESS_TIMEOUT_MS - 1
    world.probes = ['alive']
    await handle.scan()
    expect(taskStatus(world)).toBe('running')
    world.nowMs = flippedAt + PROGRESS_TIMEOUT_MS + 1
    await handle.scan()
    expect(taskStatus(world)).toBe('failed')
    expect(statusesOf(world)).toEqual(['failed'])
  })
}

test('isActive flipping during the capture of an unknown-pane failure aborts it too', async () => {
  const world = makeWorld()
  const capture = gatedDep<string | null>(null)
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    capturePaneTail: capture.dep,
  })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  // Every probe answers unknown; the bounded deferral runs out at the last scan.
  let last: Promise<void> = Promise.resolve()
  for (let i = 0; i <= MAX_UNKNOWN_RETRIES + 1; i++) {
    last = handle.scan()
    if (i <= MAX_UNKNOWN_RETRIES) {
      await last
      world.nowMs += UNKNOWN_RETRY_DELAY_MS
    }
  }
  await waitUntil(capture.gate.started, 'capture started')
  world.teamFile.members[1]!.isActive = true
  capture.gate.release()
  await last

  expect(taskStatus(world)).toBe('running')
  expect(world.notifications()).toEqual([])
  expect(handle.disposed).toBe(false)
})

test('isActive flipping during the probe of a confirmed-dead pane does not stop the failure', async () => {
  const world = makeWorld()
  const probe = gatedDep<'dead'>('dead')
  registerTeammate(world, 'worker', { ...watchdogDeps(world), probePane: probe.dep })
  const handle = world.handles[0]!
  worldToDispose.push(handle)

  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  const scanning = handle.scan()
  await waitUntil(probe.gate.started, 'probe started')
  world.teamFile.members[1]!.isActive = true
  probe.gate.release()
  await scanning

  expect(taskStatus(world)).toBe('failed')
  expect(world.unassignCalls.length).toBe(1)
  expect(statusesOf(world)).toEqual(['failed'])
})

test('a failure whose unassign throws still notifies the lead', async () => {
  const world = makeWorld()
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    unassignMemberTasks: async () => {
      throw new Error('tasks dir locked')
    },
  })
  worldToDispose.push(...world.handles)

  world.probes = ['dead']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  expect(world.notifications().length).toBe(1)
})

test('a late real completion after a watchdog failure wins — the task self-corrects to completed', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  // The watchdog fires on a merely-slow child…
  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()
  world.probes = ['alive']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  expect(world.notifications().length).toBe(1)
  expect(world.notifications()[0]).toContain('<status>failed</status>')

  // …and then the child, which was working all along, finishes its turn. The
  // completion must WIN: failed → completed, completion emitted despite the
  // earlier failure having set `notified`.
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'available', 'slow but finished'),
  )
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('completed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.error).toBeUndefined()
  const notifications = world.notifications()
  expect(notifications.length).toBe(2)
  expect(notifications[1]).toContain('<status>completed</status>')
  expect(notifications[1]).toContain('slow but finished')

  // And it stays won: no further churn.
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('completed')
  expect(world.notifications().length).toBe(2)
})

test('a healthy child disarms the watchdog and reports success', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'available', 'found the bug'),
  )
  await world.handles[0]!.scan()

  // The healthy child reports success, but stays running/idle — resumable.
  expect(taskStatus(world)).toBe('running')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.isIdle).toBe(true)
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<status>completed</status>')
  expect(notifications[0]).toContain('found the bug')

  // The watchdog disarms after the first result; a later deadline can neither
  // fail an idle teammate nor flip it terminal.
  world.nowMs += PROGRESS_TIMEOUT_MS * 3
  world.probes = ['dead']
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(world.notifications().length).toBe(1)
})

function idleWithReport(
  from: string,
  nowMs: number,
  report: { lastAssistantText?: string; reportedToLead?: boolean; summary?: string },
): PaneWatchdogMailboxMessage {
  return {
    from,
    text: JSON.stringify({
      type: 'idle_notification',
      from,
      timestamp: new Date(nowMs).toISOString(),
      idleReason: 'available',
      ...report,
    }),
    timestamp: new Date(nowMs).toISOString(),
  }
}

test("the completion <result> carries the pane teammate's final text", async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleWithReport('worker', world.nowMs, {
      lastAssistantText: 'FINAL REPORT: 3 call sites, all fixed.',
      summary: '[to peer] handed over the tests',
    }),
  )
  await world.handles[0]!.scan()

  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  const result = notifications[0]!.match(/<result>([\s\S]*)<\/result>/)?.[1]
  expect(result).toContain('FINAL REPORT: 3 call sites, all fixed.')
  // The peer-DM summary is kept beside it.
  expect(result).toContain('[to peer] handed over the tests')
})

test('a pane teammate that messaged its lead but left no final text gets the short <result>', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleWithReport('worker', world.nowMs, { reportedToLead: true }),
  )
  await world.handles[0]!.scan()

  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain(
    '<result>Final report was delivered to the lead by SendMessage (not repeated here).</result>',
  )
})

test('an early progress DM to the lead never swallows the pane teammate\'s distinct final answer', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  // The turn, as the child's Stop hook sees it: a progress DM to the lead
  // that succeeded, then more work, then the real answer.
  const at = new Date(world.nowMs).toISOString()
  const turn = [
    { type: 'user', uuid: 'u0', timestamp: at, message: { role: 'user', content: 'investigate the flake' } },
    {
      type: 'assistant', uuid: 'a0', timestamp: at,
      message: { id: 'm0', role: 'assistant', content: [
        { type: 'tool_use', id: 'p1', name: 'SendMessage', input: { to: 'team-lead', summary: 'progress', message: 'Starting investigation' } },
      ] },
    },
    {
      type: 'user', uuid: 'u1', timestamp: at,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'p1', content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'sent' }) }] },
      ] },
    },
    {
      type: 'assistant', uuid: 'a1', timestamp: at,
      message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'FINAL: the flake is a clock race in retry.ts' },
      ] },
    },
  ] as unknown as Message[]
  // Built exactly as teammateInit's Stop hook builds it.
  const idle = createIdleNotification('worker', {
    idleReason: 'available',
    ...getTeammateTurnReport(turn, 'team-lead', 'team'),
  })
  expect(idle.reportedToLead).toBe(true)
  expect(idle.lastAssistantText).toBe('FINAL: the flake is a clock race in retry.ts')

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push({ from: 'worker', text: JSON.stringify(idle), timestamp: at })
  await world.handles[0]!.scan()

  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  const result = resultOf(notifications[0]!)
  expect(result).toContain('FINAL: the flake is a clock race in retry.ts')
  expect(result).not.toContain('delivered to the lead by SendMessage')
})

test('a child-reported provider failure fails immediately without waiting for the watchdog deadline', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleNotification(
      'worker',
      world.nowMs,
      'failed',
      undefined,
      'Teammate provider request failed before completion.',
    ),
  )
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('failed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.error).toBe('Teammate provider request failed before completion.')
  expect(world.probeCalls).toBe(0)
  expect(world.notifications().length).toBe(1)
  expect(world.notifications()[0]).toContain('<status>failed</status>')
})

test('a parked (usage-limited) child is proof of life, not failure, and later completes', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'parked', 'usage limit hit'),
  )
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(world.notifications().length).toBe(0)

  // Parked teammates wait out a usage window — silence past the progress
  // deadline must not fail them while parked.
  world.nowMs += PROGRESS_TIMEOUT_MS * 2
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(world.notifications().length).toBe(0)

  // The window resets, the teammate finishes its turn.
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'available', 'done after reset'),
  )
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(
    (world.state.tasks[world.taskId()!] as Record<string, unknown>).isIdle,
  ).toBe(true)
  expect(world.notifications().length).toBe(1)
  expect(world.notifications()[0]).toContain('<status>completed</status>')
})

test('an UNKNOWN pane state never causes a false pane-exit failure, only a bounded deferral', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()

  // Deadline expires but tmux cannot be read. Unknown defers the failure…
  world.probes = ['unknown']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')

  // …through the bounded retry budget…
  for (let i = 0; i < MAX_UNKNOWN_RETRIES; i++) {
    world.nowMs += UNKNOWN_RETRY_DELAY_MS
    await world.handles[0]!.scan()
    expect(taskStatus(world)).toBe('running')
  }

  // …and when the budget is exhausted the failure is the absence-of-progress
  // one — it must not claim the pane exited.
  world.nowMs += UNKNOWN_RETRY_DELAY_MS
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  const task = world.state.tasks[world.taskId()!] as Record<string, unknown>
  expect(task.error).toBe(
    'Teammate emitted no lifecycle signal within 604s (pane state unknown after 5 probes)',
  )

  // A transient unknown must not have fired a notification on the way.
  expect(world.notifications().length).toBe(1)
})

test('a signal that arrives during an unknown deferral completes instead of failing', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()

  world.probes = ['unknown']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')

  // The child was merely slow; its idle notification lands mid-deferral.
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'available', 'slow but done'),
  )
  world.nowMs += UNKNOWN_RETRY_DELAY_MS
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('running')
  expect(
    (world.state.tasks[world.taskId()!] as Record<string, unknown>).isIdle,
  ).toBe(true)
  expect(world.notifications().length).toBe(1)
})

test('a task already terminal by another hand is left alone — no emission, no churn', async () => {
  const world = makeWorld()
  registerTeammate(world)
  worldToDispose.push(...world.handles)

  // TaskStop already killed this teammate: status killed, notified true.
  const taskId = world.taskId()
  world.state.tasks[taskId!] = {
    ...world.state.tasks[taskId!]!,
    status: 'killed',
    notified: true,
  }

  world.nowMs += PROGRESS_TIMEOUT_MS * 2
  world.probes = ['dead']
  await world.handles[0]!.scan()

  expect(taskStatus(world)).toBe('killed')
  expect(world.notifications().length).toBe(0)
})

/**
 * STEP 3 — the ghost sweep: reconcile the roster with pane reality.
 *
 * These drive the same registration path as the tests above, but with the
 * team file, the tasks list and the roster removal REAL (a temp config home),
 * because the acceptance for this step is a file edit — the member is gone
 * from `config.json` — and a seam that fakes that would prove nothing. The
 * pane probe stays injected: which pane is gone is the input to the decision,
 * not the decision.
 *
 * The world these tests build is the live incident: a team file listing
 * `ghost` (pane `%99`, `isActive: false`, its pane killed by hand) beside the
 * watchdog's own teammate `worker`, whose pane is alive.
 */

const GHOST_ID = 'ghost@team'
const GHOST_PANE = '%99'
const GHOST_TASK_ID = 'task-ghost'
const WORKER_PANE = '%42'
const LOCK_NAME = 'tools/shared/spawnMultiAgent.paneWatchdog.test.ts'
/** The session these sweep tests claim to own; seeded into the team file. */
const SESSION = 'lead-session'

function rosterMember(
  name: string,
  paneId: string,
  backendType: string,
  isActive: boolean | undefined,
  tmuxSocket?: string,
): Record<string, unknown> {
  return {
    agentId: `${name}@team`,
    name,
    joinedAt: 0,
    tmuxPaneId: paneId,
    cwd: '/work',
    subscriptions: [],
    backendType,
    ...(tmuxSocket ? { tmuxSocket } : {}),
    ...(isActive === undefined ? {} : { isActive }),
  }
}

/** Team file + one owned task on disk, under a temp config home. */
function seedDiskRoster(
  members: Array<Record<string, unknown>>,
  leadSessionId: string | null = SESSION,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-ghost-sweep-'))
  setClaudeConfigHomeDirForTesting(dir)
  const teamPath = getTeamFilePath('team')
  mkdirSync(dirname(teamPath), { recursive: true })
  writeFileSync(
    teamPath,
    JSON.stringify({
      name: 'team',
      createdAt: 0,
      leadAgentId: 'team-lead@team',
      ...(leadSessionId !== null ? { leadSessionId } : {}),
      members,
    }),
  )
  const taskPath = getTaskPath('team', '7')
  mkdirSync(dirname(taskPath), { recursive: true })
  writeFileSync(
    taskPath,
    JSON.stringify({
      id: '7',
      subject: 'reassign me',
      description: 'work the ghost was holding',
      status: 'in_progress',
      owner: GHOST_ID,
      blocks: [],
      blockedBy: [],
    }),
  )
  return dir
}

/** The lead's AppState as it stands after a failed pane teammate. */
function seedGhostInAppState(world: World): void {
  world.state.tasks[GHOST_TASK_ID] = {
    id: GHOST_TASK_ID,
    type: 'in_process_teammate',
    status: 'running',
    description: 'ghost: do the thing',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: GHOST_ID,
      agentName: 'ghost',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'do the thing',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
  world.state.teamContext = {
    teamName: 'team',
    teammates: { [GHOST_ID]: { name: 'ghost' } },
  }
  world.state.inbox = { messages: [] }
}

/**
 * A watchdog for `worker` whose roster reads are the real team file, with the
 * ghost's row pre-seeded in AppState. `world.taskId` is re-pointed at the
 * watchdog's OWN row, since the ghost's row is in the same map.
 */
function makeSweepWorld(extraDeps: PaneTeammateWatchdogDeps = {}): World {
  const world = makeWorld()
  seedGhostInAppState(world)
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    readTeamFile: () => readTeamFileAsync('team'),
    // The sweep tests assert the REAL unassign against the temp tasks dir.
    unassignMemberTasks: undefined,
    ...extraDeps,
  })
  // The watchdog handle goes into worldToDispose (its own dispose), but the
  // sweep tests drive the TEAM sweeper: `world.handles[0]` is re-pointed at it
  // so the existing `.scan()` calls exercise the sweep.
  worldToDispose.push(...world.handles)
  const sweeper = getTeamSweeper('team')
  if (!sweeper) {
    throw new Error('team sweeper not armed')
  }
  world.handles = [sweeper as PaneTeammateWatchdogHandle]
  world.taskId = () =>
    Object.keys(world.state.tasks).find(id => id !== GHOST_TASK_ID)
  return world
}

function teamFileOnDisk() {
  return readTeamFileAsync('team')
}

test('a ghost member is swept only after two consecutive dead scans, and lands in the lead’s view as gone', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('worker', WORKER_PANE, 'tmux', false),
    rosterMember('ghost', GHOST_PANE, 'tmux', false, 'default'),
  ])
  try {
    const world = makeSweepWorld()
    world.memberPresence.set(GHOST_PANE, 'absent')

    // One dead sighting is not enough: a pane reads dead between the CLI
    // exiting and a respawn typing the next one in.
    await world.handles[0]!.scan()
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain(
      'ghost',
    )
    expect(world.memberPresenceCalls).toEqual([WORKER_PANE, GHOST_PANE])
    expect(
      (world.state.tasks[GHOST_TASK_ID] as Record<string, unknown>).status,
    ).toBe('running')

    // Second consecutive confirmation reaps it.
    await world.handles[0]!.scan()
    const team = await teamFileOnDisk()
    expect(team?.members.map(m => m.name)).toEqual(['team-lead', 'worker'])

    // The teammate's own row is untouched — the sweep is about the roster.
    expect(taskStatus(world)).toBe('running')

    // Its task row is force-completed with the retention marker the spinner
    // and the lazy GC read, and marked notified because the retirement IS the
    // notification.
    const ghostTask = world.state.tasks[GHOST_TASK_ID] as Record<
      string,
      unknown
    >
    expect(ghostTask.status).toBe('completed')
    expect(ghostTask.notified).toBe(true)
    expect(ghostTask.retain).toBe(false)
    expect(ghostTask.evictAfter).toBe(
      (ghostTask.endTime as number) + TEAMMATE_GRACE_MS,
    )

    // Gone from teamContext, and the lead was told once, in the inbox.
    const teamContext = world.state.teamContext as {
      teammates: Record<string, unknown>
    }
    expect(Object.keys(teamContext.teammates)).toEqual([])
    const inbox = world.state.inbox as { messages: Array<{ text: string }> }
    expect(inbox.messages.length).toBe(1)
    expect(inbox.messages[0]!.text).toContain('teammate_terminated')
    expect(inbox.messages[0]!.text).toContain('ghost has shut down.')

    // Its open task went back to the board.
    const tasks = await listTasks('team')
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.owner).toBeUndefined()
    expect(tasks[0]!.status).toBe('pending')

    // Idempotent: the roster no longer lists it, so nothing is probed for it,
    // nothing is rewritten and the lead is not told twice.
    const probesBefore = world.memberPresenceCalls.length
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()
    expect(world.memberPresenceCalls.slice(probesBefore)).toEqual([
      WORKER_PANE,
      WORKER_PANE,
    ])
    expect(
      (world.state.inbox as { messages: unknown[] }).messages.length,
    ).toBe(1)
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toEqual([
      'team-lead',
      'worker',
    ])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a member whose pane is alive, or whose state cannot be read, is never swept', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const world = makeSweepWorld()

    // Alive: a healthy teammate sitting at its own prompt is what most of the
    // roster looks like between turns, and isActive:false is exactly what an
    // idle teammate looks like — liveness is the whole distinction.
    world.memberPresence.set(GHOST_PANE, 'present')
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    // Unknown (tmux unreachable) is not evidence of anything, and it clears
    // the count: a dead → unknown → dead sequence is ONE dead sighting, not a
    // pair, so a flaky tmux cannot delete a teammate's row.
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()
    world.memberPresence.set(GHOST_PANE, 'unknown')
    await world.handles[0]!.scan()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain(
      'ghost',
    )
    expect(
      (world.state.tasks[GHOST_TASK_ID] as Record<string, unknown>).status,
    ).toBe('running')
    expect(
      (world.state.inbox as { messages: unknown[] }).messages.length,
    ).toBe(0)
    // …and its task was never unassigned either.
    expect((await listTasks('team'))[0]!.owner).toBe(GHOST_ID)
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dead-pane run broken by an unreadable scan never reaps, and the count restarts after it', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false, 'default'),
  ])
  try {
    const world = makeSweepWorld()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()

    // The unreadable scan resets the run: dead → unknown → dead is ONE dead
    // scan, not two.
    world.memberPresence.set(GHOST_PANE, 'unknown')
    await world.handles[0]!.scan()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain(
      'ghost',
    )

    // The second consecutive dead scan after the reset completes the pair.
    await world.handles[0]!.scan()
    expect((await teamFileOnDisk())?.members.map(m => m.name)).not.toContain(
      'ghost',
    )
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a respawn that rewrites the pane id starts the dead-pane count over', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false, 'default'),
  ])
  try {
    const world = makeSweepWorld()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()

    // The row now names a NEW pane (the respawn's), so the dead sighting of
    // the old one must not count towards it.
    const otherPane = '%100'
    world.memberPresence.set(GHOST_PANE, 'present')
    world.memberPresence.set(otherPane, 'absent')
    const teamPath = getTeamFilePath('team')
    const team = await teamFileOnDisk()
    writeFileSync(
      teamPath,
      JSON.stringify({
        ...team,
        members: team!.members.map(m =>
          m.name === 'ghost' ? { ...m, tmuxPaneId: otherPane } : m,
        ),
      }),
    )

    await world.handles[0]!.scan()
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain(
      'ghost',
    )

    await world.handles[0]!.scan()
    expect((await teamFileOnDisk())?.members.map(m => m.name)).not.toContain(
      'ghost',
    )
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a member of a team owned by another session is never swept', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster(
    [
      rosterMember('team-lead', '', '', undefined),
      rosterMember('worker', WORKER_PANE, 'tmux', false),
      rosterMember('ghost', GHOST_PANE, 'tmux', false),
    ],
    'other-session',
  )
  try {
    const world = makeSweepWorld({ currentSessionId: 'this-session' })
    world.memberPresence.set(GHOST_PANE, 'absent')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    // The ghost's pane is confirmed absent, but the team belongs to another
    // session — this watchdog has no business reaping its members.
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toEqual([
      'team-lead',
      'worker',
      'ghost',
    ])
    // The session guard returns before any pane is probed.
    expect(world.memberPresenceCalls).toEqual([])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a respawned same-name member with a fresh agentId survives the sweep', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    // The dead ghost…
    {
      agentId: GHOST_ID,
      name: 'ghost',
      joinedAt: 0,
      tmuxPaneId: GHOST_PANE,
      cwd: '/work',
      subscriptions: [],
      backendType: 'tmux',
      tmuxSocket: 'default',
      isActive: false,
    },
    // …and its healthy respawn: same name, fresh agentId, live pane.
    {
      agentId: 'ghost-2@team',
      name: 'ghost',
      joinedAt: 0,
      tmuxPaneId: '%100',
      cwd: '/work',
      subscriptions: [],
      backendType: 'tmux',
      isActive: false,
    },
  ])
  try {
    const world = makeSweepWorld()
    world.memberPresence.set(GHOST_PANE, 'absent')
    world.memberPresence.set('%100', 'present')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    // Only the dead ghost was removed — by agentId. The same-name respawn with
    // a live pane is still on the roster (removeTeammateFromTeamFile's name
    // match is an OR, so it must not be handed the name).
    expect((await teamFileOnDisk())?.members.map(m => m.agentId)).toEqual([
      'team-lead@team',
      'ghost-2@team',
    ])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pane that exists with a shell in the foreground is never removed', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const world = makeSweepWorld()
    // The pane exists: the CLI exited and the shell is back in the foreground.
    // Liveness reads that 'dead'; presence reads it 'present', and only
    // 'absent' may delete a roster record — this pane's row is the only record
    // of a still-standing pane and must survive any number of scans.
    world.memberPresence.set(GHOST_PANE, 'present')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain(
      'ghost',
    )
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an active member with a confirmed-absent pane is swept; an in-process member never is', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    // Mid-turn (isActive:true) but its pane is confirmed absent: isActive no
    // longer gates the sweep — a genuinely absent pane is the evidence.
    rosterMember('busy', '%88', 'tmux', true, 'default'),
    // An in-process teammate has no pane to judge, dead or otherwise.
    rosterMember('local', '', 'in-process', false),
  ])
  try {
    const world = makeWorld()
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      readTeamFile: () => readTeamFileAsync('team'),
    })
    worldToDispose.push(...world.handles)
    const sweeper = getTeamSweeper('team')
    if (!sweeper) throw new Error('team sweeper not armed')

    world.memberPresence.set('%88', 'absent')
    await sweeper.scan()
    await sweeper.scan()

    // The active member's absent pane was reaped; the in-process member was
    // never a candidate and survives.
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toEqual([
      'team-lead',
      'local',
    ])
    expect(world.memberPresenceCalls).toEqual(['%88', '%88'])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a sole pane teammate that self-reports a failure still gets its roster reconciled', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    // The sole pane teammate: its pane is still alive when it self-reports.
    rosterMember('worker', WORKER_PANE, 'tmux', false, 'default'),
  ])
  try {
    const world = makeWorld()
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      readTeamFile: () => readTeamFileAsync('team'),
    })
    worldToDispose.push(...world.handles)
    const watchdog = world.handles[0]!
    const sweeper = getTeamSweeper('team')
    if (!sweeper) throw new Error('team sweeper not armed')

    // Self-reported failure: the child is alive enough to report, but its turn
    // failed. The watchdog transitions the task and disposes in the SAME scan
    // (idleReason 'failed' never sets watchdogFailedTask).
    world.mailbox.push(
      idleNotification('worker', world.nowMs, 'failed', undefined, 'provider 400'),
    )
    await watchdog.scan()
    expect(watchdog.disposed).toBe(true)

    // The pane is then killed by hand. The team sweeper, which outlives the
    // disposed watchdog, reconciles the roster on its own.
    world.memberPresence.set(WORKER_PANE, 'absent')
    await sweeper.scan()
    await sweeper.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toEqual([
      'team-lead',
    ])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the sweep survives its own watchdog being disposed', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false, 'default'),
  ])
  try {
    const world = makeWorld()
    seedGhostInAppState(world)
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      readTeamFile: () => readTeamFileAsync('team'),
    })
    worldToDispose.push(...world.handles)
    const watchdog = world.handles[0]!
    const sweeper = getTeamSweeper('team')
    if (!sweeper) throw new Error('team sweeper not armed')

    // The watchdog is gone, but the sweep still runs and reaps the ghost.
    watchdog.dispose()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await sweeper.scan()
    await sweeper.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toEqual([
      'team-lead',
    ])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exactly one team sweeper is armed per team', () => {
  const world = makeWorld()
  const deps = watchdogDeps(world)
  const first = ensureTeamSweeper({
    teamName: 'team',
    currentSessionId: 's',
    setAppState: world.setAppState,
    deps,
  })
  const second = ensureTeamSweeper({
    teamName: 'team',
    currentSessionId: 's',
    setAppState: world.setAppState,
    deps,
  })
  expect(second).toBe(first)

  first.dispose()
  const third = ensureTeamSweeper({
    teamName: 'team',
    currentSessionId: 's',
    setAppState: world.setAppState,
    deps,
  })
  expect(third).not.toBe(first)
  third.dispose()
})

test('a tick that lands mid-scan is skipped, not queued', async () => {
  let reads = 0
  const resolvers: Array<(value: PaneWatchdogTeamFile | null) => void> = []
  const world = makeWorld()
  const sweeper = ensureTeamSweeper({
    teamName: 'team',
    currentSessionId: SESSION,
    setAppState: world.setAppState,
    deps: {
      ...watchdogDeps(world),
      readTeamFile: () => {
        reads++
        return new Promise(resolve => resolvers.push(resolve))
      },
    },
  })
  try {
    const first = sweeper.scan()
    const second = sweeper.scan()
    // The first scan is awaiting its team-file read; the second call is
    // skipped by the in-flight guard, so only one read has been issued.
    expect(reads).toBe(1)
    // Release the read: an empty roster retires the sweeper.
    for (const resolve of resolvers) resolve(null)
    await first
    await second
    expect(reads).toBe(1)
  } finally {
    sweeper.dispose()
  }
})

test('a dispose that lands mid-scan stops the in-flight scan from mutating', async () => {
  let removed = 0
  let probeCalls = 0
  const world = makeWorld()
  seedGhostInAppState(world)
  let sweeper: TeamSweeperHandle
  sweeper = ensureTeamSweeper({
    teamName: 'team',
    currentSessionId: SESSION,
    setAppState: world.setAppState,
    deps: {
      ...watchdogDeps(world),
      readTeamFile: async () => ({
        leadAgentId: 'team-lead@team',
        leadSessionId: SESSION,
        members: [
          { name: 'team-lead', agentId: 'team-lead@team' },
          {
            name: 'ghost',
            agentId: GHOST_ID,
            backendType: 'tmux',
            tmuxPaneId: GHOST_PANE,
            tmuxSocket: 'default',
            isActive: false,
          },
        ],
      }),
      probeMemberPanePresence: async () => {
        probeCalls++
        // Dispose on the second probe — the exact seam the guard must catch,
        // after the presence probe resolves but before the roster write.
        if (probeCalls === 2) sweeper.dispose()
        return 'absent'
      },
      removeMemberFromTeamFile: () => {
        removed++
        return true
      },
      unassignMemberTasks: async () => '',
    },
  })
  try {
    // First 'absent' sighting seeds the count; no reap yet.
    await sweeper.scan()
    // The second sighting would reap, but dispose landed mid-probe: the guard
    // returns before the roster edit.
    await sweeper.scan()
    expect(removed).toBe(0)
  } finally {
    sweeper.dispose()
  }
})

test('an active member whose socket cannot be discovered is never swept', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('busy', '%88', 'tmux', true),
  ])
  try {
    const world = makeSweepWorld({
      discoverReachableSockets: async () => {
        throw new Error('enumeration failed')
      },
    })
    world.memberPresence.set('%88', 'absent')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('busy')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a socket-less member on exactly one server gets its socket recorded and stays present', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const recorded: Array<[string, string]> = []
    const world = makeSweepWorld({
      discoverReachableSockets: async () => ['default'],
      recordMemberSocket: (team, agentId, socket) => {
        recorded.push([agentId, socket])
        return true
      },
    })
    world.memberPresence.set(GHOST_PANE, 'present')

    await world.handles[0]!.scan()

    expect(recorded).toEqual([[GHOST_ID, 'default']])
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pane present on two servers records nothing and stays unknown', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const recorded: Array<[string, string]> = []
    const world = makeSweepWorld({
      discoverReachableSockets: async () => ['s1', 's2'],
      recordMemberSocket: (team, agentId, socket) => {
        recorded.push([agentId, socket])
        return true
      },
    })
    // Present on both servers: ownership is ambiguous.
    world.memberPresence.set(GHOST_PANE, 'present')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    expect(recorded).toEqual([])
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a socket-less member with an unreachable server set stays unknown', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const world = makeSweepWorld({
      discoverReachableSockets: async () => {
        throw new Error('enumeration failed')
      },
    })
    // Would be absent if ownership were provable — it is not.
    world.memberPresence.set(GHOST_PANE, 'absent')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a socket-less member whose pane is outside the enumerated set is never swept', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('ghost', GHOST_PANE, 'tmux', false),
  ])
  try {
    const recorded: Array<[string, string]> = []
    const probed: Array<string | undefined> = []
    const world = makeSweepWorld({
      // The real server lives on a socket OUTSIDE the enumerated directory (a
      // custom `-S` path, or a `TMUX_TMPDIR` elsewhere). Enumeration only sees
      // stale sockets, and every one of them disclaims the pane.
      discoverReachableSockets: async () => ['stale-1', 'stale-2'],
      probeMemberPanePresence: async (_backendType, paneId, socketName) => {
        probed.push(socketName)
        return 'absent'
      },
      recordMemberSocket: (team, agentId, socket) => {
        recorded.push([agentId, socket])
        return true
      },
    })

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    // No enumerated server claimed it, but that is not proof of absence: the
    // pane may sit on a server discovery cannot see, so the verdict is
    // unknown — never a reaper's 'absent'. The member survives, and nothing
    // was recorded (positive proof only).
    expect(probed.length).toBeGreaterThan(0)
    expect(recorded).toEqual([])
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backfill never touches another session’s members', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster(
    [
      rosterMember('team-lead', '', '', undefined),
      rosterMember('ghost', GHOST_PANE, 'tmux', false),
    ],
    'other-session',
  )
  try {
    const recorded: Array<[string, string]> = []
    const world = makeSweepWorld({
      currentSessionId: 'this-session',
      discoverReachableSockets: async () => ['default'],
      recordMemberSocket: (team, agentId, socket) => {
        recorded.push([agentId, socket])
        return true
      },
    })
    world.memberPresence.set(GHOST_PANE, 'present')

    await world.handles[0]!.scan()

    expect(recorded).toEqual([])
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a team file with no leadSessionId is neither swept nor backfilled', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  // Explicitly null: no leadSessionId recorded — a legacy file whose owner
  // cannot be proven, so it must not be touched by any session.
  const dir = seedDiskRoster(
    [
      rosterMember('team-lead', '', '', undefined),
      // Has a recorded socket: it would be sweepable if ownership were provable.
      {
        agentId: GHOST_ID,
        name: 'ghost',
        joinedAt: 0,
        tmuxPaneId: GHOST_PANE,
        cwd: '/work',
        subscriptions: [],
        backendType: 'tmux',
        tmuxSocket: 'default',
        isActive: false,
      },
    ],
    null,
  )
  try {
    const recorded: Array<[string, string]> = []
    const world = makeSweepWorld({
      discoverReachableSockets: async () => ['default'],
      recordMemberSocket: (team, agentId, socket) => {
        recorded.push([agentId, socket])
        return true
      },
    })
    world.memberPresence.set(GHOST_PANE, 'absent')

    await world.handles[0]!.scan()
    await world.handles[0]!.scan()

    // No owner to prove — nothing is swept, and nothing is backfilled.
    expect((await teamFileOnDisk())?.members.map(m => m.name)).toContain('ghost')
    expect(recorded).toEqual([])
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})


// ---------------------------------------------------------------------------
// Auto-kill of a teammate that self-reports a failed turn.
// ---------------------------------------------------------------------------

function fakeReapClock() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const clock: ReaperTimers = {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: h => {
      ;(h as { cleared: boolean }).cleared = true
    },
  }
  return {
    clock,
    timers,
    fire: async () => {
      for (const t of timers) if (!t.cleared) t.fn()
      await new Promise(r => setTimeout(r, 0))
    },
  }
}

function reapWorld() {
  const world = makeWorld()
  const reaper = fakeReapClock()
  const kills: string[] = []
  registerTeammate(world, 'worker', {
    ...watchdogDeps(world),
    reapTimers: reaper.clock,
    killFailedTeammate: async taskId => {
      kills.push(taskId)
      // What killInProcessTeammateAndCascade does: pane closed, member removed.
      world.teamFile.members = world.teamFile.members.filter(
        m => m.name !== 'worker',
      )
      return true
    },
  })
  worldToDispose.push(...world.handles)
  return { world, reaper, kills }
}

test('an explicit failed turn schedules a 3s kill that removes the roster entry', async () => {
  const { world, reaper, kills } = reapWorld()
  world.mailbox.push(
    idleNotification('worker', world.nowMs, 'failed', undefined, 'provider 400'),
  )
  await world.handles[0]!.scan()

  // Armed with the 3000 ms default, but nothing killed before it fires.
  expect(reaper.timers).toHaveLength(1)
  expect(reaper.timers[0]!.ms).toBe(3000)
  expect(kills).toEqual([])
  expect(world.teamFile.members.map(m => m.name)).toContain('worker')

  await reaper.fire()
  expect(kills).toEqual([world.taskId()!])
  expect(world.teamFile.members.map(m => m.name)).toEqual(['team-lead'])
})

test('a deadline failure does not auto-kill', async () => {
  const { world, reaper, kills } = reapWorld()
  world.probes = ['alive']
  world.nowMs += FIRST_CONTACT_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  expect(reaper.timers).toHaveLength(0)
  await reaper.fire()
  expect(kills).toEqual([])
})

test('a message to the failed teammate cancels the pending kill', async () => {
  const { world, reaper, kills } = reapWorld()
  world.mailbox.push(idleNotification('worker', world.nowMs, 'failed', undefined, 'x'))
  await world.handles[0]!.scan()
  expect(hasPendingFailedTeammateReap('team', 'worker')).toBe(true)

  expect(cancelFailedTeammateReap('team', 'worker')).toBe(true)
  await reaper.fire()
  expect(kills).toEqual([])
  expect(hasPendingFailedTeammateReap('team', 'worker')).toBe(false)
})

test('a teammate that resumed (isActive) before the timer fires is left alone', async () => {
  const { world, reaper, kills } = reapWorld()
  world.mailbox.push(idleNotification('worker', world.nowMs, 'failed', undefined, 'x'))
  await world.handles[0]!.scan()
  world.teamFile.members[1]!.isActive = true
  await reaper.fire()
  expect(kills).toEqual([])
})

test('an already-gone teammate is not killed, and scheduling is idempotent', async () => {
  const { world, reaper, kills } = reapWorld()
  world.mailbox.push(idleNotification('worker', world.nowMs, 'failed', undefined, 'x'))
  await world.handles[0]!.scan()
  // A second failed report while pending does not arm a second timer.
  world.mailbox.push(idleNotification('worker', world.nowMs + 1, 'failed', undefined, 'y'))
  await world.handles[0]!.scan()
  expect(reaper.timers.filter(t => !t.cleared)).toHaveLength(1)

  world.teamFile.members = world.teamFile.members.filter(m => m.name !== 'worker')
  await reaper.fire()
  expect(kills).toEqual([])
  // Firing again is harmless (nothing pending).
  await reaper.fire()
  expect(kills).toEqual([])
})

test('scheduleFailedTeammateReap is idempotent per teammate (pending guard)', async () => {
  const reaper = fakeReapClock()
  let reaps = 0
  const schedule = () =>
    scheduleFailedTeammateReap({
      teamName: 'team',
      teammateName: 'idem',
      reap: () => {
        reaps++
      },
      timers: reaper.clock,
    })
  expect(schedule()).toBe(true)
  expect(schedule()).toBe(false)
  expect(reaper.timers).toHaveLength(1)
  await reaper.fire()
  expect(reaps).toBe(1)
  // Once fired, the slot is free again.
  expect(schedule()).toBe(true)
})

async function mailboxWriteWith(
  text: string,
  reapers: ReturnType<typeof fakeReapClock>,
): Promise<{ reaps: number; pending: boolean }> {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([rosterMember('team-lead', '', '', undefined)])
  try {
    let reaps = 0
    scheduleFailedTeammateReap({
      teamName: 'team',
      teammateName: 'worker',
      reap: () => {
        reaps++
      },
      timers: reapers.clock,
    })
    await writeToMailbox(
      'worker',
      { from: 'team-lead', text, timestamp: new Date().toISOString() },
      'team',
    )
    await new Promise(r => setTimeout(r, 0))
    return { reaps, pending: hasPendingFailedTeammateReap('team', 'worker') }
  } finally {
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a shutdown_request fires the pending reap immediately instead of cancelling it', async () => {
  const result = await mailboxWriteWith(
    JSON.stringify({
      type: 'shutdown_request',
      requestId: 'r1',
      from: 'team-lead',
      reason: 'dead',
      timestamp: new Date().toISOString(),
    }),
    fakeReapClock(),
  )
  expect(result).toEqual({ reaps: 1, pending: false })
})

test('other protocol messages neither cancel nor fire the pending reap', async () => {
  const result = await mailboxWriteWith(
    JSON.stringify({ type: 'plan_approval_response', requestId: 'r', approved: true }),
    fakeReapClock(),
  )
  expect(result).toEqual({ reaps: 0, pending: true })
})

test('a plain-text re-task cancels the pending reap', async () => {
  const result = await mailboxWriteWith('please try again', fakeReapClock())
  expect(result).toEqual({ reaps: 0, pending: false })
})

// Phase 5: the watchdog's attention-item duties. A dead-pane failure creates
// the item BEFORE releasing the teammate's tasks (so the hold names an item
// that exists); a late completion supersedes an UNDECIDED failure item and
// releases its hold, but never touches a decided one.
const LEAD_LIST = 'lead-list'

async function withAttentionStore(fn: () => Promise<void>): Promise<void> {
  await acquireSharedMutationLock(`${LOCK_NAME}#attention`)
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-pane-attention-'))
  setClaudeConfigHomeDirForTesting(dir)
  // The root lead's own list, where items live; the teammate's tasks live in
  // the team's list ('team').
  const previousList = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LEAD_LIST
  try {
    await fn()
  } finally {
    if (previousList === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousList
    const { settleAttentionWritesForTesting } = await import('../../utils/attentionItems.js')
    await settleAttentionWritesForTesting()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
    releaseSharedMutationLock()
  }
}

test('Phase 5: a dead-pane failure creates its attention item first, then releases the tasks held for it', async () => {
  await withAttentionStore(async () => {
    const { readAttentionItem } = await import('../../utils/attentionItems.js')
    const world = makeWorld()
    const seen: Array<{ hold?: string; list?: string; itemExisted: boolean }> = []
    const deps: PaneTeammateWatchdogDeps = {
      ...watchdogDeps(world),
      unassignMemberTasks: async (teamName, member, options) => {
        world.unassignCalls.push({ teamName, ...member })
        seen.push({
          hold: options?.attentionHold,
          list: options?.attentionHoldList,
          itemExisted: options?.attentionHold
            ? (await readAttentionItem(options.attentionHold)) !== undefined
            : false,
        })
        return ''
      },
    }
    registerTeammate(world, 'worker', deps)
    worldToDispose.push(...world.handles)
    world.teamFile.members[1]!.isActive = true
    await world.handles[0]!.scan()
    world.probes = ['dead']
    world.nowMs += PROGRESS_TIMEOUT_MS + 1
    await world.handles[0]!.scan()
    expect(taskStatus(world)).toBe('failed')
    const itemId = `failure-${world.taskId()}-0`
    expect(seen).toEqual([{ hold: itemId, list: LEAD_LIST, itemExisted: true }])
    const item = await readAttentionItem(itemId)
    expect(item).toMatchObject({
      kind: 'failure',
      status: 'undecided',
      transient: true,
      source: { backend: 'pane', agentName: 'worker', teamName: 'team' },
    })
    // The notification's own hook computed the same id: still one item.
    const { listAttentionItems, settleAttentionWritesForTesting } = await import('../../utils/attentionItems.js')
    await settleAttentionWritesForTesting()
    expect((await listAttentionItems()).map(i => i.id)).toEqual([itemId])
  })
})

async function failSlowChildThenComplete(
  world: World,
  between: (itemId: string) => Promise<void>,
): Promise<string> {
  const { settleAttentionWritesForTesting } = await import('../../utils/attentionItems.js')
  registerTeammate(world)
  worldToDispose.push(...world.handles)
  world.teamFile.members[1]!.isActive = true
  await world.handles[0]!.scan()
  world.probes = ['alive']
  world.nowMs += PROGRESS_TIMEOUT_MS + 1
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('failed')
  await settleAttentionWritesForTesting()
  const itemId = `failure-${world.taskId()}-0`
  await between(itemId)
  world.mailbox.push(idleNotification('worker', world.nowMs, 'available', 'slow but finished'))
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('completed')
  return itemId
}

test('Phase 5: a late completion supersedes an undecided failure item and releases its hold', async () => {
  await withAttentionStore(async () => {
    const { readAttentionItem } = await import('../../utils/attentionItems.js')
    const { createTask, getTask } = await import('../../utils/tasks.js')
    let held = ''
    const itemId = await failSlowChildThenComplete(makeWorld(), async id => {
      expect((await readAttentionItem(id))?.status).toBe('undecided')
      held = await createTask(LEAD_LIST, {
        subject: 'held work',
        description: 'd',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: { attentionHold: id },
      })
    })
    expect(await readAttentionItem(itemId)).toMatchObject({
      status: 'superseded',
      supersededReason: 'late-completion',
    })
    expect((await getTask(LEAD_LIST, held))?.metadata?.attentionHold).toBeUndefined()
  })
})

test('Phase 5: a late completion leaves a decided failure item alone', async () => {
  await withAttentionStore(async () => {
    const { decideAttentionItem, readAttentionItem } = await import('../../utils/attentionItems.js')
    const itemId = await failSlowChildThenComplete(makeWorld(), async id => {
      await decideAttentionItem(id, { choice: 'patch', reason: 'narrow it', rootCause: 'scope' })
    })
    expect(await readAttentionItem(itemId)).toMatchObject({
      status: 'decided',
      decision: { choice: 'patch' },
    })
  })
})

// Hardening: a SELF-REPORTED failure (the child's failed turn) releases the
// teammate's tasks through the auto-reap, not through failTask. They must be
// held for the same deterministic failure item until the lead decides it.
test('hardening: the auto-reap after a self-reported failure holds the released tasks until the item is decided', async () => {
  await withAttentionStore(async () => {
    const { claimTask, createTask, getTask } = await import('../../utils/tasks.js')
    const { decideAttentionItem, readAttentionItem } = await import('../../utils/attentionItems.js')
    const world = makeWorld()
    const reaper = fakeReapClock()
    const owned = await createTask('team', {
      subject: 'worker task',
      description: 'd',
      status: 'in_progress',
      owner: 'worker',
      blocks: [],
      blockedBy: [],
    })
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      // The REAL unassign, against the isolated tasks dir.
      unassignMemberTasks: undefined,
      reapTimers: reaper.clock,
      killFailedTeammate: async () => {
        world.teamFile.members = world.teamFile.members.filter(m => m.name !== 'worker')
        return true
      },
    })
    worldToDispose.push(...world.handles)
    world.mailbox.push(
      idleNotification('worker', world.nowMs, 'failed', undefined, 'provider 400'),
    )
    await world.handles[0]!.scan()
    expect(taskStatus(world)).toBe('failed')
    const itemId = `failure-${world.taskId()}-0`
    // The item exists before the reap (created inside finalization, not only
    // by the notification's fire-and-forget hook).
    expect((await readAttentionItem(itemId))?.status).toBe('undecided')
    expect((await getTask('team', owned))?.owner).toBe('worker')

    await reaper.fire()
    // The reap runs off the timer: wait for its last step (linking the
    // released ids into the item), bounded.
    for (let i = 0; i < 300; i++) {
      if ((await readAttentionItem(itemId))?.source.taskListTaskIds) break
      await new Promise(r => setTimeout(r, 10))
    }
    const released = await getTask('team', owned)
    expect(released?.status).toBe('pending')
    expect(released?.owner).toBeUndefined()
    expect(released?.metadata).toMatchObject({
      attentionHold: itemId,
      attentionHoldList: LEAD_LIST,
    })
    expect((await readAttentionItem(itemId))?.source.taskListTaskIds).toEqual([owned])

    const blocked = await claimTask('team', owned, 'someone-else')
    expect(blocked).toMatchObject({ success: false, reason: 'held_for_decision', attentionItemId: itemId })

    await decideAttentionItem(itemId, { choice: 'continue', reason: 'accept it' })
    expect((await claimTask('team', owned, 'someone-else')).success).toBe(true)
  })
})

test('hardening: the auto-reap releases without a hold once the failure item is decided', async () => {
  await withAttentionStore(async () => {
    const { createTask, getTask } = await import('../../utils/tasks.js')
    const { decideAttentionItem } = await import('../../utils/attentionItems.js')
    const world = makeWorld()
    const reaper = fakeReapClock()
    const owned = await createTask('team', {
      subject: 'worker task',
      description: 'd',
      status: 'in_progress',
      owner: 'worker',
      blocks: [],
      blockedBy: [],
    })
    registerTeammate(world, 'worker', {
      ...watchdogDeps(world),
      unassignMemberTasks: undefined,
      reapTimers: reaper.clock,
      killFailedTeammate: async () => true,
    })
    worldToDispose.push(...world.handles)
    world.mailbox.push(idleNotification('worker', world.nowMs, 'failed', undefined, 'boom'))
    await world.handles[0]!.scan()
    await decideAttentionItem(`failure-${world.taskId()}-0`, { choice: 'continue', reason: 'accepted' })
    await reaper.fire()
    for (let i = 0; i < 300; i++) {
      if ((await getTask('team', owned))?.owner === undefined) break
      await new Promise(r => setTimeout(r, 10))
    }
    const released = await getTask('team', owned)
    expect(released?.owner).toBeUndefined()
    expect(released?.metadata?.attentionHold).toBeUndefined()
  })
})

// Hardening: when the auto-reap could not close a failed member's pane, the
// member stays on the roster and the ghost sweep releases its tasks once the
// pane is gone — still held for its undecided failure item.
test('hardening: the ghost sweep holds a swept member’s tasks for its undecided failure item', async () => {
  acquireSharedMutationLock(LOCK_NAME)
  const dir = seedDiskRoster([
    rosterMember('team-lead', '', '', undefined),
    rosterMember('worker', WORKER_PANE, 'tmux', false),
    rosterMember('ghost', GHOST_PANE, 'tmux', false, 'default'),
  ])
  const previousList = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LEAD_LIST
  try {
    const { createAttentionItem, runFailureItem } = await import('../../utils/attentionItems.js')
    const { claimTask, getTask } = await import('../../utils/tasks.js')
    const item = runFailureItem({
      taskId: GHOST_TASK_ID,
      runSeq: 0,
      description: 'ghost',
      backend: 'pane',
      agentId: GHOST_ID,
      agentName: 'ghost',
      teamName: 'team',
    })
    await createAttentionItem(item)
    const world = makeSweepWorld()
    world.memberPresence.set(GHOST_PANE, 'absent')
    await world.handles[0]!.scan()
    await world.handles[0]!.scan()
    const task = await getTask('team', '7')
    expect(task?.owner).toBeUndefined()
    expect(task?.metadata).toMatchObject({ attentionHold: item.id, attentionHoldList: LEAD_LIST })
    expect(await claimTask('team', '7', 'someone-else')).toMatchObject({
      success: false,
      reason: 'held_for_decision',
    })
  } finally {
    if (previousList === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
    else process.env.CLAUDE_CODE_TASK_LIST_ID = previousList
    releaseSharedMutationLock()
    setClaudeConfigHomeDirForTesting(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
