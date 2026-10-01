import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { enqueueAgentNotification } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import {
  getTeamSweeper,
  type PaneTeammateWatchdogDeps,
  type PaneTeammateWatchdogHandle,
  type PaneWatchdogMailboxMessage,
  LATE_COMPLETION_SEPARATOR,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import { resetFailedTeammateReapsForTesting } from '../../utils/swarm/failedTeammateReaper.js'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { unescapeXml } from '../../utils/xml.js'
import { registerOutOfProcessTeammateTask } from './spawnMultiAgent.js'

// A pane teammate's <task-notification> names an <output-file>. It used to
// name a path nothing ever created. Registration now creates the file, the
// watchdog appends the final report before it notifies, and the notification
// only advertises a path that exists.

const TEAM = 'outfile-team'
const WORKER = 'worker'

let testRoot: string
let originalTmpDir: string | undefined
const handles: PaneTeammateWatchdogHandle[] = []

beforeEach(async () => {
  await acquireSharedMutationLock('tools/shared/spawnMultiAgent.outputFile.test.ts')
  resetCommandQueue()
  originalTmpDir = process.env.CLAUDE_CODE_TMPDIR
  testRoot = await mkdtemp(join(tmpdir(), 'openclaude-pane-output-file-'))
  process.env.CLAUDE_CODE_TMPDIR = testRoot
  getClaudeTempDir.cache?.clear?.()
  _resetTaskOutputDirForTest()
})

afterEach(async () => {
  try {
    for (const handle of handles) handle.dispose()
    handles.length = 0
    getTeamSweeper(TEAM)?.dispose()
    resetFailedTeammateReapsForTesting()
    resetCommandQueue()
    await _clearOutputsForTest()
  } finally {
    if (originalTmpDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
    else process.env.CLAUDE_CODE_TMPDIR = originalTmpDir
    getClaudeTempDir.cache?.clear?.()
    _resetTaskOutputDirForTest()
    await rm(testRoot, { recursive: true, force: true })
    releaseSharedMutationLock()
  }
})

type World = {
  state: AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  mailbox: PaneWatchdogMailboxMessage[]
  nowMs: number
}

function makeWorld(): World {
  const world = {
    state: {
      tasks: {},
      speculation: { status: 'idle' },
    } as unknown as AppState,
    mailbox: [],
    nowMs: 1_000_000,
  } as unknown as World
  world.setAppState = updater => {
    world.state = updater(world.state)
  }
  return world
}

function deps(world: World): PaneTeammateWatchdogDeps {
  return {
    now: () => world.nowMs,
    currentSessionId: 'lead-session',
    readLeadMailbox: async () => world.mailbox,
    readTeamFile: async () => ({
      leadAgentId: `team-lead@${TEAM}`,
      members: [{ name: 'team-lead' }, { name: WORKER, isActive: true }],
    }),
    probePane: async () => 'alive',
    probeMemberPanePresence: async () => 'present',
    discoverReachableSockets: async () => ['default'],
    recordMemberSocket: () => true,
    capturePaneTail: async () => 'last pane line',
    unassignMemberTasks: async () => '',
    scanIntervalMs: null,
    firstContactTimeoutMs: 60_000,
    progressTimeoutMs: 600_000,
    unknownRetryDelayMs: 1_000,
    maxUnknownRetries: 3,
  }
}

function register(world: World): { taskId: string; handle: PaneTeammateWatchdogHandle } {
  const handle = registerOutOfProcessTeammateTask(
    world.setAppState,
    {
      teammateId: `${WORKER}@${TEAM}`,
      sanitizedName: WORKER,
      teamName: TEAM,
      teammateColor: 'cyan',
      prompt: 'count the call sites',
      paneId: '%42',
      backendType: 'tmux',
      toolUseId: 'toolu-1',
    },
    deps(world),
  )
  handles.push(handle)
  const taskId = Object.keys(world.state.tasks)[0]!
  return { taskId, handle }
}

function idle(
  world: World,
  fields: Record<string, unknown>,
): PaneWatchdogMailboxMessage {
  const timestamp = new Date(world.nowMs).toISOString()
  return {
    from: WORKER,
    text: JSON.stringify({ type: 'idle_notification', from: WORKER, timestamp, ...fields }),
    timestamp,
  }
}

function outputFileOf(notification: string): string | undefined {
  return notification.match(/<output-file>([^<]+)<\/output-file>/)?.[1]
}

/**
 * Record, at the instant each notification is enqueued, what its
 * <output-file> held on disk — the lead can act on the notification
 * immediately, so "written a moment later" is not good enough.
 */
function captureAtEnqueue(): {
  seen: Array<{ value: string; fileAtEnqueue: string | null }>
  stop: () => void
} {
  const seen: Array<{ value: string; fileAtEnqueue: string | null }> = []
  const stop = subscribeToCommandQueue(() => {
    for (const command of getCommandQueueSnapshot().slice(seen.length)) {
      const value = String(command.value)
      const path = outputFileOf(value)
      seen.push({
        value,
        fileAtEnqueue: path && existsSync(path) ? readFileSync(path, 'utf8') : null,
      })
    }
  })
  return { seen, stop }
}

test('registering a pane teammate creates the output file its notification names', async () => {
  const world = makeWorld()
  const { taskId } = register(world)
  await _clearOutputsForTest() // drain the fire-and-forget create

  expect(existsSync(getTaskOutputPath(taskId))).toBe(true)
  expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('')
})

test("a pane completion writes the final report to <output-file> before the lead is notified", async () => {
  const world = makeWorld()
  const { taskId, handle } = register(world)
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.mailbox.push(
    idle(world, {
      idleReason: 'available',
      lastAssistantText: 'FINAL: 7 call sites in src/.',
    }),
  )
  await handle.scan()
  capture.stop()

  expect(capture.seen).toHaveLength(1)
  const { value, fileAtEnqueue } = capture.seen[0]!
  expect(value).toContain('<status>completed</status>')
  expect(value).toContain('<result>FINAL: 7 call sites in src/.</result>')
  expect(outputFileOf(value)).toBe(getTaskOutputPath(taskId))
  // Readable, with the same text as <result>, the moment the lead sees it.
  expect(fileAtEnqueue).toBe('FINAL: 7 call sites in src/.\n')
})

test('a self-reported pane failure writes its report to <output-file> too', async () => {
  const world = makeWorld()
  const { taskId, handle } = register(world)
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.mailbox.push(
    idle(world, {
      idleReason: 'failed',
      failureReason: 'tests red',
      lastAssistantText: 'Could not fix the flaky test.',
    }),
  )
  await handle.scan()
  capture.stop()

  expect(capture.seen).toHaveLength(1)
  expect(capture.seen[0]!.value).toContain('<status>failed</status>')
  expect(outputFileOf(capture.seen[0]!.value)).toBe(getTaskOutputPath(taskId))
  expect(capture.seen[0]!.fileAtEnqueue).toBe('Could not fix the flaky test.\n')
})

test('a watchdog deadline failure writes its failure report to <output-file> before the lead is notified', async () => {
  const world = makeWorld()
  const { taskId, handle } = register(world)
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.nowMs += 600_001
  await handle.scan()
  capture.stop()

  expect(capture.seen).toHaveLength(1)
  const { value, fileAtEnqueue } = capture.seen[0]!
  expect(value).toContain('<status>failed</status>')
  expect(outputFileOf(value)).toBe(getTaskOutputPath(taskId))
  const result = value.match(/<result>([\s\S]*)<\/result>/)?.[1]
  expect(result).toContain('Teammate emitted no lifecycle signal within 600s')
  expect(result).toContain('Last ~40 lines of the pane:\nlast pane line')
  // The same failure text is on disk the moment the lead sees it.
  // The file holds the raw text; <result> holds it XML-escaped.
  expect(fileAtEnqueue).toBe(`${unescapeXml(result)}\n`)
})

test('a late completion that wins during the failure capture leaves no stale failure in <output-file>', async () => {
  const world = makeWorld()
  let releaseCapture: (tail: string | null) => void = () => {}
  const capture = new Promise<string | null>(resolve => {
    releaseCapture = resolve
  })
  let captureStarted = false
  const handle = registerOutOfProcessTeammateTask(
    world.setAppState,
    {
      teammateId: `${WORKER}@${TEAM}`,
      sanitizedName: WORKER,
      teamName: TEAM,
      teammateColor: 'cyan',
      prompt: 'count the call sites',
      paneId: '%42',
      backendType: 'tmux',
      toolUseId: 'toolu-1',
    },
    {
      ...deps(world),
      capturePaneTail: () => {
        captureStarted = true
        return capture
      },
    },
  )
  handles.push(handle)
  const taskId = Object.keys(world.state.tasks)[0]!
  await _clearOutputsForTest()

  // Alive pane past its progress deadline: failed, capture pending.
  world.nowMs += 600_001
  const failing = handle.scanUnserialized()
  await waitUntil(() => captureStarted, 'captureStarted')

  world.mailbox.push(
    idle(world, { idleReason: 'available', lastAssistantText: 'FINAL: late but real.' }),
  )
  const capture2 = captureAtEnqueue()
  await handle.scanUnserialized()
  releaseCapture('stale tail')
  await failing
  capture2.stop()
  await _clearOutputsForTest()

  expect(capture2.seen).toHaveLength(1)
  expect(capture2.seen[0]!.value).toContain('<status>completed</status>')
  // Only the winning report is on disk; the stale failure never got appended.
  expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('FINAL: late but real.\n')
})

/** Wait (yielding to timers and I/O) until `cond` holds; fail fast instead of hanging. */
async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function registerWith(
  world: World,
  extra: PaneTeammateWatchdogDeps,
): { taskId: string; handle: PaneTeammateWatchdogHandle } {
  const handle = registerOutOfProcessTeammateTask(
    world.setAppState,
    {
      teammateId: `${WORKER}@${TEAM}`,
      sanitizedName: WORKER,
      teamName: TEAM,
      teammateColor: 'cyan',
      prompt: 'count the call sites',
      paneId: '%42',
      backendType: 'tmux',
      toolUseId: 'toolu-1',
    },
    { ...deps(world), ...extra },
  )
  handles.push(handle)
  return { taskId: Object.keys(world.state.tasks)[0]!, handle }
}

const FAILURE_TEXT_START = 'Teammate emitted no lifecycle signal within 600s'

test('a completion that arrives while the failure flush is in flight waits: failure first, then the late completion after a separator', async () => {
  const world = makeWorld()
  let releaseFlush: () => void = () => {}
  const flushGate = new Promise<void>(resolve => {
    releaseFlush = resolve
  })
  let flushInFlight = false
  let gated = false
  const { taskId, handle } = registerWith(world, {
    // Gate the FIRST flush after the failure text is appended.
    flushTaskOutput: async id => {
      if (!gated) {
        gated = true
        flushInFlight = true
        await flushGate
      }
      await flushTaskOutput(id)
    },
  })
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.nowMs += 600_001
  const failing = handle.scan()
  await waitUntil(() => flushInFlight, 'flushInFlight')

  world.mailbox.push(
    idle(world, { idleReason: 'available', lastAssistantText: 'FINAL: late but real.' }),
  )
  const completing = handle.scan()
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
  // The completion waits for the failure to finish finalizing.
  expect(capture.seen).toHaveLength(0)
  expect((world.state.tasks as Record<string, { status: string }>)[taskId]!.status).toBe('failed')

  releaseFlush()
  await failing
  await completing
  capture.stop()
  await _clearOutputsForTest()

  expect(capture.seen.map(s => s.value.match(/<status>([^<]+)</)?.[1])).toEqual([
    'failed',
    'completed',
  ])
  // The failed notification's file held the failure alone; the completed one's
  // file holds the failure, the separator, then the real result.
  expect(capture.seen[0]!.fileAtEnqueue?.startsWith(FAILURE_TEXT_START)).toBe(true)
  expect(capture.seen[0]!.fileAtEnqueue).not.toContain('FINAL: late but real.')
  const finalFile = readFileSync(getTaskOutputPath(taskId), 'utf8')
  expect(finalFile).toBe(capture.seen[1]!.fileAtEnqueue!)
  expect(finalFile.startsWith(FAILURE_TEXT_START)).toBe(true)
  expect(finalFile.endsWith(`${LATE_COMPLETION_SEPARATOR}FINAL: late but real.\n`)).toBe(true)
  expect(finalFile.split(LATE_COMPLETION_SEPARATOR)).toHaveLength(2)
})

test('a TaskStop kill that lands during the failure flush suppresses the failure notification', async () => {
  const world = makeWorld()
  let releaseFlush: () => void = () => {}
  const flushGate = new Promise<void>(resolve => {
    releaseFlush = resolve
  })
  let flushInFlight = false
  const { taskId, handle } = registerWith(world, {
    flushTaskOutput: async id => {
      flushInFlight = true
      await flushGate
      await flushTaskOutput(id)
    },
  })
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.nowMs += 600_001
  const failing = handle.scan()
  await waitUntil(() => flushInFlight, 'flushInFlight')

  // TaskStop is not a finalization-lock holder: it rewrites the task directly.
  // `notified` is left false so enqueueAgentNotification's own dedupe cannot
  // mask the failure path's post-flush ownership check.
  const tasks = world.state.tasks as Record<string, Record<string, unknown>>
  tasks[taskId] = { ...tasks[taskId]!, status: 'killed', notified: false }

  releaseFlush()
  await failing
  capture.stop()
  await _clearOutputsForTest()

  expect(capture.seen).toHaveLength(0)
  expect(tasks[taskId]!.status).toBe('killed')
})

test('a TaskStop kill that lands during the dead-pane unassign leaves no failure text on the killed task', async () => {
  const world = makeWorld()
  let releaseUnassign: () => void = () => {}
  const unassignGate = new Promise<void>(resolve => {
    releaseUnassign = resolve
  })
  let unassignInFlight = false
  const { taskId, handle } = registerWith(world, {
    probePane: async () => 'dead',
    unassignMemberTasks: async () => {
      unassignInFlight = true
      await unassignGate
      return ''
    },
  })
  await _clearOutputsForTest()

  const capture = captureAtEnqueue()
  world.nowMs += 600_001
  const failing = handle.scan()
  await waitUntil(() => unassignInFlight, 'unassignInFlight')

  // Not a lock holder: the kill rewrites the task directly, mid-unassign.
  const tasks = world.state.tasks as Record<string, Record<string, unknown>>
  tasks[taskId] = { ...tasks[taskId]!, status: 'killed', notified: false }

  releaseUnassign()
  await failing
  capture.stop()
  await _clearOutputsForTest()

  expect(capture.seen).toHaveLength(0)
  expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('')
})

test('a failure whose flush throws is still reported (the file write is best-effort), and the late completion is delivered', async () => {
  const world = makeWorld()
  let thrown = false
  const { taskId, handle } = registerWith(world, {
    flushTaskOutput: async id => {
      if (!thrown) {
        thrown = true
        throw new Error('disk full')
      }
      await flushTaskOutput(id)
    },
  })
  await _clearOutputsForTest()

  // The failure is committed before emit, so an output file that cannot be
  // written must not cost the lead the failed notification (it used to
  // reject the scan and drop the notification).
  const failureCapture = captureAtEnqueue()
  world.nowMs += 600_001
  await handle.scan()
  failureCapture.stop()
  expect(failureCapture.seen).toHaveLength(1)
  expect(failureCapture.seen[0]!.value).toContain('<status>failed</status>')
  expect((world.state.tasks as Record<string, { status: string }>)[taskId]!.status).toBe('failed')

  const capture = captureAtEnqueue()
  world.mailbox.push(
    idle(world, { idleReason: 'available', lastAssistantText: 'FINAL: after the throw.' }),
  )
  await handle.scan()
  capture.stop()

  // The queue still holds the failed notification above; the late
  // completion is the one new completed notification.
  const completed = capture.seen.filter(seen =>
    seen.value.includes('<status>completed</status>'),
  )
  expect(completed).toHaveLength(1)
  expect(completed[0]!.value).toContain('FINAL: after the throw.')
  expect((world.state.tasks as Record<string, { status: string }>)[taskId]!.status).toBe('completed')
})

test('a completion after the failure fully committed is appended after the separator', async () => {
  const world = makeWorld()
  const { taskId, handle } = registerWith(world, {})
  await _clearOutputsForTest()

  world.nowMs += 600_001
  await handle.scan()
  const afterFailure = readFileSync(getTaskOutputPath(taskId), 'utf8')
  expect(afterFailure.startsWith(FAILURE_TEXT_START)).toBe(true)

  world.mailbox.push(
    idle(world, { idleReason: 'available', lastAssistantText: 'FINAL: much later.' }),
  )
  await handle.scan()
  await _clearOutputsForTest()

  expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
    `${afterFailure}${LATE_COMPLETION_SEPARATOR}FINAL: much later.\n`,
  )
})

test('eviction keeps the file, so the path advertised after it still reads', async () => {
  const world = makeWorld()
  const { taskId, handle } = register(world)
  await _clearOutputsForTest()

  world.mailbox.push(
    idle(world, { idleReason: 'available', lastAssistantText: 'done: all green' }),
  )
  await handle.scan()
  // emit already evicted; evicting again (the kill/complete paths do) is
  // memory-only and must not touch the file.
  await evictTaskOutput(taskId)
  await _clearOutputsForTest()

  const path = outputFileOf(String(getCommandQueueSnapshot()[0]!.value))
  expect(path).toBe(getTaskOutputPath(taskId))
  expect(readFileSync(path!, 'utf8')).toBe('done: all green\n')
})

test('a notification never advertises an output file that does not exist', async () => {
  const world = makeWorld()
  const { taskId } = register(world)
  await _clearOutputsForTest()
  // The file could not be created (or was removed): no stale path goes out.
  rmSync(getTaskOutputPath(taskId))

  enqueueAgentNotification({
    taskId,
    description: 'worker: count the call sites',
    status: 'failed',
    error: 'Pane exited without completing',
    setAppState: world.setAppState,
  })

  const value = String(getCommandQueueSnapshot()[0]!.value)
  expect(value).toContain('<status>failed</status>')
  expect(value).not.toContain('<output-file>')
})
