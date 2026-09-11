import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'

import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import {
  type AppState,
  AppStateProvider,
  useAppState,
} from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { TaskState } from '../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { DISABLE_AGENT_TEAMS_ENV } from '../utils/agentSwarmsEnabled.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

/**
 * Shift+↑/↓ with Agent Teams DISABLED.
 *
 * `expandedView: 'teammates'` alone used to be reason enough for this hook to
 * swallow the press into selecting-agent mode. With the feature off
 * TeammateTreePanel draws nothing, so that moved a highlight nobody could see
 * AND made the background-tasks dialog unreachable from the keyboard — the
 * `hasNonTeammateBackgroundTasks` branch below was never reached. The view is
 * no longer reachable with the feature off (the Ctrl+T cycle skips it, the boot
 * derivation maps it to 'none'), and this is the third gate: whatever a stale
 * AppState says the view is, the key does what the screen shows.
 */

let savedDisableEnv: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'hooks/useBackgroundTaskNavigation.agentTeamsDisabled.test.tsx',
  )
  savedDisableEnv = process.env[DISABLE_AGENT_TEAMS_ENV]
})

afterEach(() => {
  if (savedDisableEnv === undefined) {
    delete process.env[DISABLE_AGENT_TEAMS_ENV]
  } else {
    process.env[DISABLE_AGENT_TEAMS_ENV] = savedDisableEnv
  }
  releaseSharedMutationLock()
})

/** A background agent: a non-teammate task, so it owns the dialog branch. */
function backgroundAgent(): TaskState {
  return {
    id: 'task-agent',
    type: 'local_agent',
    status: 'running',
    description: 'a background agent',
    startTime: 1_700_000_000_000,
    outputFile: '/tmp/agent.log',
    outputOffset: 0,
    notified: false,
    retain: false,
    messages: [],
    pendingMessages: [],
  } as unknown as TaskState
}

function stateWith(overrides: Partial<AppState>): AppState {
  return {
    ...getDefaultAppState(),
    expandedView: 'teammates',
    tasks: { 'task-agent': backgroundAgent() },
    ...overrides,
  } as AppState
}

function shiftArrow(name: 'up' | 'down'): KeyboardEvent {
  const sequence = `\x1b[1;2${name === 'down' ? 'B' : 'A'}`
  return new KeyboardEvent({
    kind: 'key',
    name,
    sequence,
    raw: sequence,
    ctrl: false,
    shift: true,
    meta: false,
    option: false,
    super: false,
    fn: false,
    isPasted: false,
  })
}

type Observed = {
  viewSelectionMode: string
  selectedTeammate: AppState['selectedTeammate']
}

function Harness({
  onReady,
  onState,
  onOpenBackgroundTasks,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
  onState: (state: Observed) => void
  onOpenBackgroundTasks: () => void
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation({
    onOpenBackgroundTasks,
  })
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const selectedTeammate = useAppState(s => s.selectedTeammate)
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  useEffect(
    () => onState({ viewSelectionMode, selectedTeammate }),
    [viewSelectionMode, selectedTeammate, onState],
  )
  return null
}

async function renderNavigation(initialState: AppState): Promise<{
  press: (event: KeyboardEvent) => Promise<void>
  opened: () => number
  state: () => Observed
  cleanup: () => Promise<void>
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let handler: ((event: KeyboardEvent) => void) | undefined
  let openCount = 0
  let latest: Observed = { viewSelectionMode: 'none', selectedTeammate: null }
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
  }
  try {
    root.render(
      <AppStateProvider initialState={initialState}>
        <Harness
          onReady={value => {
            handler = value
          }}
          onState={value => {
            latest = value
          }}
          onOpenBackgroundTasks={() => {
            openCount++
          }}
        />
      </AppStateProvider>,
    )
    for (let attempts = 0; attempts < 100 && !handler; attempts++) {
      await Bun.sleep(10)
    }
    expect(handler).toBeDefined()
    return {
      async press(event) {
        handler!(event)
        await Bun.sleep(30)
      },
      opened: () => openCount,
      state: () => latest,
      cleanup: teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

test('Shift+Up opens the background-tasks dialog when Agent Teams are off, even on a stale teammates view', async () => {
  process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
  const mounted = await renderNavigation(stateWith({}))
  try {
    await mounted.press(shiftArrow('up'))

    expect(mounted.opened()).toBe(1)
    // …and nothing was selected on the panel that is not on screen.
    expect(mounted.state().viewSelectionMode).toBe('none')
    expect(mounted.state().selectedTeammate).toBeNull()
  } finally {
    await mounted.cleanup()
  }
})

test('Shift+Down does the same — both directions went to the invisible panel', async () => {
  process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
  const mounted = await renderNavigation(stateWith({}))
  try {
    await mounted.press(shiftArrow('down'))
    expect(mounted.opened()).toBe(1)
    expect(mounted.state().viewSelectionMode).toBe('none')
  } finally {
    await mounted.cleanup()
  }
})

test('with Agent Teams ENABLED the very same state still steps the panel', async () => {
  // The enabled path is byte-identical: an empty teammates panel is reason
  // enough to step, because its leader and hide rows are selectable with no
  // teammate alive. This is the half of the gate that must NOT have moved.
  delete process.env[DISABLE_AGENT_TEAMS_ENV]
  const mounted = await renderNavigation(stateWith({}))
  try {
    await mounted.press(shiftArrow('down'))

    expect(mounted.opened()).toBe(0)
    expect(mounted.state().viewSelectionMode).toBe('selecting-agent')
    // With no teammate alive the selectable rows are leader and hide, so one
    // step down off the leader lands on hide — unchanged from before this fix.
    expect(mounted.state().selectedTeammate).toEqual({ kind: 'hide' })
  } finally {
    await mounted.cleanup()
  }
})

test('with the feature off and no background task either, the press does nothing at all', async () => {
  // No dialog to open and no panel to step: the branch falls through rather
  // than calling a handler that is not there.
  process.env[DISABLE_AGENT_TEAMS_ENV] = '1'
  const mounted = await renderNavigation(stateWith({ tasks: {} }))
  try {
    await mounted.press(shiftArrow('up'))
    expect(mounted.opened()).toBe(0)
    expect(mounted.state().viewSelectionMode).toBe('none')
  } finally {
    await mounted.cleanup()
  }
})
