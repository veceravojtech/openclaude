/**
 * JEV typed-evaluation client (`typesafe-ai/jev` via Vercel AI Gateway).
 *
 * `POST https://ai-gateway.vercel.sh/v1/evaluate` with a state and a set of
 * typed questions (choice / boolean / score); the gateway returns one typed
 * answer per question.
 *
 * Hardening (mirrors linuxController's jev.py):
 * - never throws: every failure is `{ ok: false, reason }` (fail closed);
 * - every answer is validated against its question before it is returned;
 * - outbound `state` / `instruction` strings are secret-redacted;
 * - small in-process LRU cache (256 entries, 600 s TTL);
 * - usage / cost / generation-id telemetry;
 * - the API key is only ever placed in the Authorization header and is
 *   scrubbed from every error detail.
 *
 * Privacy: requests leave the machine. Zero data retention
 * (`providerOptions.gateway.zeroDataRetention`) is opt-in because the Vercel
 * Hobby plan rejects it with 403; without it the provider may retain the
 * (redacted) prompts.
 */
import { createHash } from 'crypto'
import { redactLikelySecrets } from '../../utils/redaction.js'

export type JevQuestion =
  | { type: 'choice'; criteria: Record<string, string> } // key -> description
  | { type: 'boolean' }
  | { type: 'score'; criteria: string[] } // ordered rubric, index 0 = lowest

export type JevRequest = {
  instruction?: string
  state: string | Record<string, unknown>
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  | { type: 'boolean'; probability: number }
  | { type: 'score'; score: number }

export type JevResult =
  | {
      ok: true
      answers: Record<string, JevAnswer>
      latencyMs: number
      cached: boolean
      usage?: { inputTokens?: number; outputTokens?: number }
      costUsd?: number
      generationId?: string
    }
  | {
      ok: false
      reason:
        | 'no_key'
        | 'timeout'
        | 'http_error'
        | 'invalid_response'
        | 'network_error'
      detail?: string
      status?: number
      latencyMs: number
    }

export type JevOptions = {
  apiKey?: string // default: process.env.AI_GATEWAY_API_KEY
  timeoutMs?: number // default 3000
  fetchImpl?: typeof fetch // for tests
  signal?: AbortSignal
  cache?: boolean // default true
  zeroDataRetention?: boolean // default false (Hobby plan returns 403 with ZDR)
}

export const JEV_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
export const JEV_MODEL = 'typesafe-ai/jev'

const DEFAULT_TIMEOUT_MS = 3000
const PROBABILITY_SUM_TOLERANCE = 0.02
const RULE_A_MIN_P = 0.75
const RULE_A_MIN_MARGIN = 0.15
const CACHE_SIZE = 256
const CACHE_TTL_MS = 600_000
const MAX_DETAIL_LENGTH = 200

type OkResult = Extract<JevResult, { ok: true }>
type FailResult = Extract<JevResult, { ok: false }>

// Insertion-ordered Map used as an LRU: re-inserting on hit moves to the end.
const cache = new Map<string, { expiresAt: number; result: OkResult }>()

export function _resetJevCacheForTesting(): void {
  cache.clear()
}

function resolveKey(opts?: Pick<JevOptions, 'apiKey'>): string {
  const key = (opts?.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? '').trim()
  if (!key || key === 'replace-with-your-vercel-ai-gateway-key') return ''
  return key
}

export function isJevConfigured(opts?: Pick<JevOptions, 'apiKey'>): boolean {
  return resolveKey(opts) !== ''
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function redactString(value: string, key: string): string {
  let out = key ? value.split(key).join('[REDACTED]') : value
  out = redactLikelySecrets(out)
  return out
}

function redactValue(value: unknown, key: string, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value, key)
  if (depth > 20 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => redactValue(v, key, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, key, depth + 1)
  }
  return out
}

/** Scrub the key (and anything else secret-looking) from an error detail. */
function safeDetail(detail: string, key: string): string {
  const scrubbed = redactString(detail, key)
  return scrubbed.length > MAX_DETAIL_LENGTH
    ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}…`
    : scrubbed
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

function buildPayload(
  req: JevRequest,
  key: string,
  zeroDataRetention: boolean,
): Record<string, unknown> {
  const instruction =
    typeof req.instruction === 'string' && req.instruction.trim()
      ? redactString(req.instruction, key)
      : undefined
  const questions: Record<string, unknown> = {}
  for (const [name, q] of Object.entries(req.questions)) {
    const wire: Record<string, unknown> = { type: q.type }
    if (instruction) wire.instructions = instruction
    if (q.type === 'choice' || q.type === 'score') wire.criteria = q.criteria
    questions[name] = wire
  }
  const payload: Record<string, unknown> = {
    model: JEV_MODEL,
    state: redactValue(req.state, key),
    questions,
  }
  if (zeroDataRetention) {
    payload.providerOptions = { gateway: { zeroDataRetention: true } }
  }
  return payload
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isProbability(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Returns the validated answer, or an error string. */
function validateAnswer(
  name: string,
  question: JevQuestion,
  raw: unknown,
): JevAnswer | string {
  if (!isRecord(raw)) return `answer ${name}: not an object`
  if (raw.type !== undefined && raw.type !== question.type) {
    return `answer ${name}: type mismatch`
  }
  switch (question.type) {
    case 'choice': {
      const { choice, probabilities } = raw
      if (typeof choice !== 'string' || !isRecord(probabilities)) {
        return `answer ${name}: missing choice or probabilities`
      }
      const expected = Object.keys(question.criteria).sort()
      const actual = Object.keys(probabilities).sort()
      if (
        expected.length !== actual.length ||
        expected.some((k, i) => k !== actual[i])
      ) {
        return `answer ${name}: probability keys do not match criteria`
      }
      const probs: Record<string, number> = {}
      let sum = 0
      for (const k of actual) {
        const p = probabilities[k]
        if (!isProbability(p)) return `answer ${name}: invalid probability`
        probs[k] = p
        sum += p
      }
      if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
        return `answer ${name}: probabilities do not sum to 1`
      }
      if (!(choice in probs)) return `answer ${name}: choice not in criteria`
      const max = Math.max(...Object.values(probs))
      if (probs[choice]! < max) return `answer ${name}: choice is not argmax`
      return { type: 'choice', choice, probabilities: probs }
    }
    case 'boolean': {
      if (!isProbability(raw.probability)) {
        return `answer ${name}: invalid probability`
      }
      return { type: 'boolean', probability: raw.probability }
    }
    case 'score': {
      const score = raw.score
      const max = question.criteria.length - 1
      if (
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > max
      ) {
        return `answer ${name}: score out of range`
      }
      return { type: 'score', score }
    }
    default:
      return `answer ${name}: unknown question type`
  }
}

function parseResponse(
  req: JevRequest,
  body: unknown,
): Omit<OkResult, 'latencyMs' | 'cached'> | string {
  if (!isRecord(body) || !isRecord(body.answers)) return 'missing answers'
  const answers: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(req.questions)) {
    const parsed = validateAnswer(name, question, body.answers[name])
    if (typeof parsed === 'string') return parsed
    answers[name] = parsed
  }
  const result: Omit<OkResult, 'latencyMs' | 'cached'> = { ok: true, answers }
  if (isRecord(body.usage)) {
    const usage: { inputTokens?: number; outputTokens?: number } = {}
    if (typeof body.usage.inputTokens === 'number') {
      usage.inputTokens = body.usage.inputTokens
    }
    if (typeof body.usage.outputTokens === 'number') {
      usage.outputTokens = body.usage.outputTokens
    }
    result.usage = usage
  }
  const gateway = isRecord(body.providerMetadata)
    ? body.providerMetadata.gateway
    : undefined
  if (isRecord(gateway)) {
    const cost = Number(gateway.cost)
    if (gateway.cost !== undefined && gateway.cost !== null && Number.isFinite(cost)) {
      result.costUsd = cost
    }
    if (typeof gateway.generationId === 'string') {
      result.generationId = gateway.generationId.slice(0, 100)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function evaluateJev(
  req: JevRequest,
  opts: JevOptions = {},
): Promise<JevResult> {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  const key = resolveKey(opts)
  if (!key) return { ok: false, reason: 'no_key', latencyMs: elapsed() }

  let payload: Record<string, unknown>
  let body: string
  try {
    if (!isRecord(req) || !isRecord(req.questions)) {
      return {
        ok: false,
        reason: 'invalid_response',
        detail: 'invalid request',
        latencyMs: elapsed(),
      }
    }
    payload = buildPayload(req, key, opts.zeroDataRetention === true)
    body = JSON.stringify(payload)
  } catch {
    return {
      ok: false,
      reason: 'invalid_response',
      detail: 'request could not be serialized',
      latencyMs: elapsed(),
    }
  }

  const useCache = opts.cache !== false
  // The payload never contains the key (it only travels in the header).
  const cacheKey = createHash('sha256').update(body).digest('hex')
  if (useCache) {
    const hit = cache.get(cacheKey)
    if (hit && hit.expiresAt > Date.now()) {
      cache.delete(cacheKey)
      cache.set(cacheKey, hit)
      return { ...hit.result, cached: true, latencyMs: elapsed() }
    }
    if (hit) cache.delete(cacheKey)
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const fail = (
    reason: FailResult['reason'],
    detail?: string,
    status?: number,
  ): FailResult => {
    const out: FailResult = { ok: false, reason, latencyMs: elapsed() }
    if (detail) out.detail = safeDetail(detail, key)
    if (status !== undefined) out.status = status
    return out
  }

  try {
    let response: Response
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) return fail('timeout')
      if (opts.signal?.aborted) return fail('network_error', 'aborted')
      return fail(
        'network_error',
        error instanceof Error ? error.message : 'request failed',
      )
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      if (timedOut) return fail('timeout')
      return fail('network_error', 'failed to read response body')
    }

    if (!response.ok) {
      return fail(
        'http_error',
        `HTTP ${response.status}${text ? `: ${text}` : ''}`,
        response.status,
      )
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail('invalid_response', 'response is not JSON')
    }
    const parsed = parseResponse(req, json)
    if (typeof parsed === 'string') return fail('invalid_response', parsed)

    const result: OkResult = { ...parsed, latencyMs: elapsed(), cached: false }
    if (useCache) {
      cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result })
      while (cache.size > CACHE_SIZE) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }
    return result
  } catch {
    return fail('network_error', 'unexpected error')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Rule A: accept a choice only when p >= minP (0.75) and the margin over the
 * best other option >= minMargin (0.15). Returns the choice or null.
 */
export function acceptChoice(
  answer: JevAnswer | undefined,
  rule: { minP?: number; minMargin?: number } = {},
): string | null {
  if (!answer || answer.type !== 'choice') return null
  const minP = rule.minP ?? RULE_A_MIN_P
  const minMargin = rule.minMargin ?? RULE_A_MIN_MARGIN
  const p = answer.probabilities[answer.choice]
  if (!isProbability(p)) return null
  let bestOther = 0
  for (const [k, v] of Object.entries(answer.probabilities)) {
    if (k !== answer.choice && v > bestOther) bestOther = v
  }
  // Small epsilon so 0.8 - 0.65 counts as a 0.15 margin despite float error.
  const EPS = 1e-9
  return p + EPS >= minP && p - bestOther + EPS >= minMargin
    ? answer.choice
    : null
}
