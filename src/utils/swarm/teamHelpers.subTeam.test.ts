import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createTask, getTasksDir } from '../tasks.js'
import {
  cleanupSessionTeams,
  cleanupTeamTree,
  collectDescendantTeamNames,
  getParentTeamName,
  getSubTeamNameFor,
  getTeamDepth,
  getTeamDir,
  readSubTeamLedBy,
  readSubTeamLedBySync,
  registerTeamForSessionCleanup,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'

// U3: a team name is a path in the team tree — `email` is a root team,
// `email/supervisor` the sub-team its teammate `supervisor` leads. These pin
// the name arithmetic and the "does this caller lead one" lookup, which is
// what both TeamCreate and the Agent tool's roster guard hang off.

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/teamHelpers.subTeam.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-subteam-helpers-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function makeTeamFile(overrides: Partial<TeamFile> & { name: string }): TeamFile {
  return {
    createdAt: 1,
    leadAgentId: `team-lead@${overrides.name}`,
    members: [],
    ...overrides,
  }
}

test('getTeamDepth counts the levels, a root team being 1', () => {
  expect(getTeamDepth('email')).toBe(1)
  expect(getTeamDepth('email/supervisor')).toBe(2)
  expect(getTeamDepth('a/b/c/d')).toBe(4)
})

test('getParentTeamName is undefined for a root team and the prefix otherwise', () => {
  expect(getParentTeamName('email')).toBeUndefined()
  expect(getParentTeamName('email/supervisor')).toBe('email')
  expect(getParentTeamName('a/b/c')).toBe('a/b')
})

test('getSubTeamNameFor derives the one name a teammate may lead', () => {
  expect(getSubTeamNameFor('supervisor@email', 'supervisor')).toBe(
    'email/supervisor',
  )
  expect(getSubTeamNameFor('sub@a/b', 'sub')).toBe('a/b/sub')
  // A lead or a subagent: no `name@team` identity, so no sub-team.
  expect(getSubTeamNameFor('a1234567890abcdef', 'worker')).toBeUndefined()
  expect(getSubTeamNameFor(undefined, 'worker')).toBeUndefined()
  expect(getSubTeamNameFor('supervisor@email', undefined)).toBeUndefined()
  // A name that would itself add a level is not a leader name.
  expect(getSubTeamNameFor('a/b@email', 'a/b')).toBeUndefined()
})

test('readSubTeamLedBy returns the sub-team recorded for that teammate', async () => {
  await writeTeamFileAsync(
    'email/supervisor',
    makeTeamFile({
      name: 'email/supervisor',
      parentTeam: 'email',
      parentAgentId: 'supervisor@email',
    }),
  )

  const teamFile = await readSubTeamLedBy({
    agentId: 'supervisor@email',
    name: 'supervisor',
    isTeammate: true,
  })
  expect(teamFile?.name).toBe('email/supervisor')
  expect(teamFile?.parentTeam).toBe('email')

  // Not a teammate (a lead, or a subagent inside a teammate's turn).
  expect(
    await readSubTeamLedBy({
      agentId: 'supervisor@email',
      name: 'supervisor',
      isTeammate: false,
    }),
  ).toBeNull()

  // A different teammate of the same team leads nothing.
  expect(
    await readSubTeamLedBy({
      agentId: 'reviewer@email',
      name: 'reviewer',
      isTeammate: true,
    }),
  ).toBeNull()
})

test('readSubTeamLedBy ignores a root team squatting the same directory', async () => {
  // getTeamDir sanitizes `/` to `-`, so `email/supervisor` and a root team
  // literally named `email-supervisor` share one config.json.
  await writeTeamFileAsync(
    'email-supervisor',
    makeTeamFile({ name: 'email-supervisor' }),
  )

  expect(
    await readSubTeamLedBy({
      agentId: 'supervisor@email',
      name: 'supervisor',
      isTeammate: true,
    }),
  ).toBeNull()
})

test('readSubTeamLedBy ignores a sub-team led by someone else', async () => {
  await writeTeamFileAsync(
    'email/supervisor',
    makeTeamFile({
      name: 'email/supervisor',
      parentTeam: 'email',
      parentAgentId: 'supervisor@other-email',
    }),
  )

  expect(
    await readSubTeamLedBy({
      agentId: 'supervisor@email',
      name: 'supervisor',
      isTeammate: true,
    }),
  ).toBeNull()
})

// U7: a sub-team is torn down with whatever it hangs off — the teammate that
// leads it, the team above it, or the session that created it. These pin the
// disk-side descent those three paths share, and which directories go with it.

const PARENT_TEAM = 'email'
const SUB_TEAM = `${PARENT_TEAM}/supervisor`
const SUB_SUB_TEAM = `${SUB_TEAM}/deputy`

async function writeTree(): Promise<void> {
  await writeTeamFileAsync(PARENT_TEAM, makeTeamFile({ name: PARENT_TEAM }))
  await writeTeamFileAsync(
    SUB_TEAM,
    makeTeamFile({
      name: SUB_TEAM,
      parentTeam: PARENT_TEAM,
      parentAgentId: `supervisor@${PARENT_TEAM}`,
    }),
  )
  await writeTeamFileAsync(
    SUB_SUB_TEAM,
    makeTeamFile({
      name: SUB_SUB_TEAM,
      parentTeam: SUB_TEAM,
      parentAgentId: `deputy@${SUB_TEAM}`,
    }),
  )
}

async function seedTask(taskListId: string): Promise<void> {
  await createTask(taskListId, {
    subject: `work for ${taskListId}`,
    description: 'seeded',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
}

test('readSubTeamLedBySync answers exactly as the async read does', async () => {
  await writeTeamFileAsync(
    SUB_TEAM,
    makeTeamFile({
      name: SUB_TEAM,
      parentTeam: PARENT_TEAM,
      parentAgentId: `supervisor@${PARENT_TEAM}`,
    }),
  )
  const caller = {
    agentId: `supervisor@${PARENT_TEAM}`,
    name: 'supervisor',
    isTeammate: true,
  }

  expect(readSubTeamLedBySync(caller)?.name).toBe(SUB_TEAM)
  expect((await readSubTeamLedBy(caller))?.name).toBe(SUB_TEAM)

  // Not a teammate, someone else's sub-team, and a root team squatting the
  // same sanitized directory all read as "leads none".
  expect(readSubTeamLedBySync({ ...caller, isTeammate: false })).toBeNull()
  expect(
    readSubTeamLedBySync({
      agentId: `reviewer@${PARENT_TEAM}`,
      name: 'reviewer',
      isTeammate: true,
    }),
  ).toBeNull()
  await writeTeamFileAsync(
    'email-supervisor',
    makeTeamFile({ name: 'email-supervisor' }),
  )
  expect(readSubTeamLedBySync(caller)).toBeNull()
})

test('collectDescendantTeamNames returns the whole sub-tree, deepest first', async () => {
  await writeTree()
  // A team of its own, and a sub-team of that team: neither hangs off `email`.
  await writeTeamFileAsync('other', makeTeamFile({ name: 'other' }))
  await writeTeamFileAsync(
    'other/manager',
    makeTeamFile({
      name: 'other/manager',
      parentTeam: 'other',
      parentAgentId: 'manager@other',
    }),
  )

  expect(await collectDescendantTeamNames(PARENT_TEAM)).toEqual([
    SUB_SUB_TEAM,
    SUB_TEAM,
  ])
  expect(await collectDescendantTeamNames(SUB_TEAM)).toEqual([SUB_SUB_TEAM])
  expect(await collectDescendantTeamNames(SUB_SUB_TEAM)).toEqual([])
  expect(await collectDescendantTeamNames('nothing-here')).toEqual([])
})

test('collectDescendantTeamNames terminates on a parent link that loops', async () => {
  // Hand-edited team files can name each other as parent; the walk must stop.
  await writeTeamFileAsync(
    'a',
    makeTeamFile({ name: 'a', parentTeam: 'b', parentAgentId: 'x@b' }),
  )
  await writeTeamFileAsync(
    'b',
    makeTeamFile({ name: 'b', parentTeam: 'a', parentAgentId: 'x@a' }),
  )

  expect(await collectDescendantTeamNames('a')).toEqual(['b'])
})

test('cleanupTeamTree removes a team, its sub-teams and their task lists', async () => {
  await writeTree()
  await seedTask(SUB_TEAM)
  await seedTask(SUB_SUB_TEAM)
  registerTeamForSessionCleanup(SUB_TEAM)
  registerTeamForSessionCleanup(SUB_SUB_TEAM)

  await cleanupTeamTree(PARENT_TEAM)

  expect(existsSync(getTeamDir(PARENT_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_SUB_TEAM))).toBe(false)
  // The sub-team task list is keyed by the raw name, which sanitizes to the
  // same directory `cleanupTeamDirectories` removes for the team.
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_SUB_TEAM))).toBe(false)
  // Nothing left for gracefulShutdown to try again.
  expect(getSessionCreatedTeams().has(SUB_TEAM)).toBe(false)
  expect(getSessionCreatedTeams().has(SUB_SUB_TEAM)).toBe(false)
})

test('cleanupSessionTeams removes the nested sub-team dirs created this session', async () => {
  await writeTree()
  await seedTask(SUB_TEAM)
  await seedTask(SUB_SUB_TEAM)
  // Exactly what createSubTeam registers (TeamCreateTool.ts) — nothing else
  // is needed for a sub-team dir to be cleaned up at session end.
  registerTeamForSessionCleanup(PARENT_TEAM)
  registerTeamForSessionCleanup(SUB_TEAM)
  registerTeamForSessionCleanup(SUB_SUB_TEAM)

  await cleanupSessionTeams()

  expect(existsSync(getTeamDir(PARENT_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTeamDir(SUB_SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_TEAM))).toBe(false)
  expect(existsSync(getTasksDir(SUB_SUB_TEAM))).toBe(false)
  expect(getSessionCreatedTeams().size).toBe(0)
})
