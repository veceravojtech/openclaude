import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetJevCacheForTesting,
  acceptChoice,
  evaluateJev,
  isJevConfigured,
  JEV_ENDPOINT,
  type JevAnswer,
  type JevRequest,
} from './client.js'

const KEY = 'vck_test-FAKE-key-0123456789abcdefABCDEF'

const REQUEST: JevRequest = {
  instruction: 'Route this support message.',
  state: 'Our booking integration is broken. Guests cannot reserve rooms.',
  questions: {
    department: {
      type: 'choice',
      criteria: {
        technical: 'Broken software',
        billing: 'Payments',
        other: 'Anything else',
      },
    },
    urgent: { type: 'boolean' },
    impact: { type: 'score', criteria: ['Low', 'Medium', 'High'] },
  },
}

const VALID_BODY = {
  model: 'typesafe-ai/jev',
  answers: {
    department: {
      type: 'choice',
      choice: 'technical',
      probabilities: { technical: 0.9, billing: 0.06, other: 0.04 },
    },
    urgent: { type: 'boolean', probability: 0.93 },
    impact: { type: 'score', score: 1.8 },
  },
  usage: { inputTokens: 1100, outputTokens: 150 },
  providerMetadata: {
    gateway: { cost: '0.00042', marketCost: '0.001', generationId: 'gen_abc' },
  },
}

type Call = { url: string; init: RequestInit }

function mockFetch(
  respond: (call: Call) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function withAnswers(answers: Record<string, unknown>) {
  return { ...VALID_BODY, answers: { ...VALID_BODY.answers, ...answers } }
}

const savedEnvKey = process.env.AI_GATEWAY_API_KEY

beforeEach(() => {
  _resetJevCacheForTesting()
  delete process.env.AI_GATEWAY_API_KEY
})

afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.AI_GATEWAY_API_KEY
  else process.env.AI_GATEWAY_API_KEY = savedEnvKey
})

describe('evaluateJev: success', () => {
  test('parses valid choice, boolean and score answers plus telemetry', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cached).toBe(false)
    expect(result.answers.department).toEqual({
      type: 'choice',
      choice: 'technical',
      probabilities: { technical: 0.9, billing: 0.06, other: 0.04 },
    })
    expect(result.answers.urgent).toEqual({ type: 'boolean', probability: 0.93 })
    expect(result.answers.impact).toEqual({ type: 'score', score: 1.8 })
    expect(result.usage).toEqual({ inputTokens: 1100, outputTokens: 150 })
    expect(result.costUsd).toBeCloseTo(0.00042)
    expect(result.generationId).toBe('gen_abc')
    expect(typeof result.latencyMs).toBe('number')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(JEV_ENDPOINT)
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    const sent = JSON.parse(String(calls[0]!.init.body))
    expect(sent.model).toBe('typesafe-ai/jev')
    expect(sent.questions.department.criteria).toEqual(
      (REQUEST.questions.department as { criteria: unknown }).criteria,
    )
    expect(sent.questions.urgent.instructions).toBe('Route this support message.')
    expect(sent.providerOptions).toBeUndefined()
    expect(String(calls[0]!.init.body)).not.toContain(KEY)
  })

  test('uses AI_GATEWAY_API_KEY from the environment by default', async () => {
    process.env.AI_GATEWAY_API_KEY = KEY
    expect(isJevConfigured()).toBe(true)
    const { fetchImpl } = mockFetch(() => jsonResponse(VALID_BODY))
    const result = await evaluateJev(REQUEST, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  test('zeroDataRetention adds the gateway provider option', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl, zeroDataRetention: true })
    const sent = JSON.parse(String(calls[0]!.init.body))
    expect(sent.providerOptions).toEqual({ gateway: { zeroDataRetention: true } })
  })

  test('accepts probabilities summing to 1 within 0.02', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(
        withAnswers({
          department: {
            type: 'choice',
            choice: 'technical',
            probabilities: { technical: 0.9, billing: 0.06, other: 0.055 },
          },
        }),
      ),
    )
    const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(true)
  })
})

describe('evaluateJev: validation failures give invalid_response', () => {
  const cases: Array<[string, unknown]> = [
    ['missing answers', { model: 'x' }],
    ['answers not an object', { answers: [] }],
    ['missing question answer', { answers: { urgent: VALID_BODY.answers.urgent, impact: VALID_BODY.answers.impact } }],
    [
      'extra probability key',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: 0.9, billing: 0.05, other: 0.03, sales: 0.02 },
        },
      }),
    ],
    [
      'missing probability key',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: 0.95, billing: 0.05 },
        },
      }),
    ],
    [
      'probability out of [0,1]',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: 1.2, billing: -0.1, other: -0.1 },
        },
      }),
    ],
    [
      'probabilities do not sum to 1',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: 0.5, billing: 0.2, other: 0.2 },
        },
      }),
    ],
    [
      'choice is not the argmax',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'billing',
          probabilities: { technical: 0.7, billing: 0.2, other: 0.1 },
        },
      }),
    ],
    [
      'choice not a criteria key',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'sales',
          probabilities: { technical: 0.7, billing: 0.2, other: 0.1 },
        },
      }),
    ],
    [
      'non-numeric probability',
      withAnswers({
        department: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: '0.9', billing: 0.06, other: 0.04 },
        },
      }),
    ],
    ['boolean probability > 1', withAnswers({ urgent: { type: 'boolean', probability: 1.5 } })],
    ['boolean probability missing', withAnswers({ urgent: { type: 'boolean' } })],
    ['score above range', withAnswers({ impact: { type: 'score', score: 2.5 } })],
    ['score below range', withAnswers({ impact: { type: 'score', score: -0.1 } })],
    ['score not a number', withAnswers({ impact: { type: 'score', score: 'high' } })],
    ['answer type mismatch', withAnswers({ urgent: { type: 'score', score: 1 } })],
  ]

  for (const [name, body] of cases) {
    test(name, async () => {
      const { fetchImpl } = mockFetch(() => jsonResponse(body))
      const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('invalid_response')
    })
  }

  test('non-JSON body', async () => {
    const { fetchImpl } = mockFetch(() => new Response('<html>oops</html>', { status: 200 }))
    const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' })
  })

  test('invalid responses are not cached', async () => {
    let n = 0
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(n++ === 0 ? { answers: {} } : VALID_BODY),
    )
    expect((await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })).ok).toBe(false)
    expect((await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })).ok).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

describe('evaluateJev: transport failures', () => {
  for (const status of [401, 403, 500]) {
    test(`HTTP ${status} gives http_error with the status`, async () => {
      const { fetchImpl } = mockFetch(() =>
        jsonResponse({ error: { message: 'denied' } }, status),
      )
      const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
      expect(result).toMatchObject({ ok: false, reason: 'http_error', status })
    })
  }

  test('timeout gives reason timeout', async () => {
    const { fetchImpl } = mockFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl, timeoutMs: 20 })
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
  })

  test('fetch rejection gives network_error', async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'network_error' })
  })

  test('external abort signal gives network_error without throwing', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl } = mockFetch(({ init }) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return jsonResponse(VALID_BODY)
    })
    const result = await evaluateJev(REQUEST, {
      apiKey: KEY,
      fetchImpl,
      signal: controller.signal,
    })
    expect(result).toMatchObject({ ok: false, reason: 'network_error' })
  })

  test('no key gives no_key and makes no fetch', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    expect(isJevConfigured()).toBe(false)
    expect(isJevConfigured({ apiKey: '   ' })).toBe(false)
    const result = await evaluateJev(REQUEST, { fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'no_key' })
    expect(calls).toHaveLength(0)
  })
})

describe('evaluateJev: cache', () => {
  test('second identical call is a cache hit', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    const first = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    const second = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    expect(first).toMatchObject({ ok: true, cached: false })
    expect(second).toMatchObject({ ok: true, cached: true })
    if (first.ok && second.ok) expect(second.answers).toEqual(first.answers)
    expect(calls).toHaveLength(1)
  })

  test('cache key ignores the API key but not the state', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
    const otherKey = await evaluateJev(REQUEST, { apiKey: `${KEY}-2`, fetchImpl })
    expect(otherKey).toMatchObject({ ok: true, cached: true })
    await evaluateJev({ ...REQUEST, state: 'different' }, { apiKey: KEY, fetchImpl })
    expect(calls).toHaveLength(2)
  })

  test('cache: false bypasses the cache', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl, cache: false })
    const again = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl, cache: false })
    expect(again).toMatchObject({ ok: true, cached: false })
    expect(calls).toHaveLength(2)
  })
})

describe('evaluateJev: redaction and key hygiene', () => {
  const FAKE_SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'
  const FAKE_OPENAI = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'

  test('redaction removes fake secrets from the outgoing body', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    await evaluateJev(
      {
        ...REQUEST,
        instruction: `Route it. Authorization: Bearer ${FAKE_SECRET}`,
        state: {
          task: `Use ANTHROPIC_API_KEY=${FAKE_SECRET} to call the API`,
          nested: [{ env: `OPENAI key ${FAKE_OPENAI}` }],
          count: 3,
        },
      },
      { apiKey: KEY, fetchImpl },
    )
    const body = String(calls[0]!.init.body)
    expect(body).not.toContain(FAKE_SECRET)
    expect(body).not.toContain(FAKE_OPENAI)
    const sent = JSON.parse(body)
    expect(sent.state.count).toBe(3)
    expect(sent.state.task).toContain('[REDACTED')
    expect(sent.instruction ?? sent.questions.urgent.instructions).toContain('Route it.')
  })

  test('the gateway key itself is redacted if it appears in state', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(VALID_BODY))
    await evaluateJev(
      { ...REQUEST, state: `my key is ${KEY} please` },
      { apiKey: KEY, fetchImpl },
    )
    expect(String(calls[0]!.init.body)).not.toContain(KEY)
  })

  test('the key never appears in any result or error detail', async () => {
    const scenarios: Array<() => Response | Promise<Response>> = [
      () => jsonResponse(VALID_BODY),
      () => jsonResponse({ error: `bad token ${KEY}` }, 401),
      () => new Response(`upstream echoed Bearer ${KEY}`, { status: 500 }),
      () => new Response(`not json ${KEY}`, { status: 200 }),
      () => {
        throw new Error(`connect failed with header Authorization: Bearer ${KEY}`)
      },
      () => {
        throw new Error(`raw ${KEY}`)
      },
    ]
    for (const respond of scenarios) {
      _resetJevCacheForTesting()
      const { fetchImpl } = mockFetch(respond)
      const result = await evaluateJev(REQUEST, { apiKey: KEY, fetchImpl })
      expect(JSON.stringify(result)).not.toContain(KEY)
    }
  })
})

describe('acceptChoice (Rule A)', () => {
  const choice = (probabilities: Record<string, number>, pick: string): JevAnswer => ({
    type: 'choice',
    choice: pick,
    probabilities,
  })

  test('accepts p=0.8 with margin 0.2', () => {
    // margin is measured against the best *other* option (0.6), not the sum
    expect(acceptChoice(choice({ a: 0.8, b: 0.2 }, 'a'))).toBe('a')
    expect(acceptChoice(choice({ a: 0.8, b: 0.12, c: 0.08 }, 'a'))).toBe('a')
  })

  test('rejects p=0.8 with margin 0.1', () => {
    expect(acceptChoice(choice({ a: 0.8, b: 0.7 }, 'a'))).toBeNull()
  })

  test('rejects p=0.7', () => {
    expect(acceptChoice(choice({ a: 0.7, b: 0.2, c: 0.1 }, 'a'))).toBeNull()
  })

  test('boundary p=0.75 / margin 0.15 is accepted', () => {
    expect(acceptChoice(choice({ a: 0.75, b: 0.6 }, 'a'))).toBe('a')
  })

  test('custom rule and non-choice answers', () => {
    expect(acceptChoice(choice({ a: 0.7, b: 0.3 }, 'a'), { minP: 0.6, minMargin: 0.3 })).toBe('a')
    expect(acceptChoice({ type: 'boolean', probability: 0.99 })).toBeNull()
    expect(acceptChoice(undefined)).toBeNull()
  })
})
