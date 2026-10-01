/**
 * Follow-ups to the pane-crash path (paneCrashPath.test.ts), on the same real
 * files (src/test/fixtures/paneCrashWorld.ts):
 * - a kill the USER asked for from the teams dialog never turns into a
 *   delayed crash, even once the progress deadline has passed;
 * - the crash registry forgets a watchdog on every terminal disposal, and
 *   reclaims a disarmed one once its teammate is gone;
 * - a legacy member row (no joinedAt) cannot have an old approval read as a
 *   current one;
 * - a crash failure that committed is never followed by a "has shut down"
 *   retirement, whatever throws after the commit.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { killTeammate } from '../../../components/teams/TeamsDialog.js'
import type { AppState } from '../../../state/AppState.js'
import {
  CRASH_MATE,
  CRASH_MATE_ID,
  CRASH_PANE,
  CRASH_TEAM,
  crashLeadState,
  crasherRow,
  crasherTaskId,
  expectCleanRelease,
  expectCrashOutcome,
  killPaneAndSweep,
  mailJson,
  notificationsFor,
  registerCrasher,
  setUpPaneCrashFiles,
  terminatedMessages,
} from '../../../test/fixtures/paneCrashWorld.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import { listAttentionItems } from '../../attentionItems.js'
import { getTask } from '../../tasks.js'
import {
  createIdleNotification,
  createShutdownApprovedMessage,
} from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import {
  getPaneWatchdogForTask,
  getTeamSweeper,
  PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR,
  type PaneTeammateWatchdogDeps,
  type PaneTeammateWatchdogHandle,
} from './paneTeammateWatchdog.js'
import type { PanePresence } from './types.js'

const PROGRESS_TIMEOUT_MS = 60_000

let state: AppState
let pane: { state: PanePresence }
let watchdog: PaneTeammateWatchdogHandle | undefined
let teardownFiles: (() => Promise<void>) | undefined
const clock = { now: 1_000_000 }

const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const getState = (): AppState => state

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/backends/paneCrashFollowups.test.ts')
  watchdog = undefined
  teardownFiles = undefined
  clock.now = Date.now()
  pane = { state: 'present' }
})

afterEach(async () => {
  try {
    watchdog?.dispose()
    await teardownFiles?.()
  } finally {
    releaseSharedMutationLock()
  }
})

async function setUp(
  files: Parameters<typeof setUpPaneCrashFiles>[0] = {},
  deps: PaneTeammateWatchdogDeps = {},
): Promise<void> {
  const created = await setUpPaneCrashFiles(files)
  teardownFiles = created.teardown
  state = crashLeadState(created.configDir)
  watchdog = registerCrasher(setAppState, pane, {
    now: () => clock.now,
    progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    ...deps,
  })
}

/** Booted and mid-turn: the progress deadline is armed. */
async function bootTeammate(): Promise<void> {
  await mailJson(TEAM_LEAD_NAME, CRASH_MATE, {
    type: 'teammate_startup',
    from: CRASH_MATE,
  })
  await watchdog!.scan()
  expect(crasherRow(state).status).toBe('running')
}

test('a kill from the teams dialog is a requested end: no item and no failed notification, even after the progress deadline', async () => {
  await setUp()
  await bootTeammate()
  const taskId = crasherTaskId(state)

  // The dialog's own kill (no backend recorded: the pane is killed below
  // through the injected tmux state, never a real tmux server).
  await killTeammate(CRASH_PANE, undefined, CRASH_TEAM, CRASH_MATE_ID, CRASH_MATE, setAppState)
  pane.state = 'absent'

  // Requested before the pane died: the row says so, the watchdog is off
  // and out of the crash registry.
  expect((state.tasks[taskId] as { shutdownRequested?: boolean }).shutdownRequested).toBe(true)
  expect(watchdog!.disposed).toBe(true)
  expect(getPaneWatchdogForTask(taskId)).toBeUndefined()

  // Half an hour later: the deadline is long past, the pane is dead.
  clock.now += PROGRESS_TIMEOUT_MS * 30
  await watchdog!.scan()
  await killPaneAndSweep(pane)

  await expectCleanRelease(getState)
  expect(crasherRow(state).status).toBe('completed')
  expect(terminatedMessages(state)).toHaveLength(1)
  expect(terminatedMessages(state)[0]).toContain('was terminated')
})

test('the crash registry forgets a watchdog that disposes because its task ended by another hand', async () => {
  await setUp()
  await bootTeammate()
  const taskId = crasherTaskId(state)
  expect(getPaneWatchdogForTask(taskId)).toBe(watchdog)

  // Completed by another hand (not this watchdog): its scan disarms.
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [taskId]: { ...prev.tasks[taskId]!, status: 'completed' } as AppState['tasks'][string],
    },
  }))
  await watchdog!.scan()

  expect(watchdog!.disposed).toBe(true)
  expect(getPaneWatchdogForTask(taskId)).toBeUndefined()
})

test('a disarmed (turn-delivered) watchdog keeps its crash watch, and the sweeper reclaims it once the teammate is retired cleanly', async () => {
  await setUp()
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createIdleNotification(CRASH_MATE, { idleReason: 'available' }),
  )
  await watchdog!.scan()
  const taskId = crasherTaskId(state)
  expect(watchdog!.disposed).toBe(true)
  // Idle, not gone: still registered for a crash.
  expect(getPaneWatchdogForTask(taskId)).toBe(watchdog)

  // Retired cleanly elsewhere (an approval handler): the row is completed.
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [taskId]: { ...prev.tasks[taskId]!, status: 'completed' } as AppState['tasks'][string],
    },
  }))
  await getTeamSweeper(CRASH_TEAM)!.scan()

  expect(getPaneWatchdogForTask(taskId)).toBeUndefined()
})

test('a legacy member row (no joinedAt) on a team file with no createdAt: an approval in the inbox cannot be dated, so a pane kill is a crash', async () => {
  await setUp({ legacyMember: true, teamCreatedAt: null })
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createShutdownApprovedMessage({ requestId: 'shutdown-legacy@crasher', from: CRASH_MATE }),
  )

  await killPaneAndSweep(pane)

  await expectCrashOutcome(getState)
})

test("a legacy member row falls back to the team's createdAt: an approval after it is evidence, one before it is not", async () => {
  const anHourAgo = Date.now() - 3_600_000
  await setUp({ legacyMember: true, teamCreatedAt: anHourAgo })
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createShutdownApprovedMessage({ requestId: 'shutdown-new@crasher', from: CRASH_MATE }),
  )

  await killPaneAndSweep(pane)

  await expectCleanRelease(getState)
})

test("a legacy member row: an approval older than the team's createdAt is a former run's", async () => {
  await setUp({ legacyMember: true, teamCreatedAt: Date.now() })
  const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString()
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    { ...createShutdownApprovedMessage({ requestId: 'shutdown-old@crasher', from: CRASH_MATE }), timestamp: twoHoursAgo },
    twoHoursAgo,
  )

  await killPaneAndSweep(pane)

  await expectCrashOutcome(getState)
})

test('an output file that cannot be written does not cost the lead the failed notification, and the crash is not followed by a retirement', async () => {
  await setUp({}, {
    flushTaskOutput: async () => {
      throw new Error('EIO: output file write failed')
    },
  })
  await bootTeammate()
  const taskId = crasherTaskId(state)

  await killPaneAndSweep(pane)

  expect(crasherRow(state).status).toBe('failed')
  expect(notificationsFor(taskId, 'failed')).toHaveLength(1)
  expect(notificationsFor(taskId, 'failed')[0]).toContain(PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR)
  expect((await listAttentionItems()).map(i => i.id)).toEqual([`failure-${taskId}-0`])
  expect((await getTask(CRASH_TEAM, '1'))?.metadata?.attentionHold).toBe(`failure-${taskId}-0`)
  expect(terminatedMessages(state)).toEqual([])
})

test('a crash failure that committed and THEN threw is not retired as "has shut down" on top of it', async () => {
  await setUp({}, {
    // The hand-off commits the failed row, then throws (a later step failed).
    failCrashedTeammate: async taskId => {
      setAppState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...prev.tasks[taskId]!,
            status: 'failed',
            error: PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR,
          } as AppState['tasks'][string],
        },
      }))
      throw new Error('notification enqueue failed')
    },
  })
  await bootTeammate()

  await killPaneAndSweep(pane)

  expect(crasherRow(state).status).toBe('failed')
  expect(terminatedMessages(state)).toEqual([])
  // Not released a second time by the retirement (the hand-off owns it).
  expect((await getTask(CRASH_TEAM, '1'))?.owner).toBe(CRASH_MATE)
  expect(state.teamContext?.teammates[CRASH_MATE_ID]).toBeUndefined()
})
