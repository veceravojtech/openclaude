/**
 * TeammateContext - Runtime context for in-process teammates
 *
 * This module provides AsyncLocalStorage-based context for in-process teammates,
 * enabling concurrent teammate execution without global state conflicts.
 *
 * Relationship with other teammate identity mechanisms:
 * - Env vars (CLAUDE_CODE_AGENT_ID): Process-based teammates spawned via tmux
 * - dynamicTeamContext (teammate.ts): Process-based teammates joining at runtime
 * - TeammateContext (this file): In-process teammates via AsyncLocalStorage
 *
 * The helper functions in teammate.ts check AsyncLocalStorage first, then
 * dynamicTeamContext, then env vars.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { AgentId } from '../types/ids.js'

/**
 * Runtime context for in-process teammates.
 * Stored in AsyncLocalStorage for concurrent access.
 */
export type TeammateContext = {
  /** Full agent ID, e.g., "researcher@my-team" */
  agentId: string
  /** Display name, e.g., "researcher" */
  agentName: string
  /** Team name this teammate belongs to */
  teamName: string
  /** UI color assigned to this teammate */
  color?: string
  /** Whether teammate must enter plan mode before implementing */
  planModeRequired: boolean
  /** Leader's session ID (for transcript correlation) */
  parentSessionId: string
  /** Discriminator - always true for in-process teammates */
  isInProcess: true
  /** Abort controller for lifecycle management (linked to parent) */
  abortController: AbortController
  /**
   * The tool-use-context agent id of the turn currently running, when one is.
   *
   * `agentId` above is `name@team`, which is NOT an AgentId and never appears
   * on a tool-use context. A teammate's turn goes through runAgent, which puts
   * its own freshly minted AgentId on every tool context it creates, so a tool
   * cannot tell "the teammate itself" from "a subagent spawned inside the
   * teammate" by comparing against `agentId`. The runner mints that id up front
   * per turn, passes it to runAgent as `override.agentId`, and republishes this
   * context with it here, so `context.agentId === turnAgentId` identifies the
   * teammate's own call (see resolveCallerIdentity in agentIdentity.ts).
   *
   * Absent outside a turn and for tmux teammates, whose identity comes from
   * dynamicTeamContext rather than from this context.
   */
  turnAgentId?: AgentId
}

const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()

/**
 * Get the current in-process teammate context, if running as one.
 * Returns undefined if not running within an in-process teammate context.
 */
export function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore()
}

/**
 * Run a function with teammate context set.
 * Used when spawning an in-process teammate to establish its execution context.
 *
 * @param context - The teammate context to set
 * @param fn - The function to run with the context
 * @returns The return value of fn
 */
export function runWithTeammateContext<T>(
  context: TeammateContext,
  fn: () => T,
): T {
  return teammateContextStorage.run(context, fn)
}

/**
 * Check if current execution is within an in-process teammate.
 * This is faster than getTeammateContext() !== undefined for simple checks.
 */
export function isInProcessTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined
}

/**
 * Create a TeammateContext from spawn configuration.
 * The abortController is passed in by the caller. For in-process teammates,
 * this is typically an independent controller (not linked to parent) so teammates
 * continue running when the leader's query is interrupted.
 *
 * @param config - Configuration for the teammate context
 * @returns A complete TeammateContext with isInProcess: true
 */
export function createTeammateContext(config: {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
  abortController: AbortController
}): TeammateContext {
  return {
    ...config,
    isInProcess: true,
  }
}
