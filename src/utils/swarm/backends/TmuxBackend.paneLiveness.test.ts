import { expect, test } from 'bun:test'
import { interpretTmuxPaneState } from './TmuxBackend.js'

/**
 * `interpretTmuxPaneState` carries the whole liveness judgement, so it is
 * tested directly rather than through a live tmux server.
 *
 * The rule it encodes: a teammate pane is created running a shell and the CLI
 * is typed into it, so the pane outlives its child. Pane existence therefore
 * proves nothing, and the foreground command is what answers the question.
 */

test('a non-shell foreground command is the running child', () => {
  expect(interpretTmuxPaneState('0,node')).toBe('alive')
  expect(interpretTmuxPaneState('0,openclaude')).toBe('alive')
  // Trailing newline is how tmux actually returns it.
  expect(interpretTmuxPaneState('0,node\n')).toBe('alive')
})

test('a shell back in the foreground means the child is gone', () => {
  for (const shell of ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']) {
    expect(interpretTmuxPaneState(`0,${shell}`)).toBe('dead')
  }
})

test('a login shell, which tmux reports with a leading dash, still counts', () => {
  expect(interpretTmuxPaneState('0,-bash')).toBe('dead')
  expect(interpretTmuxPaneState('0,-zsh')).toBe('dead')
})

test('pane_dead is decisive regardless of the command beside it', () => {
  expect(interpretTmuxPaneState('1,node')).toBe('dead')
  expect(interpretTmuxPaneState('1,bash')).toBe('dead')
})

test('anything unreadable is unknown, never dead', () => {
  // The asymmetry is the point: falsely failing a healthy teammate is worse
  // than the silent death this probe exists to catch, so only positive
  // evidence of death may return 'dead'.
  expect(interpretTmuxPaneState('')).toBe('unknown')
  expect(interpretTmuxPaneState('   ')).toBe('unknown')
  // No separator — not the format we asked for.
  expect(interpretTmuxPaneState('node')).toBe('unknown')
  // A pane_dead flag that is neither 0 nor 1.
  expect(interpretTmuxPaneState('2,node')).toBe('unknown')
  expect(interpretTmuxPaneState('x,node')).toBe('unknown')
  // Alive flag, but no command to judge.
  expect(interpretTmuxPaneState('0,')).toBe('unknown')
})
