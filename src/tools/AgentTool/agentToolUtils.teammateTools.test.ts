import { afterEach, beforeEach, expect, test } from 'bun:test'
import { IN_PROCESS_TEAMMATE_ALLOWED_TOOLS } from '../../constants/tools.js'
import type { Tool, Tools } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { HANDOFF_TEAM_TOOL_NAME } from '../HandoffTeamTool/constants.js'
import { LIST_AGENTS_TOOL_NAME } from '../ListAgentsTool/constants.js'
import { RECOVER_TEAM_TOOL_NAME } from '../RecoverTeamTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../TaskCreateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../TeamDeleteTool/constants.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { AGENT_TOOL_NAME } from './constants.js'

// An in-process teammate's turn runs through runAgent as an ASYNC agent, so
// its tool pool is what filterToolsForAgent lets through for an async agent
// plus the teammate exceptions. The sub-team tools (TeamCreate, RecoverTeam,
// HandoffTeam) each resolve the team from the caller and are useless to a
// lead's subagent, but a teammate cannot lead, recover or hand over a
// sub-team without them — and the runner's own "inject team-essential tools"
// list is intersected with this filtered pool, so the allowlist is the only
// place that can let them through.

const DISABLE_ENV = 'CLAUDE_CODE_DISABLE_AGENT_TEAMS'
let savedDisable: string | undefined

beforeEach(() => {
  savedDisable = process.env[DISABLE_ENV]
  delete process.env[DISABLE_ENV]
})

afterEach(() => {
  if (savedDisable === undefined) delete process.env[DISABLE_ENV]
  else process.env[DISABLE_ENV] = savedDisable
})

function stubTools(...toolNames: string[]): Tools {
  return toolNames.map(name => ({ name }) as unknown as Tool)
}

// The lead's pool, reduced to the names that matter here.
const POOL = stubTools(
  FILE_READ_TOOL_NAME,
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  RECOVER_TEAM_TOOL_NAME,
  HANDOFF_TEAM_TOOL_NAME,
)

// inProcessRunner's resolvedAgentDefinition for a plain teammate.
const PLAIN_TEAMMATE = {
  tools: ['*'],
  source: 'projectSettings' as const,
  permissionMode: 'default' as const,
}

function asTeammateTurn<T>(fn: () => T): T {
  return runWithTeammateContext(
    {
      agentId: 'supervisor@email',
      agentName: 'supervisor',
      teamName: 'email',
      planModeRequired: false,
      parentSessionId: 'parent-session',
      isInProcess: true,
      abortController: new AbortController(),
      turnAgentId: asAgentId('a00000000000cafe'),
    },
    fn,
  )
}

function names(tools: Tools): string[] {
  return tools.map(tool => tool.name).sort()
}

test('an in-process teammate turn keeps the caller-scoped sub-team tools', () => {
  const resolved = asTeammateTurn(
    () => resolveAgentTools(PLAIN_TEAMMATE, POOL, true).resolvedTools,
  )
  expect(names(resolved)).toEqual(
    expect.arrayContaining([
      TEAM_CREATE_TOOL_NAME,
      RECOVER_TEAM_TOOL_NAME,
      HANDOFF_TEAM_TOOL_NAME,
      AGENT_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
      LIST_AGENTS_TOOL_NAME,
      TASK_CREATE_TOOL_NAME,
      FILE_READ_TOOL_NAME,
    ]),
  )
})

test('TeamDelete is deliberately not exposed to a teammate turn', () => {
  // It has no caller-scoped branch and reads the shared AppState's team —
  // the PARENT team for an in-process teammate.
  const resolved = asTeammateTurn(
    () => resolveAgentTools(PLAIN_TEAMMATE, POOL, true).resolvedTools,
  )
  expect(names(resolved)).not.toContain(TEAM_DELETE_TOOL_NAME)
  expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(TEAM_DELETE_TOOL_NAME)).toBe(
    false,
  )
})

test('a plain async subagent outside any teammate turn gets none of them', () => {
  const resolved = resolveAgentTools(PLAIN_TEAMMATE, POOL, true).resolvedTools
  for (const name of [
    TEAM_CREATE_TOOL_NAME,
    RECOVER_TEAM_TOOL_NAME,
    HANDOFF_TEAM_TOOL_NAME,
    TEAM_DELETE_TOOL_NAME,
    AGENT_TOOL_NAME,
  ]) {
    expect(names(resolved)).not.toContain(name)
  }
  expect(names(resolved)).toContain(FILE_READ_TOOL_NAME)
})

test('the teammate allowlist names exactly the three caller-scoped sub-team tools', () => {
  for (const name of [
    TEAM_CREATE_TOOL_NAME,
    RECOVER_TEAM_TOOL_NAME,
    HANDOFF_TEAM_TOOL_NAME,
  ]) {
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(name)).toBe(true)
  }
})
