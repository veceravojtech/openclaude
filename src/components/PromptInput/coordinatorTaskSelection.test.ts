/**
 * Footer-Enter selection arithmetic for the CoordinatorTaskPanel.
 *
 * PromptInput.tsx is ~100 KB with dozens of providers and no Ink harness, so
 * this is the closest unit-testable equivalent: it pins the exact expressions
 * the footer handler uses — `getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]`
 * (PromptInput.tsx:1901) and `enterTeammateView` / `exitTeammateView` — plus the
 * index range those expressions imply (-1 pill / 0 main / 1..N agent rows, so
 * the last agent is index N === useCoordinatorTaskCount()).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../../state/teammateViewHelpers.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { isPillTask } from '../tasks/taskStatusUtils.js'

const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'

// isPillTask reads the opt-out on every call, so it is captured and cleared per
// test inside the file-level shared mutation lock — the panel-active cases must
// not pass vacuously for a developer who exports the variable.
let originalValue: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/PromptInput/coordinatorTaskSelection.test.ts',
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

function agentTask(
  id: string,
  startTime: number,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: `agent ${id}`,
    startTime,
    outputFile: `/tmp/${id}`,
    outputOffset: 0,
    notified: false,
    agentId: `a-${id}`,
    prompt: 'test',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } satisfies LocalAgentTaskState
}

// Three panel agents out of insertion order, plus two tasks that must never
// take a row: a main-session agent (not isPanelAgentTask) and one dismissed
// with `x` (evictAfter === 0).
function makeTasks(): AppState['tasks'] {
  return {
    third: agentTask('third', 3000),
    first: agentTask('first', 1000),
    dismissed: agentTask('dismissed', 1500, { evictAfter: 0 }),
    second: agentTask('second', 2000),
    'main-session': agentTask('main-session', 500, {
      agentType: 'main-session',
    }),
  } as AppState['tasks']
}

/**
 * Mirrors the `case 'tasks'` branch of `footer:openSelected`
 * (PromptInput.tsx:1897-1907) for the non-teammate path: index 0 is the
 * `main` row, index >= 1 is `getVisibleAgentTasks(tasks)[index - 1]`, and an
 * index that resolves to nothing falls back to the bashes dialog.
 */
function resolveFooterEnter(
  index: number,
  tasks: AppState['tasks'],
  // The handler reads the COUNT from useCoordinatorTaskCount (which the
  // CLAUDE_CODE_DISABLE_AGENT_VIEW root gate can force to 0) but does the row
  // LOOKUP through the ungated getVisibleAgentTasks, so the two are separate
  // inputs here too. Defaults to the ungated count, leaving existing cases
  // byte-identical in behaviour.
  count: number = getVisibleAgentTasks(tasks).length,
): { target: 'main' } | { target: 'agent'; id: string } | { target: 'dialog' } {
  if (index === 0 && count > 0) return { target: 'main' }
  const id = getVisibleAgentTasks(tasks)[index - 1]?.id
  return id !== undefined ? { target: 'agent', id } : { target: 'dialog' }
}

test('getVisibleAgentTasks orders panel rows by startTime and drops non-rows', () => {
  const visible = getVisibleAgentTasks(makeTasks())
  expect(visible.map(t => t.id)).toEqual(['first', 'second', 'third'])
})

test('footer index N resolves to agent N, including the last row', () => {
  const tasks = makeTasks()
  const visible = getVisibleAgentTasks(tasks)
  // The count useCoordinatorTaskCount returns is also the LAST valid index:
  // the clamp must allow index === count, not count - 1, or the final agent
  // row is unreachable (PromptInput.tsx maxCoordinatorIndex).
  const count = visible.length
  expect(count).toBe(3)
  for (let n = 1; n <= count; n++) {
    expect(getVisibleAgentTasks(tasks)[n - 1]?.id).toBe(visible[n - 1]!.id)
    expect(resolveFooterEnter(n, tasks)).toEqual({
      target: 'agent',
      id: visible[n - 1]!.id,
    })
  }
  expect(resolveFooterEnter(count, tasks)).toEqual({
    target: 'agent',
    id: 'third',
  })
})

test('footer index 0 is the main row, not an agent', () => {
  const tasks = makeTasks()
  expect(getVisibleAgentTasks(tasks)[0 - 1]).toBeUndefined()
  expect(resolveFooterEnter(0, tasks)).toEqual({ target: 'main' })
})

test('an index past the last row falls back to the bashes dialog', () => {
  const tasks = makeTasks()
  expect(resolveFooterEnter(4, tasks)).toEqual({ target: 'dialog' })
})

test('Enter on agent N puts the app into that agent view', () => {
  const tasks = makeTasks()
  let state: AppState = { ...getDefaultAppState(), tasks }
  const setAppState = (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  }

  const selected = resolveFooterEnter(2, tasks)
  expect(selected).toEqual({ target: 'agent', id: 'second' })
  if (selected.target !== 'agent') throw new Error('unreachable')
  enterTeammateView(selected.id, setAppState)

  expect(state.viewingAgentTaskId).toBe('second')
  expect(state.viewSelectionMode).toBe('viewing-agent')
  const viewed = state.tasks.second as LocalAgentTaskState
  expect(viewed.retain).toBe(true)
  expect(viewed.evictAfter).toBeUndefined()
})

test('Enter on the main row exits the agent view', () => {
  const tasks = makeTasks()
  let state: AppState = { ...getDefaultAppState(), tasks }
  const setAppState = (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  }

  enterTeammateView('second', setAppState)
  expect(state.viewingAgentTaskId).toBe('second')

  expect(resolveFooterEnter(0, tasks)).toEqual({ target: 'main' })
  exitTeammateView(setAppState)

  expect(state.viewingAgentTaskId).toBeUndefined()
  expect(state.viewSelectionMode).toBe('none')
  expect((state.tasks.second as LocalAgentTaskState).retain).toBe(false)
})

/**
 * Mirrors `maxCoordinatorIndex` and the clamp effect
 * (PromptInput.tsx:435-448). With no panel rows the last selectable index
 * collapses onto the minimum, so a pointer left behind by a previously visible
 * panel is snapped back rather than pointing at an invisible row.
 */
function clampCoordinatorIndex(
  index: number,
  count: number,
  hasBgTaskPill: boolean,
): number {
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0
  const maxCoordinatorIndex = count > 0 ? count : minCoordinatorIndex
  if (index > maxCoordinatorIndex) return maxCoordinatorIndex
  if (index < minCoordinatorIndex) return minCoordinatorIndex
  return index
}

/**
 * Mirrors the `tasksSelected && !isTeammateMode` branch of `footer:down`
 * (PromptInput.tsx:1886-1901): panel rows exist → walk the pointer; no rows →
 * the pre-panel behaviour of opening the bashes dialog.
 */
function resolveFooterDown(count: number): 'walk' | 'dialog' {
  return count > 0 ? 'walk' : 'dialog'
}

const STALE_INDICES = [-2, -1, 0, 1, 2, 3, 4]

test('the opt-out count of 0 collapses every stale index onto the minimum row', () => {
  for (const hasBgTaskPill of [true, false]) {
    const min = hasBgTaskPill ? -1 : 0
    for (const stale of STALE_INDICES) {
      expect(clampCoordinatorIndex(stale, 0, hasBgTaskPill)).toBe(min)
    }
  }
})

test('with the count gated to 0, every reachable index opens the bashes dialog and never an agent view', () => {
  const tasks = makeTasks()
  for (const hasBgTaskPill of [true, false]) {
    for (const stale of STALE_INDICES) {
      const index = clampCoordinatorIndex(stale, 0, hasBgTaskPill)
      expect(resolveFooterEnter(index, tasks, 0)).toEqual({ target: 'dialog' })
      // footer:close guards on `coordinatorTaskIndex >= 1`
      // (PromptInput.tsx:1968), so a clamped pointer never reaches its
      // stop/dismiss path either.
      expect(index).toBeLessThan(1)
    }
  }
})

test('with the count gated to 0, footer:down falls back to the bashes dialog', () => {
  expect(resolveFooterDown(0)).toBe('dialog')
  expect(resolveFooterDown(getVisibleAgentTasks(makeTasks()).length)).toBe('walk')
})

test('the clamp is load-bearing: getVisibleAgentTasks stays pure, so an unclamped index would still find a row', () => {
  const tasks = makeTasks()
  // getVisibleAgentTasks is deliberately NOT gated — the panel render and this
  // lookup both need it. What makes the opt-out safe is that the gated count
  // collapses maxCoordinatorIndex, and the clamp drags the pointer down with
  // it. This case pins that dependency so nobody deletes the clamp believing
  // the lookup defends itself.
  expect(getVisibleAgentTasks(tasks).length).toBe(3)
  expect(resolveFooterEnter(2, tasks, 0)).toEqual({
    target: 'agent',
    id: 'second',
  })
})

/**
 * Mirrors `hasBgTaskPill` / `minCoordinatorIndex` (PromptInput.tsx:433-434).
 * The -1 sentinel is the pill's own slot, so it may only exist when the pill
 * actually renders — BackgroundTaskStatus filters with the same predicate and
 * returns null on an empty list. Both sides go through isPillTask so the two
 * cannot drift apart.
 */
function minCoordinatorIndexFor(tasks: AppState['tasks']): number {
  const hasBgTaskPill = Object.values(tasks).some(t =>
    isPillTask(t as TaskState),
  )
  return hasBgTaskPill ? -1 : 0
}

/** Only panel rows: every task here gives up its pill while the panel exists. */
function panelAgentsOnly(): AppState['tasks'] {
  return {
    third: agentTask('third', 3000),
    first: agentTask('first', 1000),
    second: agentTask('second', 2000),
  } as AppState['tasks']
}

function bashTask(id: string): TaskState {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    startTime: 0,
  } as unknown as TaskState
}

test('panel active + only local agents: no pill renders, so the minimum index is 0', () => {
  const tasks = panelAgentsOnly()
  expect(minCoordinatorIndexFor(tasks)).toBe(0)
  // First ↓ therefore highlights `● main` rather than an invisible -1 slot.
  expect(clampCoordinatorIndex(-1, getVisibleAgentTasks(tasks).length, false)).toBe(0)
})

test('panel active + a non-agent background task: the pill is real, so -1 stays', () => {
  const tasks = {
    ...panelAgentsOnly(),
    sh: bashTask('sh'),
  } as AppState['tasks']
  expect(minCoordinatorIndexFor(tasks)).toBe(-1)
})

test('panel active + a dismissed or main-session agent: those keep their pills, so -1 stays', () => {
  // makeTasks() carries both, which is why it must not be used as the
  // "only local agents" fixture above.
  expect(minCoordinatorIndexFor(makeTasks())).toBe(-1)
})

test('opt-out set + only local agents: the pill comes back and so does the -1 slot', () => {
  const tasks = panelAgentsOnly()
  expect(minCoordinatorIndexFor(tasks)).toBe(0)
  process.env[ENV_VAR] = '1'
  expect(minCoordinatorIndexFor(tasks)).toBe(-1)
})

test('the pill slot and the pill filter agree in both env states', () => {
  const tasks = panelAgentsOnly()
  for (const [value, expected] of [
    [undefined, 0],
    ['1', -1],
  ] as Array<[string | undefined, number]>) {
    if (value === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = value
    }
    const pillTasks = Object.values(tasks).filter(t => isPillTask(t as TaskState))
    // -1 exists iff BackgroundTaskStatus has at least one row to render.
    expect(minCoordinatorIndexFor(tasks)).toBe(expected)
    expect(pillTasks.length > 0).toBe(expected === -1)
  }
})
