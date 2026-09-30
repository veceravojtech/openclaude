import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { getTasksDir } from './tasks.js'
import {
  clearVerdict,
  getVerdictPath,
  getVerdictsDir,
  parseVerdict,
  readVerdict,
  recordVerdict,
} from './verificationVerdicts.js'

describe('parseVerdict', () => {
  test.each(['PASS', 'FAIL', 'PARTIAL'] as const)('reads VERDICT: %s', v => {
    expect(parseVerdict(`Checked everything.\n\nVERDICT: ${v}`)).toBe(v)
  })

  test('the last matching line wins', () => {
    const text = [
      'Example format:',
      'VERDICT: PASS',
      'Actual run found a regression.',
      'VERDICT: FAIL',
      'Some trailing notes after the verdict.',
    ].join('\n')
    expect(parseVerdict(text)).toBe('FAIL')
  })

  test('trailing whitespace and CRLF are tolerated', () => {
    expect(parseVerdict('report\r\nVERDICT: PARTIAL  \t\r\n')).toBe('PARTIAL')
  })

  test.each([
    '**VERDICT: PASS**',
    'verdict: pass',
    'VERDICT: pass',
    'VERDICT: PASS.',
    '  VERDICT: PASS',
    '`VERDICT: PASS`',
    '> VERDICT: PASS',
    'VERDICT:PASS',
    'VERDICT: PASSED',
    'Final VERDICT: PASS',
  ])('rejects the variant %p as MISSING', line => {
    expect(parseVerdict(`report\n${line}`)).toBe('MISSING')
  })

  test('a rejected variant after a valid line does not override it', () => {
    expect(parseVerdict('VERDICT: FAIL\n**VERDICT: PASS**')).toBe('FAIL')
  })

  test('empty or verdict-less text is MISSING', () => {
    expect(parseVerdict('')).toBe('MISSING')
    expect(parseVerdict('all good, trust me')).toBe('MISSING')
  })
})

describe('verdict store', () => {
  let configDir: string | undefined
  const LIST = 'verdict-store-list'

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/verificationVerdicts.test.ts')
    configDir = mkdtempSync(join(tmpdir(), 'openclaude-verdicts-'))
    setClaudeConfigHomeDirForTesting(configDir)
  })

  afterEach(() => {
    try {
      setClaudeConfigHomeDirForTesting(undefined)
      if (configDir) rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('round-trips a verdict to <tasksDir>/.verdicts/<agentId>-<hash>.json', async () => {
    const written = await recordVerdict(
      { agentId: 'a1234abcd', verdict: 'PASS' },
      LIST,
    )
    const path = getVerdictPath('a1234abcd', LIST)
    expect(join(path, '..')).toBe(join(getTasksDir(LIST), '.verdicts'))
    expect(basename(path)).toMatch(/^a1234abcd-[0-9a-f]{12}\.json$/)

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk).toEqual({
      agentId: 'a1234abcd',
      verdict: 'PASS',
      recordedAt: written.recordedAt,
    })
    expect(Number.isNaN(Date.parse(onDisk.recordedAt))).toBe(false)
    expect(await readVerdict('a1234abcd', LIST)).toEqual(written)
    // No temp files left behind by the atomic write.
    expect(readdirSync(getVerdictsDir(LIST))).toEqual([basename(path)])
  })

  test('a later record replaces the earlier one', async () => {
    await recordVerdict({ agentId: 'a1', verdict: 'FAIL' }, LIST)
    await recordVerdict({ agentId: 'a1', verdict: 'PASS' }, LIST)
    expect((await readVerdict('a1', LIST))?.verdict).toBe('PASS')
  })

  test('an unknown agentId has no verdict', async () => {
    expect(await readVerdict('never-recorded', LIST)).toBeUndefined()
    await recordVerdict({ agentId: 'a1', verdict: 'PASS' }, LIST)
    expect(await readVerdict('a2', LIST)).toBeUndefined()
  })

  test('agentId is sanitized for the filename and cannot escape the dir', async () => {
    const nasty = '../../escape@team/x'
    await recordVerdict({ agentId: nasty, verdict: 'PARTIAL' }, LIST)
    const path = getVerdictPath(nasty, LIST)
    expect(join(path, '..')).toBe(getVerdictsDir(LIST))
    expect(basename(path)).toMatch(/^[A-Za-z0-9_-]+\.json$/)
    expect((await readVerdict(nasty, LIST))?.verdict).toBe('PARTIAL')
  })

  test('two agentIds that sanitize to the same text get separate files', async () => {
    await recordVerdict({ agentId: 'name@team', verdict: 'PASS' }, LIST)
    await recordVerdict({ agentId: 'name-team', verdict: 'FAIL' }, LIST)
    expect(getVerdictPath('name@team', LIST)).not.toBe(
      getVerdictPath('name-team', LIST),
    )
    // Neither record overwrote the other.
    expect((await readVerdict('name@team', LIST))?.verdict).toBe('PASS')
    expect((await readVerdict('name-team', LIST))?.verdict).toBe('FAIL')
    expect(readdirSync(getVerdictsDir(LIST))).toHaveLength(2)
  })

  test('a record embedding a different agentId is ignored on read', async () => {
    await recordVerdict({ agentId: 'real', verdict: 'PASS' }, LIST)
    const forgedPath = getVerdictPath('other', LIST)
    writeFileSync(
      forgedPath,
      JSON.stringify({
        agentId: 'real',
        verdict: 'PASS',
        recordedAt: new Date().toISOString(),
      }),
    )
    expect(await readVerdict('other', LIST)).toBeUndefined()
  })

  test('clearVerdict removes a record and tolerates a missing one', async () => {
    await recordVerdict({ agentId: 'a1', verdict: 'PASS' }, LIST)
    await clearVerdict('a1', LIST)
    expect(await readVerdict('a1', LIST)).toBeUndefined()
    // ENOENT (never recorded, or already cleared) is not an error.
    await clearVerdict('a1', LIST)
    await clearVerdict('never-recorded', LIST)
  })

  test('clearVerdict rejects when the record cannot be removed', async () => {
    // A directory at the record path makes unlink fail with EISDIR/EPERM,
    // not ENOENT, which must surface rather than be swallowed.
    mkdirSync(getVerdictPath('stuck', LIST), { recursive: true })
    await expect(clearVerdict('stuck', LIST)).rejects.toThrow()
  })

  test('recordVerdict rejects when the write fails', async () => {
    // A regular file where the .verdicts directory should be makes mkdir fail.
    mkdirSync(getTasksDir(LIST), { recursive: true })
    writeFileSync(getVerdictsDir(LIST), 'not a directory')
    await expect(
      recordVerdict({ agentId: 'a1', verdict: 'PASS' }, LIST),
    ).rejects.toThrow()
  })
})
