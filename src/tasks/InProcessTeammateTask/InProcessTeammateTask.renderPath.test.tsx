import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'
import React, { useRef } from 'react'
import stripAnsi from 'strip-ansi'

import { Messages } from '../../components/Messages.js'
import { render } from '../../ink.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { loadKeybindingsSyncWithWarnings } from '../../keybindings/loadUserBindings.js'
import type { KeybindingContextName } from '../../keybindings/types.js'
import { AppStateProvider } from '../../state/AppState.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { appendCappedTeammateMessage } from './InProcessTeammateTask.js'

/**
 * Renders a teammate's task.messages mirror through the same <Messages>
 * component the teammate view uses, so every step between the mirror and the
 * screen — row building, tool_use/progress joins, the in-flight gate and the
 * tools' own progress renderers — is the real one.
 */

/** Keybinding context without the chord interceptor, as exportRenderer.tsx does. */
function StaticKeybindingProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const { bindings } = loadKeybindingsSyncWithWarnings()
  const pendingChordRef = useRef(null)
  const handlerRegistryRef = useRef(new Map())
  const activeContexts = useRef(new Set<KeybindingContextName>()).current
  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={activeContexts}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  )
}

/**
 * The props REPL.tsx passes when a teammate is viewed: the task's mirror and
 * its inProgressToolUseIDs. Returns the last frame as plain text.
 */
async function renderTeammateView(
  mirror: readonly Message[],
  inProgressToolUseIDs: Set<string>,
): Promise<string> {
  const stdout = new PassThrough()
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  // Ink defaults to 24 rows, where AgentTool/UI.tsx switches running
  // sub-agents to its condensed form and draws no trail.
  Object.assign(stdout, { columns: 120, rows: 200 })

  const instance = await render(
    <AppStateProvider>
      <StaticKeybindingProvider>
        <Messages
          messages={mirror as Message[]}
          tools={[BashTool, AgentTool]}
          commands={[]}
          verbose={false}
          toolJSX={null}
          toolUseConfirmQueue={[]}
          inProgressToolUseIDs={inProgressToolUseIDs}
          isMessageSelectorVisible={false}
          conversationId="teammate-view"
          screen="prompt"
          streamingToolUses={[]}
          showAllInTranscript={false}
          isLoading={true}
          hideLogo={true}
        />
      </StaticKeybindingProvider>
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )
  await new Promise(resolve => setTimeout(resolve, 120))
  instance.unmount()

  const frames = output
    .split('\x1B[?2026h')
    .map(frame => stripAnsi(frame.split('\x1B[?2026l')[0] ?? ''))
    .filter(frame => frame.trim() !== '')
  return frames.at(-1) ?? ''
}

const ROW_MARKERS = Array.from({ length: 13 }, (_, i) => `ROW-${i + 1} `)

/** 13 conversation rows, each carrying a unique marker. */
function conversationRows(): Message[] {
  return ROW_MARKERS.map((marker, i) =>
    i % 2 === 0
      ? createUserMessage({ content: `${marker}user asks` })
      : createAssistantMessage({ content: `${marker}assistant answers` }),
  )
}

function rowsOnScreen(frame: string): string[] {
  return ROW_MARKERS.filter(marker => frame.includes(marker))
}

function foldIntoMirror(messages: readonly Message[]): Message[] {
  let mirror: Message[] = []
  for (const message of messages) {
    mirror = appendCappedTeammateMessage(mirror, message)
  }
  return mirror
}

function bashUse(id: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Bash',
        input: { command: `sleep 120 # ${id}`, description: 'wait' },
      },
    ],
  })
}

function bashTick(parentToolUseID: string, second: number): Message {
  const output = `TICK-${parentToolUseID}-${second}`
  return createProgressMessage({
    toolUseID: `bash-progress-${second}`,
    parentToolUseID,
    data: {
      type: 'bash_progress',
      output,
      fullOutput: output,
      elapsedTimeSeconds: second,
      totalLines: 1,
      totalBytes: output.length,
    },
  })
}

function preToolUseHook(parentToolUseID: string): Message[] {
  return [
    createProgressMessage({
      toolUseID: parentToolUseID,
      parentToolUseID,
      data: {
        type: 'hook_progress',
        hookEvent: 'PreToolUse',
        hookName: 'PreToolUse:Bash',
        command: 'true',
      },
    }),
    createAttachmentMessage({
      type: 'hook_success',
      hookName: 'PreToolUse:Bash',
      toolUseID: parentToolUseID,
      hookEvent: 'PreToolUse',
      content: '',
    }),
  ]
}

function agentUse(id: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Agent',
        input: {
          description: 'dig into the build',
          prompt: `PROMPT-${id}`,
          subagent_type: 'general-purpose',
        },
      },
    ],
  })
}

/** AgentTool's first agent_progress for a sub-agent carries its prompt. */
function agentPromptEntry(parentToolUseID: string): Message {
  return createProgressMessage({
    toolUseID: `agent_${parentToolUseID}`,
    parentToolUseID,
    data: {
      type: 'agent_progress',
      message: createUserMessage({ content: `PROMPT-${parentToolUseID}` }),
      prompt: `PROMPT-${parentToolUseID}`,
      agentId: parentToolUseID,
    },
  })
}

/** One inner round of the sub-agent: its tool_use, then that call's tool_result. */
function agentInnerRound(parentToolUseID: string, round: number): Message[] {
  const innerId = `${parentToolUseID}_inner_${round}`
  const forward = (message: Message) =>
    createProgressMessage({
      toolUseID: `agent_${parentToolUseID}`,
      parentToolUseID,
      data: {
        type: 'agent_progress',
        message,
        prompt: '',
        agentId: parentToolUseID,
      },
    })
  return [
    forward(
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: innerId,
            name: 'Bash',
            input: { command: `echo INNER-${round}`, description: 'step' },
          },
        ],
      }),
    ),
    forward(
      createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: innerId, content: 'done' }],
      }),
    ),
  ]
}

describe('teammate view — the mirror rendered through <Messages>', () => {
  test('a sub-agent flooding agent_progress leaves every conversation row and its live trail on screen', async () => {
    const agentId = 'toolu_agent'
    const rounds = Array.from({ length: 40 }, (_, round) =>
      agentInnerRound(agentId, round),
    ).flat()
    const mirror = foldIntoMirror([
      ...conversationRows(),
      agentUse(agentId),
      agentPromptEntry(agentId),
      ...rounds,
    ])

    const frame = await renderTeammateView(mirror, new Set([agentId]))

    expect(rowsOnScreen(frame)).toEqual(ROW_MARKERS)
    expect(frame).toContain('INNER-39')
    expect(frame).not.toContain('Initializing')
  })

  test('interleaved ticks from parallel Bash calls leave every conversation row and both live ticks on screen', async () => {
    const first = 'toolu_bash_a'
    const second = 'toolu_bash_b'
    const ticks: Message[] = []
    for (let s = 3; s <= 62; s++) {
      ticks.push(bashTick(first, s), bashTick(second, s))
    }
    const mirror = foldIntoMirror([
      ...conversationRows(),
      bashUse(first),
      ...preToolUseHook(first),
      bashUse(second),
      ...preToolUseHook(second),
      ...ticks,
    ])

    const frame = await renderTeammateView(mirror, new Set([first, second]))

    expect(rowsOnScreen(frame)).toEqual(ROW_MARKERS)
    expect(frame).toContain(`TICK-${first}-62`)
    expect(frame).toContain(`TICK-${second}-62`)
  })
})
