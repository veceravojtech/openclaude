import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { TaskState } from '../../tasks/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
const ENTER = '\r'
const SPACE = ' '
const LEFT = '\x1B[D'

// The two byline shapes this dialog can render. KeyboardShortcutHint prints
// "<shortcut> to <action>", so these are the literal strings in the frame.
const VIEW_HINT = 'Enter/f to view teammate'
const CLOSE_HINT_WITH_VIEW = 'Esc/Space to close'
const CLOSE_HINT_WITHOUT_VIEW = 'Esc/Enter/Space to close'
// Byline joins its children with ' · ', so this is the whole line a non-running
// teammate renders with the view reachable — no `x to stop`, kill stays
// running-only.
const NON_RUNNING_BYLINE = `\u2190 to go back \u00B7 ${VIEW_HINT} \u00B7 ${CLOSE_HINT_WITH_VIEW}`

function teammateTask(
  id: string,
  status: TaskState['status'] = 'running',
): InProcessTeammateTaskState {
  return {
    id,
    status,
    description: `task ${id}`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: false,
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

type Handlers = {
  onDone: string[]
  onKill: string[]
  onBack: string[]
  onForeground: string[]
}

/**
 * Mounts the detail dialog directly over a PassThrough stdin/stdout pair, which
 * is the only way to drive both of its key paths: Enter goes through
 * `useKeybindings` ('confirm:yes', hence the `KeybindingSetup` wrapper) while
 * Space / `←` / `x` / `f` go through the raw `onKeyDown` handler on the focused
 * Box. `BackgroundTasksDialog.test.tsx` covers the same routes through the
 * parent; this file pins the component's own contract, including the byline.
 *
 * `withForeground` is the switch the parent flips: `BackgroundTasksDialog`
 * withholds `onForeground` entirely under CLAUDE_CODE_DISABLE_AGENT_VIEW — the
 * env opt-out is its only gate — so "prop absent" IS the opt-out shape as far
 * as this component is concerned.
 */
async function mountDialog(
  teammate: InProcessTeammateTaskState,
  options?: { withForeground?: boolean; withBack?: boolean },
) {
  const withForeground = options?.withForeground ?? true
  const withBack = options?.withBack ?? true

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

  const calls: Handlers = {
    onDone: [],
    onKill: [],
    onBack: [],
    onForeground: [],
  }

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <KeybindingSetup>
        <InProcessTeammateDetailDialog
          teammate={teammate}
          onDone={() => calls.onDone.push('done')}
          onKill={() => calls.onKill.push('kill')}
          onBack={withBack ? () => calls.onBack.push('back') : undefined}
          onForeground={
            withForeground ? () => calls.onForeground.push('foreground') : undefined
          }
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
    throw new Error(`Timed out waiting for teammate detail dialog:\n${frame}`)
  }

  async function waitForCall(key: keyof Handlers): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2500) {
      if (calls[key].length > 0) return
      await Bun.sleep(10)
    }
    throw new Error(
      `Timed out waiting for ${key}; last frame:\n${extractLastFrame(output)}`,
    )
  }

  // The dialog is mounted once the title row ("@<agentName> (<activity>)") is
  // on screen — a teammate pane titles itself by identity, not description.
  await waitForFrame(f => f.includes(`@${teammate.identity.agentName}`))

  return {
    stdin,
    calls,
    waitForFrame,
    waitForCall,
    async cleanup() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/tasks/InProcessTeammateDetailDialog.test.tsx',
  )
})

afterEach(() => {
  releaseSharedMutationLock()
})

// The teammate half of the sibling agent pane's Enter ruling. isViewableAgent
// already treats in_process_teammate exactly like local_agent in the /tasks
// list, so with the live view reachable Enter must mean the same thing here
// that it means there, not "close".
describe('InProcessTeammateDetailDialog with the teammate view reachable', () => {
  test('the byline advertises the view and no longer claims Enter closes', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      const frame = await dialog.waitForFrame(f => f.includes(VIEW_HINT))
      expect(frame).toContain(VIEW_HINT)
      expect(frame).toContain(CLOSE_HINT_WITH_VIEW)
      // The regression this unit exists for: the old byline told the user Enter
      // closes, which is exactly what stopped being true.
      expect(frame).not.toContain(CLOSE_HINT_WITHOUT_VIEW)
      // "f to foreground" is folded into the combined Enter/f hint.
      expect(frame).not.toContain('f to foreground')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter opens the teammate view and does not close the dialog', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      dialog.stdin.write(ENTER)
      await dialog.waitForCall('onForeground')

      expect(dialog.calls.onForeground).toEqual(['foreground'])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('f still opens the teammate view', async () => {
    // The pre-existing route stays — the `t4` key handler was not touched.
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      dialog.stdin.write('f')
      await dialog.waitForCall('onForeground')

      expect(dialog.calls.onForeground).toEqual(['foreground'])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('Space still closes', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      dialog.stdin.write(SPACE)
      await dialog.waitForCall('onDone')

      expect(dialog.calls.onDone).toEqual(['done'])
      expect(dialog.calls.onForeground).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('x still stops a running teammate', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      const frame = await dialog.waitForFrame(f => f.includes('x to stop'))
      expect(frame).toContain('x to stop')

      dialog.stdin.write('x')
      await dialog.waitForCall('onKill')

      expect(dialog.calls.onKill).toEqual(['kill'])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('← still goes back', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'))
    try {
      const frame = await dialog.waitForFrame(f => f.includes('to go back'))
      expect(frame).toContain('to go back')

      dialog.stdin.write(LEFT)
      await dialog.waitForCall('onBack')

      expect(dialog.calls.onBack).toEqual(['back'])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })
})

// The opt-out shape. The parent withholds onForeground under
// CLAUDE_CODE_DISABLE_AGENT_VIEW, and with no view to open Enter must keep its
// original meaning. Every assertion here is the inverse of the block above, so
// neither block can pass vacuously.
describe('InProcessTeammateDetailDialog without a reachable teammate view', () => {
  test('the byline is byte-identical to the original close hint', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'), {
      withForeground: false,
    })
    try {
      const frame = await dialog.waitForFrame(f =>
        f.includes(CLOSE_HINT_WITHOUT_VIEW),
      )
      expect(frame).toContain(CLOSE_HINT_WITHOUT_VIEW)
      expect(frame).not.toContain(VIEW_HINT)
      expect(frame).not.toContain('view teammate')
      expect(frame).not.toContain('f to foreground')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter closes, exactly as it did before', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'), {
      withForeground: false,
    })
    try {
      dialog.stdin.write(ENTER)
      await dialog.waitForCall('onDone')

      expect(dialog.calls.onDone).toEqual(['done'])
      expect(dialog.calls.onForeground).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('f does nothing', async () => {
    const dialog = await mountDialog(teammateTask('teammate-1'), {
      withForeground: false,
    })
    try {
      dialog.stdin.write('f')
      await Bun.sleep(150)

      expect(dialog.calls.onForeground).toEqual([])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  test('Space still closes and x still stops', async () => {
    // The opt-out must not disturb the keys it has nothing to do with.
    const dialog = await mountDialog(teammateTask('teammate-1'), {
      withForeground: false,
    })
    try {
      dialog.stdin.write('x')
      await dialog.waitForCall('onKill')
      expect(dialog.calls.onKill).toEqual(['kill'])

      dialog.stdin.write(SPACE)
      await dialog.waitForCall('onDone')
      expect(dialog.calls.onDone).toEqual(['done'])
    } finally {
      await dialog.cleanup()
    }
  })
})

// A non-running teammate has no kill route in either byline shape.
describe('InProcessTeammateDetailDialog for a non-running teammate', () => {
  test('x is neither hinted nor handled', async () => {
    const dialog = await mountDialog(teammateTask('teammate-failed', 'failed'))
    try {
      const frame = await dialog.waitForFrame(f => f.includes(VIEW_HINT))
      expect(frame).not.toContain('x to stop')

      dialog.stdin.write('x')
      await Bun.sleep(150)

      expect(dialog.calls.onKill).toEqual([])
      expect(dialog.calls.onDone).toEqual([])
    } finally {
      await dialog.cleanup()
    }
  })

  // The pane is reachable at any status, so `f` follows `onForeground`
  // alone, exactly as the sibling agent pane does (AsyncAgentDetailDialog:85).
  // Enter and `f` are one route keyed on one prop: the byline cannot advertise
  // a key the handler refuses. The parent reaches these panes for real — the
  // list opens a pending teammate, and a running one can complete while its
  // pane is open — so this is a user path, not just a component contract.
  for (const status of ['pending', 'completed'] as const) {
    test(`${status}: the byline advertises Enter/f and offers no kill route`, async () => {
      const dialog = await mountDialog(teammateTask(`teammate-${status}`, status))
      try {
        const frame = await dialog.waitForFrame(f => f.includes(VIEW_HINT))
        expect(frame).toContain(NON_RUNNING_BYLINE)
        expect(frame).not.toContain('x to stop')
        expect(frame).not.toContain(CLOSE_HINT_WITHOUT_VIEW)
      } finally {
        await dialog.cleanup()
      }
    })

    test(`${status}: Enter opens the teammate view and does not close the dialog`, async () => {
      const dialog = await mountDialog(teammateTask(`teammate-${status}`, status))
      try {
        dialog.stdin.write(ENTER)
        await dialog.waitForCall('onForeground')

        expect(dialog.calls.onForeground).toEqual(['foreground'])
        expect(dialog.calls.onDone).toEqual([])
      } finally {
        await dialog.cleanup()
      }
    })

    test(`${status}: f opens the teammate view the byline advertises`, async () => {
      const dialog = await mountDialog(teammateTask(`teammate-${status}`, status))
      try {
        dialog.stdin.write('f')
        await dialog.waitForCall('onForeground')

        expect(dialog.calls.onForeground).toEqual(['foreground'])
        expect(dialog.calls.onDone).toEqual([])
      } finally {
        await dialog.cleanup()
      }
    })
  }
})
