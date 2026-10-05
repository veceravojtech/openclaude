import { describe, expect, test } from 'bun:test'
import { classifyTeammateApiError } from './teammateInit.js'
import {
  classifyTeammateFailureReason,
  formatTeammateFailureReason,
  TEAMMATE_FAILURE_REASONS,
  teammateFailureKindOfReason,
} from './teammateFailureReasons.js'

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

  test('a usage-policy refusal maps to refusal, by the structured marker or the text', () => {
    expect(classifyTeammateApiError('invalid_request', 'anything', 'refusal')).toBe(
      'refusal',
    )
    expect(
      classifyTeammateApiError(
        'invalid_request',
        "API Error: OpenClaude is unable to respond to this request, which appears to violate our Usage Policy (your provider's acceptable use policy). Try rephrasing the request.",
      ),
    ).toBe('refusal')
  })

  test('the refusal reason keeps its original text and is still recognised', () => {
    const reason = formatTeammateFailureReason('refusal', 'API Error: refused')
    expect(reason).toContain(TEAMMATE_FAILURE_REASONS.refusal)
    expect(reason).toContain('API Error: refused')
    expect(teammateFailureKindOfReason(reason)).toBe('refusal')
    expect(classifyTeammateFailureReason(reason).transient).toBe(false)
    expect(formatTeammateFailureReason('refusal')).toBe(
      TEAMMATE_FAILURE_REASONS.refusal,
    )
  })

  test('provider text is redacted before it is attached to a reason, then clipped', () => {
    const reason = formatTeammateFailureReason(
      'provider',
      'calling https://u:pw@proxy.example.com/v1?api_key=SECRET123 with sk-ant-api03-abcdefghijklmnop1234567890',
    )
    expect(reason).not.toContain('SECRET123')
    expect(reason).not.toContain('u:pw@')
    expect(reason).not.toContain('sk-ant-api03-abcdefghijklmnop')
    expect(reason).toContain('proxy.example.com')
    expect(
      formatTeammateFailureReason('provider', 'x'.repeat(5000)).length,
    ).toBeLessThan(1_300)
  })

  test('a chatgpt-account-id header or JSON field is redacted', () => {
    const reason = formatTeammateFailureReason(
      'provider',
      'rejected: chatgpt-account-id: acct_1234abcd5678 and {"chatgpt-account-id":"acct_9999zzzz"} done',
    )
    expect(reason).not.toContain('acct_1234abcd5678')
    expect(reason).not.toContain('acct_9999zzzz')
    expect(reason).toContain('rejected:')
    expect(reason).toContain('done')
  })

  test('anything else stays a generic provider failure', () => {
    expect(classifyTeammateApiError(undefined, 'API Error: 500')).toBe(
      'provider',
    )
    expect(classifyTeammateApiError(undefined, undefined)).toBe('provider')
  })
})
