import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_QUERY_HARD_MAX_MS,
  DEFAULT_QUERY_IDLE_TIMEOUT_MS,
  QueryGuard,
} from './QueryGuard.js'
import {
  formatQueryIdleTimeoutMs,
  getConfiguredQueryIdleTimeoutMs,
  getQueryGuardOptionsFromEnv,
  MAX_CONFIGURABLE_QUERY_HARD_MAX_MS,
  normalizeQueryIdleTimeoutMs,
  OPENCLAUDE_QUERY_HARD_MAX_MS_ENV,
  OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV,
  parseQueryIdleTimeoutOption,
  QUERY_IDLE_TIMEOUT_OPTIONS_MS,
  tryStartQueryWithConfiguredIdleTimeout,
} from './queryGuardConfig.js'

describe('query guard config', () => {
  test('uses defaults when query timeout env vars are absent or empty', () => {
    const warn = vi.fn()

    expect(getQueryGuardOptionsFromEnv({}, warn)).toEqual({})
    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '   ',
          OPENCLAUDE_QUERY_HARD_MAX_MS: '   ',
        },
        warn,
      ),
    ).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  test('accepts positive finite integer query timeout values', () => {
    const warn = vi.fn()

    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '600000',
          OPENCLAUDE_QUERY_HARD_MAX_MS: '3600000',
        },
        warn,
      ),
    ).toEqual({ idleTimeoutMs: 600_000, hardMaxQueryMs: 3_600_000 })
    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '3600000',
          OPENCLAUDE_QUERY_HARD_MAX_MS: '1800000',
        },
        warn,
      ),
    ).toEqual({ idleTimeoutMs: 3_600_000, hardMaxQueryMs: 1_800_000 })
    expect(
      getQueryGuardOptionsFromEnv(
        { OPENCLAUDE_QUERY_HARD_MAX_MS: String(DEFAULT_QUERY_HARD_MAX_MS) },
        warn,
      ),
    ).toEqual({ hardMaxQueryMs: DEFAULT_QUERY_HARD_MAX_MS })
    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCLAUDE_QUERY_HARD_MAX_MS: String(
            MAX_CONFIGURABLE_QUERY_HARD_MAX_MS,
          ),
        },
        warn,
      ),
    ).toEqual({ hardMaxQueryMs: MAX_CONFIGURABLE_QUERY_HARD_MAX_MS })
    expect(warn).not.toHaveBeenCalled()
  })

  test('ignores invalid query timeout values with a clear warning', () => {
    const invalidValues = [
      '0',
      '-1',
      'NaN',
      '1.5',
      'Infinity',
      '123abc',
      String(MAX_CONFIGURABLE_QUERY_HARD_MAX_MS + 1),
    ]

    for (const envName of [
      OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV,
      OPENCLAUDE_QUERY_HARD_MAX_MS_ENV,
    ]) {
      for (const value of invalidValues) {
        const warn = vi.fn()

        expect(getQueryGuardOptionsFromEnv({ [envName]: value }, warn)).toEqual(
          {},
        )

        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toContain(envName)
        expect(warn.mock.calls[0]?.[0]).toContain(value)
        expect(warn.mock.calls[0]?.[1]).toEqual({ level: 'warn' })
      }
    }
  })

  test('keeps a valid timeout when the other timeout is invalid', () => {
    const warn = vi.fn()

    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '600000',
          OPENCLAUDE_QUERY_HARD_MAX_MS: 'invalid',
        },
        warn,
      ),
    ).toEqual({ idleTimeoutMs: 600_000 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain(
      OPENCLAUDE_QUERY_HARD_MAX_MS_ENV,
    )
  })

  test('normalizes and formats persisted /config idle timeout values', () => {
    expect(normalizeQueryIdleTimeoutMs(undefined)).toBe(
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    expect(normalizeQueryIdleTimeoutMs(600_000)).toBe(600_000)
    expect(normalizeQueryIdleTimeoutMs('90000')).toBe(90_000)
    expect(normalizeQueryIdleTimeoutMs(0)).toBe(DEFAULT_QUERY_IDLE_TIMEOUT_MS)
    expect(
      normalizeQueryIdleTimeoutMs(MAX_CONFIGURABLE_QUERY_HARD_MAX_MS + 1),
    ).toBe(DEFAULT_QUERY_IDLE_TIMEOUT_MS)

    expect(formatQueryIdleTimeoutMs(600_000)).toBe('10 min')
    expect(formatQueryIdleTimeoutMs(90_000)).toBe('90 sec')
    expect(formatQueryIdleTimeoutMs(1_234)).toBe('1234 ms')
    expect(parseQueryIdleTimeoutOption('10 min')).toBe(600_000)
    expect(parseQueryIdleTimeoutOption('90 sec')).toBe(90_000)
    expect(parseQueryIdleTimeoutOption('1234 ms')).toBe(1_234)
    expect(parseQueryIdleTimeoutOption('invalid')).toBe(
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    expect(QUERY_IDLE_TIMEOUT_OPTIONS_MS).toEqual([
      300_000,
      600_000,
      900_000,
      1_800_000,
      3_600_000,
    ])
  })

  test('resolves the current environment timeout before the saved value', () => {
    const warn = vi.fn()

    expect(getConfiguredQueryIdleTimeoutMs({}, 600_000)).toBe(600_000)
    expect(getConfiguredQueryIdleTimeoutMs({}, undefined)).toBe(
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    expect(
      getConfiguredQueryIdleTimeoutMs(
        { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '900000' },
        600_000,
      ),
    ).toBe(900_000)
    expect(
      getConfiguredQueryIdleTimeoutMs(
        { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: 'invalid' },
        600_000,
        warn,
      ),
    ).toBe(DEFAULT_QUERY_IDLE_TIMEOUT_MS)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  describe('teammate processes', () => {
    test('disables both the hard max and the idle timeout when no env override is set', () => {
      const warn = vi.fn()

      expect(getQueryGuardOptionsFromEnv({}, warn, true)).toEqual({
        hardMaxQueryMs: null,
        idleTimeoutMs: null,
      })
      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCLAUDE_QUERY_HARD_MAX_MS: '   ' },
          warn,
          true,
        ),
      ).toEqual({ hardMaxQueryMs: null, idleTimeoutMs: null })
      expect(warn).not.toHaveBeenCalled()
    })

    test('still honors an explicit, valid hard-max env override, but keeps the idle timeout disabled', () => {
      const warn = vi.fn()

      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCLAUDE_QUERY_HARD_MAX_MS: '3600000' },
          warn,
          true,
        ),
      ).toEqual({ hardMaxQueryMs: 3_600_000, idleTimeoutMs: null })
      expect(warn).not.toHaveBeenCalled()
    })

    test('falls back to fully disabled on an invalid env override', () => {
      const warn = vi.fn()

      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCLAUDE_QUERY_HARD_MAX_MS: '0' },
          warn,
          true,
        ),
      ).toEqual({ hardMaxQueryMs: null, idleTimeoutMs: null })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('does not disable either watchdog for the non-teammate main session', () => {
      const warn = vi.fn()

      expect(getQueryGuardOptionsFromEnv({}, warn, false)).toEqual({})
      expect(getQueryGuardOptionsFromEnv({}, warn)).toEqual({})
    })

    test('an explicit, valid idle-timeout env override re-enables only the idle watchdog', () => {
      const warn = vi.fn()

      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '600000' },
          warn,
          true,
        ),
      ).toEqual({ hardMaxQueryMs: null, idleTimeoutMs: 600_000 })
      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: 'nope' },
          warn,
          true,
        ),
      ).toEqual({ hardMaxQueryMs: null, idleTimeoutMs: null })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('the persisted /config idle timeout never re-arms a teammate idle watchdog', () => {
      const warn = vi.fn()

      expect(getConfiguredQueryIdleTimeoutMs({}, 600_000, warn, true)).toBeNull()
      expect(getConfiguredQueryIdleTimeoutMs({}, undefined, warn, true)).toBeNull()
      expect(
        getConfiguredQueryIdleTimeoutMs(
          { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '900000' },
          600_000,
          warn,
          true,
        ),
      ).toBe(900_000)
      expect(
        getConfiguredQueryIdleTimeoutMs(
          { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: 'invalid' },
          600_000,
          warn,
          true,
        ),
      ).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('tryStartQueryWithConfiguredIdleTimeout keeps a teammate idle watchdog disabled', () => {
      const guard = new QueryGuard({ idleTimeoutMs: null, hardMaxQueryMs: null })
      const setIdle = vi.spyOn(guard, 'setIdleTimeoutMs')
      const start = tryStartQueryWithConfiguredIdleTimeout(
        guard,
        { queryId: 'teammate-q', querySource: 'repl_main_thread', startedAt: Date.now() } as never,
        {},
        600_000,
        true,
      )
      expect(start).not.toBeNull()
      expect(setIdle).toHaveBeenCalledWith(null)
      guard.end(start!.generation)
    })
  })
})
