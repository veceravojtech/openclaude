import { describe, expect, test } from 'bun:test'
import {
  HOOK_EVENTS as SCHEMA_HOOK_EVENTS,
  HookInputSchema,
  StreamStalledHookInputSchema,
  SyncHookJSONOutputSchema,
  TeammateIdleTimeoutHookInputSchema,
} from '../../entrypoints/sdk/coreSchemas.js'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import { getManagedSettingsKeysForLogging } from '../settings/settings.js'
import { getHookEventMetadata } from './hooksConfigManager.js'

const base = {
  session_id: 'session-1',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/repo',
}

describe('StreamStalled and TeammateIdleTimeout hook events', () => {
  test('are registered in both HOOK_EVENTS arrays', () => {
    for (const events of [HOOK_EVENTS, SCHEMA_HOOK_EVENTS]) {
      expect(events).toContain('StreamStalled')
      expect(events).toContain('TeammateIdleTimeout')
    }
    // The two arrays must stay identical: coreTypes.ts is the runtime list,
    // coreSchemas.ts feeds the generated SDK types.
    expect([...HOOK_EVENTS]).toEqual([...SCHEMA_HOOK_EVENTS])
  })

  test('StreamStalled input schema parses a sample payload and rejects unknown stages', () => {
    const sample = {
      ...base,
      hook_event_name: 'StreamStalled',
      stage: 'timeout',
      since_last_event_ms: 90_000,
      timeout_ms: 90_000,
      model: 'claude-test',
      request_id: 'unknown',
      agent_id: 'reviewer@alpha',
      agent_name: 'reviewer',
      team_name: 'alpha',
    }
    expect(StreamStalledHookInputSchema().safeParse(sample).success).toBe(true)
    expect(HookInputSchema().safeParse(sample).success).toBe(true)
    // Identity is optional: main-thread requests carry none.
    const { agent_id: _a, agent_name: _n, team_name: _t, ...anonymous } = sample
    expect(StreamStalledHookInputSchema().safeParse(anonymous).success).toBe(
      true,
    )
    expect(
      StreamStalledHookInputSchema().safeParse({ ...sample, stage: 'stalled' })
        .success,
    ).toBe(false)
  })

  test('TeammateIdleTimeout input schema parses a sample payload', () => {
    const sample = {
      ...base,
      hook_event_name: 'TeammateIdleTimeout',
      agent_id: 'idle-worker@alpha',
      teammate_name: 'idle-worker',
      team_name: 'alpha',
      idle_ms: 300_000,
      occurrence: 1,
    }
    expect(TeammateIdleTimeoutHookInputSchema().safeParse(sample).success).toBe(
      true,
    )
    expect(HookInputSchema().safeParse(sample).success).toBe(true)
    const { idle_ms: _ms, ...missingIdle } = sample
    expect(
      TeammateIdleTimeoutHookInputSchema().safeParse(missingIdle).success,
    ).toBe(false)
  })

  test('TeammateIdleTimeout hook JSON output accepts the shutdown action only', () => {
    const shutdown = {
      hookSpecificOutput: {
        hookEventName: 'TeammateIdleTimeout',
        action: 'shutdown',
        reason: 'nothing queued for this teammate',
      },
    }
    expect(SyncHookJSONOutputSchema().safeParse(shutdown).success).toBe(true)
    expect(
      SyncHookJSONOutputSchema().safeParse({
        hookSpecificOutput: {
          hookEventName: 'TeammateIdleTimeout',
          action: 'restart',
        },
      }).success,
    ).toBe(false)
  })

  test('hooks config metadata describes both events with their semantics', () => {
    const metadata = getHookEventMetadata([])

    expect(metadata.StreamStalled.matcherMetadata).toEqual({
      fieldToMatch: 'stage',
      values: ['warning', 'timeout', 'recovered'],
    })
    expect(metadata.StreamStalled.description).toContain('Fire-and-forget')

    expect(metadata.TeammateIdleTimeout.matcherMetadata).toBeUndefined()
    expect(metadata.TeammateIdleTimeout.description).toContain(
      'CLAUDE_CODE_TEAMMATE_IDLE_TIMEOUT_MS',
    )
    expect(metadata.TeammateIdleTimeout.description).toContain('Exit code 2')
    expect(metadata.TeammateIdleTimeout.description).toContain(
      '"action":"shutdown"',
    )
  })

  test('settings key expansion recognises hooks for both events', () => {
    const keys = getManagedSettingsKeysForLogging({
      hooks: { StreamStalled: [], TeammateIdleTimeout: [] },
    })
    expect(keys).toContain('hooks.StreamStalled')
    expect(keys).toContain('hooks.TeammateIdleTimeout')
  })
})
