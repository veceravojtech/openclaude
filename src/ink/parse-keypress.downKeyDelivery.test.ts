import { describe, expect, test } from 'bun:test'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedInput,
} from './parse-keypress.ts'

// REPRODUCTION SUITE — "Down arrow does not always register after switching
// windows". Feeds the parser the exact byte shapes a terminal multiplexer or
// a busy event loop can deliver and checks that a DOWN never disappears.
const DOWN = '\x1b[B'
const DOWN_APP_MODE = '\x1bOB' // DECCKM (application cursor keys) form
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

function feed(chunks: (string | null)[]): ParsedInput[] {
  let state = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const chunk of chunks) {
    const [items, next] = parseMultipleKeypresses(state, chunk)
    state = next
    out.push(...items)
  }
  return out
}

function describeItems(items: ParsedInput[]): string[] {
  return items.map(item => {
    if (item.kind !== 'key') return item.kind
    if (item.sequence === FOCUS_IN) return 'focus-in'
    if (item.sequence === FOCUS_OUT) return 'focus-out'
    // An EMPTY name is the nameless-key leak, not a name — render it as text
    // so a leaked '' shows up in the diff as the sequence that leaked.
    return item.name
      ? item.name
      : `text:${JSON.stringify(item.sequence)}`
  })
}

describe('DOWN delivery shapes', () => {
  test('two DOWN sequences in one chunk are two down keys', () => {
    expect(describeItems(feed([DOWN + DOWN]))).toEqual(['down', 'down'])
  })

  test('three DOWNs in one chunk (key auto-repeat) are three down keys', () => {
    expect(describeItems(feed([DOWN + DOWN + DOWN]))).toEqual([
      'down',
      'down',
      'down',
    ])
  })

  test('a focus-in report immediately followed by DOWN in one chunk keeps the DOWN', () => {
    expect(describeItems(feed([FOCUS_IN + DOWN]))).toEqual(['focus-in', 'down'])
  })

  test('focus-out, focus-in and DOWN in one chunk keep the DOWN', () => {
    expect(describeItems(feed([FOCUS_OUT + FOCUS_IN + DOWN]))).toEqual([
      'focus-out',
      'focus-in',
      'down',
    ])
  })

  test('DOWN followed by a focus-out in one chunk keeps the DOWN', () => {
    expect(describeItems(feed([DOWN + FOCUS_OUT]))).toEqual(['down', 'focus-out'])
  })

  test('DOWN delivered byte by byte is one down key', () => {
    expect(describeItems(feed(['\x1b', '[', 'B']))).toEqual(['down'])
  })

  test('DOWN split as ESC then "[B" across two reads is one down key', () => {
    expect(describeItems(feed(['\x1b', '[B']))).toEqual(['down'])
  })

  test('DOWN split as "ESC[" then "B" across two reads is one down key', () => {
    expect(describeItems(feed(['\x1b[', 'B']))).toEqual(['down'])
  })

  test('DOWN split around a flush (ESC, 300ms App timer flush, then "[B") is still a down key', () => {
    // null = the App's incomplete-escape flush timer (NORMAL_TIMEOUT, 300ms)
    // firing between the two reads.
    //
    // The leading 'escape' is a RESIDUAL, not a bug in this expectation: the
    // flush already emitted (and App already dispatched) that Escape one call
    // earlier, so the parser cannot retract it when the orphaned tail shows
    // up. What it can do — and what this asserts — is deliver the tail as a
    // real 'down' instead of leaking a nameless '' key, so the selection
    // still moves. See the cursor-tail branch in parse-keypress.ts.
    expect(describeItems(feed(['\x1b', null, '[B']))).toEqual([
      'escape',
      'down',
    ])
  })

  test('no orphaned cursor tail after a flush is ever a nameless key', () => {
    // Every tail the re-synthesis whitelist covers: arrows, Home/End, focus
    // reports, tilde keys, and the DECCKM application-cursor forms. None of
    // them may come back as '' (the pre-fix leak).
    const tails: [string, string][] = [
      ['[A', 'up'],
      ['[B', 'down'],
      ['[C', 'right'],
      ['[D', 'left'],
      ['[H', 'home'],
      ['[F', 'end'],
      ['[I', 'focus-in'],
      ['[O', 'focus-out'],
      ['[3~', 'delete'],
      ['OA', 'up'],
      ['OB', 'down'],
      ['OC', 'right'],
      ['OD', 'left'],
    ]
    for (const [tail, expected] of tails) {
      expect(describeItems(feed(['\x1b', null, tail]))).toEqual([
        'escape',
        expected,
      ])
    }
  })

  test('typing "[B" is left alone when no flushed Escape precedes it', () => {
    // The ambiguity guard. A literal "[B" is byte-identical to an orphaned
    // DOWN tail, so re-synthesis is armed ONLY by the flushed lone Escape
    // that could have stranded one. With no such Escape the text stays text.
    expect(describeItems(feed(['[B']))).toEqual(['text:"[B"'])
  })

  test('typing "[" then "B" after an Escape stays two typed keys', () => {
    // Separate keystrokes land in separate reads, so the tail whitelist never
    // sees a two-character token — the realistic typed case is unaffected
    // even directly after an Escape that timed out.
    expect(describeItems(feed(['\x1b', null, '[', 'B']))).toEqual([
      'escape',
      'text:"["',
      'b',
    ])
  })

  test('a cursor tail is only re-synthesized as the FIRST key after the flush', () => {
    // Once any other key has intervened the Escape is no longer the previous
    // key, so "[B" is ordinary text again.
    expect(describeItems(feed(['\x1b', null, 'x', '[B']))).toEqual([
      'escape',
      'x',
      'text:"[B"',
    ])
  })

  test('application-cursor-mode DOWN (ESC O B) is a down key', () => {
    expect(describeItems(feed([DOWN_APP_MODE]))).toEqual(['down'])
  })

  test('application-cursor-mode DOWN twice in one chunk is two down keys', () => {
    expect(describeItems(feed([DOWN_APP_MODE + DOWN_APP_MODE]))).toEqual([
      'down',
      'down',
    ])
  })

  test('DOWN then Enter in one chunk (typeahead) is down then return', () => {
    expect(describeItems(feed([DOWN + '\r']))).toEqual(['down', 'return'])
  })
})
