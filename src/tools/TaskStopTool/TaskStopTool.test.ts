import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  getTeamFilePath,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { TaskStopTool } from './TaskStopTool.js'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/TaskStopTool/TaskStopTool.test.ts')
  // The kill path cleans up team files, and the resolver reads them: keep both
  // away from the real home.
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-taskstop-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function teammateTask(
  taskId: string,
  name: string,
  teamName: string,
  abortController = new AbortController(),
): InProcessTeammateTaskState {
  return {
    id: taskId,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: idle (waiting for work)`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@${teamName}`,
      agentName: name,
      teamName,
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

type World = {
  context: ToolUseContext
  state: () => AppState
}

function world(tasks: InProcessTeammateTaskState[]): World {
  let state = {
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
    teamContext: {
      teamName: tasks[0]?.identity.teamName ?? 'alpha',
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: Object.fromEntries(
        tasks.map(t => [t.identity.agentId, { name: t.identity.agentName }]),
      ),
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  } as unknown as ToolUseContext
  return { context, state: () => state }
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  leadSessionId: string | undefined,
  members: Array<{
    name: string
    backendType?: TeamFile['members'][number]['backendType']
    tmuxPaneId?: string
  }>,
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId,
    members: members.map(m => ({
      agentId: `${m.name}@${teamName}`,
      name: m.name,
      joinedAt: 0,
      tmuxPaneId: m.tmuxPaneId ?? 'in-process',
      cwd: '/repo',
      subscriptions: [],
      backendType: m.backendType,
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

function validate(
  id: string,
  context: ToolUseContext,
): ReturnType<NonNullable<typeof TaskStopTool.validateInput>> {
  return TaskStopTool.validateInput({ task_id: id }, context)
}

test('TaskStop accepts the name@team form ListAgents advertises', async () => {
  // The bug: teammates are registered under a generated task id, never under
  // `name@team` — so the id the agent is handed by ListAgents was rejected by
  // the one tool meant to act on it.
  const abortController = new AbortController()
  const task = teammateTask('t-idle', 'idler', 'alpha', abortController)
  const { context, state } = world([task])

  expect(await validate('idler@alpha', context)).toEqual({ result: true })

  const result = await TaskStopTool.call({ task_id: 'idler@alpha' }, context)
  // The REAL task id comes back, not the address that was typed.
  expect(result.data.task_id).toBe('t-idle')
  expect(result.data.task_type).toBe('in_process_teammate')
  expect(
    (state().tasks['t-idle'] as InProcessTeammateTaskState | undefined)?.status,
  ).toBe('killed')
  expect(abortController.signal.aborted).toBe(true)
})

test('a plain task id still stops the task it always did', async () => {
  // Regression guard: resolving `name@team` must not cost the generated-id path.
  const abortController = new AbortController()
  const task = teammateTask('t-idle', 'idler', 'alpha', abortController)
  const { context, state } = world([task])

  expect(await validate('t-idle', context)).toEqual({ result: true })

  const result = await TaskStopTool.call({ task_id: 't-idle' }, context)
  expect(result.data.task_id).toBe('t-idle')
  expect(
    (state().tasks['t-idle'] as InProcessTeammateTaskState | undefined)?.status,
  ).toBe('killed')
  expect(abortController.signal.aborted).toBe(true)
})

test('a bare name carried by two teams is reported as ambiguous, not silently picked', async () => {
  const { context, state } = world([
    teammateTask('t-one', 'codex-a', 'team-one'),
    teammateTask('t-two', 'codex-a', 'team-two'),
  ])

  const validation = await validate('codex-a', context)
  expect(validation.result).toBe(false)
  const message = validation.result ? '' : validation.message
  expect(message).toContain('ambiguous')
  expect(message).toContain('codex-a@team-one')
  expect(message).toContain('codex-a@team-two')

  // Neither teammate was stopped by the ambiguous ask.
  expect(state().tasks['t-one']?.status).toBe('running')
  expect(state().tasks['t-two']?.status).toBe('running')
})

test('an unknown name is a not-found that names what IS stoppable', async () => {
  const { context } = world([teammateTask('t-idle', 'idler', 'alpha')])

  const validation = await validate('ghost', context)
  expect(validation.result).toBe(false)
  const message = validation.result ? '' : validation.message
  expect(message).toContain('No task found with ID: ghost')
  // The old message stopped here and left the caller guessing.
  expect(message).toContain('idler@alpha')
  expect(message).toContain('t-idle')
})

test('a teammate owned by another session says so, instead of "No task found"', async () => {
  // AppState.tasks is per-process and never persisted, so a teammate spawned by
  // a different session has no row here in ANY id format. Reporting that as a
  // bad id sent the user round in circles re-typing the address.
  writeTeam('codex-probe', 'be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60', [
    { name: 'codex-a', backendType: 'tmux', tmuxPaneId: '%42' },
  ])
  const { context } = world([teammateTask('t-idle', 'idler', 'alpha')])

  const validation = await validate('codex-a@codex-probe', context)
  expect(validation.result).toBe(false)
  const message = validation.result ? '' : validation.message
  expect(message).not.toContain('No task found with ID')
  expect(message).toContain('codex-a@codex-probe is not a task in this session')
  expect(message).toContain('be73e248-0f3c-4a1e-9b5c-7d2f1a8c4e60')
  expect(message).toContain('cannot be stopped from here')
  // It runs in a tmux pane, so there IS somewhere to go.
  expect(message).toContain('%42')

  // The call path tells the same story rather than the old one.
  await expect(
    TaskStopTool.call({ task_id: 'codex-a@codex-probe' }, context),
  ).rejects.toThrow('is not a task in this session')
})

test('a bare name owned by another session is qualified in the answer', async () => {
  writeTeam('codex-probe', undefined, [{ name: 'codex-a' }])
  const { context } = world([])

  const validation = await validate('codex-a', context)
  expect(validation.result).toBe(false)
  const message = validation.result ? '' : validation.message
  expect(message).toContain('codex-a@codex-probe')
  expect(message).toContain('another session')
})
