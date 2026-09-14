import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { createDisabledBypassPermissionsContext } from '../permissions/permissionSetup.js'
import {
  killInProcessTeammate,
  resolveTeammatePermissionMode,
  spawnInProcessTeammate,
} from './spawnInProcess.js'

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/spawnInProcess.permissionMode.test.ts',
  )
})

afterEach(() => {
  releaseSharedMutationLock()
})

function bypassContext(): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  }
}

/**
 * Spawns a teammate against a leader AppState pinned to `leaderContext` and
 * returns the permission mode the teammate's task state was registered with.
 */
async function spawnAndReadMode(
  name: string,
  {
    leaderContext,
    planModeRequired = false,
    withoutGetAppState = false,
  }: {
    leaderContext?: ToolPermissionContext
    planModeRequired?: boolean
    withoutGetAppState?: boolean
  },
): Promise<string> {
  let state: AppState = getDefaultAppState()
  if (leaderContext) {
    state = { ...state, toolPermissionContext: leaderContext }
  }
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
  }
  const getAppState = (): AppState => state

  const spawn = await spawnInProcessTeammate(
    { name, teamName: 'perm-team', prompt: 'work', planModeRequired },
    withoutGetAppState ? { setAppState } : { setAppState, getAppState },
  )
  if (!spawn.success || !spawn.taskId) {
    throw new Error(`spawn failed: ${spawn.error}`)
  }
  const task = state.tasks[spawn.taskId]
  if (!task || task.type !== 'in_process_teammate') {
    throw new Error('teammate task was not registered')
  }
  const mode = task.permissionMode
  killInProcessTeammate(spawn.taskId, setAppState)
  return mode
}

test('a teammate spawned under a bypassPermissions leader inherits it', async () => {
  expect(
    await spawnAndReadMode('inheritor', { leaderContext: bypassContext() }),
  ).toBe('bypassPermissions')
})

test('a teammate spawned under a default leader stays in default', async () => {
  expect(await spawnAndReadMode('plain', {})).toBe('default')
})

test('planModeRequired still wins over the leader mode', async () => {
  expect(
    await spawnAndReadMode('planner', {
      leaderContext: bypassContext(),
      planModeRequired: true,
    }),
  ).toBe('plan')
})

test('a caller without getAppState falls back to default', async () => {
  // respawn/handoff paths that only hold a setter must not silently widen
  // permissions — absent evidence of the leader's mode, prompt.
  expect(
    await spawnAndReadMode('setter-only', { withoutGetAppState: true }),
  ).toBe('default')
})

test('the org-policy killswitch is not defeated by spawning a teammate', async () => {
  // checkAndDisableBypassPermissionsIfNeeded applies exactly this transform to
  // the LIVE context when policy revokes bypass mid-session. A teammate
  // spawned afterwards must read the revoked context, not the original one.
  const revoked = createDisabledBypassPermissionsContext(bypassContext())
  expect(revoked.isBypassPermissionsModeAvailable).toBe(false)

  expect(
    await spawnAndReadMode('post-killswitch', { leaderContext: revoked }),
  ).toBe('default')
})

test('a spawn cannot inherit bypass from a context whose mode field lags', async () => {
  // The killswitch test above is satisfied by the mode reset alone, so on its
  // own it would still pass if the availability guard were deleted. This pins
  // that guard through the real spawn path: a context that still SAYS
  // bypassPermissions while availability is revoked must not widen a teammate.
  expect(
    await spawnAndReadMode('lagging-mode', {
      leaderContext: {
        ...bypassContext(),
        isBypassPermissionsModeAvailable: false,
      },
    }),
  ).toBe('default')
})

test('a dangerous mode is not inherited once bypass availability is revoked', () => {
  // Belt-and-braces for the killswitch: even if the mode field still read
  // bypassPermissions, the cleared availability flag alone must block it.
  expect(
    resolveTeammatePermissionMode({
      planModeRequired: false,
      leaderPermissionContext: {
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: false,
      },
    }),
  ).toBe('default')

  expect(
    resolveTeammatePermissionMode({
      planModeRequired: false,
      leaderPermissionContext: {
        mode: 'fullAccess',
        isBypassPermissionsModeAvailable: false,
      },
    }),
  ).toBe('default')
})

test('non-dangerous leader modes are inherited as-is', () => {
  for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
    expect(
      resolveTeammatePermissionMode({
        planModeRequired: false,
        leaderPermissionContext: {
          mode,
          isBypassPermissionsModeAvailable: false,
        },
      }),
    ).toBe(mode)
  }
})
