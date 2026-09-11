import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type Tools } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { toolToAPISchema } from '../../utils/api.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { AgentTool } from './AgentTool.js'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const originalEnv = {
  CLAUDE_CODE_AGENT_LIST_IN_MESSAGES:
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES,
  CLAUDE_CODE_DISABLE_AGENT_TEAMS: process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS,
  USER_TYPE: process.env.USER_TYPE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/prompt.test.ts')
})

afterEach(() => {
  try {
    restoreEnv('CLAUDE_CODE_AGENT_LIST_IN_MESSAGES')
    restoreEnv('CLAUDE_CODE_DISABLE_AGENT_TEAMS')
    restoreEnv('USER_TYPE')
  } finally {
    releaseSharedMutationLock()
  }
})

function restoreEnv(key: keyof typeof originalEnv): void {
  const originalValue = originalEnv[key]
  if (originalValue === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalValue
  }
}

/**
 * Agent Teams ON for this render, whatever the developer's shell exports.
 * `isAgentSwarmsEnabled()` checks the opt-out FIRST (agentSwarmsEnabled.ts:21-24
 * — "Explicit opt-out wins over everything, including ant builds"), so
 * USER_TYPE='ant' does NOT out-vote an exported CLAUDE_CODE_DISABLE_AGENT_TEAMS:
 * the opt-out has to be deleted. Both vars are snapshotted at module load and
 * put back in afterEach, so deleting here is self-cleaning.
 */
function forceAgentTeamsOn(): void {
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  process.env.USER_TYPE = 'ant'
}

const agents: AgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse: 'Use for general tasks',
    source: 'projectSettings',
    getSystemPrompt: () => 'system prompt',
  },
]

describe('AgentTool prompt isolation contract', () => {
  test('advertises worktree isolation but never remote isolation', async () => {
    forceAgentTeamsOn()
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await getPrompt(agents)

    expect(prompt).toContain('isolation: "worktree"')
    expect(prompt).not.toContain('isolation: "remote"')
    expect(prompt).toContain('parent folder that contains multiple git repos')
    expect(prompt).toContain('set `cwd` to the absolute path of the target child repository')
    expect(prompt).toContain('the agent still runs with that `cwd` override instead of failing')
    expect(prompt).toContain('tool result notes that worktree isolation was unavailable')
    expect(prompt).toContain('If worktree creation fails only because no git repository is available')
  })
})

// T4/F3: the in-process teammate branch used to say `name`, `team_name` and
// `mode` "are not available in this context". False since U3 — a teammate CAN
// spawn into the sub-team it leads, once it has created it.
// T8: the branch ITSELF was the defect. What a model reads is not what
// getPrompt() returns on a given call but what `toolToAPISchema` cached at the
// session's FIRST render (src/utils/api.ts:207-214, the Map at
// src/utils/toolSchemaCache.ts:18, cleared only on an auth or a tool-set
// change). An in-process teammate shares that process and that Map with its
// lead, and the lead necessarily renders `Agent` before it can call it to
// spawn a teammate — so the sub-team rule, gated on isInProcessTeammate(),
// never reached a teammate at all. ONE text now states all three reader cases
// — the lead, the teammate inside its lead's session, the teammate in its own
// terminal — with the reader each belongs to. These pin every clause in one
// render, that the bytes do not depend on where they are rendered (at
// getPrompt and through the production toolToAPISchema, in both orders), and
// that the block still promises nothing about a tree row — a teammate spawned
// by a teammate is not registered in the lead's AppState at HEAD.
describe('AgentTool prompt: one text for the lead and for the teammate', () => {
  function inTeammateContext<T>(fn: () => T): T {
    return runWithTeammateContext(
      {
        agentId: 'supervisor@zeekr',
        agentName: 'supervisor',
        teamName: 'zeekr',
        planModeRequired: false,
        parentSessionId: 'session-1',
        isInProcess: true,
        abortController: new AbortController(),
      },
      fn,
    )
  }

  /** The description bytes the API actually receives, memoised and all. */
  async function renderThroughAPISchema(): Promise<string> {
    const schema = await toolToAPISchema(AgentTool, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents,
    })
    return (schema as { description: string }).description
  }

  afterEach(() => {
    // The schema cache is module-level state shared with every other suite in
    // this process. There is no snapshot/restore for it: clearToolSchemaCache()
    // EMPTIES the Map, so the next suite starts from an empty cache rather than
    // the entries that were there before us. Emptying is the safe direction — a
    // stale entry rendered under this suite's env would outlive it.
    clearToolSchemaCache()
  })

  test('states the lead case and the teammate sub-team rule in ONE render', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const prompt = await getPrompt(agents)

    // The LEAD's half: AgentTool.tsx:434-436 resolves team_name, or the team
    // the caller is already in, and :481 spawns into it.
    expect(prompt).toContain(
      'as a LEAD, the team you pass in `team_name` or the team you are already in',
    )
    // The TEAMMATE's half: AgentTool.tsx:437-457.
    expect(prompt).toContain('`name` spawns a TEAMMATE')
    expect(prompt).toContain('the sub-team YOU lead, never your own team')
    expect(prompt).toContain('TeamCreate(team_name: "<your team>/<your name>")')
    expect(prompt).toContain('`team_name` is then optional')
    expect(prompt).toContain('must name exactly that sub-team')
    expect(prompt).toContain('`mode: "plan"` starts the teammate in plan mode')
    // AgentTool.tsx:462-464 — scoped to the in-process teammate, and said so.
    expect(prompt).toContain(
      '`run_in_background` is not available to you when you are a teammate',
    )
    // U3 made both of these false; neither may come back.
    expect(prompt).not.toContain('teammates cannot spawn other teammates')
    expect(prompt).not.toContain(
      'The name, team_name, and mode parameters are not available',
    )
  })

  // The three clauses the first version of this text got WRONG, each pinned to
  // the line that makes the corrected wording true at HEAD:
  //  - A teammate in its own terminal cannot lead a sub-team at all:
  //    createSubTeam refuses every caller that is not an in-process teammate
  //    (TeamCreateTool.ts:130-141), so readSubTeamLedBy finds nothing for it and
  //    AgentTool.tsx:440-450 refuses its named spawn every time. The shipped
  //    text told that reader to create a sub-team it can never have.
  //  - A lead in no team that passes no team_name resolves no team at all
  //    (resolveTeamName, AgentTool.tsx:1773-1782), so the spawn branch at :481
  //    is skipped and the call runs an ordinary subagent — which :610-614
  //    refuses when there is no prompt. The shipped text had no clause for it.
  //  - `mode`: AgentTool.tsx:546 (`plan_mode_required: spawnMode === 'plan'`) is
  //    the sole consumer, so no other value changes a teammate spawn; and in a
  //    lead's session useInboxPoller.ts:641-701 writes the approval itself and
  //    only then passes the request through as a message. The shipped text
  //    promised the spawner gates the plan.
  test('states the truth for the own-terminal teammate, the no-team lead and `mode`', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const prompt = await getPrompt(agents)

    expect(prompt).toContain(
      'as a TEAMMATE running in your own terminal, none — you cannot lead a sub-team there, so a spawn with `name` is refused',
    )
    expect(prompt).toContain(
      'ask your team lead to create the team and spawn its members instead',
    )
    expect(prompt).toContain(
      'with neither, `name` makes no teammate at all and the call runs an ordinary subagent, which needs a prompt',
    )
    expect(prompt).toContain('is the only `mode` value a teammate spawn acts on')
    expect(prompt).toContain(
      'that plan is approved automatically and reaches you as a message',
    )
    // The sub-team instruction now addresses only the reader that can act on it.
    expect(prompt).toContain("To lead a sub-team from inside your lead's session")
    // None of the three over-promises may come back.
    expect(prompt).not.toContain(
      "running inside your lead's session or in your own terminal",
    )
    expect(prompt).not.toContain('`mode` applies to such a teammate spawn')
    expect(prompt).not.toContain('requires it to get its plan approved by you')
  })

  test('the rendered text does not depend on where it is rendered', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    expect(await inTeammateContext(() => getPrompt(agents))).toBe(
      await getPrompt(agents),
    )
  })

  test('the memoised description carries the sub-team rule in either render order', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    // Lead first — the only order a real session can take.
    clearToolSchemaCache()
    const leadFirstLead = await renderThroughAPISchema()
    const leadFirstTeammate = await inTeammateContext(() =>
      renderThroughAPISchema(),
    )

    // Teammate first — the order that used to be the only one that worked.
    clearToolSchemaCache()
    const teammateFirstTeammate = await inTeammateContext(() =>
      renderThroughAPISchema(),
    )
    const teammateFirstLead = await renderThroughAPISchema()

    for (const description of [
      leadFirstLead,
      leadFirstTeammate,
      teammateFirstTeammate,
      teammateFirstLead,
    ]) {
      expect(description).toContain('the sub-team YOU lead, never your own team')
    }
    // And the cache hands every reader the same bytes, whoever missed first.
    expect(leadFirstTeammate).toBe(leadFirstLead)
    expect(teammateFirstLead).toBe(teammateFirstTeammate)
    expect(teammateFirstLead).toBe(leadFirstLead)
  })

  test('promises nothing about a tree row for the spawned teammate', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const prompt = await getPrompt(agents)
    // Only the teammate block: the rest of the prompt says "worktree".
    const start = prompt.indexOf('- `name` spawns a TEAMMATE')
    const end = prompt.indexOf('## Writing the prompt')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const teammateBlock = prompt.slice(start, end)

    for (const promise of ['tree', 'row', 'pill', 'visible', 'spinner']) {
      expect(teammateBlock).not.toContain(promise)
    }
  })

  // The description may not offer a parameter the schema does not carry.
  // `toolToAPISchema` strips `name`, `team_name` and `mode` from the input
  // schema when Agent Teams is off (src/utils/api.ts:89-91,224-227) in the very
  // same cache-miss branch that renders this text, and `TeamCreate` is not
  // registered at all (TeamCreateTool.ts:245-247). Asserted against the schema
  // the API receives, so the two can only drift together.
  test('offers no teammate parameter that the schema does not carry', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
    // The opt-out already wins on its own (agentSwarmsEnabled.ts:21-24 checks
    // it before the ant branch), so this delete is belt-and-braces: it keeps the
    // render independent of an ambient ant build if that precedence ever moves.
    delete process.env.USER_TYPE

    clearToolSchemaCache()
    const schema = (await toolToAPISchema(AgentTool, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents,
    })) as { description: string; input_schema: { properties?: object } }

    const properties = Object.keys(schema.input_schema.properties ?? {})
    expect(properties).not.toContain('name')
    expect(properties).not.toContain('team_name')
    expect(properties).not.toContain('mode')

    for (const clause of [
      '`name` spawns a TEAMMATE',
      '`team_name` is then optional',
      '`mode: "plan"` starts the teammate in plan mode',
      'TeamCreate(team_name:',
      '`run_in_background` is not available to you when you are a teammate',
    ]) {
      expect(schema.description).not.toContain(clause)
    }
    // The rest of the description is untouched by the gate.
    expect(schema.description).toContain('isolation: "worktree"')
  })
})
