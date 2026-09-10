import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getTeamsDir, setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createTask, getTasksDir } from '../tasks.js'
import { readMailbox, writeToMailbox } from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import {
  adoptOrphanedSubTeam,
  classifySubTeamState,
  collectSubTeamRecoveryInfo,
  noteSubLeadFailure,
  notifyAdoptedMembers,
  readSubTeamRecoveryInfo,
  resolveUpwardInboxTeam,
} from './subTeamRecovery.js'
import {
  cleanupTeamTree,
  getNaturalSubLeadAgentId,
  getTeamDir,
  getTeamFilePath,
  readSubTeamLedBySync,
  readTeamFile,
  reattachSubTeamToLead,
  registerTeamForSessionCleanup,
  type TeamFile,
} from './teamHelpers.js'

// U9: the runner's FAILURE path is the one terminal path that leaves a
// sub-team behind — its members keep working and keep writing an inbox nobody
// reads. These pin the detection that records it, the four derived states, the
// adopt path (members' reports move to the lead above them, and move back when
// a new sub-lead takes over), the `parentAgentId` re-point that is the whole
// on-disk transition, and that no path leaves an orphan directory.

const PARENT_TEAM = 'email'
const SUB_LEAD = 'supervisor'
const SUB_TEAM = `${PARENT_TEAM}/${SUB_LEAD}`
const SUB_LEAD_AGENT_ID = `${SUB_LEAD}@${PARENT_TEAM}`
const ROOT_LEAD_AGENT_ID = `${TEAM_LEAD_NAME}@${PARENT_TEAM}`
const WORKER = 'worker'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/subTeamRecovery.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-recovery-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/** Writes the team file a real TeamCreate would leave behind. */
function writeTeam(
  teamName: string,
  members: Array<{ agentId: string; name: string; worktreePath?: string }>,
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
      worktreePath: m.worktreePath,
      subscriptions: [],
    })),
  }
  const path = getTeamFilePath(teamName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
}

/** The root team plus the sub-team `supervisor` leads, as U3 records them. */
function writeSubTeamWorld(): void {
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
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

type World = {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}

function createWorld(): World {
  let state: AppState = getDefaultAppState()
  return {
    getState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

/** Registers a running teammate task in AppState, as a real spawn does. */
async function registerTeammate(
  world: World,
  name: string,
  teamName: string,
): Promise<string> {
  const spawn = await spawnInProcessTeammate(
    { name, teamName, planModeRequired: false, prompt: 'work' },
    { setAppState: world.setAppState },
  )
  if (!spawn.success || !spawn.taskId) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  return spawn.taskId
}

/** What the runner's failure path leaves in AppState: a terminal task. */
function markTaskFailed(world: World, taskId: string): void {
  world.setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    const failed: InProcessTeammateTaskState = {
      ...task,
      status: 'failed',
      isIdle: true,
      error: 'boom',
    }
    return { ...prev, tasks: { ...prev.tasks, [taskId]: failed } }
  })
}

/**
 * What the runner's failure path leaves in AppState SINCE the teammates tree got
 * its 30s row grace: the same terminal task, plus the retain/grace pair that
 * keeps its row on screen. The row is visible; the teammate is not live.
 */
function markTaskFailedInGrace(world: World, taskId: string): void {
  markTaskFailed(world, taskId)
  world.setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') return prev
    const inGrace: InProcessTeammateTaskState = {
      ...task,
      notified: true,
      retain: false,
      evictAfter: Date.now() + 30_000,
    }
    return { ...prev, tasks: { ...prev.tasks, [taskId]: inGrace } }
  })
}

function stateOf(teamName: string, world: World): string | undefined {
  const teamFile = readTeamFile(teamName)
  return teamFile
    ? classifySubTeamState(teamFile, world.getState().tasks)
    : undefined
}

test('getNaturalSubLeadAgentId names the one teammate that can lead a sub-team', () => {
  expect(getNaturalSubLeadAgentId('email/supervisor')).toBe('supervisor@email')
  expect(getNaturalSubLeadAgentId('a/b/deputy')).toBe('deputy@a/b')
  // A root team has no leading teammate at all.
  expect(getNaturalSubLeadAgentId('email')).toBeUndefined()
  expect(getNaturalSubLeadAgentId('email/')).toBeUndefined()
})

test('a failed sub-lead still inside its row-grace window is orphaned, not respawning', async () => {
  // hasLiveTaskFor keys on isTerminalTaskStatus, and the grace pair does not
  // touch the status — so a sub-lead whose row is still drawn (dimmed, reading
  // `failed`) is NOT a live lead, and the sub-team below it is an orphan that
  // recovery must act on now rather than 30 seconds from now.
  const world = createWorld()
  writeSubTeamWorld()
  const leadTaskId = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    reason: 'boom',
    tasks: world.getState().tasks,
  })
  expect(stateOf(SUB_TEAM, world)).toBe('respawning')

  markTaskFailedInGrace(world, leadTaskId)
  const graced = world.getState().tasks[leadTaskId]
  expect(graced?.status).toBe('failed')
  expect((graced as InProcessTeammateTaskState).evictAfter).toBeGreaterThan(Date.now())
  expect(stateOf(SUB_TEAM, world)).toBe('orphaned')
})

test('classifySubTeamState derives led, orphaned, adopted and respawning', async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const leadTaskId = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)

  // A live lead with no failure record: the normal state.
  expect(stateOf(SUB_TEAM, world)).toBe('led')

  // A failure record while the lead's task is still live is the window inside
  // a respawn — the lead is back but the re-attach has not run yet.
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    reason: 'boom',
    tasks: world.getState().tasks,
  })
  expect(stateOf(SUB_TEAM, world)).toBe('respawning')

  // The same record with no live task is an orphan.
  markTaskFailed(world, leadTaskId)
  expect(stateOf(SUB_TEAM, world)).toBe('orphaned')

  // A caretaker in parentAgentId is an adoption, whatever the tasks say.
  await adoptOrphanedSubTeam(SUB_TEAM)
  expect(stateOf(SUB_TEAM, world)).toBe('adopted')
})

test('reattachSubTeamToLead re-points parentAgentId and clears the record for a natural lead', async () => {
  writeSubTeamWorld()
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    turnAgentId: 'a00112233445566778',
    reason: 'boom',
    tasks: {},
  })
  expect(readTeamFile(SUB_TEAM)?.orphanedLead?.turnAgentId).toBe(
    'a00112233445566778',
  )

  // Adopt first, so the re-attach has a real re-point to perform.
  await adoptOrphanedSubTeam(SUB_TEAM)
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(ROOT_LEAD_AGENT_ID)

  const result = await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)
  expect(result).toMatchObject({
    ok: true,
    subTeamName: SUB_TEAM,
    previousLeadAgentId: ROOT_LEAD_AGENT_ID,
    newLeadAgentId: SUB_LEAD_AGENT_ID,
    isNaturalLead: true,
    clearedOrphanRecord: true,
  })

  const teamFile = readTeamFile(SUB_TEAM)
  expect(teamFile?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(teamFile?.orphanedLead).toBeUndefined()
  // parentTeam is never re-pointed: it is what the teardown scan descends by.
  expect(teamFile?.parentTeam).toBe(PARENT_TEAM)
  // The sub-lead can lead it again, so the U7 kill cascade owns it once more.
  expect(
    readSubTeamLedBySync({
      agentId: SUB_LEAD_AGENT_ID,
      name: SUB_LEAD,
      isTeammate: true,
    })?.name,
  ).toBe(SUB_TEAM)

  // Idempotent: re-attaching to the lead already recorded succeeds.
  const again = await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)
  expect(again).toMatchObject({
    ok: true,
    previousLeadAgentId: SUB_LEAD_AGENT_ID,
    clearedOrphanRecord: false,
  })
})

test('reattachSubTeamToLead keeps the failure record for a caretaker and preserves every other field', async () => {
  writeSubTeamWorld()
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    turnAgentId: 'a00112233445566778',
    reason: 'boom',
    tasks: {},
  })
  const before = readTeamFile(SUB_TEAM)!

  const result = await reattachSubTeamToLead(SUB_TEAM, ROOT_LEAD_AGENT_ID)
  expect(result).toMatchObject({
    ok: true,
    isNaturalLead: false,
    clearedOrphanRecord: false,
  })

  const after = readTeamFile(SUB_TEAM)!
  // An adopted sub-team has a caretaker, not a lead: the record stays, which
  // is how a later respawn still finds the transcript to resume from.
  expect(after.orphanedLead).toEqual(before.orphanedLead)
  expect(after.parentAgentId).toBe(ROOT_LEAD_AGENT_ID)
  // Only parentAgentId moved.
  expect({ ...after, parentAgentId: undefined }).toEqual({
    ...before,
    parentAgentId: undefined,
  })
})

test('reattachSubTeamToLead refuses a root team, a missing file and a squatted directory', async () => {
  expect(await reattachSubTeamToLead(PARENT_TEAM, ROOT_LEAD_AGENT_ID)).toEqual({
    ok: false,
    subTeamName: PARENT_TEAM,
    reason: 'not-a-sub-team',
  })
  expect(await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)).toEqual({
    ok: false,
    subTeamName: SUB_TEAM,
    reason: 'missing-team-file',
  })

  // getTeamDir sanitizes `/` to `-`, so `email/supervisor` and a root team
  // literally named `email-supervisor` share one config.json. A re-attach must
  // never rewrite that team's file.
  writeTeam('email-supervisor', [
    { agentId: 'team-lead@email-supervisor', name: TEAM_LEAD_NAME },
  ])
  expect(await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)).toEqual({
    ok: false,
    subTeamName: SUB_TEAM,
    reason: 'directory-collision',
  })
  expect(readTeamFile('email-supervisor')?.parentAgentId).toBeUndefined()
})

test('resolveUpwardInboxTeam redirects only an adopted sub-team', async () => {
  writeSubTeamWorld()

  // A root-team teammate: its own team, and no disk read at all.
  expect(await resolveUpwardInboxTeam(PARENT_TEAM)).toBe(PARENT_TEAM)
  // A led sub-team: its own sub-lead is still the reader.
  expect(await resolveUpwardInboxTeam(SUB_TEAM)).toBe(SUB_TEAM)

  await adoptOrphanedSubTeam(SUB_TEAM)
  expect(await resolveUpwardInboxTeam(SUB_TEAM)).toBe(PARENT_TEAM)

  // And back again the moment a new sub-lead takes the team over.
  await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)
  expect(await resolveUpwardInboxTeam(SUB_TEAM)).toBe(SUB_TEAM)

  // A sub-team whose parentAgentId names something that is neither its natural
  // lead nor a team-lead is left alone rather than guessed at.
  await reattachSubTeamToLead(SUB_TEAM, 'someone@elsewhere')
  expect(await resolveUpwardInboxTeam(SUB_TEAM)).toBe(SUB_TEAM)
})

test('noteSubLeadFailure records the orphan and tells the lead above it', async () => {
  const world = createWorld()
  writeSubTeamWorld()
  await registerTeammate(world, WORKER, SUB_TEAM)

  const recorded = await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    turnAgentId: 'a0123456789abcdef',
    reason: 'API stream failed',
    tasks: world.getState().tasks,
  })
  expect(recorded).toBe(true)

  const record = readTeamFile(SUB_TEAM)?.orphanedLead
  expect(record?.agentId).toBe(SUB_LEAD_AGENT_ID)
  expect(record?.turnAgentId).toBe('a0123456789abcdef')
  expect(record?.reason).toBe('API stream failed')
  expect(typeof record?.detectedAt).toBe('number')
  // Detection is additive: the pointers teardown and leadership depend on are
  // untouched.
  expect(readTeamFile(SUB_TEAM)?.parentAgentId).toBe(SUB_LEAD_AGENT_ID)
  expect(readTeamFile(SUB_TEAM)?.parentTeam).toBe(PARENT_TEAM)

  // The notification goes to the inbox the recovery authority actually polls —
  // the parent team's team-lead — and names the team, the live member and both
  // recovery actions.
  const leadInbox = await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)
  expect(leadInbox).toHaveLength(1)
  expect(leadInbox[0]!.text).toContain(SUB_TEAM)
  expect(leadInbox[0]!.text).toContain(WORKER)
  expect(leadInbox[0]!.text).toContain('API stream failed')
  expect(leadInbox[0]!.text).toContain('respawn')
  expect(leadInbox[0]!.text).toContain('adopt')
})

test('noteSubLeadFailure ignores a teammate that leads no sub-team, and a squatter', async () => {
  // A plain teammate of a plain team: nothing on disk, nothing written.
  writeTeam(PARENT_TEAM, [
    { agentId: ROOT_LEAD_AGENT_ID, name: TEAM_LEAD_NAME },
    { agentId: `${WORKER}@${PARENT_TEAM}`, name: WORKER },
  ])
  expect(
    await noteSubLeadFailure({
      identity: {
        agentId: `${WORKER}@${PARENT_TEAM}`,
        agentName: WORKER,
        teamName: PARENT_TEAM,
      },
      reason: 'boom',
      tasks: {},
    }),
  ).toBe(false)
  expect(await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)).toHaveLength(0)

  // A root team squatting the sub-team's sanitized directory is not this
  // teammate's sub-team, so it is neither recorded nor reported.
  writeTeam('email-supervisor', [
    { agentId: 'team-lead@email-supervisor', name: TEAM_LEAD_NAME },
  ])
  expect(
    await noteSubLeadFailure({
      identity: {
        agentId: SUB_LEAD_AGENT_ID,
        agentName: SUB_LEAD,
        teamName: PARENT_TEAM,
      },
      reason: 'boom',
      tasks: {},
    }),
  ).toBe(false)
  expect(readTeamFile('email-supervisor')?.orphanedLead).toBeUndefined()
  expect(await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)).toHaveLength(0)
})

test('collectSubTeamRecoveryInfo finds the orphan by disk scan, with its live members', async () => {
  const world = createWorld()
  writeSubTeamWorld()
  const leadTaskId = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  await registerTeammate(world, WORKER, SUB_TEAM)
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    reason: 'boom',
    tasks: world.getState().tasks,
  })
  markTaskFailed(world, leadTaskId)

  const infos = await collectSubTeamRecoveryInfo(
    PARENT_TEAM,
    world.getState().tasks,
  )
  expect(infos).toHaveLength(1)
  expect(infos[0]).toMatchObject({
    teamName: SUB_TEAM,
    state: 'orphaned',
    leadAgentId: SUB_LEAD_AGENT_ID,
    naturalLeadAgentId: SUB_LEAD_AGENT_ID,
    hasLiveLead: false,
    liveMembers: [WORKER],
    failureReason: 'boom',
  })
})

test("an adopted sub-team's members report to the root's inbox until a new sub-lead exists, and leave no orphan directory", async () => {
  const world = createWorld()
  writeSubTeamWorld()
  registerTeamForSessionCleanup(SUB_TEAM)
  // The sub-team owns a task list of its own (U5) and a member worktree, so
  // "no orphan directories" is a claim about all three kinds of directory.
  const workerWorktree = join(configDir!, 'worktrees', WORKER)
  mkdirSync(workerWorktree, { recursive: true })
  writeTeam(
    SUB_TEAM,
    [
      { agentId: `${TEAM_LEAD_NAME}@${SUB_TEAM}`, name: TEAM_LEAD_NAME },
      {
        agentId: `${WORKER}@${SUB_TEAM}`,
        name: WORKER,
        worktreePath: workerWorktree,
      },
    ],
    { parentTeam: PARENT_TEAM, parentAgentId: SUB_LEAD_AGENT_ID },
  )
  await createTask(SUB_TEAM, {
    subject: 'sub-team work',
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(true)

  const leadTaskId = await registerTeammate(world, SUB_LEAD, PARENT_TEAM)
  await registerTeammate(world, WORKER, SUB_TEAM)

  // The lead's runner fails. Detection records the orphan; nothing is torn
  // down, and the member keeps running.
  await noteSubLeadFailure({
    identity: {
      agentId: SUB_LEAD_AGENT_ID,
      agentName: SUB_LEAD,
      teamName: PARENT_TEAM,
    },
    reason: 'boom',
    tasks: world.getState().tasks,
  })
  markTaskFailed(world, leadTaskId)
  expect(stateOf(SUB_TEAM, world)).toBe('orphaned')
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(true)

  // While orphaned, the member's report still goes to the sub-team's own
  // team-lead inbox — the one nothing reads. That is the defect adopt fixes.
  const reportUpward = async (text: string): Promise<void> => {
    await writeToMailbox(
      TEAM_LEAD_NAME,
      { from: WORKER, text, timestamp: new Date().toISOString() },
      await resolveUpwardInboxTeam(SUB_TEAM),
    )
  }
  await reportUpward('while orphaned')
  expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.text)).toEqual(
    ['while orphaned'],
  )

  // Adopt: parentAgentId becomes the root lead, and nothing else moves.
  const adopted = await adoptOrphanedSubTeam(SUB_TEAM)
  expect(adopted).toMatchObject({ ok: true, newLeadAgentId: ROOT_LEAD_AGENT_ID })
  expect(stateOf(SUB_TEAM, world)).toBe('adopted')
  const notified = await notifyAdoptedMembers(
    SUB_TEAM,
    ROOT_LEAD_AGENT_ID,
    world.getState().tasks,
  )
  expect(notified).toEqual([WORKER])
  expect((await readMailbox(WORKER, SUB_TEAM))[0]!.text).toContain(
    ROOT_LEAD_AGENT_ID,
  )

  // Now the same report reaches the ROOT lead's inbox instead, and the
  // sub-team's own inbox gains nothing further.
  await reportUpward('after adopt')
  expect(
    (await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)).map(m => m.from),
  ).toEqual([SUB_LEAD, WORKER])
  expect(
    (await readMailbox(TEAM_LEAD_NAME, PARENT_TEAM)).at(-1)!.text,
  ).toBe('after adopt')
  expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.text)).toEqual(
    ['while orphaned'],
  )

  // "Until a new sub-lead exists": a re-attach to the natural lead ends the
  // redirect on the member's very next report, with no member restarted.
  await reattachSubTeamToLead(SUB_TEAM, SUB_LEAD_AGENT_ID)
  await reportUpward('after a new sub-lead')
  expect((await readMailbox(TEAM_LEAD_NAME, SUB_TEAM)).map(m => m.text)).toEqual(
    ['while orphaned', 'after a new sub-lead'],
  )

  // No orphan directories: because adopt never re-points parentTeam, the
  // roster-blind disk scan still owns the adopted sub-team, so the ordinary
  // teardown funnel takes the whole tree — team dirs, inboxes, task lists and
  // the member worktree.
  await adoptOrphanedSubTeam(SUB_TEAM)
  expect(stateOf(SUB_TEAM, world)).toBe('adopted')
  await cleanupTeamTree(PARENT_TEAM)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(PARENT_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(existsSync(workerWorktree)).toBe(false)
  expect(readdirSync(getTeamsDir())).toEqual([])
})

test('readSubTeamRecoveryInfo answers null for a root team and for a squatted directory', async () => {
  writeSubTeamWorld()
  expect(await readSubTeamRecoveryInfo(PARENT_TEAM, {})).toBeNull()
  expect(await readSubTeamRecoveryInfo('email/nobody', {})).toBeNull()

  rmSync(getTeamDir(SUB_TEAM), { recursive: true, force: true })
  writeTeam('email-supervisor', [
    { agentId: 'team-lead@email-supervisor', name: TEAM_LEAD_NAME },
  ])
  expect(await readSubTeamRecoveryInfo(SUB_TEAM, {})).toBeNull()
})
