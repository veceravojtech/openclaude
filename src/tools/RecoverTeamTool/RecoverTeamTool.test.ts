import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { noteSubLeadFailure } from '../../utils/swarm/subTeamRecovery.js'
import {
  getTeamFilePath,
  readTeamFile,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { clearDynamicTeamContext } from '../../utils/teammate.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { readMailbox } from '../../utils/teammateMailbox.js'

// U9: RecoverTeam is how a lead acts on the orphan notification — list what is
// unled, then adopt its members or respawn its lead. These pin the authority
// rule (you recover sub-teams of the team YOU lead, answered only through
// resolveCallerIdentity), the refusal to take a healthy sub-team away from a
// running lead, and both actions' effect.

type RespawnModule = typeof import('../../utils/swarm/respawnSubLead.js')
type ToolModule = typeof import('./RecoverTeamTool.js')

let actualRespawn: RespawnModule | undefined

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const ROOT_LEAD_AGENT_ID = `${TEAM_LEAD_NAME}@${PARENT_TEAM}`
const WORKER = 'worker'
const TURN_AGENT_ID = asAgentId('a00000000000beef')

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/RecoverTeamTool/RecoverTeamTool.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-recover-team-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.restore()
    if (actualRespawn) {
      mock.module('../../utils/swarm/respawnSubLead.js', () => actualRespawn!)
    }
    clearDynamicTeamContext()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

type RespawnArgs = Parameters<RespawnModule['respawnSubLead']>[0]

type Harness = {
  tool: ToolModule
  respawnCalls: RespawnArgs[]
}

/**
 * Imports the tool with the respawn mocked: a real respawn starts a runner,
 * which `respawnSubLead.test.ts` covers directly. Here only the wiring and the
 * reported outcome are under test.
 */
async function importToolWithMocks(
  respawnResult?: Awaited<ReturnType<RespawnModule['respawnSubLead']>>,
): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualRespawn ??= await import(
    `../../utils/swarm/respawnSubLead.ts?recoverToolActual=${stamp}`
  )
  const respawnCalls: RespawnArgs[] = []
  mock.module('../../utils/swarm/respawnSubLead.js', () => ({
    ...actualRespawn!,
    respawnSubLead: async (args: RespawnArgs) => {
      respawnCalls.push(args)
      return (
        respawnResult ?? {
          ok: true as const,
          subTeamName: args.subTeamName,
          leadAgentId: SUB_LEAD_AGENT_ID,
          taskId: 'task-1',
          resumedFromTranscript: true,
          resumedMessageCount: 3,
          reattach: {
            ok: true as const,
            subTeamName: args.subTeamName,
            previousLeadAgentId: SUB_LEAD_AGENT_ID,
            newLeadAgentId: SUB_LEAD_AGENT_ID,
            isNaturalLead: true,
            clearedOrphanRecord: true,
          },
        }
      )
    },
  }))
  const tool: ToolModule = await import(`./RecoverTeamTool.ts?recover=${stamp}`)
  return { tool, respawnCalls }
}

function writeTeam(
  teamName: string,
  members: Array<{ agentId: string; name: string }>,
  extra?: Partial<TeamFile>,
): void {
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: members[0]?.agentId ?? 'lead-id',
    ...extra,
    members: members.map(m => ({
      agentId: m.agentId,
      name: m.name,
      joinedAt: 0,
      tmuxPaneId: 'in-process',
      cwd: '/repo',
      subscriptions: [],
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

function writeSubTeamWorld(): void {
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME },
      { agentId: `${WORKER}@${SUB_TEAM}`, name: WORKER },
    ],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
}

/** A running in-process teammate task, as the spinner tree and the caps see it. */
function runningTask(
  taskId: string,
  agentName: string,
  teamName: string,
): [string, unknown] {
  return [
    taskId,
    {
      id: taskId,
      type: 'in_process_teammate',
      status: 'running',
      isIdle: false,
      identity: {
        agentId: `${agentName}@${teamName}`,
        agentName,
        teamName,
        planModeRequired: false,
        parentSessionId: 'parent-session',
      },
    },
  ]
}

function makeContext(
  options: { teamName?: string; tasks?: Array<[string, unknown]> } = {},
): ToolUseContext {
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    mainLoopModel: 'test-model',
    tasks: Object.fromEntries(options.tasks ?? []),
    teamContext: options.teamName ? { teamName: options.teamName } : undefined,
  } as unknown as AppState
  return {
    agentId: TURN_AGENT_ID,
    getAppState: () => appState,
    setAppState: mock(() => {}),
    abortController: new AbortController(),
    messages: [],
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext
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

type ToolInput = Parameters<NonNullable<ToolModule['RecoverTeamTool']['call']>>[0]
type ToolOutput = { data: import('./RecoverTeamTool.js').Output }

/** The tool's own call surface, with the permission arguments a lead supplies. */
function callTool(
  harness: Harness,
  input: ToolInput,
  context: ToolUseContext,
): Promise<ToolOutput> {
  return harness.tool.RecoverTeamTool.call(
    input,
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-recover' } as never,
  ) as Promise<ToolOutput>
}

async function recordFailure(): Promise<void> {
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    reason: 'boom',
    tasks: {},
  })
}

test('list reports every sub-team below the lead own team, with its state', async () => {
  writeSubTeamWorld()
  await recordFailure()
  const harness = await importToolWithMocks()

  const result = await callTool(
    harness,
    { action: 'list' },
    makeContext({
      teamName: PARENT_TEAM,
      tasks: [runningTask('t-worker', WORKER, SUB_TEAM)],
    }),
  )
  expect(result.data.own_team).toBe(PARENT_TEAM)
  expect(result.data.sub_teams).toEqual([
    {
      team_name: SUB_TEAM,
      state: 'orphaned',
      lead_agent_id: SUB_LEAD_AGENT_ID,
      has_live_lead: false,
      live_members: [WORKER],
      failure_reason: 'boom',
    },
  ])
  expect(result.data.message).toContain('1 orphaned')
  // Read-only, so it never needs a permission decision of its own.
  expect(harness.tool.RecoverTeamTool.isReadOnly({ action: 'list' })).toBe(true)
  expect(
    harness.tool.RecoverTeamTool.isReadOnly({
      action: 'adopt',
      team_name: SUB_TEAM,
    }),
  ).toBe(false)
})

test('adopt re-points the sub-team to the lead and tells its members', async () => {
  writeSubTeamWorld()
  await recordFailure()
  const harness = await importToolWithMocks()

  const result = await callTool(
    harness,
    { action: 'adopt', team_name: SUB_TEAM },
    makeContext({
      teamName: PARENT_TEAM,
      tasks: [runningTask('t-worker', WORKER, SUB_TEAM)],
    }),
  )
  expect(result.data).toMatchObject({
    action: 'adopt',
    team_name: SUB_TEAM,
    state: 'adopted',
    lead_agent_id: ROOT_LEAD_AGENT_ID,
    notified_members: [WORKER],
  })

  const teamFile = readTeamFile(SUB_TEAM)
  expect(teamFile?.parentAgentId).toBe(ROOT_LEAD_AGENT_ID)
  // The record is kept — an adopted sub-team has a caretaker, not a lead — and
  // parentTeam never moves, so the teardown scan still owns the sub-team.
  expect(teamFile?.orphanedLead?.agentId).toBe(SUB_LEAD_AGENT_ID)
  expect(teamFile?.parentTeam).toBe(PARENT_TEAM)
  expect((await readMailbox(WORKER, SUB_TEAM))[0]!.text).toContain(
    ROOT_LEAD_AGENT_ID,
  )
})

test('respawn hands the sub-team to the resume path and reports what it resumed', async () => {
  writeSubTeamWorld()
  await recordFailure()
  const harness = await importToolWithMocks()

  const context = makeContext({ teamName: PARENT_TEAM })
  const result = await callTool(
    harness,
    { action: 'respawn', team_name: SUB_TEAM, prompt: 'carry on' },
    context,
  )
  expect(harness.respawnCalls).toHaveLength(1)
  expect(harness.respawnCalls[0]).toMatchObject({
    subTeamName: SUB_TEAM,
    prompt: 'carry on',
  })
  expect(harness.respawnCalls[0]!.toolUseContext).toBe(context)
  expect(result.data).toMatchObject({
    action: 'respawn',
    team_name: SUB_TEAM,
    state: 'led',
    lead_agent_id: SUB_LEAD_AGENT_ID,
    resumed_from_transcript: true,
    resumed_message_count: 3,
  })
  expect(result.data.message).toContain('re-attached')
})

test('a respawn whose re-attach failed reports the sub-team as still respawning', async () => {
  writeSubTeamWorld()
  await recordFailure()
  const harness = await importToolWithMocks({
    ok: true,
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    taskId: 'task-1',
    resumedFromTranscript: false,
    resumedMessageCount: 0,
    reattach: {
      ok: false,
      subTeamName: SUB_TEAM,
      reason: 'directory-collision',
    },
  })

  const result = await callTool(
    harness,
    { action: 'respawn', team_name: SUB_TEAM },
    makeContext({ teamName: PARENT_TEAM }),
  )
  expect(result.data.state).toBe('respawning')
  expect(result.data.message).toContain('directory-collision')
  expect(result.data.message).toContain('starts cold')
})

test('a lead may only recover a sub-team of its own team', async () => {
  writeSubTeamWorld()
  await recordFailure()
  const harness = await importToolWithMocks()

  // A root team is nobody's sub-team.
  await expect(
    callTool(
      harness,
      { action: 'adopt', team_name: PARENT_TEAM },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  ).rejects.toThrow(`"${PARENT_TEAM}" is not a sub-team of "${PARENT_TEAM}"`)

  // Neither is a sub-team of somebody else's team.
  await expect(
    callTool(
      harness,
      { action: 'respawn', team_name: 'other/supervisor' },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  ).rejects.toThrow('is not a sub-team of')
  expect(harness.respawnCalls).toEqual([])
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
})

test('an agent that leads no team is refused, and adopt without a team_name is too', async () => {
  writeSubTeamWorld()
  const harness = await importToolWithMocks()

  await expect(
    callTool(harness, { action: 'list' }, makeContext({})),
  ).rejects.toThrow('you lead none')

  await expect(
    callTool(
      harness,
      { action: 'adopt' },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  ).rejects.toThrow('team_name is required')
})

test('a sub-team whose lead is still running is not recoverable', async () => {
  writeSubTeamWorld()
  const harness = await importToolWithMocks()

  await expect(
    callTool(
      harness,
      { action: 'adopt', team_name: SUB_TEAM },
      makeContext({
        teamName: PARENT_TEAM,
        tasks: [runningTask('t-lead', SUB_LEAD, PARENT_TEAM)],
      }),
    ),
  ).rejects.toThrow('still led by')

  // A sub-team on no disk at all is refused with the reason, not a crash.
  await expect(
    callTool(
      harness,
      { action: 'adopt', team_name: `${PARENT_TEAM}/nobody` },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  ).rejects.toThrow('was found on disk')
})

test('a sub-lead recovers the sub-teams of the sub-team IT leads', async () => {
  // Three levels: the root lead of `email`, its teammate `supervisor` leading
  // `email/supervisor`, and `deputy` leading `email/supervisor/deputy`.
  writeSubTeamWorld()
  const subSubTeam = `${SUB_TEAM}/deputy`
  writeTeam(
    subSubTeam,
    [{ agentId: `${TEAM_LEAD_NAME}@${subSubTeam}`, name: TEAM_LEAD_NAME }],
    { parentTeam: SUB_TEAM, parentAgentId: `deputy@${SUB_TEAM}` },
  )
  await noteSubLeadFailure({
    identity: {
      agentId: `deputy@${SUB_TEAM}`,
      agentName: 'deputy',
      teamName: SUB_TEAM,
    },
    reason: 'deputy crashed',
    tasks: {},
  })
  const harness = await importToolWithMocks()

  // The root lead sees the deeper sub-team in its listing (the scan descends
  // the whole tree) but may not recover it: it is not a sub-team of `email`.
  const rootList = await callTool(
    harness,
    { action: 'list' },
    makeContext({ teamName: PARENT_TEAM }),
  )
  expect(rootList.data.sub_teams?.map(s => s.team_name)).toEqual([
    subSubTeam,
    SUB_TEAM,
  ])
  await expect(
    callTool(
      harness,
      { action: 'adopt', team_name: subSubTeam },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  ).rejects.toThrow('is not a sub-team of')

  // The sub-lead does: its own team is the sub-team it leads, and the
  // caretaker an adopt installs is `team-lead@email/supervisor` — the inbox
  // this very teammate polls through U5's dual-inbox path.
  const result = await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    callTool(
      harness,
      { action: 'adopt', team_name: subSubTeam },
      makeContext({ teamName: PARENT_TEAM }),
    ),
  )
  expect(result.data).toMatchObject({
    own_team: SUB_TEAM,
    team_name: subSubTeam,
    state: 'adopted',
    lead_agent_id: `${TEAM_LEAD_NAME}@${SUB_TEAM}`,
  })
  expect(readTeamFile(subSubTeam)?.parentAgentId).toBe(
    `${TEAM_LEAD_NAME}@${SUB_TEAM}`,
  )
})
