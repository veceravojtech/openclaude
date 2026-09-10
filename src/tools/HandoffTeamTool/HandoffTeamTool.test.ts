import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { takeSubLeadHandoff } from '../../utils/swarm/subLeadHandoff.js'
import {
  getTeamFilePath,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { clearDynamicTeamContext } from '../../utils/teammate.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { HandoffTeamTool } from './HandoffTeamTool.js'

// U10: HandoffTeam is how a sub-lead retires itself in favour of a fresh
// successor. These pin the authority rule (the sub-team is the CALLER's, and
// there is no argument to name another), the refusal for anyone who leads
// nothing, and the three effects the tool has: the notes are written, the
// handoff is armed for the runner's tail, and the caller's own run is ended.

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const WORKER = 'worker'
const TURN_AGENT_ID = asAgentId('a00000000000cafe')

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/HandoffTeamTool/HandoffTeamTool.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-handoff-tool-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.restore()
    // Nothing may outlive a test in the one-shot registry.
    takeSubLeadHandoff(SUB_LEAD_AGENT_ID)
    clearDynamicTeamContext()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

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
    { agentId: `${TEAM_LEAD_NAME}@${PARENT_TEAM}`, name: TEAM_LEAD_NAME },
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

type Context = {
  context: ToolUseContext
  abortController: AbortController
}

/** The sub-lead's own running task, plus one running child of its sub-team. */
function makeContext(
  options: { teamName?: string; withOwnTask?: boolean } = {},
): Context {
  const abortController = new AbortController()
  const tasks: Record<string, unknown> = {
    't-worker': {
      id: 't-worker',
      type: 'in_process_teammate',
      status: 'running',
      identity: {
        agentId: `${WORKER}@${SUB_TEAM}`,
        agentName: WORKER,
        teamName: SUB_TEAM,
      },
    },
  }
  if (options.withOwnTask !== false) {
    tasks['t-sub-lead'] = {
      id: 't-sub-lead',
      type: 'in_process_teammate',
      status: 'running',
      abortController,
      identity: {
        agentId: SUB_LEAD_AGENT_ID,
        agentName: SUB_LEAD,
        teamName: PARENT_TEAM,
      },
    }
  }
  const appState = {
    agentNameRegistry: new Map<string, string>(),
    mainLoopModel: 'test-model',
    tasks,
    teamContext: options.teamName ? { teamName: options.teamName } : undefined,
  } as unknown as AppState
  return {
    abortController,
    context: {
      agentId: TURN_AGENT_ID,
      getAppState: () => appState,
      setAppState: mock(() => {}),
      abortController: new AbortController(),
      messages: [],
      options: { mainLoopModel: 'test-model' },
    } as unknown as ToolUseContext,
  }
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

type ToolInput = Parameters<NonNullable<typeof HandoffTeamTool.call>>[0]
type ToolOutput = { data: import('./HandoffTeamTool.js').Output }

function callTool(input: ToolInput, context: ToolUseContext): Promise<ToolOutput> {
  return HandoffTeamTool.call(
    input,
    context,
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-handoff' } as never,
  ) as Promise<ToolOutput>
}

const INPUT: ToolInput = {
  synthesis: 'the digest ships on Fridays; the worker owns the template',
  open_items: ['confirm the send window'],
  first_instruction: 'read the task list before messaging anyone',
  reason: 'context nearly full',
}

test('the sub-lead hands its own sub-team over: notes written, handoff armed, run ended', async () => {
  writeSubTeamWorld()
  const { context, abortController } = makeContext()

  const result = await asTeammate(SUB_LEAD, PARENT_TEAM, () =>
    callTool(INPUT, context),
  )

  expect(result.data.team_name).toBe(SUB_TEAM)
  // A handoff keeps the identity: the successor IS the caller's id.
  expect(result.data.successor_agent_id).toBe(SUB_LEAD_AGENT_ID)
  expect(result.data.members).toEqual([WORKER])
  expect(existsSync(result.data.handoff_path)).toBe(true)

  const document = readFileSync(result.data.handoff_path, 'utf-8')
  expect(document).toContain('the digest ships on Fridays')
  expect(document).toContain('- confirm the send window')
  expect(document).toContain('- Requested by: the sub-lead itself (HandoffTeam)')

  // Armed for the runner's completion tail — the tool never spawns itself.
  const pending = takeSubLeadHandoff(SUB_LEAD_AGENT_ID)
  expect(pending).toEqual({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    handoffPath: result.data.handoff_path,
    source: 'tool',
    reason: 'context nearly full',
    firstInstruction: 'read the task list before messaging anyone',
  })

  // And the caller's own run is ending: its lifecycle controller is aborted,
  // exactly as an approved shutdown ends an in-process teammate.
  expect(abortController.signal.aborted).toBe(true)
})

test('a team lead cannot hand over on a sub-lead behalf', async () => {
  writeSubTeamWorld()
  const { context, abortController } = makeContext({ teamName: PARENT_TEAM })

  await expect(callTool(INPUT, context)).rejects.toThrow(
    /hands over the sub-team you lead, and you lead none/,
  )
  expect(takeSubLeadHandoff(SUB_LEAD_AGENT_ID)).toBeUndefined()
  expect(abortController.signal.aborted).toBe(false)
})

test('a teammate that leads no sub-team is refused', async () => {
  writeTeam(PARENT_TEAM, [
    { agentId: `${TEAM_LEAD_NAME}@${PARENT_TEAM}`, name: TEAM_LEAD_NAME },
    { agentId: `helper@${PARENT_TEAM}`, name: 'helper' },
  ])
  const { context } = makeContext()

  await expect(
    asTeammate('helper', PARENT_TEAM, () => callTool(INPUT, context)),
  ).rejects.toThrow(/you lead none/)
})

test('a subagent running inside the sub-lead turn is not the sub-lead', async () => {
  writeSubTeamWorld()
  const { context, abortController } = makeContext()
  // A background subagent inherits the teammate's ALS context, so only the
  // tool-use context id tells them apart — resolveCallerIdentity's job.
  const subagentContext = {
    ...context,
    agentId: asAgentId('a00000000000beef'),
  } as unknown as ToolUseContext

  await expect(
    asTeammate(SUB_LEAD, PARENT_TEAM, () => callTool(INPUT, subagentContext)),
  ).rejects.toThrow(/you lead none/)
  expect(abortController.signal.aborted).toBe(false)
})

test('a sub-lead with no running task of its own is refused before anything is written', async () => {
  writeSubTeamWorld()
  const { context } = makeContext({ withOwnTask: false })

  await expect(
    asTeammate(SUB_LEAD, PARENT_TEAM, () => callTool(INPUT, context)),
  ).rejects.toThrow(/could not find the running task/)
  expect(takeSubLeadHandoff(SUB_LEAD_AGENT_ID)).toBeUndefined()
})

test('the tool is gated on Agent Teams and is never read-only', () => {
  expect(HandoffTeamTool.isEnabled()).toBe(true)
  expect(HandoffTeamTool.isReadOnly?.(INPUT)).toBe(false)
})
