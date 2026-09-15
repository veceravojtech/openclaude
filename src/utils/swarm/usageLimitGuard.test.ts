import { beforeEach, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  clearCannotProceed,
  endedInApiError,
  findUsageLimitNotice,
  isCannotProceed,
  markCannotProceed,
  shouldReportUsageLimit,
} from './usageLimitGuard.js'

// The guard's whole job is to keep ONE account-wide condition from turning
// into N teammates x M turns worth of lead-bound messages, while still
// letting the lead hear it once — including the reset time, which is the only
// actionable part. Both halves are pinned here; dropping either is the bug.

/** Verbatim shape of what services/rateLimitMessages.ts produces. */
const OUT_OF_USAGE = "You're out of extra usage · resets 3pm"
const OUT_OF_USAGE_LATER = "You're out of extra usage · resets 9pm"

function assistantMessage(
  text: string,
  options: { apiError: boolean },
): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${text}-${options.apiError}`,
    timestamp: new Date().toISOString(),
    ...(options.apiError ? { isApiErrorMessage: true } : {}),
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  } as unknown as Message
}

beforeEach(() => {
  // Module-level by necessity, so it outlives any one test.
  clearCannotProceed()
})

test('a usage-limit turn is recognised, with the reset time intact', () => {
  const notice = findUsageLimitNotice([
    assistantMessage('working on it', { apiError: false }),
    assistantMessage(OUT_OF_USAGE, { apiError: true }),
  ])

  expect(notice).toBe(OUT_OF_USAGE)
  // The reset time is the actionable half of the report. Truncating the
  // notice to a category ("usage limit") would strip it.
  expect(notice).toContain('resets 3pm')
})

test('an ordinary assistant turn is not mistaken for a limit', () => {
  expect(
    findUsageLimitNotice([
      assistantMessage('all done', { apiError: false }),
      assistantMessage("You're out of extra usage · resets 3pm", {
        apiError: false,
      }),
    ]),
  ).toBeUndefined()
})

test('a non-limit API error is not mistaken for a limit', () => {
  // Fails the turn, but the account can still proceed — stopping every
  // teammate on a 500 would be a far worse bug than the one being fixed.
  expect(
    findUsageLimitNotice([
      assistantMessage('API Error: 500 Internal Server Error', {
        apiError: true,
      }),
    ]),
  ).toBeUndefined()
})

test('the lead is told once per limit, however many teammates hit it', () => {
  // Five teammates, one account-wide limit, one message.
  const sends = [
    shouldReportUsageLimit(OUT_OF_USAGE),
    shouldReportUsageLimit(OUT_OF_USAGE),
    shouldReportUsageLimit(OUT_OF_USAGE),
    shouldReportUsageLimit(OUT_OF_USAGE),
    shouldReportUsageLimit(OUT_OF_USAGE),
  ]

  expect(sends).toEqual([true, false, false, false, false])
  expect(sends.filter(Boolean)).toHaveLength(1)
})

test('repeated turns hitting the same limit report nothing further', () => {
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)
  for (let turn = 0; turn < 50; turn++) {
    expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(false)
  }
})

test('a different limit is news, and is reported again', () => {
  // Keyed on the notice, not on a boolean: a new reset time is information
  // the lead does not have, so swallowing it as a duplicate is wrong.
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)
  expect(shouldReportUsageLimit(OUT_OF_USAGE_LATER)).toBe(true)
  expect(shouldReportUsageLimit(OUT_OF_USAGE_LATER)).toBe(false)
})

test('the stop marker gates work until it is lifted', () => {
  expect(isCannotProceed()).toBe(false)

  markCannotProceed(OUT_OF_USAGE)

  expect(isCannotProceed()).toBe(true)
})

test('a successful turn lifts the stop and re-arms reporting', () => {
  markCannotProceed(OUT_OF_USAGE)
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)

  clearCannotProceed()

  expect(isCannotProceed()).toBe(false)
  // Usage came back and then ran out again: that is a NEW outage, and the
  // lead should not have it suppressed by the record of the old one.
  expect(shouldReportUsageLimit(OUT_OF_USAGE)).toBe(true)
})

test('endedInApiError covers the failure class, not just usage limits', () => {
  expect(
    endedInApiError([assistantMessage('all done', { apiError: false })]),
  ).toBe(false)
  expect(
    endedInApiError([
      assistantMessage('all done', { apiError: false }),
      assistantMessage('API Error: 529 Overloaded', { apiError: true }),
    ]),
  ).toBe(true)
})
