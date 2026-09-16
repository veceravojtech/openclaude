/**
 * Level: component-integration. The footer's ←/→ teammate cycle, mounted as the
 * REAL PromptInput with the repo's Ink harness (the style
 * promptPlaceholderAgentName.test.tsx already uses).
 *
 * What is asserted is what Enter OPENS, not a rendered highlight: that reads the
 * stored selection back through the same path the user takes, so it fails if the
 * cycle, the survivor effect or the derived `teammateFooterIndex` prop is
 * mis-wired — not only if a pure helper regresses.
 *
 * The defect: `teammateFooterIndex` was a POSITION with no clamp at all, so
 * after the list shrank it either pointed at a different teammate or at nothing.
 */
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useAppState,
  useSetAppState,
} from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings } from '../../keybindings/parser.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import PromptInput, { footerSurvivor } from './PromptInput.js'

// The auto-updater reaches for a build-time macro that does not exist under the
// test runner; the same stub promptPlaceholderAgentName.test.tsx uses.
const actualAutoUpdaterWrapper = await import(
  `../AutoUpdaterWrapper.js?actual=${Date.now()}-${Math.random()}`
)
// PromptInput's ←/→/Enter go through useKeybinding, which is inert without a
// KeybindingProvider — so the real KeybindingSetup is mounted here. Its user
// config comes off disk, which a test must not depend on, so the loader is
// pinned to the shipped default table (the one that maps right → footer:next).
const actualUserBindings = await import(
  `../../keybindings/loadUserBindings.js?actual=${Date.now()}-${Math.random()}`
)

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ENTER = '\r'

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/PromptInput/teammateFooterSelection.test.tsx',
  )
  mock.module('../AutoUpdaterWrapper.js', () => ({
    AutoUpdaterWrapper: () => null,
  }))
  mock.module('../../keybindings/loadUserBindings.js', () => ({
    ...actualUserBindings,
    loadKeybindingsSyncWithWarnings: () => ({
      bindings: parseBindings(DEFAULT_BINDINGS),
      warnings: [],
    }),
    initializeKeybindingWatcher: () => {},
    subscribeToKeybindingChanges: () => () => {},
  }))
})

afterEach(() => {
  try {
    mock.module('../AutoUpdaterWrapper.js', () => ({ ...actualAutoUpdaterWrapper }))
    mock.module('../../keybindings/loadUserBindings.js', () => ({ ...actualUserBindings }))
  } finally {
    releaseSharedMutationLock()
  }
})

// PromptInput's ~35 props are irrelevant here; only app state and keys drive
// the footer. One cast beats 35 fixtures that drift with every unrelated prop.
const PROMPT_INPUT_PROPS = {
  debug: false,
  ideSelection: undefined,
  toolPermissionContext: {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
  },
  setToolPermissionContext: () => {},
  apiKeyStatus: 'valid',
  commands: [],
  agents: [],
  isLoading: false,
  verbose: false,
  messages: [],
  onAutoUpdaterResult: () => {},
  autoUpdaterResult: null,
  input: '',
  onInputChange: () => {},
  mode: 'prompt',
  onModeChange: () => {},
  stashedPrompt: undefined,
  setStashedPrompt: () => {},
  submitCount: 0,
  onShowMessageSelector: () => {},
  mcpClients: [],
  pastedContents: {},
  setPastedContents: () => {},
  vimMode: 'INSERT',
  setVimMode: () => {},
  showBashesDialog: false,
  setShowBashesDialog: () => {},
  onExit: () => {},
  getToolUseContext: () => ({}),
  onSubmit: async () => {},
  isSearchingHistory: false,
  setIsSearchingHistory: () => {},
  helpOpen: false,
  setHelpOpen: () => {},
} as unknown as React.ComponentProps<typeof PromptInput>

function teammate(
  name: string,
  teamName = 'email',
  overrides: Record<string, unknown> = {},
): AppState['tasks'][string] {
  return {
    id: `task-${teamName}-${name}`,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: working`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${name}.log`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: formatAgentId(name, teamName),
      agentName: name,
      teamName,
      color: 'cyan',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: `prompt of ${name}`,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  } as unknown as AppState['tasks'][string]
}

/** The depth-first order the footer cycles: alice, supervisor, worker-1, zoe. */
const ALICE = teammate('alice')
const SUPERVISOR = teammate('supervisor')
const WORKER_1 = teammate('worker-1', 'email/supervisor')
const ZOE = teammate('zoe')
const TEAM = [ALICE, SUPERVISOR, WORKER_1, ZOE]

function Probe({
  onReady,
}: {
  onReady: (probe: {
    viewing: () => string | undefined
    setTeammates: (tasks: AppState['tasks'][string][]) => void
  }) => void
}): React.ReactNode {
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()
  const viewingRef = React.useRef(viewingAgentTaskId)
  viewingRef.current = viewingAgentTaskId
  React.useEffect(() => {
    onReady({
      viewing: () => viewingRef.current,
      setTeammates: tasks =>
        setAppState(prev => ({
          ...prev,
          tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
        })),
    })
  }, [onReady, setAppState])
  return null
}

/**
 * `strict` mounts the whole tree inside React.StrictMode, which is what makes a
 * useState updater run TWICE for a single set call — verified in this renderer,
 * under this React (19) and this NODE_ENV. That is the only way to drive the
 * footer's survivor effect through the double invocation from the outside.
 */
async function mountFooter(
  tasks: AppState['tasks'][string][],
  { strict = false }: { strict?: boolean } = {},
): Promise<{
  press: (sequence: string) => Promise<void>
  viewing: () => string | undefined
  setTeammates: (tasks: AppState['tasks'][string][]) => Promise<void>
  cleanup: () => Promise<void>
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  // PromptInput binds keyboard input, so stdin has to look like a raw TTY.
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 160
  // Draining stdout keeps the PassThrough from stalling once ink starts writing
  // frames; nothing here asserts on the frame itself.
  stdout.resume()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let probe:
    | {
        viewing: () => string | undefined
        setTeammates: (tasks: AppState['tasks'][string][]) => void
      }
    | undefined
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
  }
  const tree = (
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
        // The tasks footer item is the one being navigated, which is what
        // puts ←/→ on the teammate cycle instead of on the footer items.
        footerSelection: 'tasks',
      }}
    >
      <KeybindingSetup>
        <PromptInput {...PROMPT_INPUT_PROPS} />
      </KeybindingSetup>
      <Probe
        onReady={value => {
          probe = value
        }}
      />
    </AppStateProvider>
  )
  try {
    root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
    for (let attempt = 0; attempt < 100 && !probe; attempt++) {
      await Bun.sleep(10)
    }
    expect(probe).toBeDefined()
    return {
      async press(sequence) {
        stdin.write(sequence)
        await Bun.sleep(60)
      },
      viewing: () => probe!.viewing(),
      async setTeammates(next) {
        probe!.setTeammates(next)
        await Bun.sleep(60)
      },
      cleanup: teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

test('→ cycles the pills in tree order and Enter opens the one it landed on', async () => {
  const mounted = await mountFooter(TEAM)
  try {
    // Pill 0 is the leader's own `main`, so three steps land on worker-1.
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBe(WORKER_1.id)
  } finally {
    await mounted.cleanup()
  }
})

test('← wraps onto the last teammate of the same order', async () => {
  const mounted = await mountFooter(TEAM)
  try {
    await mounted.press(LEFT)
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBe(ZOE.id)
  } finally {
    await mounted.cleanup()
  }
})

test('the selection follows its teammate when a pill is inserted above it', async () => {
  const mounted = await mountFooter(TEAM)
  try {
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    // Two steps is `supervisor`. `aaron` sorts first, so every pill shifts one
    // to the right — a positional index would now open `alice` instead.
    await mounted.setTeammates([teammate('aaron'), ...TEAM])
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBe(SUPERVISOR.id)
  } finally {
    await mounted.cleanup()
  }
})

test('after a shrink the selection lands on the nearest survivor, not on a dangling pill', async () => {
  const mounted = await mountFooter(TEAM)
  try {
    // Four steps is `zoe`, the last pill.
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    // zoe leaves. Her previous sibling in team `email` is `supervisor` — NOT
    // worker-1, which sits between them in depth-first order but belongs to the
    // sub-team. The footer had no clamp at all before this unit, so Enter here
    // opened nothing.
    await mounted.setTeammates(TEAM.filter(t => t.id !== ZOE.id))
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBe(SUPERVISOR.id)
  } finally {
    await mounted.cleanup()
  }
})

test('the shrink lands on the nearest survivor under StrictMode too', async () => {
  // The same journey as the case above, with the tree in StrictMode so React
  // runs the survivor updater TWICE for that one set call. The bookkeeping used
  // to live inside the updater: the second run found `prevOrder` already
  // advanced to the new order, so no row had departed, and a departed selection
  // fell to the LEADER — Enter here opened nothing instead of supervisor.
  const mounted = await mountFooter(TEAM, { strict: true })
  try {
    // Four steps is `zoe`, the last pill.
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.press(RIGHT)
    await mounted.setTeammates(TEAM.filter(t => t.id !== ZOE.id))
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBe(SUPERVISOR.id)
  } finally {
    await mounted.cleanup()
  }
})

test('Enter on the leader pill leaves the teammate view', async () => {
  const mounted = await mountFooter(TEAM)
  try {
    await mounted.press(RIGHT)
    await mounted.press(ENTER)
    expect(mounted.viewing()).toBe(ALICE.id)

    // One more step past the last teammate wraps back onto `main`.
    for (let step = 0; step < 4; step++) await mounted.press(RIGHT)
    await mounted.press(ENTER)

    expect(mounted.viewing()).toBeUndefined()
  } finally {
    await mounted.cleanup()
  }
})

/**
 * The survivor updater, run TWICE.
 *
 * Unlike the AppState store's updater — one synchronous invocation, documented
 * on the navigation hook — a useState updater may run more than once for a
 * single set call (StrictMode, or a render React throws away). The footer's used
 * to do its own bookkeeping inside itself: it read `prevTeammateOrderRef` and
 * advanced it in the same breath, so a second run read back
 * `prevOrder === inProcessTeammates`, found no departed row, and handed a
 * departed selection to the LEADER instead of to the nearest survivor. The ref
 * is now read and advanced in the effect body and only the captured order goes
 * in, which is what makes the updater a pure function of its argument.
 */
const ORDER = TEAM as unknown as InProcessTeammateTaskState[]
const WITHOUT_ZOE = ORDER.filter(t => t.id !== ZOE.id)
const ON_ZOE = { kind: 'teammate' as const, taskId: ZOE.id }

test('the survivor updater lands on the nearest survivor, once or twice', () => {
  const once = footerSurvivor(ON_ZOE, ORDER, WITHOUT_ZOE)
  // zoe's previous sibling in team `email` is supervisor — NOT worker-1, which
  // sits between them in depth-first order but belongs to the sub-team.
  expect(once).toEqual({ kind: 'teammate', taskId: SUPERVISOR.id })

  // React re-running the SAME closure: same argument, same captured orders.
  expect(footerSurvivor(ON_ZOE, ORDER, WITHOUT_ZOE)).toEqual(once)
  // …and applied to what it produced, which is the other shape a discarded
  // render can take. Landing on the leader here is exactly the old defect.
  expect(footerSurvivor(once, ORDER, WITHOUT_ZOE)).toBe(once)
})

test('a selection that survived is returned by identity, so useState short-circuits', () => {
  const onSupervisor = { kind: 'teammate' as const, taskId: SUPERVISOR.id }
  const next = footerSurvivor(onSupervisor, ORDER, WITHOUT_ZOE)
  expect(next).toBe(onSupervisor)
  expect(footerSurvivor(next, ORDER, WITHOUT_ZOE)).toBe(onSupervisor)
})

test('with every teammate gone it answers the leader, twice over', () => {
  const once = footerSurvivor(ON_ZOE, ORDER, [])
  expect(once).toEqual({ kind: 'leader' })
  expect(footerSurvivor(once, ORDER, [])).toEqual({ kind: 'leader' })
})

test('it never answers null, which the footer state cannot hold', () => {
  for (const selection of [
    ON_ZOE,
    { kind: 'leader' as const },
    { kind: 'teammate' as const, taskId: 'task-that-never-existed' },
  ]) {
    expect(footerSurvivor(selection, ORDER, WITHOUT_ZOE)).not.toBeNull()
  }
})
