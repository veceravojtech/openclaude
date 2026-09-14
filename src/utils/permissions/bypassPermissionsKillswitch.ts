import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from 'src/state/AppState.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  createDisabledBypassPermissionsContext,
  shouldDisableBypassPermissions,
  verifyAutoModeGateAccess,
} from './permissionSetup.js'

let bypassPermissionsCheckRan = false
let bypassPermissionsCheckPromise: Promise<void> | null = null

/**
 * Strips a revoked dangerous mode from teammates that are ALREADY RUNNING.
 *
 * Revoking bypass on `toolPermissionContext` alone does not reach them. An
 * in-process teammate carries its own `permissionMode` on its task state, the
 * runner re-reads that field every iteration
 * (`inProcessRunner.ts` "Read current permission mode from task state"), and
 * `runAgent.ts` writes it back over the live context precisely when the live
 * mode is no longer dangerous — which is the state revocation produces. So the
 * stale field does not merely survive the killswitch, it takes over from it,
 * and the teammate keeps bypass for the rest of its life.
 *
 * Only `bypassPermissions` and `fullAccess` are downgraded. Anything else is
 * left exactly as it is: `plan` is `planModeRequired` intent, and the leader
 * can cycle a teammate's mode by hand, so this must not flatten per-teammate
 * modes that policy has no objection to.
 *
 * Returns the same reference when nothing changed, so the caller can skip the
 * state update entirely.
 */
export function downgradeLiveTeammateDangerousModes(
  tasks: AppState['tasks'],
): AppState['tasks'] {
  let changed = false
  const next: Record<string, AppState['tasks'][string]> = {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      (task.permissionMode === 'bypassPermissions' ||
        task.permissionMode === 'fullAccess')
    ) {
      next[taskId] = { ...task, permissionMode: 'default' }
      changed = true
    } else {
      next[taskId] = task
    }
  }
  return changed ? next : tasks
}

type BypassPermissionsCheckDeps = {
  createDisabledBypassPermissionsContext: typeof createDisabledBypassPermissionsContext
  shouldDisableBypassPermissions: typeof shouldDisableBypassPermissions
}

const DEFAULT_BYPASS_PERMISSIONS_CHECK_DEPS: BypassPermissionsCheckDeps = {
  createDisabledBypassPermissionsContext,
  shouldDisableBypassPermissions,
}

export async function checkAndDisableBypassPermissionsIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
  deps: BypassPermissionsCheckDeps = DEFAULT_BYPASS_PERMISSIONS_CHECK_DEPS,
): Promise<void> {
  // Check if bypassPermissions should be disabled based on Statsig gate.
  // Share the in-flight check so startup and the first query both wait on the
  // same authoritative verdict instead of racing each other.
  if (bypassPermissionsCheckRan) {
    return
  }

  if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
    return
  }

  if (bypassPermissionsCheckPromise) {
    return bypassPermissionsCheckPromise
  }

  bypassPermissionsCheckPromise = (async () => {
    const shouldDisable = await deps.shouldDisableBypassPermissions()
    if (!shouldDisable) {
      bypassPermissionsCheckRan = true
      return
    }

    setAppState(prev => {
      return {
        ...prev,
        toolPermissionContext: deps.createDisabledBypassPermissionsContext(
          prev.toolPermissionContext,
        ),
        // Revoking the leader's context is not enough on its own: teammates
        // already running carry their own copy of the mode. Sweep them in the
        // same update, so there is no window in which the leader is downgraded
        // and its teammates are not.
        tasks: downgradeLiveTeammateDangerousModes(prev.tasks),
      }
    })
    bypassPermissionsCheckRan = true
  })().finally(() => {
    bypassPermissionsCheckPromise = null
  })

  return bypassPermissionsCheckPromise
}

/**
 * Reset the run-once flag for checkAndDisableBypassPermissionsIfNeeded.
 * Call this after /login so the gate check re-runs with the new org.
 */
export function resetBypassPermissionsCheck(): void {
  bypassPermissionsCheckRan = false
  bypassPermissionsCheckPromise = null
}

export function useKickOffCheckAndDisableBypassPermissionsIfNeeded(): void {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const setAppState = useSetAppState()

  // Kick off the authoritative check on mount and whenever dangerous-mode
  // availability appears later in the session (for example after settings load
  // or org-aware login changes).
  useEffect(() => {
    if (getIsRemoteMode()) return
    void checkAndDisableBypassPermissionsIfNeeded(
      toolPermissionContext,
      setAppState,
    )
  }, [toolPermissionContext, setAppState])
}

let autoModeCheckRan = false

export async function checkAndDisableAutoModeIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
  fastMode?: boolean,
): Promise<void> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (autoModeCheckRan) {
      return
    }
    autoModeCheckRan = true

    const { updateContext, notification } = await verifyAutoModeGateAccess(
      toolPermissionContext,
      fastMode,
    )
    setAppState(prev => {
      // Apply the transform to CURRENT context, not the stale snapshot we
      // passed to verifyAutoModeGateAccess. The async GrowthBook await inside
      // can be outrun by a mid-turn shift-tab; spreading a stale context here
      // would revert the user's mode change.
      const nextCtx = updateContext(prev.toolPermissionContext)
      const newState =
        nextCtx === prev.toolPermissionContext
          ? prev
          : { ...prev, toolPermissionContext: nextCtx }
      if (!notification) return newState
      return {
        ...newState,
        notifications: {
          ...newState.notifications,
          queue: [
            ...newState.notifications.queue,
            {
              key: 'auto-mode-gate-notification',
              text: notification,
              color: 'warning' as const,
              priority: 'high' as const,
            },
          ],
        },
      }
    })
  }
}

/**
 * Reset the run-once flag for checkAndDisableAutoModeIfNeeded.
 * Call this after /login so the gate check re-runs with the new org.
 */
export function resetAutoModeGateCheck(): void {
  autoModeCheckRan = false
}

export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const fastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const isFirstRunRef = useRef(true)

  // Runs on mount (startup check) AND whenever the model or fast mode changes
  // (kick-out / carousel-restore). Watching both model fields covers /model,
  // Cmd+P picker, /config, and bridge onSetModel paths; fastMode covers
  // /fast on|off for the tengu_auto_mode_config.disableFastMode circuit
  // breaker. The print.ts headless paths are covered by the sync
  // isAutoModeGateEnabled() check.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false
    } else {
      resetAutoModeGateCheck()
    }
    void checkAndDisableAutoModeIfNeeded(
      store.getState().toolPermissionContext,
      setAppState,
      fastMode,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLoopModel, mainLoopModelForSession, fastMode])
}
