import { expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import {
  createIdleNotification,
  formatTeammateReportResult,
  getTeammateTurnReport,
  isIdleNotification,
  REPORTED_TO_LEAD_RESULT,
  TEAMMATE_REPORT_MAX_CHARS,
  truncateTeammateReport,
} from './teammateMailbox.js'

function user(content: unknown): Message {
  return {
    type: 'user',
    uuid: `u-${Math.random()}`,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  } as unknown as Message
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}): Message {
  return {
    type: 'assistant',
    uuid: `a-${Math.random()}`,
    timestamp: new Date().toISOString(),
    message: { id: 'm', role: 'assistant', content },
    ...extra,
  } as unknown as Message
}

function sendMessage(id: string, to: string, message: unknown) {
  return { type: 'tool_use', id, name: 'SendMessage', input: { to, message, summary: 's' } }
}

function result(id: string, success: boolean) {
  return user([
    {
      type: 'tool_result',
      tool_use_id: id,
      content: [{ type: 'text', text: JSON.stringify({ success, message: 'x' }) }],
    },
  ])
}

test('an idle notification with lastAssistantText round-trips through the mailbox JSON', () => {
  const text = JSON.stringify(
    createIdleNotification('worker', {
      idleReason: 'available',
      lastAssistantText: 'Done: fixed the parser.',
    }),
  )
  const parsed = isIdleNotification(text)
  expect(parsed?.lastAssistantText).toBe('Done: fixed the parser.')
  expect(parsed?.reportedToLead).toBeUndefined()
  // Older readers see an ordinary idle notification.
  expect(parsed).toMatchObject({ type: 'idle_notification', from: 'worker', idleReason: 'available' })
})

test('reportedToLead round-trips and suppresses the text', () => {
  const text = JSON.stringify(
    createIdleNotification('worker', {
      idleReason: 'available',
      lastAssistantText: 'The same report again.',
      reportedToLead: true,
    }),
  )
  const parsed = isIdleNotification(text)
  expect(parsed?.reportedToLead).toBe(true)
  expect(parsed?.lastAssistantText).toBeUndefined()
  expect(text).not.toContain('The same report again.')
})

test('a notification without a report carries neither field', () => {
  const text = JSON.stringify(createIdleNotification('worker', { idleReason: 'available' }))
  expect(text).not.toContain('lastAssistantText')
  expect(text).not.toContain('reportedToLead')
})

test('text over 8192 chars is cut with a marker; short text is unchanged', () => {
  expect(TEAMMATE_REPORT_MAX_CHARS).toBe(8192)
  const short = 'x'.repeat(8192)
  expect(truncateTeammateReport(short)).toBe(short)

  const long = 'y'.repeat(10_000)
  const cut = truncateTeammateReport(long)
  expect(cut).toBe(`${'y'.repeat(8192)}\n[truncated: 1808 more chars]`)
  // Idempotent: truncating again does not stack a second marker.
  expect(truncateTeammateReport(cut)).toBe(cut)

  // The idle notification applies it.
  const parsed = isIdleNotification(
    JSON.stringify(createIdleNotification('w', { lastAssistantText: long })),
  )
  expect(parsed?.lastAssistantText).toBe(cut)
})

test('truncation never splits a surrogate pair', () => {
  const text = `${'a'.repeat(8191)}😀tail`
  const cut = truncateTeammateReport(text)
  expect(cut.startsWith('a'.repeat(8191) + '\n')).toBe(true)
  expect(cut).toContain('[truncated: 6 more chars]')
})

test('the turn report takes the last assistant text of the latest turn only', () => {
  const report = getTeammateTurnReport([
    user('first task'),
    assistant([{ type: 'text', text: 'old report' }]),
    user('second task'),
    assistant([{ type: 'text', text: 'working' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    assistant([{ type: 'text', text: 'final report' }]),
    assistant([{ type: 'text', text: 'API Error: 500' }], { isApiErrorMessage: true }),
  ])
  expect(report).toEqual({ lastAssistantText: 'final report' })
})

test('dedupe: a successful plain-text SendMessage to the lead sets reportedToLead', () => {
  const messages = [
    user('task'),
    assistant([sendMessage('s1', 'team-lead', 'here is my report')]),
    result('s1', true),
    assistant([{ type: 'text', text: 'Sent my report.' }]),
  ]
  const report = getTeammateTurnReport(messages)
  expect(report.reportedToLead).toBe(true)
  expect(formatTeammateReportResult(report)).toBe(REPORTED_TO_LEAD_RESULT)
  // A lead with a custom name is recognised too, bare and qualified.
  expect(
    getTeammateTurnReport(
      [user('t'), assistant([sendMessage('s2', 'Boss@proj', 'r')]), result('s2', true)],
      'boss',
      'proj',
    ).reportedToLead,
  ).toBe(true)
})

test('dedupe does not fire for failed sends, peer DMs, structured messages or earlier turns', () => {
  const cases: Message[][] = [
    [user('t'), assistant([sendMessage('a', 'team-lead', 'r')]), result('a', false)],
    [user('t'), assistant([sendMessage('b', 'peer', 'r')]), result('b', true)],
    [
      user('t'),
      assistant([sendMessage('c', 'team-lead', { type: 'shutdown_response', request_id: 'x', approve: true })]),
      result('c', true),
    ],
    [
      user('old'),
      assistant([sendMessage('d', 'team-lead', 'r')]),
      result('d', true),
      user('new task'),
    ],
  ]
  for (const messages of cases) {
    expect(getTeammateTurnReport(messages).reportedToLead).toBeUndefined()
  }
})
