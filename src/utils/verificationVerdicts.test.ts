import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { getTasksDir } from './tasks.js'
import {
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

  test('round-trips a verdict to <tasksDir>/.verdicts/<agentId>.json', async () => {
    const written = await recordVerdict(
      { agentId: 'a1234abcd', verdict: 'PASS' },
      LIST,
    )
    const path = getVerdictPath('a1234abcd', LIST)
    expect(path).toBe(join(getTasksDir(LIST), '.verdicts', 'a1234abcd.json'))

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk).toEqual({
      agentId: 'a1234abcd',
      verdict: 'PASS',
      recordedAt: written.recordedAt,
    })
    expect(Number.isNaN(Date.parse(onDisk.recordedAt))).toBe(false)
    expect(await readVerdict('a1234abcd', LIST)).toEqual(written)
    // No temp files left behind by the atomic write.
    expect(readdirSync(getVerdictsDir(LIST))).toEqual(['a1234abcd.json'])
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

  test('two agentIds that sanitize to the same filename do not alias', async () => {
    await recordVerdict({ agentId: 'name@team', verdict: 'PASS' }, LIST)
    // 'name-team' maps to the same file, but the stored agentId differs.
    expect(await readVerdict('name-team', LIST)).toBeUndefined()
    expect((await readVerdict('name@team', LIST))?.verdict).toBe('PASS')
  })
})
