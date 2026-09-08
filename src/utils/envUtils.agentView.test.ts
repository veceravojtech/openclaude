import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { isAgentViewDisabled } from './envUtils.js'

const ENV_VAR = 'CLAUDE_CODE_DISABLE_AGENT_VIEW'

// Saved per test rather than once at module load: the gate reads process.env on
// every call, and a developer running with the variable exported must not get a
// false pass from a leaked value.
let originalValue: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/envUtils.agentView.test.ts')
  originalValue = process.env[ENV_VAR]
  delete process.env[ENV_VAR]
})

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = originalValue
  }
  releaseSharedMutationLock()
})

describe('isAgentViewDisabled', () => {
  test('is false when the variable is unset', () => {
    expect(process.env[ENV_VAR]).toBeUndefined()
    expect(isAgentViewDisabled()).toBe(false)
  })

  test.each(['1', 'true', 'yes', 'on'])(
    'is true for the truthy value %p',
    value => {
      process.env[ENV_VAR] = value
      expect(isAgentViewDisabled()).toBe(true)
    },
  )

  test.each(['0', 'false', '', 'no', 'off', 'maybe'])(
    'is false for the non-truthy value %p',
    value => {
      process.env[ENV_VAR] = value
      expect(isAgentViewDisabled()).toBe(false)
    },
  )

  // Guards the "must go through isEnvTruthy" decision: a `=== '1'` gate would
  // fail these, and upstream managed settings may write either casing.
  test.each(['TRUE', 'On', '  1  ', ' Yes '])(
    'normalizes case and whitespace for %p',
    value => {
      process.env[ENV_VAR] = value
      expect(isAgentViewDisabled()).toBe(true)
    },
  )

  test('re-reads process.env on every call rather than caching', () => {
    expect(isAgentViewDisabled()).toBe(false)
    process.env[ENV_VAR] = '1'
    expect(isAgentViewDisabled()).toBe(true)
    delete process.env[ENV_VAR]
    expect(isAgentViewDisabled()).toBe(false)
  })
})
