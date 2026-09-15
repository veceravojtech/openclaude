import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { filterResumableSessions } from '../commands/resume/resume.js'
import type { LogOption } from '../types/logs.js'
import { enrichLogs, readLiteMetadata } from './sessionStorage.js'
import { LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'

/** Write a session JSONL to a temp file and read its lite metadata back. */
async function readMetadata(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'lite-team-'))
  const file = join(dir, 'session.jsonl')
  try {
    writeFileSync(file, lines.join('\n') + '\n')
    const size = statSync(file).size
    return await readLiteMetadata(file, size, Buffer.alloc(LITE_READ_BUF_SIZE))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A message entry as written by insertMessageChain. `teamName` is stamped for
 * anyone in a team; `agentName` is stamped only when teamContext carries
 * selfAgentName, which is true for teammates and false for the lead.
 */
function messageLine(
  opts: { teamName?: string; agentName?: string; isSidechain?: boolean } = {},
) {
  const entry: Record<string, unknown> = {
    parentUuid: null,
    isSidechain: opts.isSidechain ?? false,
    ...(opts.teamName === undefined ? {} : { teamName: opts.teamName }),
    ...(opts.agentName === undefined ? {} : { agentName: opts.agentName }),
    type: 'user',
    message: { role: 'user', content: 'do the thing' },
    cwd: '/work/app',
  }
  return JSON.stringify(entry)
}

describe('readLiteMetadata teammate detection', () => {
  test('a lead session that created a team has no teammate name', async () => {
    // TeamCreateTool sets teamContext WITHOUT selfAgentName, so the lead's own
    // entries carry teamName alone.
    const meta = await readMetadata([messageLine({ teamName: 'examine' })])
    expect(meta.teamName).toBe('examine')
    expect(meta.teammateName).toBeUndefined()
  })

  test("a teammate's own session carries both team and agent name", async () => {
    const meta = await readMetadata([
      messageLine({ teamName: 'examine', agentName: 'researcher' }),
    ])
    expect(meta.teamName).toBe('examine')
    expect(meta.teammateName).toBe('researcher')
  })

  test('a renamed lead session is not mistaken for a teammate', async () => {
    // saveAgentName writes a standalone {"type":"agent-name"} entry for the
    // user-facing session name. An unscoped head scan would read that as the
    // teammate discriminator and filter the lead out of /resume.
    const meta = await readMetadata([
      '{"type":"agent-name","agentName":"my-refactor","sessionId":"S1"}',
      messageLine({ teamName: 'examine' }),
    ])
    expect(meta.teamName).toBe('examine')
    expect(meta.teammateName).toBeUndefined()
  })

  test('a plain session has neither', async () => {
    const meta = await readMetadata([messageLine()])
    expect(meta.teamName).toBeUndefined()
    expect(meta.teammateName).toBeUndefined()
  })
})

/** Build a lite LogOption pointing at a JSONL file written into `dir`. */
function writeLiteLog(dir: string, name: string, lines: string[]): LogOption {
  const file = join(dir, `${name}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  return {
    date: new Date().toISOString(),
    messages: [],
    fullPath: file,
    fileSize: statSync(file).size,
    value: 0,
    created: new Date(),
    modified: new Date(),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    isLite: true,
    sessionId: name,
  }
}

async function enrichAll(build: (dir: string) => LogOption[]) {
  const dir = mkdtempSync(join(tmpdir(), 'enrich-team-'))
  try {
    const logs = build(dir)
    const { logs: enriched } = await enrichLogs(logs, 0, logs.length)
    return enriched
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('enrichLogs team filtering', () => {
  test('keeps a lead session that created a team', async () => {
    // Regression: this session was dropped entirely, so a user whose long
    // session had spawned a team saw "No conversations found to resume".
    const enriched = await enrichAll(dir => [
      writeLiteLog(dir, 'lead', [messageLine({ teamName: 'examine' })]),
    ])
    expect(enriched.map(l => l.sessionId)).toEqual(['lead'])
    expect(enriched[0]!.isTeammate).toBe(false)
  })

  test("drops a teammate's own session", async () => {
    const enriched = await enrichAll(dir => [
      writeLiteLog(dir, 'mate', [
        messageLine({ teamName: 'examine', agentName: 'researcher' }),
      ]),
    ])
    expect(enriched).toEqual([])
  })

  test('keeps a plain session with no team', async () => {
    const enriched = await enrichAll(dir => [
      writeLiteLog(dir, 'plain', [messageLine()]),
    ])
    expect(enriched.map(l => l.sessionId)).toEqual(['plain'])
  })

  test('still drops sidechains', async () => {
    const enriched = await enrichAll(dir => [
      writeLiteLog(dir, 'side', [messageLine({ isSidechain: true })]),
    ])
    expect(enriched).toEqual([])
  })

  test('keeps the lead while dropping its teammates', async () => {
    const enriched = await enrichAll(dir => [
      writeLiteLog(dir, 'lead', [messageLine({ teamName: 'examine' })]),
      writeLiteLog(dir, 'mate-a', [
        messageLine({ teamName: 'examine', agentName: 'researcher' }),
      ]),
      writeLiteLog(dir, 'mate-b', [
        messageLine({ teamName: 'examine', agentName: 'tester' }),
      ]),
    ])
    expect(enriched.map(l => l.sessionId)).toEqual(['lead'])
  })
})

describe('filterResumableSessions', () => {
  const log = (sessionId: string, extra: Partial<LogOption> = {}): LogOption =>
    ({
      date: '',
      messages: [],
      value: 0,
      created: new Date(),
      modified: new Date(),
      firstPrompt: '',
      messageCount: 0,
      isSidechain: false,
      sessionId,
      ...extra,
    }) as LogOption

  test('still excludes the current session but keeps a team lead session', async () => {
    const result = filterResumableSessions(
      [log('current'), log('lead', { teamName: 'examine' })],
      'current',
    )
    expect(result.map(l => l.sessionId)).toEqual(['lead'])
  })
})
