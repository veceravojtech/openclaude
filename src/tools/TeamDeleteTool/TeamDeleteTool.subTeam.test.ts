import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
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
import type { ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { spawnInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'
import {
  getTeamDir,
  getTeamFilePath,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import {
  clearLeaderTeamName,
  createTask,
  getTasksDir,
} from '../../utils/tasks.js'
import { TeamDeleteTool } from './TeamDeleteTool.js'

// U7: disbanding a team disbands the sub-teams below it. A sub-team is created
// and led by a TEAMMATE, so none of its members appears in this team's roster
// — the active-member guard never sees them, and nothing else would ever
// remove their directories once their lead's team is gone.

const TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${TEAM}`
const DEPUTY = 'deputy'
const SUB_SUB_TEAM = `${SUB_TEAM}/${DEPUTY}`
const DEPUTY_AGENT_ID = `${DEPUTY}@${SUB_TEAM}`
const TEAM_LEAD = 'team-lead'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TeamDeleteTool/TeamDeleteTool.subTeam.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-delete-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    // TeamDelete clears the process-wide leader team name; keep the next test
    // from inheriting whatever this one left behind.
    clearLeaderTeamName()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

type Member = {
  agentId: string
  name: string
  isActive?: boolean
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
      isActive: m.isActive,
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
  context: ToolUseContext
}

function createWorld(teamName: string | undefined): World {
  let state: AppState = {
    ...getDefaultAppState(),
    teamContext: teamName
      ? ({ teamName } as AppState['teamContext'])
      : undefined,
  }
  const world = {
    getState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
  }
  return {
    ...world,
    context: {
      getAppState: world.getState,
      setAppState: world.setAppState,
      abortController: new AbortController(),
      messages: [],
      options: { mainLoopModel: 'test-model' },
    } as unknown as ToolUseContext,
  }
}

function deleteTeam(
  context: ToolUseContext,
): Promise<{ data: { success: boolean; message: string } }> {
  return TeamDeleteTool.call(
    {},
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-team-delete' } as never,
  ) as Promise<{ data: { success: boolean; message: string } }>
}

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

/** `email` → `email/supervisor` → `email/supervisor/deputy`. */
function writeThreeLevelWorld(options: { subLeadActive?: boolean } = {}): void {
  writeTeam(TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    {
      agentId: SUB_LEAD_AGENT_ID,
      name: SUB_LEAD,
      isActive: options.subLeadActive ?? false,
    },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `worker@${SUB_TEAM}`, name: 'worker' },
      { agentId: DEPUTY_AGENT_ID, name: DEPUTY },
    ],
    { parentTeam: TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
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

test('deleting a team deletes its sub-teams, and theirs, leaving no orphan directory', async () => {
  const world = createWorld(TEAM)
  writeThreeLevelWorld()
  await seedTask(SUB_TEAM)
  await seedTask(SUB_SUB_TEAM)

  const worker = await registerTeammate(world, 'worker', SUB_TEAM)
  const helper = await registerTeammate(world, 'helper', SUB_SUB_TEAM)

  const result = await deleteTeam(world.context)
  expect(result.data.success).toBe(true)

  expect(existsSync(getTeamDir(TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_SUB_TEAM))).toBe(false)

  // Their members are stopped too: their inbox and task list have just been
  // deleted out from under them.
  expect(statusOf(world, worker)).toBe('killed')
  expect(statusOf(world, helper)).toBe('killed')
})

test('a sub-team member worktree goes with the sub-team', async () => {
  const world = createWorld(TEAM)
  const worktreePath = join(configDir!, 'worktrees', 'worker')
  mkdirSync(worktreePath, { recursive: true })
  writeTeam(TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD, isActive: false },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD}@${SUB_TEAM}`, name: TEAM_LEAD },
      { agentId: `worker@${SUB_TEAM}`, name: 'worker', worktreePath },
    ],
    { parentTeam: TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )

  expect((await deleteTeam(world.context)).data.success).toBe(true)
  expect(existsSync(worktreePath)).toBe(false)
})

test('an unrelated team and its sub-team are left alone', async () => {
  const world = createWorld(TEAM)
  writeThreeLevelWorld()
  writeTeam('other', [{ agentId: 'other-lead', name: TEAM_LEAD }])
  writeTeam(
    'other/manager',
    [{ agentId: `${TEAM_LEAD}@other/manager`, name: TEAM_LEAD }],
    { parentTeam: 'other', parentAgentId: `manager@other` },
  )
  await seedTask('other/manager')

  const outsider = await registerTeammate(world, 'worker', 'other/manager')

  expect((await deleteTeam(world.context)).data.success).toBe(true)

  expect(existsSync(getTeamDir('other'))).toBe(true)
  expect(existsSync(getTeamDir('other/manager'))).toBe(true)
  expect(existsSync(getTasksDir('other/manager'))).toBe(true)
  expect(statusOf(world, outsider)).toBe('running')
})

test('an active member still refuses the delete, sub-teams included', async () => {
  const world = createWorld(TEAM)
  writeThreeLevelWorld({ subLeadActive: true })
  await seedTask(SUB_TEAM)

  const worker = await registerTeammate(world, 'worker', SUB_TEAM)

  const result = await deleteTeam(world.context)
  expect(result.data.success).toBe(false)
  expect(result.data.message).toContain(SUB_LEAD)

  expect(existsSync(getTeamDir(TEAM))).toBe(true)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(true)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)
  expect(statusOf(world, worker)).toBe('running')
})
