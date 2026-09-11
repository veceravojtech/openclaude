import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { normalizeAttachmentForAPI } from '../messages.js'
import {
  createPermissionResponseMessage,
  createShutdownRequestMessage,
  isPermissionRequest,
  readMailbox,
  writeToMailbox,
} from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import { getTeamFilePath, type TeamFile } from './teamHelpers.js'

// T4/D2+D3. The failed hop: `worker -> supervisor` messages sat unread in
// `teams/zeekr/inboxes/supervisor.json` for as long as `supervisor` was busy,
// because an in-process teammate reads its own inbox ONLY in the idle poll
// loop. These drive the real runner through a turn whose rounds call the real
// per-tool-round attachment hook, and pin that a message arriving mid-turn is
// handed to the next round, marked read, and never delivered twice.

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('../../tools/AgentTool/runAgent.js')
type MailboxModule = typeof import('../teammateMailbox.js')
type SleepModule = typeof import('../sleep.js')
type DiskOutputModule = typeof import('../task/diskOutput.js')
type SdkEventQueueModule = typeof import('../sdkEventQueue.js')
type RunnerModule = typeof import('./inProcessRunner.js')
type AttachmentsModule = typeof import('../attachments.js')

let actualPrompts: PromptsModule | undefined
let actualRunAgent: RunAgentModule | undefined
let actualMailbox: MailboxModule | undefined
let actualSleep: SleepModule | undefined
let actualDiskOutput: DiskOutputModule | undefined
let actualSdkEventQueue: SdkEventQueueModule | undefined

const PARENT_TEAM = 'zeekr'
const SUB_LEAD = 'supervisor'
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const PLAIN = 'worker'

const ENV_KEYS = [
  'CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS',
  'CLAUDE_CODE_TEAMMATE_IDLE_SHUTDOWN_MS',
  'CLAUDE_CODE_TASK_LIST_ID',
  'USER_TYPE',
  'CLAUDE_CODE_DISABLE_AGENT_TEAMS',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/inProcessRunner.midTurnInbox.test.ts',
  )
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-midturn-runner-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousInteractive = getIsInteractive()
  setIsInteractive(false)
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
})

afterEach(() => {
  try {
    mock.restore()
    if (actualPrompts) {
      mock.module('../../constants/prompts.js', () => actualPrompts!)
    }
    if (actualRunAgent) {
      mock.module('../../tools/AgentTool/runAgent.js', () => actualRunAgent!)
    }
    if (actualMailbox) {
      mock.module('../teammateMailbox.js', () => actualMailbox!)
    }
    if (actualSleep) {
      mock.module('../sleep.js', () => actualSleep!)
    }
    if (actualDiskOutput) {
      mock.module('../task/diskOutput.js', () => actualDiskOutput!)
    }
    if (actualSdkEventQueue) {
      mock.module('../sdkEventQueue.js', () => actualSdkEventQueue!)
    }
    clearRegisteredHooks()
    if (previousRegisteredHooks) {
      registerHookCallbacks(previousRegisteredHooks)
    }
    setIsInteractive(previousInteractive)
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key]
      if (saved === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

type RunAgentParams = Parameters<RunAgentModule['runAgent']>[0]

/** One inbox read the attachment path performed, in call order. */
type InboxRead = { agentName: string; teamName: string | undefined }

type Harness = {
  runner: RunnerModule
  attachments: AttachmentsModule
  /** The user content each round of the teammate's turn was given. */
  roundInputs: string[]
  /** Runs between round 1 and round 2 of the NEXT turn, once. */
  betweenRounds?: () => Promise<void>
  /** Runs right after that round's drain, still inside the turn, once. */
  afterDrain?: () => Promise<void>
  turns: number
  sleeps: number
  attachmentInboxReads: InboxRead[]
  /** Set only around a drain, so only the drain's inbox reads are logged. */
  recordingInboxReads: boolean
  /**
   * While true the permission poll parses no response, so it cannot claim one
   * before the test says so. Nothing else reads a permission response.
   */
  blockingPermissionPoll: boolean
}

async function importRunnerWithMocks(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random()}`
  actualPrompts ??= await import(
    `../../constants/prompts.ts?midTurnActual=${stamp}`
  )
  actualRunAgent ??= await import(
    `../../tools/AgentTool/runAgent.ts?midTurnActual=${stamp}`
  )
  actualMailbox ??= await import(`../teammateMailbox.ts?midTurnActual=${stamp}`)
  actualSleep ??= await import(`../sleep.ts?midTurnActual=${stamp}`)
  actualDiskOutput ??= await import(
    `../task/diskOutput.ts?midTurnActual=${stamp}`
  )
  actualSdkEventQueue ??= await import(
    `../sdkEventQueue.ts?midTurnActual=${stamp}`
  )

  const harness: Harness = {
    runner: undefined as unknown as RunnerModule,
    attachments: undefined as unknown as AttachmentsModule,
    roundInputs: [],
    turns: 0,
    sleeps: 0,
    attachmentInboxReads: [],
    recordingInboxReads: false,
    blockingPermissionPoll: false,
  }

  mock.module('../../constants/prompts.js', () => ({
    ...actualPrompts!,
    getSystemPrompt: async () => ['system prompt'],
  }))
  // Real disk, wrapped twice.
  //
  // readMailbox is how the drain opens an inbox — and also how the runner's
  // own poll loops do, so only the reads made INSIDE a drain are logged. That
  // flag is exact here: the idle loop does not poll while a turn is in flight,
  // and the permission poll only runs in the test that installs it.
  //
  // isPermissionResponse is the permission poll's only way to recognise its
  // answer (inProcessRunner.ts), and nothing else calls it — the drain's own
  // filter goes through isStructuredProtocolMessage, which is internal to the
  // real module. Withholding it is therefore a clean pause button on that one
  // consumer, which is what lets the permission case assert on an inbox
  // without racing a 500 ms timer for it.
  mock.module('../teammateMailbox.js', () => ({
    ...actualMailbox!,
    readMailbox: async (agentName: string, teamName?: string) => {
      if (harness.recordingInboxReads) {
        harness.attachmentInboxReads.push({ agentName, teamName })
      }
      return actualMailbox!.readMailbox(agentName, teamName)
    },
    isPermissionResponse: (text: string) =>
      harness.blockingPermissionPoll
        ? null
        : actualMailbox!.isPermissionResponse(text),
  }))
  mock.module('../../tools/AgentTool/runAgent.js', () => ({
    ...actualRunAgent!,
    runAgent: async function* (params: RunAgentParams) {
      harness.turns++
      // What runAgent hands a tool during this turn: the context it was given,
      // carrying override.agentId (the runner's turnAgentId) verbatim.
      const roundContext = {
        ...params.toolUseContext,
        agentId: params.override?.agentId,
      } as unknown as ToolUseContext

      // Round 1 — the model calls a tool.
      harness.roundInputs.push(userContentOf(params))
      yield assistantMessage(harness.turns, 'looking into it')

      const between = harness.betweenRounds
      harness.betweenRounds = undefined
      if (between) await between()

      // The per-tool-round attachment hook: query.ts runs
      // getAttachmentMessages between rounds, and this is its mailbox half.
      harness.roundInputs.push(await drainRound(harness, roundContext))

      const afterDrain = harness.afterDrain
      harness.afterDrain = undefined
      if (afterDrain) await afterDrain()

      // Round 2 — the model answers with what it was just handed.
      yield assistantMessage(harness.turns, 'acknowledged')
    },
  }))
  mock.module('../sleep.js', () => ({
    ...actualSleep!,
    sleep: (ms: number) => {
      harness.sleeps++
      return new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2)))
    },
  }))
  mock.module('../task/diskOutput.js', () => ({
    ...actualDiskOutput!,
    evictTaskOutput: async () => {},
  }))
  mock.module('../sdkEventQueue.js', () => ({
    ...actualSdkEventQueue!,
    emitTaskTerminatedSdk: () => {},
  }))

  harness.attachments = await import(`../attachments.ts?midTurn=${stamp}`)
  harness.attachments.__test.resetSubTeamLeadershipCache()
  harness.runner = await import(`./inProcessRunner.ts?midTurn=${stamp}`)
  return harness
}

/** The mailbox half of one tool round, rendered as the model receives it. */
async function drainRound(
  harness: Harness,
  context: ToolUseContext,
): Promise<string> {
  harness.recordingInboxReads = true
  let attachments
  try {
    attachments =
      await harness.attachments.__test.getTeammateMailboxAttachments(context)
  } finally {
    harness.recordingInboxReads = false
  }
  return attachments
    .flatMap(a => normalizeAttachmentForAPI(a))
    .map(m => (typeof m.message.content === 'string' ? m.message.content : ''))
    .join('\n')
}

function assistantMessage(turn: number, text: string): unknown {
  return {
    type: 'assistant',
    uuid: `assistant-${turn}-${text}`,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg-${turn}-${text}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  }
}

function userContentOf(params: RunAgentParams): string {
  const first = params.promptMessages[0]
  if (!first || first.type !== 'user') return ''
  const content = first.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function writeTeam(
  teamName: string,
  members: Array<{ agentId: string; name: string }>,
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
      subscriptions: [],
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

/** The parent team, plus the sub-team `supervisor` leads. */
function writeSubTeamWorld(): void {
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD_NAME },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  writeTeam(
    SUB_TEAM,
    [{ agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME }],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
}

/** writeToMailbox wants a full message; the timestamp is not under test. */
function mail(
  from: string,
  text: string,
): { from: string; text: string; timestamp: string } {
  return { from, text, timestamp: new Date().toISOString() }
}

type StartedTeammate = {
  abortController: AbortController
  done: ReturnType<RunnerModule['runInProcessTeammate']>
}

async function startIdleTeammate(
  harness: Harness,
  name: string,
  teamName: string,
): Promise<StartedTeammate> {
  let state: AppState = getDefaultAppState()
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false },
    { setAppState },
  )
  if (
    !spawn.success ||
    !spawn.taskId ||
    !spawn.teammateContext ||
    !spawn.abortController
  ) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  const toolUseContext = {
    options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
    abortController: spawn.abortController,
    messages: [],
    readFileState: new Map(),
    getAppState: () => state,
    setAppState,
  } as unknown as ToolUseContext

  const done = harness.runner.runInProcessTeammate({
    identity: {
      agentId: spawn.agentId,
      agentName: name,
      teamName,
      planModeRequired: false,
      parentSessionId: spawn.teammateContext.parentSessionId,
    },
    taskId: spawn.taskId,
    teammateContext: spawn.teammateContext,
    toolUseContext,
    abortController: spawn.abortController,
  })
  return { abortController: spawn.abortController, done }
}

async function stopTeammate(started: StartedTeammate): Promise<void> {
  started.abortController.abort()
  await started.done
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** The request id the mailbox fallback just wrote into the lead's inbox. */
async function waitForPermissionRequestId(): Promise<string> {
  const deadline = Date.now() + 5000
  for (;;) {
    for (const m of await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)) {
      const parsed = isPermissionRequest(m.text)
      if (parsed) {
        return parsed.request_id
      }
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the permission request')
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Let the idle poll loop run several more rounds. */
async function letThePollLoopRun(harness: Harness): Promise<void> {
  const target = harness.sleeps + 4
  await waitFor(() => harness.sleeps >= target, 'the poll loop to keep polling')
}

test('a message that lands mid-turn reaches the teammate on its next round', async () => {
  const harness = await importRunnerWithMocks()
  writeSubTeamWorld()
  const subLead = await startIdleTeammate(harness, SUB_LEAD, PARENT_TEAM)
  try {
    harness.betweenRounds = async () => {
      // The failed hop, reproduced: the worker DMs its busy sub-lead.
      await writeToMailbox(
        SUB_LEAD,
        mail(PLAIN, 'build is red on main'),
        PARENT_TEAM,
      )
    }
    // The lead wakes the teammate — this is turn 1's prompt, via the idle loop.
    await writeToMailbox(
      SUB_LEAD,
      mail(TEAM_LEAD_NAME, 'start on the release'),
      PARENT_TEAM,
    )

    await waitFor(() => harness.roundInputs.length >= 2, 'two rounds to run')

    expect(harness.roundInputs[0]).toContain('start on the release')
    // The second round's input carries the message that arrived mid-turn.
    expect(harness.roundInputs[1]).toContain(
      '<teammate-message teammate_id="worker">\nbuild is red on main\n</teammate-message>',
    )

    // Marked read on disk...
    const inbox = await readMailbox(SUB_LEAD, PARENT_TEAM)
    expect(inbox.map(m => ({ text: m.text, read: m.read }))).toEqual([
      { text: 'start on the release', read: true },
      { text: 'build is red on main', read: true },
    ])

    // ...so the idle loop does not hand it over a second time as a new turn.
    await letThePollLoopRun(harness)
    expect(harness.turns).toBe(1)
    expect(
      harness.roundInputs.filter(i => i.includes('build is red')),
    ).toHaveLength(1)
  } finally {
    await stopTeammate(subLead)
  }
})

test("a sub-lead also gets its sub-team's team-lead inbox mid-turn", async () => {
  const harness = await importRunnerWithMocks()
  writeSubTeamWorld()
  const subLead = await startIdleTeammate(harness, SUB_LEAD, PARENT_TEAM)
  try {
    harness.betweenRounds = async () => {
      // A member of the sub-team addressed `team-lead`; from inside the sub-team
      // that is this sub-lead, and nothing else polls that inbox.
      await writeToMailbox(TEAM_LEAD_NAME, mail(PLAIN, 'task 3 is done'), SUB_TEAM)
    }
    await writeToMailbox(
      SUB_LEAD,
      mail(TEAM_LEAD_NAME, 'start on the release'),
      PARENT_TEAM,
    )

    await waitFor(() => harness.roundInputs.length >= 2, 'two rounds to run')

    expect(harness.roundInputs[1]).toContain(
      '<teammate-message teammate_id="worker">\ntask 3 is done\n</teammate-message>',
    )
    expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.read)).toEqual(
      [true],
    )
    // Own inbox first, then the sub-team's — the idle loop's order.
    expect(harness.attachmentInboxReads).toEqual([
      { agentName: SUB_LEAD, teamName: PARENT_TEAM },
      { agentName: TEAM_LEAD_NAME, teamName: SUB_TEAM },
    ])

    await letThePollLoopRun(harness)
    expect(harness.turns).toBe(1)
  } finally {
    await stopTeammate(subLead)
  }
})

test('a teammate that leads no sub-team never reads a sub-team inbox', async () => {
  const harness = await importRunnerWithMocks()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD_NAME },
    { agentId: `${PLAIN}@${PARENT_TEAM}`, name: PLAIN },
  ])
  const worker = await startIdleTeammate(harness, PLAIN, PARENT_TEAM)
  try {
    harness.betweenRounds = async () => {
      await writeToMailbox(PLAIN, mail(SUB_LEAD, 'status please'), PARENT_TEAM)
    }
    await writeToMailbox(
      PLAIN,
      mail(TEAM_LEAD_NAME, 'start on the release'),
      PARENT_TEAM,
    )

    await waitFor(() => harness.roundInputs.length >= 2, 'two rounds to run')

    expect(harness.roundInputs[1]).toContain('status please')
    // Exactly one inbox read, and it is its own: no sub-team file, no sub-team
    // mailbox, no disk read paid for by a teammate that leads nothing.
    expect(harness.attachmentInboxReads).toEqual([
      { agentName: PLAIN, teamName: PARENT_TEAM },
    ])
  } finally {
    await stopTeammate(worker)
  }
})

test('a shutdown request that lands mid-turn is left for the idle loop', async () => {
  const harness = await importRunnerWithMocks()
  writeSubTeamWorld()
  const subLead = await startIdleTeammate(harness, SUB_LEAD, PARENT_TEAM)
  try {
    harness.betweenRounds = async () => {
      await writeToMailbox(
        SUB_LEAD,
        mail(
          TEAM_LEAD_NAME,
          JSON.stringify(
            createShutdownRequestMessage({
              requestId: 'req-1',
              from: TEAM_LEAD_NAME,
            }),
          ),
        ),
        PARENT_TEAM,
      )
    }
    await writeToMailbox(
      SUB_LEAD,
      mail(TEAM_LEAD_NAME, 'start on the release'),
      PARENT_TEAM,
    )

    await waitFor(() => harness.roundInputs.length >= 2, 'two rounds to run')
    expect(harness.roundInputs[1]).toBe('')

    // The idle loop's shutdown scan still finds it, unread, after the turn.
    await waitFor(
      () => harness.turns >= 2,
      'the shutdown request to become the next turn',
    )
    expect(harness.roundInputs[2]).toContain('"type":"shutdown_request"')
  } finally {
    await stopTeammate(subLead)
  }
})

test("a permission response that lands mid-turn is left for the teammate's own poll", async () => {
  const harness = await importRunnerWithMocks()
  writeTeam(PARENT_TEAM, [
    { agentId: 'lead-id', name: TEAM_LEAD_NAME },
    { agentId: SUB_LEAD_AGENT_ID, name: SUB_LEAD },
  ])
  const subLead = await startIdleTeammate(harness, SUB_LEAD, PARENT_TEAM)
  try {
    // The permission poll is held from before it exists until the snapshot
    // below has been taken. Without that the assertion "still unread when the
    // drain finished" is a bet that a 500 ms timer does not tick during the
    // few milliseconds of disk work between the response landing and the
    // snapshot — true almost always, and a flake on a loaded machine. The poll
    // is not slowed down or stubbed out: it runs its real interval against the
    // real inbox the whole time, it just cannot recognise its answer yet.
    harness.blockingPermissionPoll = true
    const appState = getDefaultAppState()

    type PermissionDecision = Awaited<
      ReturnType<ReturnType<RunnerModule['createInProcessCanUseTool']>>
    >
    let decision: Promise<PermissionDecision> | undefined
    let decided: PermissionDecision | undefined
    let inboxAfterDrain: Array<{ from: string; read: boolean }> | undefined

    harness.betweenRounds = async () => {
      // The teammate hits a permission prompt mid-turn. No leader UI queue is
      // registered, so this takes the mailbox fallback: the request goes to the
      // lead and the teammate polls its OWN inbox for the answer
      // (inProcessRunner.ts:529-575). Deliberately not awaited — that poll is
      // the consumer the drain must not race.
      decision = harness.runner.createInProcessCanUseTool(
        {
          agentId: SUB_LEAD_AGENT_ID,
          agentName: SUB_LEAD,
          teamName: PARENT_TEAM,
          planModeRequired: false,
          parentSessionId: 'session-1',
        },
        subLead.abortController,
      )(
        {
          name: 'MidTurnTool',
          description: async () => 'needs approval',
        } as unknown as Tool,
        {},
        {
          getAppState: () => appState,
          options: { isNonInteractiveSession: false, tools: [] },
        } as never,
        {} as never,
        'tool-use-midturn',
        { behavior: 'ask', message: 'approval required' },
      )

      const requestId = await waitForPermissionRequestId()
      // The lead answers while the teammate is still inside the turn...
      await writeToMailbox(
        SUB_LEAD,
        mail(
          TEAM_LEAD_NAME,
          JSON.stringify(
            createPermissionResponseMessage({
              request_id: requestId,
              subtype: 'success',
            }),
          ),
        ),
        PARENT_TEAM,
      )
      // ...and DMs it as well, so the next round proves the drain really ran.
      await writeToMailbox(
        SUB_LEAD,
        mail(PLAIN, 'build is red on main'),
        PARENT_TEAM,
      )
    }

    harness.afterDrain = async () => {
      inboxAfterDrain = (await readMailbox(SUB_LEAD, PARENT_TEAM)).map(m => ({
        from: m.from,
        read: m.read,
      }))
      // The drain is done and the evidence is taken: let the poll have its
      // answer.
      harness.blockingPermissionPoll = false
      // Hold the turn open while the poll runs — the real shape of the wait: the
      // tool call is blocked on the response, so the idle loop (which would
      // otherwise take the response as the next prompt) is not running. The
      // timeout is a diagnostic bound, not a margin: nothing is asserted on
      // whether it wins, and the decision is awaited again below.
      await Promise.race([
        decision!.then(d => {
          decided = d
        }),
        new Promise<void>(resolve => setTimeout(resolve, 3000)),
      ])
    }

    await writeToMailbox(
      SUB_LEAD,
      mail(TEAM_LEAD_NAME, 'start on the release'),
      PARENT_TEAM,
    )

    await waitFor(() => harness.roundInputs.length >= 2, 'two rounds to run')
    await waitFor(
      () => inboxAfterDrain !== undefined,
      'the inbox snapshot taken right after the drain',
    )

    // The drain ran in that round and took the ordinary DM...
    expect(harness.roundInputs[1]).toContain(
      '<teammate-message teammate_id="worker">\nbuild is red on main\n</teammate-message>',
    )
    // ...and left the permission response for its own poll: not in the round's
    // input, and still unread on disk at the moment the drain finished — the
    // only other reader of that entry was held until this snapshot.
    expect(harness.roundInputs[1]).not.toContain('permission_response')
    expect(inboxAfterDrain).toEqual([
      { from: TEAM_LEAD_NAME, read: true }, // 'start on the release', turn 1
      { from: TEAM_LEAD_NAME, read: false }, // the permission response
      { from: PLAIN, read: true }, // the DM the drain delivered
    ])

    // And the poll does get it: the blocked tool call is answered, and only now
    // is the response read.
    await waitFor(
      () => decided !== undefined,
      'the permission poll to answer the tool call',
    )
    expect(decided).toMatchObject({ behavior: 'allow' })
    expect((await readMailbox(SUB_LEAD, PARENT_TEAM)).map(m => m.read)).toEqual([
      true,
      true,
      true,
    ])

    // Nothing became a second turn on the way.
    await letThePollLoopRun(harness)
    expect(harness.turns).toBe(1)
  } finally {
    await stopTeammate(subLead)
  }
})
