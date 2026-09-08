import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { TaskState } from '../../tasks/types.js'
import { isPillTask } from './taskStatusUtils.js'

const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'

// `isPillTask` reads the opt-out on every call, so the variable is captured and
// cleared per test inside the file-level shared mutation lock: a developer
// running with it exported must not get a false pass on the panel-active cases,
// and no case may leak the value into the next file.
let originalValue: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/tasks/BackgroundTaskStatus.test.tsx',
  )
  originalValue = process.env[ENV_VAR]
  delete process.env[ENV_VAR]
})

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = originalValue
  }
  releaseSharedMutationLock()
})

function setAgentView(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = value
  }
}

// Cases that must not depend on the gate run under both states.
const ENV_STATES: Array<[string, string | undefined]> = [
  ['panel active', undefined],
  ['agent view opted out', '1'],
]

function agent(id: string, overrides: Record<string, unknown> = {}): TaskState {
  return {
    id,
    type: 'local_agent',
    agentType: 'general-purpose',
    status: 'running',
    startTime: 0,
    retain: false,
    ...overrides,
  } as unknown as TaskState
}

function task(id: string, type: string, overrides: Record<string, unknown> = {}): TaskState {
  return {
    id,
    type,
    status: 'running',
    startTime: 0,
    ...overrides,
  } as unknown as TaskState
}

describe('background-task pill filter with the panel active', () => {
  test('excludes a panel-visible local agent — the panel already lists it', () => {
    expect(isPillTask(agent('a'))).toBe(false)
    expect(isPillTask(agent('a', { status: 'pending' }))).toBe(false)
  })

  test('keeps a running in_process_teammate so the teammate pill row survives', () => {
    expect(isPillTask(task('t', 'in_process_teammate'))).toBe(true)
  })

  test('keeps bash, monitor, remote, workflow and dream pills untouched', () => {
    expect(isPillTask(task('sh', 'local_bash'))).toBe(true)
    expect(isPillTask(task('mon', 'monitor_mcp'))).toBe(true)
    expect(isPillTask(task('rem', 'remote_agent'))).toBe(true)
    expect(isPillTask(task('wf', 'local_workflow'))).toBe(true)
    expect(isPillTask(task('dr', 'dream'))).toBe(true)
  })

  test('keeps a main-session local agent — the panel never renders it', () => {
    expect(isPillTask(agent('m', { agentType: 'main-session' }))).toBe(true)
  })

  test('gives the pill back to an agent dismissed from the panel with x', () => {
    expect(isPillTask(agent('a', { evictAfter: 0 }))).toBe(true)
  })

  test('still drops terminal tasks, which were never background tasks', () => {
    expect(isPillTask(agent('a', { status: 'completed' }))).toBe(false)
    expect(isPillTask(task('sh', 'local_bash', { status: 'completed' }))).toBe(false)
  })
})

// The exclusion exists only to stop the pill and the CoordinatorTaskPanel from
// double-listing one agent. With the opt-out set the panel is never mounted, so
// an excluded agent would show up nowhere at all — the pill has to come back.
describe('background-task pill filter with CLAUDE_CODE_DISABLE_AGENT_VIEW set', () => {
  test('a running panel agent is a pill task again', () => {
    setAgentView('1')
    expect(isPillTask(agent('a'))).toBe(true)
    expect(isPillTask(agent('a', { status: 'pending' }))).toBe(true)
  })

  test('the same agent flips back to excluded once the opt-out is cleared', () => {
    const t = agent('a')
    setAgentView('1')
    expect(isPillTask(t)).toBe(true)
    // Read at call time, never cached (isAgentViewDisabled): the identical task
    // object must answer differently after the variable goes away.
    setAgentView(undefined)
    expect(isPillTask(t)).toBe(false)
  })

  test('honours the shared truthy-value parsing, not just "1"', () => {
    setAgentView('true')
    expect(isPillTask(agent('a'))).toBe(true)
    setAgentView('0')
    expect(isPillTask(agent('a'))).toBe(false)
  })

  test('terminal tasks stay dropped — the gate never resurrects one', () => {
    setAgentView('1')
    expect(isPillTask(agent('a', { status: 'completed' }))).toBe(false)
    expect(isPillTask(task('sh', 'local_bash', { status: 'completed' }))).toBe(false)
  })
})

describe('background-task pill filter regardless of the opt-out', () => {
  test.each(ENV_STATES)(
    'bash, monitor, remote, workflow, dream and teammate pills are unchanged (%s)',
    (_label, value) => {
      setAgentView(value)
      expect(isPillTask(task('sh', 'local_bash'))).toBe(true)
      expect(isPillTask(task('mon', 'monitor_mcp'))).toBe(true)
      expect(isPillTask(task('rem', 'remote_agent'))).toBe(true)
      expect(isPillTask(task('wf', 'local_workflow'))).toBe(true)
      expect(isPillTask(task('dr', 'dream'))).toBe(true)
      expect(isPillTask(task('t', 'in_process_teammate'))).toBe(true)
    },
  )

  test.each(ENV_STATES)(
    'a main-session agent and an agent dismissed with x keep their pills (%s)',
    (_label, value) => {
      setAgentView(value)
      expect(isPillTask(agent('m', { agentType: 'main-session' }))).toBe(true)
      expect(isPillTask(agent('a', { evictAfter: 0 }))).toBe(true)
    },
  )
})
