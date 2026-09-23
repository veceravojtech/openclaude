import { expect, test } from 'bun:test'

import { applyModelRequestConstraints } from './modelRequestConstraints.js'

type ToolChoice = { type: string; name?: string; disable_parallel_tool_use?: boolean }

const FABLE_5_1 = 'claude-fable-5-1'

test('forced tool_choice is downgraded to auto for Fable 5.1+', () => {
  for (const model of [
    FABLE_5_1,
    'us.anthropic.claude-fable-5-1',
    'claude-fable-5-2',
  ]) {
    const out = applyModelRequestConstraints({
      model,
      tool_choice: { type: 'tool', name: 'explain_command' } as ToolChoice,
    })
    expect(out.tool_choice).toEqual({ type: 'auto' })
    expect(
      applyModelRequestConstraints({ model, tool_choice: { type: 'any' } })
        .tool_choice,
    ).toEqual({ type: 'auto' })
  }
})

test('disable_parallel_tool_use survives the downgrade', () => {
  const out = applyModelRequestConstraints({
    model: FABLE_5_1,
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  })
  expect(out.tool_choice).toEqual({
    type: 'auto',
    disable_parallel_tool_use: true,
  })
})

test('forced tool_choice is left alone for Opus 5.5 and Sonnet', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-4-6']) {
    const params = {
      model,
      tool_choice: { type: 'tool', name: 'x' },
      temperature: 0,
      thinking: { type: 'disabled' },
    }
    // Untouched params are returned as-is.
    expect(applyModelRequestConstraints(params)).toBe(params)
  }
})

test('the explicit model argument wins over params.model', () => {
  // params.model can be a normalized/deployment id; the resolved model decides.
  const out = applyModelRequestConstraints(
    { model: 'my-deployment', tool_choice: { type: 'tool', name: 'x' } as ToolChoice },
    FABLE_5_1,
  )
  expect(out.tool_choice).toEqual({ type: 'auto' })
})

test('temperature 0 is omitted for Fable 5.1; temperature 1 is kept', () => {
  expect(
    'temperature' in
      applyModelRequestConstraints({ model: FABLE_5_1, temperature: 0 }),
  ).toBe(false)
  expect(
    applyModelRequestConstraints({ model: FABLE_5_1, temperature: 1 })
      .temperature,
  ).toBe(1)
})

test('disabled thinking is dropped and budgeted thinking becomes adaptive', () => {
  expect(
    'thinking' in
      applyModelRequestConstraints({
        model: FABLE_5_1,
        thinking: { type: 'disabled' },
      }),
  ).toBe(false)
  expect(
    applyModelRequestConstraints({
      model: FABLE_5_1,
      thinking: { type: 'enabled', budget_tokens: 1024 } as {
        type: string
        budget_tokens?: number
      },
    }).thinking,
  ).toEqual({ type: 'adaptive' })
})

test('top_p / top_k restrictions are enforced for Fable 5.1', () => {
  const out = applyModelRequestConstraints({
    model: FABLE_5_1,
    top_p: 0.5,
    top_k: 40,
  })
  expect('top_p' in out).toBe(false)
  expect('top_k' in out).toBe(false)
  expect(
    applyModelRequestConstraints({ model: FABLE_5_1, top_p: 0.99 }).top_p,
  ).toBe(0.99)
  // temperature and top_p cannot both be set.
  const both = applyModelRequestConstraints({
    model: FABLE_5_1,
    temperature: 1,
    top_p: 0.99,
  })
  expect(both.temperature).toBe(1)
  expect('top_p' in both).toBe(false)
})
