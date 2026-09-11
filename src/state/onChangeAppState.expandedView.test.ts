import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { DISABLE_AGENT_TEAMS_ENV } from '../utils/agentSwarmsEnabled.js'
import { getGlobalConfig } from '../utils/config.js'
import { type AppState, getDefaultAppState } from './AppStateStore.js'
import { onChangeAppState } from './onChangeAppState.js'

/**
 * The WRITER half of the expandedView preference, the one deriveInitialExpandedView
 * reads back. Both booleans go out in a single saveGlobalConfig, so with Agent
 * Teams off the computed tree flag — whatever it works out to — overwrote the
 * preference recorded while the feature was on, and the mere difference against
 * the stored value was enough to enter the save, so expanding the todo list was
 * all it took.
 *
 * Under NODE_ENV=test getGlobalConfig and saveGlobalConfig share one in-memory
 * object, so the assertions read the config the block actually wrote — and,
 * through countingSaves below, whether it wrote at all. Values alone cannot tell
 * a guard that stayed shut from a save that wrote the same pair straight back,
 * which is the difference between the two halves of the gate.
 */

let savedDisableEnv: string | undefined
let savedShowExpandedTodos: boolean | undefined
let savedShowSpinnerTree: boolean | undefined
let saves: () => number

/**
 * How many times the block called saveGlobalConfig.
 *
 * Its NODE_ENV=test path is `Object.assign(current, updater(current))`, and the
 * updater spreads `current`, so every save writes back every own enumerable key
 * of the config — including this probe key, whose setter does the counting. The
 * key belongs to the test only; nothing in the block reads it.
 */
const SAVE_PROBE_KEY = '__expandedViewSaveProbe'

function countingSaves(): () => number {
  const config = getGlobalConfig() as unknown as Record<string, unknown>
  let count = 0
  let held: unknown = 0
  Object.defineProperty(config, SAVE_PROBE_KEY, {
    configurable: true,
    enumerable: true,
    get: () => held,
    set: value => {
      count++
      held = value
    },
  })
  return () => count
}

beforeEach(async () => {
  await acquireSharedMutationLock('state/onChangeAppState.expandedView.test.ts')
  savedDisableEnv = process.env[DISABLE_AGENT_TEAMS_ENV]
  const config = getGlobalConfig()
  savedShowExpandedTodos = config.showExpandedTodos
  savedShowSpinnerTree = config.showSpinnerTree
  saves = countingSaves()
})

afterEach(() => {
  try {
    const config = getGlobalConfig()
    delete (config as unknown as Record<string, unknown>)[SAVE_PROBE_KEY]
    config.showExpandedTodos = savedShowExpandedTodos
    config.showSpinnerTree = savedShowSpinnerTree
    if (savedDisableEnv === undefined) {
      delete process.env[DISABLE_AGENT_TEAMS_ENV]
    } else {
      process.env[DISABLE_AGENT_TEAMS_ENV] = savedDisableEnv
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/** One expandedView transition, with nothing else in AppState moving. */
function changeView(
  from: AppState['expandedView'],
  to: AppState['expandedView'],
): void {
  const base = getDefaultAppState()
  onChangeAppState({
    oldState: { ...base, expandedView: from },
    newState: { ...base, expandedView: to },
  })
}

function storeConfig(options: {
  showExpandedTodos: boolean
  showSpinnerTree: boolean
}): { showExpandedTodos?: boolean; showSpinnerTree?: boolean } {
  const config = getGlobalConfig()
  config.showExpandedTodos = options.showExpandedTodos
  config.showSpinnerTree = options.showSpinnerTree
  return config
}

describe('expandedView persistence with Agent Teams off', () => {
  test('expanding the todo list leaves a stored teammates preference intact', () => {
    process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
    const config = storeConfig({
      showExpandedTodos: false,
      showSpinnerTree: true,
    })

    changeView('none', 'tasks')

    // The todo list is not a teams preference: a feature-off session still
    // records it — one save, which is also what proves the counter below is
    // live rather than stuck at zero...
    expect(saves()).toBe(1)
    expect(config.showExpandedTodos).toBe(true)
    // ...and the tree preference it cannot express survives that save untouched.
    expect(config.showSpinnerTree).toBe(true)
  })

  test('a transition that differs only on the tree flag saves nothing', () => {
    process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
    const config = storeConfig({
      showExpandedTodos: false,
      showSpinnerTree: true,
    })

    // 'tasks' → 'none' with the todo list already stored as hidden: the only
    // difference left is the tree flag, which used to open the save on its own.
    changeView('tasks', 'none')

    // The guard half, and the only assertion that can see it: with the payload
    // spread in place the two values below read the same whether the save was
    // skipped or wrote them straight back, so the save itself has to be counted.
    expect(saves()).toBe(0)
    expect(config.showSpinnerTree).toBe(true)
    expect(config.showExpandedTodos).toBe(false)
  })
})

describe('expandedView persistence with Agent Teams on', () => {
  test('showing the teammates panel is recorded', () => {
    delete process.env[DISABLE_AGENT_TEAMS_ENV]
    const config = storeConfig({
      showExpandedTodos: false,
      showSpinnerTree: false,
    })

    changeView('none', 'teammates')

    expect(saves()).toBe(1)
    expect(config.showSpinnerTree).toBe(true)
    expect(config.showExpandedTodos).toBe(false)
  })

  test('hiding it is recorded too, and the pair still goes out together', () => {
    delete process.env[DISABLE_AGENT_TEAMS_ENV]
    const config = storeConfig({
      showExpandedTodos: false,
      showSpinnerTree: true,
    })

    changeView('teammates', 'tasks')

    expect(saves()).toBe(1)
    expect(config.showSpinnerTree).toBe(false)
    expect(config.showExpandedTodos).toBe(true)
  })
})
