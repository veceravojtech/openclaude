import { afterEach, expect, test } from 'bun:test'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import type { PaneLiveness } from '../../utils/swarm/backends/types.js'
import type { AppState } from '../../state/AppState.js'
import type {
  PaneTeammateWatchdogDeps,
  PaneTeammateWatchdogHandle,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import type {
  PaneWatchdogMailboxMessage,
  PaneWatchdogTeamFile,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
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
  idleReason?: 'available' | 'parked',
  summary?: string,
): PaneWatchdogMailboxMessage {
  return {
    from,
    text: JSON.stringify({
      type: 'idle_notification',
      from,
      timestamp: new Date(nowMs).toISOString(),
      idleReason,
      summary,
    }),
    timestamp: new Date(nowMs).toISOString(),
  }
}

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
    readLeadMailbox: async () => world.mailbox,
    readTeamFile: async () => world.teamFile,
    probePane: async () => {
      world.probeCalls++
      return world.probes.shift() ?? 'unknown'
    },
    scanIntervalMs: null,
    firstContactTimeoutMs: FIRST_CONTACT_TIMEOUT_MS,
    progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    unknownRetryDelayMs: UNKNOWN_RETRY_DELAY_MS,
    maxUnknownRetries: MAX_UNKNOWN_RETRIES,
  }
}

function registerTeammate(world: World, teammateName = 'worker'): void {
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
    watchdogDeps(world),
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
  expect(String(task.error)).toContain('no lifecycle signal')
  expect(String(task.error)).not.toContain('Pane exited')
  expect(world.notifications().length).toBe(1)
  expect(world.notifications()[0]).toContain('<status>failed</status>')
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

  expect(taskStatus(world)).toBe('completed')
  const notifications = world.notifications()
  expect(notifications.length).toBe(1)
  expect(notifications[0]).toContain('<status>completed</status>')
  expect(notifications[0]).toContain('found the bug')

  // Deadlines expiring afterwards must not flip a completed task to failed.
  world.nowMs += PROGRESS_TIMEOUT_MS * 3
  world.probes = ['dead']
  await world.handles[0]!.scan()
  expect(taskStatus(world)).toBe('completed')
  expect(world.notifications().length).toBe(1)
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
  expect(taskStatus(world)).toBe('completed')
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
  expect(String(task.error)).toContain('no lifecycle signal')
  expect(String(task.error)).not.toContain('Pane exited')

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
  expect(taskStatus(world)).toBe('completed')
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
