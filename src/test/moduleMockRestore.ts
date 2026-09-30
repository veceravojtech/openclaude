import { mock } from 'bun:test'

/**
 * Put real modules back after (or before) `mock.module()` stubs.
 *
 * bun's `mock.restore()` does NOT undo `mock.module()`: a module stub stays
 * installed for every later test file in the same `bun test` process, so a
 * file that stubs e.g. `./providers.js` and never restores it silently decides
 * the provider for whichever unrelated file happens to run next.
 *
 * `captureRealModules()` snapshots each module through a cache-busted
 * specifier — a registry key nothing ever mocks — so the snapshot holds the
 * genuine exports even when an earlier file already leaked a stub for the
 * plain specifier. The returned function re-installs those exports, spread
 * into a plain object (bun cannot install a namespace object itself, and
 * `mock.module()` mutates the live namespace in place).
 *
 * Specifiers are resolved against `fromDir` (pass `import.meta.dir`) and the
 * restore targets the resolved path, which is the same registry key the
 * relative, `src/…` and bare-package spellings of that module resolve to.
 *
 * Call it at module scope, before the file's first `mock.module()`:
 *
 *   const restoreRealModules = await captureRealModules(import.meta.dir, [
 *     './providers.js',
 *   ])
 *   afterEach(() => {
 *     mock.restore()
 *     restoreRealModules()
 *   })
 */
export async function captureRealModules(
  fromDir: string,
  specifiers: readonly string[],
): Promise<() => void> {
  const nonce = `realModuleSnapshot=${Date.now()}-${Math.random()}`
  const snapshots = await Promise.all(
    specifiers.map(async specifier => {
      const resolvedPath = Bun.resolveSync(specifier, fromDir)
      const exports: Record<string, unknown> = {
        ...(await import(`${resolvedPath}?${nonce}`)),
      }
      return { resolvedPath, exports }
    }),
  )
  return () => {
    for (const { resolvedPath, exports } of snapshots) {
      mock.module(resolvedPath, () => ({ ...exports }))
    }
  }
}
