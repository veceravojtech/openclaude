import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import type { AgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { getTeamFilePath, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import {
  NO_ADDRESSABLE_AGENTS_MESSAGE,
  SEND_MESSAGE_HINT,
} from './collectAddressableAgents.js'
import { ListAgentsTool, type Output } from './ListAgentsTool.js'

const originalEnv = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
  CLAUDE_CODE_DISABLE_AGENT_TEAMS: process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS,
  USER_TYPE: process.env.USER_TYPE,
}

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/ListAgentsTool/ListAgentsTool.test.ts')
  // Teams are on by default; tests turn them off explicitly.
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  delete process.env.USER_TYPE
})

afterEach(() => {
  try {
    restoreEnv('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS')
    restoreEnv('CLAUDE_CODE_DISABLE_AGENT_TEAMS')
    restoreEnv('USER_TYPE')
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function restoreEnv(key: keyof typeof originalEnv): void {
  const originalValue = originalEnv[key]
  if (originalValue === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalValue
  }
}

function contextFor(appState: AppState, agentId?: string): ToolUseContext {
  return {
    getAppState: () => appState,
    agentId: agentId as AgentId | undefined,
  } as unknown as ToolUseContext
}

function toText(output: Output): string {
  const block = ListAgentsTool.mapToolResultToToolResultBlockParam(output, 'tu-1')
  return block.content as string
}

test('isEnabled follows the agent-teams gate', () => {
  expect(ListAgentsTool.isEnabled()).toBe(true)
  process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
  expect(ListAgentsTool.isEnabled()).toBe(false)
})

test('is read-only, concurrency-safe, parameterless and never deferred', () => {
  expect(ListAgentsTool.name).toBe('ListAgents')
  expect(ListAgentsTool.isReadOnly()).toBe(true)
  expect(ListAgentsTool.isConcurrencySafe()).toBe(true)
  expect((ListAgentsTool as { shouldDefer?: boolean }).shouldDefer).toBeFalsy()
  expect(ListAgentsTool.inputSchema.safeParse({}).success).toBe(true)
  expect(ListAgentsTool.inputSchema.safeParse({ team: 'x' }).success).toBe(false)
})

test('registered next to SendMessage and gated the same way', () => {
  const baseNames = getAllBaseTools().map(tool => tool.name)
  expect(baseNames[baseNames.indexOf('SendMessage') + 1]).toBe('ListAgents')

  const permissionContext = getEmptyToolPermissionContext()
  expect(getTools(permissionContext).map(tool => tool.name)).toContain(
    'ListAgents',
  )
  process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
  const gatedOff = getTools(permissionContext).map(tool => tool.name)
  expect(gatedOff).not.toContain('ListAgents')
  expect(gatedOff).not.toContain('SendMessage')
})

test('call() merges the team file, in-process teammates and named background agents, excluding the caller', async () => {
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-list-agents-'))
  setClaudeConfigHomeDirForTesting(configDir)

  const teamName = 'alpha'
  const teamFile: TeamFile = {
    name: teamName,
    createdAt: 0,
    leadAgentId: 'lead-id',
    members: [
      {
        agentId: 'lead-id',
        name: 'team-lead',
        joinedAt: 0,
        tmuxPaneId: '%0',
        cwd: '/work',
        subscriptions: [],
      },
      {
        agentId: `coder@${teamName}`,
        name: 'coder',
        joinedAt: 0,
        tmuxPaneId: '',
        cwd: '/work',
        subscriptions: [],
        backendType: 'in-process',
      },
      {
        agentId: `painter@${teamName}`,
        name: 'painter',
        prompt: 'paint the shed',
        model: 'opus',
        joinedAt: 0,
        tmuxPaneId: '%2',
        cwd: '/work',
        subscriptions: [],
        backendType: 'tmux',
        isActive: false,
      },
    ],
  }
  const teamFilePath = getTeamFilePath(teamName)
  mkdirSync(dirname(teamFilePath), { recursive: true })
  writeFileSync(teamFilePath, JSON.stringify(teamFile))

  const coder: InProcessTeammateTaskState = {
    id: 't-coder',
    type: 'in_process_teammate',
    status: 'running',
    description: 'coder: fix the tests',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `coder@${teamName}`,
      agentName: 'coder',
      teamName,
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'fix the tests',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
  const scout: LocalAgentTaskState = {
    id: 'a-scout',
    type: 'local_agent',
    status: 'completed',
    description: 'scout the repo',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'a-scout',
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
  const appState = {
    tasks: { [coder.id]: coder, [scout.id]: scout },
    agentNameRegistry: new Map([['scout', 'a-scout' as AgentId]]),
    teamContext: {
      teamName,
      teamFilePath,
      leadAgentId: 'lead-id',
      selfAgentId: 'lead-id',
      selfAgentName: 'team-lead',
      isLeader: true,
      teammates: {},
    },
  } as unknown as AppState

  // The lead sees everyone but itself; it is not a teammate, so no lead row.
  const { data } = await ListAgentsTool.call({}, contextFor(appState))
  expect(data.agents.map(a => [a.name, a.kind, a.status, a.to])).toEqual([
    ['coder', 'teammate', 'busy', 'coder'],
    ['painter', 'teammate', 'idle', 'painter'],
    ['scout', 'background_agent', 'completed', 'scout'],
  ])
  expect(data.agents.find(a => a.name === 'painter')).toMatchObject({
    agentId: `painter@${teamName}`,
    model: 'opus',
    team: teamName,
    description: 'painter: paint the shed',
  })
  expect(toText(data).split('\n')).toEqual([
    'coder  teammate  busy  to=coder  - coder: fix the tests',
    'painter  teammate  idle  to=painter  - painter: paint the shed',
    'scout  background_agent  completed  to=scout  - scout the repo',
    '',
    SEND_MESSAGE_HINT,
  ])

  // A background subagent is identified by toolUseContext.agentId.
  const fromScout = await ListAgentsTool.call({}, contextFor(appState, 'a-scout'))
  expect(fromScout.data.agents.map(a => a.name)).toEqual(['coder', 'painter'])
})

test('call() outside a team reports that nothing is addressable', async () => {
  const appState = {
    tasks: {},
    agentNameRegistry: new Map(),
  } as unknown as AppState
  const { data } = await ListAgentsTool.call({}, contextFor(appState))
  expect(data.agents).toEqual([])
  expect(toText(data)).toBe(NO_ADDRESSABLE_AGENTS_MESSAGE)
})
