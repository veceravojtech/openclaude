import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import type { TaskState } from '../../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolUseContext } from '../../Tool.js'
import { BackgroundTasksDialog } from './BackgroundTasksDialog.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
const ENTER = '\r'
const DOWN = '\x1B[B'

type DoneCall = {
  result?: string
  display?: string
}

function taskBase(id: string, status: TaskState['status']) {
  return {
    id,
    status,
    description: `task ${id}`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: false,
  }
}

function agentTask(id: string): LocalAgentTaskState {
  return {
    ...taskBase(id, 'running'),
    type: 'local_agent',
    agentId: id,
    prompt: 'prompt',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
}

// A finished panel agent. `retain`/`evictAfter` are the two clauses of
// isPanelVisibleAgent, so each variant sets them explicitly — never a bare
// Date.now() that could race the predicate's `now` comparison.
function completedAgentTask(
  id: string,
  kept: { retain: boolean; evictAfter?: number },
): LocalAgentTaskState {
  return {
    ...agentTask(id),
    status: 'completed',
    retain: kept.retain,
    evictAfter: kept.evictAfter,
  }
}

function bashTask(id: string): LocalShellTaskState {
  return {
    ...taskBase(id, 'running'),
    type: 'local_bash',
    command: `echo ${id}`,
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }
}

function teammateTask(
  id: string,
  status: TaskState['status'] = 'running',
): InProcessTeammateTaskState {
  return {
    ...taskBase(id, status),
    type: 'in_process_teammate',
    identity: {
      agentId: `${id}@team`,
      agentName: id,
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: 'prompt',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function stateWith(tasks: TaskState[], overrides?: Partial<AppState>): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
    ...overrides,
  }
}

// Non-TTY stdout emits one DEC-synchronized frame per render; reading the raw
// buffer yields concatenated duplicates, so pull the last complete frame out.
function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return stripAnsi(lastFrame ?? output)
}

/**
 * Mounts the real dialog over a PassThrough stdin/stdout pair so both key
 * paths can be driven natively: Enter goes through `useKeybindings`
 * ('confirm:yes', hence the `KeybindingSetup` wrapper) and `f` through the raw
 * `onKeyDown` handler on the dialog's focused Box.
 *
 * `'Viewing agent'` / `'Viewing teammate'` / `'Viewing leader'` are never
 * rendered — they are handed to the `onDone` prop — so assertions read `done`
 * plus the resulting AppState, never the frame text.
 *
 * `AppStateProvider` builds its store ONCE from `initialState`, so reassigning
 * the mirrored `state` cannot move a task that is already mounted. `StateProbe`
 * — a null-rendering child inside the provider — hands the store's real setter
 * back out, which is what `setAppState`/`updateTask` drive a status transition
 * with. It is a harness-only addition: the dialog under test is untouched.
 */
async function mountDialog(tasks: TaskState[], overrides?: Partial<AppState>) {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const done: DoneCall[] = []
  let state = stateWith(tasks, overrides)
  let mountedSetAppState: ((updater: (prev: AppState) => AppState) => void) | null =
    null

  // Renders nothing; its only job is to capture the provider's setter. Declared
  // per mount so two dialogs mounted in the same file never share one.
  function StateProbe(): null {
    mountedSetAppState = useSetAppState()
    return null
  }

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider
      initialState={state}
      onChangeAppState={({ newState }) => {
        state = newState
      }}
    >
      <StateProbe />
      <KeybindingSetup>
        <BackgroundTasksDialog
          onDone={(result, options) => {
            done.push({ result, display: options?.display })
          }}
          toolUseContext={{} as ToolUseContext}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  async function waitForFrame(
    predicate: (frame: string) => boolean,
  ): Promise<string> {
    const startedAt = Date.now()
    let frame = ''
    while (Date.now() - startedAt < 2500) {
      frame = extractLastFrame(output)
      if (predicate(frame)) return frame
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for background tasks dialog:\n${frame}`)
  }

  async function waitForDone(): Promise<DoneCall> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2500) {
      if (done.length > 0) return done[0]!
      await Bun.sleep(10)
    }
    throw new Error(
      `Timed out waiting for onDone; last frame:\n${extractLastFrame(output)}`,
    )
  }

  function setAppState(updater: (prev: AppState) => AppState): void {
    if (!mountedSetAppState) {
      throw new Error('StateProbe has not mounted yet; nothing to update')
    }
    mountedSetAppState(updater)
  }

  // Patch one already-mounted task. Spreading a union member with a partial of
  // the same union is not something TS can check structurally, so the merge is
  // asserted — each call site below patches fields the task type it names
  // really declares.
  function updateTask(id: string, patch: Partial<TaskState>): void {
    setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [id]: { ...prev.tasks[id], ...patch } as TaskState,
      },
    }))
  }

  return {
    stdin,
    done,
    waitForFrame,
    waitForDone,
    getState: () => state,
    setAppState,
    updateTask,
    async cleanup() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

// The dialog skips the list and opens the detail view on mount when exactly one
// selectable task exists, so every fixture below mounts at least two rows.
// Row order follows `allSelectableItems`:
// [leader, ...teammates, ...bash, ...monitorMcp, ...remote, ...agent, ...].

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/tasks/BackgroundTasksDialog.test.tsx',
  )
})

afterEach(() => {
  releaseSharedMutationLock()
})

describe('BackgroundTasksDialog agent view entry', () => {
  test('Enter on a local_agent row enters the agent view instead of the detail dialog', async () => {
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // bash sorts before agent, so step down onto the agent row first.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
      // enterTeammateView holds a local_agent so it cannot be evicted.
      const task = state.tasks['agent-1'] as LocalAgentTaskState
      expect(task.retain).toBe(true)
      expect(task.evictAfter).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on the leader row exits the agent view', async () => {
    // The synthetic '__leader__' row only exists when a teammate is present,
    // and it is always index 0.
    const dialog = await mountDialog(
      [teammateTask('teammate-1'), agentTask('agent-1')],
      { viewingAgentTaskId: 'agent-1', viewSelectionMode: 'viewing-agent' },
    )
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing leader', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on an in_process_teammate row enters the teammate view', async () => {
    const dialog = await mountDialog([
      teammateTask('teammate-1'),
      agentTask('agent-1'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // Index 0 is the leader row; index 1 is the teammate.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      // The row names its own type, so the same teammate reads the same way
      // whether the list or its detail pane opened the view.
      expect(call).toEqual({ result: 'Viewing teammate', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('teammate-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f on an in_process_teammate row enters the teammate view', async () => {
    // The list's second route through the same viewability choke point —
    // without this only the Enter site would pin the type-specific wording.
    const dialog = await mountDialog([
      teammateTask('teammate-1'),
      agentTask('agent-1'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // Index 0 is the leader row; index 1 is the teammate.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write('f')

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing teammate', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('teammate-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on a local_bash row still opens the shell detail dialog', async () => {
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // Index 0 is the bash row — no navigation needed.
      dialog.stdin.write(ENTER)

      await dialog.waitForFrame(f => f.includes('Shell details'))
      expect(dialog.done).toEqual([])

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f on a running local_agent row enters the agent view', async () => {
    // Regression guard: before the agent-view change, `f` on a local_agent did
    // nothing at all — only a running in_process_teammate was handled.
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write('f')

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f in the local_agent detail dialog enters the agent view', async () => {
    // A single selectable task makes the dialog skip the list and mount
    // AsyncAgentDetailDialog directly, which is the only route to its new
    // onForeground prop.
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      dialog.stdin.write('f')

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f on a local_bash row does not enter the agent view', async () => {
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write('f')
      await Bun.sleep(150)

      expect(dialog.done).toEqual([])
      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a completed local_agent retained by the UI is listed and Enter opens its view', async () => {
    const dialog = await mountDialog([
      completedAgentTask('agent-done', { retain: true }),
      bashTask('bash-1'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('task agent-done'))
      // bash is index 0; the completed agent row follows it.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-done')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f on a completed local_agent row opens its view the same way Enter does', async () => {
    const dialog = await mountDialog([
      completedAgentTask('agent-done', { retain: true }),
      bashTask('bash-1'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('task agent-done'))
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write('f')

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-done')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a completed local_agent still inside its eviction grace window is listed', async () => {
    // Second visibility clause: not retained, but evictAfter is far enough in
    // the future that the predicate cannot flip mid-test.
    const dialog = await mountDialog([
      completedAgentTask('agent-grace', {
        retain: false,
        evictAfter: Date.now() + 600_000,
      }),
      bashTask('bash-1'),
    ])
    try {
      const frame = await dialog.waitForFrame(f => f.includes('task agent-grace'))
      // Completed rows render through TaskStatusText as "(done, unread)".
      expect(frame).toContain('done')
      expect(dialog.done).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('an evicted local_agent (evictAfter === 0) is not listed', async () => {
    const dialog = await mountDialog([
      completedAgentTask('agent-evicted', { retain: false, evictAfter: 0 }),
      agentTask('agent-1'),
      bashTask('bash-1'),
    ])
    try {
      const frame = await dialog.waitForFrame(f => f.includes('task agent-1'))
      expect(frame).not.toContain('task agent-evicted')
    } finally {
      await dialog.cleanup()
    }
  })
})

// C3: the upstream opt-out. `isViewableAgent` is the single choke point, so
// setting the variable has to take Enter, `f`, and the footer hint out
// together. Every case here pairs with an unset-variable control so the
// assertions cannot pass vacuously.
describe('BackgroundTasksDialog with CLAUDE_CODE_DISABLE_AGENT_VIEW', () => {
  const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'
  // Captured per test, inside the file-level shared mutation lock: the gate
  // reads process.env on every keypress, and a developer running with the
  // variable exported must not get a false pass on the control cases.
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_VAR]
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = originalValue
    }
  })

  test('Enter on a local_agent row opens the detail dialog instead of the view', async () => {
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // bash sorts before agent, so step down onto the agent row first.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      // Falls into the existing `else` branch: setViewState({ mode: 'detail' }).
      await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      expect(dialog.done).toEqual([])

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on an in_process_teammate row opens the detail dialog instead of the view', async () => {
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([
      teammateTask('teammate-1'),
      agentTask('agent-1'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // Index 0 is the leader row; index 1 is the teammate.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      await dialog.waitForFrame(f => !f.includes('Background tasks'))
      expect(dialog.done).toEqual([])

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f on a local_agent row does not enter the agent view', async () => {
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write('f')
      await Bun.sleep(150)

      // `f` no longer matches, so it falls through without preventDefault and
      // the dialog stays in list mode.
      expect(dialog.done).toEqual([])
      const frame = await dialog.waitForFrame(f =>
        f.includes('Background tasks'),
      )
      expect(frame).toContain('task agent-1')

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('the "f · foreground" footer hint is hidden on an agent row', async () => {
    process.env[ENV_VAR] = '1'
    // Two agent rows: index 0 is already viewable-shaped, so no navigation is
    // needed before reading the footer.
    const dialog = await mountDialog([agentTask('agent-1'), agentTask('agent-2')])
    try {
      const frame = await dialog.waitForFrame(f =>
        f.includes('Background tasks'),
      )
      // KeyboardShortcutHint renders "<shortcut> to <action>".
      expect(frame).not.toContain('f to foreground')
      // Enter · view is unconditional and must survive.
      expect(frame).toContain('Enter to view')
    } finally {
      await dialog.cleanup()
    }
  })

  test('without the variable the "f · foreground" footer hint is shown', async () => {
    expect(process.env[ENV_VAR]).toBeUndefined()
    const dialog = await mountDialog([agentTask('agent-1'), agentTask('agent-2')])
    try {
      const frame = await dialog.waitForFrame(f =>
        f.includes('Background tasks'),
      )
      expect(frame).toContain('f to foreground')
      expect(frame).toContain('Enter to view')
    } finally {
      await dialog.cleanup()
    }
  })

  test('without the variable Enter on a local_agent row still enters the view', async () => {
    expect(process.env[ENV_VAR]).toBeUndefined()
    const dialog = await mountDialog([agentTask('agent-1'), bashTask('bash-1')])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('the leader row is unaffected by the opt-out', async () => {
    // The gate covers the live agent view only; leaving the view must keep
    // working so an opted-out session is never stranded inside one.
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog(
      [teammateTask('teammate-1'), agentTask('agent-1')],
      { viewingAgentTaskId: 'agent-1', viewSelectionMode: 'viewing-agent' },
    )
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing leader', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('f in the local_agent detail dialog does not enter the view', async () => {
    // Regression guard for the two-keystroke bypass: gating only the list-mode
    // choke point left Enter → detail → `f` reaching the view, because the
    // detail dialog's onForeground prop was passed unconditionally. Before the
    // fix this produced done = ['Viewing agent'] and viewingAgentTaskId =
    // 'agent-1'; the assertions below are the exact inverse.
    process.env[ENV_VAR] = '1'
    // A single selectable task makes the dialog skip the list and mount
    // AsyncAgentDetailDialog directly.
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      // The detail dialog keys both its `f` handler and its hint on
      // onForeground, so withholding the prop removes them together.
      expect(frame).not.toContain('f to foreground')

      dialog.stdin.write('f')
      await Bun.sleep(150)

      expect(dialog.done).toEqual([])
      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
      // enterTeammateView would have flipped retain on the task.
      const task = state.tasks['agent-1'] as LocalAgentTaskState
      expect(task.retain).toBe(false)
    } finally {
      await dialog.cleanup()
    }
  })

  test('rows stay listed when the view is disabled', async () => {
    // isListedTask is deliberately NOT gated: a completed-but-kept agent still
    // shows up, it just opens the detail dialog now.
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([
      completedAgentTask('agent-done', { retain: true }),
      bashTask('bash-1'),
    ])
    try {
      const frame = await dialog.waitForFrame(f =>
        f.includes('Background tasks'),
      )
      expect(frame).toContain('task agent-done')
      // Bash rows render their command, not the description.
      expect(frame).toContain('echo bash-1')
    } finally {
      await dialog.cleanup()
    }
  })
})

// U3a: the single-task auto-skip path. With exactly one selectable task the
// dialog never renders the list — it mounts the detail pane directly
// (`allItems.length === 1` → `{ mode: 'detail' }`), which is the common shape
// for a lone background agent. Enter there used to close the dialog, out of
// step with the list; these tests pin the integration end of the fix, and the
// env gate is only real here because the parent owns the `onForeground` prop.
describe('BackgroundTasksDialog single-task auto-skip', () => {
  const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'
  // Captured per test inside the file-level shared mutation lock, so a
  // developer running with the variable exported cannot get a false pass.
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_VAR]
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = originalValue
    }
  })

  test('Enter in the auto-skipped local_agent detail pane enters the agent view', async () => {
    expect(process.env[ENV_VAR]).toBeUndefined()
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      // No list frame at all — straight into AsyncAgentDetailDialog.
      const frame = await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      // The byline has to advertise the route it now offers.
      expect(frame).toContain('Enter/f to view agent')
      expect(frame).not.toContain('Esc/Enter/Space to close')

      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
      // enterTeammateView holds a local_agent so it cannot be evicted.
      const task = state.tasks['agent-1'] as LocalAgentTaskState
      expect(task.retain).toBe(true)
      expect(task.evictAfter).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter in the auto-skipped pane closes when the agent view is disabled', async () => {
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      // Withholding onForeground restores the original byline verbatim.
      expect(frame).toContain('Esc/Enter/Space to close')
      expect(frame).not.toContain('view agent')

      dialog.stdin.write(ENTER)

      // AsyncAgentDetailDialog closes by calling onDone with no arguments.
      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: undefined, display: undefined })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
      // enterTeammateView would have flipped retain on the task.
      const task = state.tasks['agent-1'] as LocalAgentTaskState
      expect(task.retain).toBe(false)
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter in the auto-skipped in_process_teammate detail pane enters the agent view', async () => {
    // A lone teammate auto-skips too: getSelectableBackgroundTasks does not add
    // the synthetic leader row, so one teammate really is one selectable item.
    // isViewableAgent already treats it like a local_agent in the list; this is
    // the detail pane catching up.
    expect(process.env[ENV_VAR]).toBeUndefined()
    const dialog = await mountDialog([teammateTask('teammate-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('@teammate-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Enter/f to view teammate')
      expect(frame).not.toContain('Esc/Enter/Space to close')

      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing teammate', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('teammate-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter in the auto-skipped pane of a pending teammate enters the agent view', async () => {
    // The teammate case gates on the env opt-out alone, so a teammate that
    // has not started yet reaches the view by the same route a running one
    // does. isBackgroundTask lists a pending task, so a lone pending teammate
    // is still exactly one selectable item and still auto-skips into the pane;
    // withholding onForeground here would advertise nothing and close on Enter.
    expect(process.env[ENV_VAR]).toBeUndefined()
    const dialog = await mountDialog([teammateTask('teammate-1', 'pending')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('@teammate-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Enter/f to view teammate')
      expect(frame).not.toContain('Esc/Enter/Space to close')

      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing teammate', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('teammate-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter in the auto-skipped teammate pane closes when the agent view is disabled', async () => {
    // The gate this unit added to the teammate case: without it the pane still
    // handed out onForeground under the env var, opening a view the list
    // (isViewableAgent) refuses to open.
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([teammateTask('teammate-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('@teammate-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Esc/Enter/Space to close')
      expect(frame).not.toContain('view teammate')

      dialog.stdin.write(ENTER)

      // The detail dialog closes by calling onDone with no arguments.
      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: undefined, display: undefined })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter in an auto-skipped non-agent detail pane is unchanged', async () => {
    // A lone local_bash skips into ShellDetailDialog, which owns its own
    // confirm:yes handler — the agent-view change must not reach it.
    const dialog = await mountDialog([bashTask('bash-1')])
    try {
      await dialog.waitForFrame(
        f => f.includes('Shell details') && !f.includes('Background tasks'),
      )
      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({
        result: 'Shell details dismissed',
        display: 'system',
      })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })
})

// The auto-close effect is the only thing that reacts to a task CHANGING
// status underneath an open detail pane, and where it lands depends on the
// task type and on whether the list was auto-skipped on mount. Every case
// below mounts a task in one status and reads the pane in another, which is
// what the harness probe exists for.
describe('BackgroundTasksDialog detail pane across a status transition', () => {
  const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'
  // Captured per test inside the file-level shared mutation lock, so a
  // developer running with the variable exported cannot get a false pass.
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_VAR]
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = originalValue
    }
  })

  test('a teammate that completes under its auto-skipped pane closes the dialog', async () => {
    const dialog = await mountDialog([teammateTask('teammate-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('@teammate-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Enter/f to view teammate')

      // A teammate has no retention, so any terminal status unlists it — and
      // the auto-skipped pane has no list to fall back to.
      dialog.updateTask('teammate-1', { status: 'completed' })

      const call = await dialog.waitForDone()
      expect(call).toEqual({
        result: 'Background tasks dialog dismissed',
        display: 'system',
      })
      // Closing is not entering: the view must not be opened on the way out.
      expect(dialog.done.map(c => c.result)).not.toContain('Viewing teammate')

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a teammate killed under its auto-skipped pane closes the dialog', async () => {
    const dialog = await mountDialog([teammateTask('teammate-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('@teammate-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Enter/f to view teammate')

      dialog.updateTask('teammate-1', { status: 'killed' })

      const call = await dialog.waitForDone()
      expect(call).toEqual({
        result: 'Background tasks dialog dismissed',
        display: 'system',
      })
      expect(dialog.done.map(c => c.result)).not.toContain('Viewing teammate')

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a local_agent retained as it completes keeps its pane and Enter still enters the view', async () => {
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      const openFrame = await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      expect(openFrame).toContain('Enter/f to view agent')

      // retain: true is the first clause of isPanelVisibleAgent, so the row
      // survives the terminal status and the open pane survives with it.
      dialog.updateTask('agent-1', { status: 'completed', retain: true })

      const completedFrame = await dialog.waitForFrame(f =>
        f.includes('Completed'),
      )
      expect(completedFrame).toContain('Enter/f to view agent')
      expect(completedFrame).not.toContain('Background tasks')
      expect(dialog.done).toEqual([])

      dialog.stdin.write(ENTER)

      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBe('agent-1')
      expect(state.viewSelectionMode).toBe('viewing-agent')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a local_agent evicted as it completes closes the dialog', async () => {
    const dialog = await mountDialog([agentTask('agent-1')])
    try {
      const frame = await dialog.waitForFrame(
        f => f.includes('task agent-1') && !f.includes('Background tasks'),
      )
      expect(frame).toContain('Enter/f to view agent')

      // Neither clause of isPanelVisibleAgent holds: evictAfter === 0 is the
      // dismissal short-circuit, so the row goes and the pane goes with it.
      dialog.updateTask('agent-1', {
        status: 'completed',
        retain: false,
        evictAfter: 0,
      })

      const call = await dialog.waitForDone()
      expect(call).toEqual({
        result: 'Background tasks dialog dismissed',
        display: 'system',
      })
      expect(dialog.done.map(c => c.result)).not.toContain('Viewing agent')

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a teammate that completes under a pane opened from the list returns to the list', async () => {
    // The opt-out is what sends Enter to the detail pane instead of the live
    // view, which is the only route to a pane the list still stands behind.
    process.env[ENV_VAR] = '1'
    const dialog = await mountDialog([
      teammateTask('teammate-1'),
      teammateTask('teammate-2'),
    ])
    try {
      await dialog.waitForFrame(f => f.includes('Background tasks'))
      // Index 0 is the leader row, 1 is teammate-1, 2 is teammate-2.
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      dialog.stdin.write(ENTER)

      await dialog.waitForFrame(
        f => f.includes('@teammate-2') && !f.includes('Background tasks'),
      )

      dialog.updateTask('teammate-2', { status: 'completed' })

      // Three rows means the list was never auto-skipped, so the effect falls
      // to the list branch instead of dismissing the dialog.
      const listFrame = await dialog.waitForFrame(f =>
        f.includes('Background tasks'),
      )
      expect(listFrame).toContain('@teammate-1')
      expect(listFrame).not.toContain('@teammate-2')
      expect(dialog.done).toEqual([])

      const state = dialog.getState()
      expect(state.viewingAgentTaskId).toBeUndefined()
      expect(state.viewSelectionMode).toBe('none')
    } finally {
      await dialog.cleanup()
    }
  })
})

// REPRODUCTION SUITE — "Down arrow does not always register after switching
// windows". Every existing test in this file paces DOWN keystrokes with a
// 50ms sleep; these cases deliberately do NOT, and add the byte shapes a
// terminal multiplexer or a busy event loop can hand the dialog: several
// keys in one stdin read, focus reports glued to the key, and a DOWN whose
// escape sequence is split across two reads.
describe('BackgroundTasksDialog DOWN delivery under real stdin batching', () => {
  const FOCUS_IN = '\x1B[I'
  const FOCUS_OUT = '\x1B[O'
  const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_VAR]
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = originalValue
    }
  })

  // Three running agents list as agent-1, agent-2, agent-3 with agent-1
  // selected; Enter on an agent row reports which one was entered.
  async function mountThreeAgents() {
    const dialog = await mountDialog([
      agentTask('agent-1'),
      agentTask('agent-2'),
      agentTask('agent-3'),
    ])
    const frame = await dialog.waitForFrame(f => f.includes('Background tasks'))
    expect(frame).toContain('agent-1')
    expect(frame).toContain('agent-2')
    expect(frame).toContain('agent-3')
    return dialog
  }

  async function enteredAgent(
    dialog: Awaited<ReturnType<typeof mountDialog>>,
  ): Promise<string | undefined> {
    dialog.stdin.write(ENTER)
    const call = await dialog.waitForDone()
    expect(call).toEqual({ result: 'Viewing agent', display: 'system' })
    return dialog.getState().viewingAgentTaskId
  }

  test('two DOWNs in ONE stdin chunk move the selection two rows', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(DOWN + DOWN)
      await Bun.sleep(50)
      expect(await enteredAgent(dialog)).toBe('agent-3')
    } finally {
      await dialog.cleanup()
    }
  })

  test('two DOWN writes back-to-back with no pacing move the selection two rows', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(DOWN)
      dialog.stdin.write(DOWN)
      await Bun.sleep(50)
      expect(await enteredAgent(dialog)).toBe('agent-3')
    } finally {
      await dialog.cleanup()
    }
  })

  test('DOWN, DOWN and Enter typed ahead in one chunk enter the third row', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(DOWN + DOWN + ENTER)
      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })
      expect(dialog.getState().viewingAgentTaskId).toBe('agent-3')
    } finally {
      await dialog.cleanup()
    }
  })

  test('DOWN and Enter in ONE stdin chunk enter the second row (minimal typeahead repro)', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(DOWN + ENTER)
      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })
      expect(dialog.getState().viewingAgentTaskId).toBe('agent-2')
    } finally {
      await dialog.cleanup()
    }
  })

  test('DOWN then Enter as two immediate writes (same readable event) enter the second row', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(DOWN)
      dialog.stdin.write(ENTER)
      const call = await dialog.waitForDone()
      expect(call).toEqual({ result: 'Viewing agent', display: 'system' })
      expect(dialog.getState().viewingAgentTaskId).toBe('agent-2')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a focus-in report glued to DOWN in one chunk still moves the selection', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(FOCUS_IN + DOWN)
      await Bun.sleep(50)
      expect(await enteredAgent(dialog)).toBe('agent-2')
    } finally {
      await dialog.cleanup()
    }
  })

  test('focus-out, then focus-in glued to DOWN (window switch and back) moves the selection', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write(FOCUS_OUT)
      await Bun.sleep(30)
      dialog.stdin.write(FOCUS_IN + DOWN)
      await Bun.sleep(50)
      expect(await enteredAgent(dialog)).toBe('agent-2')
    } finally {
      await dialog.cleanup()
    }
  })

  test('DOWN split as ESC then "[B" in two immediate writes moves the selection', async () => {
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write('\x1B')
      dialog.stdin.write('[B')
      await Bun.sleep(50)
      expect(await enteredAgent(dialog)).toBe('agent-2')
    } finally {
      await dialog.cleanup()
    }
  })

  test('DOWN split as ESC then "[B" with a 350ms gap dismisses on the flushed Escape and delivers the tail as a real DOWN', async () => {
    // RULING on the orphaned cursor tail (parse-keypress.ts, cursor-tail
    // branch). Once the gap exceeds App's 300ms NORMAL_TIMEOUT the ESC is
    // flushed as a lone Escape and DISPATCHED — cancelling the dialog —
    // before the "[B" tail is even read. The parser cannot un-send an Escape
    // that a previous call already emitted, so dismissal here is a residual
    // that no parser-level fix can remove; asserting 'agent-2' would be
    // asserting something the architecture cannot deliver.
    //
    // What IS fixable is the tail: it must arrive as a real 'down' key
    // instead of leaking a nameless '' key into the prompt. The dialog is
    // already unmounted by the time the tail lands, so that half cannot be
    // observed here — it is pinned at the parser level instead, in
    // parse-keypress.downKeyDelivery.test.ts ('DOWN split around a flush'
    // and 'no orphaned cursor tail after a flush is ever a nameless key').
    const dialog = await mountThreeAgents()
    try {
      dialog.stdin.write('\x1B')
      await Bun.sleep(350)
      dialog.stdin.write('[B')
      await Bun.sleep(50)
      const call = await dialog.waitForDone()
      expect(call).toEqual({
        result: 'Background tasks dialog dismissed',
        display: 'system',
      })
    } finally {
      await dialog.cleanup()
    }
  })
})
