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
 * It restores values only; clearing keys a test needs absent (so an ambient
 * shell value cannot change an assertion) stays the caller's job.
 */
export function useHermeticEnv(options: HermeticEnvOptions = {}): void {
  const { resetSettingsCache: shouldResetSettingsCache = true } = options
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
