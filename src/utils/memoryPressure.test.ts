import { afterEach, describe, expect, test } from 'bun:test'
import {
  consumeCompactionRequest,
  getMemoryPressureLevel,
  startMemoryPressureMonitor,
  stopMemoryPressureMonitor,
} from './memoryPressure.js'

// Budget chosen so the derived thresholds are round numbers:
// elevated = 80% = 800MB, critical = 90% = 900MB.
const BUDGET_MB = 1000
const TICK_MS = 10

const realMemoryUsage = process.memoryUsage

function stubRssMB(mb: number): void {
  const usage = (() => ({
    rss: mb * 1024 * 1024,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  })) as unknown as typeof process.memoryUsage
  process.memoryUsage = usage
}

/** Wait for at least `n` monitor ticks to have run. */
function ticks(n: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, TICK_MS * n + TICK_MS * 2))
}

function startMonitor(): void {
  startMemoryPressureMonitor({
    perSessionBudgetMB: BUDGET_MB,
    checkIntervalMs: TICK_MS,
  })
}

afterEach(() => {
  stopMemoryPressureMonitor()
  // stopMemoryPressureMonitor() resets level + listeners but NOT the
  // one-shot compaction flag; drain it so tests don't leak into each other.
  consumeCompactionRequest()
  process.memoryUsage = realMemoryUsage
})

describe('memory-pressure compaction requests', () => {
  test('elevated pressure alone does NOT request compaction', async () => {
    stubRssMB(850) // between elevated (800) and critical (900)
    startMonitor()
    await ticks(2)

    expect(getMemoryPressureLevel()).toBe('elevated')
    // Merely-elevated RSS is not evidence the conversation exhausted its
    // context. Forcing a full compaction here throws away a healthy
    // transcript; only genuine OOM risk justifies that.
    expect(consumeCompactionRequest()).toBe(false)
  })

  test('critical pressure DOES request compaction', async () => {
    stubRssMB(950) // above critical (900)
    startMonitor()
    await ticks(2)

    expect(getMemoryPressureLevel()).toBe('critical')
    expect(consumeCompactionRequest()).toBe(true)
  })

  test('sustained critical pressure requests compaction once, not every tick', async () => {
    stubRssMB(950)
    startMonitor()
    await ticks(2)

    // First request is the transition into critical.
    expect(consumeCompactionRequest()).toBe(true)

    // RSS stays critical. Re-arming every tick is what produced repeated
    // unexplained compactions; a level that never changed is not new evidence.
    await ticks(3)
    expect(consumeCompactionRequest()).toBe(false)
  })

  test('re-entering critical after recovery requests compaction again', async () => {
    stubRssMB(950)
    startMonitor()
    await ticks(2)
    expect(consumeCompactionRequest()).toBe(true)

    // Drop back to normal, then climb into critical again — a genuinely new
    // transition, so protection must re-arm.
    stubRssMB(100)
    await ticks(2)
    expect(getMemoryPressureLevel()).toBe('normal')
    consumeCompactionRequest()

    stubRssMB(950)
    await ticks(2)
    expect(consumeCompactionRequest()).toBe(true)
  })
})
