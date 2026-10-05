import { expect, test } from 'bun:test'
import { createAssistantAPIErrorMessage } from '../messages.js'
import { findTurnFailure } from './turnFailure.js'

const ok = (text: string) =>
  ({
    type: 'assistant',
    uuid: 'u',
    message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }] },
  }) as never

test('a turn ending in a refusal message is a refusal failure carrying its text', () => {
  const failure = findTurnFailure([
    ok('hi'),
    createAssistantAPIErrorMessage({
      content: 'API Error: unable to respond',
      apiError: 'refusal',
      error: 'invalid_request',
    }),
  ])
  expect(failure).toEqual({
    kind: 'refusal',
    errorText: 'API Error: unable to respond',
  })
})

test('a turn that recovered after an error, or never errored, is not a failure', () => {
  expect(
    findTurnFailure([createAssistantAPIErrorMessage({ content: 'API Error: 529' }), ok('fine')]),
  ).toBeUndefined()
  expect(findTurnFailure([ok('fine')])).toBeUndefined()
  expect(findTurnFailure([])).toBeUndefined()
})

test('a user abort is a stop, not a failure', () => {
  expect(
    findTurnFailure([createAssistantAPIErrorMessage({ content: 'API Error: Request was aborted.' })]),
  ).toBeUndefined()
})
