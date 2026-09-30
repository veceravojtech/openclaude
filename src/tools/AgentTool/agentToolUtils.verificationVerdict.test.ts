import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Load the tool graph before agentToolUtils: importing agentToolUtils first
// hits a pre-existing agentToolUtils <-> AgentTool.tsx import cycle (TDZ on
// agentToolResultSchema). Same entry order as agentToolUtils.teammateTools.test.ts.
import '../../constants/tools.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  getVerdictsDir,
  readVerdict,
} from '../../utils/verificationVerdicts.js'
import {
  type AgentToolResult,
  recordVerificationVerdictIfApplicable,
} from './agentToolUtils.js'
import { VERIFICATION_AGENT_TYPE } from './constants.js'

// Phase 1: when a built-in verification run finishes, the Agent tool parses
// the VERDICT line from its final text and records it under the verifier's
// agentId, so TaskUpdate can gate requiresVerification tasks on it. The hook
// runs inline in the Agent tool's completion paths and must never throw.

const LIST = 'verification-verdict-hook-list'

let configDir: string | undefined
let previousListId: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/agentToolUtils.verificationVerdict.test.ts',
  )
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-verdict-hook-'))
  setClaudeConfigHomeDirForTesting(configDir)
  previousListId = process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_TASK_LIST_ID = LIST
})

afterEach(() => {
  try {
    if (previousListId === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = previousListId
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

function makeResult(
  agentType: string | undefined,
  texts: string[],
  agentId = 'a0000verifier01',
): AgentToolResult {
  return {
    agentId,
    agentType,
    content: texts.map(text => ({ type: 'text' as const, text })),
    totalToolUseCount: 3,
    totalDurationMs: 1000,
    totalTokens: 100,
    usage: {
      input_tokens: 10,
      output_tokens: 90,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as AgentToolResult
}

describe('recordVerificationVerdictIfApplicable', () => {
  test('records a verification run verdict under its agentId', async () => {
    const result = makeResult(VERIFICATION_AGENT_TYPE, [
      '### Check: tests\n**Result: PASS**',
      'All good.\n\nVERDICT: PASS',
    ])

    await recordVerificationVerdictIfApplicable(result)

    expect(result.verificationVerdict).toBe('PASS')
    const record = await readVerdict('a0000verifier01', LIST)
    expect(record?.agentId).toBe('a0000verifier01')
    expect(record?.verdict).toBe('PASS')
    expect(typeof record?.recordedAt).toBe('string')
  })

  test.each(['FAIL', 'PARTIAL'] as const)(
    'records a %s verdict',
    async verdict => {
      const result = makeResult(VERIFICATION_AGENT_TYPE, [
        `Report\nVERDICT: ${verdict}`,
      ])
      await recordVerificationVerdictIfApplicable(result)
      expect(result.verificationVerdict).toBe(verdict)
      expect((await readVerdict('a0000verifier01', LIST))?.verdict).toBe(
        verdict,
      )
    },
  )

  test('a verification run without a VERDICT line records MISSING', async () => {
    const result = makeResult(VERIFICATION_AGENT_TYPE, [
      'I think it works. **VERDICT: PASS**',
    ])
    await recordVerificationVerdictIfApplicable(result)
    expect(result.verificationVerdict).toBe('MISSING')
    expect((await readVerdict('a0000verifier01', LIST))?.verdict).toBe(
      'MISSING',
    )
  })

  test('a resumed verifier re-recording replaces the earlier verdict', async () => {
    await recordVerificationVerdictIfApplicable(
      makeResult(VERIFICATION_AGENT_TYPE, ['VERDICT: FAIL']),
    )
    await recordVerificationVerdictIfApplicable(
      makeResult(VERIFICATION_AGENT_TYPE, ['fixed\nVERDICT: PASS']),
    )
    expect((await readVerdict('a0000verifier01', LIST))?.verdict).toBe('PASS')
  })

  test.each(['general-purpose', 'Explore', undefined])(
    'a non-verification agent (%p) records nothing, even with a VERDICT line',
    async agentType => {
      const result = makeResult(agentType, ['done\nVERDICT: PASS'])

      await recordVerificationVerdictIfApplicable(result)

      expect(result.verificationVerdict).toBeUndefined()
      expect(await readVerdict('a0000verifier01', LIST)).toBeUndefined()
      expect(existsSync(getVerdictsDir(LIST))).toBe(false)
    },
  )

  test('a store write failure is swallowed', async () => {
    // Put a regular file where the .verdicts directory must go, so the
    // store's mkdir/write fails.
    const verdictsDir = getVerdictsDir(LIST)
    mkdirSync(dirname(verdictsDir), { recursive: true })
    writeFileSync(verdictsDir, 'not a directory')
    const result = makeResult(VERIFICATION_AGENT_TYPE, ['VERDICT: PASS'])

    await expect(
      recordVerificationVerdictIfApplicable(result),
    ).resolves.toBeUndefined()

    expect(await readVerdict('a0000verifier01', LIST)).toBeUndefined()
  })

  test('malformed result content is swallowed', async () => {
    const result = makeResult(VERIFICATION_AGENT_TYPE, [])
    ;(result as { content: unknown }).content = null

    await expect(
      recordVerificationVerdictIfApplicable(result),
    ).resolves.toBeUndefined()
  })
})
