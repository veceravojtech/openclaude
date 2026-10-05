import { afterEach, beforeEach, expect, test } from 'bun:test'

import { isDebugMode, isDebugToStdErr, logForDebugging } from './debug.js'
import { sanitizeError } from './log.js'

// A provider error echoed into a log line can carry a bare account id or JWT
// (no field name for the named-field scrubber to key on). The log sinks add the
// bare-token sweep; model-visible text does not go through them.

const BARE = 'acct-SECRETACCT99 and eyJhbGciOiJIUzI1NiJ9.SECRETJWTPAYLOAD.SECRETJWTSIG'

let savedArgv: string[]
let savedEnv: string | undefined
let written: string[]
let realWrite: typeof process.stderr.write

beforeEach(() => {
  savedArgv = process.argv
  savedEnv = process.env.NODE_ENV
  process.argv = [...process.argv, '-d2e']
  isDebugToStdErr.cache.clear?.()
  isDebugMode.cache.clear?.()
  written = []
  realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stderr.write = realWrite
  process.argv = savedArgv
  if (savedEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedEnv
  isDebugToStdErr.cache.clear?.()
  isDebugMode.cache.clear?.()
})

test('the debug log never writes a bare account id or JWT from an echoed provider error', () => {
  logForDebugging(`Sync agent error: API Error: 400 ${BARE}`)
  const line = written.join('')
  expect(line).toContain('Sync agent error')
  expect(line).not.toContain('SECRETACCT99')
  expect(line).not.toContain('SECRETJWTPAYLOAD')
})

test('the error log copy of an Error drops a bare account id or JWT from message and stack', () => {
  const err = new Error(`API Error: 400 ${BARE}`)
  err.stack = `Error: API Error: 400 ${BARE}\n    at test (file.ts:1:1)`
  const sanitized = sanitizeError(err)
  for (const text of [sanitized.message, sanitized.stack!]) {
    expect(text).toContain('API Error: 400')
    expect(text).not.toContain('SECRETACCT99')
    expect(text).not.toContain('SECRETJWTPAYLOAD')
  }
})
