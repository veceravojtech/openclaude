import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { TaskState } from '../../tasks/types.js'
import { isAgentViewDisabled } from '../../utils/envUtils.js'
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

// The teammate tree is the SECOND way the CoordinatorTaskPanel goes unmounted:
// PromptInput renders it on `coordinatorTaskCount > 0 && !showSpinnerTree`.
// Only the opt-out used to be accounted for here, so with the tree expanded a
// local agent was dropped from the pill by an exclusion whose justification —
// "the panel already lists it" — was false, and it appeared on neither surface.
// expandedView is sticky, so one Shift+Up hid every later teamless subagent.
describe('background-task pill filter with the teammate tree expanded', () => {
  test('a running local agent is a pill task again — the panel is unmounted', () => {
    expect(isPillTask(agent('a'), true)).toBe(true)
    expect(isPillTask(agent('a', { status: 'pending' }), true)).toBe(true)
  })

  test('the same agent flips back to excluded when the tree collapses', () => {
    const t = agent('a')
    expect(isPillTask(t, true)).toBe(true)
    // The panel is mounted again and lists it, so the pill must stand down —
    // the identical task object answers differently on the flag alone.
    expect(isPillTask(t, false)).toBe(false)
  })

  test('defaults to the panel-mounted answer when the flag is omitted', () => {
    expect(isPillTask(agent('a'))).toBe(isPillTask(agent('a'), false))
  })

  test('composes with the opt-out — either unmount hands the pill back', () => {
    setAgentView('1')
    expect(isPillTask(agent('a'), true)).toBe(true)
    expect(isPillTask(agent('a'), false)).toBe(true)
  })

  test('terminal tasks stay dropped — the tree never resurrects one', () => {
    expect(isPillTask(agent('a', { status: 'completed' }), true)).toBe(false)
    expect(isPillTask(task('sh', 'local_bash', { status: 'completed' }), true)).toBe(
      false,
    )
  })
})

// Regression guard for the fix: team-based agents must be untouched by it.
// in_process_teammate never entered the exclusion in the first place
// (isPanelAgentTask matches only local_agent), so it keeps its pill in every
// combination of the two unmount conditions.
describe('teammate pills are unaffected by the teammate-tree gate', () => {
  test.each(ENV_STATES)(
    'a running teammate keeps its pill with the tree expanded and collapsed (%s)',
    (_label, value) => {
      setAgentView(value)
      expect(isPillTask(task('t', 'in_process_teammate'), true)).toBe(true)
      expect(isPillTask(task('t', 'in_process_teammate'), false)).toBe(true)
    },
  )

  test.each(ENV_STATES)(
    'non-agent pills are unchanged with the tree expanded (%s)',
    (_label, value) => {
      setAgentView(value)
      expect(isPillTask(task('sh', 'local_bash'), true)).toBe(true)
      expect(isPillTask(task('mon', 'monitor_mcp'), true)).toBe(true)
      expect(isPillTask(task('rem', 'remote_agent'), true)).toBe(true)
      expect(isPillTask(task('wf', 'local_workflow'), true)).toBe(true)
      expect(isPillTask(task('dr', 'dream'), true)).toBe(true)
    },
  )
})

// ── The collapsed-state half of the claim ────────────────────────────────────
// `isPillTask(t, false) === false` says the pill stands down; on its own it says
// NOTHING about the agent being visible. The other surface has to be shown to
// draw it. `panelDrawsRow` below is not a reimplementation — it is the three
// gates that decide whether a row exists, each read off the shipped code:
//
//   1. CoordinatorAgentStatus.tsx:101-107 (`useCoordinatorTaskCount`) — the
//      panel's ROOT gate: CLAUDE_CODE_DISABLE_AGENT_VIEW forces the count to 0.
//   2. PromptInput.tsx:2453 — the panel mounts on
//      `coordinatorTaskCount > 0 && !showSpinnerTree`.
//   3. CoordinatorAgentStatus.tsx:38-40 (`getVisibleAgentTasks`) — the panel's
//      OWN row filter, `isPanelAgentTask(t) && isPanelVisibleAgent(t)`: the
//      identical conjunction isPillTask excludes on (taskStatusUtils.tsx:140).
//      Imported, not copied, so the two cannot drift.
function panelDrawsRow(t: TaskState, showSpinnerTree: boolean): boolean {
  const tasks = { [t.id]: t } as unknown as AppState['tasks']
  const coordinatorTaskCount = isAgentViewDisabled()
    ? 0
    : getVisibleAgentTasks(tasks).length
  if (!(coordinatorTaskCount > 0) || showSpinnerTree) return false
  return getVisibleAgentTasks(tasks).some(row => row.id === t.id)
}

describe('a teamless subagent is drawn by exactly one surface in every state', () => {
  // The 2x2 of the two unmount conditions, with the surface that owes the row.
  // BOTH false is the bug this fix closes (invisible everywhere); BOTH true is
  // the double-listing the exclusion exists to prevent. Neither may happen.
  const SURFACES: Array<[string, string | undefined, boolean, 'pill' | 'panel']> = [
    ['panel active, tree collapsed — the panel owes the row', undefined, false, 'panel'],
    ['panel active, tree expanded — the panel is unmounted', undefined, true, 'pill'],
    ['opted out, tree collapsed — no panel exists', '1', false, 'pill'],
    ['opted out, tree expanded — neither panel path exists', '1', true, 'pill'],
  ]

  test.each(SURFACES)('%s', (_label, value, showSpinnerTree, surface) => {
    setAgentView(value)
    const t = agent('a')
    const pill = isPillTask(t, showSpinnerTree)
    const panel = panelDrawsRow(t, showSpinnerTree)
    expect(pill).toBe(surface === 'pill')
    expect(panel).toBe(surface === 'panel')
    // Visible somewhere, and never twice — the property the whole gate exists for.
    expect(pill !== panel).toBe(true)
  })

  test.each(ENV_STATES)(
    'the handoff is exact for every running task shape (%s)',
    (_label, value) => {
      setAgentView(value)
      const cases = [
        agent('a'),
        agent('m', { agentType: 'main-session' }),
        agent('x', { evictAfter: 0 }),
        task('t', 'in_process_teammate'),
        task('sh', 'local_bash'),
      ]
      for (const t of cases) {
        for (const showSpinnerTree of [false, true]) {
          // Every case here is running, so it is a background task and the pill
          // can only be withheld by the panel exclusion — which makes "pill" and
          // "panel row" exact complements. One surface always has it.
          expect(isPillTask(t, showSpinnerTree)).toBe(!panelDrawsRow(t, showSpinnerTree))
        }
      }
    },
  )
})

// ── Blast radius, enumerated rather than asserted ────────────────────────────
// isPanelAgentTask (LocalAgentTask.tsx:170-172) is `isLocalAgentTask(t) &&
// agentType !== 'main-session'`, and isLocalAgentTask (:160-162) gates on
// `type === 'local_agent'`. So no other member of the union can reach the
// exclusion at taskStatusUtils.tsx:140. The enumeration below proves it for
// every member of TaskState (src/tasks/types.ts:12-19) instead of trusting the
// reading.
const UNION_TYPES = [
  'local_bash',
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
] as const

describe('the teammate-tree flag moves local_agent and nothing else', () => {
  test('the enumeration covers the whole TaskState union', () => {
    // Record<TaskState['type'], true> is the compile-time half: adding a member
    // to the union makes this literal fail to typecheck until it is listed here,
    // so the runtime enumeration below cannot silently go stale.
    const covered: Record<TaskState['type'], true> = {
      local_bash: true,
      local_agent: true,
      remote_agent: true,
      in_process_teammate: true,
      local_workflow: true,
      monitor_mcp: true,
      dream: true,
    }
    expect(Object.keys(covered).sort()).toEqual([...UNION_TYPES].sort())
  })

  test.each(ENV_STATES)(
    'local_agent is the ONLY member whose answer moves on the flag (%s)',
    (_label, value) => {
      setAgentView(value)
      const moved: string[] = []
      for (const type of UNION_TYPES) {
        const t = type === 'local_agent' ? agent('a') : task(type, type)
        if (isPillTask(t, true) !== isPillTask(t, false)) moved.push(type)
        // Tree expanded: no panel exists, so every background task keeps a pill.
        expect(isPillTask(t, true)).toBe(true)
      }
      // With the opt-out set the panel was already gone, so nothing moves at all.
      expect(moved).toEqual(value === undefined ? ['local_agent'] : [])
    },
  )
})
