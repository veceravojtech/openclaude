import type { AppState } from '../../../state/AppState.js'
import type { ToolUseContext } from '../../../Tool.js'
import {
  findTeammateTaskByAgentId,
  requestTeammateShutdown,
} from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { parseAgentId } from '../../../utils/agentId.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import {
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../../utils/teammateMailbox.js'
import {
  TEAM_LEAD_NAME,
  TEAMMATE_SHUTDOWN_DEADLINE_MS,
  TEAMMATE_SHUTDOWN_POLL_INTERVAL_MS,
} from '../constants.js'
import { startInProcessTeammate } from '../inProcessRunner.js'
import {
  killInProcessTeammate,
  killInProcessTeammateAndCascade,
  spawnInProcessTeammate,
} from '../spawnInProcess.js'
import type {
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
  TerminateOutcome,
} from './types.js'

/**
 * Overrides for {@link InProcessBackend.terminate}, so its deadline and its
 * escalation can be exercised without waiting real seconds or really killing
 * anything. Extra OPTIONAL parameters, which is why the method still satisfies
 * the two-argument `TeammateExecutor.terminate` contract.
 */
export type InProcessTerminateOptions = {
  /** Defaults to {@link TEAMMATE_SHUTDOWN_DEADLINE_MS}. */
  deadlineMs?: number
  /** Defaults to {@link TEAMMATE_SHUTDOWN_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** Defaults to `killInProcessTeammateAndCascade`. */
  forceKill?: (
    taskId: string,
    setAppState: (updater: (prev: AppState) => AppState) => void,
  ) => Promise<boolean>
}

/**
 * InProcessBackend implements TeammateExecutor for in-process teammates.
 *
 * Unlike pane-based backends (tmux/iTerm2), in-process teammates run in the
 * same Node.js process with isolated context via AsyncLocalStorage. They:
 * - Share resources (API client, MCP connections) with the leader
 * - Communicate via file-based mailbox (same as pane-based teammates)
 * - Are terminated via AbortController (not kill-pane)
 *
 * IMPORTANT: Before spawning, call setContext() to provide the ToolUseContext
 * needed for AppState access. This is intended for use via the TeammateExecutor
 * abstraction (getTeammateExecutor() in registry.ts).
 */
export class InProcessBackend implements TeammateExecutor {
  readonly type = 'in-process' as const

  /**
   * Tool use context for AppState access.
   * Must be set via setContext() before spawn() is called.
   */
  private context: ToolUseContext | null = null

  /**
   * Sets the ToolUseContext for this backend.
   * Called by TeammateTool before spawning to provide AppState access.
   */
  setContext(context: ToolUseContext): void {
    this.context = context
  }

  /**
   * In-process backend is always available (no external dependencies).
   */
  async isAvailable(): Promise<boolean> {
    return true
  }

  /**
   * Spawns an in-process teammate.
   *
   * Uses spawnInProcessTeammate() to:
   * 1. Create TeammateContext via createTeammateContext()
   * 2. Create independent AbortController (not linked to parent)
   * 3. Register teammate in AppState.tasks
   * 4. Start agent execution via startInProcessTeammate()
   * 5. Return spawn result with agentId, taskId, abortController
   */
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] spawn() called without context for ${config.name}`,
      )
      return {
        success: false,
        agentId: `${config.name}@${config.teamName}`,
        error:
          'InProcessBackend not initialized. Call setContext() before spawn().',
      }
    }

    logForDebugging(`[InProcessBackend] spawn() called for ${config.name}`)

    const result = await spawnInProcessTeammate(
      {
        name: config.name,
        teamName: config.teamName,
        prompt: config.prompt,
        color: config.color,
        planModeRequired: config.planModeRequired ?? false,
      },
      this.context,
    )

    // If spawn succeeded, start the agent execution loop
    if (
      result.success &&
      result.taskId &&
      result.teammateContext &&
      result.abortController
    ) {
      // Start the agent loop in the background (fire-and-forget)
      // The prompt is passed through the task state and config
      startInProcessTeammate({
        identity: {
          agentId: result.agentId,
          agentName: config.name,
          teamName: config.teamName,
          color: config.color,
          planModeRequired: config.planModeRequired ?? false,
          parentSessionId: result.teammateContext.parentSessionId,
        },
        taskId: result.taskId,
        prompt: config.prompt,
        teammateContext: result.teammateContext,
        // Strip messages: the teammate never reads toolUseContext.messages
        // (runAgent overrides it via createSubagentContext). Passing the
        // parent's conversation would pin it for the teammate's lifetime.
        toolUseContext: { ...this.context, messages: [] },
        abortController: result.abortController,
        model: config.model,
        modelWasToolSpecified:
          config.modelWasToolSpecified ?? config.model !== undefined,
        systemPrompt: config.systemPrompt,
        systemPromptMode: config.systemPromptMode,
        allowedTools: config.permissions,
        allowPermissionPrompts: config.allowPermissionPrompts,
      })

      logForDebugging(
        `[InProcessBackend] Started agent execution for ${result.agentId}`,
      )
    }

    return {
      success: result.success,
      agentId: result.agentId,
      taskId: result.taskId,
      abortController: result.abortController,
      error: result.error,
    }
  }

  /**
   * Sends a message to an in-process teammate.
   *
   * All teammates use file-based mailboxes for simplicity.
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    logForDebugging(
      `[InProcessBackend] sendMessage() to ${agentId}: ${message.text.substring(0, 50)}...`,
    )

    // Parse agentId to get agentName and teamName
    // agentId format: "agentName@teamName" (e.g., "researcher@my-team")
    const parsed = parseAgentId(agentId)
    if (!parsed) {
      logForDebugging(`[InProcessBackend] Invalid agentId format: ${agentId}`)
      throw new Error(
        `Invalid agentId format: ${agentId}. Expected format: agentName@teamName`,
      )
    }

    const { agentName, teamName } = parsed

    // Write to file-based mailbox
    await writeToMailbox(
      agentName,
      {
        text: message.text,
        from: message.from,
        color: message.color,
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(`[InProcessBackend] sendMessage() completed for ${agentId}`)
  }

  /**
   * Asks an in-process teammate to shut down, and makes sure it does.
   *
   * Three steps, in order:
   *
   * 1. Deliver a `shutdown_request` to the teammate's mailbox and mark the row
   *    `shutdownRequested` (which is what draws it as `stopping`). The request
   *    reaches the teammate as a PROMPT — it only stops if its model answers
   *    with `shutdown_response{approve:true}`.
   * 2. Wait up to `deadlineMs` for the teammate to actually stop, polling the
   *    same liveness predicate {@link isActive} exposes.
   * 3. On expiry, stop asking: force-kill it (and the sub-team it leads) via
   *    `killInProcessTeammateAndCascade`. Cooperation had its chance.
   *
   * The returned {@link TerminateOutcome} reports what happened, and
   * `'terminated'` is only ever returned for an observed stop. This used to
   * return `true` for "a note was left in a file", which meant a caller could
   * not distinguish a dead teammate from one that had ignored the request.
   *
   * A shutdown request is re-delivered on every call. `shutdownRequested` is an
   * in-flight/UI marker, NOT a "do not ask again" latch: it used to
   * short-circuit this method with a fabricated `true`, so a teammate that
   * declined once could never be asked again and every later caller was lied
   * to.
   *
   * @param options - Test seam only; production callers pass nothing and get
   * {@link TEAMMATE_SHUTDOWN_DEADLINE_MS} and the real force kill. Kept off
   * the `TeammateExecutor` interface, which stays a two-argument contract.
   */
  async terminate(
    agentId: string,
    reason?: string,
    options?: InProcessTerminateOptions,
  ): Promise<TerminateOutcome> {
    logForDebugging(
      `[InProcessBackend] terminate() called for ${agentId}: ${reason}`,
    )

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: no context set for ${agentId}`,
      )
      return 'not_found'
    }
    const context = this.context

    const task = findTeammateTaskByAgentId(agentId, context.getAppState().tasks)
    if (!task) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: task not found for ${agentId}`,
      )
      return 'not_found'
    }

    // Already stopped: there is nothing to ask and nothing to escalate, and
    // `terminated` is the honest answer rather than a fresh request nobody
    // will ever read.
    if (!(await this.isActive(agentId))) {
      logForDebugging(
        `[InProcessBackend] terminate(): ${agentId} is already stopped`,
      )
      return 'terminated'
    }

    const requestId = `shutdown-${agentId}-${Date.now()}`
    const shutdownRequest = createShutdownRequestMessage({
      requestId,
      from: TEAM_LEAD_NAME, // Terminate is always called by the leader
      reason,
    })
    await writeToMailbox(
      task.identity.agentName,
      {
        from: TEAM_LEAD_NAME,
        text: jsonStringify(shutdownRequest),
        timestamp: new Date().toISOString(),
      },
      task.identity.teamName,
    )
    requestTeammateShutdown(task.id, context.setAppState)
    logForDebugging(
      `[InProcessBackend] terminate() sent shutdown request ${requestId} to ${agentId}`,
    )

    const deadlineMs = options?.deadlineMs ?? TEAMMATE_SHUTDOWN_DEADLINE_MS
    const pollIntervalMs =
      options?.pollIntervalMs ?? TEAMMATE_SHUTDOWN_POLL_INTERVAL_MS
    if (await this.waitForStop(agentId, deadlineMs, pollIntervalMs)) {
      logForDebugging(
        `[InProcessBackend] terminate(): ${agentId} stopped cooperatively`,
      )
      return 'terminated'
    }

    logForDebugging(
      `[InProcessBackend] terminate(): ${agentId} did not stop within ${deadlineMs}ms - force killing`,
    )
    const forceKill = options?.forceKill ?? killInProcessTeammateAndCascade
    await forceKill(task.id, context.setAppState)

    // Re-checked rather than assumed: a force kill that did not take is still
    // "requested", however loudly it was attempted.
    const stopped = !(await this.isActive(agentId))
    logForDebugging(
      `[InProcessBackend] terminate(): force kill of ${agentId} ${stopped ? 'succeeded' : 'did not stop it'}`,
    )
    return stopped ? 'terminated' : 'requested'
  }

  /**
   * Resolves true as soon as the teammate has stopped, or false once
   * `deadlineMs` has passed with it still active. Polls rather than listening
   * on the abort signal: a teammate can also stop by reaching a terminal status
   * or by leaving AppState entirely, and {@link isActive} already knows all
   * three shapes.
   */
  private async waitForStop(
    agentId: string,
    deadlineMs: number,
    pollIntervalMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (!(await this.isActive(agentId))) {
        return true
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return false
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
      )
    }
  }

  /**
   * Force kills an in-process teammate immediately.
   *
   * Uses the teammate's AbortController to cancel all async operations
   * and updates the task state to 'killed'.
   */
  async kill(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] kill() called for ${agentId}`)

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] kill() failed: no context set for ${agentId}`,
      )
      return false
    }

    // Get current AppState to find the task
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] kill() failed: task not found for ${agentId}`,
      )
      return false
    }

    // Kill the teammate via the existing helper function
    const killed = killInProcessTeammate(task.id, this.context.setAppState)

    logForDebugging(
      `[InProcessBackend] kill() ${killed ? 'succeeded' : 'failed'} for ${agentId}`,
    )

    return killed
  }

  /**
   * Checks if an in-process teammate is still active.
   *
   * Returns true if the teammate exists, has status 'running',
   * and its AbortController has not been aborted.
   */
  async isActive(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] isActive() called for ${agentId}`)

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] isActive() failed: no context set for ${agentId}`,
      )
      return false
    }

    // Get current AppState to find the task
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] isActive(): task not found for ${agentId}`,
      )
      return false
    }

    // Check if task is running and not aborted
    const isRunning = task.status === 'running'
    const isAborted = task.abortController?.signal.aborted ?? true

    const active = isRunning && !isAborted

    logForDebugging(
      `[InProcessBackend] isActive() for ${agentId}: ${active} (running=${isRunning}, aborted=${isAborted})`,
    )

    return active
  }
}

/**
 * Factory function to create an InProcessBackend instance.
 * Used by the registry (Task #8) to get backend instances.
 */
export function createInProcessBackend(): InProcessBackend {
  return new InProcessBackend()
}
