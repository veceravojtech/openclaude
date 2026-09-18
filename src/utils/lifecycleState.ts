/**
 * Explicit process wind-down state.
 *
 * The flag means: a real shutdown initiator (gracefulShutdown / gracefulShutdownSync)
 * has decided this process is winding down. It explicitly does NOT mean "some
 * component set process.exitCode" — in bun, `process.exitCode = undefined` is a
 * silent no-op, so exitCode can never serve as a reliable "not winding down"
 * signal across a whole process lifetime. Consumers that need to know whether a
 * shutdown was initiated must read this flag instead of sniffing process.exitCode.
 */

let windingDown = false

/** Mark the process as winding down. Called by the actual shutdown initiators. */
export function markProcessWindingDown(): void {
  windingDown = true
}

/** Whether a shutdown initiator has decided this process is winding down. */
export function isProcessWindingDown(): boolean {
  return windingDown
}

/** Testing seam: reset the flag between tests. */
export function resetLifecycleStateForTesting(): void {
  windingDown = false
}
