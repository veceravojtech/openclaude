import { expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { TaskStatus } from '../../Task.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AgentId } from '../../types/ids.js'
import type { TeammateStatus } from '../../utils/teamDiscovery.js'
import {
  type CollectAddressableAgentsInput,
  collectAddressableAgents,
  NO_ADDRESSABLE_AGENTS_MESSAGE,
  renderAddressableAgents,
  SEND_MESSAGE_HINT,
} from './collectAddressableAgents.js'

const TEAM = 'alpha'

function teammate(
  name: string,
  opts: {
    status?: TaskStatus
    isIdle?: boolean
    model?: string
    agentId?: string
  } = {},
): InProcessTeammateTaskState {
  return {
    id: `t-${name}`,
    type: 'in_process_teammate',
    status: opts.status ?? 'running',
    description: `${name}: doing work`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: opts.agentId ?? `${name}@${TEAM}`,
      agentName: name,
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'doing work',
    model: opts.model,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: opts.isIdle ?? false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function backgroundAgent(
  agentId: string,
  opts: {
    status?: TaskStatus
    agentType?: string
    model?: string
    description?: string
  } = {},
): LocalAgentTaskState {
  return {
    id: agentId,
    type: 'local_agent',
    status: opts.status ?? 'running',
    description: opts.description ?? `agent ${agentId}`,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId,
    prompt: 'p',
    agentType: opts.agentType ?? 'general-purpose',
    model: opts.model,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
}

function member(
  name: string,
  opts: Partial<TeammateStatus> = {},
): TeammateStatus {
  return {
    name,
    agentId: `${name}@${TEAM}`,
    status: 'running',
    tmuxPaneId: '%1',
    cwd: '/work',
    ...opts,
  }
}

function state(
  tasks: Array<InProcessTeammateTaskState | LocalAgentTaskState>,
  registry: Record<string, string> = {},
): Pick<CollectAddressableAgentsInput, 'tasks' | 'agentNameRegistry'> {
  return {
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])) as AppState['tasks'],
    agentNameRegistry: new Map(
      Object.entries(registry).map(([name, id]) => [name, id as AgentId]),
    ),
  }
}

/** A lead calling from outside any team context. */
const asLead = { teamMembers: [], callerIsTeammate: false } as const

test('empty state lists nothing', () => {
  const agents = collectAddressableAgents({ ...state([]), ...asLead })
  expect(agents).toEqual([])
  expect(renderAddressableAgents(agents)).toBe(NO_ADDRESSABLE_AGENTS_MESSAGE)
})

test('in-process teammates map idle/busy, skip non-running tasks, and are addressed by name', () => {
  const agents = collectAddressableAgents({
    ...state([
      teammate('idler', { isIdle: true, model: 'sonnet' }),
      teammate('worker'),
      // Terminal and not-yet-running teammate tasks are not addressable:
      // killed teammates are evicted within seconds and cannot be resumed.
      teammate('gone', { status: 'killed' }),
      teammate('starting', { status: 'pending' }),
    ]),
    ...asLead,
    teamName: TEAM,
  })
  expect(agents.map(a => [a.name, a.status, a.to])).toEqual([
    ['idler', 'idle', 'idler'],
    ['worker', 'busy', 'worker'],
  ])
  const idler = agents.find(a => a.name === 'idler')!
  expect(idler).toMatchObject({
    kind: 'teammate',
    agentId: `idler@${TEAM}`,
    team: TEAM,
    model: 'sonnet',
    description: 'idler: doing work',
  })
})

test('a lingering killed teammate task does not shadow a re-spawned running one', () => {
  // TaskStop leaves the killed task in AppState for ~3s (STOPPED_DISPLAY_MS);
  // a re-spawn of the same name gets the identical deterministic agentId and
  // is inserted after it, so first-wins dedupe would otherwise hide it.
  const killed = { ...teammate('coder', { status: 'killed' }), id: 't-coder-old' }
  const respawned = teammate('coder', { isIdle: true })
  const agents = collectAddressableAgents({
    ...state([killed, respawned]),
    ...asLead,
    teamName: TEAM,
  })
  expect(agents.map(a => [a.name, a.status, a.agentId])).toEqual([
    ['coder', 'idle', `coder@${TEAM}`],
  ])
})

test('team-file members add pane teammates and are deduped against in-process ones', () => {
  const longPrompt = 'x'.repeat(60)
  const agents = collectAddressableAgents({
    ...state([teammate('coder')]),
    teamMembers: [
      member('team-lead', { agentId: 'lead-id' }),
      // Same agentId as the in-process task: covered by (a), skipped here.
      member('coder', { status: 'idle' }),
      // Same name, different id (stale entry): still deduped by name.
      member('Coder', { agentId: 'stale@alpha', status: 'idle' }),
      member('painter', {
        status: 'idle',
        idleSince: '2026-09-08T10:00:00.000Z',
        model: 'opus',
        prompt: longPrompt,
      }),
      member('runner', { status: 'running', agentType: 'reviewer' }),
      member('mystery', { status: 'unknown' }),
    ],
    teamName: TEAM,
    callerIsTeammate: false,
  })
  expect(agents.map(a => [a.name, a.kind, a.status])).toEqual([
    ['coder', 'teammate', 'busy'],
    ['mystery', 'teammate', 'unknown'],
    ['painter', 'teammate', 'idle'],
    ['runner', 'teammate', 'busy'],
  ])
  expect(agents.find(a => a.name === 'painter')).toMatchObject({
    agentId: `painter@${TEAM}`,
    team: TEAM,
    model: 'opus',
    idleSince: '2026-09-08T10:00:00.000Z',
    description: `painter: ${'x'.repeat(50)}...`,
    to: 'painter',
  })
  expect(agents.find(a => a.name === 'runner')?.description).toBe(
    'runner: reviewer',
  )
})

test('named background agents come from the registry; main-session and evicted entries are skipped', () => {
  const agents = collectAddressableAgents({
    ...state(
      [
        backgroundAgent('a-1', { model: 'haiku', description: 'scout the repo' }),
        backgroundAgent('a-2', { status: 'completed' }),
        backgroundAgent('a-3', { status: 'pending' }),
        backgroundAgent('a-main', { agentType: 'main-session' }),
        backgroundAgent('a-unnamed'),
      ],
      {
        scout: 'a-1',
        done: 'a-2',
        queued: 'a-3',
        main: 'a-main',
        evicted: 'a-missing',
      },
    ),
    ...asLead,
  })
  expect(agents.map(a => [a.name, a.kind, a.status, a.to])).toEqual([
    ['done', 'background_agent', 'completed', 'done'],
    ['queued', 'background_agent', 'unknown', 'queued'],
    ['scout', 'background_agent', 'running', 'scout'],
  ])
  expect(agents.find(a => a.name === 'scout')).toMatchObject({
    agentId: 'a-1',
    model: 'haiku',
    description: 'scout the repo',
  })
  expect(agents.find(a => a.name === 'scout')?.team).toBeUndefined()
})

test('the caller is excluded by agentId and by name', () => {
  const s = state(
    [
      teammate('me'),
      teammate('peer'),
      backgroundAgent('a-me'),
      backgroundAgent('a-other'),
    ],
    { selfagent: 'a-me', other: 'a-other' },
  )
  // A background subagent knows only its agentId.
  expect(
    collectAddressableAgents({ ...s, ...asLead, selfAgentId: 'a-me' }).map(
      a => a.name,
    ),
  ).toEqual(['me', 'peer', 'other'])
  // A teammate is matched by name, case-insensitively.
  expect(
    collectAddressableAgents({
      ...s,
      teamMembers: [],
      selfAgentName: 'ME',
      callerIsTeammate: true,
      leadAgentId: 'lead-id',
    }).map(a => a.name),
  ).toEqual(['team-lead', 'peer', 'other', 'selfagent'])
})

test('team-lead is listed only for teammate callers', () => {
  const s = state([teammate('peer')])
  expect(
    collectAddressableAgents({ ...s, ...asLead }).map(a => a.kind),
  ).toEqual(['teammate'])

  const [lead] = collectAddressableAgents({
    ...s,
    teamMembers: [],
    teamName: TEAM,
    leadAgentId: 'lead-id',
    callerIsTeammate: true,
  })
  expect(lead).toEqual({
    name: 'team-lead',
    agentId: 'lead-id',
    kind: 'team_lead',
    status: 'unknown',
    description: 'Team lead (main session)',
    team: TEAM,
    to: 'team-lead',
  })

  // Without a known lead id the name doubles as the id.
  const [fallback] = collectAddressableAgents({
    ...s,
    teamMembers: [],
    callerIsTeammate: true,
  })
  expect(fallback?.agentId).toBe('team-lead')
})

test('sorted: team lead, then teammates by name, then background agents by name', () => {
  const agents = collectAddressableAgents({
    ...state([backgroundAgent('a-z'), teammate('zed'), backgroundAgent('a-b'), teammate('amy')], {
      zulu: 'a-z',
      bravo: 'a-b',
    }),
    teamMembers: [member('mid')],
    teamName: TEAM,
    callerIsTeammate: true,
  })
  expect(agents.map(a => `${a.kind}:${a.name}`)).toEqual([
    'team_lead:team-lead',
    'teammate:amy',
    'teammate:mid',
    'teammate:zed',
    'background_agent:bravo',
    'background_agent:zulu',
  ])
})

test('a registry name shadows a same-named teammate, matching SendMessage resolution', () => {
  const agents = collectAddressableAgents({
    ...state([teammate('twin'), backgroundAgent('a-twin')], { twin: 'a-twin' }),
    ...asLead,
  })
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ kind: 'background_agent', agentId: 'a-twin' })
})

test('renderAddressableAgents prints one line per agent plus the SendMessage hint', () => {
  const text = renderAddressableAgents([
    {
      name: 'team-lead',
      agentId: 'lead-id',
      kind: 'team_lead',
      status: 'unknown',
      description: 'Team lead (main session)',
      to: 'team-lead',
    },
    {
      name: 'coder',
      agentId: 'coder@alpha',
      kind: 'teammate',
      status: 'idle',
      description: 'coder: fix the tests',
      to: 'coder',
    },
    {
      name: 'scout',
      agentId: 'a-1',
      kind: 'background_agent',
      status: 'running',
      description: '',
      to: 'scout',
    },
  ])
  expect(text.split('\n')).toEqual([
    'team-lead  team_lead  unknown  to=team-lead  - Team lead (main session)',
    'coder  teammate  idle  to=coder  - coder: fix the tests',
    'scout  background_agent  running  to=scout',
    '',
    SEND_MESSAGE_HINT,
  ])
})
