import { expect, test } from 'bun:test'

import { resolveQueryModelSetting } from './model.js'

// Regression: headless (-p) AppState left mainLoopModel null, so queryLoop fell
// straight to the account default and `--model claude-sonnet-5-5` ran (and
// billed) as Opus. The tool-use context's options carry the real selection.

test('AppState session model wins over everything', () => {
  expect(
    resolveQueryModelSetting({
      mainLoopModelForSession: 'claude-haiku-4-5',
      mainLoopModel: 'claude-sonnet-5-5',
      optionsMainLoopModel: 'claude-opus-5-5',
    }),
  ).toBe('claude-haiku-4-5')
})

test('AppState mainLoopModel wins over options', () => {
  expect(
    resolveQueryModelSetting({
      mainLoopModelForSession: null,
      mainLoopModel: 'claude-sonnet-5-5',
      optionsMainLoopModel: 'claude-opus-5-5',
    }),
  ).toBe('claude-sonnet-5-5')
})

test('falls back to options.mainLoopModel when both AppState fields are null', () => {
  expect(
    resolveQueryModelSetting({
      mainLoopModelForSession: null,
      mainLoopModel: null,
      optionsMainLoopModel: 'claude-sonnet-5-5',
    }),
  ).toBe('claude-sonnet-5-5')
})

test('mid-session set_model (session pin) overrides the startup --model', () => {
  const startup = {
    mainLoopModelForSession: null,
    mainLoopModel: 'claude-sonnet-5-5',
    optionsMainLoopModel: 'claude-sonnet-5-5',
  }
  expect(resolveQueryModelSetting(startup)).toBe('claude-sonnet-5-5')
  expect(
    resolveQueryModelSetting({
      ...startup,
      mainLoopModelForSession: 'claude-haiku-4-5',
    }),
  ).toBe('claude-haiku-4-5')
})

test('uses the built-in default only when nothing is selected', () => {
  const resolved = resolveQueryModelSetting({
    mainLoopModelForSession: null,
    mainLoopModel: null,
    optionsMainLoopModel: undefined,
  })
  expect(typeof resolved).toBe('string')
  expect(resolved.length).toBeGreaterThan(0)
  expect(
    resolveQueryModelSetting({
      mainLoopModelForSession: null,
      mainLoopModel: null,
      optionsMainLoopModel: '',
    }),
  ).toBe(resolved)
})
