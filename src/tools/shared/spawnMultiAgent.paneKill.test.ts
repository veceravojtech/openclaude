import { afterEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { registerTmuxBackend } from '../../utils/swarm/backends/registry.js'
import { TmuxBackend } from '../../utils/swarm/backends/TmuxBackend.js'
import type { PaneBackend } from '../../utils/swarm/backends/types.js'
import * as spawnMod from './spawnMultiAgent.js'

// The abort listener armed by `registerOutOfProcessTeammateTask` is the one
// kill that still derived the tmux socket from the spawning process's
// environment (`killPane(paneId, !insideTmux)`). A wrong guess here does not
// mislabel — it destroys a pane on a server this session may not own. These
// pin the fix: the listener must kill on the recorded socket via
// `killPaneOnSocket`, and must fail closed (pass the missing socket through,
// never guess) when no socket was recorded.

type RegisterFn = (
  setAppState: (updater: (prev: AppState) => AppState) => void,
  options: Record<string, unknown>,
  deps?: Record<string, unknown>,
) => unknown

function register(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  options: Record<string, unknown>,
): void {
  const fn = (
    spawnMod as unknown as Record<string, unknown>
  ).registerOutOfProcessTeammateTask as RegisterFn | undefined
  if (typeof fn !== 'function') {
    throw new Error('registerOutOfProcessTeammateTask is not exported')
  }
  // scanIntervalMs: null keeps the watchdog's interval from being armed — this
  // test only drives the abort signal, never a scan.
  fn(setAppState, options, { scanIntervalMs: null })
}

/** A fake tmux backend whose killPaneOnSocket records calls and fails closed. */
function installFakeTmuxBackend(): {
  calls: Array<{ paneId: string; socket?: string }>
} {
  const calls: Array<{ paneId: string; socket?: string }> = []
  class FakeTmuxBackend {
    async killPaneOnSocket(paneId: string, socket?: string): Promise<boolean> {
      calls.push({ paneId, socket })
      // Mirror the real contract: no recorded socket means no positive server
      // identity, so the pane is not killed.
      return socket !== undefined
    }
  }
  registerTmuxBackend(FakeTmuxBackend as unknown as new () => PaneBackend)
  return { calls }
}

afterEach(() => {
  registerTmuxBackend(TmuxBackend)
})

function makeWorld(): {
  setAppState: (updater: (prev: AppState) => AppState) => void
  abortController: () => AbortController | undefined
} {
  let state = {
    tasks: {},
    // abortSpeculation (in enqueueAgentNotification) reads this.
    speculation: { status: 'idle' },
  } as unknown as AppState
  return {
    setAppState: updater => {
      state = updater(state)
    },
    abortController: () => {
      const task = Object.values(
        state.tasks as Record<string, Record<string, unknown>>,
      )[0]
      return task?.abortController as AbortController | undefined
    },
  }
}

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teammateId: 'worker@team',
    sanitizedName: 'worker',
    teamName: 'team',
    teammateColor: 'cyan',
    prompt: 'do the thing',
    plan_mode_required: false,
    paneId: '%42',
    backendType: 'tmux',
    toolUseId: 'toolu-1',
    ...extra,
  }
}

test('aborting a running pane teammate kills its pane on the recorded socket', () => {
  const { calls } = installFakeTmuxBackend()
  const world = makeWorld()
  register(world.setAppState, baseOptions({ tmuxSocket: 'swarm-socket' }))

  const abortController = world.abortController()
  expect(abortController).toBeDefined()
  abortController!.abort()

  // The recorded socket, not a socket re-derived from the spawning process.
  expect(calls).toEqual([{ paneId: '%42', socket: 'swarm-socket' }])
})

test('aborting with no recorded socket fails closed and never guesses', () => {
  const { calls } = installFakeTmuxBackend()
  const world = makeWorld()
  // No tmuxSocket: a legacy member has no recorded server identity.
  register(world.setAppState, baseOptions())

  const abortController = world.abortController()
  expect(abortController).toBeDefined()
  abortController!.abort()

  // The listener still routed through killPaneOnSocket with the missing socket
  // (which fails closed) instead of falling back to a guessed socket.
  expect(calls).toEqual([{ paneId: '%42', socket: undefined }])
})
