import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage } from '../../types/message.js'
import type { CallerIdentity } from '../../utils/agentIdentity.js'
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
  formatRecipientAddress,
  getRootTeamName,
  resolveCallerTeamName,
  resolveRecipient,
} from './addressing.js'
import { SendMessageTool } from './SendMessageTool.js'

/**
 * The tree every test in this file addresses in:
 *
 *   alpha                    team-lead, supervisor, coder
 *   alpha/supervisor         team-lead (= supervisor), worker, painter
 */
const ROOT = 'alpha'
const SUB = `${ROOT}/supervisor`
const SUPERVISOR_ID = `supervisor@${ROOT}`
const WORKER_ID = `worker@${SUB}`
const SUBAGENT_ID = 'ageneral-purpose-0123456789abcdef'

let configDir: string | undefined
let originalDynamicTeamContext: ReturnType<typeof getDynamicTeamContext> = null

beforeEach(async () => {
  await acquireSharedMutationLock('tools/SendMessageTool/addressing.test.ts')
  originalDynamicTeamContext = getDynamicTeamContext()
  setDynamicTeamContext(null)
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-addressing-'))
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

function member(
  name: string,
  team: string,
): TeamFile['members'][number] {
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
    leadAgentId: `team-lead@${ROOT}`,
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

/** The caller identities `resolveCallerIdentity` reports at each position. */
const asLead: CallerIdentity = {
  agentId: `team-lead@${ROOT}`,
  name: 'team-lead',
  isTeammate: false,
}
const asSubLead: CallerIdentity = {
  agentId: SUPERVISOR_ID,
  name: 'supervisor',
  isTeammate: true,
}
const asChild: CallerIdentity = {
  agentId: WORKER_ID,
  name: 'worker',
  isTeammate: true,
}
const asSubagentOfSubLead: CallerIdentity = {
  agentId: SUBAGENT_ID,
  name: 'scout',
  isTeammate: false,
  spawnerAgentId: SUPERVISOR_ID,
}

async function resolve(
  to: string,
  caller: CallerIdentity,
  sessionTeamName: string | undefined = ROOT,
): Promise<string> {
  const { recipientName, teamName, via } = await resolveRecipient(
    to,
    caller,
    sessionTeamName,
  )
  return `${formatRecipientAddress(recipientName, teamName)} (${via})`
}

test('a name@team address names that team, from every position', async () => {
  // No roster search and no ambient team: the address is the answer.
  expect(await resolve(`worker@${SUB}`, asLead)).toBe(
    `worker@${SUB} (qualified)`,
  )
  expect(await resolve(`worker@${SUB}`, asSubLead)).toBe(
    `worker@${SUB} (qualified)`,
  )
  expect(await resolve(`coder@${ROOT}`, asChild)).toBe(
    `coder@${ROOT} (qualified)`,
  )
  // The team half keeps its `/`: parseAgentId splits on the FIRST `@`.
  expect(
    await resolveRecipient(`painter@${SUB}`, asChild, ROOT),
  ).toMatchObject({ recipientName: 'painter', teamName: SUB })
})

test('a bare name resolves own team, then the team above, then the sub-team', async () => {
  // Root lead: its own team only — it leads no sub-team, so a name that
  // exists solely below stays home rather than reaching down.
  expect(await resolve('coder', asLead)).toBe(`coder@${ROOT} (own-team)`)
  expect(await resolve('painter', asLead)).toBe(`painter@${ROOT} (unplaced)`)

  // Sub-lead: its own team first, then the sub-team it leads.
  expect(await resolve('coder', asSubLead)).toBe(`coder@${ROOT} (own-team)`)
  expect(await resolve('worker', asSubLead)).toBe(`worker@${SUB} (sub-team)`)

  // Child: its own team first, then the team above it.
  expect(await resolve('painter', asChild)).toBe(`painter@${SUB} (own-team)`)
  expect(await resolve('coder', asChild)).toBe(`coder@${ROOT} (parent-team)`)

  // A name nobody has stays in the sender's own team, as before sub-teams.
  expect(await resolve('ghost', asChild)).toBe(`ghost@${SUB} (unplaced)`)
})

test('`team-lead` is the lead of the sender’s own team; the root needs its address', async () => {
  expect(await resolve('team-lead', asLead)).toBe(`team-lead@${ROOT} (team-lead)`)
  expect(await resolve('team-lead', asSubLead)).toBe(
    `team-lead@${ROOT} (team-lead)`,
  )
  // From inside the sub-team, `team-lead` is the sub-lead...
  expect(await resolve('team-lead', asChild)).toBe(`team-lead@${SUB} (team-lead)`)
  // ...and the root lead is reached by its full address.
  expect(await resolve(`team-lead@${ROOT}`, asChild)).toBe(
    `team-lead@${ROOT} (qualified)`,
  )
})

test('a subagent is placed in the team of the teammate that spawned it', async () => {
  expect(await resolve('coder', asSubagentOfSubLead)).toBe(
    `coder@${ROOT} (own-team)`,
  )
  // It does not inherit the sub-team its spawner leads: only a teammate leads
  // one, so a bare name from below is not searched there.
  expect(await resolve('worker', asSubagentOfSubLead)).toBe(
    `worker@${ROOT} (unplaced)`,
  )
  expect(await resolve(`worker@${SUB}`, asSubagentOfSubLead)).toBe(
    `worker@${SUB} (qualified)`,
  )
})

test('a caller with no team of its own falls back to the session’s team', async () => {
  const loneSubagent: CallerIdentity = {
    agentId: SUBAGENT_ID,
    name: 'scout',
    isTeammate: false,
  }
  expect(await resolve('coder', loneSubagent)).toBe(`coder@${ROOT} (own-team)`)
  // Outside every team — a plain session's own subagent — nothing places it,
  // and `writeToMailbox` keeps its own default.
  expect(await resolveRecipient('coder', loneSubagent, undefined)).toEqual({
    recipientName: 'coder',
    teamName: undefined,
    via: 'unplaced',
  })
})

test('resolveCallerTeamName and getRootTeamName read the tree, not the session', () => {
  expect(resolveCallerTeamName(asChild, ROOT)).toBe(SUB)
  expect(resolveCallerTeamName(asSubLead, ROOT)).toBe(ROOT)
  expect(resolveCallerTeamName(asSubagentOfSubLead, 'other')).toBe(ROOT)
  expect(resolveCallerTeamName({ agentId: 'lead-id' }, ROOT)).toBe(ROOT)
  expect(
    resolveCallerTeamName({ agentId: undefined }, undefined),
  ).toBeUndefined()

  expect(getRootTeamName(ROOT)).toBe(ROOT)
  expect(getRootTeamName(SUB)).toBe(ROOT)
  expect(getRootTeamName(`${SUB}/deeper`)).toBe(ROOT)

  expect(formatRecipientAddress('worker', SUB)).toBe(WORKER_ID)
  expect(formatRecipientAddress('scout', undefined)).toBe('scout')
})

/**
 * The last AppState the tool's own `setAppState` produced, so a test can read
 * a task field the handler wrote. Reset per `contextFor`.
 */
let lastAppState: AppState | undefined

/** The AppState a teammate shares with its lead: the ROOT team's context. */
function appState(workerTask?: unknown): AppState {
  return {
    tasks: workerTask ? { [WORKER_ID]: workerTask } : {},
    agentNameRegistry: new Map<string, AgentId>([['scout', SUBAGENT_ID as AgentId]]),
    teamContext: {
      teamName: ROOT,
      teamFilePath: getTeamFilePath(ROOT),
      leadAgentId: `team-lead@${ROOT}`,
      selfAgentId: `team-lead@${ROOT}`,
      selfAgentName: 'team-lead',
      isLeader: true,
      teammates: {},
    },
  } as unknown as AppState
}

function contextFor(agentId?: string, workerTask?: unknown): ToolUseContext {
  let state = appState(workerTask)
  lastAppState = state
  const setAppState = (f: (prev: AppState) => AppState): void => {
    state = f(state)
    lastAppState = state
  }
  return {
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    agentId: agentId as AgentId | undefined,
  } as unknown as ToolUseContext
}

const canUseTool = (() => {
  throw new Error('canUseTool must not be reached in these tests')
}) as unknown as CanUseToolFn

async function send(to: string, text: string): Promise<string> {
  const { data } = await SendMessageTool.call(
    { to, summary: text, message: text },
    contextFor(),
    canUseTool,
    undefined as unknown as AssistantMessage,
  )
  return (data as { message: string }).message
}

/** A structured (protocol) message, optionally sent by a subagent. */
async function sendStructured(
  to: string,
  message: Parameters<typeof SendMessageTool.call>[0]['message'],
  agentId?: string,
  workerTask?: unknown,
): Promise<string> {
  const { data } = await SendMessageTool.call(
    { to, message },
    contextFor(agentId, workerTask),
    canUseTool,
    undefined as unknown as AssistantMessage,
  )
  return (data as { message: string }).message
}

/** Run `fn` as an in-process teammate of the given identity. */
function asTeammate<T>(agentId: string, name: string, team: string, fn: () => T): T {
  return runWithTeammateContext(
    createTeammateContext({
      agentId,
      agentName: name,
      teamName: team,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    }),
    fn,
  )
}

async function inboxSenders(name: string, team: string): Promise<string[]> {
  return (await readMailbox(name, team)).map(message => message.from)
}

async function inboxProtocolFrom(
  name: string,
  team: string,
): Promise<Array<string | undefined>> {
  return (await readMailbox(name, team)).map(
    message => (JSON.parse(message.text) as { from?: string }).from,
  )
}

test('SendMessage delivers to the team the address resolves to', async () => {
  // Child → its sub-lead. The root lead's inbox must stay empty: this is the
  // message that used to skip a level.
  await asTeammate(WORKER_ID, 'worker', SUB, () =>
    send('team-lead', 'sub-team status'),
  )
  expect(await inboxSenders('team-lead', SUB)).toEqual(['worker'])
  expect(await inboxSenders('team-lead', ROOT)).toEqual([])

  // Child → the root lead, explicitly addressed.
  await asTeammate(WORKER_ID, 'worker', SUB, () =>
    send(`team-lead@${ROOT}`, 'escalating'),
  )
  expect(await inboxSenders('team-lead', ROOT)).toEqual(['worker'])

  // Child → a bare name that only the team above has.
  await asTeammate(WORKER_ID, 'worker', SUB, () => send('coder', 'rebased'))
  expect(await inboxSenders('coder', ROOT)).toEqual(['worker'])

  // Sub-lead → a bare name in the sub-team it leads.
  await asTeammate(SUPERVISOR_ID, 'supervisor', ROOT, () =>
    send('worker', 'take task 2'),
  )
  expect(await inboxSenders('worker', SUB)).toEqual(['supervisor'])

  // Root lead → into the sub-team, by address.
  const sent = await send(`painter@${SUB}`, 'ship it')
  expect(sent).toBe(`Message sent to painter@${SUB}'s inbox`)
  expect(await inboxSenders('painter', SUB)).toEqual(['team-lead'])
  expect(await inboxSenders('painter', ROOT)).toEqual([])
})

test('validateInput accepts name@team and rejects a half-written address', async () => {
  const context = contextFor()
  const valid = async (to: string) =>
    (await SendMessageTool.validateInput!(
      { to, summary: 's', message: 'm' },
      context,
    )).result

  expect(await valid(`worker@${SUB}`)).toBe(true)
  expect(await valid('worker')).toBe(true)
  expect(await valid('*')).toBe(true)
  expect(await valid('@alpha')).toBe(false)
  expect(await valid('worker@')).toBe(false)
})

test('shutdown messages resolve like any `to` and are signed by the caller', async () => {
  // A request crosses teams the same way a plain message does.
  await sendStructured(`worker@${SUB}`, {
    type: 'shutdown_request',
    reason: 'wrap up',
  })
  expect(await inboxSenders('worker', SUB)).toEqual(['team-lead'])
  expect(await inboxProtocolFrom('worker', SUB)).toEqual(['team-lead'])

  // A response goes to the lead of the sender's OWN team — from inside the
  // sub-team that is its sub-lead, not the root lead.
  await asTeammate(WORKER_ID, 'worker', SUB, () =>
    sendStructured('team-lead', {
      type: 'shutdown_response',
      request_id: 'shutdown-1@worker',
      approve: false,
      reason: 'mid-task',
    }),
  )
  expect(await inboxSenders('team-lead', SUB)).toEqual(['worker'])
  expect(await inboxProtocolFrom('team-lead', SUB)).toEqual(['worker'])
  expect(await inboxSenders('team-lead', ROOT)).toEqual([])

  // And a subagent spawned inside that teammate's turn signs as ITSELF: the
  // three shutdown handlers now take their `from` from the caller, not from
  // the ambient identity they inherit.
  await asTeammate(WORKER_ID, 'worker', SUB, () =>
    sendStructured(
      'team-lead',
      {
        type: 'shutdown_response',
        request_id: 'shutdown-2@worker',
        approve: false,
        reason: 'still reading',
      },
      SUBAGENT_ID,
    ),
  )
  expect(await inboxProtocolFrom('team-lead', SUB)).toEqual(['worker', 'scout'])
})

test('a rejected shutdown clears the flag so the next request is a fresh one', async () => {
  // shutdownRequested used to be set by the lead's terminate() and then never
  // cleared, which left the row reading `stopping` for the rest of the
  // teammate's life and let terminate() short-circuit every later request.
  // A rejection is an ANSWER: the request is no longer in flight.
  const workerTask = {
    ...runningWorkerTask(new AbortController()),
    shutdownRequested: true,
  }

  const result = await asTeammate(WORKER_ID, 'worker', SUB, () =>
    sendStructured(
      'team-lead',
      {
        type: 'shutdown_response',
        request_id: 'shutdown-4@worker',
        approve: false,
        reason: 'mid-task',
      },
      undefined,
      workerTask,
    ),
  )

  expect(result).toContain('Shutdown rejected')
  expect(
    (lastAppState?.tasks[WORKER_ID] as { shutdownRequested?: boolean })
      .shutdownRequested,
  ).toBe(false)
  // Still running: a rejection stops the request, not the teammate.
  expect(lastAppState?.tasks[WORKER_ID]?.status).toBe('running')
})

test('an approved shutdown answers its own team’s lead, signed by the caller', async () => {
  // The teammate's own task has to be in AppState: with it, approval aborts
  // that controller. The roster entry's `backendType: 'in-process'` is what
  // keeps this path off `gracefulShutdown` — do not loosen it here.
  const abortController = new AbortController()
  const workerTask = runningWorkerTask(abortController)

  const result = await asTeammate(WORKER_ID, 'worker', SUB, () =>
    sendStructured(
      'team-lead',
      {
        type: 'shutdown_response',
        request_id: 'shutdown-3@worker',
        approve: true,
      },
      undefined,
      workerTask,
    ),
  )
  expect(result).toContain('Shutdown approved')
  expect(abortController.signal.aborted).toBe(true)
  expect(await inboxProtocolFrom('team-lead', SUB)).toEqual(['worker'])
  expect(await inboxSenders('team-lead', ROOT)).toEqual([])
})

/** The worker's own in-process task row, as its lead's AppState holds it. */
function runningWorkerTask(abortController: AbortController) {
  return {
    id: WORKER_ID,
    type: 'in_process_teammate',
    status: 'running',
    description: 'worker: working',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: WORKER_ID,
      agentName: 'worker',
      teamName: SUB,
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
    abortController,
  }
}
