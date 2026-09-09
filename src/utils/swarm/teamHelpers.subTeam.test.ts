import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import {
  getParentTeamName,
  getSubTeamNameFor,
  getTeamDepth,
  readSubTeamLedBy,
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
