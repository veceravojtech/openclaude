/**
 * In-process teammate spawning
 *
 * Creates and registers an in-process teammate task. Unlike process-based
 * teammates (tmux/iTerm2), in-process teammates run in the same Node.js
 * process using AsyncLocalStorage for context isolation.
 *
 * The actual agent execution loop is handled by InProcessTeammateTask
 * component (Task #14). This module handles:
 * 1. Creating TeammateContext
 * 2. Creating linked AbortController
 * 3. Registering InProcessTeammateTaskState in AppState
 * 4. Returning spawn result for backend
 */

import sample from 'lodash-es/sample.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getSpinnerVerbs } from '../../constants/spinnerVerbs.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
} from '../../Task.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { createAbortController } from '../abortController.js'
import { formatAgentId } from '../agentId.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import {
  registerInterruptionController,
  requestAbort,
} from '../interruptionTrace.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import { registerTask, TEAMMATE_GRACE_MS } from '../task/framework.js'
import { createTeammateContext } from '../teammateContext.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../telemetry/perfettoTracing.js'
import {
  cleanupTeamTree,
  collectDescendantTeamNames,
  readSubTeamLedBySync,
  readTeamFile,
  removeMemberByAgentId,
} from './teamHelpers.js'
import { isPaneBackend, type PaneBackendType } from './backends/types.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export type InProcessTeammateKillTrace = {
  source: string
  causalEventId?: string
}

/**
 * A live pane that a terminal (failed) pane teammate still owns, which the
 * kill cascade must close on its recorded socket before removing the roster
 * member. `socket` is undefined for legacy members written before the backing
 * socket was recorded; in that case the kill must fail closed rather than
 * guess.
 */
type TerminalPaneKill = {
  backendType: PaneBackendType
  paneId: string
  socket?: string
}

/**
 * Minimal context required for spawning an in-process teammate.
 * This is a subset of ToolUseContext - only what spawnInProcessTeammate actually uses.
 */
export type SpawnContext = {
  setAppState: SetAppStateFn
  /**
   * Reads the leader's live AppState, for the permission mode the teammate
   * inherits — see resolveTeammatePermissionMode.
   *
   * Required, deliberately. Every caller in the tree already holds a
   * `ToolUseContext`, which supplies this structurally; making it optional
   * meant the inheritance could be switched off at a call site silently, and
   * meant a later narrowing of a parameter type could disable it with no test
   * failing. A required field forces that decision to be explicit and
   * reviewable.
   */
  getAppState: () => AppState
  toolUseId?: string
}

/**
 * The permission mode a newly spawned in-process teammate starts in.
 *
 * Teammates inherit the leader's mode rather than starting in `default`:
 * they run in the leader's process, against the leader's cwd, so a leader
 * that is not being prompted should not have its teammates prompting.
 *
 * Two things still override the inheritance:
 * - `planModeRequired` is explicit caller intent and always wins.
 * - A dangerous mode is only inherited while the leader's context still says
 *   `isBypassPermissionsModeAvailable`. The org-policy killswitch
 *   (checkAndDisableBypassPermissionsIfNeeded) clears that flag and resets the
 *   mode on the LIVE context, so a teammate spawned after policy revoked
 *   bypass cannot resurrect it. This is read at spawn time, never captured at
 *   startup, so the revocation applies to every later spawn.
 */
export function resolveTeammatePermissionMode({
  planModeRequired,
  leaderPermissionContext,
}: {
  planModeRequired: boolean
  leaderPermissionContext: Pick<
    ToolPermissionContext,
    'mode' | 'isBypassPermissionsModeAvailable'
  >
}): PermissionMode {
  if (planModeRequired) {
    return 'plan'
  }
  const { mode, isBypassPermissionsModeAvailable } = leaderPermissionContext
  if (
    (mode === 'bypassPermissions' || mode === 'fullAccess') &&
    !isBypassPermissionsModeAvailable
  ) {
    return 'default'
  }
  return mode
}

/**
 * Configuration for spawning an in-process teammate.
 */
export type InProcessSpawnConfig = {
  /** Display name for the teammate, e.g., "researcher" */
  name: string
  /** Team this teammate belongs to */
  teamName: string
  /** Initial prompt/task for the teammate. Omit to start idle (waiting for work). */
  prompt?: string
  /** Optional UI color for the teammate */
  color?: string
  /** Whether teammate must enter plan mode before implementing */
  planModeRequired: boolean
  /** Optional model override for this teammate */
  model?: string
}

/**
 * Result from spawning an in-process teammate.
 */
export type InProcessSpawnOutput = {
  /** Whether spawn was successful */
  success: boolean
  /** Full agent ID (format: "name@team") */
  agentId: string
  /** Task ID for tracking in AppState */
  taskId?: string
  /** AbortController for this teammate (linked to parent) */
  abortController?: AbortController
  /** Teammate context for AsyncLocalStorage */
  teammateContext?: ReturnType<typeof createTeammateContext>
  /** Error message if spawn failed */
  error?: string
}

/**
 * Spawns an in-process teammate.
 *
 * Creates the teammate's context, registers the task in AppState, and returns
 * the spawn result. The actual agent execution is driven by the
 * InProcessTeammateTask component which uses runWithTeammateContext() to
 * execute the agent loop with proper identity isolation.
 *
 * @param config - Spawn configuration
 * @param context - Context with setAppState for registering task
 * @returns Spawn result with teammate info
 */
export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const { name, teamName, prompt, color, planModeRequired, model } = config
  const { setAppState, getAppState } = context

  // Generate deterministic agent ID
  const agentId = formatAgentId(name, teamName)
  const taskId = generateTaskId('in_process_teammate')

  logForDebugging(
    `[spawnInProcessTeammate] Spawning ${agentId} (taskId: ${taskId})`,
  )
  try {
    // Create independent AbortController for this teammate
    // Teammates should not be aborted when the leader's query is interrupted
    const abortController = createAbortController()
    registerInterruptionController(abortController, {
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-lifecycle',
      subagentId: agentId,
    })

    // Get parent session ID for transcript correlation
    const parentSessionId = getSessionId()

    // Create teammate identity (stored as plain data in AppState)
    const identity: TeammateIdentity = {
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
    }

    // Create teammate context for AsyncLocalStorage
    // This will be used by runWithTeammateContext() during agent execution
    const teammateContext = createTeammateContext({
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
      abortController,
    })

    // Register agent in Perfetto trace for hierarchy visualization
    if (isPerfettoTracingEnabled()) {
      registerPerfettoAgent(agentId, name, parentSessionId)
    }

    // Create task state. An idle spawn (no prompt) is registered already idle
    // so the panel shows it waiting for work from the very first render.
    const isIdleSpawn = prompt === undefined
    const description = isIdleSpawn
      ? `${name}: idle (waiting for work)`
      : `${name}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

    const taskState: InProcessTeammateTaskState = {
      ...createTaskStateBase(
        taskId,
        'in_process_teammate',
        description,
        context.toolUseId,
      ),
      type: 'in_process_teammate',
      status: 'running',
      identity,
      // Kept as a string (empty for idle spawns) rather than widening the
      // task type to `prompt?: string`: the UI consumers (TeammateViewHeader,
      // InProcessTeammateDetailDialog's truncateToWidth, the SDK task_started
      // event) all assume a string, and the idle marker lives in description.
      prompt: prompt ?? '',
      model,
      abortController,
      awaitingPlanApproval: false,
      spinnerVerb: sample(getSpinnerVerbs()),
      pastTenseVerb: sample(TURN_COMPLETION_VERBS),
      permissionMode: resolveTeammatePermissionMode({
        planModeRequired,
        leaderPermissionContext: getAppState().toolPermissionContext,
      }),
      isIdle: isIdleSpawn,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [], // Initialize to empty array so getDisplayedMessages works immediately
    }

    // Register cleanup handler for graceful shutdown
    const unregisterCleanup = registerCleanup(async () => {
      logForDebugging(`[spawnInProcessTeammate] Cleanup called for ${agentId}`)
      requestAbort(abortController, undefined, {
        source: 'graceful_shutdown',
        subsystem: 'in_process_teammate',
        controllerRole: 'subagent-lifecycle',
        subagentId: agentId,
      })
      // Task state will be updated by the execution loop when it detects abort
    })
    taskState.unregisterCleanup = unregisterCleanup

    // Register task in AppState
    registerTask(taskState, setAppState)

    logForDebugging(
      `[spawnInProcessTeammate] Registered ${agentId} in AppState`,
    )

    return {
      success: true,
      agentId,
      taskId,
      abortController,
      teammateContext,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error during spawn'
    logForDebugging(
      `[spawnInProcessTeammate] Failed to spawn ${agentId}: ${errorMessage}`,
    )
    return {
      success: false,
      agentId,
      error: errorMessage,
    }
  }
}

/** Trace source for a teammate stopped because the team above it went away. */
const SUB_TEAM_CASCADE_SOURCE = 'sub_team_cascade'

/**
 * Kills an in-process teammate by aborting its controller, and with it the
 * sub-team that teammate leads.
 *
 * Note: This is the implementation called by InProcessBackend.kill().
 *
 * The sub-team cascade has two halves. Stopping the processes is synchronous
 * and finishes before this returns, so the three callers that only take the
 * boolean — InProcessBackend.kill, the teammate-view kill key, and the task
 * impl below — never leave a sub-team's members running past the tick that
 * killed their lead. Removing the directories is inherently asynchronous
 * (worktrees, `rm -rf`) and is left running; use
 * {@link killInProcessTeammateAndCascade} when the caller must observe the
 * directories gone, as TaskStop does.
 *
 * @param taskId - Task ID of the teammate to kill
 * @param setAppState - AppState setter
 * @returns true if killed successfully
 */
export function killInProcessTeammate(
  taskId: string,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace = { source: 'task_stop' },
): boolean {
  const { killed, teardown } = killTeammateAndSubTeam(
    taskId,
    setAppState,
    trace,
  )
  // Never rejects: cascadeSubTeamTeardown logs its own failures.
  void teardown
  return killed
}

/**
 * {@link killInProcessTeammate}, awaiting the sub-team teardown.
 *
 * TaskStop resolves through here, so "the sub-lead is stopped" and "its
 * sub-team is gone" become one observable event instead of a race a caller
 * would have to sleep on.
 */
export async function killInProcessTeammateAndCascade(
  taskId: string,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace = { source: 'task_stop' },
): Promise<boolean> {
  const { killed, identity, paneKill, teardown } = killTeammateAndSubTeam(
    taskId,
    setAppState,
    trace,
  )
  // A terminal pane teammate still owns a live pane: close it on its recorded
  // socket BEFORE the roster member goes, and never report a kill that left
  // the pane running.
  let paneKilled = true
  if (killed && paneKill && identity) {
    paneKilled = await killTerminalPaneAndRemoveMember(paneKill, identity)
  }
  await teardown
  return killed && paneKilled
}

/**
 * Kills one teammate and, when it leads a sub-team, hands back the promise
 * that tears that sub-team down. The kill itself is complete on return.
 */
function killTeammateAndSubTeam(
  taskId: string,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace,
): {
  killed: boolean
  teardown: Promise<void>
  paneKill?: TerminalPaneKill
  identity?: TeammateIdentity
} {
  const { killed, identity, appStateBefore, paneKill } =
    killOneInProcessTeammate(taskId, setAppState, trace)
  if (!killed || !identity || !appStateBefore) {
    return { killed, teardown: Promise.resolve(), paneKill, identity }
  }
  // The derived name alone is not enough: `email/supervisor` and a root team
  // literally named `email-supervisor` share a directory, so the team file's
  // own name and recorded parent are what say this teammate really leads it.
  const subTeam = readSubTeamLedBySync({
    agentId: identity.agentId,
    name: identity.agentName,
    isTeammate: true,
  })
  if (!subTeam) {
    return { killed, teardown: Promise.resolve(), paneKill, identity }
  }
  return {
    killed,
    teardown: cascadeSubTeamTeardown(
      subTeam.name,
      appStateBefore,
      setAppState,
      trace,
    ),
    paneKill,
    identity,
  }
}

/**
 * Stops every in-process teammate of `teamName` and of every sub-team led by
 * one of them, then removes the whole sub-tree's directories.
 *
 * `teamName` must already be confirmed as a real sub-team of the caller (the
 * `readSubTeamLedBy` contract) — this function trusts the name it is given.
 *
 * Everything up to the first `await` runs in the caller's tick, so a
 * synchronous caller still stops the live sub-tree before it returns.
 */
export async function cascadeSubTeamTeardown(
  teamName: string,
  appState: AppState,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace = { source: SUB_TEAM_CASCADE_SOURCE },
): Promise<void> {
  try {
    stopTeamTreeMembers(teamName, appState, setAppState, trace)
    // Disk is the authority for which teams exist: a sub-sub-team whose own
    // lead is already dead has no live task to recurse through, but its
    // members are still running and its directory is still there.
    for (const descendant of await collectDescendantTeamNames(teamName)) {
      stopTeamTreeMembers(descendant, appState, setAppState, trace)
    }
    await cleanupTeamTree(teamName)
  } catch (err) {
    logForDebugging(
      `[killInProcessTeammate] Failed to tear down sub-team ${teamName}: ${errorMessage(err)}`,
    )
  }
}

/**
 * Stops the in-process members of `teamName` and, recursively, of any
 * sub-team one of those members leads. Returns the agent ids stopped.
 *
 * Members are found in `appState.tasks` by `identity.teamName` rather than in
 * the roster, because that is what a running teammate actually carries; a
 * roster-only member has no process to stop, and its worktree goes with the
 * team directory. Each member is aborted BEFORE its own sub-team is walked,
 * so nothing below it can be spawned while the cascade descends. `visited`
 * guards against a parent link that points back up the tree.
 */
export function stopTeamTreeMembers(
  teamName: string,
  appState: AppState,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace = { source: SUB_TEAM_CASCADE_SOURCE },
  visited: Set<string> = new Set([teamName]),
): string[] {
  const stopped: string[] = []
  const cascadeTrace: InProcessTeammateKillTrace = {
    source: SUB_TEAM_CASCADE_SOURCE,
    causalEventId: trace.causalEventId,
  }
  for (const task of Object.values(appState.tasks)) {
    if (task.type !== 'in_process_teammate') continue
    if (task.identity.teamName !== teamName) continue
    if (isTerminalTaskStatus(task.status)) continue

    const { killed } = killOneInProcessTeammate(
      task.id,
      setAppState,
      cascadeTrace,
    )
    if (killed) stopped.push(task.identity.agentId)

    const subTeam = readSubTeamLedBySync({
      agentId: task.identity.agentId,
      name: task.identity.agentName,
      isTeammate: true,
    })
    if (!subTeam || visited.has(subTeam.name)) continue
    visited.add(subTeam.name)
    stopped.push(
      ...stopTeamTreeMembers(
        subTeam.name,
        appState,
        setAppState,
        trace,
        visited,
      ),
    )
  }
  return stopped
}

/**
 * Kills one in-process teammate, with no sub-team cascade. Also hands back
 * the identity it killed and the AppState as it was before the kill, which is
 * how the cascade enumerates the sub-tree without a second read.
 */
function killOneInProcessTeammate(
  taskId: string,
  setAppState: SetAppStateFn,
  trace: InProcessTeammateKillTrace,
): {
  killed: boolean
  identity: TeammateIdentity | undefined
  appStateBefore: AppState | undefined
  paneKill: TerminalPaneKill | undefined
} {
  let killed = false
  let identity: TeammateIdentity | undefined
  let appStateBefore: AppState | undefined
  let toolUseId: string | undefined
  let description: string | undefined
  let wasRunning = false

  setAppState((prev: AppState) => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }

    const teammateTask = task as InProcessTeammateTaskState

    // A running teammate is the normal kill; a FAILED pane teammate is the
    // one terminal shape still worth killing — its pane stays alive for
    // resume, so TaskStop drives this same cascade to close the pane and
    // remove the roster member. Completed/killed rows have nothing alive
    // left, so they stay untouched.
    if (
      teammateTask.status !== 'running' &&
      teammateTask.status !== 'failed'
    ) {
      return prev
    }

    wasRunning = teammateTask.status === 'running'

    // Capture identity for cleanup after state update
    identity = teammateTask.identity
    appStateBefore = prev
    toolUseId = teammateTask.toolUseId
    description = teammateTask.description

    // Abort the controller to stop execution. Only a RUNNING row aborts: a
    // running pane teammate kills its pane through the spawn-time abort
    // listener, while a FAILED pane teammate must NOT abort — its abort
    // listener still kills the pane, but on the guessed socket, and the
    // terminal-pane kill below closes the pane on its recorded socket instead.
    if (wasRunning && teammateTask.abortController) {
      requestAbort(teammateTask.abortController, undefined, {
        source: trace.source,
        subsystem: 'in_process_teammate',
        controllerRole: 'subagent-lifecycle',
        subagentId: teammateTask.identity.agentId,
        causalEventId: trace.causalEventId,
      })
    }

    // Call cleanup handler
    teammateTask.unregisterCleanup?.()

    // Update task state and remove from teamContext.teammates
    killed = true

    // Call pending idle callbacks to unblock any waiters (e.g., engine.waitForIdle)
    teammateTask.onIdleCallbacks?.forEach(cb => cb())

    // Remove from teamContext.teammates using the agentId
    const killedAgentId = teammateTask.identity.agentId
    let updatedTeamContext = prev.teamContext
    if (prev.teamContext?.teammates) {
      const { [killedAgentId]: _, ...remainingTeammates } =
        prev.teamContext.teammates
      updatedTeamContext = {
        ...prev.teamContext,
        teammates: remainingTeammates,
      }
    }

    return {
      ...prev,
      teamContext: updatedTeamContext,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...teammateTask,
          status: 'killed' as const,
          notified: true,
          endTime: Date.now(),
          // The killed row stays in the tree for TEAMMATE_GRACE_MS, drawn dimmed
          // and reading `killed`, instead of lingering 3s undrawn and then being
          // evicted by a timer of its own. The shared retain/grace rule holds
          // both evictors off until the deadline passes.
          retain: false,
          evictAfter: Date.now() + TEAMMATE_GRACE_MS,
          onIdleCallbacks: [], // Clear callbacks to prevent stale references
          // task.messages is left alone — the grace row above is opened onto it.
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        },
      },
    }
  })

  // A FAILED pane teammate has a live pane that still needs closing, and the
  // roster member is the only record of which pane and socket to close — so
  // read it BEFORE any removal. This runs after the state updater (file I/O
  // stays out of the React callback).
  let paneKill: TerminalPaneKill | undefined
  if (identity && !wasRunning) {
    const { teamName, agentId } = identity
    const teamFile = readTeamFile(teamName)
    const member = teamFile?.members?.find(m => m.agentId === agentId)
    if (
      member?.backendType &&
      isPaneBackend(member.backendType) &&
      member.tmuxPaneId &&
      member.tmuxPaneId !== 'in-process'
    ) {
      paneKill = {
        backendType: member.backendType,
        paneId: member.tmuxPaneId,
        socket: member.tmuxSocket,
      }
    }
  }

  // Remove the member synchronously only when there is no pane to close first.
  // For a terminal PANE teammate the pane must be confirmed dead before the
  // member goes — the async caller does that, so a failed kill leaves the
  // member (and its pane id) in place for the ghost sweep instead of orphaning
  // a pane nobody can name.
  if (identity && !paneKill) {
    removeMemberByAgentId(identity.teamName, identity.agentId)
  }

  if (killed) {
    void evictTaskOutput(taskId)
    // A terminal event was already emitted when the task failed, so only a
    // RUNNING row being stopped here is a NEW terminal transition and closes
    // the SDK task_started bookend. notified:true was pre-set so no XML
    // notification fires; the in-process runner's own completion/failure emit
    // guards on status==='running' and won't double-emit after status:killed.
    if (wasRunning) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId,
        summary: description,
      })
    }
  }

  // Release perfetto agent registry entry
  if (identity) {
    unregisterPerfettoAgent(identity.agentId)
  }

  return { killed, identity, appStateBefore, paneKill }
}

/**
 * Closes a failed pane teammate's still-live pane on its recorded socket, then
 * removes the roster member only once the pane is confirmed dead. Returns
 * whether the pane was actually killed; a `false` result leaves the member in
 * place so the ghost sweep can still see and reconcile it.
 */
async function killTerminalPaneAndRemoveMember(
  paneKill: TerminalPaneKill,
  identity: TeammateIdentity,
): Promise<boolean> {
  const { getBackendByType } = await import('./backends/registry.js')
  const backend = getBackendByType(paneKill.backendType)
  const killed = backend.killPaneOnSocket
    ? await backend.killPaneOnSocket(paneKill.paneId, paneKill.socket)
    : await backend.killPane(paneKill.paneId, false)
  if (killed) {
    removeMemberByAgentId(identity.teamName, identity.agentId)
  } else {
    logForDebugging(
      `[killInProcessTeammate] Could not kill pane ${paneKill.paneId} of ${identity.agentId} (${paneKill.backendType}); leaving the roster member in place for the ghost sweep`,
    )
  }
  return killed
}
