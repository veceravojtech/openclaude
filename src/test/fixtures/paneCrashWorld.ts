/**
 * A lead with one tmux pane teammate that has claimed team task #1, on real
 * files in an isolated config home: the team file, the task list, the
 * mailboxes, the attention store and the task output file are all real. Only
 * tmux is injected — whether the member's pane is present.
 *
 * Shared by the sweep-level test (paneCrashPath.test.ts) and the
 * inbox-poller-level test (useInboxPoller.paneCrash.test.tsx), so both assert
 * the same crash outcome and the same clean release.
 */
import { expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { ListAgentsTool } from '../../tools/ListAgentsTool/ListAgentsTool.js'
import { registerOutOfProcessTeammateTask } from '../../tools/shared/spawnMultiAgent.js'
import {
  checkAttentionSpawnGate,
  listAttentionItems,
  settleAttentionWritesForTesting,
} from '../../utils/attentionItems.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import {
  getTeamSweeper,
  PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR,
  PANE_GONE_LINE,
  type PaneTeammateWatchdogDeps,
  type PaneTeammateWatchdogHandle,
} from '../../utils/swarm/backends/paneTeammateWatchdog.js'
import type { PanePresence } from '../../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { getTeamFilePath, readTeamFile } from '../../utils/swarm/teamHelpers.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { claimTask, createTask, getTask } from '../../utils/tasks.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'

export const CRASH_TEAM = 'crashteam'
export const CRASH_MATE = 'crasher'
export const CRASH_MATE_ID = `${CRASH_MATE}@${CRASH_TEAM}`
export const CRASH_LEAD_ID = `${TEAM_LEAD_NAME}@${CRASH_TEAM}`
export const CRASH_PANE = '%7'
const SESSION = 'crash-path-session'
/** The root lead's own task list: where its attention items live. */
export const CRASH_LEAD_LIST = 'crash-path-lead-list'

/** Config home, lead list, team file and team task #1 (claimed by the mate). */
export async function setUpPaneCrashFiles(
  options: {
    /** A legacy member row: no `joinedAt`. */
    legacyMember?: boolean
    /** The team file's `createdAt`; `null` leaves it out. */
    teamCreatedAt?: number | null
  } = {},
): Promise<{
  configDir: string
  teardown: () => Promise<void>
}> {
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-pane-crash-'))
  setClaudeConfigHomeDirForTesting(configDir)
  const previousList = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = CRASH_LEAD_LIST
  const teamFilePath = getTeamFilePath(CRASH_TEAM)
  mkdirSync(dirname(teamFilePath), { recursive: true })
  writeFileSync(
    teamFilePath,
    JSON.stringify({
      name: CRASH_TEAM,
      ...(options.teamCreatedAt === null
        ? {}
        : { createdAt: options.teamCreatedAt ?? Date.now() }),
      leadAgentId: CRASH_LEAD_ID,
      leadSessionId: SESSION,
      members: [
        {
          agentId: CRASH_LEAD_ID,
          name: TEAM_LEAD_NAME,
          joinedAt: Date.now() - 60_000,
          tmuxPaneId: '',
          cwd: configDir,
          subscriptions: [],
        },
        {
          agentId: CRASH_MATE_ID,
          name: CRASH_MATE,
          ...(options.legacyMember ? {} : { joinedAt: Date.now() - 5_000 }),
          tmuxPaneId: CRASH_PANE,
          tmuxSocket: 'crash-sock',
          backendType: 'tmux',
          cwd: configDir,
          subscriptions: [],
          isActive: true,
        },
      ],
    }),
  )
  await createTask(CRASH_TEAM, {
    subject: 'heartbeat work',
    description: 'loop',
    status: 'in_progress',
    owner: CRASH_MATE,
    blocks: [],
    blockedBy: [],
  })
  return {
    configDir,
    teardown: async () => {
      getTeamSweeper(CRASH_TEAM)?.dispose()
      await settleAttentionWritesForTesting()
      if (previousList === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousList
      setClaudeConfigHomeDirForTesting(undefined)
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}

/** The lead's AppState: its team context names the pane teammate. */
export function crashLeadState(configDir: string): AppState {
  return {
    ...getDefaultAppState(),
    teamContext: {
      teamName: CRASH_TEAM,
      teamFilePath: getTeamFilePath(CRASH_TEAM),
      leadAgentId: CRASH_LEAD_ID,
      teammates: {
        [CRASH_MATE_ID]: {
          name: CRASH_MATE,
          tmuxSessionName: 'lead',
          tmuxPaneId: CRASH_PANE,
          cwd: configDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }
}

/**
 * The spawn's registration: the task row plus its real watchdog and the real
 * team sweeper, with only the tmux probes injected and no timers (tests scan).
 */
export function registerCrasher(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  pane: { state: PanePresence },
  /** Extra watchdog deps (a clock, a failing flush, a fake crash hand-off). */
  extraDeps: PaneTeammateWatchdogDeps = {},
): PaneTeammateWatchdogHandle {
  return registerOutOfProcessTeammateTask(
    setAppState,
    {
      teammateId: CRASH_MATE_ID,
      sanitizedName: CRASH_MATE,
      teamName: CRASH_TEAM,
      teammateColor: 'red',
      prompt: 'Create a task, claim it, then run a heartbeat loop.',
      paneId: CRASH_PANE,
      tmuxSocket: 'crash-sock',
      backendType: 'tmux',
      toolUseId: 'toolu_spawn',
    },
    {
      currentSessionId: SESSION,
      probePane: async () => (pane.state === 'absent' ? 'dead' : 'alive'),
      probeMemberPanePresence: async () => pane.state,
      capturePaneTail: async () => null,
      discoverReachableSockets: async () => ['crash-sock'],
      scanIntervalMs: null,
      ...extraDeps,
    },
  )
}

/** Write one JSON protocol message in the real mailbox file format. */
export async function mailJson(
  to: string,
  from: string,
  payload: object,
  timestamp = new Date().toISOString(),
): Promise<void> {
  await writeToMailbox(
    to,
    { from, text: JSON.stringify(payload), timestamp },
    CRASH_TEAM,
  )
}

/** The pane dies; the team sweeper confirms it on two consecutive scans. */
export async function killPaneAndSweep(pane: { state: PanePresence }): Promise<void> {
  pane.state = 'absent'
  const sweeper = getTeamSweeper(CRASH_TEAM)
  if (!sweeper) throw new Error('no team sweeper armed')
  await sweeper.scan()
  await sweeper.scan()
  await settleAttentionWritesForTesting()
}

export function crasherTaskId(state: AppState): string {
  const row = Object.values(state.tasks).find(
    t => t.type === 'in_process_teammate' && t.identity.agentId === CRASH_MATE_ID,
  )
  if (!row) throw new Error('no task row for the teammate')
  return row.id
}

export function crasherRow(state: AppState): { status: string; error?: string } {
  return state.tasks[crasherTaskId(state)] as unknown as {
    status: string
    error?: string
  }
}

export function notificationsFor(taskId: string, status?: string): string[] {
  return getCommandQueue()
    .map(cmd => String(cmd.value))
    .filter(
      text =>
        text.includes(`<task-id>${taskId}</task-id>`) &&
        (status === undefined || text.includes(`<status>${status}</status>`)),
    )
}

export function terminatedMessages(state: AppState): string[] {
  return state.inbox.messages
    .map(m => m.text)
    .filter(text => text.includes('teammate_terminated'))
}

function onRoster(): boolean {
  return (readTeamFile(CRASH_TEAM)?.members ?? []).some(
    m => m.agentId === CRASH_MATE_ID,
  )
}

/**
 * An unrequested pane death, as Phases 3 and 5 promise it: a failed row, ONE
 * failed task-notification whose output file holds the reason and says the
 * pane could not be read, ONE undecided transient item, task #1 held for it
 * (claim refused, spawn gate closed), off the roster with no contradictory
 * "has shut down", and still listed by ListAgents as failed.
 */
export async function expectCrashOutcome(state: () => AppState): Promise<{
  taskId: string
  output: string
}> {
  const taskId = crasherTaskId(state())
  const itemId = `failure-${taskId}-0`

  expect(crasherRow(state()).status).toBe('failed')
  expect(crasherRow(state()).error).toBe(PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR)

  const failed = notificationsFor(taskId, 'failed')
  expect(failed).toHaveLength(1)
  expect(failed[0]).toContain(PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR)
  expect(failed[0]).toContain(`<output-file>${getTaskOutputPath(taskId)}`)
  const output = readFileSync(getTaskOutputPath(taskId), 'utf8')
  expect(output).toContain(PANE_CLOSED_WITHOUT_SHUTDOWN_ERROR)
  expect(output).toContain(PANE_GONE_LINE)

  const items = await listAttentionItems(CRASH_LEAD_LIST)
  expect(items.map(i => i.id)).toEqual([itemId])
  expect(items[0]).toMatchObject({
    kind: 'failure',
    status: 'undecided',
    transient: true,
    transientReason: 'pane exited (dead pane)',
    source: {
      taskId,
      backend: 'pane',
      agentId: CRASH_MATE_ID,
      agentName: CRASH_MATE,
      teamName: CRASH_TEAM,
    },
  })

  const task = await getTask(CRASH_TEAM, '1')
  expect(task?.owner).toBeUndefined()
  expect(task?.status).toBe('pending')
  expect(task?.metadata?.attentionHold).toBe(itemId)
  expect(await claimTask(CRASH_TEAM, '1', 'someone-else')).toMatchObject({
    success: false,
    reason: 'held_for_decision',
  })
  expect(await checkAttentionSpawnGate(CRASH_LEAD_LIST)).toContain(itemId)

  expect(onRoster()).toBe(false)
  expect(state().teamContext?.teammates[CRASH_MATE_ID]).toBeUndefined()
  expect(terminatedMessages(state())).toEqual([])

  const { data } = await ListAgentsTool.call({}, {
    getAppState: state,
  } as unknown as ToolUseContext)
  expect(data.agents.find(a => a.agentId === CRASH_MATE_ID)).toMatchObject({
    status: 'failed',
    source: 'attention_item',
    taskId,
    attentionItemId: itemId,
  })
  return { taskId, output }
}

/**
 * A requested shutdown, as today: no failed notification, no item, task #1
 * released WITHOUT a hold (claimable), spawn gate open, off the roster.
 */
export async function expectCleanRelease(state: () => AppState): Promise<void> {
  const taskId = crasherTaskId(state())
  expect(notificationsFor(taskId, 'failed')).toEqual([])
  expect(await listAttentionItems(CRASH_LEAD_LIST)).toEqual([])
  const task = await getTask(CRASH_TEAM, '1')
  expect(task?.owner).toBeUndefined()
  expect(task?.status).toBe('pending')
  expect(task?.metadata?.attentionHold).toBeUndefined()
  expect(await checkAttentionSpawnGate(CRASH_LEAD_LIST)).toBeUndefined()
  expect(crasherRow(state()).status).not.toBe('failed')
  expect(onRoster()).toBe(false)
}
