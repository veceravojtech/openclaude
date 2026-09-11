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
 * Teams off a session that can only ever compute `showSpinnerTree: false` would
 * clear the tree preference recorded while the feature was on — and the mere
 * difference against the stored value was enough to enter the save, so expanding
 * the todo list was all it took.
 *
 * Under NODE_ENV=test getGlobalConfig and saveGlobalConfig share one in-memory
 * object, so the assertions read the config the block actually wrote.
 */

let savedDisableEnv: string | undefined
let savedShowExpandedTodos: boolean | undefined
let savedShowSpinnerTree: boolean | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('state/onChangeAppState.expandedView.test.ts')
  savedDisableEnv = process.env[DISABLE_AGENT_TEAMS_ENV]
  const config = getGlobalConfig()
  savedShowExpandedTodos = config.showExpandedTodos
  savedShowSpinnerTree = config.showSpinnerTree
})

afterEach(() => {
  try {
    const config = getGlobalConfig()
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
    // records it...
    expect(config.showExpandedTodos).toBe(true)
    // ...and the tree preference it cannot express survives untouched.
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

    expect(config.showSpinnerTree).toBe(false)
    expect(config.showExpandedTodos).toBe(true)
  })
})
