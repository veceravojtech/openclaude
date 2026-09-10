import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createTask } from '../tasks.js'
import {
  armSubLeadHandoff,
  formatHandoffDocument,
  formatSuccessorHandoffMessage,
  getHandoffDir,
  liveSubTeamMemberNames,
  type PendingSubLeadHandoff,
  takeSubLeadHandoff,
  writeSubLeadHandoffFile,
} from './subLeadHandoff.js'
import { getTeamDir } from './teamHelpers.js'

// U10: the halves of a handoff that neither spawn nor kill — where the notes
// go, what they say, and the one-shot request that carries "this run is
// ending to be replaced" from whoever decided it to the runner's tail.

const PARENT_TEAM = 'email'
const SUB_TEAM = `${PARENT_TEAM}/supervisor`
const SUB_LEAD_AGENT_ID = `supervisor@${PARENT_TEAM}`

let configDir: string | undefined
let nowSpy: ReturnType<typeof spyOn> | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/subLeadHandoff.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-handoff-'))
  setClaudeConfigHomeDirForTesting(configDir)
  nowSpy = spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000)
})

afterEach(() => {
  try {
    nowSpy?.mockRestore()
    nowSpy = undefined
    // Nothing may outlive a test in the one-shot registry.
    takeSubLeadHandoff(SUB_LEAD_AGENT_ID)
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

const PENDING: PendingSubLeadHandoff = {
  subTeamName: SUB_TEAM,
  leadAgentId: SUB_LEAD_AGENT_ID,
  handoffPath: '/tmp/handoff.md',
  source: 'tool',
  reason: 'context nearly full',
  firstInstruction: 'confirm the send window',
}

/** A live in-process teammate task, as the runner and the caps see one. */
function teammateTask(
  taskId: string,
  agentName: string,
  teamName: string,
  status: 'running' | 'completed' = 'running',
): [string, unknown] {
  return [
    taskId,
    {
      id: taskId,
      type: 'in_process_teammate',
      status,
      identity: { agentId: `${agentName}@${teamName}`, agentName, teamName },
    },
  ]
}

test('an armed handoff is readable exactly once', () => {
  expect(takeSubLeadHandoff(SUB_LEAD_AGENT_ID)).toBeUndefined()

  armSubLeadHandoff(PENDING)
  expect(takeSubLeadHandoff(SUB_LEAD_AGENT_ID)).toEqual(PENDING)
  // Delete-on-read: a handoff cannot fire twice, and the failure path can
  // discard one that never happened by taking it.
  expect(takeSubLeadHandoff(SUB_LEAD_AGENT_ID)).toBeUndefined()
  expect(takeSubLeadHandoff('someone@else')).toBeUndefined()
})

test('the notes live under the sub-team own directory and carry every section', async () => {
  await createTask(SUB_TEAM, {
    subject: 'ship the digest',
    description: 'write it',
    status: 'in_progress',
    owner: 'worker',
    blocks: [],
    blockedBy: [],
  })

  const path = await writeSubLeadHandoffFile({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    source: 'tool',
    reason: 'context nearly full',
    synthesis: 'the digest ships on Fridays',
    openItems: ['confirm the send window'],
    members: ['worker'],
  })

  // Under the team directory, never beside it, and never in a second tree.
  expect(path.startsWith(join(getTeamDir(SUB_TEAM), 'handoffs'))).toBe(true)
  expect(getHandoffDir(SUB_TEAM)).toBe(join(getTeamDir(SUB_TEAM), 'handoffs'))
  expect(existsSync(path)).toBe(true)

  const document = readFileSync(path, 'utf-8')
  expect(document).toContain(`# Handoff — ${SUB_TEAM}`)
  expect(document).toContain(`- From: ${SUB_LEAD_AGENT_ID}`)
  expect(document).toContain(`- Successor: ${SUB_LEAD_AGENT_ID}`)
  expect(document).toContain('- Requested by: the sub-lead itself (HandoffTeam)')
  expect(document).toContain('- Reason: context nearly full')
  expect(document).toContain('the digest ships on Fridays')
  expect(document).toContain('- confirm the send window')
  // The task list is snapshotted from disk, not asserted by the outgoing lead.
  expect(document).toContain('- [in_progress] #1 ship the digest (owner: worker)')
  expect(document).toContain('- worker')
})

test('the hook route says it wrote no synthesis instead of faking one', () => {
  const document = formatHandoffDocument({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    source: 'idle-timeout-hook',
    writtenAt: 1_700_000_000_000,
    tasks: [],
    members: [],
  })

  expect(document).toContain('- Requested by: the TeammateIdleTimeout hook')
  expect(document).toContain('- Reason: not given')
  expect(document).toContain('requested by the TeammateIdleTimeout hook')
  expect(document).toContain('None recorded.')
  expect(document).toContain('The task list was empty.')
  expect(document).toContain('No members were running.')
})

test('the successor message points at the notes and carries the predecessor asks', () => {
  const message = formatSuccessorHandoffMessage(PENDING)

  expect(message).toContain(`new lead of sub-team "${SUB_TEAM}"`)
  expect(message).toContain(`same identity (${SUB_LEAD_AGENT_ID})`)
  expect(message).toContain('Read the handoff notes first: /tmp/handoff.md')
  expect(message).toContain('Reason for the handoff: context nearly full')
  expect(message).toContain('confirm the send window')

  // Optional halves are omitted rather than rendered empty.
  const bare = formatSuccessorHandoffMessage({
    subTeamName: SUB_TEAM,
    leadAgentId: SUB_LEAD_AGENT_ID,
    handoffPath: '/tmp/handoff.md',
    source: 'idle-timeout-hook',
  })
  expect(bare).not.toContain('Reason for the handoff')
  expect(bare).not.toContain('asks you to start with')
})

test('the recorded members are the sub-team live ones only', () => {
  const tasks = Object.fromEntries([
    teammateTask('t-worker', 'worker', SUB_TEAM),
    teammateTask('t-gone', 'retired', SUB_TEAM, 'completed'),
    teammateTask('t-peer', 'peer', PARENT_TEAM),
  ]) as unknown as AppState['tasks']

  expect(liveSubTeamMemberNames(tasks, SUB_TEAM)).toEqual(['worker'])
  expect(liveSubTeamMemberNames(tasks, PARENT_TEAM)).toEqual(['peer'])
})
