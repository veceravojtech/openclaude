import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppState.js'
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
import {
  type BroadcastOutput,
  type MessageOutput,
  SendMessageTool,
} from './SendMessageTool.js'

const TEAM = 'alpha'
const SUPERVISOR_ID = `supervisor@${TEAM}`
const SUBAGENT_ID = 'ageneral-purpose-0123456789abcdef'

let configDir: string | undefined
let originalDynamicTeamContext: ReturnType<typeof getDynamicTeamContext> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/SendMessageTool/SendMessageTool.test.ts',
  )
  originalDynamicTeamContext = getDynamicTeamContext()
  setDynamicTeamContext(null)
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-send-message-'))
  setClaudeConfigHomeDirForTesting(configDir)
  writeTeamFile()
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

function writeTeamFile(): string {
  const teamFile: TeamFile = {
    name: TEAM,
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
        agentId: SUPERVISOR_ID,
        name: 'supervisor',
        joinedAt: 0,
        tmuxPaneId: '',
        cwd: '/work',
        subscriptions: [],
        backendType: 'in-process',
      },
      {
        agentId: `coder@${TEAM}`,
        name: 'coder',
        joinedAt: 0,
        tmuxPaneId: '',
        cwd: '/work',
        subscriptions: [],
        backendType: 'in-process',
      },
    ],
  }
  const teamFilePath = getTeamFilePath(TEAM)
  mkdirSync(dirname(teamFilePath), { recursive: true })
  writeFileSync(teamFilePath, JSON.stringify(teamFile))
  return teamFilePath
}

function runningSubagent(agentId: string): LocalAgentTaskState {
  return {
    id: agentId,
    type: 'local_agent',
    status: 'running',
    description: 'read the roadmap',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId,
    prompt: 'read the roadmap',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
}

function appStateWith(registry: Record<string, string> = {}): AppState {
  return {
    tasks: { [SUBAGENT_ID]: runningSubagent(SUBAGENT_ID) },
    agentNameRegistry: new Map(
      Object.entries(registry).map(([name, id]) => [name, id as AgentId]),
    ),
    teamContext: {
      teamName: TEAM,
      teamFilePath: getTeamFilePath(TEAM),
      leadAgentId: 'lead-id',
      selfAgentId: 'lead-id',
      selfAgentName: 'team-lead',
      isLeader: true,
      teammates: {},
    },
  } as unknown as AppState
}

/** A context whose AppState mutations are observable, as tasks see them. */
function contextFor(
  state: AppState,
  agentId?: string,
): { context: ToolUseContext; getState: () => AppState } {
  let current = state
  const context = {
    getAppState: () => current,
    setAppState: (f: (prev: AppState) => AppState) => {
      current = f(current)
    },
    setAppStateForTasks: (f: (prev: AppState) => AppState) => {
      current = f(current)
    },
    agentId: agentId as AgentId | undefined,
  } as unknown as ToolUseContext
  return { context, getState: () => current }
}

const canUseTool = (() => {
  throw new Error('canUseTool must not be reached in these tests')
}) as unknown as CanUseToolFn

async function send(
  input: { to: string; message: string; summary?: string },
  context: ToolUseContext,
): Promise<MessageOutput & BroadcastOutput> {
  const { data } = await SendMessageTool.call(
    input,
    context,
    canUseTool,
    undefined as unknown as AssistantMessage,
  )
  return data as MessageOutput & BroadcastOutput
}

function asSupervisor<T>(fn: () => T): T {
  return runWithTeammateContext(
    createTeammateContext({
      agentId: SUPERVISOR_ID,
      agentName: 'supervisor',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    }),
    fn,
  )
}

async function lastSenderTo(recipient: string): Promise<string | undefined> {
  const messages = await readMailbox(recipient, TEAM)
  return messages.at(-1)?.from
}

test('a direct message is signed with the caller’s own identity', async () => {
  // The lead signs as the team lead.
  const lead = contextFor(appStateWith())
  const fromLead = await send(
    { to: 'supervisor', message: 'ping', summary: 'ping' },
    lead.context,
  )
  expect(fromLead.routing?.sender).toBe('team-lead')
  expect(await lastSenderTo('supervisor')).toBe('team-lead')

  // A real teammate signs as itself.
  const teammate = contextFor(appStateWith())
  const fromTeammate = await asSupervisor(() =>
    send({ to: 'coder', message: 'status?', summary: 'status' }, teammate.context),
  )
  expect(fromTeammate.routing?.sender).toBe('supervisor')
  expect(await lastSenderTo('coder')).toBe('supervisor')

  // A named subagent of that teammate signs as ITSELF, not as its spawner —
  // it inherits the teammate's AsyncLocalStorage context but has its own id.
  const named = contextFor(appStateWith({ scout: SUBAGENT_ID }), SUBAGENT_ID)
  const fromNamed = await asSupervisor(() =>
    send({ to: 'coder', message: 'found it', summary: 'found it' }, named.context),
  )
  expect(fromNamed.routing?.sender).toBe('scout')
  expect(await lastSenderTo('coder')).toBe('scout')

  // An unnamed one signs with its raw agent id, which is a valid reply target.
  const unnamed = contextFor(appStateWith(), SUBAGENT_ID)
  const fromUnnamed = await asSupervisor(() =>
    send({ to: 'coder', message: 'me too', summary: 'me too' }, unnamed.context),
  )
  expect(fromUnnamed.routing?.sender).toBe(SUBAGENT_ID)
  expect(await lastSenderTo('coder')).toBe(SUBAGENT_ID)
})

test('a broadcast is signed the same way and still reaches the spawning teammate', async () => {
  const lead = contextFor(appStateWith())
  const fromLead = await send(
    { to: '*', message: 'standup', summary: 'standup' },
    lead.context,
  )
  expect(fromLead.routing?.sender).toBe('team-lead')
  expect(fromLead.recipients).toEqual(['supervisor', 'coder'])

  const teammate = contextFor(appStateWith())
  const fromTeammate = await asSupervisor(() =>
    send({ to: '*', message: 'on it', summary: 'on it' }, teammate.context),
  )
  expect(fromTeammate.routing?.sender).toBe('supervisor')
  expect(fromTeammate.recipients).toEqual(['team-lead', 'coder'])

  // The subagent is not a team member, so no member row is suppressed: its
  // spawning teammate must still receive the broadcast, signed by the subagent.
  const named = contextFor(appStateWith({ scout: SUBAGENT_ID }), SUBAGENT_ID)
  const fromNamed = await asSupervisor(() =>
    send({ to: '*', message: 'heads up', summary: 'heads up' }, named.context),
  )
  expect(fromNamed.routing?.sender).toBe('scout')
  expect(fromNamed.recipients).toEqual(['team-lead', 'supervisor', 'coder'])
  expect(await lastSenderTo('supervisor')).toBe('scout')

  const unnamed = contextFor(appStateWith(), SUBAGENT_ID)
  const fromUnnamed = await asSupervisor(() =>
    send({ to: '*', message: 'and me', summary: 'and me' }, unnamed.context),
  )
  expect(fromUnnamed.routing?.sender).toBe(SUBAGENT_ID)
  expect(fromUnnamed.recipients).toContain('supervisor')
  expect(await lastSenderTo('supervisor')).toBe(SUBAGENT_ID)
})

test('replying to the raw id an unnamed subagent signed with reaches its pending messages', async () => {
  // What the subagent signed with is what the teammate replies to.
  const subagent = contextFor(appStateWith(), SUBAGENT_ID)
  const sent = await asSupervisor(() =>
    send(
      { to: 'supervisor', message: 'done', summary: 'done' },
      subagent.context,
    ),
  )
  const replyTo = sent.routing?.sender
  expect(replyTo).toBe(SUBAGENT_ID)

  const teammate = contextFor(appStateWith())
  const reply = await asSupervisor(() =>
    send(
      { to: replyTo!, message: 'thanks, keep going', summary: 'thanks' },
      teammate.context,
    ),
  )
  expect(reply.success).toBe(true)
  expect(reply.message).toContain('queued')

  const task = teammate.getState().tasks[SUBAGENT_ID]
  expect(task && 'pendingMessages' in task ? task.pendingMessages : []).toEqual([
    'thanks, keep going',
  ])
})
