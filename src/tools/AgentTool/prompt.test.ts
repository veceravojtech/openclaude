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
    process.env.USER_TYPE = 'ant'
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
// never reached a teammate at all. ONE text now states the LEAD case and the
// TEAMMATE case with the reader each belongs to. These pin both clauses in one
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
    // this process — leave it as we found it.
    clearToolSchemaCache()
  })

  test('states the lead case and the teammate sub-team rule in ONE render', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.USER_TYPE = 'ant' // Agent Teams on, whatever the killswitch says

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
    expect(prompt).toContain(
      '`mode: "plan"` requires it to get its plan approved by you',
    )
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

  test('the rendered text does not depend on where it is rendered', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.USER_TYPE = 'ant'

    expect(await inTeammateContext(() => getPrompt(agents))).toBe(
      await getPrompt(agents),
    )
  })

  test('the memoised description carries the sub-team rule in either render order', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.USER_TYPE = 'ant'

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
    process.env.USER_TYPE = 'ant'

    const prompt = await getPrompt(agents)
    // Only the teammate block: the rest of the prompt says "worktree".
    const start = prompt.indexOf('- `name` spawns a TEAMMATE')
    const end = prompt.indexOf('## Writing the prompt')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const teammateBlock = prompt.slice(start, end)

    for (const promise of ['tree', 'row', 'pill', 'visible']) {
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
    delete process.env.USER_TYPE // 'ant' forces Agent Teams back on

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
      '`mode: "plan"` requires',
      'TeamCreate(team_name:',
      '`run_in_background` is not available to you when you are a teammate',
    ]) {
      expect(schema.description).not.toContain(clause)
    }
    // The rest of the description is untouched by the gate.
    expect(schema.description).toContain('isolation: "worktree"')
  })
})
