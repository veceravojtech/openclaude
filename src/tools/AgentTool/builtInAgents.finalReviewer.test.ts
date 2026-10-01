import { expect, test } from 'bun:test'
// Load the tool graph first: importing a built-in agent module before it
// hits a pre-existing import cycle (TDZ), as noted in
// agentToolUtils.verificationVerdict.test.ts.
import '../../constants/tools.js'
import { FINAL_REVIEWER_AGENT } from './built-in/finalReviewerAgent.js'
import { getBuiltInAgents, isBuiltInAgentType } from './builtInAgents.js'
import { FINAL_REVIEW_AGENT_TYPE } from './constants.js'

// Phase 4: the final reviewer is a built-in agent registered unconditionally
// (not behind the VERIFICATION_AGENT flag) with a read-and-run tool set.

test('the final reviewer is registered unconditionally as a built-in', () => {
  const agents = getBuiltInAgents()
  const found = agents.find(a => a.agentType === FINAL_REVIEW_AGENT_TYPE)
  expect(found).toBe(FINAL_REVIEWER_AGENT)
  expect(isBuiltInAgentType(FINAL_REVIEW_AGENT_TYPE)).toBe(true)
  expect(FINAL_REVIEWER_AGENT.source).toBe('built-in')
})

test('its name makes the dispatcher classify it as a reviewer', () => {
  expect(FINAL_REVIEW_AGENT_TYPE).toContain('review')
})

test('explicit read-and-run allow-list: no Task, MCP, Edit or delegation tools', () => {
  const tools = FINAL_REVIEWER_AGENT.tools!
  expect(tools).toContain('Read')
  expect(tools).toContain('Bash')
  for (const tool of tools) {
    expect(['Read', 'Glob', 'Grep', 'Bash']).toContain(tool)
  }
  expect(tools.some(t => t.startsWith('mcp__') || t === '*')).toBe(false)
  const denied = FINAL_REVIEWER_AGENT.disallowedTools!
  for (const tool of [
    'Agent',
    'Edit',
    'Write',
    'NotebookEdit',
    'SendMessage',
    'TaskCreate',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
    'TaskStop',
    'TaskOutput',
  ]) {
    expect(denied).toContain(tool)
  }
})

test('no model (the dispatcher picks it), omits CLAUDE.md, carries the format reminder', () => {
  expect('model' in FINAL_REVIEWER_AGENT).toBe(false)
  expect(FINAL_REVIEWER_AGENT.omitClaudeMd).toBe(true)
  const reminder = FINAL_REVIEWER_AGENT.criticalSystemReminder_EXPERIMENTAL!
  expect(reminder).toContain('FINAL REVIEW: DONE')
  expect(reminder).toContain('FINAL REVIEW: GAPS')
  expect(reminder).toContain('REVIEW HEAD')
  const prompt = FINAL_REVIEWER_AGENT.getSystemPrompt({} as never)
  expect(prompt).toContain('REVIEW CWD: <output of pwd>')
  expect(prompt).toContain('git rev-parse HEAD')
  expect(prompt).toContain('git status --short')
  expect(prompt).toContain('claims, not proof')
  expect(FINAL_REVIEWER_AGENT.whenToUse).toContain('ORIGINAL USER REQUEST VERBATIM')
  expect(FINAL_REVIEWER_AGENT.whenToUse).toContain('review_commit')
})
