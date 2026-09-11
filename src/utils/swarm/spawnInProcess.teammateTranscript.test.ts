import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { enterTeammateView } from '../../state/teammateViewHelpers.js'
import { generateTaskId } from '../../Task.js'
import {
  appendCappedMessage,
  TEAMMATE_MESSAGES_UI_CAP,
} from '../../tasks/InProcessTeammateTask/types.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { toAgentId } from '../../types/ids.js'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import { createUserMessage } from '../messages.js'
import { TEAMMATE_GRACE_MS } from '../task/framework.js'
import { killInProcessTeammate } from './spawnInProcess.js'

/**
 * T6 gave a terminal teammate's row TEAMMATE_GRACE_MS so the user can select it
 * and press Enter. The same object literal that granted the window truncated
 * `messages` to its last entry, so the row opened onto one message.
 *
 * What the reader sees is `task.messages` itself: REPL's `displayedMessages`
 * reads it straight off the viewed task with no bootstrap in between, which is
 * why these drive the real kill through `killInProcessTeammate` and then assert
 * on the array.
 */

const NOW = 1_700_000_000_000
const TASK_ID = 'teammate-task-transcript'

let nowSpy: ReturnType<typeof spyOn> | undefined
let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/spawnInProcess.teammateTranscript.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-teammate-transcript-'))
  setClaudeConfigHomeDirForTesting(configDir)
  nowSpy = spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  try {
    nowSpy?.mockRestore()
    nowSpy = undefined
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/** `n` messages in the shape the runner mirrors into `task.messages`. */
function conversation(n: number): InProcessTeammateTaskState['messages'] {
  let messages: InProcessTeammateTaskState['messages']
  for (let i = 0; i < n; i++) {
    messages = appendCappedMessage(
      messages,
      createUserMessage({ content: `turn ${i}` }),
    )
  }
  return messages
}

function teammate(
  messages: InProcessTeammateTaskState['messages'],
): InProcessTeammateTaskState {
  return {
    id: TASK_ID,
    type: 'in_process_teammate',
    status: 'running',
    description: 'researcher: working',
    startTime: NOW - 5_000,
    outputFile: join(configDir ?? tmpdir(), 'researcher.log'),
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'researcher@email',
      agentName: 'researcher',
      teamName: '',
      planModeRequired: false,
      parentSessionId: 'parent-session',
    },
    prompt: 'research the thing',
    abortController: new AbortController(),
    awaitingPlanApproval: false,
    permissionMode: 'default',
    isIdle: false,
    shutdownRequested: false,
    pendingUserMessages: [],
    messages,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  } satisfies InProcessTeammateTaskState
}

/** An AppState the kill and the view entry can both be driven against. */
function store(task: InProcessTeammateTaskState) {
  let state: AppState = {
    ...getDefaultAppState(),
    tasks: { [TASK_ID]: task },
  }
  return {
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    get: () => state,
    task: () => state.tasks[TASK_ID] as InProcessTeammateTaskState,
  }
}

test('a killed teammate keeps the conversation, not its last message', () => {
  const before = conversation(4)
  const s = store(teammate(before))

  expect(killInProcessTeammate(TASK_ID, s.setAppState)).toBe(true)

  expect(s.task().status).toBe('killed')
  expect(s.task().messages).toEqual(before!)
})

test('the killed row is opened onto the whole conversation', () => {
  // The user's path through scenario 6's own kill: `k` on the selected row,
  // then Enter on it while it is still inside the grace window. The array
  // asserted here is the one REPL hands to the transcript.
  const s = store(teammate(conversation(4)))

  killInProcessTeammate(TASK_ID, s.setAppState)
  enterTeammateView(TASK_ID, s.setAppState)

  expect(s.get().viewingAgentTaskId).toBe(TASK_ID)
  expect(s.task().retain).toBe(true)
  expect(s.task().messages).toHaveLength(4)
})

test('the kill still writes T6 retain/grace pair', () => {
  const s = store(teammate(conversation(4)))

  killInProcessTeammate(TASK_ID, s.setAppState)

  expect(s.task().retain).toBe(false)
  expect(s.task().evictAfter).toBe(NOW + TEAMMATE_GRACE_MS)
})

test('TEAMMATE_MESSAGES_UI_CAP is what bounds a killed row', () => {
  // The ceiling the retained array is argued against: the kill hands the reader
  // whatever the cap allowed while the teammate ran, and nothing more.
  const s = store(teammate(conversation(TEAMMATE_MESSAGES_UI_CAP + 10)))
  expect(s.task().messages).toHaveLength(TEAMMATE_MESSAGES_UI_CAP)

  killInProcessTeammate(TASK_ID, s.setAppState)

  expect(s.task().messages).toHaveLength(TEAMMATE_MESSAGES_UI_CAP)
})

test('a teammate killed with nothing to show is opened onto nothing', () => {
  // An idle spawn never gets an initial prompt appended, so this is the state
  // e2e scenario 6's two teammates are actually killed in. The truncation used
  // to write `undefined` here; an empty array reads the same to every reader.
  const s = store(teammate([]))

  killInProcessTeammate(TASK_ID, s.setAppState)
  enterTeammateView(TASK_ID, s.setAppState)

  expect(s.task().messages).toEqual([])
})

test('a teammate task carries no agent id a transcript could be read by', () => {
  // Why the reader is served from AppState: reading a transcript takes an
  // AgentId, and a teammate has none to hand over — each TURN writes under its
  // own `createAgentId()`, which is never written back to the task. This goes
  // red if one ever is.
  expect(
    [
      ...Object.values(teammate(undefined)),
      ...Object.values(teammate(undefined).identity),
    ].filter(v => typeof v === 'string' && toAgentId(v) !== null),
  ).toEqual([])
  for (let i = 0; i < 32; i++) {
    expect(toAgentId(generateTaskId('in_process_teammate'))).toBeNull()
  }
})
