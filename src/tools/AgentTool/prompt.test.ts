import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext, type Tools } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { toolToAPISchema } from '../../utils/api.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { AgentTool } from './AgentTool.js'
import { AGENT_TOOL_NAME } from './constants.js'
import * as forkSubagentModule from './forkSubagent.js'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Snapshot of the real fork gate, taken at module load and BEFORE any
 * mock.module() call: bun never unregisters a mock.module() override, and
 * re-reading the namespace object after mocking hands back the MOCK (the live
 * binding has already been swapped). Restoring means re-registering this copy.
 */
const realForkSubagentModule = { ...forkSubagentModule }
const FORK_SUBAGENT_MODULE = './forkSubagent.js'

/**
 * Render under the FORK branch. getPrompt() picks it on isForkSubagentEnabled()
 * alone (prompt.ts), and that needs `feature('FORK_SUBAGENT')` (false in the
 * test build) AND `!getIsNonInteractiveSession()` — ALSO false here, which is
 * why the mock is needed: `STATE.isInteractive` defaults to false
 * (bootstrap/state.ts:286, read back at :1063-1064) and nothing under
 * `bun test` sets it (forkSubagent.ts:35-40). Neither term is settable from a
 * test, so replacing the gate is the only way to reach that render at all.
 * Restored in `finally`.
 */
async function withForkRender<T>(render: () => Promise<T>): Promise<T> {
  mock.module(FORK_SUBAGENT_MODULE, () => ({
    ...realForkSubagentModule,
    isForkSubagentEnabled: () => true,
  }))
  try {
    return await render()
  } finally {
    mock.module(FORK_SUBAGENT_MODULE, () => realForkSubagentModule)
  }
}

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
    // The guard is isInProcessTeammate(), so the rule is FALSE of a pane
    // teammate — a separate process that keeps the parameter. Both halves are
    // pinned: stopping at "when you are a teammate" leaves the blanket wording
    // green.
    expect(prompt).toContain(
      "`run_in_background` is not available to you when you are a teammate running inside your lead's session",
    )
    expect(prompt).toContain(
      'a lead, or a teammate running in its own terminal, can use it',
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
  // Round 2 corrected the same bullet again: "in a lead's session that plan is
  // approved automatically" read as its own case to the in-process SUB-LEAD,
  // which bullets 1 and 2 address in those exact words, and for that reader it
  // is false. Its child writes to the SUB-team's `team-lead` mailbox
  // (ExitPlanModeV2Tool.ts:292-300 over the team AgentTool.tsx:457
  // substituted); the auto-approver never sees it (useInboxPoller.ts:97-99
  // returns early for an IN-PROCESS teammate — a pane teammate falls to the
  // isTeammate() branch just below — and :641-644 gates on
  // isTeamLead() over the ROOT team's inbox); and it cannot approve by hand
  // either (SendMessageTool.ts:479-483, isTeamLead at teammate.ts:171-190).
  // Only "reaches you as a message" survives for it
  // (inProcessRunner.ts:1351-1384), so the bullet now scopes the automatic
  // approval to the LEAD and tells the sub-lead the half it can act on.
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
    // True for both readers the bullet names: useInboxPoller.ts:699-702 for the
    // lead, inProcessRunner.ts:1351-1384 for the sub-lead. Round 3 dropped
    // "whoever you are": a plain subagent inside a lead's turn that passes
    // `name` is not a teammate, so AgentTool.tsx:437 is skipped and :481 spawns
    // a real teammate into the LEAD's team — that plan reaches the LEAD, never
    // the subagent that spawned it.
    expect(prompt).toContain('Its plan reaches you as a message.')
    expect(prompt).not.toContain('reaches you as a message whoever you are')
    // The automatic approval is the LEAD's half alone (useInboxPoller.ts:643),
    // and only in an INTERACTIVE session: the poller is a REPL hook mounted at
    // REPL.tsx:4700, so it does not run under `-p`, where only
    // shutdown_approved is handled out of band (attachments.ts:4382-4384) and a
    // headless lead answers the request by hand with SendMessage
    // (SendMessageTool/prompt.ts:79, permitted at SendMessageTool.ts:479-482).
    expect(prompt).toContain(
      'As a LEAD in an interactive session it is also approved for you automatically',
    )
    expect(prompt).not.toContain('you see it, you do not gate it')
    // And the sub-lead's half: nothing within its own reach approves it
    // (useInboxPoller.ts:97-99, SendMessageTool.ts:479-482), so it should not
    // ask for one. "automatically" is load-bearing — the ROOT lead can still
    // approve a sub-team child out of band, by addressing `child@<sub-team>`
    // (addressing.ts:126-133) into a handlePlanApproval that gates only on ITS
    // own team.
    expect(prompt).toContain(
      "As a TEAMMATE leading a sub-team from inside your lead's session, nothing approves it automatically",
    )
    expect(prompt).toContain(
      'do not spawn your sub-team members with `mode: "plan"`',
    )
    // The sub-team instruction now addresses only the reader that can act on it.
    expect(prompt).toContain("To lead a sub-team from inside your lead's session")
    // None of the three over-promises may come back.
    expect(prompt).not.toContain(
      "running inside your lead's session or in your own terminal",
    )
    expect(prompt).not.toContain('`mode` applies to such a teammate spawn')
    expect(prompt).not.toContain('requires it to get its plan approved by you')
    // Round 2's over-promise: true of the lead, false of the sub-lead that
    // reads "a lead's session" as its own.
    expect(prompt).not.toContain(
      "In a lead's session that plan is approved automatically",
    )
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

  // The description may not offer a parameter the schema does not carry, in
  // EITHER render. `toolToAPISchema` strips `name`, `team_name` and `mode` from
  // the input schema when Agent Teams is off (src/utils/api.ts:89-91,224-227)
  // in the very same cache-miss branch that renders the description, and
  // `TeamCreate` is not registered at all (TeamCreateTool.ts:245-247). Asserted
  // against the schema the API receives, so the two can only drift together.
  //
  // getPrompt() picks the fork render on isForkSubagentEnabled() ALONE, which
  // is independent of Agent Teams — so "fork on, teams off" is a reachable
  // combination and the fork render has to hold the invariant too. Both renders
  // are exercised below.

  type AgentAPISchema = {
    description: string
    input_schema: { properties?: object }
  }

  /** Rendered past the cache, so the caller's env is the env that renders. */
  async function agentAPISchema(): Promise<AgentAPISchema> {
    clearToolSchemaCache()
    return (await toolToAPISchema(AgentTool, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents,
    })) as AgentAPISchema
  }

  /** The Agent schema the API receives with Agent Teams OFF. */
  async function teamsOffSchema(): Promise<AgentAPISchema> {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
    // The opt-out already wins on its own (agentSwarmsEnabled.ts:21-24 checks
    // it before the ant branch), so this delete is belt-and-braces: it keeps the
    // render independent of an ambient ant build if that precedence ever moves.
    delete process.env.USER_TYPE

    return agentAPISchema()
  }

  /** The same schema with Agent Teams ON — the strip must not reach here. */
  async function teamsOnSchema(): Promise<AgentAPISchema> {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    return agentAPISchema()
  }

  /**
   * Every teammate-only parameter filterSwarmFieldsFromSchema takes out of the
   * Agent schema. `replicas` belongs here because its own describe() requires
   * `name`, which the same cache-miss branch has just stripped.
   */
  const TEAMMATE_SCHEMA_FIELDS = ['name', 'team_name', 'mode', 'replicas']

  // The list IS the content of every assertion that loops over it, and a loop
  // over a shorter list still passes: trimming one name to match a trimmed
  // SWARM_FIELDS_BY_TOOL would un-pin that field in all three tests below, and
  // `carries every teammate parameter when Agent Teams is ON` — which asserts
  // nothing else — would pass having asserted nothing at all. So the list needs
  // a pin of its own. The literal is that pin because SWARM_FIELDS_BY_TOOL is
  // not exported from the api module: an import would not compile.
  test('pins the teammate parameter list the loops below assert over', () => {
    expect(TEAMMATE_SCHEMA_FIELDS).toEqual([
      'name',
      'team_name',
      'mode',
      'replicas',
    ])
  })

  /** Clauses of TEAMMATE_SPAWN_RULES / TEAMMATE_BACKGROUND_RULE. */
  const TEAMMATE_PARAM_CLAUSES = [
    '`name` spawns a TEAMMATE',
    '`team_name` is then optional',
    '`mode: "plan"` starts the teammate in plan mode',
    'TeamCreate(team_name:',
    // Deliberately the SHORT substring. This list is asserted with
    // not.toContain, where a LONGER needle matches less and so pins less — the
    // opposite of the positive pin above.
    '`run_in_background` is not available to you when you are a teammate',
    // TEAMMATE_DEFAULT_RECOMMENDATION and its fork-section echo: they name
    // TeamCreate, `name` and `team_name`, so they share the same gate.
    '**Default to teammates.**',
    'A fork is the fallback, not the default',
  ]

  /**
   * The FORK-render fragment that still discusses a teammate parameter: the
   * omit-name/team_name note under the code-reviewer example, gated on the same
   * flag that strips those parameters from the schema.
   *
   * Round 3 DELETED the two that made a promise instead. The `name` sentence in
   * "When to fork" was false on both halves for the only reader it rendered to
   * (Agent Teams on): a fork is a `local_agent` and the panel lists teammate
   * rows by `type === 'in_process_teammate'`
   * (BackgroundTasksDialog.tsx:229,234), so a fork never gets one; and a lead
   * already in a team that passes `name` spawns a TEAMMATE, not a named fork —
   * AgentTool.tsx:481 branches on `teamName && name` with no regard for
   * `subagent_type`, over the team resolveTeamName (:1773-1782) hands it. The
   * `name:` line of the fork example demonstrated exactly that call.
   * DELETED_FORK_NAME_PROMISES pins that neither comes back.
   */
  const FORK_TEAMMATE_PARAM_FRAGMENTS = [
    'Omit name/team_name so it runs as a standard subagent',
  ]

  /** Gone from every render, Agent Teams on or off. */
  const DELETED_FORK_NAME_PROMISES = [
    'see the fork in the teams panel',
    'name: "ship-audit"',
  ]

  test('offers no teammate parameter that the schema does not carry', async () => {
    const schema = await teamsOffSchema()

    // This is the DEFAULT render, not the fork one — named so the fork case
    // below cannot be mistaken for a duplicate of it.
    expect(schema.description).not.toContain('## When to fork')

    const properties = Object.keys(schema.input_schema.properties ?? {})
    for (const field of TEAMMATE_SCHEMA_FIELDS) {
      expect(properties).not.toContain(field)
    }

    for (const clause of TEAMMATE_PARAM_CLAUSES) {
      expect(schema.description).not.toContain(clause)
    }
    // Same class, same gate: SendMessageTool.isEnabled() IS
    // isAgentSwarmsEnabled() (SendMessageTool.ts:836-838), so with Agent Teams
    // off that tool is not registered and the description may not name it.
    expect(schema.description).not.toContain('SendMessage')
    // Only the SendMessage half of that bullet is gated; its advice survives.
    expect(schema.description).toContain(
      'Each Agent invocation starts fresh — provide a complete task description.',
    )
    // The rest of the description is untouched by the gate.
    expect(schema.description).toContain('isolation: "worktree"')
  })

  test('the FORK render offers no teammate parameter either', async () => {
    const schema = await withForkRender(() => teamsOffSchema())

    // Prove the fork branch actually rendered: without these two the rest of
    // this test would pass vacuously on the default render.
    expect(schema.description).toContain('## When to fork')
    expect(schema.description).toContain(
      'Forks are cheap because they share your prompt cache',
    )

    const properties = Object.keys(schema.input_schema.properties ?? {})
    for (const field of TEAMMATE_SCHEMA_FIELDS) {
      expect(properties).not.toContain(field)
    }

    for (const clause of [
      ...TEAMMATE_PARAM_CLAUSES,
      ...FORK_TEAMMATE_PARAM_FRAGMENTS,
      ...DELETED_FORK_NAME_PROMISES,
    ]) {
      expect(schema.description).not.toContain(clause)
    }
    // The fork section named SendMessage twice ungated ("Don't peek", "Don't
    // take over"); with the tool unregistered, both mentions go with it.
    expect(schema.description).not.toContain('SendMessage')
    // What the gate must NOT take with it: the advice itself, in both places.
    expect(schema.description).toContain(
      'Each fresh Agent invocation with a subagent_type starts without context',
    )
    expect(schema.description).toContain(
      'Never write its output yourself or discard its result when it lands.',
    )
    expect(schema.description).toContain('isolation: "worktree"')
  })

  test('carries every teammate parameter when Agent Teams is ON', async () => {
    const schema = await teamsOnSchema()

    const properties = Object.keys(schema.input_schema.properties ?? {})
    for (const field of TEAMMATE_SCHEMA_FIELDS) {
      expect(properties).toContain(field)
    }
  })

  test('the FORK render keeps those fragments when Agent Teams is ON', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const prompt = await withForkRender(() => getPrompt(agents))

    expect(prompt).toContain('## When to fork')
    for (const fragment of FORK_TEAMMATE_PARAM_FRAGMENTS) {
      expect(prompt).toContain(fragment)
    }
    // Deleting the `name:` line must not disturb the example's shape.
    expect(prompt).toContain(
      `${AGENT_TOOL_NAME}({\n  description: "Branch ship-readiness audit",`,
    )
    // Neither deleted promise comes back in the render they were written for.
    for (const promise of DELETED_FORK_NAME_PROMISES) {
      expect(prompt).not.toContain(promise)
    }
    // SendMessage IS registered with Agent Teams on, so both fork-section
    // mentions and the tail bullet keep naming it.
    expect(prompt).toContain(
      'If you need to course-correct, use SendMessage — never Read.',
    )
    expect(prompt).toContain('Course-correct with SendMessage; never write')
    expect(prompt).toContain(
      'To continue a previously spawned agent, use SendMessage',
    )
    // And the teammate rules themselves are back with the parameters.
    expect(prompt).toContain('`name` spawns a TEAMMATE')
    // Forks stay documented, but framed as the fallback to teammates; the
    // built-in code-reviewer stays the exception to that default.
    expect(prompt).toContain(
      'A fork is the fallback, not the default — a named teammate in your team is still the better choice',
    )
    expect(prompt).toContain(
      'this is the exception to the "always teammates" default',
    )
    expect(prompt).toContain('**Default to teammates.**')
  })

  test('recommends named teammates in a team, in both renders, when Agent Teams is ON', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const full = await getPrompt(agents)
    // The slim supervisor render only carries `shared` — the default has to
    // live there, or the supervisor never sees it.
    const slim = await getPrompt(agents, true)
    for (const prompt of [full, slim]) {
      expect(prompt).toContain(
        '**Default to teammates.** Create a team once with TeamCreate, then spawn every agent with `name` (and `team_name`)',
      )
      expect(prompt).toContain(
        'can be re-tasked with SendMessage with their context still loaded, and report back to you',
      )
      // A recommendation, not a ban: the other paths stay open.
      expect(prompt).toContain('Omitting `name` still works; treat it as the fallback')
      expect(prompt).toContain('`Explore`, `Plan`, `code-reviewer`, `verification`')
    }
    expect(slim).not.toContain('Usage notes:')
  })
})

// The one-objective-one-agent policy is prompt text and nothing else.
// TEAMMATE-WORKFLOW-ROADMAP.md ("Rejected designs") records both enforcement
// designs being rejected — no topic records, no spawn-time listing, no
// across-call cap, no programmatic termination check — so the rendered string
// IS the mechanism and these assertions are the only thing holding it in
// place. They pin one distinct phrase per rule rather than matching the block
// as a blob: a blob match survives any rewrite that keeps the first and last
// sentence, which is exactly the drift the roadmap is trying to prevent.
describe('AgentTool prompt: one objective, one agent', () => {
  /**
   * Roadmap rule number -> the phrase that carries it. Distinct per rule: no
   * phrase here is a substring of another, so a rule dropped in a rewrite
   * fails its own assertion and not someone else's.
   */
  const OBJECTIVE_RULE_PHRASES: Array<[number, string]> = [
    [1, 'starting, running, idle, parked and shutting-down agents all hold that ownership'],
    [2, "needs the user's approval, asked for before you create the overlap, and two is the ceiling"],
    [3, 'Send the follow-up to the owner with SendMessage'],
    [4, 'do not start a speculative replacement, a competing implementation, or a second investigator'],
    [5, 'confirm with ListAgents that it is no longer listed'],
    [6, 'splitting the same work under a new label does not make it a new objective'],
    [7, 'parked on a usage limit is idle, not finished'],
  ]

  /**
   * Rule 5 used to say "shut the owner down" without naming HOW. This render is
   * NOT lead-only: the same memoised description reaches in-process teammates,
   * which are granted the Agent tool (agentToolUtils.ts:100-105) but never hold
   * TaskStop (ALL_AGENT_DISALLOWED_TOOLS, src/constants/tools.ts:45). So the
   * text states the holder condition and the sub-lead fallback rather than
   * naming TaskStop outright, and these phrases pin both halves. Pinned apart
   * from rule 5's own phrase above so a rewrite that keeps the confirmation
   * clause but drops the mechanism still fails something.
   */
  const SHUTDOWN_MECHANISM_PHRASES = [
    'SendMessage with `message: {"type": "shutdown_request"}`',
    'TaskStop if you have it, otherwise ask your own lead to stop it',
  ]

  /**
   * The reader-dependent form the phrases above replaced: unconditional, and
   * so false for any teammate that cannot call TaskStop. Pinned negatively —
   * the positive pins alone would pass a text that names both forms.
   */
  const RETIRED_SHUTDOWN_PHRASE = 'or TaskStop when it does not stop on its own'

  /**
   * Rendered to the lead and to a teammate from the SAME cached description
   * (see the design note above TEAMMATE_SPAWN_RULES), so the sub-team case is
   * stated in the shared text instead of branched on the reader.
   */
  const NESTED_DELEGATION_CLAUSE =
    'delegating one level down does not reset the count'

  // Same reasoning as `pins the teammate parameter list the loops below assert
  // over`: every assertion below is a loop over this list, and a loop over a
  // trimmed list still passes. Drop rule 5 from the array and nothing else in
  // this file notices. So the array needs a pin of its own.
  test('pins all seven rules the loops below assert over', () => {
    expect(OBJECTIVE_RULE_PHRASES.map(([rule]) => rule)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ])
  })

  test('carries all seven rules and the nested-delegation clause in both renders when Agent Teams is ON', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const full = await getPrompt(agents)
    // The rules live in the SHARED core, so the slim coordinator render has
    // to carry them too — a coordinator makes the same spawn decision.
    const slim = await getPrompt(agents, true)

    for (const prompt of [full, slim]) {
      expect(prompt).toContain(
        '**One objective, one agent.** An objective is owned by the agent working on it',
      )
      for (const [, phrase] of OBJECTIVE_RULE_PHRASES) {
        expect(prompt).toContain(phrase)
      }
      for (const phrase of SHUTDOWN_MECHANISM_PHRASES) {
        expect(prompt).toContain(phrase)
      }
      expect(prompt).not.toContain(RETIRED_SHUTDOWN_PHRASE)
      expect(prompt).toContain(NESTED_DELEGATION_CLAUSE)
      expect(prompt).toContain(
        "you cannot approve your own overlap, and a lead cannot grant one on the user's behalf",
      )
    }
    expect(slim).not.toContain('Usage notes:')
  })

  test('drops all seven rules when Agent Teams is OFF', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
    // The opt-out wins on its own (agentSwarmsEnabled.ts:21-24), but an
    // ambient ant build must not be able to turn this render back on.
    delete process.env.USER_TYPE

    const prompt = await getPrompt(agents)

    expect(prompt).not.toContain('**One objective, one agent.**')
    for (const [, phrase] of OBJECTIVE_RULE_PHRASES) {
      expect(prompt).not.toContain(phrase)
    }
    for (const phrase of SHUTDOWN_MECHANISM_PHRASES) {
      expect(prompt).not.toContain(phrase)
    }
    expect(prompt).not.toContain(NESTED_DELEGATION_CLAUSE)
    // The gate takes the rules because they name SendMessage and ListAgents,
    // both unregistered with Agent Teams off — not because the surrounding
    // description went away.
    expect(prompt).not.toContain('ListAgents')
    // Rule 5's escalation names TaskStop, and it lives inside the same gated
    // block, so the tool name goes with it.
    expect(prompt).not.toContain('TaskStop')
    expect(prompt).toContain('isolation: "worktree"')
  })

  test('the FORK render keeps the rules when Agent Teams is ON', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'
    forceAgentTeamsOn()

    const prompt = await withForkRender(() => getPrompt(agents))

    // Prove the fork branch actually rendered, or the rest passes vacuously
    // on the default render.
    expect(prompt).toContain('## When to fork')

    for (const [, phrase] of OBJECTIVE_RULE_PHRASES) {
      expect(prompt).toContain(phrase)
    }
    for (const phrase of SHUTDOWN_MECHANISM_PHRASES) {
      expect(prompt).toContain(phrase)
    }
    expect(prompt).not.toContain(RETIRED_SHUTDOWN_PHRASE)
    expect(prompt).toContain(NESTED_DELEGATION_CLAUSE)
  })
})
