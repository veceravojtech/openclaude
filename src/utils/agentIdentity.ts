/**
 * Caller identity for tools that speak or list on behalf of whoever invoked
 * them (SendMessage, ListAgents).
 *
 * A background subagent spawned inside a teammate's turn keeps running inside
 * that teammate's AsyncLocalStorage context — permission routing and abort
 * linkage depend on the inheritance, so it must not be restructured. The
 * consequence is that `getAgentId()` / `getAgentName()` / `isTeammate()`
 * report the SPAWNING TEAMMATE even when the caller is the subagent.
 *
 * Telling the two apart takes the tool-use context's `agentId`, but NOT by
 * comparing it with the ambient teammate id: those two ids are different kinds
 * of thing. The ambient id is `formatAgentId(name, team)` = `name@team`, while
 * a tool-use context only ever carries a branded `AgentId` (`a` + 16 hex,
 * `src/types/ids.ts`) minted by runAgent — so an in-process teammate's OWN turn
 * also carries an id that differs from the ambient one, and "differs" alone
 * would classify a teammate as a subagent of itself.
 *
 * What the comparison needs is the id of the turn currently running, which the
 * teammate runner mints up front, hands to runAgent as `override.agentId`, and
 * publishes on its ambient context as `turnAgentId`
 * (`src/utils/swarm/inProcessRunner.ts`). `context.agentId === turnAgentId` is
 * therefore the teammate's own call; any other context id inside that turn is a
 * subagent whose spawner is the teammate. With no ambient `turnAgentId` — a
 * tmux teammate, whose identity comes from `dynamicTeamContext` and whose turns
 * run on its own process's main thread — a differing context id is a subagent as
 * before.
 */

import { getAgentId, getAgentName, isTeammate } from './teammate.js'
import { getTeammateContext } from './teammateContext.js'

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
 * - teammate: the ambient AsyncLocalStorage (or tmux CLI-args) identity,
 *   including when its own turn's `turnAgentId` is on the context.
 * - subagent: any other context agent id that differs from the ambient one;
 *   the ambient id, when there is one, is its spawning teammate.
 */
export function resolveCallerIdentity(
  context: CallerIdentityContext,
): CallerIdentity {
  const ambientAgentId = getAgentId()
  const contextAgentId = context.agentId

  // The in-process teammate's own turn: runAgent put the runner's turn id on
  // this context, so the caller is the teammate, not something it spawned.
  const turnAgentId = getTeammateContext()?.turnAgentId
  const isOwnTurn = turnAgentId !== undefined && contextAgentId === turnAgentId

  if (
    !isOwnTurn &&
    contextAgentId !== undefined &&
    contextAgentId !== ambientAgentId
  ) {
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
