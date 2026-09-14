import { afterEach, describe, expect, test } from 'bun:test'

import type { AppState } from 'src/state/AppState.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import {
  checkAndDisableBypassPermissionsIfNeeded,
  downgradeLiveTeammateDangerousModes,
  resetBypassPermissionsCheck,
} from './bypassPermissionsKillswitch.js'
import { createDisabledBypassPermissionsContext } from './permissionSetup.js'

afterEach(() => {
  resetBypassPermissionsCheck()
})

describe('checkAndDisableBypassPermissionsIfNeeded', () => {
  test('does not latch the run-once guard before dangerous mode becomes available', async () => {
    let gateChecks = 0

    await checkAndDisableBypassPermissionsIfNeeded(
      {
        isBypassPermissionsModeAvailable: false,
      } as never,
      () => {},
      {
        createDisabledBypassPermissionsContext: context => context,
        shouldDisableBypassPermissions: async () => {
          gateChecks += 1
          return false
        },
      },
    )

    expect(gateChecks).toBe(0)

    await checkAndDisableBypassPermissionsIfNeeded(
      {
        isBypassPermissionsModeAvailable: true,
      } as never,
      () => {},
      {
        createDisabledBypassPermissionsContext: context => context,
        shouldDisableBypassPermissions: async () => {
          gateChecks += 1
          return false
        },
      },
    )

    expect(gateChecks).toBe(1)
  })

  test('shares the in-flight authoritative check between startup and first query', async () => {
    let gateChecks = 0
    let disabledContexts = 0
    let appStateUpdates = 0
    let resolveGateCheck: ((value: boolean) => void) | undefined

    // Minimal fixture: the killswitch only reads isBypassPermissionsModeAvailable.
    const context = {
      isBypassPermissionsModeAvailable: true,
    } as ToolPermissionContext

    const setAppState = (update: (prev: AppState) => AppState) => {
      appStateUpdates += 1
      // Minimal prev state: the updater touches toolPermissionContext and
      // sweeps `tasks` for live teammates holding a now-revoked mode.
      update({
        toolPermissionContext: context,
        tasks: {},
      } as AppState)
    }

    const deps = {
      createDisabledBypassPermissionsContext: (
        currentContext: typeof context,
      ) => {
        disabledContexts += 1
        return currentContext
      },
      shouldDisableBypassPermissions: () => {
        gateChecks += 1
        return new Promise<boolean>(resolve => {
          resolveGateCheck = resolve
        })
      },
    }

    const startupCheck = checkAndDisableBypassPermissionsIfNeeded(
      context,
      setAppState,
      deps,
    )
    const firstQueryCheck = checkAndDisableBypassPermissionsIfNeeded(
      context,
      setAppState,
      deps,
    )

    expect(gateChecks).toBe(1)

    resolveGateCheck?.(true)
    await Promise.all([startupCheck, firstQueryCheck])

    expect(disabledContexts).toBe(1)
    expect(appStateUpdates).toBe(1)
  })

  test('strips a revoked dangerous mode from teammates that are already running', async () => {
    // Revoking the leader's context does not reach a teammate that is already
    // running: it carries its own permissionMode, the runner re-reads that
    // field every iteration, and runAgent writes it back over the live context
    // exactly when the live mode is no longer dangerous. Without the sweep the
    // teammate keeps bypass for the rest of its life.
    const context = {
      mode: 'bypassPermissions',
      isBypassPermissionsModeAvailable: true,
    } as ToolPermissionContext

    let nextState: AppState | undefined
    const prev = {
      toolPermissionContext: context,
      tasks: {
        'task-bypass': {
          type: 'in_process_teammate',
          permissionMode: 'bypassPermissions',
        },
        'task-full': {
          type: 'in_process_teammate',
          permissionMode: 'fullAccess',
        },
        // Must survive untouched: plan is planModeRequired intent, and the
        // leader can cycle a teammate's mode by hand.
        'task-plan': { type: 'in_process_teammate', permissionMode: 'plan' },
        'task-edits': {
          type: 'in_process_teammate',
          permissionMode: 'acceptEdits',
        },
        // Not a teammate, so not this killswitch's business.
        'task-agent': {
          type: 'local_agent',
          permissionMode: 'bypassPermissions',
        },
      },
    } as unknown as AppState

    await checkAndDisableBypassPermissionsIfNeeded(
      context,
      update => {
        nextState = update(prev)
      },
      {
        // The real transform, not a stub: the point is that the teammate sweep
        // happens in the same update as the context revocation.
        createDisabledBypassPermissionsContext,
        shouldDisableBypassPermissions: async () => true,
      },
    )

    const tasks = nextState?.tasks as unknown as Record<
      string,
      { permissionMode: string }
    >
    expect(nextState?.toolPermissionContext.isBypassPermissionsModeAvailable).toBe(
      false,
    )
    expect(tasks['task-bypass']?.permissionMode).toBe('default')
    expect(tasks['task-full']?.permissionMode).toBe('default')
    expect(tasks['task-plan']?.permissionMode).toBe('plan')
    expect(tasks['task-edits']?.permissionMode).toBe('acceptEdits')
    expect(tasks['task-agent']?.permissionMode).toBe('bypassPermissions')
  })
})

describe('downgradeLiveTeammateDangerousModes', () => {
  test('returns the same reference when no teammate holds a dangerous mode', () => {
    const tasks = {
      a: { type: 'in_process_teammate', permissionMode: 'plan' },
    } as unknown as AppState['tasks']

    expect(downgradeLiveTeammateDangerousModes(tasks)).toBe(tasks)
  })
})
