import { afterEach, beforeEach, expect, test } from 'bun:test'
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
  formatTeammateMessages,
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

let configDir: string | undefined
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

/** A tool-use context as runAgent builds it for the teammate's own turn. */
function createHarness(
  turnAgentId: string,
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

  // inProcessRunner.formatAsTeammateMessage emits exactly this for the same
  // message; formatTeammateMessages is the shared spelling of it.
  expect(rendered).toContain(
    '<teammate-message teammate_id="worker" color="red" summary="ci status">\nbuild is red\n</teammate-message>',
  )
  expect(rendered).toContain(
    formatTeammateMessages([
      {
        from: 'worker',
        text: 'build is red',
        timestamp: 'ignored',
        color: 'red',
        summary: 'ci status',
      },
    ]),
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

test("the lead's own turn takes nothing from a viewed teammate's inbox", async () => {
  const viewedTask = {
    type: 'in_process_teammate',
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
  } as unknown as InProcessTeammateTaskState
  const harness = createHarness(createAgentId(), prev => ({
    ...prev,
    viewingAgentTaskId: 'task-1',
    tasks: { ...prev.tasks, 'task-1': viewedTask },
  }))
  await writeToMailbox(SUB_LEAD, mail('worker', 'for the teammate'), TEAM)

  // No ambient teammate context: this is the lead's own turn.
  const attachments = await drain(harness)

  expect(attachments).toEqual([])
  expect((await readMailbox(SUB_LEAD, TEAM)).map(m => m.read)).toEqual([false])
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
