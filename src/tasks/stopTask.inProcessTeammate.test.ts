import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTaskByType } from '../tasks.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../utils/envUtils.js'
import { spawnInProcessTeammate } from '../utils/swarm/spawnInProcess.js'
import { registerTmuxBackend } from '../utils/swarm/backends/registry.js'
import { TmuxBackend } from '../utils/swarm/backends/TmuxBackend.js'
import type { PaneBackend } from '../utils/swarm/backends/types.js'
import {
  getTeamDir,
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from '../utils/swarm/teamHelpers.js'
import { TEAMMATE_GRACE_MS } from '../utils/task/framework.js'
import { createTask, getTasksDir } from '../utils/tasks.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import { stopTask, StopTaskError } from './stopTask.js'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tasks/stopTask.inProcessTeammate.test.ts')
  // Keep killInProcessTeammate's team-file cleanup away from the real home.
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-stop-teammate-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    // Restore the real tmux backend after any test that installed a fake.
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

function idleTeammate(abortController: AbortController): InProcessTeammateTaskState {
  return {
    id: 't-idle',
    type: 'in_process_teammate',
    status: 'running',
    description: 'idler: idle (waiting for work)',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'idler@alpha',
      agentName: 'idler',
      teamName: 'alpha',
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: '',
    abortController,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: true,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

test('the in-process teammate task impl is registered for kill dispatch', () => {
  expect(getTaskByType('in_process_teammate')?.type).toBe('in_process_teammate')
})

test('stopTask kills an idle in-process teammate', async () => {
  const abortController = new AbortController()
  const task = idleTeammate(abortController)
  let idleCallbacks = 0
  task.onIdleCallbacks = [() => idleCallbacks++]

  let state = {
    tasks: { [task.id]: task },
    teamContext: {
      teamName: 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [task.identity.agentId]: { name: 'idler' } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const result = await stopTask(task.id, context)
  expect(result).toEqual({
    taskId: task.id,
    taskType: 'in_process_teammate',
    command: task.description,
  })
  const stopped = state.tasks[task.id] as InProcessTeammateTaskState | undefined
  expect(stopped?.status).toBe('killed')
  expect(stopped?.notified).toBe(true)
  expect(abortController.signal.aborted).toBe(true)
  expect(idleCallbacks).toBe(1)
  expect(state.teamContext?.teammates).toEqual({})

  // Already stopped: the shared guard rejects a second stop.
  await expect(stopTask(task.id, context)).rejects.toBeInstanceOf(StopTaskError)
})

test('stopTask kills a teammate addressed as name@team', async () => {
  // The address ListAgents hands out. It is never a key in AppState.tasks —
  // task ids are a type prefix plus 8 chars of [0-9a-z], so `@` can never
  // appear in one — and the raw key lookup here used to reject it outright.
  const abortController = new AbortController()
  const task = idleTeammate(abortController)
  let state = {
    tasks: { [task.id]: task },
    teamContext: {
      teamName: 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [task.identity.agentId]: { name: 'idler' } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const result = await stopTask(task.identity.agentId, context)
  // Reported under the id the task really has, not the address that was typed.
  expect(result).toEqual({
    taskId: task.id,
    taskType: 'in_process_teammate',
    command: task.description,
  })
  expect(state.tasks[task.id]?.status).toBe('killed')
  expect(abortController.signal.aborted).toBe(true)
})

test('stopTask refuses to call a teammate of another session a bad id', async () => {
  // AppState.tasks is per-process and never persisted: a teammate spawned by
  // another session has no row here under any id, so "No task found with ID"
  // sent the caller off to re-type an address that was never the problem.
  writeTeam(
    'codex-probe',
    [{ agentId: 'codex-a@codex-probe', name: 'codex-a' }],
    undefined,
    'be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60',
  )
  let state = { tasks: {} } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const error = await stopTask('codex-a@codex-probe', context).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(StopTaskError)
  const message = (error as StopTaskError).message
  expect(message).not.toContain('No task found with ID')
  expect(message).toContain('is not a task in this session')
  expect(message).toContain('be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60')
})

test('stopTask reports a kill that did not take, instead of a fabricated success', async () => {
  // The honesty rule terminate() now follows: success is an OBSERVED stop. Here
  // the store drops the kill's mutation, so the teammate is still running when
  // the kill returns — the caller must not be told it was stopped.
  const abortController = new AbortController()
  const task = idleTeammate(abortController)
  const state = {
    tasks: { [task.id]: task },
    teamContext: {
      teamName: 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [task.identity.agentId]: { name: 'idler' } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    // A store that never applies the update: the row stays `running`.
    setAppState: () => {},
  }

  const error = await stopTask(task.id, context).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StopTaskError)
  expect((error as StopTaskError).code).toBe('not_terminated')
  expect((error as StopTaskError).message).toContain('still running')
  expect(state.tasks[task.id]?.status).toBe('running')
  expect(abortController.signal.aborted).toBe(false)
})

test('a killed teammate keeps its row for the grace window instead of lingering 3s undrawn', async () => {
  // The kill path used to set a 3s setTimeout that evicted the task — and the
  // row was not drawn during those 3s anyway, so a killed teammate simply
  // disappeared. It now writes the same retain/grace pair the other two terminal
  // paths write, which keeps the row in the tree for 30s, dimmed and reading
  // `killed`, and hands the collecting to the shared funnel.
  const abortController = new AbortController()
  const task = idleTeammate(abortController)
  let state = {
    tasks: { [task.id]: task },
    teamContext: {
      teamName: 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [task.identity.agentId]: { name: 'idler' } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const before = Date.now()
  await stopTask(task.id, context)
  const killed = state.tasks[task.id] as InProcessTeammateTaskState | undefined

  expect(killed?.status).toBe('killed')
  expect(killed?.retain).toBe(false)
  expect(killed?.evictAfter).toBeGreaterThanOrEqual(before + TEAMMATE_GRACE_MS)
  expect(killed?.evictAfter).toBeLessThanOrEqual(Date.now() + TEAMMATE_GRACE_MS)
})

// U7: TaskStop on a teammate that leads a sub-team takes the sub-team with
// it, and stopTask does not resolve until it has — no sleeping in the test.

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const TEAM_LEAD = 'team-lead'

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
  parent?: { parentTeam: string; parentAgentId: string },
  leadSessionId?: string,
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    leadSessionId,
    ...parent,
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

test('stopTask on a sub-lead stops its sub-team and removes it before resolving', async () => {
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `worker@${SUB_TEAM}`, name: 'worker' },
    ],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
  await createTask(SUB_TEAM, {
    subject: 'sub-team work',
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  let state: AppState = getDefaultAppState()
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }
  const spawn = async (name: string, teamName: string): Promise<string> => {
    const result = await spawnInProcessTeammate(
      { name, teamName, planModeRequired: false, prompt: 'work' },
      { setAppState: context.setAppState, getAppState: context.getAppState },
    )
    if (!result.success || !result.taskId) {
      throw new Error(`spawn failed: ${result.error}`)
    }
    return result.taskId
  }

  const subLeadTask = await spawn(SUB_LEAD, PARENT_TEAM)
  const workerTask = await spawn('worker', SUB_TEAM)

  const result = await stopTask(subLeadTask, context)
  expect(result.taskType).toBe('in_process_teammate')

  // Observable the moment stopTask resolves: no polling, no sleeping.
  expect(state.tasks[subLeadTask]?.status).toBe('killed')
  expect(state.tasks[workerTask]?.status).toBe('killed')
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(readTeamFile(PARENT_TEAM)?.members.map(m => m.name)).toEqual([
    TEAM_LEAD,
  ])
})

// A failed PANE teammate: the failure path leaves the pane alive for resume,
// so the task row reads `failed` while the pane and its roster member still
// exist. TaskStop from the lead session must reach that ghost.

function failedPaneTeammate(
  abortController: AbortController,
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
    abortController,
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

test('TaskStop on a failed pane teammate kills its pane on the recorded socket before removing the member', async () => {
  const fake = installFakeTmuxBackend(true)
  const abortController = new AbortController()
  const task = failedPaneTeammate(abortController, 'opus-worker@test')
  writeTeam(
    'test',
    [
      {
        agentId: 'opus-worker@test',
        name: 'opus-worker',
        backendType: 'tmux',
        tmuxPaneId: '%21',
        tmuxSocket: 'swarm-socket',
      },
    ],
    undefined,
    getSessionId(),
  )

  let state = { tasks: { [task.id]: task } } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const result = await stopTask('opus-worker@test', context)
  expect(result.taskId).toBe(task.id)
  expect(result.taskType).toBe('in_process_teammate')

  // The pane was killed through the recorded socket, not the abort listener's
  // guessed socket: a failed row must NOT abort (that listener still kills on
  // `!insideTmux`), and the member goes only after the kill returned success.
  expect(state.tasks[task.id]?.status).toBe('killed')
  expect(fake.calls).toEqual([{ paneId: '%21', socket: 'swarm-socket' }])
  expect(abortController.signal.aborted).toBe(false)
  expect(readTeamFile('test')?.members.map(m => m.agentId)).toEqual([])
})

test('TaskStop still refuses a failed pane teammate of another session with the pane hint', async () => {
  // No task row here (another session spawned it), and the roster says the
  // owner is a different session: the existing refusal text must survive,
  // including the pane-closing hint.
  writeTeam(
    'test',
    [
      {
        agentId: 'opus-worker@test',
        name: 'opus-worker',
        backendType: 'tmux',
        tmuxPaneId: '%42',
      },
    ],
    undefined,
    'be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60',
  )

  let state = { tasks: {} } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const error = await stopTask('opus-worker@test', context).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(StopTaskError)
  const message = (error as StopTaskError).message
  expect(message).toContain('is not a task in this session')
  expect(message).toContain('be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60')
  expect(message).toContain('%42')
})

test('TaskStop on a failed pane teammate whose pane will not close leaves the member for the sweep', async () => {
  // The pane is already gone, so the socket kill reports failure. The stop
  // must not crash, and — crucially — must NOT orphan the member: leaving it
  // in place keeps the ghost visible and sweepable rather than deleting the
  // only record of its pane id.
  installFakeTmuxBackend(false)
  const abortController = new AbortController()
  const task = failedPaneTeammate(abortController, 'opus-worker@test')
  writeTeam(
    'test',
    [
      {
        agentId: 'opus-worker@test',
        name: 'opus-worker',
        backendType: 'tmux',
        tmuxPaneId: '%21',
        tmuxSocket: 'swarm-socket',
      },
    ],
    undefined,
    getSessionId(),
  )

  let state = { tasks: { [task.id]: task } } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const result = await stopTask('opus-worker@test', context)
  expect(result.taskId).toBe(task.id)
  expect(state.tasks[task.id]?.status).toBe('killed')
  expect(readTeamFile('test')?.members.map(m => m.agentId)).toEqual([
    'opus-worker@test',
  ])
})

// Characterization of the post-eviction ghost (Step 3 scope): once the 30s
// grace has passed the failed row is evicted from AppState.tasks, and only the
// roster member remains. resolveStoppableTask then falls back to the on-disk
// roster and reports our OWN session as foreign — the "belongs to session
// <leadSessionId>" refusal the roadmap quotes. Step 2 makes the still-present
// `failed` row stoppable; sweeping this evicted ghost is the watchdog's job.
test('an evicted failed pane teammate of this session is still misreported as foreign (Step 3 scope)', async () => {
  writeTeam(
    'test',
    [
      {
        agentId: 'opus-worker@test',
        name: 'opus-worker',
        backendType: 'tmux',
        tmuxPaneId: '%21',
      },
    ],
    undefined,
    getSessionId(),
  )

  let state = { tasks: {} } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }

  const error = await stopTask('opus-worker@test', context).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(StopTaskError)
  const message = (error as StopTaskError).message
  expect(message).toContain(`it belongs to session ${getSessionId()}`)
  expect(message).toContain('%21')
})
