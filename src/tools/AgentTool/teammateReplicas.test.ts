import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  countLiveInProcessTeammates,
  countLiveTeammatesInTeam,
  DEFAULT_MAX_LIVE_TEAMMATES,
  DEFAULT_MAX_TEAM_TOTAL,
  DEFAULT_MAX_TEAMMATE_REPLICAS,
  getMaxLiveTeammates,
  getMaxTeammateReplicas,
  getMaxTeamTotal,
  getTeammateSpawnCapError,
  MAX_LIVE_TEAMMATES_ENV,
  MAX_TEAM_TOTAL_ENV,
  MAX_TEAMMATE_REPLICAS_ENV,
  parsePositiveIntEnv,
  REPLICAS_REQUIRE_NAME_ERROR,
  REPLICAS_REQUIRE_TEAM_ERROR,
} from './teammateReplicas.js'

const ENV_KEYS = [
  MAX_TEAMMATE_REPLICAS_ENV,
  MAX_LIVE_TEAMMATES_ENV,
  MAX_TEAM_TOTAL_ENV,
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/teammateReplicas.test.ts')
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function teammateTask(
  name: string,
  opts: {
    status?: InProcessTeammateTaskState['status']
    isIdle?: boolean
    team?: string
  } = {},
): InProcessTeammateTaskState {
  const team = opts.team ?? 'team'
  return {
    id: `task-${name}`,
    type: 'in_process_teammate',
    status: opts.status ?? 'running',
    description: `${name}: doing work`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@${team}`,
      agentName: name,
      teamName: team,
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'doing work',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: opts.isIdle ?? false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function backgroundAgentTask(id: string): LocalAgentTaskState {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: 'bg',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
  } as unknown as LocalAgentTaskState
}

function tasksOf(...tasks: Array<InProcessTeammateTaskState | LocalAgentTaskState>): AppState['tasks'] {
  return Object.fromEntries(tasks.map(task => [task.id, task]))
}

function runningTeammates(count: number): AppState['tasks'] {
  return tasksOf(
    ...Array.from({ length: count }, (_, i) => teammateTask(`w-${i + 1}`)),
  )
}

/** `count` running teammates in `team`, named so teams never share a task id. */
function teamMembers(
  team: string,
  count: number,
): InProcessTeammateTaskState[] {
  const prefix = team.replaceAll('/', '-')
  return Array.from({ length: count }, (_, i) =>
    teammateTask(`${prefix}-${i + 1}`, { team }),
  )
}

/**
 * A running teammate whose task carries no identity at all — the shape
 * AgentTool.replicas.test.ts builds, and the one the per-team cap has to
 * charge to every team.
 */
function teammateTaskWithoutIdentity(name: string): InProcessTeammateTaskState {
  const task: Partial<InProcessTeammateTaskState> = teammateTask(name)
  delete task.identity
  return task as InProcessTeammateTaskState
}

test('parsePositiveIntEnv accepts positive integers and falls back otherwise', () => {
  expect(parsePositiveIntEnv('4', 8)).toBe(4)
  expect(parsePositiveIntEnv(' 12 ', 8)).toBe(12)
  expect(parsePositiveIntEnv(undefined, 8)).toBe(8)
  expect(parsePositiveIntEnv('', 8)).toBe(8)
  expect(parsePositiveIntEnv('   ', 8)).toBe(8)
  expect(parsePositiveIntEnv('0', 8)).toBe(8)
  expect(parsePositiveIntEnv('-3', 8)).toBe(8)
  expect(parsePositiveIntEnv('2.5', 8)).toBe(8)
  expect(parsePositiveIntEnv('abc', 8)).toBe(8)
  expect(parsePositiveIntEnv('1e3', 8)).toBe(8)
  expect(parsePositiveIntEnv('99999999999999999999', 8)).toBe(8)
})

test('caps default to 8 replicas per call and 16 live teammates', () => {
  expect(DEFAULT_MAX_TEAMMATE_REPLICAS).toBe(8)
  expect(DEFAULT_MAX_LIVE_TEAMMATES).toBe(16)
  expect(getMaxTeammateReplicas()).toBe(8)
  expect(getMaxLiveTeammates()).toBe(16)
})

test('CLAUDE_CODE_MAX_TEAMMATE_REPLICAS and CLAUDE_CODE_MAX_TEAMMATES override the caps', () => {
  expect(MAX_TEAMMATE_REPLICAS_ENV).toBe('CLAUDE_CODE_MAX_TEAMMATE_REPLICAS')
  expect(MAX_LIVE_TEAMMATES_ENV).toBe('CLAUDE_CODE_MAX_TEAMMATES')

  process.env[MAX_TEAMMATE_REPLICAS_ENV] = '3'
  process.env[MAX_LIVE_TEAMMATES_ENV] = '5'
  expect(getMaxTeammateReplicas()).toBe(3)
  expect(getMaxLiveTeammates()).toBe(5)

  process.env[MAX_TEAMMATE_REPLICAS_ENV] = 'nope'
  process.env[MAX_LIVE_TEAMMATES_ENV] = '0'
  expect(getMaxTeammateReplicas()).toBe(8)
  expect(getMaxLiveTeammates()).toBe(16)
})

test('countLiveInProcessTeammates counts running teammates, idle included, terminal excluded', () => {
  const tasks = tasksOf(
    teammateTask('busy'),
    teammateTask('idle', { isIdle: true }),
    teammateTask('done', { status: 'completed' }),
    teammateTask('killed', { status: 'killed' }),
    teammateTask('failed', { status: 'failed' }),
    backgroundAgentTask('bg-1'),
  )
  expect(countLiveInProcessTeammates(tasks)).toBe(2)
  expect(countLiveInProcessTeammates({})).toBe(0)
})

test('replicas without name is rejected regardless of team', () => {
  for (const isTeammateSpawn of [true, false]) {
    expect(
      getTeammateSpawnCapError({ replicas: 1, isTeammateSpawn, tasks: {} }),
    ).toBe(REPLICAS_REQUIRE_NAME_ERROR)
    expect(
      getTeammateSpawnCapError({ replicas: 3, name: '', isTeammateSpawn, tasks: {} }),
    ).toBe(REPLICAS_REQUIRE_NAME_ERROR)
  }
})

test('replicas over the per-call cap is rejected with the cap named', () => {
  const error = getTeammateSpawnCapError({
    replicas: 9,
    name: 'worker',
    isTeammateSpawn: true,
    tasks: {},
  })
  expect(error).toContain('replicas (9)')
  expect(error).toContain('cap of 8')
  expect(error).toContain(MAX_TEAMMATE_REPLICAS_ENV)

  expect(
    getTeammateSpawnCapError({
      replicas: 8,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: {},
    }),
  ).toBeUndefined()

  process.env[MAX_TEAMMATE_REPLICAS_ENV] = '2'
  expect(
    getTeammateSpawnCapError({
      replicas: 3,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: {},
    }),
  ).toContain('cap of 2')
  expect(
    getTeammateSpawnCapError({
      replicas: 2,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: {},
    }),
  ).toBeUndefined()
})

test('multi-replica requests outside a teammate spawn are rejected; single ones pass through', () => {
  expect(
    getTeammateSpawnCapError({
      replicas: 2,
      name: 'worker',
      isTeammateSpawn: false,
      tasks: {},
    }),
  ).toBe(REPLICAS_REQUIRE_TEAM_ERROR)
  expect(
    getTeammateSpawnCapError({
      replicas: 1,
      name: 'worker',
      isTeammateSpawn: false,
      tasks: runningTeammates(16),
    }),
  ).toBeUndefined()
  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: false,
      tasks: runningTeammates(16),
    }),
  ).toBeUndefined()
})

test('live teammate cap names the request, the running count, and the cap', () => {
  const error = getTeammateSpawnCapError({
    replicas: 3,
    name: 'worker',
    isTeammateSpawn: true,
    tasks: runningTeammates(14),
  })
  expect(error).toContain('Spawning 3 teammates')
  expect(error).toContain('14 already running')
  expect(error).toContain('cap of 16')
  expect(error).toContain(MAX_LIVE_TEAMMATES_ENV)

  // Exactly filling the pool is allowed.
  expect(
    getTeammateSpawnCapError({
      replicas: 2,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: runningTeammates(14),
    }),
  ).toBeUndefined()
})

test('a single spawn counts as one against the live cap', () => {
  const full = runningTeammates(16)
  const single = getTeammateSpawnCapError({
    name: 'worker',
    isTeammateSpawn: true,
    tasks: full,
  })
  expect(single).toContain('Spawning 1 teammate with 16 already running')
  expect(
    getTeammateSpawnCapError({
      replicas: 1,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: full,
    }),
  ).toBe(single)
  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: true,
      tasks: runningTeammates(15),
    }),
  ).toBeUndefined()
})

test('CLAUDE_CODE_MAX_TEAMMATES overrides the live cap', () => {
  process.env[MAX_LIVE_TEAMMATES_ENV] = '3'
  expect(
    getTeammateSpawnCapError({
      replicas: 2,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: runningTeammates(2),
    }),
  ).toContain('cap of 3')
  expect(
    getTeammateSpawnCapError({
      replicas: 1,
      name: 'worker',
      isTeammateSpawn: true,
      tasks: runningTeammates(2),
    }),
  ).toBeUndefined()
})

test('the live cap counts per team and matches sub-team names exactly', () => {
  const tasks = tasksOf(
    ...teamMembers('email', 14),
    ...teamMembers('email/supervisor', 3),
    teammateTaskWithoutIdentity('stray-1'),
    teammateTaskWithoutIdentity('stray-2'),
  )
  expect(countLiveInProcessTeammates(tasks)).toBe(19)
  expect(countLiveTeammatesInTeam(tasks, 'email')).toBe(16)
  expect(countLiveTeammatesInTeam(tasks, 'email/supervisor')).toBe(5)
  expect(countLiveTeammatesInTeam(tasks, 'research')).toBe(2)

  const refused = getTeammateSpawnCapError({
    replicas: 2,
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'email',
    tasks,
  })
  expect(refused).toContain(
    'Spawning 2 teammates with 16 already running in team "email"',
  )
  expect(refused).toContain('live teammate cap of 16 per team')

  // The sub-team is its own pool: the parent team's 14 members do not count
  // against it, and its own 3 do not count against the parent.
  expect(
    getTeammateSpawnCapError({
      replicas: 2,
      name: 'worker',
      isTeammateSpawn: true,
      teamName: 'email/supervisor',
      tasks,
    }),
  ).toBeUndefined()
})

test('a running teammate with no readable team counts against every team', () => {
  const tasks = tasksOf(
    ...teamMembers('review', 14),
    teammateTaskWithoutIdentity('stray'),
    teammateTask('blank', { team: '   ' }),
    ...teamMembers('docs', 2),
  )
  expect(countLiveTeammatesInTeam(tasks, 'review')).toBe(16)
  expect(countLiveTeammatesInTeam(tasks, 'docs')).toBe(4)
  expect(countLiveTeammatesInTeam(tasks, 'brand-new-team')).toBe(2)

  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: true,
      teamName: 'review',
      tasks,
    }),
  ).toContain('with 16 already running in team "review"')
  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: true,
      teamName: 'docs',
      tasks,
    }),
  ).toBeUndefined()
})

test('an omitted teamName keeps the legacy global live count', () => {
  const tasks = tasksOf(...teamMembers('alpha', 8), ...teamMembers('beta', 8))
  expect(countLiveTeammatesInTeam(tasks, undefined)).toBe(16)
  const refused = getTeammateSpawnCapError({
    name: 'worker',
    isTeammateSpawn: true,
    tasks,
  })
  expect(refused).toContain(
    'Spawning 1 teammate with 16 already running would exceed',
  )
  expect(refused).not.toContain('in team')
  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: true,
      teamName: 'alpha',
      tasks,
    }),
  ).toBeUndefined()
})

test('the total cap fires across teams whose own pools are far from full', () => {
  const nearTotal = tasksOf(
    ...teamMembers('alpha', 8),
    ...teamMembers('beta', 8),
    ...teamMembers('gamma', 7),
  )
  // 23 running, every per-team pool well under 16: filling the total exactly
  // is allowed.
  expect(
    getTeammateSpawnCapError({
      name: 'worker',
      isTeammateSpawn: true,
      teamName: 'delta',
      tasks: nearTotal,
    }),
  ).toBeUndefined()

  const full = tasksOf(
    ...teamMembers('alpha', 8),
    ...teamMembers('beta', 8),
    ...teamMembers('gamma', 8),
  )
  const refused = getTeammateSpawnCapError({
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'delta',
    tasks: full,
  })
  expect(countLiveTeammatesInTeam(full, 'delta')).toBe(0)
  expect(refused).toContain(
    'Spawning 1 teammate with 24 already running across all teams',
  )
  expect(refused).toContain('total teammate cap of 24')
})

test('CLAUDE_CODE_MAX_TEAM_TOTAL overrides the total cap and falls back to 24', () => {
  expect(MAX_TEAM_TOTAL_ENV).toBe('CLAUDE_CODE_MAX_TEAM_TOTAL')
  expect(DEFAULT_MAX_TEAM_TOTAL).toBe(24)
  expect(getMaxTeamTotal()).toBe(24)

  const tasks = tasksOf(...teamMembers('alpha', 3), ...teamMembers('beta', 3))
  const spawn = {
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'gamma',
    tasks,
  }

  process.env[MAX_TEAM_TOTAL_ENV] = '6'
  expect(getMaxTeamTotal()).toBe(6)
  expect(getTeammateSpawnCapError(spawn)).toContain('total teammate cap of 6')

  process.env[MAX_TEAM_TOTAL_ENV] = '0'
  expect(getMaxTeamTotal()).toBe(24)
  expect(getTeammateSpawnCapError(spawn)).toBeUndefined()

  process.env[MAX_TEAM_TOTAL_ENV] = 'plenty'
  expect(getMaxTeamTotal()).toBe(24)
  expect(getTeammateSpawnCapError(spawn)).toBeUndefined()
})

test('both caps and both env vars are named whichever cap refuses', () => {
  const perTeam = getTeammateSpawnCapError({
    replicas: 2,
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'email',
    tasks: tasksOf(...teamMembers('email', 16)),
  })
  expect(perTeam).toContain('live teammate cap of 16 per team')
  expect(perTeam).toContain('across all teams is 24')
  expect(perTeam).toContain(MAX_LIVE_TEAMMATES_ENV)
  expect(perTeam).toContain(MAX_TEAM_TOTAL_ENV)

  const total = getTeammateSpawnCapError({
    replicas: 2,
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'delta',
    tasks: tasksOf(
      ...teamMembers('alpha', 8),
      ...teamMembers('beta', 8),
      ...teamMembers('gamma', 8),
    ),
  })
  expect(total).toContain('total teammate cap of 24')
  expect(total).toContain('per-team cap is 16')
  expect(total).toContain(MAX_TEAM_TOTAL_ENV)
  expect(total).toContain(MAX_LIVE_TEAMMATES_ENV)
})

test('a replica batch that fits its own team is still refused by the total cap', () => {
  const tasks = tasksOf(
    ...teamMembers('alpha', 7),
    ...teamMembers('beta', 7),
    ...teamMembers('gamma', 7),
  )
  const batch = {
    replicas: 4,
    name: 'worker',
    isTeammateSpawn: true,
    teamName: 'delta',
    tasks,
  }
  expect(countLiveTeammatesInTeam(tasks, 'delta')).toBe(0)

  const refused = getTeammateSpawnCapError(batch)
  expect(refused).toContain(
    'Spawning 4 teammates with 21 already running across all teams',
  )
  expect(refused).toContain('total teammate cap of 24')

  process.env[MAX_TEAM_TOTAL_ENV] = '30'
  expect(getTeammateSpawnCapError(batch)).toBeUndefined()
})

/**
 * A finished teammate whose row is still on screen inside its 30s grace window.
 * The pair is what the terminal-marking sites write; the point of these cases is
 * that it changes nothing here. A grace row is a row, not a slot: the caps and
 * the liveness counts key on status, so a teammate that has stopped stops
 * counting the instant it stops — exactly as before the grace existed.
 */
function teammateInGrace(
  name: string,
  status: 'completed' | 'failed' | 'killed' = 'killed',
  team?: string,
): InProcessTeammateTaskState {
  return {
    ...teammateTask(name, { status, team }),
    notified: true,
    retain: false,
    evictAfter: Date.now() + 30_000,
  }
}

test('countLiveInProcessTeammates ignores a teammate inside its grace window', () => {
  const tasks = tasksOf(
    teammateTask('busy'),
    teammateInGrace('done', 'completed'),
    teammateInGrace('stopped', 'killed'),
    teammateInGrace('broken', 'failed'),
  )
  expect(countLiveInProcessTeammates(tasks)).toBe(1)
})

test('countLiveTeammatesInTeam ignores grace rows in its own team', () => {
  const tasks = tasksOf(
    ...teamMembers('team', 2),
    teammateInGrace('done', 'completed', 'team'),
    teammateInGrace('stopped', 'killed', 'team'),
  )
  expect(countLiveTeammatesInTeam(tasks, 'team')).toBe(2)
})

test('the spawn cap is not spent by grace rows: a team full of them still accepts a spawn', () => {
  // MAX_LIVE_TEAMMATES worth of finished teammates, all still drawn. If a grace
  // row counted as live this would be refused, and a user who had just stopped a
  // full team would have to wait out the grace window to spawn anything.
  const graced = Array.from({ length: DEFAULT_MAX_LIVE_TEAMMATES }, (_, i) =>
    teammateInGrace(`done-${i + 1}`, 'completed', 'team'),
  )
  expect(
    getTeammateSpawnCapError({
      name: 'fresh',
      isTeammateSpawn: true,
      teamName: 'team',
      tasks: tasksOf(...graced),
    }),
  ).toBeUndefined()
  // …while the same number of RUNNING teammates is still refused.
  expect(
    getTeammateSpawnCapError({
      name: 'fresh',
      isTeammateSpawn: true,
      teamName: 'team',
      tasks: tasksOf(...teamMembers('team', DEFAULT_MAX_LIVE_TEAMMATES)),
    }),
  ).toContain(String(DEFAULT_MAX_LIVE_TEAMMATES))
})
