import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { AccountInfo } from '../utils/config.js'
import {
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from './claudeAiLimits.js'

type LimitsModule = typeof import('./claudeAiLimits.js')

// Captured before any mock.module call, so these are the real namespaces. They
// are spread — never handed back as the namespace object itself — because
// mock.module() mutates the registration in place, so returning the namespace
// would re-install the stub instead of undoing it.
const realAuthModule = { ...(await import('../utils/auth.js')) }
const realConfigModule = { ...(await import('../utils/config.js')) }

const ACCOUNT_ONE = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_TWO = '22222222-2222-4222-8222-222222222222'

/** Which account getOauthAccountInfo() reports; undefined = API-key traffic. */
let activeAccountUuid: string | undefined
let isSubscriber = true
/** Stands in for the on-disk global config so no test touches the real one. */
let fakeGlobalConfig: Record<string, unknown> = {}
let freshImportCounter = 0

function makeAccountInfo(accountUuid: string): AccountInfo {
  return { accountUuid, emailAddress: `${accountUuid}@example.test` }
}

/**
 * Install the stubs and hand back a FRESH claudeAiLimits instance, so each test
 * starts from empty per-account state regardless of what ran before it.
 */
async function importFreshLimits(): Promise<LimitsModule> {
  mock.module('src/utils/auth.js', () => ({
    ...realAuthModule,
    getOauthAccountInfo: () =>
      activeAccountUuid === undefined
        ? undefined
        : makeAccountInfo(activeAccountUuid),
    isClaudeAISubscriber: () => isSubscriber,
  }))
  // cacheExtraUsageDisabledReason writes through saveGlobalConfig on the happy
  // path; without this stub every capture below would rewrite the developer's
  // real ~/.claude config.
  mock.module('src/utils/config.js', () => ({
    ...realConfigModule,
    getGlobalConfig: () => fakeGlobalConfig,
    saveGlobalConfig: (update: unknown) => {
      fakeGlobalConfig =
        typeof update === 'function'
          ? (update as (c: Record<string, unknown>) => Record<string, unknown>)(
              fakeGlobalConfig,
            )
          : (update as Record<string, unknown>)
    },
  }))
  return import(`./claudeAiLimits.js?h1-account-keying=${freshImportCounter++}`)
}

/**
 * Quota headers for one five-hour window. `unifiedReset` is what lands in
 * ClaudeAILimits.resetsAt, so it is the marker that says which response moved
 * a given account's limits.
 */
function quotaHeaders(opts: {
  utilization5h: number
  /** Kept in the past so computeTimeProgress saturates and no early warning
   *  fires — that keeps computeNewLimitsFromHeaders deterministic. */
  reset5h: number
  unifiedReset: number
}): globalThis.Headers {
  return new Headers({
    'anthropic-ratelimit-unified-5h-utilization': String(opts.utilization5h),
    'anthropic-ratelimit-unified-5h-reset': String(opts.reset5h),
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(opts.unifiedReset),
  })
}

function headerless429(): APIError {
  return new APIError(
    429,
    { error: { type: 'rate_limit_error', message: 'rate limited' } },
    'rate limited',
    undefined,
  )
}

beforeEach(async () => {
  await acquireSharedMutationLock('claudeAiLimits.test.ts')
  activeAccountUuid = ACCOUNT_ONE
  isSubscriber = true
  fakeGlobalConfig = { cachedExtraUsageDisabledReason: null }
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('src/utils/auth.js', () => ({ ...realAuthModule }))
    mock.module('src/utils/config.js', () => ({ ...realConfigModule }))
  } finally {
    releaseSharedMutationLock()
  }
})

describe('account key derivation', () => {
  test('keys on getOauthAccountInfo().accountUuid, and on the reserved sentinel without one', async () => {
    const limits = await importFreshLimits()

    activeAccountUuid = ACCOUNT_ONE
    expect(limits.currentAccountUsageKey()).toBe(ACCOUNT_ONE)

    activeAccountUuid = undefined
    expect(limits.currentAccountUsageKey()).toBe(limits.NO_ACCOUNT_USAGE_KEY)
    // The sentinel must not be confusable with a real accountUuid.
    expect(limits.NO_ACCOUNT_USAGE_KEY).toBe('no-oauth-account')
    expect(limits.NO_ACCOUNT_USAGE_KEY).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  test('the account key is a required parameter on both extract entry points', () => {
    // Runtime arity: an optional or defaulted parameter would drop these to 1.
    expect(extractQuotaStatusFromHeaders.length).toBe(2)
    expect(extractQuotaStatusFromError.length).toBe(2)

    // Compile-time: the declared parameter tuple must be assignable TO a tuple
    // whose second element is a required `string`. Both `accountKey?: string`
    // and `accountKey: string | undefined` break this assignment. The
    // direction matters — a required tuple is assignable to an optional one,
    // so asserting it the other way round would check nothing.
    const headerArgs: [globalThis.Headers, string] =
      null as unknown as Parameters<typeof extractQuotaStatusFromHeaders>
    const errorArgs: [APIError, string] =
      null as unknown as Parameters<typeof extractQuotaStatusFromError>
    expect(headerArgs).toBeNull()
    expect(errorArgs).toBeNull()
  })
})

describe('R7 attribution at the limits layer', () => {
  test('a response keyed to a switched-away account moves only that account, never the active view', async () => {
    const limits = await importFreshLimits()

    // Account one is active and gets a reading.
    activeAccountUuid = ACCOUNT_ONE
    // This is the snapshot a request build would have taken.
    const buildTimeKey = limits.currentAccountUsageKey()
    expect(buildTimeKey).toBe(ACCOUNT_ONE)
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      buildTimeKey,
    )

    // The switch lands: account two becomes active and gets its own reading.
    activeAccountUuid = ACCOUNT_TWO
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.42, reset5h: 222, unifiedReset: 2222 }),
      limits.currentAccountUsageKey(),
    )
    expect(limits.getRawUtilization().five_hour?.utilization).toBe(0.42)
    expect(limits.currentLimits.resetsAt).toBe(2222)
    const activeLimitsBeforeLateResponse = { ...limits.currentLimits }

    const fanOut: number[] = []
    limits.statusListeners.add(next => fanOut.push(next.resetsAt ?? -1))

    // The late response for account one arrives while account two is active.
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.99, reset5h: 333, unifiedReset: 3333 }),
      buildTimeKey,
    )

    const snapshots = limits.listAccountUsageSnapshots()
    const one = snapshots.find(s => s.accountUuid === ACCOUNT_ONE)
    const two = snapshots.find(s => s.accountUuid === ACCOUNT_TWO)

    // Account one's slot moved...
    expect(one?.raw.five_hour?.utilization).toBe(0.99)
    // ...account two's slot did not...
    expect(two?.raw.five_hour?.utilization).toBe(0.42)
    // ...and the active-account view still reads account two.
    expect(limits.getRawUtilization().five_hour?.utilization).toBe(0.42)
    expect(limits.currentLimits).toEqual(activeLimitsBeforeLateResponse)
    // No fan-out: a switched-away account must not repaint the status line.
    expect(fanOut).toEqual([])
  })

  test('a response for the active account still fans out normally', async () => {
    const limits = await importFreshLimits()
    const fanOut: number[] = []
    limits.statusListeners.add(next => fanOut.push(next.resetsAt ?? -1))

    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )

    expect(fanOut).toEqual([1111])
    expect(limits.currentLimits.resetsAt).toBe(1111)
  })

  test('listAccountUsageSnapshots reports first-capture-first and omits uncaptured slots', async () => {
    const limits = await importFreshLimits()

    activeAccountUuid = ACCOUNT_TWO
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.42, reset5h: 222, unifiedReset: 2222 }),
      ACCOUNT_TWO,
    )
    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )

    expect(limits.listAccountUsageSnapshots().map(s => s.accountUuid)).toEqual([
      ACCOUNT_TWO,
      ACCOUNT_ONE,
    ])
    for (const snapshot of limits.listAccountUsageSnapshots()) {
      expect(typeof snapshot.capturedAt).toBe('number')
      expect(snapshot.capturedAt).toBeGreaterThan(0)
    }
  })

  test('clearAccountUsageForTests drops every slot and resets the active view', async () => {
    const limits = await importFreshLimits()
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )
    expect(limits.listAccountUsageSnapshots()).toHaveLength(1)

    limits.clearAccountUsageForTests()

    expect(limits.listAccountUsageSnapshots()).toEqual([])
    expect(limits.getRawUtilization()).toEqual({})
    expect(limits.getRawUtilizationCapturedAt()).toBeUndefined()
    expect(limits.currentLimits).toEqual({
      status: 'allowed',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
    })
  })
})

describe('extractQuotaStatusFromError seeds from the responding account', () => {
  test('a headerless 429 inherits that account stored limits, not the globally displayed ones', async () => {
    const limits = await importFreshLimits()

    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )
    activeAccountUuid = ACCOUNT_TWO
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.42, reset5h: 222, unifiedReset: 2222 }),
      ACCOUNT_TWO,
    )
    // currentLimits is now account two's, even though account one is about to
    // become active again — nothing re-reads the store on a switch.
    expect(limits.currentLimits.resetsAt).toBe(2222)

    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromError(headerless429(), ACCOUNT_ONE)

    expect(limits.currentLimits.status).toBe('rejected')
    // 1111 = seeded from account one's slot. 2222 would mean it seeded from
    // the previous global currentLimits, which is the bug this replaces.
    expect(limits.currentLimits.resetsAt).toBe(1111)
  })

  test('a 429 for a switched-away account leaves the active view alone', async () => {
    const limits = await importFreshLimits()

    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )
    activeAccountUuid = ACCOUNT_TWO
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.42, reset5h: 222, unifiedReset: 2222 }),
      ACCOUNT_TWO,
    )

    const fanOut: string[] = []
    limits.statusListeners.add(next => fanOut.push(next.status))
    limits.extractQuotaStatusFromError(headerless429(), ACCOUNT_ONE)

    expect(fanOut).toEqual([])
    expect(limits.currentLimits.status).toBe('allowed')
    expect(limits.currentLimits.resetsAt).toBe(2222)
  })
})

describe('single-account behaviour is unchanged', () => {
  test('one oauth account: reads, fan-out and dedupe behave as before keying', async () => {
    const limits = await importFreshLimits()
    activeAccountUuid = ACCOUNT_ONE

    expect(limits.getRawUtilization()).toEqual({})
    expect(limits.getRawUtilizationCapturedAt()).toBeUndefined()
    expect(limits.currentLimits).toEqual({
      status: 'allowed',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
    })

    const fanOut: number[] = []
    limits.statusListeners.add(next => fanOut.push(next.resetsAt ?? -1))

    const before = Date.now()
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.33, reset5h: 111, unifiedReset: 1111 }),
      limits.currentAccountUsageKey(),
    )

    expect(limits.getRawUtilization()).toEqual({
      five_hour: { utilization: 0.33, resets_at: 111 },
    })
    expect(limits.getRawUtilizationCapturedAt()).toBeGreaterThanOrEqual(before)
    expect(limits.currentLimits.resetsAt).toBe(1111)
    expect(fanOut).toEqual([1111])

    // An identical second response must not re-emit — the isEqual dedupe that
    // guarded currentLimits before now guards the account's own slot.
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.33, reset5h: 111, unifiedReset: 1111 }),
      limits.currentAccountUsageKey(),
    )
    expect(fanOut).toEqual([1111])

    // A changed response emits again.
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.55, reset5h: 111, unifiedReset: 9999 }),
      limits.currentAccountUsageKey(),
    )
    expect(fanOut).toEqual([1111, 9999])
    expect(limits.listAccountUsageSnapshots()).toHaveLength(1)
  })

  test('no oauth account: the sentinel slot carries the whole session', async () => {
    const limits = await importFreshLimits()
    activeAccountUuid = undefined

    const fanOut: number[] = []
    limits.statusListeners.add(next => fanOut.push(next.resetsAt ?? -1))

    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.21, reset5h: 111, unifiedReset: 1111 }),
      limits.currentAccountUsageKey(),
    )

    expect(limits.getRawUtilization()).toEqual({
      five_hour: { utilization: 0.21, resets_at: 111 },
    })
    expect(limits.currentLimits.resetsAt).toBe(1111)
    expect(fanOut).toEqual([1111])
    expect(limits.listAccountUsageSnapshots()).toEqual([
      {
        accountUuid: limits.NO_ACCOUNT_USAGE_KEY,
        raw: { five_hour: { utilization: 0.21, resets_at: 111 } },
        capturedAt: expect.any(Number),
      },
    ])
  })

  test('a non-subscriber response clears only its own account slot', async () => {
    const limits = await importFreshLimits()

    activeAccountUuid = ACCOUNT_ONE
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.1, reset5h: 111, unifiedReset: 1111 }),
      ACCOUNT_ONE,
    )
    activeAccountUuid = ACCOUNT_TWO
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.42, reset5h: 222, unifiedReset: 2222 }),
      ACCOUNT_TWO,
    )

    // The subscription lapses (or the account was never one) for account one.
    isSubscriber = false
    limits.extractQuotaStatusFromHeaders(
      quotaHeaders({ utilization5h: 0.9, reset5h: 333, unifiedReset: 3333 }),
      ACCOUNT_ONE,
    )

    expect(
      limits.listAccountUsageSnapshots().map(s => s.accountUuid),
    ).toEqual([ACCOUNT_TWO])
    isSubscriber = true
    activeAccountUuid = ACCOUNT_TWO
    expect(limits.getRawUtilization().five_hour?.utilization).toBe(0.42)
  })
})
