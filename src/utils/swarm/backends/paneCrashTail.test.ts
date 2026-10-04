/**
 * The pane tail of a crashed pane teammate. `tmux kill-pane` destroys the pane
 * before the ghost sweep can confirm the death, so the crash path itself can
 * never read it: the failure report's "last lines of the pane" come from the
 * rolling capture the team sweeper's tick takes while the pane is alive.
 *
 * Same world as paneCrashPath.test.ts (src/test/fixtures/paneCrashWorld.ts):
 * real team, task, mailbox, attention and output files; only tmux (presence,
 * liveness, capture-pane) and the clock are injected. No real sleeps.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { AppState } from '../../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import {
  CRASH_MATE,
  CRASH_TEAM,
  crashLeadState,
  crasherTaskId,
  expectCrashOutcome,
  killPaneAndSweep,
  mailJson,
  notificationsFor,
  registerCrasher,
  scriptedPaneTail,
  setUpPaneCrashFiles,
} from '../../../test/fixtures/paneCrashWorld.js'
import { getTaskOutputPath } from '../../task/diskOutput.js'
import { createIdleNotification } from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import {
  getCachedPaneTailForTask,
  getPaneWatchdogForTask,
  getTeamSweeper,
  PANE_FAILURE_TAIL_LINES,
  PANE_GONE_LINE,
  PANE_TAIL_CAPTURE_INTERVAL_MS,
  type PaneTeammateWatchdogHandle,
} from './paneTeammateWatchdog.js'
import type { PanePresence } from './types.js'

let state: AppState
let pane: { state: PanePresence }
let clock: { t: number }
let tail: ReturnType<typeof scriptedPaneTail>
let watchdog: PaneTeammateWatchdogHandle
let teardownFiles: () => Promise<void>

const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const getState = (): AppState => state
const sweep = async (): Promise<void> => {
  const sweeper = getTeamSweeper(CRASH_TEAM)
  if (!sweeper) throw new Error('no team sweeper armed')
  await sweeper.scan()
}

/** What the teammate's pane showed before the kill; `<`/`&` test escaping. */
const PANE_TEXT = [
  '⏺ Bash(for i in $(seq 1 600); do echo "beat $i"; sleep 1; done)',
  '  ⎿  beat 41',
  '     beat 42 <e2e-heartbeat & marker>',
].join('\n')

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/backends/paneCrashTail.test.ts')
  const files = await setUpPaneCrashFiles()
  teardownFiles = files.teardown
  state = crashLeadState(files.configDir)
  pane = { state: 'present' }
  clock = { t: Date.now() }
  tail = scriptedPaneTail(pane, PANE_TEXT)
  watchdog = registerCrasher(setAppState, pane, {
    now: () => clock.t,
    capturePaneTail: tail.dep,
  })
})

afterEach(async () => {
  try {
    watchdog.dispose()
    await teardownFiles()
  } finally {
    releaseSharedMutationLock()
  }
})

test('a crash after a rolling capture reports the cached lines and their age, in the output file and the <result>', async () => {
  await mailJson(TEAM_LEAD_NAME, CRASH_MATE, { type: 'teammate_startup', from: CRASH_MATE })
  await watchdog.scan()

  // The sweeper's tick captures the live pane, with the failure tail's size.
  await sweep()
  expect(tail.calls).toBe(1)
  expect(tail.lines).toEqual([PANE_FAILURE_TAIL_LINES])
  expect(getCachedPaneTailForTask(crasherTaskId(state))).toEqual({
    text: PANE_TEXT,
    capturedAt: clock.t,
  })

  clock.t += 7_000
  await killPaneAndSweep(pane)

  const { output, notification } = await expectCrashOutcome(getState, {
    cachedTail: { ageSeconds: 7, text: PANE_TEXT },
  })
  // The raw marker in the file, escaped inside the XML notification.
  expect(output).toContain('beat 42 <e2e-heartbeat & marker>')
  expect(notification).toContain('beat 42 &lt;e2e-heartbeat &amp; marker&gt;')
  expect(notification).not.toContain('<e2e-heartbeat')
})

test('the cached tail sits beside the teammate\'s last text, never replacing it', async () => {
  await mailJson(
    TEAM_LEAD_NAME,
    CRASH_MATE,
    createIdleNotification(CRASH_MATE, {
      idleReason: 'available',
      lastAssistantText: 'Claimed task #1; idle now.',
    }),
  )
  await watchdog.scan()
  // The delivered turn disarmed the deadlines, not the crash watch: the idle
  // teammate's pane is still captured.
  expect(watchdog.disposed).toBe(true)
  await sweep()
  expect(tail.calls).toBe(1)

  clock.t += 12_400
  await killPaneAndSweep(pane)

  const { output } = await expectCrashOutcome(getState, {
    cachedTail: { ageSeconds: 12, text: PANE_TEXT },
  })
  expect(output).toContain('Last assistant text:\nClaimed task #1; idle now.')
  expect(output.indexOf('Last assistant text:')).toBeLessThan(
    output.indexOf('Last pane output (captured'),
  )
})

test('a crash before any capture (the first seconds) still reports PANE_GONE_LINE', async () => {
  tail.text = null
  await sweep()
  expect(tail.calls).toBe(1)
  expect(getCachedPaneTailForTask(crasherTaskId(state))).toBeUndefined()

  await killPaneAndSweep(pane)

  const { output } = await expectCrashOutcome(getState)
  expect(output).toContain(PANE_GONE_LINE)
})

test('a failing, timed-out or blank capture keeps the previous tail', async () => {
  const taskId = crasherTaskId(state)
  tail.next.push('first tail', 'throw', null, '   \n')
  await sweep()
  const first = getCachedPaneTailForTask(taskId)
  expect(first?.text).toBe('first tail')

  for (let i = 0; i < 3; i++) {
    clock.t += PANE_TAIL_CAPTURE_INTERVAL_MS
    await sweep()
  }
  expect(tail.calls).toBe(4)
  expect(getCachedPaneTailForTask(taskId)).toEqual(first)

  clock.t += 2_000
  await killPaneAndSweep(pane)
  await expectCrashOutcome(getState, {
    cachedTail: {
      ageSeconds: (3 * PANE_TAIL_CAPTURE_INTERVAL_MS + 2_000) / 1000,
      text: 'first tail',
    },
  })
})

test('captures are rate-limited to one per interval and never overlap', async () => {
  await sweep()
  await sweep()
  expect(tail.calls).toBe(1)
  clock.t += PANE_TAIL_CAPTURE_INTERVAL_MS - 1
  await sweep()
  expect(tail.calls).toBe(1)
  clock.t += 1
  await sweep()
  expect(tail.calls).toBe(2)

  // A capture still in flight (tmux slow to answer): another tick, even one
  // past the interval, starts nothing, and the slow capture still lands.
  let release!: (text: string | null) => void
  tail.gate = () => new Promise<string | null>(resolve => (release = resolve))
  clock.t += PANE_TAIL_CAPTURE_INTERVAL_MS
  const first = watchdog.refreshPaneTail()
  clock.t += PANE_TAIL_CAPTURE_INTERVAL_MS
  await sweep()
  await watchdog.refreshPaneTail()
  expect(tail.calls).toBe(3)
  release('gated tail')
  await first
  expect(getCachedPaneTailForTask(crasherTaskId(state))?.text).toBe('gated tail')
})

test('no capture after dispose, and a capture in flight at dispose leaves nothing behind', async () => {
  const taskId = crasherTaskId(state)
  await sweep()
  expect(getCachedPaneTailForTask(taskId)).toBeDefined()

  watchdog.dispose()
  // Bounded memory: the entry goes with the registration.
  expect(getCachedPaneTailForTask(taskId)).toBeUndefined()
  expect(getPaneWatchdogForTask(taskId)).toBeUndefined()

  const calls = tail.calls
  clock.t += 10 * PANE_TAIL_CAPTURE_INTERVAL_MS
  await sweep()
  await watchdog.refreshPaneTail()
  expect(tail.calls).toBe(calls)
  expect(getCachedPaneTailForTask(taskId)).toBeUndefined()
})

test('a capture that settles after dispose is dropped', async () => {
  const taskId = crasherTaskId(state)
  let release!: (text: string | null) => void
  tail.gate = () => new Promise<string | null>(resolve => (release = resolve))
  const inFlight = watchdog.refreshPaneTail()
  expect(tail.calls).toBe(1)
  watchdog.dispose()
  release('late tail')
  await inFlight
  expect(getCachedPaneTailForTask(taskId)).toBeUndefined()
})

test('the crash hand-off drops the tail with the registration', async () => {
  await sweep()
  const taskId = crasherTaskId(state)
  expect(getCachedPaneTailForTask(taskId)).toBeDefined()
  await killPaneAndSweep(pane)
  await expectCrashOutcome(getState, {
    cachedTail: { ageSeconds: 0, text: PANE_TEXT },
  })
  expect(getCachedPaneTailForTask(taskId)).toBeUndefined()
  // Later ticks capture nothing for the failed task.
  const calls = tail.calls
  clock.t += PANE_TAIL_CAPTURE_INTERVAL_MS
  pane.state = 'present'
  await sweep()
  expect(tail.calls).toBe(calls)
})

test('a respawn under the same name never inherits the previous run\'s tail', async () => {
  const oldTaskId = crasherTaskId(state)
  tail.text = 'old life: beat 99'
  await sweep()
  expect(getCachedPaneTailForTask(oldTaskId)?.text).toBe('old life: beat 99')

  // The old run ends by another hand while its registration (and tail) is
  // still held, then the teammate is respawned under the same name.
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [oldTaskId]: { ...prev.tasks[oldTaskId]!, status: 'completed' },
    },
  }))
  const fresh = scriptedPaneTail(pane, null)
  const respawned = registerCrasher(setAppState, pane, {
    now: () => clock.t,
    capturePaneTail: fresh.dep,
  })
  try {
    const newTaskId = Object.values(state.tasks).find(
      t => t.id !== oldTaskId && t.type === 'in_process_teammate',
    )!.id
    expect(newTaskId).not.toBe(oldTaskId)
    expect(getCachedPaneTailForTask(newTaskId)).toBeUndefined()

    await killPaneAndSweep(pane)

    const failed = notificationsFor(newTaskId, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).not.toContain('old life')
    expect(failed[0]).toContain(PANE_GONE_LINE)
    const output = readFileSync(getTaskOutputPath(newTaskId), 'utf8')
    expect(output).not.toContain('old life')
    expect(output).toContain(PANE_GONE_LINE)
  } finally {
    respawned.dispose()
  }
})

test('the dead-pane deadline failure uses the cached tail too', async () => {
  const firstTaskId = crasherTaskId(state)
  watchdog.dispose()
  const deadline = registerCrasher(setAppState, pane, {
    now: () => clock.t,
    capturePaneTail: tail.dep,
    progressTimeoutMs: 20_000,
  })
  try {
    const taskId = Object.values(state.tasks).find(
      t => t.type === 'in_process_teammate' && t.id !== firstTaskId,
    )!.id
    await deadline.refreshPaneTail()
    expect(getCachedPaneTailForTask(taskId)?.text).toBe(PANE_TEXT)

    // The CLI died and its pane is gone; no sweep has confirmed it yet.
    pane.state = 'absent'
    clock.t += 25_000
    await deadline.scan()

    const failed = notificationsFor(taskId, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('Pane exited without completing')
    const heading = 'Last pane output (captured 25s before the pane closed):'
    const output = readFileSync(getTaskOutputPath(taskId), 'utf8')
    expect(output).toContain(`${heading}\n${PANE_TEXT}`)
    expect(output).not.toContain(PANE_GONE_LINE)
  } finally {
    deadline.dispose()
  }
})
