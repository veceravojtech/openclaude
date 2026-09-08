import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { describe, expect, mock, test } from 'bun:test'
import React, { useState } from 'react'

import { Box, createRoot, Text, useInput } from '../../ink.js'
import {
  INITIAL_STATE,
  type ParsedInput,
  type ParsedKey,
  parseMultipleKeypresses,
} from '../parse-keypress.js'
import { createSelectionState } from '../selection.js'
import { PASTE_END, PASTE_START } from '../termio/csi.js'
import App, { splitIntoRenderBatches } from './App.js'

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const ENTER = '\r'
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

// Long enough to be a "real" paste by the size the batching guard cares
// about: the single-batch design exists so a paste this big cannot turn
// into hundreds of nested React updates.
const BIG_PASTE = 'x'.repeat(600)

function parse(input: string): ParsedInput[] {
  return parseMultipleKeypresses(INITIAL_STATE, input)[0]
}

type FakeStdin = NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof mock>
  ref: ReturnType<typeof mock>
  unref: ReturnType<typeof mock>
  resume: ReturnType<typeof mock>
  pause: ReturnType<typeof mock>
}

function createFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as unknown as FakeStdin
  stdin.isTTY = true
  stdin.ref = mock(() => stdin)
  stdin.unref = mock(() => stdin)
  stdin.resume = mock(() => stdin)
  stdin.pause = mock(() => stdin)
  stdin.setEncoding = mock(() => stdin) as unknown as FakeStdin['setEncoding']
  stdin.setRawMode = mock(() => stdin)
  return stdin
}

function createFakeStdout(): NodeJS.WriteStream {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.isTTY = true
  stdout.write = mock(() => true) as unknown as NodeJS.WriteStream['write']
  return stdout
}

function createApp(dispatchKeyboardEvent: (parsedKey: ParsedKey) => void): App {
  return new App({
    children: null,
    stdin: createFakeStdin(),
    stdout: createFakeStdout(),
    stderr: createFakeStdout(),
    exitOnCtrlC: true,
    onExit: () => {},
    terminalColumns: 80,
    terminalRows: 24,
    selection: createSelectionState(),
    onSelectionChange: () => {},
    onClickAt: () => false,
    onHoverAt: () => {},
    getHyperlinkAt: () => undefined,
    onOpenHyperlink: () => {},
    onMultiClick: () => {},
    onSelectionDrag: () => {},
    dispatchKeyboardEvent,
  })
}

/**
 * An App wired to a stubbed `dispatchKeyboardEvent`, recording for every key
 * how many React commits (`flushKeyBatch` calls) had already happened when it
 * was dispatched. A key that reads state written by the key before it is
 * correct exactly when its `flushes` count is higher than its predecessor's.
 */
function createBatchProbe(): {
  app: App
  dispatched: Array<{ name: string | undefined; flushes: number }>
  flushes: () => number
} {
  let flushes = 0
  const dispatched: Array<{ name: string | undefined; flushes: number }> = []
  const app = createApp(key => {
    dispatched.push({ name: key.name, flushes })
  })
  const realFlush = app.flushKeyBatch
  app.flushKeyBatch = () => {
    flushes++
    realFlush()
  }
  return { app, dispatched, flushes: () => flushes }
}

describe('splitIntoRenderBatches', () => {
  test('keeps a run of typed text in one batch', () => {
    const batches = splitIntoRenderBatches(parse('hello world'))

    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
  })

  test('keeps a 600-character single-chunk paste in ONE batch', () => {
    const keys = parse(`${PASTE_START}${BIG_PASTE}${PASTE_END}`)
    const batches = splitIntoRenderBatches(keys)

    // One paste key, one batch: no per-character flushing, so the guard the
    // original single-discreteUpdates design provided is untouched.
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
    expect((batches[0]![0] as ParsedKey).isPasted).toBe(true)
    expect((batches[0]![0] as ParsedKey).sequence).toHaveLength(600)
  })

  test('splits between a DOWN and the Enter that follows it', () => {
    const batches = splitIntoRenderBatches(parse(DOWN + ENTER))

    expect(batches.map(batch => batch.map(item => (item as ParsedKey).name))).toEqual([
      ['down'],
      ['return'],
    ])
  })

  test('gives every key of an arrow burst its own batch', () => {
    const batches = splitIntoRenderBatches(parse(DOWN + DOWN + UP))

    expect(batches).toHaveLength(3)
  })

  test('closes a text run at an arrow and opens a fresh one after it', () => {
    const batches = splitIntoRenderBatches(parse(`ab${DOWN}cd`))

    expect(batches.map(batch => batch.map(item => (item as ParsedKey).name))).toEqual([
      [''],
      ['down'],
      [''],
    ])
  })

  test('gives a ctrl combo its own batch', () => {
    // Ctrl+A: no escape sequence, but a modifier — a command, not text.
    const batches = splitIntoRenderBatches(parse('\x01'))

    expect(batches).toHaveLength(1)
    expect((batches[0]![0] as ParsedKey).ctrl).toBe(true)
  })

  test('lets a terminal response ride along in the current batch', () => {
    // DA1 reply glued to typed text: it resolves a querier promise and never
    // touches React state, so it must not cost an extra commit.
    const batches = splitIntoRenderBatches(parse(`ab\x1b[?62;c`))

    expect(batches).toHaveLength(1)
    expect(batches[0]!.map(item => item.kind)).toEqual(['key', 'response'])
  })

  test('returns no batches for an empty read', () => {
    expect(splitIntoRenderBatches([])).toEqual([])
  })
})

describe('App key-batch flushing', () => {
  test('commits React between a DOWN and the Enter typed ahead of it in ONE read', () => {
    const { app, dispatched } = createBatchProbe()

    app.processInput(DOWN + ENTER)

    expect(dispatched.map(d => d.name)).toEqual(['down', 'return'])
    // The whole point: Enter is dispatched strictly after a commit that the
    // DOWN did not have, so its handler reads the post-DOWN selection.
    expect(dispatched[1]!.flushes).toBe(dispatched[0]!.flushes + 1)
  })

  test('commits React between two chunks of the same readable event', () => {
    const { app, dispatched } = createBatchProbe()

    // Two writes drained by one 'readable' event arrive as two processInput
    // calls with nothing in between — the boundary still needs a commit.
    app.processInput(DOWN)
    app.processInput(ENTER)

    expect(dispatched.map(d => d.name)).toEqual(['down', 'return'])
    expect(dispatched[1]!.flushes).toBe(dispatched[0]!.flushes + 1)
  })

  test('commits React between each key of a DOWN DOWN Enter typeahead', () => {
    const { app, dispatched } = createBatchProbe()

    app.processInput(DOWN + DOWN + ENTER)

    expect(dispatched.map(d => d.name)).toEqual(['down', 'down', 'return'])
    expect(dispatched[1]!.flushes).toBe(dispatched[0]!.flushes + 1)
    expect(dispatched[2]!.flushes).toBe(dispatched[1]!.flushes + 1)
  })

  test('keeps a 600-character single-chunk paste in one un-flushed batch', () => {
    const { app, dispatched, flushes } = createBatchProbe()

    app.processInput(`${PASTE_START}${BIG_PASTE}${PASTE_END}`)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.flushes).toBe(0)
    // Nothing flushed at all: the paste is a single key in a single batch.
    expect(flushes()).toBe(0)
  })

  test('does not flush inside a run of typed characters', () => {
    const { app, dispatched, flushes } = createBatchProbe()

    // Auto-repeat / fast typing coalesced by the tokenizer into one text key.
    app.processInput('the quick brown fox')

    expect(dispatched).toHaveLength(1)
    expect(flushes()).toBe(0)
  })
})

describe('App paste rendering', () => {
  test('renders a 600-character single-chunk paste without Maximum update depth exceeded', async () => {
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

    let renders = 0

    function PasteSink(): React.ReactElement {
      const [typed, setTyped] = useState('')
      renders++
      useInput(input => {
        setTyped(prev => prev + input)
      })
      return (
        <Box>
          <Text>len:{typed.length}</Text>
        </Box>
      )
    }

    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    // A React error thrown out of the commit (this is how "Maximum update
    // depth exceeded" surfaces) unmounts the root with a rejection.
    let exitError: unknown = null
    void root.waitUntilExit().catch((error: unknown) => {
      exitError = error
    })

    try {
      root.render(<PasteSink />)
      await waitForFrame(() => output, frame => frame.includes('len:0'))
      const rendersBeforePaste = renders

      stdin.write(`${PASTE_START}${BIG_PASTE}${PASTE_END}`)

      const frame = await waitForFrame(
        () => output,
        f => f.includes('len:600'),
      )
      expect(frame).toContain('len:600')
      expect(exitError).toBeNull()
      // One commit for the whole paste — a per-character split would show up
      // here as hundreds of renders (and is what trips React's depth guard).
      expect(renders - rendersBeforePaste).toBeLessThanOrEqual(2)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }
  })
})

// Non-TTY stdout emits one DEC-synchronized frame per render; pull the last
// complete one out of the concatenated buffer.
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

async function waitForFrame(
  readOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const startedAt = Date.now()
  let frame = ''
  while (Date.now() - startedAt < 2500) {
    frame = extractLastFrame(readOutput())
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for frame:\n${frame}`)
}
