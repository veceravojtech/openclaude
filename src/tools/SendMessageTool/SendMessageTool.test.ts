import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PaneLiveness } from '../../utils/swarm/backends/types.js'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { TaskStatus } from '../../Task.js'
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
import { createAgentId } from '../../utils/uuid.js'
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
  paneLiveness = 'alive'
  probeThrows = false
  probedPanes = []
  probedSockets = []
  aliveSocket = undefined
  await mockBackendRegistry()
  writeTeamFile()
})

afterEach(() => {
  try {
    // `mock.restore()` does not undo `mock.module()` (bun 1.3.9), so the real
    // registry has to be handed back explicitly or every later suite in this
    // process would get this file's fake pane probe.
    if (pristineBackendRegistry) {
      mock.module('../../utils/swarm/backends/registry.js', () => ({
        ...pristineBackendRegistry,
      }))
    }
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

/**
 * What the pane probe answers, and which panes it was asked about. The probe
 * is the only part of liveness that needs a tmux server, so it is the only
 * part faked; everything else here runs the product code.
 */
let paneLiveness: PaneLiveness = 'alive'
let probeThrows = false
let probedPanes: string[] = []
let probedSockets: Array<string | undefined> = []
/**
 * When set, the mock answers `'alive'` only for a probe sent to this socket and
 * `'dead'` for any other named socket — the way a live pane on one tmux server
 * reads as gone when asked from a different one. This lets a test prove the
 * probe used the socket recorded on the roster rather than a guessed one.
 */
let aliveSocket: string | undefined
let pristineBackendRegistry: Record<string, unknown> | undefined

async function mockBackendRegistry(): Promise<void> {
  // Cache-busted specifier so this captures the REAL module, not the fake
  // installed by an earlier test in this file.
  const nonce = `sendMessagePristine=${Date.now()}-${Math.random()}`
  pristineBackendRegistry ??= await import(
    `../../utils/swarm/backends/registry.js?${nonce}`
  )
  mock.module('../../utils/swarm/backends/registry.js', () => ({
    ...pristineBackendRegistry,
    ensureBackendsRegistered: async () => {},
    getBackendByType: () => ({
      isPaneAliveOnSocket: async (
        paneId: string,
        socketName?: string,
      ): Promise<PaneLiveness> => {
        probedPanes.push(paneId)
        probedSockets.push(socketName)
        if (probeThrows) throw new Error('tmux server not running')
        // Mirror the real backend contract: without a recorded socket there is
        // no positive server identity, so the probe is unprovable.
        if (socketName === undefined) return 'unknown'
        if (aliveSocket !== undefined) {
          return socketName === aliveSocket ? 'alive' : 'dead'
        }
        return paneLiveness
      },
    }),
  }))
}

/** A roster member spawned into its own tmux pane. */
function paneMember(
  name: string,
  paneId: string,
  tmuxSocket?: string,
): TeamFile['members'][number] {
  return {
    agentId: `${name}@${TEAM}`,
    name,
    joinedAt: 0,
    tmuxPaneId: paneId,
    cwd: '/work',
    subscriptions: [],
    backendType: 'tmux',
    isActive: false,
    // Absent on legacy rows: a member written before the socket was recorded.
    ...(tmuxSocket !== undefined && { tmuxSocket }),
  }
}

function writeTeamFile(extraMembers: TeamFile['members'] = []): string {
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
  // Overrides, not appends: a name appears once on a real roster, and the two
  // defaults are in-process members, so a pane teammate has to displace one.
  for (const member of extraMembers) {
    const at = teamFile.members.findIndex(m => m.name === member.name)
    if (at === -1) {
      teamFile.members.push(member)
    } else {
      teamFile.members[at] = member
    }
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

/**
 * The AppState row a spawned in-process teammate has, at `status`. This row —
 * not the team file — is what says whether a runner is alive to drain the
 * teammate's inbox.
 */
function teammateTask(
  name: string,
  status: TaskStatus,
): InProcessTeammateTaskState {
  const agentId = `${name}@${TEAM}`
  return {
    id: agentId,
    type: 'in_process_teammate',
    status,
    description: 'ship the fix',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId,
      agentName: name,
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'ship the fix',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function appStateWith(
  registry: Record<string, string> = {},
  teammateTasks: InProcessTeammateTaskState[] = [],
): AppState {
  return {
    tasks: {
      [SUBAGENT_ID]: runningSubagent(SUBAGENT_ID),
      ...Object.fromEntries(teammateTasks.map(task => [task.id, task])),
    },
    agentNameRegistry: new Map(
      Object.entries(registry).map(([name, id]) => [name, id as AgentId]),
    ),
    toolPermissionContext: { mode: 'default' },
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

/**
 * The protocol half of SendMessage — `{type: ...}` envelopes, which take the
 * switch in `call()` rather than `handleMessage`. Its fields are read
 * defensively: a refusal deliberately carries neither `request_id` nor
 * `routing`, which is itself one of the things these tests pin.
 */
type StructuredResult = {
  success: boolean
  message: string
  request_id?: string
  target?: string
  routing?: unknown
}

async function sendStructured(
  to: string,
  message: Parameters<typeof SendMessageTool.call>[0]['message'],
  context: ToolUseContext,
): Promise<StructuredResult> {
  const { data } = await SendMessageTool.call(
    { to, message },
    context,
    canUseTool,
    undefined as unknown as AssistantMessage,
  )
  return data as StructuredResult
}

/**
 * Run `fn` inside the supervisor teammate's ambient context. `turnAgentId` is
 * the id the runner minted for the turn in progress and published on the
 * context, which is what tells the teammate's own calls apart from those of a
 * subagent spawned inside the turn.
 */
function asSupervisor<T>(fn: () => T, turnAgentId?: AgentId): T {
  return runWithTeammateContext(
    {
      ...createTeammateContext({
        agentId: SUPERVISOR_ID,
        agentName: 'supervisor',
        teamName: TEAM,
        planModeRequired: false,
        parentSessionId: 'lead-session',
        abortController: new AbortController(),
      }),
      ...(turnAgentId !== undefined && { turnAgentId }),
    },
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

test('a teammate signs its own runtime-shaped turn as itself, its subagent as itself', async () => {
  // The shape a real turn has: runAgent puts the runner's minted turn id on the
  // teammate's tool-use context, so it never matches the ambient `name@team`.
  // Signing off "the context id differs from the ambient one" alone would make
  // the supervisor sign with a raw per-turn id and broadcast to itself.
  const turnAgentId = createAgentId()
  expect(turnAgentId).not.toBe(SUPERVISOR_ID)

  const direct = contextFor(appStateWith(), turnAgentId)
  const fromTeammate = await asSupervisor(
    () => send({ to: 'coder', message: 'status?', summary: 'status' }, direct.context),
    turnAgentId,
  )
  expect(fromTeammate.routing?.sender).toBe('supervisor')
  expect(await lastSenderTo('coder')).toBe('supervisor')

  // Broadcast signs the same way, so the supervisor's own member row is the one
  // suppressed — it does not message itself.
  const broadcast = contextFor(appStateWith(), turnAgentId)
  const fromBroadcast = await asSupervisor(
    () => send({ to: '*', message: 'on it', summary: 'on it' }, broadcast.context),
    turnAgentId,
  )
  expect(fromBroadcast.routing?.sender).toBe('supervisor')
  expect(fromBroadcast.recipients).toEqual(['team-lead', 'coder'])

  // A subagent spawned inside that same turn carries a different id and still
  // signs as itself, named or raw.
  const named = contextFor(appStateWith({ scout: SUBAGENT_ID }), SUBAGENT_ID)
  const fromNamed = await asSupervisor(
    () => send({ to: 'coder', message: 'found it', summary: 'found it' }, named.context),
    turnAgentId,
  )
  expect(fromNamed.routing?.sender).toBe('scout')
  expect(await lastSenderTo('coder')).toBe('scout')

  const unnamed = contextFor(appStateWith(), SUBAGENT_ID)
  const fromUnnamed = await asSupervisor(
    () => send({ to: '*', message: 'me too', summary: 'me too' }, unnamed.context),
    turnAgentId,
  )
  expect(fromUnnamed.routing?.sender).toBe(SUBAGENT_ID)
  expect(fromUnnamed.recipients).toEqual(['team-lead', 'supervisor', 'coder'])
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

test('a message to a teammate whose task is terminal reports the real state, not a false success', async () => {
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'killed')]))
  const result = await send(
    { to: 'coder', message: 'status?', summary: 'status' },
    lead.context,
  )

  // The old behaviour was `success: true` into a mailbox nobody reads.
  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  // No routing: the UI draws a delivery whenever routing is present, and this
  // was not one — the caller and the human both get the text instead.
  expect(result.routing).toBeUndefined()
  // The write is deliberately KEPT: the inbox is durable, so the message
  // survives for a resume or a respawn under the same name.
  expect(await lastSenderTo('coder')).toBe('team-lead')
})

test('the undelivered message names the recipient and the status that made it undeliverable', async () => {
  for (const status of ['completed', 'failed', 'killed'] as const) {
    const lead = contextFor(appStateWith({}, [teammateTask('coder', status)]))
    const result = await send(
      { to: 'coder', message: 'ping', summary: 'ping' },
      lead.context,
    )
    // A model caller has to be able to act on this without parsing prose: the
    // address it used and the status word that explains the refusal.
    expect(result.success).toBe(false)
    expect(result.message).toContain(`coder@${TEAM}`)
    expect(result.message).toContain(status)
  }
})

test('a live teammate is messaged exactly as before, in every direction', async () => {
  // lead -> teammate
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'running')]))
  const fromLead = await send(
    { to: 'coder', message: 'status?', summary: 'status' },
    lead.context,
  )
  expect(fromLead.success).toBe(true)
  expect(fromLead.message).toContain('inbox')
  expect(fromLead.routing?.target).toBe('@coder')
  expect(await lastSenderTo('coder')).toBe('team-lead')

  // teammate -> teammate
  const teammate = contextFor(
    appStateWith({}, [teammateTask('coder', 'running')]),
  )
  const fromTeammate = await asSupervisor(() =>
    send({ to: 'coder', message: 'on it', summary: 'on it' }, teammate.context),
  )
  expect(fromTeammate.success).toBe(true)
  expect(await lastSenderTo('coder')).toBe('supervisor')

  // teammate -> lead. The lead has no teammate task row at all, and absence of
  // a row is not evidence of death, so it keeps today's success.
  const toLead = contextFor(appStateWith({}, [teammateTask('coder', 'killed')]))
  const fromTeammateToLead = await asSupervisor(() =>
    send({ to: 'team-lead', message: 'done', summary: 'done' }, toLead.context),
  )
  expect(fromTeammateToLead.success).toBe(true)

  // broadcast, with a dead row present: still one write per roster member.
  const broadcaster = contextFor(
    appStateWith({}, [teammateTask('coder', 'killed')]),
  )
  const broadcast = await send(
    { to: '*', message: 'standup', summary: 'standup' },
    broadcaster.context,
  )
  expect(broadcast.success).toBe(true)
  expect(broadcast.recipients).toEqual(['supervisor', 'coder'])
})

/**
 * STEP 0a — characterisation of the delivery gate as it stands, so the Step 1
 * exemption is diff-visible rather than argued about.
 *
 * The gate is `classifyTeammateDelivery`, and it reads exactly one thing: the
 * `appState.tasks` row for the recipient. A pane teammate's row is not its
 * runner — the process in the pane is, and the watchdog deliberately keeps
 * that process running after a failure — so "the row says failed" and "nothing
 * is reading the inbox" are not the same claim for a pane teammate.
 */

test('a plain message to a terminal task is refused even when its pane still runs', async () => {
  // The state the live repro left behind: a `failed` row for a teammate whose
  // tmux pane was still running the CLI, and still polling its inbox.
  writeTeamFile([paneMember('coder', '%21')])
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await send(
    { to: 'coder', message: 'status?', summary: 'status' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(result.message).toContain('failed')
  // The row alone convicted it: a plain message never spends a tmux probe.
  expect(probedPanes).toEqual([])
})

test('a shutdown request reaches a failed teammate whose pane is still running', async () => {
  // The live repro's end state: a `failed` row from the lead's registry, and a
  // `%21` still running the child whose poller surfaces the request
  // (useInboxPoller) so the teammate can approve its own exit.
  writeTeamFile([paneMember('coder', '%21', 'swarm-socket')])
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request', reason: 'wrap up' },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(result.request_id).toBeTruthy()
  // The exemption is an exception, not the removal of the check: it is granted
  // on evidence, so the pane was actually asked.
  expect(probedPanes).toEqual(['%21'])
  expect(await lastSenderTo('coder')).toBe('team-lead')
})

test('a shutdown request to a failed teammate whose pane is gone is refused like any dead recipient', async () => {
  // Step 1's other half, and a behaviour change: before it, the envelope never
  // passed through the terminal-task gate at all, so a request into an inbox
  // with no poller was reported as sent and the lead waited for an approval
  // that could never arrive.
  writeTeamFile([paneMember('coder', '%21', 'swarm-socket')])
  paneLiveness = 'dead'
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request', reason: 'wrap up' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(result.message).toContain(`coder@${TEAM}`)
  expect(result.message).toContain('failed')
  // No `request_id` and no `routing`: there is no request in flight to answer
  // and this was not a delivery. The UI renders neither, so the text is what
  // the caller and the human see.
  expect(result.request_id).toBeUndefined()
  expect(result.routing).toBeUndefined()
  // Unlike a refused plain message, a refused shutdown leaves no envelope: it
  // is a command a respawn under the same name would execute, so it is never
  // persisted. The mailbox stays empty.
  expect(await lastSenderTo('coder')).toBeUndefined()
})

test('an unreadable pane probe proves nothing, so the request is still refused', async () => {
  // 'unknown' is tmux unreachable or an answer with nothing readable in it —
  // a failure to prove liveness. Only a runner the probe actually saw counts,
  // and a refusal that was not needed costs a retry where a claimed delivery
  // nobody read costs the whole stop.
  writeTeamFile([paneMember('coder', '%21', 'swarm-socket')])
  paneLiveness = 'unknown'
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(probedPanes).toEqual(['%21'])
})

test('a shutdown request to a terminal teammate with no live pane to check is refused', async () => {
  // `coder` is in-process on this roster: no pane, so no evidence of a reader,
  // and its terminal row is the whole story (the row IS an in-process
  // teammate's runner). Refused rather than falsely acknowledged.
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'completed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(result.message).toContain('completed')
  expect(probedPanes).toEqual([])
})

test('a shutdown request to a running teammate is delivered without spending a probe', async () => {
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'running')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(result.request_id).toBeTruthy()
  expect(probedPanes).toEqual([])
  expect(await lastSenderTo('coder')).toBe('team-lead')
})

test('a shutdown request to a recipient with no task row keeps its optimistic success', async () => {
  // Absence of a row is not evidence of death — the lead, another process, a
  // roster name AppState has not caught up with. Unchanged by Step 1.
  const lead = contextFor(appStateWith())

  const result = await sendStructured(
    'supervisor',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(result.request_id).toBeTruthy()
  expect(probedPanes).toEqual([])
})

test('a probe that blows up is a refusal, not a failed tool call', async () => {
  // Liveness probing reaches tmux, which can be missing, wedged or scoped to
  // a socket this process cannot reach. None of that may turn a stop into an
  // exception the lead has to interpret.
  writeTeamFile([paneMember('coder', '%21')])
  probeThrows = true
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
})

test('only the shutdown request is exempt — a plan response to a terminal teammate is unchanged', async () => {
  // Scope check for the exemption: it is granted by message type, so the other
  // structured message a lead sends keeps whichever behaviour it had.
  writeTeamFile([paneMember('coder', '%21')])
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'plan_approval_response', request_id: 'plan-1', approve: true },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(probedPanes).toEqual([])
})

/**
 * DEFECT FIXES — the probe socket comes from the roster (not the probing
 * process's environment), and the untracked path (task row evicted) still
 * refuses a confirmed-dead pane.
 */

test('a live pane on a socket this process would not guess is still exempt — the recorded socket is used', async () => {
  // The member records a socket that differs from what the probing process's
  // own environment would derive. A probe that still guessed the socket would
  // ask the wrong server and read the live pane as dead.
  writeTeamFile([paneMember('coder', '%21', 'the-recorded-socket')])
  aliveSocket = 'the-recorded-socket'
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request', reason: 'wrap up' },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(result.request_id).toBeTruthy()
  expect(probedPanes).toEqual(['%21'])
  // The probe was handed the socket recorded on the member — not one derived
  // from this process's own environment.
  expect(probedSockets).toEqual(['the-recorded-socket'])
  expect(await lastSenderTo('coder')).toBe('team-lead')
})

test('a pane member with no recorded socket is unprovable and a shutdown request is refused', async () => {
  // A legacy roster row: no `tmuxSocket`. Without a recorded socket the probe
  // has no positive server identity, so it answers 'unknown' and the request
  // is refused rather than falsely acknowledged.
  writeTeamFile([paneMember('coder', '%21')])
  const lead = contextFor(appStateWith({}, [teammateTask('coder', 'failed')]))

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(probedPanes).toEqual(['%21'])
  expect(probedSockets).toEqual([undefined])
})

test('an untracked delivery to a pane member with a confirmed-dead pane is refused and writes no envelope', async () => {
  // The task row has been evicted (grace window), so the recipient is
  // `untracked` — yet its recorded pane is confirmed gone, which must still
  // refuse rather than report a false success.
  writeTeamFile([paneMember('coder', '%21', 'swarm-socket')])
  paneLiveness = 'dead'
  const lead = contextFor(appStateWith())

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(false)
  expect(result.message).toContain('Not delivered')
  expect(result.message).toContain(`coder@${TEAM}`)
  expect(result.request_id).toBeUndefined()
  expect(result.routing).toBeUndefined()
  // A refused shutdown leaves no envelope behind (a command, not a message).
  expect(await lastSenderTo('coder')).toBeUndefined()
})

test('an untracked delivery whose pane probe is unknown is not refused on that basis', async () => {
  // Fail open: an unprovable pane must not be refused, and certainly not read
  // as dead. The optimistic delivery survives.
  writeTeamFile([paneMember('coder', '%21', 'swarm-socket')])
  paneLiveness = 'unknown'
  const lead = contextFor(appStateWith())

  const result = await sendStructured(
    'coder',
    { type: 'shutdown_request' },
    lead.context,
  )

  expect(result.success).toBe(true)
  expect(result.request_id).toBeTruthy()
  expect(await lastSenderTo('coder')).toBe('team-lead')
})
