/**
 * Level: component-integration. Every case below mounts the REAL
 * `PromptInput` with the repo's Ink harness (the mounted-root style already
 * used by `Notifications.effort.test.tsx`) and asserts on the rendered frame.
 * Nothing here re-implements the derivation, so these tests fail if the
 * wiring between `PromptInput`'s `placeholderAgentName` and
 * `usePromptInputPlaceholder` is broken, not just if a pure helper regresses.
 *
 * Covered:
 *  - the prompt placeholder while viewing a local agent (named / unnamed),
 *    an in-process teammate, and nothing at all;
 *  - CLAUDE_CODE_DISABLE_AGENT_VIEW gating the agent panel at its root — the
 *    real `useCoordinatorTaskCount` hook, and the panel it unmounts.
 */
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot, Text } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { AgentId } from '../../types/ids.js'
import { formatAgentId } from '../../utils/agentId.js'
import { useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js'
import { renderToString } from '../../utils/staticRender.js'
import PromptInput from './PromptInput.js'

const actualAutoUpdaterWrapper = await import(
  `../AutoUpdaterWrapper.js?actual=${Date.now()}-${Math.random()}`
)

const AGENT_VIEW_ENV_KEY = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'
let savedAgentViewEnv: string | undefined

// DEC synchronized update markers, same framing Ink emits for every frame.
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

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
  return lastFrame ?? output
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  // PromptInput binds keyboard input, so stdin has to look like a raw-capable TTY.
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

// PromptInput's ~35 props are irrelevant to what these tests assert; only app
// state drives the placeholder and the panel. One cast beats 35 hand-built
// fixtures that would drift with every unrelated prop change.
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

// agentNameRegistry is keyed name -> branded AgentId; brand the ids here so the
// fixtures stay assignable without an `unknown` cast at every call site.
function registry(entries: Array<[string, string]>): Map<string, AgentId> {
  return new Map(entries.map(([name, id]) => [name, id as unknown as AgentId]))
}

function localAgent(
  id: string,
  description: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    type: 'local_agent',
    agentType: 'general-purpose',
    status: 'running',
    description,
    prompt: '',
    startTime: Date.now(),
    retain: true,
    pendingMessages: [],
    ...overrides,
  } as unknown as AppState['tasks'][string]
}

/**
 * A complete teammate identity, as the type demands: the footer renders this
 * task through the pill row, which reads `teamName` (and, for a sub-team
 * member, `agentId`) to label and place the pill. A root team keeps the label
 * the bare `@name` these cases assert on.
 */
function teammate(id: string, agentName: string, teamName = 'crew') {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: 'teammate task',
    startTime: Date.now(),
    identity: {
      agentId: formatAgentId(agentName, teamName),
      agentName,
      teamName,
      color: 'cyan',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
  } as unknown as AppState['tasks'][string]
}

/** Renders nothing but the real hook's value, so the gate is read end-to-end. */
function CountProbe(): React.ReactNode {
  const count = useCoordinatorTaskCount()
  return <Text>count={count}</Text>
}

/**
 * Mounts PromptInput and returns the last rendered frame with ANSI stripped.
 * Waits for the frame to actually carry the prompt border so we never assert
 * against a half-committed first paint.
 */
async function renderPromptInput(
  state: Partial<AppState>,
  timeoutMs = 5000,
): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider initialState={{ ...getDefaultAppState(), ...state }}>
      <PromptInput {...PROMPT_INPUT_PROPS} />
    </AppStateProvider>,
  )
  try {
    const startedAt = Date.now()
    let frame = ''
    while (Date.now() - startedAt < timeoutMs) {
      frame = stripAnsi(extractLastFrame(getOutput()))
      if (frame.includes('─')) return frame
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for a prompt frame. Last frame:\n${frame}`)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/PromptInput/promptPlaceholderAgentName.test.tsx',
  )
  savedAgentViewEnv = process.env[AGENT_VIEW_ENV_KEY]
  delete process.env[AGENT_VIEW_ENV_KEY]
  mock.module('../AutoUpdaterWrapper.js', () => ({
    AutoUpdaterWrapper: () => null,
  }))
})

afterEach(() => {
  try {
    if (savedAgentViewEnv === undefined) {
      delete process.env[AGENT_VIEW_ENV_KEY]
    } else {
      process.env[AGENT_VIEW_ENV_KEY] = savedAgentViewEnv
    }
    mock.module('../AutoUpdaterWrapper.js', () => ({ ...actualAutoUpdaterWrapper }))
  } finally {
    releaseSharedMutationLock()
  }
})

describe('prompt placeholder while viewing an agent', () => {
  test('names a viewed local agent from agentNameRegistry', async () => {
    const frame = await renderPromptInput({
      tasks: { a1: localAgent('a1', 'Audit the retry ladder') },
      viewingAgentTaskId: 'a1',
      agentNameRegistry: registry([['scout', 'a1']]),
    } as Partial<AppState>)

    expect(frame).toContain('Message @scout…')
  })

  test('falls back to the description when the local agent has no registered name', async () => {
    const frame = await renderPromptInput({
      tasks: { a1: localAgent('a1', 'Audit retries') },
      viewingAgentTaskId: 'a1',
      agentNameRegistry: registry([]),
    } as Partial<AppState>)

    // The hook owns the '@'; the derivation must feed it a bare name.
    expect(frame).toContain('Message @Audit retries…')
  })

  test('keeps the in-process teammate placeholder unchanged', async () => {
    const frame = await renderPromptInput({
      tasks: { t1: teammate('t1', 'builder') },
      viewingAgentTaskId: 't1',
      agentNameRegistry: registry([]),
    } as Partial<AppState>)

    expect(frame).toContain('Message @builder…')
  })

  test('shows no agent placeholder when nothing is viewed', async () => {
    const frame = await renderPromptInput({
      tasks: { a1: localAgent('a1', 'Audit retries') },
      viewingAgentTaskId: undefined,
      agentNameRegistry: registry([['scout', 'a1']]),
    } as Partial<AppState>)

    expect(frame).not.toContain('Message @')
  })
})

describe('CLAUDE_CODE_DISABLE_AGENT_VIEW gates the agent panel', () => {
  const PANEL_STATE = {
    tasks: { a1: localAgent('a1', 'PANEL-ROW-MARKER') },
    viewingAgentTaskId: undefined,
    agentNameRegistry: registry([]),
  } as Partial<AppState>

  test('mounts CoordinatorTaskPanel when the opt-out is unset', async () => {
    const frame = await renderPromptInput(PANEL_STATE)

    expect(frame).toContain('PANEL-ROW-MARKER')
    expect(frame).toContain('main')
  })

  test('does not mount CoordinatorTaskPanel when the opt-out is set', async () => {
    process.env[AGENT_VIEW_ENV_KEY] = '1'

    const frame = await renderPromptInput(PANEL_STATE)

    expect(frame).not.toContain('PANEL-ROW-MARKER')
  })

  // The two below drive the REAL useCoordinatorTaskCount hook (no mirror), so
  // they pin the root gate itself rather than the mount guard that consumes it.
  // A bare hook binds no keyboard input, so renderToString is enough here.
  async function renderCount(): Promise<string> {
    return renderToString(
      <AppStateProvider
        initialState={
          { ...getDefaultAppState(), ...PANEL_STATE } as AppState
        }
      >
        <CountProbe />
      </AppStateProvider>,
      40,
    )
  }

  test('useCoordinatorTaskCount counts the running panel agent when the opt-out is unset', async () => {
    expect(await renderCount()).toContain('count=1')
  })

  test('useCoordinatorTaskCount returns 0 when the opt-out is set', async () => {
    process.env[AGENT_VIEW_ENV_KEY] = '1'

    expect(await renderCount()).toContain('count=0')
  })
})
