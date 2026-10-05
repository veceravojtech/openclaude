import { describe, expect, test } from 'bun:test'
import { classifyTeammateApiError } from './teammateInit.js'

describe('classifyTeammateApiError', () => {
  test('revoked OAuth maps to authentication', () => {
    expect(
      classifyTeammateApiError(
        'authentication_failed',
        'OAuth token revoked · Please run /login',
      ),
    ).toBe('authentication')
    // The text alone is enough when the error code is missing.
    expect(
      classifyTeammateApiError(undefined, 'OAuth token has been revoked'),
    ).toBe('authentication')
  })

  test('quota exhaustion maps to quota', () => {
    expect(
      classifyTeammateApiError(
        undefined,
        'API Error: API quota exhausted or not enabled.\nFix:\n- Enable billing',
      ),
    ).toBe('quota')
    expect(
      classifyTeammateApiError(undefined, 'You exceeded your current quota'),
    ).toBe('quota')
    // A ChatGPT plan (Codex) usage limit, as getCodexPlanLimitMessage words it.
    expect(
      classifyTeammateApiError(
        undefined,
        "Your ChatGPT plan's Codex usage limit has been reached. It resets at 3:05pm (UTC) (in 2h 5m).\nFix:\n- Wait for the limit to reset\n- Or switch provider via /provider",
      ),
    ).toBe('quota')
  })

  test('rate limits map to rate_limit', () => {
    expect(classifyTeammateApiError('rate_limit', 'slow down')).toBe(
      'rate_limit',
    )
    expect(classifyTeammateApiError(undefined, 'API Error: 429 Too Many')).toBe(
      'rate_limit',
    )
  })

  test('anything else stays a generic provider failure', () => {
    expect(classifyTeammateApiError(undefined, 'API Error: 500')).toBe(
      'provider',
    )
    expect(classifyTeammateApiError(undefined, undefined)).toBe('provider')
  })
})
