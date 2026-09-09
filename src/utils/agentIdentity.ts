/**
 * Caller identity for tools that speak or list on behalf of whoever invoked
 * them (SendMessage, ListAgents).
 *
 * A background subagent spawned inside a teammate's turn keeps running inside
 * that teammate's AsyncLocalStorage context — permission routing and abort
 * linkage depend on the inheritance, so it must not be restructured. The
 * consequence is that `getAgentId()` / `getAgentName()` / `isTeammate()`
 * report the SPAWNING TEAMMATE even when the caller is the subagent. The
 * subagent's own id is the one on its tool-use context, so preferring
 * `context.agentId` whenever it differs from the ambient teammate id gives
 * every caller its own identity without touching the context plumbing.
 */

import { getAgentId, getAgentName, isTeammate } from './teammate.js'

export type CallerIdentity = {
  /** The caller's own agent id, undefined for a lead outside any team. */
  agentId: string | undefined
  /**
   * Display name: the teammate name, the lead's team name, or a subagent's
   * registered name. Undefined for a subagent that was never named — such an
   * agent is addressed by its raw id.
   */
  name: string | undefined
  /** True only for a real teammate turn, never for a subagent inside one. */
  isTeammate: boolean
  /** The teammate a subagent was spawned inside, when there is one. */
  spawnerAgentId?: string
}

/**
 * The slice of `ToolUseContext` identity resolution reads. Narrow on purpose:
 * tests pass a plain object, and any `ToolUseContext` satisfies it.
 */
export type CallerIdentityContext = {
  agentId?: string
  getAppState: () => {
    agentNameRegistry: ReadonlyMap<string, string>
    teamContext?: {
      selfAgentId?: string
      selfAgentName?: string
    }
  }
}

/**
 * Reverse-lookup a name in the `name -> agentId` registry the Agent tool
 * populates. Latest-wins on collision is the registry's contract, so the
 * first match wins here too.
 */
function findRegisteredName(
  registry: ReadonlyMap<string, string>,
  agentId: string,
): string | undefined {
  for (const [name, id] of registry) {
    if (id === agentId) return name
  }
  return undefined
}

/**
 * Resolve who is actually calling a tool.
 *
 * - lead / main session: no ambient teammate and no context agent id.
 * - teammate: the ambient AsyncLocalStorage (or tmux CLI-args) identity.
 * - subagent: a context agent id that differs from the ambient one; the
 *   ambient id, when there is one, is its spawning teammate.
 */
export function resolveCallerIdentity(
  context: CallerIdentityContext,
): CallerIdentity {
  const ambientAgentId = getAgentId()
  const contextAgentId = context.agentId

  if (contextAgentId !== undefined && contextAgentId !== ambientAgentId) {
    return {
      agentId: contextAgentId,
      name: findRegisteredName(
        context.getAppState().agentNameRegistry,
        contextAgentId,
      ),
      isTeammate: false,
      spawnerAgentId: ambientAgentId,
    }
  }

  if (ambientAgentId !== undefined) {
    return {
      agentId: ambientAgentId,
      name: getAgentName(),
      isTeammate: isTeammate(),
    }
  }

  const teamContext = context.getAppState().teamContext
  return {
    agentId: teamContext?.selfAgentId,
    name: teamContext?.selfAgentName,
    isTeammate: false,
  }
}
