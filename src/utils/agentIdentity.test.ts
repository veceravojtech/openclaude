import { expect, test } from 'bun:test'
import {
  type CallerIdentity,
  type CallerIdentityContext,
  resolveCallerIdentity,
} from './agentIdentity.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from './teammateContext.js'

const TEAM = 'alpha'
const SUPERVISOR_ID = `supervisor@${TEAM}`
const SUBAGENT_ID = 'ageneral-purpose-0123456789abcdef'

function contextFor(
  agentId?: string,
  opts: {
    registry?: Record<string, string>
    teamContext?: { selfAgentId?: string; selfAgentName?: string }
  } = {},
): CallerIdentityContext {
  return {
    agentId,
    getAppState: () => ({
      agentNameRegistry: new Map(Object.entries(opts.registry ?? {})),
      teamContext: opts.teamContext,
    }),
  }
}

function asSupervisor<T>(fn: () => T): T {
  return runWithTeammateContext(
    createTeammateContext({
      agentId: SUPERVISOR_ID,
      agentName: 'supervisor',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    }),
    fn,
  )
}

test('the lead resolves to its team identity and is never a teammate', () => {
  const identity: CallerIdentity = resolveCallerIdentity(
    contextFor(undefined, {
      teamContext: { selfAgentId: 'lead-id', selfAgentName: 'team-lead' },
    }),
  )
  expect(identity).toEqual({
    agentId: 'lead-id',
    name: 'team-lead',
    isTeammate: false,
  })
})

test('a session outside any team has no identity at all', () => {
  expect(resolveCallerIdentity(contextFor())).toEqual({
    agentId: undefined,
    name: undefined,
    isTeammate: false,
  })
})

test('a real teammate resolves to its own ambient identity', () => {
  expect(asSupervisor(() => resolveCallerIdentity(contextFor()))).toEqual({
    agentId: SUPERVISOR_ID,
    name: 'supervisor',
    isTeammate: true,
  })

  // Its own turn may carry the same id on the tool-use context: still itself.
  expect(
    asSupervisor(() => resolveCallerIdentity(contextFor(SUPERVISOR_ID))),
  ).toEqual({
    agentId: SUPERVISOR_ID,
    name: 'supervisor',
    isTeammate: true,
  })
})

test('a subagent inside a teammate resolves to itself, with the teammate as spawner', () => {
  // The subagent runs inside the teammate's AsyncLocalStorage context (that
  // inheritance carries permission routing and abort linkage, so it stays),
  // and is told apart by the differing tool-use-context agent id.
  const named = asSupervisor(() =>
    resolveCallerIdentity(
      contextFor(SUBAGENT_ID, { registry: { scout: SUBAGENT_ID } }),
    ),
  )
  expect(named).toEqual({
    agentId: SUBAGENT_ID,
    name: 'scout',
    isTeammate: false,
    spawnerAgentId: SUPERVISOR_ID,
  })

  // Unnamed background agents are addressed by their raw id.
  const unnamed = asSupervisor(() =>
    resolveCallerIdentity(contextFor(SUBAGENT_ID)),
  )
  expect(unnamed).toEqual({
    agentId: SUBAGENT_ID,
    name: undefined,
    isTeammate: false,
    spawnerAgentId: SUPERVISOR_ID,
  })
})

test('a subagent of the lead resolves to itself with no spawner', () => {
  expect(
    resolveCallerIdentity(
      contextFor(SUBAGENT_ID, {
        registry: { scout: SUBAGENT_ID },
        teamContext: { selfAgentId: 'lead-id', selfAgentName: 'team-lead' },
      }),
    ),
  ).toEqual({
    agentId: SUBAGENT_ID,
    name: 'scout',
    isTeammate: false,
    spawnerAgentId: undefined,
  })
})
