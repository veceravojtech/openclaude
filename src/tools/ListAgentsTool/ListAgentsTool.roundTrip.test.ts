/**
 * The round trip: every `to` ListAgents hands out is a `to` SendMessage
 * resolves back to the agent on that row. A row that cannot be answered is
 * worse than no row at all, so this walks the whole list from each position
 * in a fixtured tree and delivers to every one of them.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage } from '../../types/message.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { getTeamFilePath, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import {
  getDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from '../../utils/teammateContext.js'
import { readMailbox } from '../../utils/teammateMailbox.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import type { AddressableAgent } from './collectAddressableAgents.js'
import { ListAgentsTool } from './ListAgentsTool.js'

const ROOT = 'alpha'
const SUB = `${ROOT}/supervisor`
const LEAD_ID = `team-lead@${ROOT}`
const SUPERVISOR_ID = `supervisor@${ROOT}`
const WORKER_ID = `worker@${SUB}`
const SCOUT_ID = 'ageneral-purpose-0123456789abcdef'

let configDir: string | undefined
let originalDynamicTeamContext: ReturnType<typeof getDynamicTeamContext> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/ListAgentsTool/ListAgentsTool.roundTrip.test.ts',
  )
  originalDynamicTeamContext = getDynamicTeamContext()
  setDynamicTeamContext(null)
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-list-agents-tree-'))
  setClaudeConfigHomeDirForTesting(configDir)
  writeTeamFiles()
})

afterEach(() => {
  try {
    setDynamicTeamContext(originalDynamicTeamContext)
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function member(name: string, team: string): TeamFile['members'][number] {
  return {
    agentId: `${name}@${team}`,
    name,
    joinedAt: 0,
    tmuxPaneId: '',
    cwd: '/work',
    subscriptions: [],
    backendType: 'in-process',
  }
}

function writeTeamFile(teamFile: TeamFile): void {
  const path = getTeamFilePath(teamFile.name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

function writeTeamFiles(): void {
  writeTeamFile({
    name: ROOT,
    createdAt: 0,
    leadAgentId: LEAD_ID,
    members: [
      member('team-lead', ROOT),
      member('supervisor', ROOT),
      member('coder', ROOT),
    ],
  })
  writeTeamFile({
    name: SUB,
    createdAt: 0,
    leadAgentId: `team-lead@${SUB}`,
    parentTeam: ROOT,
    parentAgentId: SUPERVISOR_ID,
    members: [
      member('team-lead', SUB),
      member('worker', SUB),
      member('painter', SUB),
    ],
  })
}

function teammateTask(
  name: string,
  team: string,
): InProcessTeammateTaskState {
  return {
    id: `${name}@${team}`,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: working`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@${team}`,
      agentName: name,
      teamName: team,
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'working',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

const scoutTask: LocalAgentTaskState = {
  id: SCOUT_ID,
  type: 'local_agent',
  status: 'running',
  description: 'scout the repo',
  startTime: 0,
  outputFile: '',
  outputOffset: 0,
  notified: false,
  agentId: SCOUT_ID,
  prompt: 'scout',
  agentType: 'general-purpose',
  retrieved: false,
  lastReportedToolCount: 0,
  lastReportedTokenCount: 0,
  isBackgrounded: true,
  pendingMessages: [],
  retain: false,
  diskLoaded: false,
}

/** The one AppState the lead and every in-process teammate share. */
function appState(): AppState {
  const supervisor = teammateTask('supervisor', ROOT)
  const worker = teammateTask('worker', SUB)
  return {
    tasks: {
      [supervisor.id]: supervisor,
      [worker.id]: worker,
      [scoutTask.id]: scoutTask,
    },
    agentNameRegistry: new Map<string, AgentId>([
      ['scout', SCOUT_ID as AgentId],
    ]),
    teamContext: {
      teamName: ROOT,
      teamFilePath: getTeamFilePath(ROOT),
      leadAgentId: LEAD_ID,
      selfAgentId: LEAD_ID,
      selfAgentName: 'team-lead',
      isLeader: true,
      teammates: {},
    },
  } as unknown as AppState
}

function contextFor(): ToolUseContext {
  let current = appState()
  return {
    getAppState: () => current,
    setAppState: (f: (prev: AppState) => AppState) => {
      current = f(current)
    },
    setAppStateForTasks: (f: (prev: AppState) => AppState) => {
      current = f(current)
    },
  } as unknown as ToolUseContext
}

const canUseTool = (() => {
  throw new Error('canUseTool must not be reached in these tests')
}) as unknown as CanUseToolFn

/** Run `fn` at one position in the tree: the lead, or an in-process teammate. */
function at<T>(
  position: { agentId: string; name: string; team: string } | undefined,
  fn: () => T,
): T {
  if (!position) return fn()
  return runWithTeammateContext(
    createTeammateContext({
      agentId: position.agentId,
      agentName: position.name,
      teamName: position.team,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    }),
    fn,
  )
}

const POSITIONS = {
  lead: undefined,
  subLead: { agentId: SUPERVISOR_ID, name: 'supervisor', team: ROOT },
  child: { agentId: WORKER_ID, name: 'worker', team: SUB },
} as const

async function listFrom(
  position: (typeof POSITIONS)[keyof typeof POSITIONS],
): Promise<AddressableAgent[]> {
  const { data } = await at(position, () =>
    ListAgentsTool.call({}, contextFor()),
  )
  return data.agents
}

/** Deliver to a row's `to` from the same position that listed it. */
async function sendTo(
  position: (typeof POSITIONS)[keyof typeof POSITIONS],
  to: string,
  text: string,
): Promise<string> {
  const { data } = await at(position, () =>
    SendMessageTool.call(
      { to, summary: text, message: text },
      contextFor(),
      canUseTool,
      undefined as unknown as AssistantMessage,
    ),
  )
  return (data as { message: string }).message
}

async function inboxTexts(name: string, team: string): Promise<string[]> {
  return (await readMailbox(name, team)).map(message => message.text)
}

test('ListAgents shows each position its own neighbourhood in the tree', async () => {
  expect(
    (await listFrom(POSITIONS.lead)).map(a => [a.name, a.kind, a.to]),
  ).toEqual([
    // Its own team, and no reaching into the sub-team its teammate leads.
    ['coder', 'teammate', `coder@${ROOT}`],
    ['supervisor', 'teammate', `supervisor@${ROOT}`],
    ['scout', 'background_agent', 'scout'],
  ])

  expect(
    (await listFrom(POSITIONS.subLead)).map(a => [a.name, a.kind, a.to]),
  ).toEqual([
    ['team-lead', 'team_lead', `team-lead@${ROOT}`],
    ['coder', 'teammate', `coder@${ROOT}`],
    ['painter', 'teammate', `painter@${SUB}`],
    ['worker', 'teammate', `worker@${SUB}`],
    ['scout', 'background_agent', 'scout'],
  ])

  const fromChild = await listFrom(POSITIONS.child)
  expect(fromChild.map(a => [a.name, a.kind, a.team, a.to])).toEqual([
    // Both leads: the root's, and its own team's — which is the supervisor.
    ['team-lead', 'team_lead', ROOT, `team-lead@${ROOT}`],
    ['team-lead', 'team_lead', SUB, `team-lead@${SUB}`],
    ['painter', 'teammate', SUB, `painter@${SUB}`],
    ['scout', 'background_agent', undefined, 'scout'],
  ])
  expect(fromChild[1]?.description).toBe(`Lead of ${SUB} (${SUPERVISOR_ID})`)
})

test('every listed `to` delivers to the agent on its row, from every position', async () => {
  for (const [label, position] of Object.entries(POSITIONS)) {
    const rows = await listFrom(position)
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      const text = `${label} -> ${row.to}`
      const result = await sendTo(position, row.to, text)

      if (row.team === undefined) {
        // A named background agent has no inbox: its name routes through the
        // agent registry to the running task instead.
        expect(result).toContain('queued')
        continue
      }
      expect(result).toBe(`Message sent to ${row.to}'s inbox`)
      expect(await inboxTexts(row.name, row.team)).toContain(text)
    }
  }

  // Every delivery landed where the row said and nowhere else: the child's
  // `team-lead@alpha/supervisor` in the sub-team, the root lead's inbox only
  // from the rows that named it.
  expect(await inboxTexts('team-lead', SUB)).toEqual([
    `child -> team-lead@${SUB}`,
  ])
  expect(await inboxTexts('team-lead', ROOT)).toEqual([
    `subLead -> team-lead@${ROOT}`,
    `child -> team-lead@${ROOT}`,
  ])
  expect(await inboxTexts('painter', SUB)).toEqual([
    `subLead -> painter@${SUB}`,
    `child -> painter@${SUB}`,
  ])
  expect(await inboxTexts('coder', ROOT)).toEqual([
    `lead -> coder@${ROOT}`,
    `subLead -> coder@${ROOT}`,
  ])
  expect(await inboxTexts('worker', SUB)).toEqual([`subLead -> worker@${SUB}`])
  expect(await inboxTexts('supervisor', ROOT)).toEqual([
    `lead -> supervisor@${ROOT}`,
  ])
})
