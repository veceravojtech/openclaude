import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { registerTmuxBackend } from './backends/registry.js'
import { TmuxBackend } from './backends/TmuxBackend.js'
import type { PaneBackend } from './backends/types.js'
import {
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from './teamHelpers.js'
import { TEAMMATE_GRACE_MS } from '../task/framework.js'

// The kill cascade's terminal-pane half: a FAILED pane teammate still owns a
// live pane, so TaskStop must close that pane on its recorded socket and only
// then remove the roster member — never orphaning the pane by deleting the
// member first. These pin the socket plumbing, the kill-then-remove ordering,
// the single terminal SDK bookend, and the untouched early-return for rows
// that are already terminal by a non-killable shape.

type SdkEventQueueModule = typeof import('../sdkEventQueue.js')
type SpawnModule = typeof import('./spawnInProcess.js')

let configDir: string | undefined
let actualSdkEventQueue: SdkEventQueueModule | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/spawnInProcess.paneKill.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-pane-kill-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.restore()
    // See inProcessRunner.handoff.test.ts: the factory must be handed a spread
    // copy, or bun treats a returned namespace object as a silent no-op.
    if (actualSdkEventQueue) {
      mock.module('../sdkEventQueue.js', () => ({ ...actualSdkEventQueue }))
    }
    registerTmuxBackend(TmuxBackend)
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type World = {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}

function createWorld(): World {
  let state: AppState = getDefaultAppState()
  return {
    getState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

/** A failed pane teammate task row, as the watchdog leaves it. */
function failedPaneTask(
  agentId = 'opus-worker@test',
): InProcessTeammateTaskState {
  const [agentName, teamName] = agentId.split('@') as [string, string]
  return {
    id: 't-failed-pane',
    type: 'in_process_teammate',
    status: 'failed',
    description: `${agentName}: first turn failed`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: true,
    identity: {
      agentId,
      agentName,
      teamName,
      planModeRequired: false,
      parentSessionId: getSessionId(),
    },
    prompt: 'work',
    abortController: new AbortController(),
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    retain: false,
    evictAfter: Date.now() + TEAMMATE_GRACE_MS,
  }
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Array<{
    agentId: string
    name: string
    backendType?: TeamFile['members'][number]['backendType']
    tmuxPaneId?: string
    tmuxSocket?: string
  }>,
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    leadSessionId: getSessionId(),
    members: members.map(m => ({
      agentId: m.agentId,
      name: m.name,
      joinedAt: 0,
      tmuxPaneId: m.tmuxPaneId ?? 'in-process',
      cwd: '/repo',
      subscriptions: [],
      backendType: m.backendType,
      ...(m.tmuxSocket !== undefined ? { tmuxSocket: m.tmuxSocket } : {}),
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

/** Registers a fake tmux backend whose killPaneOnSocket records its calls. */
function installFakeTmuxBackend(killResult: boolean): {
  calls: Array<{ paneId: string; socket?: string }>
} {
  const calls: Array<{ paneId: string; socket?: string }> = []
  class FakeTmuxBackend {
    async killPaneOnSocket(paneId: string, socket?: string): Promise<boolean> {
      calls.push({ paneId, socket })
      return killResult
    }
  }
  registerTmuxBackend(FakeTmuxBackend as unknown as new () => PaneBackend)
  return { calls }
}

/** Freshly imports spawnInProcess with the SDK bookend recorded. */
async function importSpawnWithMocks(
  terminatedEvents: Array<{ taskId: string; status: string }>,
): Promise<SpawnModule> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?paneKillActual=${stamp}`
  )
  mock.module('../sdkEventQueue.js', () => ({
    ...actualSdkEventQueue!,
    emitTaskTerminatedSdk: (taskId: string, status: string) => {
      terminatedEvents.push({ taskId, status })
    },
  }))
  return import(`./spawnInProcess.js?paneKill=${stamp}`)
}

test('killing a failed pane teammate closes its pane on the recorded socket and emits no second terminal event', async () => {
  const terminatedEvents: Array<{ taskId: string; status: string }> = []
  const spawn = await importSpawnWithMocks(terminatedEvents)
  const fake = installFakeTmuxBackend(true)
  const world = createWorld()
  const task = failedPaneTask()
  world.setAppState(prev => ({
    ...prev,
    tasks: { ...prev.tasks, [task.id]: task },
  }))
  writeTeam('test', [
    {
      agentId: 'opus-worker@test',
      name: 'opus-worker',
      backendType: 'tmux',
      tmuxPaneId: '%21',
      tmuxSocket: 'swarm-socket',
    },
  ])

  const killed = await spawn.killInProcessTeammateAndCascade(
    task.id,
    world.setAppState,
  )

  expect(killed).toBe(true)
  expect(fake.calls).toEqual([{ paneId: '%21', socket: 'swarm-socket' }])
  // The failure transition already emitted 'failed' for this task; the kill
  // must not add a second terminal event for the same id.
  expect(terminatedEvents).toEqual([])
  expect(readTeamFile('test')?.members.map(m => m.agentId)).toEqual([])
})

test('killing a running teammate emits exactly one terminal SDK event', async () => {
  const terminatedEvents: Array<{ taskId: string; status: string }> = []
  const spawn = await importSpawnWithMocks(terminatedEvents)
  const world = createWorld()
  const result = await spawn.spawnInProcessTeammate(
    { name: 'idler', teamName: 'alpha', planModeRequired: false, prompt: 'work' },
    { setAppState: world.setAppState, getAppState: world.getState },
  )
  if (!result.success || !result.taskId) {
    throw new Error(`spawn failed: ${result.error}`)
  }

  await spawn.killInProcessTeammateAndCascade(result.taskId, world.setAppState)

  expect(terminatedEvents).toEqual([
    { taskId: result.taskId, status: 'stopped' },
  ])
})

test('a failed pane kill leaves the roster member in place and reports false', async () => {
  const terminatedEvents: Array<{ taskId: string; status: string }> = []
  const spawn = await importSpawnWithMocks(terminatedEvents)
  installFakeTmuxBackend(false)
  const world = createWorld()
  const task = failedPaneTask()
  world.setAppState(prev => ({
    ...prev,
    tasks: { ...prev.tasks, [task.id]: task },
  }))
  writeTeam('test', [
    {
      agentId: 'opus-worker@test',
      name: 'opus-worker',
      backendType: 'tmux',
      tmuxPaneId: '%21',
      tmuxSocket: 'swarm-socket',
    },
  ])

  const killed = await spawn.killInProcessTeammateAndCascade(
    task.id,
    world.setAppState,
  )

  expect(killed).toBe(false)
  expect(readTeamFile('test')?.members.map(m => m.agentId)).toEqual([
    'opus-worker@test',
  ])
})

test('completed and killed rows still early-return untouched', async () => {
  const terminatedEvents: Array<{ taskId: string; status: string }> = []
  const spawn = await importSpawnWithMocks(terminatedEvents)
  installFakeTmuxBackend(true)
  const world = createWorld()

  for (const status of ['completed', 'killed'] as const) {
    const task = failedPaneTask()
    const id = `t-${status}`
    world.setAppState(prev => ({
      ...prev,
      tasks: { ...prev.tasks, [id]: { ...task, id, status } },
    }))

    const killed = await spawn.killInProcessTeammateAndCascade(
      id,
      world.setAppState,
    )

    expect(killed).toBe(false)
    expect(world.getState().tasks[id]?.status).toBe(status)
  }
  expect(terminatedEvents).toEqual([])
})
