import { expect, test } from 'bun:test'
import {
  interpretTmuxPaneProbe,
  interpretTmuxPaneState,
  TmuxBackend,
} from './TmuxBackend.js'

/**
 * The pane-liveness judgement is split into two pure functions so the
 * socket-identity rule is provable without a live tmux server:
 *
 * - `interpretTmuxPaneState(raw, serverIdentityConfirmed)` judges the
 *   3-field reply. The `serverIdentityConfirmed` flag is consulted ONLY when
 *   the `pane_id` field is empty — the one answer that is ambiguous between
 *   "pane gone" and "asked a foreign server".
 * - `interpretTmuxPaneProbe(query, serverIdentityConfirmed)` adds the non-zero
 *   exit path (unreachable socket vs. a server that names a missing pane).
 *
 * A teammate pane is created running a shell and the CLI is typed into it, so
 * the pane outlives its child. Pane existence therefore proves nothing about
 * the CLI — the foreground command is what answers that. Shape is
 * `#{pane_id},#{pane_dead},#{pane_current_command}`. Samples marked "observed"
 * are verbatim tmux 3.6b output.
 */

test('a non-shell foreground command is the running child', () => {
  // Observed: a live pane, `tmux display-message -p -t %22 …` with the CLI up.
  expect(interpretTmuxPaneState('%22,0,node', true)).toBe('alive')
  expect(interpretTmuxPaneState('%5,0,openclaude', false)).toBe('alive')
  // Trailing newline is how tmux actually returns it.
  expect(interpretTmuxPaneState('%22,0,node\n', true)).toBe('alive')
})

test('a shell back in the foreground means the child is gone', () => {
  for (const shell of ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']) {
    expect(interpretTmuxPaneState(`%7,0,${shell}`, false)).toBe('dead')
  }
})

test('a login shell, which tmux reports with a leading dash, still counts', () => {
  expect(interpretTmuxPaneState('%7,0,-bash', false)).toBe('dead')
  expect(interpretTmuxPaneState('%7,0,-zsh', false)).toBe('dead')
})

test('pane_dead is decisive regardless of the command beside it', () => {
  expect(interpretTmuxPaneState('%7,1,node', false)).toBe('dead')
  expect(interpretTmuxPaneState('%7,1,bash', false)).toBe('dead')
})

test('anything unreadable is unknown, never dead', () => {
  expect(interpretTmuxPaneState('', true)).toBe('unknown')
  expect(interpretTmuxPaneState('   ', true)).toBe('unknown')
  // Not the shape we asked for: not enough fields (the old two-field format).
  expect(interpretTmuxPaneState('node', true)).toBe('unknown')
  expect(interpretTmuxPaneState('0,node', true)).toBe('unknown')
  // A pane_dead flag that is neither 0 nor 1.
  expect(interpretTmuxPaneState('%7,2,node', true)).toBe('unknown')
  expect(interpretTmuxPaneState('%7,x,node', true)).toBe('unknown')
  // Alive flag, but no command to judge.
  expect(interpretTmuxPaneState('%7,0,', true)).toBe('unknown')
})

/**
 * THE BLOCKER. An empty `pane_id` is not, by itself, evidence of death: it is
 * the answer "this id does not resolve on the server I asked", and a live pane
 * queried on a foreign socket produces exactly the same empty fields. Death
 * therefore requires positive server identity. This is the test that failed
 * before the fix: the old rule returned 'dead' for `,,` unconditionally.
 */
test('an empty pane_id is death only with positive server identity', () => {
  // A live pane queried on a foreign socket: the server answered (so it is
  // reachable) but the caller cannot confirm it owns this pane -> unknown.
  expect(interpretTmuxPaneState(',,', false)).toBe('unknown')
  expect(interpretTmuxPaneState(',,\n', false)).toBe('unknown')
  expect(interpretTmuxPaneState(',0,node', false)).toBe('unknown')
  expect(interpretTmuxPaneState(',1,node', false)).toBe('unknown')

  // The same reply, on a socket the caller positively confirmed owns the pane
  // (a genuinely absent pane) -> dead.
  expect(interpretTmuxPaneState(',,', true)).toBe('dead')
  expect(interpretTmuxPaneState(',,\n', true)).toBe('dead')
  expect(interpretTmuxPaneState(',0,node', true)).toBe('dead')
  expect(interpretTmuxPaneState(',1,node', true)).toBe('dead')
})

test('a live pane queried on its own socket is alive', () => {
  expect(
    interpretTmuxPaneProbe(
      { code: 0, stdout: '%25,0,node', stderr: '' },
      true,
    ),
  ).toBe('alive')
})

test('a live pane queried on a foreign socket is unknown, not dead', () => {
  // Observed: `%1` is live on `-L revtest`, but `tmux display-message -p -t
  // %1 …` on the default socket answers `,,` with exit 0. serverIdentityConfirmed
  // is false because the caller has no proof the queried socket owns the pane.
  expect(
    interpretTmuxPaneProbe(
      { code: 0, stdout: ',,', stderr: '' },
      false,
    ),
  ).toBe('unknown')
})

test('a genuinely absent pane on the confirmed owning socket is dead', () => {
  expect(
    interpretTmuxPaneProbe(
      { code: 0, stdout: ',,', stderr: '' },
      true,
    ),
  ).toBe('dead')
})

test('an unreachable socket is unknown', () => {
  // Observed: `tmux -L nosuchsock1234 …` -> "error connecting to …" exit 1.
  expect(
    interpretTmuxPaneProbe(
      { code: 1, stdout: '', stderr: 'error connecting to /tmp/tmux-1000/nosuchsock1234' },
      false,
    ),
  ).toBe('unknown')
})

test('a server that names a missing pane on stderr is dead', () => {
  // Some tmux versions report a missing pane by name rather than the empty
  // reply; the server answering is itself the positive identity.
  expect(
    interpretTmuxPaneProbe(
      { code: 1, stdout: '', stderr: "can't find pane %9999" },
      false,
    ),
  ).toBe('dead')
})

test('a probe with no recorded socket fails open as unknown', async () => {
  // Back-compat: a legacy roster row has no socket, so the probe cannot prove
  // which server owns the pane. It must answer unknown without even shelling
  // out, rather than risk a false 'dead' against a foreign server.
  const backend = new TmuxBackend()
  await expect(
    backend.isPaneAliveOnSocket('%1', undefined),
  ).resolves.toBe('unknown')
})
