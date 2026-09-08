import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../bootstrap/state.js'
import type {
  HookEvent,
  HookInput,
  HookJSONOutput,
} from '../entrypoints/agentSdkTypes.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import {
  type AggregatedHookResult,
  executeStreamStalledHooks,
  executeTeammateIdleTimeoutHooks,
  getTeammateIdleTimeoutHookMessage,
} from './hooks.js'

let configDir: string | undefined
let previousInteractive = true
let previousRegisteredHooks: ReturnType<typeof getRegisteredHooks> = null
let previousSimpleEnv: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/hooks.idleTimeoutStreamStalled.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-idle-hooks-'))
  setClaudeConfigHomeDirForTesting(configDir)
  // Hooks only run once workspace trust is settled; non-interactive sessions
  // treat trust as implicit, which keeps this test independent of any
  // trust dialog state on the machine.
  previousInteractive = getIsInteractive()
  setIsInteractive(false)
  previousRegisteredHooks = getRegisteredHooks()
  clearRegisteredHooks()
  previousSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_SIMPLE
})

afterEach(() => {
  try {
    clearRegisteredHooks()
    if (previousRegisteredHooks) {
      registerHookCallbacks(previousRegisteredHooks)
    }
    setIsInteractive(previousInteractive)
    if (previousSimpleEnv === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = previousSimpleEnv
    }
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function registerCallback(
  event: HookEvent,
  callback: (input: HookInput) => Promise<HookJSONOutput>,
  matcher?: string,
): void {
  registerHookCallbacks({
    [event]: [{ matcher, hooks: [{ type: 'callback', callback }] }],
  })
}

async function collect(
  generator: AsyncGenerator<AggregatedHookResult>,
): Promise<AggregatedHookResult[]> {
  const results: AggregatedHookResult[] = []
  for await (const result of generator) {
    results.push(result)
  }
  return results
}

const streamStalledParams = {
  stage: 'warning' as const,
  sinceLastEventMs: 45_000,
  timeoutMs: 90_000,
  model: 'claude-test',
  requestId: null,
  agentId: 'reviewer@alpha',
  agentName: 'reviewer',
  teamName: 'alpha',
}

test('executeStreamStalledHooks builds the payload and matches on stage', async () => {
  const unmatched: HookInput[] = []
  const timeoutOnly: HookInput[] = []
  registerCallback('StreamStalled', async input => {
    unmatched.push(input)
    return {}
  })
  registerCallback(
    'StreamStalled',
    async input => {
      timeoutOnly.push(input)
      return {}
    },
    'timeout',
  )

  await executeStreamStalledHooks(streamStalledParams)

  expect(timeoutOnly).toHaveLength(0)
  expect(unmatched).toHaveLength(1)
  expect(unmatched[0]).toMatchObject({
    hook_event_name: 'StreamStalled',
    stage: 'warning',
    since_last_event_ms: 45_000,
    timeout_ms: 90_000,
    model: 'claude-test',
    request_id: 'unknown',
    agent_id: 'reviewer@alpha',
    agent_name: 'reviewer',
    team_name: 'alpha',
  })
  expect(typeof unmatched[0]!.session_id).toBe('string')
  expect(typeof unmatched[0]!.cwd).toBe('string')

  await executeStreamStalledHooks({
    ...streamStalledParams,
    stage: 'timeout',
    sinceLastEventMs: 90_000,
    requestId: 'req-42',
  })

  expect(timeoutOnly).toHaveLength(1)
  expect(timeoutOnly[0]).toMatchObject({
    stage: 'timeout',
    since_last_event_ms: 90_000,
    request_id: 'req-42',
  })
  expect(unmatched).toHaveLength(2)
})

test('executeStreamStalledHooks never rejects, even when a hook throws', async () => {
  registerCallback('StreamStalled', async () => {
    throw new Error('hook exploded')
  })
  await expect(
    executeStreamStalledHooks(streamStalledParams),
  ).resolves.toBeUndefined()

  clearRegisteredHooks()
  await expect(
    executeStreamStalledHooks(streamStalledParams),
  ).resolves.toBeUndefined()
})

const idleParams = {
  teammateName: 'idle-worker',
  teamName: 'alpha',
  agentId: 'idle-worker@alpha',
  idleMs: 300_000,
  occurrence: 2,
  permissionMode: 'default',
}

test('executeTeammateIdleTimeoutHooks yields nothing without a configured hook', async () => {
  expect(await collect(executeTeammateIdleTimeoutHooks(idleParams))).toEqual(
    [],
  )
})

test('executeTeammateIdleTimeoutHooks builds the payload; a silent hook keeps waiting', async () => {
  const inputs: HookInput[] = []
  registerCallback('TeammateIdleTimeout', async input => {
    inputs.push(input)
    return {}
  })

  const results = await collect(executeTeammateIdleTimeoutHooks(idleParams))

  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toMatchObject({
    hook_event_name: 'TeammateIdleTimeout',
    teammate_name: 'idle-worker',
    team_name: 'alpha',
    agent_id: 'idle-worker@alpha',
    idle_ms: 300_000,
    occurrence: 2,
    permission_mode: 'default',
  })
  expect(results.some(r => r.blockingError)).toBe(false)
  expect(results.some(r => r.teammateIdleTimeoutAction)).toBe(false)
})

test('a blocking TeammateIdleTimeout hook hands its text to the teammate', async () => {
  registerCallback('TeammateIdleTimeout', async () => ({
    decision: 'block',
    reason: 'Review PR #7',
  }))

  const results = await collect(executeTeammateIdleTimeoutHooks(idleParams))
  const blocking = results.find(r => r.blockingError)

  expect(blocking?.blockingError?.blockingError).toBe('Review PR #7')
  expect(getTeammateIdleTimeoutHookMessage(blocking!.blockingError!)).toBe(
    'TeammateIdleTimeout hook feedback:\nReview PR #7',
  )
  expect(results.some(r => r.teammateIdleTimeoutAction)).toBe(false)
})

test('a TeammateIdleTimeout hook can request a clean shutdown via hookSpecificOutput', async () => {
  registerCallback('TeammateIdleTimeout', async () => ({
    hookSpecificOutput: {
      hookEventName: 'TeammateIdleTimeout',
      action: 'shutdown',
      reason: 'nothing queued',
    },
  }))

  const results = await collect(executeTeammateIdleTimeoutHooks(idleParams))

  expect(results.find(r => r.teammateIdleTimeoutAction)?.teammateIdleTimeoutAction).toEqual({
    action: 'shutdown',
    reason: 'nothing queued',
  })
  expect(results.some(r => r.blockingError)).toBe(false)
})
