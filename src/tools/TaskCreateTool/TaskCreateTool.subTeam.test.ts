import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  clearRegisteredHooks,
  getRegisteredHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  getTeamFilePath,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { clearLeaderTeamName, getTasksDir, listTasks } from '../../utils/tasks.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { TaskCreateTool } from './TaskCreateTool.js'

// U5: a teammate that leads a sub-team creates work FOR that sub-team.
// getTaskListId() would hand back its PARENT team — where the sub-lead is an
// ordinary member — so its tasks would land in the list its own peers claim
// from and its children would never see them.

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`

const TURN_AGENT_ID = asAgentId('a00000000000beef')
const SUBAGENT_ID = asAgentId('a11111111111cafe')

let configDir: string | undefined
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/TaskCreateTool/TaskCreateTool.subTeam.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-taskcreate-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
})

afterEach(() => {
  try {
    clearRegisteredHooks()
    if (previousRegisteredHooks) {
      registerHookCallbacks(previousRegisteredHooks)
    }
    clearLeaderTeamName()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

/** Writes the sub-team file TeamCreate's sub-team branch leaves behind. */
function writeSubTeam(parentAgentId: string): void {
  const teamFile: TeamFile = {
    name: SUB_TEAM,
    createdAt: 0,
    leadAgentId: `team-lead@${SUB_TEAM}`,
    parentTeam: PARENT_TEAM,
    parentAgentId,
    members: [
      {
        agentId: `team-lead@${SUB_TEAM}`,
        name: 'team-lead',
        joinedAt: 0,
        tmuxPaneId: '',
        cwd: '/repo',
        subscriptions: [],
      },
    ],
  }
  const path = getTeamFilePath(SUB_TEAM)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

function makeContext(agentId: string = TURN_AGENT_ID): ToolUseContext {
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    teamContext: { teamName: PARENT_TEAM },
  } as unknown as AppState
  return {
    agentId,
    getAppState: () => appState,
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext
}

/** Runs `fn` as the in-process teammate `name` of team `team`, mid-turn. */
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

function createTask(
  context: ToolUseContext,
  subject: string,
): Promise<unknown> {
  return TaskCreateTool.call(
    { subject, description: 'the work' },
    context,
  ) as Promise<unknown>
}

test('a sub-lead creates tasks in its sub-team list, not in its parent team list', async () => {
  writeSubTeam(SUB_LEAD_AGENT_ID)

  await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    createTask(makeContext(), 'ship the digest'),
  )

  const subTeamTasks = await listTasks(SUB_TEAM)
  expect(subTeamTasks.map(t => t.subject)).toEqual(['ship the digest'])
  // The parent team's list — where the sub-lead's own peers claim from — is
  // left empty.
  expect(await listTasks(PARENT_TEAM)).toEqual([])
})

test('the sub-team task directory is created on first write', async () => {
  writeSubTeam(SUB_LEAD_AGENT_ID)
  // TeamCreate's sub-team branch skips ensureTasksDir, so nothing exists yet.
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)

  await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    createTask(makeContext(), 'first task'),
  )

  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)
  // `email/supervisor` is flattened by sanitizePathComponent, not nested.
  expect(getTasksDir(SUB_TEAM)).toBe(
    join(configDir!, 'tasks', 'email-supervisor'),
  )
})

test('a teammate that leads no sub-team keeps writing to its own team list', async () => {
  // No sub-team file on disk for `helper`.
  await asTeammate('helper', PARENT_TEAM, () =>
    createTask(makeContext(), 'ordinary work'),
  )

  expect((await listTasks(PARENT_TEAM)).map(t => t.subject)).toEqual([
    'ordinary work',
  ])
  expect(await listTasks(SUB_TEAM)).toEqual([])
})

test('a subagent inside the sub-lead turn writes to the ordinary list', async () => {
  writeSubTeam(SUB_LEAD_AGENT_ID)

  // The ambient identity is the teammate's, but the context carries a
  // different agent id — resolveCallerIdentity calls that a subagent, and a
  // subagent leads no sub-team.
  await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    createTask(makeContext(SUBAGENT_ID), 'subagent work'),
  )

  expect((await listTasks(PARENT_TEAM)).map(t => t.subject)).toEqual([
    'subagent work',
  ])
  expect(await listTasks(SUB_TEAM)).toEqual([])
})

test('a sub-team file recorded against another agent is not this caller sub-team', async () => {
  // Same derived name, different parent: readSubTeamLedBy must reject it.
  writeSubTeam('someone-else@email')

  await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    createTask(makeContext(), 'not mine'),
  )

  expect((await listTasks(PARENT_TEAM)).map(t => t.subject)).toEqual([
    'not mine',
  ])
  expect(await listTasks(SUB_TEAM)).toEqual([])
})
