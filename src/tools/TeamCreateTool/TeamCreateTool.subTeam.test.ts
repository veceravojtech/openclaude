import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import {
  clearLeaderTeamName,
  getTaskListId,
  getTasksDir,
} from '../../utils/tasks.js'
import { TeamCreateTool } from './TeamCreateTool.js'

// U3: TeamCreate called BY a teammate creates the one sub-team that teammate
// may lead, `<its team>/<its name>`. The lead path's "already in a team" guard
// reads AppState, which an in-process teammate shares with the lead — so these
// pin that the branch is keyed on the caller instead, and that it stops at one
// team per agent, at the derived name, and at the depth cap.

const MAX_DEPTH_ENV = 'CLAUDE_CODE_MAX_TEAM_DEPTH'

let configDir: string | undefined
let savedMaxDepth: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TeamCreateTool/TeamCreateTool.subTeam.test.ts',
  )
  savedMaxDepth = process.env[MAX_DEPTH_ENV]
  delete process.env[MAX_DEPTH_ENV]
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-create-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    if (savedMaxDepth === undefined) {
      delete process.env[MAX_DEPTH_ENV]
    } else {
      process.env[MAX_DEPTH_ENV] = savedMaxDepth
    }
    // The lead path sets a process-wide leader team name; keep it out of the
    // next test, and so is the pane-teammate identity one case installs.
    clearLeaderTeamName()
    clearDynamicTeamContext()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

const TURN_AGENT_ID = asAgentId('a00000000000beef')
const SUBAGENT_ID = asAgentId('a11111111111cafe')

function makeContext(options: { agentId?: string; teamName?: string } = {}): {
  context: ToolUseContext
  setAppState: ReturnType<typeof mock>
} {
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    mainLoopModel: 'test-model',
    teamContext: options.teamName ? { teamName: options.teamName } : undefined,
  } as unknown as AppState
  const setAppState = mock(() => {})
  const context = {
    agentId: options.agentId ?? TURN_AGENT_ID,
    getAppState: () => appState,
    setAppState,
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext
  return { context, setAppState }
}

/** Runs `fn` as the teammate `name` of team `team`, mid-turn. */
function asTeammate<T>(
  name: string,
  team: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTeammateContext(
    {
      agentId: `${name}@${team}`,
      agentName: name,
      teamName: team,
      planModeRequired: false,
      parentSessionId: 'parent-session',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: TURN_AGENT_ID,
    },
    fn,
  )
}

function createTeam(
  context: ToolUseContext,
  teamName: string,
): Promise<{ data: { team_name: string; team_file_path: string; lead_agent_id: string } }> {
  return TeamCreateTool.call(
    { team_name: teamName },
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-subteam' } as never,
  ) as Promise<{
    data: { team_name: string; team_file_path: string; lead_agent_id: string }
  }>
}

test('a teammate creates the sub-team it leads, with its parent recorded', async () => {
  const { context, setAppState } = makeContext({ teamName: 'email' })

  const result = await asTeammate('supervisor', 'email', () =>
    createTeam(context, 'email/supervisor'),
  )

  expect(result.data.team_name).toBe('email/supervisor')
  expect(result.data.lead_agent_id).toBe('team-lead@email/supervisor')
  expect(result.data.team_file_path).toBe(
    join(configDir!, 'teams', 'email-supervisor', 'config.json'),
  )

  const teamFile = await readTeamFileAsync('email/supervisor')
  expect(teamFile?.name).toBe('email/supervisor')
  expect(teamFile?.parentTeam).toBe('email')
  expect(teamFile?.parentAgentId).toBe('supervisor@email')
  expect(teamFile?.leadAgentId).toBe('team-lead@email/supervisor')
  expect(teamFile?.members.map(m => m.name)).toEqual(['team-lead'])

  // The lead-only side effects stay lead-only: the root AppState is not
  // repointed at the sub-team, and neither is the process-wide task list.
  expect(setAppState).not.toHaveBeenCalled()
  expect(getTaskListId()).not.toBe('email-supervisor')
})

test('a second create by the same teammate errors instead of renaming', async () => {
  const { context } = makeContext({ teamName: 'email' })

  await asTeammate('supervisor', 'email', () =>
    createTeam(context, 'email/supervisor'),
  )

  await expect(
    asTeammate('supervisor', 'email', () =>
      createTeam(context, 'email/supervisor'),
    ),
  ).rejects.toThrow('Already leading team "email/supervisor"')
})

test('a teammate cannot create a team under any other name', async () => {
  const { context } = makeContext({ teamName: 'email' })

  await expect(
    asTeammate('supervisor', 'email', () => createTeam(context, 'strike-team')),
  ).rejects.toThrow(
    'A teammate can only create its own sub-team "email/supervisor", not "strike-team"',
  )
  await expect(
    asTeammate('supervisor', 'email', () =>
      createTeam(context, 'email/other-name'),
    ),
  ).rejects.toThrow('can only create its own sub-team "email/supervisor"')

  expect(await readTeamFileAsync('strike-team')).toBeNull()
  expect(await readTeamFileAsync('email/other-name')).toBeNull()
})

test('a lead cannot name a root team like a sub-team, but its teammate still can', async () => {
  const lead = makeContext()

  await expect(createTeam(lead.context, 'email/supervisor')).rejects.toThrow(
    'a "/" in a team name marks a sub-team',
  )
  // The same hole let a lead name a root team at any depth, since only the
  // teammate branch applies the cap.
  await expect(createTeam(lead.context, 'a/b/c/d/e')).rejects.toThrow(
    'Cannot create team "a/b/c/d/e"',
  )
  expect(await readTeamFileAsync('email/supervisor')).toBeNull()
  expect(await readTeamFileAsync('a/b/c/d/e')).toBeNull()
  expect(lead.setAppState).not.toHaveBeenCalled()

  // The rejection lives on the lead branch alone: the teammate that leads
  // `email/supervisor` still creates it under exactly that name.
  const result = await asTeammate('supervisor', 'email', () =>
    createTeam(makeContext({ teamName: 'email' }).context, 'email/supervisor'),
  )
  expect(result.data.team_name).toBe('email/supervisor')
  expect((await readTeamFileAsync('email/supervisor'))?.parentAgentId).toBe(
    'supervisor@email',
  )
})

test('a subagent inside a teammate turn does not get the sub-team branch', async () => {
  const { context } = makeContext({ agentId: SUBAGENT_ID, teamName: 'email' })

  // Falls through to the lead path, which rejects because AppState already
  // has a team — the point is that no sub-team is created for the spawner.
  await expect(
    asTeammate('supervisor', 'email', () =>
      createTeam(context, 'email/supervisor'),
    ),
  ).rejects.toThrow('Already leading team "email"')
  expect(await readTeamFileAsync('email/supervisor')).toBeNull()
})

test('the depth cap stops the fourth level and names the env var', async () => {
  const { context } = makeContext({ teamName: 'a/b/c' })

  await expect(
    asTeammate('d', 'a/b/c', () => createTeam(context, 'a/b/c/d')),
  ).rejects.toThrow(
    'Team "a/b/c/d" would be 4 levels deep, past the limit of 3 (CLAUDE_CODE_MAX_TEAM_DEPTH)',
  )
  expect(await readTeamFileAsync('a/b/c/d')).toBeNull()
})

test('CLAUDE_CODE_MAX_TEAM_DEPTH raises and lowers the cap', async () => {
  process.env[MAX_DEPTH_ENV] = '4'
  const deep = makeContext({ teamName: 'a/b/c' })
  const raised = await asTeammate('d', 'a/b/c', () =>
    createTeam(deep.context, 'a/b/c/d'),
  )
  expect(raised.data.team_name).toBe('a/b/c/d')
  expect((await readTeamFileAsync('a/b/c/d'))?.parentTeam).toBe('a/b/c')

  process.env[MAX_DEPTH_ENV] = '1'
  const shallow = makeContext({ teamName: 'email' })
  await expect(
    asTeammate('supervisor', 'email', () =>
      createTeam(shallow.context, 'email/supervisor'),
    ),
  ).rejects.toThrow('past the limit of 1 (CLAUDE_CODE_MAX_TEAM_DEPTH)')
})

test('a root team occupying the sub-team directory is reported, not overwritten', async () => {
  const { context } = makeContext()
  // The lead's own team, named so that sanitizeName collides with
  // `email/supervisor`.
  await createTeam(context, 'email-supervisor')

  await expect(
    asTeammate('supervisor', 'email', () =>
      createTeam(makeContext({ teamName: 'email' }).context, 'email/supervisor'),
    ),
  ).rejects.toThrow(
    'team "email-supervisor" already occupies its directory ("email-supervisor")',
  )
  expect((await readTeamFileAsync('email-supervisor'))?.name).toBe(
    'email-supervisor',
  )
})

test('a teammate creating its sub-team leaves the task list alone', async () => {
  const { context } = makeContext({ teamName: 'email' })

  // The lead path runs resetTaskList + ensureTasksDir for the new team, and
  // resetTaskList DELETES every task file in that list. Seed the directory the
  // sub-team would resolve to, to pin that the teammate branch returns before
  // either call rather than merely being argued to.
  const seededDir = getTasksDir('email/supervisor')
  mkdirSync(seededDir, { recursive: true })
  const seededTask = join(seededDir, 'task-1.json')
  writeFileSync(seededTask, JSON.stringify({ id: 'task-1', status: 'open' }))

  await asTeammate('supervisor', 'email', () =>
    createTeam(context, 'email/supervisor'),
  )

  expect(existsSync(seededTask)).toBe(true)
  expect(JSON.parse(readFileSync(seededTask, 'utf8')).id).toBe('task-1')

  // And ensureTasksDir is skipped too: a sub-team whose task directory did not
  // exist does not get one.
  await asTeammate('ops', 'email', () =>
    createTeam(makeContext({ teamName: 'email' }).context, 'email/ops'),
  )
  expect(existsSync(getTasksDir('email/ops'))).toBe(false)
})

test('a pane teammate is refused a sub-team, and leaves no team file behind', async () => {
  // A pane/tmux teammate gets its identity from dynamicTeamContext rather than
  // from AsyncLocalStorage, and its own turns run on its process's main thread
  // — so the tool context carries no agent id. resolveCallerIdentity therefore
  // calls it a teammate and it reaches the sub-team branch, but there is no
  // in-process runner behind it to poll the sub-team's inbox or hand out its
  // task list.
  setDynamicTeamContext({
    agentId: 'supervisor@email',
    agentName: 'supervisor',
    teamName: 'email',
    planModeRequired: false,
  })
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    mainLoopModel: 'test-model',
    teamContext: { teamName: 'email' },
  } as unknown as AppState
  const paneContext = {
    agentId: undefined,
    getAppState: () => appState,
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext

  await expect(createTeam(paneContext, 'email/supervisor')).rejects.toThrow(
    'Only an in-process teammate can lead a sub-team',
  )
  expect(await readTeamFileAsync('email/supervisor')).toBeNull()

  // The same teammate running in-process is still allowed.
  clearDynamicTeamContext()
  const inProcess = await asTeammate('supervisor', 'email', () =>
    createTeam(makeContext({ teamName: 'email' }).context, 'email/supervisor'),
  )
  expect(inProcess.data.team_name).toBe('email/supervisor')
})
