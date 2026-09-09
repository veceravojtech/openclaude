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
  DEFAULT_MAX_LIVE_TEAMMATES,
  DEFAULT_MAX_TEAMMATE_REPLICAS,
  getMaxLiveTeammates,
  getMaxTeammateReplicas,
  getTeammateSpawnCapError,
  MAX_LIVE_TEAMMATES_ENV,
  MAX_TEAMMATE_REPLICAS_ENV,
  parsePositiveIntEnv,
  REPLICAS_REQUIRE_NAME_ERROR,
  REPLICAS_REQUIRE_TEAM_ERROR,
} from './teammateReplicas.js'

const ENV_KEYS = [MAX_TEAMMATE_REPLICAS_ENV, MAX_LIVE_TEAMMATES_ENV] as const
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
  opts: { status?: InProcessTeammateTaskState['status']; isIdle?: boolean } = {},
): InProcessTeammateTaskState {
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
      agentId: `${name}@team`,
      agentName: name,
      teamName: 'team',
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
