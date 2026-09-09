import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { type AgentId, toAgentId } from '../types/ids.js'
import {
  type CallerIdentity,
  type CallerIdentityContext,
  resolveCallerIdentity,
} from './agentIdentity.js'
import { getDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from './teammateContext.js'
import { createAgentId } from './uuid.js'

const TEAM = 'alpha'
const SUPERVISOR_ID = `supervisor@${TEAM}`
const SUBAGENT_ID = 'ageneral-purpose-0123456789abcdef'

let originalDynamicTeamContext: ReturnType<typeof getDynamicTeamContext> = null

beforeEach(async () => {
  await acquireSharedMutationLock('utils/agentIdentity.test.ts')
  originalDynamicTeamContext = getDynamicTeamContext()
  setDynamicTeamContext(null)
})

afterEach(() => {
  try {
    setDynamicTeamContext(originalDynamicTeamContext)
  } finally {
    releaseSharedMutationLock()
  }
})

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

/**
 * Run `fn` inside an in-process teammate's ambient context. `turnAgentId` is
 * the id the runner minted for the turn in progress, published on the context
 * exactly as `runInProcessTeammate` publishes it; omit it for the shapes that
 * carry none (a tmux teammate, a context built before U2b).
 */
function asSupervisor<T>(fn: () => T, turnAgentId?: AgentId): T {
  return runWithTeammateContext(
    {
      ...createTeammateContext({
        agentId: SUPERVISOR_ID,
        agentName: 'supervisor',
        teamName: TEAM,
        planModeRequired: false,
        parentSessionId: 'lead-session',
        abortController: new AbortController(),
      }),
      ...(turnAgentId !== undefined && { turnAgentId }),
    },
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

test('a teammate’s own turn resolves to the teammate, never to a subagent of itself', () => {
  // The runtime shape, not a same-id fixture: a teammate's turn goes through
  // runAgent, which stamps a freshly minted AgentId on every tool context it
  // builds (runAgent.ts:389 → createSubagentContext at :746). That id can never
  // equal the ambient `name@team`, so "the context id differs" cannot mean
  // "a subagent" — the runner's published turn id is what settles it.
  const turnAgentId = createAgentId()
  expect(toAgentId(turnAgentId)).not.toBeNull()
  expect(turnAgentId).not.toBe(SUPERVISOR_ID)

  expect(
    asSupervisor(
      () => resolveCallerIdentity(contextFor(turnAgentId)),
      turnAgentId,
    ),
  ).toEqual({
    agentId: SUPERVISOR_ID,
    name: 'supervisor',
    isTeammate: true,
  })
})

test('a subagent spawned inside that same turn is still a subagent of the teammate', () => {
  // Both ids are runtime-shaped and distinct, and only one of them is the
  // turn's: the other one is the subagent's own.
  const turnAgentId = createAgentId()
  const subagentId = createAgentId()
  expect(subagentId).not.toBe(turnAgentId)

  expect(
    asSupervisor(
      () =>
        resolveCallerIdentity(
          contextFor(subagentId, { registry: { scout: subagentId } }),
        ),
      turnAgentId,
    ),
  ).toEqual({
    agentId: subagentId,
    name: 'scout',
    isTeammate: false,
    spawnerAgentId: SUPERVISOR_ID,
  })

  // Unnamed, and the teammate's own turn id is still recognised alongside it.
  expect(
    asSupervisor(
      () => resolveCallerIdentity(contextFor(subagentId)),
      turnAgentId,
    ),
  ).toEqual({
    agentId: subagentId,
    name: undefined,
    isTeammate: false,
    spawnerAgentId: SUPERVISOR_ID,
  })
})

test('a tmux teammate keeps the rule it had: no turn id, so a differing context id is a subagent', () => {
  // Pane teammates are separate processes whose identity comes from
  // dynamicTeamContext (main.tsx), not from the in-process AsyncLocalStorage
  // context, so nothing ever publishes a turn id for them. The pre-U2b rule
  // must keep applying there verbatim.
  setDynamicTeamContext({
    agentId: SUPERVISOR_ID,
    agentName: 'supervisor',
    teamName: TEAM,
    planModeRequired: false,
  })

  expect(resolveCallerIdentity(contextFor())).toEqual({
    agentId: SUPERVISOR_ID,
    name: 'supervisor',
    isTeammate: true,
  })
  expect(resolveCallerIdentity(contextFor(SUBAGENT_ID))).toEqual({
    agentId: SUBAGENT_ID,
    name: undefined,
    isTeammate: false,
    spawnerAgentId: SUPERVISOR_ID,
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
