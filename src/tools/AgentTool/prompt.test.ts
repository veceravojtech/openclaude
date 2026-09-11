import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { runWithTeammateContext } from '../../utils/teammateContext.js'
import { getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const originalEnv = {
  CLAUDE_CODE_AGENT_LIST_IN_MESSAGES:
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES,
  USER_TYPE: process.env.USER_TYPE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/prompt.test.ts')
})

afterEach(() => {
  try {
    restoreEnv('CLAUDE_CODE_AGENT_LIST_IN_MESSAGES')
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
// spawn into the sub-team it leads, once it has created it. These pin the
// truthful replacement, and that it promises nothing about a tree row (the
// spawned teammate is not registered in the lead's AppState at HEAD).
describe('AgentTool prompt for an in-process teammate', () => {
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

  test('describes the sub-team spawn rule instead of denying `name`', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await inTeammateContext(() => getPrompt(agents))

    expect(prompt).toContain(
      '`name` spawns a TEAMMATE into the sub-team you lead',
    )
    expect(prompt).toContain('TeamCreate(team_name: "<your team>/<your name>")')
    expect(prompt).toContain('`team_name` is optional')
    expect(prompt).toContain('must name exactly that sub-team')
    expect(prompt).toContain(
      '`mode: "plan"` requires it to get its plan approved by you',
    )
    expect(prompt).toContain('`run_in_background` is not available')
    expect(prompt).not.toContain(
      'The run_in_background, name, team_name, and mode parameters are not available',
    )
  })

  test('promises nothing about a tree row for the spawned teammate', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await inTeammateContext(() => getPrompt(agents))
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

  test('the non-teammate prompt says none of it', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await getPrompt(agents)

    expect(prompt).not.toContain('`name` spawns a TEAMMATE')
    expect(prompt).not.toContain('TeamCreate')
  })
})
