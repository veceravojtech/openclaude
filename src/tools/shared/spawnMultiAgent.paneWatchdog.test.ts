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
import { TEAMMATE_GRACE_MS } from '../../utils/task/framework.js'
import { getTaskPath, listTasks } from '../../utils/tasks.js'
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
  expect(world.state.tasks[world.taskId()!]!.status).toBe('completed')
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
