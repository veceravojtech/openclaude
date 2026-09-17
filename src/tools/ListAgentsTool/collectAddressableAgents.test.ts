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
  TEAM_FILE_ONLY_MARKER,
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
const asLead = { teamMembers: [], includeTeamLead: false } as const

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
    ['idler', 'idle', `idler@${TEAM}`],
    ['worker', 'busy', `worker@${TEAM}`],
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
  // TaskStop leaves the killed task in AppState for the TEAMMATE_GRACE_MS
  // window — killInProcessTeammate writes the retain/evictAfter marker and the
  // lazy GC collects the task once the deadline passes — and a re-spawn of the
  // same name gets the identical deterministic agentId and is inserted after
  // it, so first-wins dedupe would otherwise hide it.
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
    includeTeamLead: false,
  })
  // Only `coder` has a task behind it, so only `coder` gets a liveness word.
  // The other three are in the file and nowhere else: the file's own
  // idle/running column is derived from a flag nothing ever writes, so it is
  // not evidence and they report `unknown`.
  expect(agents.map(a => [a.name, a.kind, a.status, a.source])).toEqual([
    ['coder', 'teammate', 'busy', 'task'],
    ['mystery', 'teammate', 'unknown', 'team_file'],
    ['painter', 'teammate', 'unknown', 'team_file'],
    ['runner', 'teammate', 'unknown', 'team_file'],
  ])
  expect(agents.find(a => a.name === 'painter')).toMatchObject({
    agentId: `painter@${TEAM}`,
    team: TEAM,
    model: 'opus',
    idleSince: '2026-09-08T10:00:00.000Z',
    description: `painter: ${'x'.repeat(50)}...`,
    to: `painter@${TEAM}`,
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
      includeTeamLead: true,
      leadAgentId: 'lead-id',
    }).map(a => a.name),
  ).toEqual(['team-lead', 'peer', 'other', 'selfagent'])
})

test('a subagent inside a teammate keeps its spawner listed and itself out', () => {
  // The observed defect was the mirror image of this: the subagent inherited
  // its spawner's name as `selfAgentName`, so `supervisor` was excluded and
  // the subagent's own row stayed.
  const agents = collectAddressableAgents({
    ...state([teammate('supervisor'), backgroundAgent('a-sub')], {
      scout: 'a-sub',
    }),
    teamMembers: [],
    teamName: TEAM,
    leadAgentId: 'lead-id',
    selfAgentId: 'a-sub',
    selfAgentName: 'scout',
    includeTeamLead: true,
  })
  expect(agents.map(a => [a.name, a.kind])).toEqual([
    ['team-lead', 'team_lead'],
    ['supervisor', 'teammate'],
  ])
})

test('team-lead is listed only when the caller asks for it', () => {
  const s = state([teammate('peer')])
  expect(
    collectAddressableAgents({ ...s, ...asLead }).map(a => a.kind),
  ).toEqual(['teammate'])

  const [lead] = collectAddressableAgents({
    ...s,
    teamMembers: [],
    teamName: TEAM,
    leadAgentId: 'lead-id',
    includeTeamLead: true,
  })
  expect(lead).toEqual({
    name: 'team-lead',
    agentId: 'lead-id',
    kind: 'team_lead',
    status: 'unknown',
    description: 'Team lead (main session)',
    team: TEAM,
    to: `team-lead@${TEAM}`,
  })

  // Without a known lead id the name doubles as the id.
  const [fallback] = collectAddressableAgents({
    ...s,
    teamMembers: [],
    includeTeamLead: true,
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
    includeTeamLead: true,
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

test('a same-named background agent and teammate are both listed, at their own addresses', () => {
  // The bare name is the registry agent's, matching the order SendMessage
  // resolves `to` in; the teammate keeps its qualified address, so a name
  // collision no longer hides an agent that is genuinely reachable.
  const agents = collectAddressableAgents({
    ...state([teammate('twin'), backgroundAgent('a-twin')], { twin: 'a-twin' }),
    ...asLead,
    teamName: TEAM,
  })
  expect(agents.map(a => [a.kind, a.agentId, a.to])).toEqual([
    ['teammate', `twin@${TEAM}`, `twin@${TEAM}`],
    ['background_agent', 'a-twin', 'twin'],
  ])
})

const SUB_TEAM = `${TEAM}/supervisor`

/** The same in-process teammate task, but running in another team. */
function inTeam(
  task: InProcessTeammateTaskState,
  team: string,
): InProcessTeammateTaskState {
  return {
    ...task,
    identity: {
      ...task.identity,
      agentId: `${task.identity.agentName}@${team}`,
      teamName: team,
    },
  }
}

test('a member of a sub-team lists its sub-lead, the root lead and its siblings', () => {
  const agents = collectAddressableAgents({
    ...state([]),
    teamMembers: [
      member('sibling', { agentId: `sibling@${SUB_TEAM}`, status: 'idle' }),
    ],
    teamName: SUB_TEAM,
    leadAgentId: `team-lead@${SUB_TEAM}`,
    selfAgentId: `worker@${SUB_TEAM}`,
    selfAgentName: 'worker',
    includeTeamLead: true,
    tree: {
      root: { teamName: TEAM, leadAgentId: 'lead-id' },
      parentAgentId: `supervisor@${TEAM}`,
    },
  })
  // Both leads are called `team-lead`; the address is what tells them apart,
  // and a bare `team-lead` from here means the sub-lead.
  expect(agents.map(a => [a.name, a.kind, a.team, a.to])).toEqual([
    ['team-lead', 'team_lead', TEAM, `team-lead@${TEAM}`],
    ['team-lead', 'team_lead', SUB_TEAM, `team-lead@${SUB_TEAM}`],
    ['sibling', 'teammate', SUB_TEAM, `sibling@${SUB_TEAM}`],
  ])
  expect(agents.map(a => [a.agentId, a.description])).toEqual([
    ['lead-id', 'Team lead (main session)'],
    [`team-lead@${SUB_TEAM}`, `Lead of ${SUB_TEAM} (supervisor@${TEAM})`],
    [`sibling@${SUB_TEAM}`, 'sibling: teammate'],
  ])
})

test('a teammate leading a sub-team lists its own team and its children', () => {
  const agents = collectAddressableAgents({
    ...state([teammate('sibling'), inTeam(teammate('child'), SUB_TEAM)]),
    teamMembers: [member('sibling'), member('supervisor')],
    teamName: TEAM,
    leadAgentId: 'lead-id',
    selfAgentId: `supervisor@${TEAM}`,
    selfAgentName: 'supervisor',
    includeTeamLead: true,
    tree: {
      subTeam: {
        teamName: SUB_TEAM,
        members: [
          member('child', { agentId: `child@${SUB_TEAM}` }),
          member('painter', { agentId: `painter@${SUB_TEAM}`, status: 'idle' }),
        ],
      },
    },
  })
  // Its own row is gone, its lead is the root's, and both children are here —
  // the in-process one from AppState, the pane one from the sub-team file.
  expect(agents.map(a => [a.name, a.kind, a.team, a.to])).toEqual([
    ['team-lead', 'team_lead', TEAM, `team-lead@${TEAM}`],
    ['child', 'teammate', SUB_TEAM, `child@${SUB_TEAM}`],
    ['painter', 'teammate', SUB_TEAM, `painter@${SUB_TEAM}`],
    ['sibling', 'teammate', TEAM, `sibling@${TEAM}`],
  ])
  expect(agents.find(a => a.name === 'child')?.agentId).toBe(
    `child@${SUB_TEAM}`,
  )
})

test('teammates of another branch of the tree are not neighbours', () => {
  // Every in-process teammate of the session sits in the lead's AppState,
  // including the members of a sub-team the caller has nothing to do with.
  const agents = collectAddressableAgents({
    ...state([teammate('sibling'), inTeam(teammate('cousin'), `${TEAM}/other`)]),
    teamMembers: [],
    teamName: TEAM,
    includeTeamLead: false,
  })
  expect(agents.map(a => [a.name, a.to])).toEqual([['sibling', `sibling@${TEAM}`]])
})

test('a same-named agent in another team of the tree is not the caller', () => {
  // Name-only self-exclusion would drop a child that happens to share the
  // caller's name: one team's roster is unique, the tree's is not.
  const agents = collectAddressableAgents({
    ...state([]),
    teamMembers: [],
    teamName: TEAM,
    selfAgentId: `supervisor@${TEAM}`,
    selfAgentName: 'supervisor',
    includeTeamLead: false,
    tree: {
      subTeam: {
        teamName: SUB_TEAM,
        members: [
          member('supervisor', { agentId: `supervisor@${SUB_TEAM}` }),
        ],
      },
    },
  })
  expect(agents.map(a => a.to)).toEqual([`supervisor@${SUB_TEAM}`])
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

test('a team-file member with no live local task is not presented as live', () => {
  // `isActive` is maintained only by the teammate itself, as it goes idle and
  // busy; getTeammateStatuses reads a missing or true flag as "running". A
  // pane teammate that died on its first turn never got to say otherwise, so
  // it stays `isActive: true` forever and this row used to claim it was busy.
  // Without a task behind it, the file says only that the member was once
  // written down: it may be dead, or it may belong to another session.
  const agents = collectAddressableAgents({
    ...state([]),
    teamMembers: [member('ghost')],
    teamName: TEAM,
    includeTeamLead: false,
  })
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({
    name: 'ghost',
    status: 'unknown',
    source: 'team_file',
    to: `ghost@${TEAM}`,
  })
  expect(agents[0]?.taskId).toBeUndefined()
  expect(renderAddressableAgents(agents)).toContain(TEAM_FILE_ONLY_MARKER)
})

test('a task-backed row carries the real task id, in the row and in the output', () => {
  // The task id is what TaskStop takes. It was in hand here all along and
  // never surfaced, so a user watching a teammate hang had no id to stop it by.
  const agents = collectAddressableAgents({
    ...state([teammate('coder'), backgroundAgent('a-1')], { scout: 'a-1' }),
    ...asLead,
    teamName: TEAM,
  })
  expect(agents.map(a => [a.name, a.source, a.taskId, a.to])).toEqual([
    ['coder', 'task', 't-coder', `coder@${TEAM}`],
    ['scout', 'task', 'a-1', 'scout'],
  ])
  const lines = renderAddressableAgents(agents).split('\n')
  expect(lines[0]).toContain('task=t-coder')
  expect(lines[1]).toContain('task=a-1')
  expect(lines[0]).not.toContain(TEAM_FILE_ONLY_MARKER)
})

test('a team-file member with a live task takes the task status and its id', () => {
  // The task is the live fact; the file is a cache of it. A member whose task
  // has failed reports `failed`, not the file's cheerful default.
  const agents = collectAddressableAgents({
    ...state([
      teammate('coder', { isIdle: true }),
      teammate('gone', { status: 'failed' }),
    ]),
    teamMembers: [member('coder'), member('gone')],
    teamName: TEAM,
    includeTeamLead: false,
  })
  expect(agents.map(a => [a.name, a.status, a.source, a.taskId])).toEqual([
    ['coder', 'idle', 'task', 't-coder'],
    ['gone', 'failed', 'task', 't-gone'],
  ])
  expect(renderAddressableAgents(agents)).not.toContain(TEAM_FILE_ONLY_MARKER)
})

test('the `to` address is identical whether a row is task-backed or file-only', () => {
  // Addressing is a separate, working concern: honesty about liveness must not
  // cost SendMessage its recipient.
  const backed = collectAddressableAgents({
    ...state([teammate('coder')]),
    teamMembers: [member('coder')],
    teamName: TEAM,
    includeTeamLead: false,
  })
  const fileOnly = collectAddressableAgents({
    ...state([]),
    teamMembers: [member('coder')],
    teamName: TEAM,
    includeTeamLead: false,
  })
  expect(backed.map(a => a.to)).toEqual([`coder@${TEAM}`])
  expect(fileOnly.map(a => a.to)).toEqual([`coder@${TEAM}`])
  expect(backed[0]?.source).toBe('task')
  expect(fileOnly[0]?.source).toBe('team_file')
  // Same for a sub-team child, whose address carries the sub-team's name.
  const child = collectAddressableAgents({
    ...state([]),
    teamMembers: [],
    teamName: TEAM,
    includeTeamLead: false,
    tree: {
      subTeam: {
        teamName: SUB_TEAM,
        members: [member('child', { agentId: `child@${SUB_TEAM}` })],
      },
    },
  })
  expect(child.map(a => [a.to, a.status, a.source])).toEqual([
    [`child@${SUB_TEAM}`, 'unknown', 'team_file'],
  ])
})
