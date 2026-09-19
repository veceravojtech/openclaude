import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'

import { resetSettingsCache } from '../utils/settings/settingsCache.js'

/**
 * A wholesale copy of `process.env` taken at a point in time. Only defined
 * values are recorded, so "absent" and "present but undefined" collapse to the
 * same restorable state.
 */
export type EnvSnapshot = ReadonlyMap<string, string>

export type HermeticEnvOptions = {
  /**
   * Also clear the settings cache around every test, so a test that mutates
   * env cannot leave a memoized settings object derived from that env behind
   * (and cannot inherit one from an earlier file). Defaults to `true`.
   */
  resetSettingsCache?: boolean
  /**
   * Delete ambient provider-selection env for the duration of every test in
   * this file, so an ambient shell value cannot change what the tests assert.
   * A mid-session `/provider` switch re-exports OPENAI_MODEL/OPENAI_BASE_URL/
   * OPENAI_API_KEY/CLAUDE_CODE_USE_OPENAI (and the Anthropic counterparts)
   * into the process; suites that assert first-party vs OpenAI-compatible
   * routing silently read those and fail only under such a shell. Keys with
   * an OPENAI_, ANTHROPIC_, or CLAUDE_CODE_USE_ prefix are deleted after the
   * per-test snapshot, so afterEach's restore puts the ambient values back
   * for the rest of the process. Defaults to `false`.
   */
  scrubProviderEnv?: boolean
}

/**
 * Env prefixes whose ambient values select a provider and therefore change
 * what provider-routing assertions see. Prefix-based so new provider vars are
 * covered without remembering to extend a fixed key list.
 */
const PROVIDER_ENV_PREFIXES = ['OPENAI_', 'ANTHROPIC_', 'CLAUDE_CODE_USE_']

function deleteProviderEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete process.env[key]
    }
  }
}

/** Capture every currently defined `process.env` key/value pair. */
export function snapshotEnv(): EnvSnapshot {
  const snapshot = new Map<string, string>()
  for (const [key, value] of Object.entries({ ...process.env })) {
    if (value !== undefined) {
      snapshot.set(key, value)
    }
  }
  return snapshot
}

/**
 * Restore `process.env` to exactly the snapshot: delete every key added since,
 * re-add every key deleted since, and rewrite every value that changed. Unlike
 * a fixed key list this cannot miss a key a test invented at runtime.
 */
export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of Object.keys(process.env)) {
    if (!snapshot.has(key)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of snapshot) {
    if (process.env[key] !== value) {
      process.env[key] = value
    }
  }
}

/**
 * One-line hermeticity for a test file that mutates `process.env`. Call it at
 * the top of the file, before any other hook registration:
 *
 * ```ts
 * useHermeticEnv()
 * ```
 *
 * It registers its own `beforeEach`/`afterEach` (per-test snapshot + restore)
 * plus a `beforeAll`/`afterAll` pair as a backstop, so nothing this file
 * writes to `process.env` can survive the file — bun runs same-level
 * `afterEach` hooks in registration order, so the file-scoped `afterAll`
 * covers env writes made by hooks registered after this one.
 *
 * It restores values only; clearing keys a test needs absent so an ambient
 * shell value cannot change an assertion is opt-in via `scrubProviderEnv`
 * (provider-selection keys only — other absent-keys requirements stay the
 * caller's job).
 */
export function useHermeticEnv(options: HermeticEnvOptions = {}): void {
  const {
    resetSettingsCache: shouldResetSettingsCache = true,
    scrubProviderEnv: shouldScrubProviderEnv = false,
  } = options
  let fileSnapshot: EnvSnapshot | undefined
  let testSnapshot: EnvSnapshot | undefined

  function restore(snapshot: EnvSnapshot | undefined): void {
    if (snapshot) {
      restoreEnv(snapshot)
    }
    if (shouldResetSettingsCache) {
      resetSettingsCache()
    }
  }

  beforeAll(() => {
    fileSnapshot = snapshotEnv()
  })

  beforeEach(() => {
    testSnapshot = snapshotEnv()
    if (shouldScrubProviderEnv) {
      deleteProviderEnv()
    }
    if (shouldResetSettingsCache) {
      resetSettingsCache()
    }
  })

  afterEach(() => {
    restore(testSnapshot)
    testSnapshot = undefined
  })

  afterAll(() => {
    restore(fileSnapshot)
    fileSnapshot = undefined
  })
}
