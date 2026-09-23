import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { withMockMacro } from '../test/mockMacro.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import type { Tools } from '../Tool.js'
import { getSystemPrompt } from './prompts.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

/**
 * getAgentToolSection() is private; it reaches the model only through
 * getSessionSpecificGuidanceSection, which gates on the Agent tool being in
 * the enabled set (`enabledTools` is built from tool NAMES in
 * getSystemPrompt). So the assertions below go through the public prompt with
 * a name-only stub rather than exporting internals for the test.
 */
const AGENT_TOOL_STUB = [{ name: AGENT_TOOL_NAME }] as unknown as Tools

const originalEnv = {
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  CLAUDE_CODE_DISABLE_AGENT_TEAMS: process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS,
  USER_TYPE: process.env.USER_TYPE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('constants/prompts.agentTeams.test.ts')
  // CLAUDE_CODE_SIMPLE short-circuits getSystemPrompt to a minimal prompt with
  // no session-guidance section at all, which would pass the OFF test
  // vacuously and fail the ON one for the wrong reason.
  delete process.env.CLAUDE_CODE_SIMPLE
  // The section is memoised per name until /clear (systemPromptSections.ts),
  // so a render cached by another test would out-vote the env set here.
  clearSystemPromptSections()
})

afterEach(() => {
  try {
    for (const key of Object.keys(originalEnv) as Array<
      keyof typeof originalEnv
    >) {
      const originalValue = originalEnv[key]
      if (originalValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalValue
      }
    }
    clearSystemPromptSections()
  } finally {
    releaseSharedMutationLock()
  }
})

async function renderSystemPrompt(): Promise<string> {
  return withMockMacro(
    {
      ISSUES_EXPLAINER: 'report the issue at the tracker',
      VERSION: '0.0.0-test',
      DISPLAY_VERSION: '0.0.0-test',
      PACKAGE_URL: '@gitlawb/openclaude',
    },
    async () => (await getSystemPrompt(AGENT_TOOL_STUB, 'test-model')).join('\n'),
  )
}

/**
 * The headline only. The full seven rules live once, on the lead side in
 * `src/tools/AgentTool/prompt.ts`, rendered at the moment the spawn decision
 * is made; the system prompt carries the headline so the policy is not a
 * second copy of that list here.
 */
const HEADLINE =
  'One objective, one agent: re-task the live owner with SendMessage instead of spawning a second agent for work someone already owns, and ask the user before putting a second agent on the same objective.'

test('the Agent-Teams delegation guidance carries the one-objective-one-agent headline', async () => {
  // Same gate as the Agent tool's own teammate text; the opt-out is checked
  // first (agentSwarmsEnabled.ts), so it has to be deleted, not out-voted.
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS
  process.env.USER_TYPE = 'ant'

  const prompt = await renderSystemPrompt()

  // Prove the Agent-Teams branch rendered at all, or the headline assertion
  // below could pass on a prompt that happens to contain it for another
  // reason — and prove the headline did not displace the branch's own text.
  expect(prompt).toContain('When you delegate, strongly prefer a team')
  expect(prompt).toContain(HEADLINE)
  // The headline is the WHOLE of the policy here. The seven rules are the
  // Agent tool description's job; restating them in the system prompt is the
  // duplication this split exists to avoid.
  expect(prompt).not.toContain('**One objective, one agent.**')
  expect(prompt).not.toContain('confirm with ListAgents that it is no longer listed')
})

test('the headline is absent when Agent Teams is OFF', async () => {
  process.env.CLAUDE_CODE_DISABLE_AGENT_TEAMS = '1'
  delete process.env.USER_TYPE

  const prompt = await renderSystemPrompt()

  expect(prompt).not.toContain(HEADLINE)
  expect(prompt).not.toContain('One objective, one agent')
  expect(prompt).not.toContain('When you delegate, strongly prefer a team')
  // The gate takes the delegation guidance, not the Agent tool bullet that
  // carries it — the non-teammate base text stays.
  expect(prompt).toContain(`Use the ${AGENT_TOOL_NAME} tool with specialized agents`)
})
