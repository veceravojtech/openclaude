import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { getBuiltInAgents } from '../tools/AgentTool/builtInAgents.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from '../utils/swarm/teammatePromptAddendum.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../utils/teammate.js'
import { runWithTeammateContext } from '../utils/teammateContext.js'
import { getCoordinatorSystemPrompt } from './coordinatorMode.js'
import { WORK_MODES_SECTION } from './workModes.js'

const HEADING = '## 1b. Work modes'

afterEach(() => {
  clearDynamicTeamContext()
})

function asInProcessTeammate<T>(fn: () => T): T {
  return runWithTeammateContext(
    {
      agentId: 'dev@team',
      agentName: 'dev',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'lead-session',
      isInProcess: true,
      abortController: new AbortController(),
    },
    fn,
  )
}

describe('lead work modes — the lead', () => {
  it('carries the section in the lead prompt', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain(HEADING)
    expect(prompt).toContain(WORK_MODES_SECTION)
  })

  it('names the three modes and the Mode: first line', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('**answer**')
    expect(prompt).toContain('**ask**')
    expect(prompt).toContain('**develop**')
    expect(prompt).toContain('state it on the first line of your reply')
    expect(prompt).toContain('`Mode: develop`')
  })

  it('points develop mode at the on-demand checklist', () => {
    expect(getCoordinatorSystemPrompt()).toContain(
      'In develop mode, load the develop checklist',
    )
  })

  it('states escalation, monitoring and usage rules', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('Escalate, never quietly downgrade')
    expect(prompt).toContain('before anything is committed')
    expect(prompt).toContain('**Monitoring — keep your context small.**')
    expect(prompt).toContain('asked once, not respawned')
    expect(prompt).toContain('Never pull whole logs or transcripts')
    expect(prompt).toContain('**Usage.**')
    expect(prompt).toContain('Never silently substitute another model')
    expect(prompt).toContain('Mention the cost in your final summary')
  })

  it('sits between the self-work section and the tools section', () => {
    const prompt = getCoordinatorSystemPrompt()
    const ownHands = prompt.indexOf('## 1a.')
    const modes = prompt.indexOf(HEADING)
    const tools = prompt.indexOf('## 2. Your Tools')
    expect(ownHands).toBeGreaterThan(-1)
    expect(modes).toBeGreaterThan(ownHands)
    expect(tools).toBeGreaterThan(modes)
  })

  it('stays small — the long checklist is not always on', () => {
    expect(WORK_MODES_SECTION.length).toBeLessThan(2600)
    expect(WORK_MODES_SECTION.split('\n').length).toBeLessThanOrEqual(30)
    expect(WORK_MODES_SECTION).not.toContain('requiresFinalReview')
    expect(WORK_MODES_SECTION).not.toContain('review_commit')
  })
})

describe('lead work modes — never for teammates or subagents', () => {
  it('drops the section for a pane teammate', () => {
    setDynamicTeamContext({
      agentId: 'dev@team',
      agentName: 'dev',
      teamName: 'team',
      planModeRequired: false,
    })
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).not.toContain(HEADING)
    expect(prompt).not.toContain('Mode: develop')
    // The rest of the prompt is untouched.
    expect(prompt).toContain('## 2. Your Tools')
  })

  it('drops the section inside an in-process teammate', () => {
    const prompt = asInProcessTeammate(() => getCoordinatorSystemPrompt())
    expect(prompt).not.toContain(HEADING)
    expect(prompt).not.toContain('Mode: develop')
  })

  it('is not in the teammate addendum', () => {
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).not.toContain(HEADING)
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).not.toContain('Mode: develop')
  })

  it('is not wired into the in-process teammate runner', () => {
    const runner = readFileSync(
      new URL('../utils/swarm/inProcessRunner.ts', import.meta.url),
      'utf8',
    )
    expect(runner).not.toContain('getCoordinatorSystemPrompt')
    expect(runner).not.toContain('workModes')
  })

  it('is not in any built-in subagent prompt', () => {
    // claude-code-guide reads a build-time MACRO that bun test does not define.
    const agents = getBuiltInAgents().filter(
      agent => agent.agentType !== 'claude-code-guide',
    )
    expect(agents.map(agent => agent.agentType)).toContain('general-purpose')
    for (const agent of agents) {
      const prompt = (
        agent.getSystemPrompt as (params: unknown) => string
      )({
        toolUseContext: {
          options: {
            commands: [],
            mcpClients: [],
            agentDefinitions: { activeAgents: [], allAgents: [] },
          },
        },
      })
      expect(prompt).not.toContain(HEADING)
      expect(prompt).not.toContain('Mode: develop')
    }
  })
})
