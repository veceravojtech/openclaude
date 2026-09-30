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
import { getTasksDir } from '../../utils/tasks.js'
import { checkVerificationGateIn } from '../../utils/verificationVerdictStore.js'
import {
  getVerdictPath,
  getVerdictsDir,
  readVerdict,
  recordVerdict,
} from '../../utils/verificationVerdicts.js'
import {
  type AgentToolResult,
  clearVerificationVerdictBeforeRun,
  formatVerificationVerdictLine,
  recordVerificationVerdictIfApplicable,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import { VERIFICATION_AGENT_TYPE } from './constants.js'

// Phase 1: when a built-in verification run finishes, the Agent tool parses
// the VERDICT line from its final text and records it under the verifier's
// agentId, so a requiresVerification task can be gated on it. The hook runs
// inline in the Agent tool's completion paths and must never throw.

const LIST = 'verification-verdict-hook-list'
const BUILT_IN = { isBuiltInAgent: true }
const VERIFIER_ID = 'a0000verifier01'

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
  agentId = VERIFIER_ID,
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

    await recordVerificationVerdictIfApplicable(result, BUILT_IN)

    expect(result.verificationVerdict).toBe('PASS')
    expect(result.verificationVerdictRecorded).toBe(true)
    const record = await readVerdict(VERIFIER_ID, LIST)
    expect(record?.agentId).toBe(VERIFIER_ID)
    expect(record?.verdict).toBe('PASS')
    expect(typeof record?.recordedAt).toBe('string')
    expect(formatVerificationVerdictLine(result)).toContain(
      `verificationVerdict: PASS (recorded for this agentId; to complete a task with requiresVerification, set metadata.verifiedBy: '${VERIFIER_ID}'`,
    )
  })

  test.each(['FAIL', 'PARTIAL'] as const)(
    'records a %s verdict',
    async verdict => {
      const result = makeResult(VERIFICATION_AGENT_TYPE, [
        `Report\nVERDICT: ${verdict}`,
      ])
      await recordVerificationVerdictIfApplicable(result, BUILT_IN)
      expect(result.verificationVerdict).toBe(verdict)
      expect((await readVerdict(VERIFIER_ID, LIST))?.verdict).toBe(verdict)
    },
  )

  test('a verification run without a VERDICT line records MISSING', async () => {
    const result = makeResult(VERIFICATION_AGENT_TYPE, [
      'I think it works. **VERDICT: PASS**',
    ])
    await recordVerificationVerdictIfApplicable(result, BUILT_IN)
    expect(result.verificationVerdict).toBe('MISSING')
    expect((await readVerdict(VERIFIER_ID, LIST))?.verdict).toBe('MISSING')
  })

  test.each(['general-purpose', 'Explore', undefined])(
    'a non-verification agent (%p) records nothing, even with a VERDICT line',
    async agentType => {
      const result = makeResult(agentType, ['done\nVERDICT: PASS'])

      await recordVerificationVerdictIfApplicable(result, BUILT_IN)

      expect(result.verificationVerdict).toBeUndefined()
      expect(formatVerificationVerdictLine(result)).toBeUndefined()
      expect(await readVerdict(VERIFIER_ID, LIST)).toBeUndefined()
      expect(existsSync(getVerdictsDir(LIST))).toBe(false)
    },
  )

  test('a project/user/plugin agent overriding "verification" records nothing', async () => {
    // loadAgentsDir lets a custom agent take over a built-in's name; its
    // agentType is 'verification' but it is not the built-in and could have
    // write access, so it must not be able to mint a PASS.
    const result = makeResult(VERIFICATION_AGENT_TYPE, ['VERDICT: PASS'])

    await recordVerificationVerdictIfApplicable(result, {
      isBuiltInAgent: false,
    })

    expect(result.verificationVerdict).toBeUndefined()
    expect(await readVerdict(VERIFIER_ID, LIST)).toBeUndefined()
    expect(existsSync(getVerdictsDir(LIST))).toBe(false)
  })

  test('a store write failure is swallowed and reported as NOT recorded', async () => {
    // Put a regular file where the .verdicts directory must go, so the
    // store's mkdir/write fails.
    const verdictsDir = getVerdictsDir(LIST)
    mkdirSync(dirname(verdictsDir), { recursive: true })
    writeFileSync(verdictsDir, 'not a directory')
    const result = makeResult(VERIFICATION_AGENT_TYPE, ['VERDICT: PASS'])

    await expect(
      recordVerificationVerdictIfApplicable(result, BUILT_IN),
    ).resolves.toBeUndefined()

    expect(result.verificationVerdict).toBe('PASS')
    expect(result.verificationVerdictRecorded).toBe(false)
    expect(result.verificationVerdictError).toBeTruthy()
    const line = formatVerificationVerdictLine(result)
    expect(line).toContain('verificationVerdict: PASS (NOT recorded:')
    expect(line).not.toContain('(recorded for this agentId')
    expect(await readVerdict(VERIFIER_ID, LIST)).toBeUndefined()
  })

  test('malformed result content is swallowed', async () => {
    const result = makeResult(VERIFICATION_AGENT_TYPE, [])
    ;(result as { content: unknown }).content = null

    await expect(
      recordVerificationVerdictIfApplicable(result, BUILT_IN),
    ).resolves.toBeUndefined()
    expect(result.verificationVerdictRecorded).toBe(false)
  })
})

describe('clearVerificationVerdictBeforeRun', () => {
  const identity = { agentType: VERIFICATION_AGENT_TYPE, isBuiltInAgent: true }

  test('removes an existing record for a built-in verifier', async () => {
    await recordVerdict({ agentId: VERIFIER_ID, verdict: 'PASS' }, LIST)

    await clearVerificationVerdictBeforeRun(VERIFIER_ID, identity)

    expect(await readVerdict(VERIFIER_ID, LIST)).toBeUndefined()
  })

  test('is a no-op when there is no record', async () => {
    await expect(
      clearVerificationVerdictBeforeRun(VERIFIER_ID, identity),
    ).resolves.toBeUndefined()
  })

  test.each([
    { agentType: 'general-purpose', isBuiltInAgent: true },
    { agentType: VERIFICATION_AGENT_TYPE, isBuiltInAgent: false },
  ])('leaves records alone for other agents (%p)', async other => {
    await recordVerdict({ agentId: VERIFIER_ID, verdict: 'PASS' }, LIST)
    await clearVerificationVerdictBeforeRun(VERIFIER_ID, other)
    expect((await readVerdict(VERIFIER_ID, LIST))?.verdict).toBe('PASS')
  })

  test('throws a clear error when a stale record cannot be removed', async () => {
    // A directory at the record path makes unlink fail with a non-ENOENT
    // error (EISDIR/EPERM), even when running as root.
    mkdirSync(getVerdictPath(VERIFIER_ID, LIST), { recursive: true })

    await expect(
      clearVerificationVerdictBeforeRun(VERIFIER_ID, identity),
    ).rejects.toThrow(
      /Refusing to run while a possibly stale verdict is on file/,
    )
  })

  test('prior PASS + a replacement run whose write fails -> the gate blocks', async () => {
    // A resumed verifier previously recorded PASS.
    await recordVerdict({ agentId: VERIFIER_ID, verdict: 'PASS' }, LIST)

    // The resume clears the old record before the run starts...
    await clearVerificationVerdictBeforeRun(VERIFIER_ID, identity)
    // ...the run then finds a regression, but recording FAIL fails (a
    // directory now occupies the record path, so the rename fails).
    mkdirSync(getVerdictPath(VERIFIER_ID, LIST), { recursive: true })
    const result = makeResult(VERIFICATION_AGENT_TYPE, ['VERDICT: FAIL'])
    await recordVerificationVerdictIfApplicable(result, BUILT_IN)
    expect(result.verificationVerdictRecorded).toBe(false)

    // The old PASS is gone, so a task citing this verifier cannot complete.
    const metadata = { requiresVerification: true, verifiedBy: VERIFIER_ID }
    const gateError = await checkVerificationGateIn(
      getTasksDir(LIST),
      metadata,
      metadata,
    )
    expect(gateError).toContain(
      `no verdict was recorded for verifier '${VERIFIER_ID}'`,
    )
  })
})

// Drives the real async lifecycle (AgentTool's async path and
// resumeAgentBackground both use it) with a scripted message stream.
describe('runAsyncAgentLifecycle verdict wiring', () => {
  const TASK_ID = VERIFIER_ID

  function assistant(text: string) {
    return {
      type: 'assistant',
      uuid: `assistant-${Math.random()}`,
      message: {
        id: `msg-${Math.random()}`,
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  }

  type Observation = { status: string; verdictOnFile: boolean }

  async function runLifecycle(
    stream: () => AsyncGenerator<unknown, void>,
    isBuiltInAgent = true,
  ): Promise<Observation[]> {
    const task = {
      type: 'local_agent',
      id: TASK_ID,
      agentId: TASK_ID,
      status: 'running',
      description: 'verify',
      prompt: 'verify it',
      startTime: Date.now(),
      notified: false,
      retain: false,
      messages: [],
    }
    let state: Record<string, unknown> = {
      tasks: { [TASK_ID]: task },
      toolPermissionContext: { mode: 'default' },
      // Read by abortSpeculation when a failure notification is enqueued.
      speculation: { status: 'idle' },
    }
    const statusOf = () =>
      (state.tasks as Record<string, { status: string } | undefined>)[TASK_ID]
        ?.status
    // Verdict-file state at the moment the task turns terminal, i.e. when
    // completion is signalled to anything waiting on it.
    const observed: Observation[] = []
    const rootSetAppState = (f: (prev: never) => unknown) => {
      const before = statusOf()
      state = f(state as never) as Record<string, unknown>
      const after = statusOf()
      if (after && after !== before && after !== 'running') {
        observed.push({
          status: after,
          verdictOnFile: existsSync(getVerdictPath(TASK_ID, LIST)),
        })
      }
    }

    await runAsyncAgentLifecycle({
      taskId: TASK_ID,
      abortController: new AbortController(),
      makeStream: stream as never,
      metadata: {
        prompt: 'verify it',
        resolvedAgentModel: 'test-model',
        isBuiltInAgent,
        startTime: Date.now(),
        agentType: VERIFICATION_AGENT_TYPE,
        isAsync: true,
      },
      description: 'verify',
      toolUseContext: {
        options: { tools: [] },
        getAppState: () => state,
        toolUseId: 'toolu_verify',
      } as never,
      rootSetAppState: rootSetAppState as never,
      agentIdForCleanup: TASK_ID,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })
    return observed
  }

  test('the verdict is on file before the completion transition', async () => {
    const observed = await runLifecycle(async function* () {
      yield assistant('checked\nVERDICT: PASS')
    })

    expect(observed[0]).toEqual({ status: 'completed', verdictOnFile: true })
    expect((await readVerdict(TASK_ID, LIST))?.verdict).toBe('PASS')
  })

  test('an errored run records nothing', async () => {
    const observed = await runLifecycle(async function* () {
      yield assistant('VERDICT: PASS')
      throw new Error('provider exploded')
    })

    expect(observed[0]?.status).toBe('failed')
    expect(await readVerdict(TASK_ID, LIST)).toBeUndefined()
    expect(existsSync(getVerdictsDir(LIST))).toBe(false)
  })

  test('a non-built-in "verification" run records nothing', async () => {
    const observed = await runLifecycle(async function* () {
      yield assistant('VERDICT: PASS')
    }, false)

    expect(observed[0]?.status).toBe('completed')
    expect(await readVerdict(TASK_ID, LIST)).toBeUndefined()
  })
})
