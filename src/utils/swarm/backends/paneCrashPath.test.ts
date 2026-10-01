/**
 * The lead-side path of a pane teammate whose pane disappears: real team
 * file, real mailbox files, real task files, the real attention store, the
 * real watchdog and team sweeper, the real failed notification and output
 * file. Only tmux is injected (src/test/fixtures/paneCrashWorld.ts).
 *
 * The user's manual test killed a working teammate's pane with
 * `tmux kill-pane`; the ghost sweep retired it exactly like a requested
 * shutdown — "has shut down", tasks released, no failed notification, no
 * attention item. These pin both halves: an UNREQUESTED pane death is a
 * crash; a REQUESTED one stays a clean release. The lead's real inbox poller
 * handling an approval first is src/hooks/useInboxPoller.paneCrash.test.tsx.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import {
  CRASH_MATE,
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
  listAttentionItems,
  settleAttentionWritesForTesting,
} from '../../attentionItems.js'
import {
  createIdleNotification,
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
} from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import {
  getTeamSweeper,
  type PaneTeammateWatchdogHandle,
} from './paneTeammateWatchdog.js'
import type { PanePresence } from './types.js'

let state: AppState
let pane: { state: PanePresence }
let watchdog: PaneTeammateWatchdogHandle
let teardownFiles: () => Promise<void>

const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const getState = (): AppState => state

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/backends/paneCrashPath.test.ts')
  const files = await setUpPaneCrashFiles()
  teardownFiles = files.teardown
  state = crashLeadState(files.configDir)
  pane = { state: 'present' }
  watchdog = registerCrasher(setAppState, pane)
})

afterEach(async () => {
  try {
    watchdog.dispose()
    await teardownFiles()
  } finally {
    releaseSharedMutationLock()
  }
})

const request = (requestId: string) =>
  createShutdownRequestMessage({ requestId, from: TEAM_LEAD_NAME })
const approval = (requestId: string) =>
  createShutdownApprovedMessage({
    requestId,
    from: CRASH_MATE,
    paneId: CRASH_PANE,
    backendType: 'tmux',
  })

test('tmux kill-pane on a working teammate (no shutdown asked) is a crash: failed notification, one attention item, held task', async () => {
  // Mid-turn: booted, claimed its task, not finished.
  await mailJson(TEAM_LEAD_NAME, CRASH_MATE, { type: 'teammate_startup', from: CRASH_MATE })
  await watchdog.scan()
  expect(crasherRow(state).status).toBe('running')

  await killPaneAndSweep(pane)

  await expectCrashOutcome(getState)
  // Further sweeps and watchdog scans change nothing: still one of each.
  await getTeamSweeper(CRASH_TEAM)?.scan()
  await watchdog.scan()
  await settleAttentionWritesForTesting()
  expect(await listAttentionItems()).toHaveLength(1)
  expect(notificationsFor(crasherTaskId(state), 'failed')).toHaveLength(1)
})

test('killing the pane of an IDLE teammate (turn delivered, watchdog disarmed) is a crash too, and reports its last text', async () => {
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createIdleNotification(CRASH_MATE, {
      idleReason: 'available',
      lastAssistantText: 'Claimed task #1; idle now.',
    }),
  )
  await watchdog.scan()
  // The turn was delivered as completed; the task stays running (idle).
  expect(crasherRow(state).status).toBe('running')
  expect(watchdog.disposed).toBe(true)
  expect(notificationsFor(crasherTaskId(state), 'completed')).toHaveLength(1)

  await killPaneAndSweep(pane)

  const { output } = await expectCrashOutcome(getState)
  expect(output).toContain('Last assistant text:')
  expect(output).toContain('Claimed task #1; idle now.')
})

test('a REQUESTED shutdown the lead has not processed yet (approval in its real inbox) stays a clean release', async () => {
  await mailJson(CRASH_MATE, TEAM_LEAD_NAME, request('shutdown-1@crasher'))
  await mailJson(TEAM_LEAD_NAME, CRASH_MATE, approval('shutdown-1@crasher'))

  await killPaneAndSweep(pane)

  await expectCleanRelease(getState)
  // Today's clean path: "has shut down", the row retired as completed.
  expect(terminatedMessages(state)).toHaveLength(1)
  expect(terminatedMessages(state)[0]).toContain('has shut down')
  expect(crasherRow(state).status).toBe('completed')
})

test('a shutdown_request the lead sent is evidence of a requested end even before the teammate answers', async () => {
  await mailJson(CRASH_MATE, TEAM_LEAD_NAME, request('shutdown-3@crasher'))

  await killPaneAndSweep(pane)

  await expectCleanRelease(getState)
})

test('a shutdown_request the teammate REJECTED is no evidence: a later pane kill is still a crash', async () => {
  await mailJson(CRASH_MATE, TEAM_LEAD_NAME, request('shutdown-4@crasher'))
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createShutdownRejectedMessage({
      requestId: 'shutdown-4@crasher',
      from: CRASH_MATE,
      reason: 'still working',
    }),
  )

  await killPaneAndSweep(pane)

  await expectCrashOutcome(getState)
})

test("an approval from a former run under the same name (older than this member's spawn) is no evidence", async () => {
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString()
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    { ...approval('shutdown-old@crasher'), timestamp: anHourAgo },
    anHourAgo,
  )

  await killPaneAndSweep(pane)

  await expectCrashOutcome(getState)
})
