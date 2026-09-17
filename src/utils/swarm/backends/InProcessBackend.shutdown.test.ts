import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../envUtils.js'
import { isShutdownRequest, readMailbox } from '../../teammateMailbox.js'
import { killInProcessTeammateAndCascade } from '../spawnInProcess.js'
import { InProcessBackend } from './InProcessBackend.js'

const TEAM = 'alpha'
const AGENT_NAME = 'idler'
const AGENT_ID = `${AGENT_NAME}@${TEAM}`
const TASK_ID = 't-idle'

/** Short enough that the deadline expires inside one test tick. */
const DEADLINE_MS = 20
const POLL_MS = 2

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/backends/InProcessBackend.shutdown.test.ts',
  )
  // Mailbox writes and the force kill's team-file cleanup stay out of the real
  // home.
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-terminate-'))
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

function runningTeammate(
  abortController: AbortController,
): InProcessTeammateTaskState {
  return {
    id: TASK_ID,
    type: 'in_process_teammate',
    status: 'running',
    description: `${AGENT_NAME}: idle (waiting for work)`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      teamName: TEAM,
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
  backend: InProcessBackend
  abortController: AbortController
  task: () => InProcessTeammateTaskState | undefined
}

/**
 * A lead whose AppState holds one running in-process teammate that never
 * cooperates: nothing in these tests answers the shutdown request, which is
 * exactly the case the model is free to produce by ignoring the prompt.
 */
function uncooperativeTeammate(): World {
  const abortController = new AbortController()
  let state = {
    tasks: { [TASK_ID]: runningTeammate(abortController) },
    teamContext: {
      teamName: TEAM,
      teamFilePath: '',
      leadAgentId: 'lead-id',
      teammates: { [AGENT_ID]: { name: AGENT_NAME } },
    },
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  } as unknown as ToolUseContext

  const backend = new InProcessBackend()
  backend.setContext(context)
  return {
    backend,
    abortController,
    task: () => state.tasks[TASK_ID] as InProcessTeammateTaskState | undefined,
  }
}

/** The shutdown requests actually delivered to the teammate's inbox. */
async function deliveredShutdownRequests(): Promise<number> {
  const inbox = await readMailbox(AGENT_NAME, TEAM)
  return inbox.filter(message => isShutdownRequest(message.text)).length
}

test('terminate() reports `requested`, not success, when nothing terminated', async () => {
  // The lie this replaces: terminate() wrote the mailbox file, set the flag and
  // returned `true` — a caller could not tell "the teammate is gone" from "a
  // note was left for a model that may ignore it".
  const world = uncooperativeTeammate()
  let forceKills = 0

  const outcome = await world.backend.terminate(AGENT_ID, 'wrap up', {
    deadlineMs: DEADLINE_MS,
    pollIntervalMs: POLL_MS,
    // A force kill that does not manage to stop it: the outcome must still be
    // the honest one rather than a fabricated success.
    forceKill: async () => {
      forceKills++
      return false
    },
  })

  expect(outcome).toBe('requested')
  expect(forceKills).toBe(1)
  expect(await deliveredShutdownRequests()).toBe(1)
  expect(world.task()?.status).toBe('running')
  expect(world.abortController.signal.aborted).toBe(false)
})

test('a teammate that ignored one shutdown request can be asked again', async () => {
  // The sticky rejection: shutdownRequested was never cleared, and terminate()
  // short-circuited on it with `true` forever after — one declined request made
  // a teammate permanently unstoppable through this path, and lied about it.
  const world = uncooperativeTeammate()
  const noForceKill = async (): Promise<boolean> => false

  const first = await world.backend.terminate(AGENT_ID, 'first ask', {
    deadlineMs: DEADLINE_MS,
    pollIntervalMs: POLL_MS,
    forceKill: noForceKill,
  })
  const flagAfterFirst = world.task()?.shutdownRequested

  // Second ask, with the flag still set by the first one.
  const second = await world.backend.terminate(AGENT_ID, 'second ask', {
    deadlineMs: DEADLINE_MS,
    pollIntervalMs: POLL_MS,
    forceKill: noForceKill,
  })

  // (i) genuinely re-asked rather than short-circuited on the flag...
  expect(await deliveredShutdownRequests()).toBe(2)
  // ...and (ii) neither caller is told it worked.
  expect([first, second]).toEqual(['requested', 'requested'])
  expect(flagAfterFirst).toBe(true)
  expect(world.task()?.status).toBe('running')
})

test('terminate() escalates to a force kill when the deadline expires', async () => {
  const world = uncooperativeTeammate()
  const forceKilled: string[] = []

  const outcome = await world.backend.terminate(AGENT_ID, 'no more time', {
    deadlineMs: DEADLINE_MS,
    pollIntervalMs: POLL_MS,
    forceKill: async (taskId, setAppState) => {
      forceKilled.push(taskId)
      return killInProcessTeammateAndCascade(taskId, setAppState)
    },
  })

  expect(forceKilled).toEqual([TASK_ID])
  // Reported termination is the observed one: aborted, terminal, off the roster.
  expect(outcome).toBe('terminated')
  expect(world.abortController.signal.aborted).toBe(true)
  expect(world.task()?.status).toBe('killed')
  expect(await world.backend.isActive(AGENT_ID)).toBe(false)
})

test('terminate() reports `not_found` for a teammate it cannot address', async () => {
  const world = uncooperativeTeammate()

  expect(await world.backend.terminate(`ghost@${TEAM}`)).toBe('not_found')
  expect(await deliveredShutdownRequests()).toBe(0)

  const contextless = new InProcessBackend()
  expect(await contextless.terminate(AGENT_ID)).toBe('not_found')
})

test('terminate() on an already-stopped teammate reports it terminated, and asks nothing', async () => {
  const world = uncooperativeTeammate()
  world.abortController.abort()

  expect(
    await world.backend.terminate(AGENT_ID, 'already gone', {
      deadlineMs: DEADLINE_MS,
      pollIntervalMs: POLL_MS,
      forceKill: async () => {
        throw new Error('must not escalate against a stopped teammate')
      },
    }),
  ).toBe('terminated')
  expect(await deliveredShutdownRequests()).toBe(0)
  expect(world.task()?.shutdownRequested).toBe(false)
})
