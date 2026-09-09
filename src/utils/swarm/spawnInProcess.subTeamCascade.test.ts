import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createTask, getTasksDir } from '../tasks.js'
import {
  killInProcessTeammate,
  killInProcessTeammateAndCascade,
  spawnInProcessTeammate,
} from './spawnInProcess.js'
import {
  getTeamDir,
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from './teamHelpers.js'

// U7: killing or retiring a sub-lead never leaves an orphan sub-team. These
// pin the cascade itself — the sub-team's members stopped recursively, the
// whole sub-tree's directories (team, task list and worktrees) removed, and
// the parent team file no longer listing the sub-lead — plus the guard that
// keeps a root team squatting the same sanitized directory out of it.

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const DEPUTY = 'deputy'
const SUB_SUB_TEAM = `${SUB_TEAM}/${DEPUTY}`
const DEPUTY_AGENT_ID = `${DEPUTY}@${SUB_TEAM}`
const TEAM_LEAD = 'team-lead'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/spawnInProcess.subTeamCascade.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-cascade-'))
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

type Member = {
  agentId: string
  name: string
  worktreePath?: string
}

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Member[],
  parent?: { parentTeam: string; parentAgentId: string },
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    ...parent,
    members: members.map(m => ({
      agentId: m.agentId,
      name: m.name,
      joinedAt: 0,
      tmuxPaneId: 'in-process',
      cwd: '/repo',
      worktreePath: m.worktreePath,
      subscriptions: [],
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

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

/** Registers a running teammate task in AppState, as a real spawn does. */
async function registerTeammate(
  world: World,
  name: string,
  teamName: string,
): Promise<string> {
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false, prompt: 'work' },
    { setAppState: world.setAppState },
  )
  if (!spawn.success || !spawn.taskId) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  return spawn.taskId
}

function statusOf(world: World, taskId: string): string | undefined {
  const task = world.getState().tasks[taskId] as
    | InProcessTeammateTaskState
    | undefined
  return task?.status
}

function memberNames(teamName: string): string[] {
  return readTeamFile(teamName)?.members.map(m => m.name) ?? []
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function seedTask(taskListId: string): Promise<void> {
  await createTask(taskListId, {
    subject: `work for ${taskListId}`,
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
}

/**
 * The three-level world: `email` leads to `email/supervisor`, whose member
 * `deputy` leads `email/supervisor/deputy` in turn.
 */
function writeThreeLevelWorld(worktreePath?: string): void {
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `worker@${SUB_TEAM}`, name: 'worker' },
      { agentId: DEPUTY_AGENT_ID, name: DEPUTY },
      // Roster-only: no running task, but a worktree that must still go.
      { agentId: `retired@${SUB_TEAM}`, name: 'retired', worktreePath },
    ],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
  writeTeam(
    SUB_SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `helper@${SUB_SUB_TEAM}`, name: 'helper' },
    ],
    { parentTeam: SUB_TEAM, parentAgentId: DEPUTY_AGENT_ID },
  )
}

test('killing a sub-lead stops its sub-team recursively and removes every directory below it', async () => {
  const world = createWorld()
  const worktreePath = join(configDir!, 'worktrees', 'retired')
  mkdirSync(worktreePath, { recursive: true })
  writeThreeLevelWorld(worktreePath)
  await seedTask(SUB_TEAM)
  await seedTask(SUB_SUB_TEAM)

  const subLead = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  const worker = await registerTeammate(world, 'worker', SUB_TEAM)
  const deputy = await registerTeammate(world, DEPUTY, SUB_TEAM)
  const helper = await registerTeammate(world, 'helper', SUB_SUB_TEAM)

  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(true)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)

  expect(
    await killInProcessTeammateAndCascade(subLead, world.setAppState),
  ).toBe(true)

  // Every process in the sub-tree is stopped, the sub-lead included.
  expect(statusOf(world, subLead)).toBe('killed')
  expect(statusOf(world, worker)).toBe('killed')
  expect(statusOf(world, deputy)).toBe('killed')
  expect(statusOf(world, helper)).toBe('killed')

  // Team directories and task lists of both levels, and the roster-only
  // member's worktree, are gone.
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_SUB_TEAM))).toBe(false)
  expect(existsSync(worktreePath)).toBe(false)

  // The parent team survives, without the sub-lead in it.
  expect(existsSync(getTeamDir(PARENT_TEAM))).toBe(true)
  expect(memberNames(PARENT_TEAM)).toEqual([TEAM_LEAD])
})

test('the synchronous kill stops the whole live sub-tree before it returns', async () => {
  const world = createWorld()
  writeThreeLevelWorld()

  const subLead = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  const worker = await registerTeammate(world, 'worker', SUB_TEAM)
  const deputy = await registerTeammate(world, DEPUTY, SUB_TEAM)
  const helper = await registerTeammate(world, 'helper', SUB_SUB_TEAM)

  // No await: the boolean form is what InProcessBackend.kill and the
  // teammate-view kill key call, and neither of them can await the cascade.
  expect(killInProcessTeammate(subLead, world.setAppState)).toBe(true)

  expect(statusOf(world, subLead)).toBe('killed')
  expect(statusOf(world, worker)).toBe('killed')
  expect(statusOf(world, deputy)).toBe('killed')
  expect(statusOf(world, helper)).toBe('killed')
  // The parent team file is written synchronously too.
  expect(memberNames(PARENT_TEAM)).toEqual([TEAM_LEAD])

  // Removing the directories is the asynchronous half; it follows on its own
  // without anyone awaiting it.
  await waitFor(
    () =>
      !existsSync(getTeamDir(SUB_TEAM)) &&
      !existsSync(getTeamDir(SUB_SUB_TEAM)),
    'the sub-team directories to be removed',
  )
})

test('a root team squatting the sub-team directory is never torn down with the teammate', async () => {
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  // `email/supervisor` sanitizes to the same directory as a root team named
  // `email-supervisor`, so only the recorded name and parent tell them apart.
  writeTeam('email-supervisor', [
    { agentId: `${TEAM_LEAD}@email-supervisor`, name: TEAM_LEAD },
    { agentId: 'worker@email-supervisor', name: 'worker' },
  ])
  await seedTask('email-supervisor')

  const subLead = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  const stranger = await registerTeammate(world, 'worker', 'email-supervisor')

  expect(
    await killInProcessTeammateAndCascade(subLead, world.setAppState),
  ).toBe(true)

  expect(statusOf(world, subLead)).toBe('killed')
  expect(statusOf(world, stranger)).toBe('running')
  expect(existsSync(getTeamDir('email-supervisor'))).toBe(true)
  expect(existsSync(getTasksDir('email-supervisor'))).toBe(true)
  expect(memberNames('email-supervisor')).toEqual([TEAM_LEAD, 'worker'])
})

test('a teammate that leads no sub-team is killed alone', async () => {
  const world = createWorld()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: `helper@${PARENT_TEAM}`, name: 'helper' },
    { agentId: `other@${PARENT_TEAM}`, name: 'other' },
  ])

  const helper = await registerTeammate(world, 'helper', PARENT_TEAM)
  const other = await registerTeammate(world, 'other', PARENT_TEAM)

  expect(await killInProcessTeammateAndCascade(helper, world.setAppState)).toBe(
    true,
  )

  expect(statusOf(world, helper)).toBe('killed')
  expect(statusOf(world, other)).toBe('running')
  expect(existsSync(getTeamDir(PARENT_TEAM))).toBe(true)
  expect(memberNames(PARENT_TEAM)).toEqual([TEAM_LEAD, 'other'])
})
