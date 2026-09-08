import { describe, expect, test } from 'bun:test'
import {
  MIN_TMUX_MAJOR,
  MIN_TMUX_MINOR,
  isTmuxTooOld,
  parseTmuxVersion,
} from './tmux-version'

/**
 * Pure unit tests for the harness's tmux version gate.
 *
 * These import ONLY `./tmux-version` - never `tui-keys.ts`, which runs
 * `main()` at module scope. Nothing here spawns a process, needs tmux or
 * touches the network, so this file is safe for the default `bun test`.
 *
 * Every case is named after the `tmux -V` banner it covers, so a failure reads
 * on its own without opening the file.
 */
describe('parseTmuxVersion', () => {
  test('`tmux 3.6b` -> 3.6 (letter suffix ignored)', () => {
    expect(parseTmuxVersion('tmux 3.6b')).toEqual({ major: 3, minor: 6 })
  })

  test('`tmux 3.2a` -> 3.2 (the floor release, letter suffix ignored)', () => {
    expect(parseTmuxVersion('tmux 3.2a')).toEqual({ major: 3, minor: 2 })
  })

  test('`tmux 3.4` -> 3.4 (OpenBSD bare form)', () => {
    expect(parseTmuxVersion('tmux 3.4')).toEqual({ major: 3, minor: 4 })
  })

  test('`tmux next-3.7` -> 3.7 (release candidate, number follows a hyphen)', () => {
    expect(parseTmuxVersion('tmux next-3.7')).toEqual({ major: 3, minor: 7 })
  })

  test('`tmux 10.1` -> 10.1 (multi-digit major is parsed as a number)', () => {
    expect(parseTmuxVersion('tmux 10.1')).toEqual({ major: 10, minor: 1 })
  })

  test('`tmux master` -> null (banner names no version)', () => {
    expect(parseTmuxVersion('tmux master')).toBeNull()
  })

  test('`` (empty banner) -> null', () => {
    expect(parseTmuxVersion('')).toBeNull()
  })
})

describe('isTmuxTooOld', () => {
  test('the floor is 3.2 - `new-session -e` landed there', () => {
    expect(MIN_TMUX_MAJOR).toBe(3)
    expect(MIN_TMUX_MINOR).toBe(2)
  })

  test('`tmux 3.6b` is not too old', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 3.6b'))).toBe(false)
  })

  test('`tmux 3.2a` is not too old', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 3.2a'))).toBe(false)
  })

  test('`tmux 3.2` is not too old - the floor is INCLUSIVE', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 3.2'))).toBe(false)
  })

  test('`tmux 3.1c` is too old (Debian 11)', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 3.1c'))).toBe(true)
  })

  test('`tmux 3.0a` is too old (Ubuntu 20.04)', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 3.0a'))).toBe(true)
  })

  test('`tmux 2.9` is too old (major below the floor)', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 2.9'))).toBe(true)
  })

  test('`tmux 10.1` is not too old - majors compare as numbers, not lexically', () => {
    expect(isTmuxTooOld(parseTmuxVersion('tmux 10.1'))).toBe(false)
  })

  test('an UNKNOWN version (null) is never too old - the run proceeds', () => {
    expect(isTmuxTooOld(null)).toBe(false)
    expect(isTmuxTooOld(parseTmuxVersion('tmux master'))).toBe(false)
  })
})
