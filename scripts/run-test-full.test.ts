import { spawn } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import {
  CONVERSATION_ARC_STEP,
  SWEEP_STEP,
  TEST_FULL_STEPS,
  evaluateStep,
  killProcessGroup,
  parseBunTestSummary,
  runStep,
  stepSpawnOptions,
  stripAnsi,
  toLines,
  type StepOutcome,
} from './run-test-full'

/**
 * Pure unit tests for the `test:full` guard's summary parser and verdict logic. Nothing
 * here spawns a test run: every fixture is captured output text, so the whole suite is
 * instant and safe to execute from inside the very sweep it guards. (The
 * process-group block at the bottom does spawn - but only `bash -c sleep`/`true`, never a
 * test run, and it kills what it starts.)
 *
 * Fixtures are verbatim shapes emitted by bun 1.3.9 on this repo (including the singular
 * `Ran 1 test across 1 file.` form and the stderr-only summary block).
 */

/** A child that exited normally with `code`. */
function exited(code: number): StepOutcome {
  return { exitCode: code, signal: null }
}

const ESC = '\u001B'

/**
 * Control bytes as ESCAPES, never as literal bytes. A raw NUL in this source would make the
 * file `data` to file(1) and invisible to a plain `grep`, which silently breaks the repo's
 * source-scanning guard tests and anyone verifying this file.
 */
const CONTROL_GARBAGE = '\u0000\u0001'

/** A clean pass, with every optional count line present. */
const CLEAN_PASS = [
  'bun test v1.3.9 (cf6cdbbb)',
  '',
  ' 1 pass',
  ' 1 skip',
  ' 1 todo',
  ' 0 fail',
  ' 1 expect() calls',
  'Ran 3 tests across 1 file. [5.00ms]',
  '',
].join('\n')

/** One failing assertion, with bun's error block above the summary. */
const ONE_FAILURE = [
  'bun test v1.3.9 (cf6cdbbb)',
  '',
  'bad.test.ts:',
  '1 | import { expect, test } from "bun:test"',
  'error: expect(received).toBe(expected)',
  '(fail) this one fails on purpose',
  '',
  ' 1 pass',
  ' 1 fail',
  ' 2 expect() calls',
  'Ran 2 tests across 1 file. [5.00ms]',
  '',
].join('\n')

/**
 * THE BUG: 64 `(fail)` lines and then nothing - no count block, no `Ran` line - while the
 * child still exits 0. The old `&&` chain read this as success.
 */
const NO_SUMMARY = [
  'bun test v1.3.9 (cf6cdbbb)',
  '',
  'src/memdir/autoExtractFacts.test.ts:',
  '(fail) extracts facts from a transcript',
  '(fail) dedupes repeated facts',
  'src/components/ExportDialog.test.tsx:',
  '(fail) renders the export dialog',
  '',
].join('\n')

describe('stripAnsi / toLines', () => {
  test('strips CSI colour sequences', () => {
    expect(stripAnsi(`${ESC}[0m${ESC}[31m 5 fail${ESC}[0m`)).toBe(' 5 fail')
  })

  test('treats a bare carriage return as a line break so PTY progress cannot hide the summary', () => {
    expect(toLines('a\rb\r\nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseBunTestSummary', () => {
  test('reads a clean pass summary including skip and todo', () => {
    const summary = parseBunTestSummary(CLEAN_PASS)
    expect(summary).toBeDefined()
    expect(summary?.counts).toEqual({ pass: 1, fail: 0, skip: 1, todo: 1 })
    expect(summary?.tests).toBe(3)
    expect(summary?.files).toBe(1)
    expect(summary?.reportedLabels).toEqual(['pass', 'skip', 'todo', 'fail'])
    expect(summary?.otherLabels).toEqual(['1 expect() calls'])
  })

  test('reads a non-zero fail count', () => {
    expect(parseBunTestSummary(ONE_FAILURE)?.counts.fail).toBe(1)
  })

  test('returns undefined when no summary line was emitted at all', () => {
    expect(parseBunTestSummary(NO_SUMMARY)).toBeUndefined()
  })

  test('returns undefined for truncated and garbage output', () => {
    expect(parseBunTestSummary('')).toBeUndefined()
    expect(parseBunTestSummary('Ran 12 tes')).toBeUndefined()
    expect(parseBunTestSummary(`${CONTROL_GARBAGE} not test output at all`)).toBeUndefined()
    expect(parseBunTestSummary(' 12 pass\n 3 fail')).toBeUndefined()
  })

  test('parses an ANSI-coloured summary exactly like a plain one', () => {
    const coloured = [
      `${ESC}[0m${ESC}[32m 1 pass${ESC}[0m`,
      `${ESC}[0m${ESC}[31m 1 fail${ESC}[0m`,
      ' 2 expect() calls',
      `Ran 2 tests across 1 file. ${ESC}[0m${ESC}[2m[${ESC}[1m6.00ms${ESC}[0m${ESC}[2m]${ESC}[0m`,
    ].join('\n')
    expect(parseBunTestSummary(coloured)?.counts).toEqual({ pass: 1, fail: 1, skip: 0, todo: 0 })
  })

  test('finds a summary followed by trailing output', () => {
    const trailing = `${ONE_FAILURE}\nerror: script "test" exited with code 1\nsome epilogue\n`
    expect(parseBunTestSummary(trailing)?.counts.fail).toBe(1)
  })

  test('uses the LAST summary when the output contains more than one', () => {
    const twice = `${CLEAN_PASS}\n${ONE_FAILURE}`
    expect(parseBunTestSummary(twice)?.counts.fail).toBe(1)
  })

  test('accepts the singular "Ran 1 test across 1 file." form', () => {
    const summary = parseBunTestSummary(' 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]')
    expect(summary?.tests).toBe(1)
    expect(summary?.files).toBe(1)
  })

  test('keeps non-test categories out of the counts but records them', () => {
    const filtered = [
      ' 1 pass',
      ' 2 filtered out',
      ' 0 fail',
      ' 1 expect() calls',
      'Ran 1 test across 1 file. [6.00ms]',
    ].join('\n')
    const summary = parseBunTestSummary(filtered)
    expect(summary?.counts).toEqual({ pass: 1, fail: 0, skip: 0, todo: 0 })
    expect(summary?.otherLabels).toEqual(['2 filtered out', '1 expect() calls'])
  })

  test('stops the count-block walk at the first non-count line', () => {
    const noisy = ['(fail) 3 things went wrong', '', ' 4 pass', 'Ran 4 tests across 2 files.'].join(
      '\n',
    )
    expect(parseBunTestSummary(noisy)?.otherLabels).toEqual([])
  })
})

describe('evaluateStep', () => {
  test('passes a clean run that exited 0', () => {
    const verdict = evaluateStep(SWEEP_STEP, CLEAN_PASS, exited(0))
    expect(verdict.ok).toBe(true)
    expect(verdict.exitCode).toBe(0)
    expect(verdict.reasons).toEqual([])
    expect(verdict.message).toContain('unit sweep OK')
  })

  test('THE BUG: failures with no summary and exit 0 is a FAILURE', () => {
    const verdict = evaluateStep(SWEEP_STEP, NO_SUMMARY, exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(1)
    expect(verdict.reasons).toContain('no-summary')
    expect(verdict.message).toContain('A1 SUMMARY')
    expect(verdict.message).toContain('child exit 0')
  })

  test('empty output and exit 0 is a FAILURE', () => {
    const verdict = evaluateStep(SWEEP_STEP, '', exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('no-summary')
  })

  test('a reported fail count fails and keeps the child exit code', () => {
    const verdict = evaluateStep(SWEEP_STEP, ONE_FAILURE, exited(1))
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(1)
    expect(verdict.reasons).toContain('reported-failures')
    expect(verdict.message).toContain('A2 NO FAILURES')
  })

  test('a reported fail count fails even when the child claims success', () => {
    const verdict = evaluateStep(SWEEP_STEP, ONE_FAILURE, exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(1)
    expect(verdict.reasons).toContain('reported-failures')
  })

  test('a non-zero child exit fails even with a clean-looking summary', () => {
    const verdict = evaluateStep(SWEEP_STEP, CLEAN_PASS, exited(7))
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(7)
    expect(verdict.reasons).toContain('child-exit')
    expect(verdict.message).toContain('A5 CLEAN EXIT')
  })

  test('a child killed by a signal fails', () => {
    const verdict = evaluateStep(SWEEP_STEP, CLEAN_PASS, { exitCode: null, signal: 'SIGSEGV' })
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(1)
    expect(verdict.reasons).toContain('signal')
    expect(verdict.message).toContain('SIGSEGV')
  })

  test('a spawn failure fails', () => {
    const verdict = evaluateStep(SWEEP_STEP, '', {
      exitCode: null,
      signal: null,
      spawnError: 'spawn bun ENOENT',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('spawn-failed')
    expect(verdict.message).toContain('ENOENT')
  })

  test('a summary reporting zero tests fails instead of passing vacuously', () => {
    const verdict = evaluateStep(SWEEP_STEP, ' 0 pass\n 0 fail\nRan 0 tests across 0 files.', exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('no-tests')
    expect(verdict.message).toContain('A4 NON-EMPTY')
  })

  test('an omitted fail line is accepted only when the counts reconcile', () => {
    const verdict = evaluateStep(SWEEP_STEP, ' 3 pass\nRan 3 tests across 1 file.', exited(0))
    expect(verdict.ok).toBe(true)
    expect(verdict.summary?.reportedLabels).toEqual(['pass'])
  })

  test('counts that do not add up to the reported total fail', () => {
    const verdict = evaluateStep(SWEEP_STEP, ' 40 pass\nRan 100 tests across 12 files.', exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('unreconciled-summary')
    expect(verdict.message).toContain('A3 RECONCILED')
  })

  test('A6: a skip-only arc run FAILS instead of passing on a test that never executed', () => {
    // The exact shape bun prints when `--feature=CONVERSATION_ARC` does not reach
    // src/query.conversationArc.test.ts and its `test` degrades to `test.skip`.
    const skippedArc = [
      'bun test v1.3.9 (cf6cdbbb)',
      '',
      ' 0 pass',
      ' 1 skip',
      ' 0 fail',
      'Ran 1 test across 1 file. [30.00ms]',
    ].join('\n')
    const verdict = evaluateStep(CONVERSATION_ARC_STEP, skippedArc, exited(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.exitCode).toBe(1)
    expect(verdict.reasons).toContain('below-min-passing')
    expect(verdict.message).toContain('A6 MIN PASSING')
    // A1-A5 all held - only A6 caught it, which is the point of the assertion.
    expect(verdict.reasons).toEqual(['below-min-passing'])
  })

  test('A6: a genuine 1 pass / 0 fail arc run passes', () => {
    const passingArc = [
      ' 1 pass',
      ' 0 fail',
      ' 9 expect() calls',
      'Ran 1 test across 1 file. [511.00ms]',
    ].join('\n')
    const verdict = evaluateStep(CONVERSATION_ARC_STEP, passingArc, exited(0))
    expect(verdict.ok).toBe(true)
    expect(verdict.exitCode).toBe(0)
    expect(verdict.reasons).toEqual([])
    expect(verdict.message).toContain('conversation-arc OK')
  })

  test('A6 applies only to steps that declare minPassing - the sweep is unaffected', () => {
    const allSkipped = [' 0 pass', ' 1 skip', ' 0 fail', 'Ran 1 test across 1 file.'].join('\n')
    const verdict = evaluateStep(SWEEP_STEP, allSkipped, exited(0))
    expect(verdict.ok).toBe(true)
    expect(verdict.reasons).toEqual([])
  })

  test('A6 does not mask the other assertions on the same step', () => {
    const failingArc = [' 0 pass', ' 1 fail', 'Ran 1 test across 1 file.'].join('\n')
    const verdict = evaluateStep(CONVERSATION_ARC_STEP, failingArc, exited(1))
    expect(verdict.reasons).toEqual(['reported-failures', 'below-min-passing', 'child-exit'])
    expect(verdict.message).toContain('A2 NO FAILURES')
    expect(verdict.message).toContain('A6 MIN PASSING')
  })

  test('the failure diagnostic always names the step and quotes what was parsed', () => {
    const verdict = evaluateStep(CONVERSATION_ARC_STEP, NO_SUMMARY, exited(0))
    expect(verdict.message).toContain('conversation-arc')
    expect(verdict.message).toContain('bun run test:conversation-arc')
    expect(verdict.message).toContain('parsed summary: (none')
  })
})

describe('step specs', () => {
  test('the sweep step is verbatim the command test:full used to run first', () => {
    expect(SWEEP_STEP.command.join(' ')).toBe(
      'bun test --feature=UNATTENDED_RETRY --max-concurrency=1',
    )
  })

  test('the arc step still resolves through package.json', () => {
    expect(CONVERSATION_ARC_STEP.command.join(' ')).toBe('bun run test:conversation-arc')
  })

  test('the arc step must report at least one PASSING test', () => {
    expect(CONVERSATION_ARC_STEP.minPassing).toBe(1)
    expect(SWEEP_STEP.minPassing).toBeUndefined()
  })

  test('test:full keeps its two phases, sweep first', () => {
    expect(TEST_FULL_STEPS).toEqual([SWEEP_STEP, CONVERSATION_ARC_STEP])
  })
})

/**
 * The orphan guard. `runStep` used to spawn without `detached`, so killing this wrapper
 * left the `bun test` grandchild reparented to init and running - once at 98.9% CPU and
 * 15.7 GB resident for 3h36m. These cover the two halves of the fix that CAN be asserted
 * honestly in-process: that the kill helper aims at a process GROUP (and refuses the pids
 * that would turn that into friendly fire), and that a real child spawned with these
 * options genuinely leads its own group and dies with it. The end-to-end proof - a real
 * bounded run killed mid-flight leaving nothing behind - is empirical and lives in the
 * task report; it cannot be asserted from inside the suite it would have to kill.
 */
describe('process-group termination', () => {
  test('signals the NEGATIVE pid - the group, not just the leader', () => {
    const calls: Array<[number, NodeJS.Signals]> = []
    const delivered = killProcessGroup(4321, 'SIGTERM', (target, signal) => {
      calls.push([target, signal])
    })

    expect(delivered).toBe(true)
    expect(calls).toEqual([[-4321, 'SIGTERM']])
  })

  test('a vanished group is not an error - ESRCH is the normal path', () => {
    const delivered = killProcessGroup(4321, 'SIGKILL', () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })

    expect(delivered).toBe(false)
  })

  test('refuses the pids that would turn a group kill into friendly fire', () => {
    const calls: number[] = []
    const record = (target: number): void => {
      calls.push(target)
    }

    // undefined: spawn never produced a pid. 0: signals our OWN group. 1: signals every
    // process we can reach. Both of the latter would be far worse than the orphan.
    for (const pid of [undefined, 0, 1, -9, 12.5]) {
      expect(killProcessGroup(pid, 'SIGKILL', record)).toBe(false)
    }

    expect(calls).toEqual([])
  })

  test('steps spawn detached, so the child is a group leader', () => {
    expect(stepSpawnOptions(SWEEP_STEP).detached).toBe(true)
  })

  test('stdin is ignored, never inherited - a detached reader would SIGTTIN and stop', () => {
    expect(stepSpawnOptions(SWEEP_STEP).stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  test('per-step env is still layered over process.env', () => {
    const layered = stepSpawnOptions({ ...SWEEP_STEP, env: { MARKER: 'yes' } })
      .env as NodeJS.ProcessEnv

    expect(layered.MARKER).toBe('yes')
    expect(layered.PATH).toBe(process.env.PATH)
    expect(stepSpawnOptions(SWEEP_STEP).env).toBe(process.env)
  })

  test('a child spawned with these options leads a real, killable process group', async () => {
    const child = spawn('bash', ['-c', 'sleep 30'], stepSpawnOptions(SWEEP_STEP))
    await new Promise(resolve => child.once('spawn', resolve))
    const pid = child.pid

    expect(pid).toBeDefined()
    // The negative pid RESOLVES: a process group led by the child exists. Without
    // `detached` the child would sit in this process's group and -pid would be ESRCH.
    expect(() => process.kill(-(pid as number), 0)).not.toThrow()

    expect(killProcessGroup(pid, 'SIGKILL')).toBe(true)
    await new Promise(resolve => child.once('close', resolve))

    // ...and the group went with it.
    expect(() => process.kill(-(pid as number), 0)).toThrow()
  })

  test('a completed step leaves no signal listeners behind', async () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      exit: process.listenerCount('exit'),
    }

    await runStep({ name: 'noop', command: ['bash', '-c', 'true'] })
    await runStep({ name: 'noop again', command: ['bash', '-c', 'true'] })

    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(process.listenerCount('exit')).toBe(before.exit)
  })
})
