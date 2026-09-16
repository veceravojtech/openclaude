import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { ToolUseContext } from '../Tool.js'
import { asAgentId } from '../types/ids.js'
import { __test } from './attachments.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { normalizeAttachmentForAPI } from './messages.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { getTeamFilePath, type TeamFile } from './swarm/teamHelpers.js'
import {
  createIdleNotification,
  createPermissionResponseMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  readMailbox,
  writeToMailbox,
} from './teammateMailbox.js'
import { runWithTeammateContext } from './teammateContext.js'
import { createAgentId } from './uuid.js'

// T4/F1+F2. The per-tool-round `teammate_mailbox` attachment existed but was
// dead behind `process.env.USER_TYPE !== 'ant'`, so an in-process teammate
// read its own inbox only in the idle poll loop: a message sent to a BUSY
// teammate sat unread for the whole turn (user's manual test, team zeekr,
// worker -> supervisor). These pin the new teammate path at the attachment
// level: which inboxes it drains, the exact filter, the shape the model sees,
// and that the LEAD path is untouched.

const TEAM = 'zeekr'
const SUB_LEAD = 'supervisor'
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${TEAM}`
const SUB_TEAM = `${TEAM}/${SUB_LEAD}`

type MailboxModule = typeof import('./teammateMailbox.js')

let configDir: string | undefined
/** The real mailbox module, captured before the one test that mocks it. */
let actualMailbox: MailboxModule | undefined
const savedUserType = process.env.USER_TYPE
const savedDisable = process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.teammateMidTurn.test.ts')
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-midturn-attach-'))
  setClaudeConfigHomeDirForTesting(configDir)
  __test.resetSubTeamLeadershipCache()
})

afterEach(() => {
  try {
    if (actualMailbox) {
      mock.restore()
      mock.module('./teammateMailbox.js', () => ({ ...actualMailbox! }))
    }
    __test.resetSubTeamLeadershipCache()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
    if (savedUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = savedUserType
    }
    if (savedDisable === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
    } else {
      process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = savedDisable
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/** The team file TeamCreate's sub-team branch leaves behind. */
function writeTeamFile(
  name: string,
  leadAgentId: string,
  parent?: { parentTeam: string; parentAgentId: string },
): void {
  const teamFile: TeamFile = {
    name,
    createdAt: 0,
    leadAgentId,
    ...parent,
    members: [],
  }
  const path = getTeamFilePath(name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

/** writeToMailbox wants a full message; the timestamp is not under test. */
function mail(
  from: string,
  text: string,
  extra?: { color?: string; summary?: string },
): {
  from: string
  text: string
  timestamp: string
  color?: string
  summary?: string
} {
  return { from, text, timestamp: new Date().toISOString(), ...extra }
}

type Harness = {
  context: ToolUseContext
  state: () => AppState
}

/**
 * The tool-use context the drain under test reads: an `agentId`, and
 * getAppState/setAppState over one local AppState.
 *
 * `turnAgentId` is `undefined` for a MAIN LOOP — the lead's own turn, or a
 * tmux teammate's. Neither REPL.tsx's getToolUseContext nor QueryEngine.ts's
 * processUserInputContext puts an `agentId` on the context it builds; the
 * forks do — createSubagentContext and execAgentHook.
 */
function createHarness(
  turnAgentId: string | undefined,
  mutate?: (prev: AppState) => AppState,
): Harness {
  let state = getDefaultAppState()
  if (mutate) state = mutate(state)
  return {
    state: () => state,
    context: {
      agentId: turnAgentId,
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
    } as unknown as ToolUseContext,
  }
}

function runAsTeammate<T>(
  turnAgentId: string,
  agentName: string,
  teamName: string,
  fn: () => T,
): T {
  return runWithTeammateContext(
    {
      agentId: `${agentName}@${teamName}`,
      agentName,
      teamName,
      planModeRequired: false,
      parentSessionId: 'session-1',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: asAgentId(turnAgentId),
    },
    fn,
  )
}

async function drain(harness: Harness) {
  return await __test.getTeammateMailboxAttachments(harness.context)
}

function textsOf(attachments: Awaited<ReturnType<typeof drain>>): string[] {
  const first = attachments[0]
  if (!first || first.type !== 'teammate_mailbox') return []
  return first.messages.map(m => m.text)
}

test('a busy teammate is handed its own unread messages mid-turn, once', async () => {
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(SUB_LEAD, mail('worker', 'build is red'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(textsOf(attachments)).toEqual(['build is red'])
  // Marked read on disk, so neither the idle loop nor the next tool round
  // delivers it a second time.
  const inbox = await readMailbox(SUB_LEAD, TEAM)
  expect(inbox.map(m => m.read)).toEqual([true])

  const second = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )
  expect(second).toEqual([])
})

test('the model sees the same <teammate-message> shape the idle loop emits', async () => {
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(
    SUB_LEAD,
    mail('worker', 'build is red', { color: 'red', summary: 'ci status' }),
    TEAM,
  )

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )
  const rendered = normalizeAttachmentForAPI(attachments[0]!)
    .map(m => m.message.content)
    .join('')

  // The literal the runner's formatAsTeammateMessage emits for the same
  // message (inProcessRunner.ts) — spelled out rather than compared against
  // formatTeammateMessages, which is the very function this path renders
  // through and would agree with itself whatever it emitted.
  expect(rendered).toContain(
    '<teammate-message teammate_id="worker" color="red" summary="ci status">\nbuild is red\n</teammate-message>',
  )
})

test('protocol messages, idle notifications and shutdown rejections are left unread', async () => {
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(
    SUB_LEAD,
    mail(
      TEAM_LEAD_NAME,
      JSON.stringify(
        createShutdownRequestMessage({
          requestId: 'req-shutdown',
          from: TEAM_LEAD_NAME,
        }),
      ),
    ),
    TEAM,
  )
  await writeToMailbox(
    SUB_LEAD,
    mail(
      TEAM_LEAD_NAME,
      JSON.stringify(
        createPermissionResponseMessage({
          request_id: 'req-1',
          subtype: 'success',
        }),
      ),
    ),
    TEAM,
  )
  await writeToMailbox(
    SUB_LEAD,
    mail(
      'worker',
      JSON.stringify(
        createIdleNotification('worker', { idleReason: 'available' }),
      ),
    ),
    TEAM,
  )
  await writeToMailbox(
    SUB_LEAD,
    mail(
      TEAM_LEAD_NAME,
      JSON.stringify(
        createShutdownRejectedMessage({
          requestId: 'req-shutdown',
          from: TEAM_LEAD_NAME,
          reason: 'keep working',
        }),
      ),
    ),
    TEAM,
  )
  await writeToMailbox(SUB_LEAD, mail(TEAM_LEAD_NAME, 'keep going'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(textsOf(attachments)).toEqual(['keep going'])
  const inbox = await readMailbox(SUB_LEAD, TEAM)
  expect(inbox.map(m => m.read)).toEqual([false, false, false, false, true])
})

test('a sub-lead also drains its sub-team team-lead inbox, own inbox first', async () => {
  writeTeamFile(TEAM, 'lead-id')
  writeTeamFile(SUB_TEAM, `${TEAM_LEAD_NAME}@${SUB_TEAM}`, {
    parentTeam: TEAM,
    parentAgentId: SUB_LEAD_AGENT_ID,
  })
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(
    TEAM_LEAD_NAME,
    mail('worker', 'sub-team report'),
    SUB_TEAM,
  )
  await writeToMailbox(SUB_LEAD, mail(TEAM_LEAD_NAME, 'own inbox'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(textsOf(attachments)).toEqual(['own inbox', 'sub-team report'])
  expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.read)).toEqual(
    [true],
  )
})

test('a teammate that leads no sub-team drains only its own inbox', async () => {
  writeTeamFile(TEAM, 'lead-id')
  // The sub-team directory exists but records a DIFFERENT parent: not led here.
  writeTeamFile(SUB_TEAM, `${TEAM_LEAD_NAME}@${SUB_TEAM}`, {
    parentTeam: TEAM,
    parentAgentId: `someone-else@${TEAM}`,
  })
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(TEAM_LEAD_NAME, mail('worker', 'not yours'), SUB_TEAM)
  await writeToMailbox(SUB_LEAD, mail(TEAM_LEAD_NAME, 'own inbox'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(textsOf(attachments)).toEqual(['own inbox'])
  expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.read)).toEqual(
    [false],
  )
})

test('a subagent spawned inside the turn does not steal the teammate inbox', async () => {
  const turnAgentId = createAgentId()
  const subagentId = createAgentId()
  const harness = createHarness(subagentId)
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(attachments).toEqual([])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([false])
})

test('nor does it under `ant`, where the lead path below would run', async () => {
  // The twin above passes for every user type EXCEPT the one the lead path is
  // gated on, which `beforeEach` deletes. Under `ant` a `undefined` answer
  // here falls through to that path, which resolves its agent name from
  // `getAgentName()` — the ambient identity the subagent INHERITED from the
  // teammate that spawned it — and would hand the subagent its spawner's mail
  // and mark it read on disk.
  process.env.USER_TYPE = 'ant'
  const turnAgentId = createAgentId()
  const subagentId = createAgentId()
  const harness = createHarness(subagentId)
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(attachments).toEqual([])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([false])
})

/**
 * The AppState a LEAD has while a teammate's transcript is open.
 *
 * The `teamContext` is load-bearing rather than scenery: the lead path takes
 * its team name from `getTeamName(appState.teamContext)`, so without one it
 * opens the NON-team inbox, which nothing here writes to — and every assertion
 * about the viewed teammate's inbox would then hold whatever that path did.
 *
 * `turnAgentId` defaults to absent, which is what a lead's own turn has: an
 * `agentId` on the context means a subagent (Tool.ts), and the callers
 * below that DO want one — a teammate's turn, a lead-spawned subagent — pass
 * it explicitly.
 */
function createViewingHarness(
  viewedName: string,
  turnAgentId?: string,
): Harness {
  const viewedTask = {
    type: 'in_process_teammate',
    identity: {
      agentId: `${viewedName}@${TEAM}`,
      agentName: viewedName,
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
  } as unknown as InProcessTeammateTaskState
  return createHarness(turnAgentId, prev => ({
    ...prev,
    viewingAgentTaskId: 'task-viewed',
    tasks: { ...prev.tasks, 'task-viewed': viewedTask },
    teamContext: {
      teamName: TEAM,
      teamFilePath: getTeamFilePath(TEAM),
      leadAgentId: 'lead-id',
      teammates: {},
    },
  }))
}

test("the lead's own turn takes nothing from a viewed teammate's inbox", async () => {
  const harness = createViewingHarness(SUB_LEAD)
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  // No ambient teammate context: this is the lead's own turn, and for a
  // non-`ant` user the lead path below the gate never runs at all.
  const attachments = await drain(harness)

  expect(attachments).toEqual([])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([false])
})

test("an `ant` lead's own turn still drains the viewed teammate's inbox", async () => {
  // Deleted for every other case in beforeEach, restored in afterEach.
  process.env.USER_TYPE = 'ant'
  const harness = createViewingHarness(SUB_LEAD)
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  const attachments = await drain(harness)

  // Exactly what `128f26cc` did, and the one thing this change could have
  // broken: the teammate path returns `undefined` — not `[]` — on a lead's
  // turn precisely so the lead path still runs here.
  expect(textsOf(attachments)).toEqual(['for the teammate'])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([true])
})

/**
 * The AppState a LEAD has with no teammate transcript open.
 *
 * The second thing the lead path can drain: with no `viewedTeammate`,
 * `agentName` falls back to the lead's own name — `isTeamLead(teamContext)` is
 * true for a context with no ambient agent id, and the name then resolves
 * `teammates[leadAgentId]?.name || 'team-lead'`. `teammates`
 * maps the LEAD's teammates, so it holds no entry for `leadAgentId` and the
 * fallback is what a real lead takes — hence TEAM_LEAD_NAME's inbox below.
 */
function createLeadHarness(
  turnAgentId?: string,
  inbox?: AppState['inbox'],
): Harness {
  return createHarness(turnAgentId, prev => ({
    ...prev,
    ...(inbox ? { inbox } : {}),
    teamContext: {
      teamName: TEAM,
      teamFilePath: getTeamFilePath(TEAM),
      leadAgentId: 'lead-id',
      teammates: {},
    },
  }))
}

/** One message useInboxPoller queued on the lead mid-turn, still pending. */
function pendingInbox(text: string): AppState['inbox'] {
  return {
    messages: [
      {
        id: 'inbox-1',
        from: 'worker',
        text,
        timestamp: new Date().toISOString(),
        status: 'pending' as const,
      },
    ],
  }
}

test("an `ant` lead's own turn still drains its own inbox", async () => {
  // The lead path's OTHER mail source, pinned so the T9 guard below cannot
  // take it with it: the guard must stop a subagent, not the lead.
  process.env.USER_TYPE = 'ant'
  const harness = createLeadHarness()
  await writeToMailbox(TEAM_LEAD_NAME, mail('worker', 'for the lead'), TEAM)

  const attachments = await drain(harness)

  expect(textsOf(attachments)).toEqual(['for the lead'])
  expect((await readMailbox(TEAM_LEAD_NAME, TEAM)).map(m => m.read)).toEqual([
    true,
  ])
})

test("a lead-spawned subagent takes nothing from the lead's own inbox", async () => {
  // T9. The twin of the teammate-spawned case above, for the other spawner. A
  // subagent the LEAD spawned has its own `agentId` but NO ambient teammate
  // context, so the mid-turn guard returns `undefined` for it and it used to
  // fall through to the `ant` lead path — which resolved the lead's own name
  // from `teamContext` and handed the subagent the lead's mail, marking it
  // read so the lead never saw it.
  process.env.USER_TYPE = 'ant'
  const harness = createLeadHarness(createAgentId())
  await writeToMailbox(TEAM_LEAD_NAME, mail('worker', 'for the lead'), TEAM)

  const attachments = await drain(harness)

  expect(attachments).toEqual([])
  expect((await readMailbox(TEAM_LEAD_NAME, TEAM)).map(m => m.read)).toEqual([
    false,
  ])
})

test("a lead-spawned subagent takes nothing from the viewed teammate's inbox", async () => {
  // T9, the lead path's second mail source. `getViewedTeammateTask` resolves
  // against the AppState the subagent shares with the lead, so whichever
  // teammate the lead happens to be VIEWING is the one whose inbox the
  // subagent drained.
  process.env.USER_TYPE = 'ant'
  const harness = createViewingHarness(SUB_LEAD, createAgentId())
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  const attachments = await drain(harness)

  expect(attachments).toEqual([])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([false])
})

test("an `ant` lead's own turn still drains AppState.inbox", async () => {
  // The lead path's THIRD mail source, and the only one that is not on disk:
  // useInboxPoller queues a message onto `appState.inbox` mid-turn and the lead
  // path hands it over without waiting for the turn to end, flipping it to
  // `processed` so the poller does not deliver it twice. Pinned so the T9 guard
  // is shown to leave this source alone for the lead.
  process.env.USER_TYPE = 'ant'
  const harness = createLeadHarness(undefined, pendingInbox('queued mid-turn'))

  const attachments = await drain(harness)

  expect(textsOf(attachments)).toEqual(['queued mid-turn'])
  expect(harness.state().inbox.messages.map(m => m.status)).toEqual([
    'processed',
  ])
})

test('a lead-spawned subagent takes nothing from AppState.inbox', async () => {
  // T9, the lead path's third mail source. `appState.inbox` holds the messages
  // queued FOR THE LEAD, and a fork reads the same AppState its spawner does —
  // so without the guard it was handed them. The `processed` flip lands only
  // where setAppState is shared — a SYNC subagent like this one, not a
  // background one, whose setAppState is a no-op. For that one the leak is the
  // read alone.
  process.env.USER_TYPE = 'ant'
  const harness = createLeadHarness(
    createAgentId(),
    pendingInbox('queued mid-turn'),
  )

  const attachments = await drain(harness)

  expect(attachments).toEqual([])
  expect(harness.state().inbox.messages.map(m => m.status)).toEqual(['pending'])
})

test("a teammate's turn ignores whichever teammate the lead is viewing", async () => {
  const viewedTask = {
    type: 'in_process_teammate',
    identity: {
      agentId: `other@${TEAM}`,
      agentName: 'other',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
  } as unknown as InProcessTeammateTaskState
  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId, prev => ({
    ...prev,
    viewingAgentTaskId: 'task-other',
    tasks: { ...prev.tasks, 'task-other': viewedTask },
  }))
  await writeToMailbox(SUB_LEAD, mail('worker', 'mine'), TEAM)
  await writeToMailbox('other', mail('worker', 'theirs'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  expect(textsOf(attachments)).toEqual(['mine'])
  expect((await readMailbox('other', TEAM)).map(m => m.read)).toEqual([false])
})

test("an `ant` teammate's turn takes its own inbox, not the viewed one", async () => {
  process.env.USER_TYPE = 'ant'
  const turnAgentId = createAgentId()
  const harness = createViewingHarness('other', turnAgentId)
  await writeToMailbox(SUB_LEAD, mail('worker', 'mine'), TEAM)
  await writeToMailbox('other', mail('worker', 'theirs'), TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    drain(harness),
  )

  // The case the `ant` lead path gets wrong on a teammate's round: there
  // `viewedTeammate` outranks the ambient identity, so without the early
  // return this teammate would be handed `other`'s mail and have its own left
  // unread. The non-`ant` twin above cannot see that — the gate stops it.
  expect(textsOf(attachments)).toEqual(['mine'])
  expect((await readMailbox('other', TEAM)).map(m => m.read)).toEqual([false])
})

test('a duplicate that lands between the read and the mark stays unread', async () => {
  // F5. Two identical messages from one sender in one millisecond are one
  // (from, timestamp, text): keyed marking could not tell them apart, so a
  // twin that landed after the read and before the mark was marked read
  // without ever being delivered. The mark is by index now, and this drops the
  // twin into exactly that window — the mark call itself — through both mark
  // paths, so the same test is red against either spelling of the old code.
  const stamp = `${Date.now()}-${Math.random()}`
  actualMailbox ??= await import(`./teammateMailbox.ts?markWindowActual=${stamp}`)
  const message = mail('worker', 'build is red')
  let injected = false
  const injectTwin = async (): Promise<void> => {
    if (injected) return
    injected = true
    await actualMailbox!.writeToMailbox(SUB_LEAD, message, TEAM)
  }
  mock.module('./teammateMailbox.js', () => ({
    ...actualMailbox!,
    markMessageAsReadByIndex: async (
      agentName: string,
      teamName: string | undefined,
      index: number,
    ) => {
      await injectTwin()
      return actualMailbox!.markMessageAsReadByIndex(agentName, teamName, index)
    },
    markMessagesAsReadByPredicate: async (
      agentName: string,
      predicate: Parameters<MailboxModule['markMessagesAsReadByPredicate']>[1],
      teamName?: string,
    ) => {
      await injectTwin()
      return actualMailbox!.markMessagesAsReadByPredicate(
        agentName,
        predicate,
        teamName,
      )
    },
  }))
  const freshAttachments = (await import(
    `./attachments.ts?markWindow=${stamp}`
  )) as typeof import('./attachments.js')

  const turnAgentId = createAgentId()
  const harness = createHarness(turnAgentId)
  await writeToMailbox(SUB_LEAD, message, TEAM)

  const attachments = await runAsTeammate(turnAgentId, SUB_LEAD, TEAM, () =>
    freshAttachments.__test.getTeammateMailboxAttachments(harness.context),
  )

  expect(injected).toBe(true)
  expect(textsOf(attachments)).toEqual(['build is red'])
  // The twin is still unread, so the next tool round delivers it.
  expect(
    (await readMailbox(SUB_LEAD, TEAM)).map(m => ({
      text: m.text,
      read: m.read,
    })),
  ).toEqual([
    { text: 'build is red', read: true },
    { text: 'build is red', read: false },
  ])
})
