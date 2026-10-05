import { APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import {
  AbortError,
  isAbortError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as TelemetrySafeError,
} from '../errors.js'

import { redactThrownError } from './teammateFailureReasons.js'

const BODY = JSON.stringify({
  error: { message: 'bad', 'chatgpt-account-id': 'acct-SECRETACCT99', api_key: 'sk-SECRETOPENAIKEY12345678' },
})

test('a thrown provider error is rethrown without its secrets, keeping name and shape', () => {
  const original = new TypeError(`API Error: 400 ${BODY}`)
  const redacted = redactThrownError(original)
  expect(redacted).not.toBe(original)
  expect(redacted).toBeInstanceOf(Error)
  expect(redacted.name).toBe('TypeError')
  expect(redacted.message).toContain('API Error: 400')
  expect(redacted.message).not.toContain('SECRETACCT99')
  expect(redacted.message).not.toContain('SECRETOPENAIKEY')
  expect(redacted.stack).not.toContain('SECRETACCT99')
  // The original is not mutated.
  expect(original.message).toContain('SECRETACCT99')
})

test('an error that needs no scrubbing is returned as is, so its class survives', () => {
  class CustomError extends Error {}
  const original = new CustomError('plain failure')
  expect(redactThrownError(original)).toBe(original)
})

test('a non-Error throw becomes an Error with a scrubbed message', () => {
  const redacted = redactThrownError(`oops ${BODY}`)
  expect(redacted).toBeInstanceOf(Error)
  expect(redacted.message).not.toContain('SECRETACCT99')
})

test('a redacted APIError is still an APIError with its status, and carries no raw body or headers', () => {
  const body = { error: { message: 'bad', 'chatgpt-account-id': 'acct-SECRETACCT99' } }
  const original = APIError.generate(
    400,
    body,
    `400 ${JSON.stringify(body)}`,
    new Headers({ 'x-request-id': 'req_abc123' }),
  )
  expect(original.message).toContain('SECRETACCT99')
  const redacted = redactThrownError(original) as APIError
  expect(redacted).not.toBe(original)
  expect(redacted).toBeInstanceOf(APIError)
  expect(redacted.status).toBe(400)
  expect(redacted.message).not.toContain('SECRETACCT99')
  // The raw response body and headers are not carried over.
  expect(redacted.error).toBeUndefined()
  expect(redacted.headers).toBeUndefined()
  expect(JSON.stringify(redacted)).not.toContain('SECRETACCT99')
  expect(redacted.stack).not.toContain('SECRETACCT99')
})

test('a redacted error keeps its code and requestID', () => {
  const original = Object.assign(new Error(`failed ${BODY}`), {
    code: 'E_PROVIDER',
    requestID: 'req_1',
    cause: new Error('raw sk-SECRETOPENAIKEY12345678'),
  })
  const redacted = redactThrownError(original) as Error & { code?: string; requestID?: string }
  expect(redacted.code).toBe('E_PROVIDER')
  expect(redacted.requestID).toBe('req_1')
  expect((redacted as { cause?: unknown }).cause).toBeUndefined()
})

test('a redacted TelemetrySafeError stays one and its telemetry message is scrubbed too', () => {
  const original = new TelemetrySafeError(`provider said ${BODY}`)
  const redacted = redactThrownError(original) as InstanceType<typeof TelemetrySafeError>
  expect(redacted).toBeInstanceOf(TelemetrySafeError)
  expect(redacted.name).toBe('TelemetrySafeError')
  expect(redacted.telemetryMessage).not.toContain('SECRETACCT99')
  expect(redacted.message).not.toContain('SECRETACCT99')
})

test('abort errors still satisfy isAbortError after redaction', () => {
  for (const original of [
    new AbortError(`aborted ${BODY}`),
    new APIUserAbortError({ message: `aborted ${BODY}` } as never),
    Object.assign(new Error(`aborted ${BODY}`), { name: 'AbortError' }),
  ]) {
    const redacted = redactThrownError(original)
    expect(redacted.message).not.toContain('SECRETACCT99')
    expect(isAbortError(redacted)).toBe(true)
  }
})

test('an error without a stack gets a sensible one, not a pointer into the helper', () => {
  const original = new Error(`boom ${BODY}`)
  original.stack = undefined
  const redacted = redactThrownError(original)
  expect(redacted.stack).toStartWith('Error: boom')
  expect(redacted.stack).not.toContain('redactThrownError')
})
