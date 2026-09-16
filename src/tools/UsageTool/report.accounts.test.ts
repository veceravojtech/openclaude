import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { AccountInfo } from '../../utils/config.js'
import type {
  SecureStorageData,
  StoredClaudeAccount,
} from '../../utils/secureStorage/index.js'
import type { Utilization } from '../../services/api/usage.js'

type LimitsModule = typeof import('../../services/claudeAiLimits.js')
type ReportModule = typeof import('./report.js')
type AccountSwitchModule = typeof import('../../utils/accountSwitch.js')

// Captured before any mock.module call, so these are the real namespaces, and
// spread rather than handed back as the namespace object itself: mock.module
// mutates the registration in place, so returning the namespace would
// re-install the stub instead of undoing it.
const realAuthModule = { ...(await import('../../utils/auth.js')) }
const realConfigModule = { ...(await import('../../utils/config.js')) }
const realStorageModule = {
  ...(await import('../../utils/secureStorage/index.js')),
}

// The report resolves the active provider from process.env; the same keys the
// sibling UsageTool suite scrubs, so every case starts on the first-party
// route instead of inheriting the developer's shell.
const MANAGED_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'OPENAI_MODEL',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'NVIDIA_NIM',
  'GEMINI_BASE_URL',
  'MINIMAX_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
] as const

const originalEnv = new Map(
  MANAGED_ENV_KEYS.map(key => [key, process.env[key]] as const),
)

/** The lead's account, and the account a Sonnet-routed teammate runs on. */
const LEAD = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
/** Shares TEAMMATE's first eight hex characters, which is all a name gets. */
const TEAMMATE_TWIN = '22222222-3333-4333-8333-333333333333'

const LEAD_5H_RESET = Math.floor(
  new Date('2026-09-16T18:00:00Z').getTime() / 1000,
)
const LEAD_7D_RESET = Math.floor(
  new Date('2026-09-20T06:00:00Z').getTime() / 1000,
)
const TEAMMATE_5H_RESET = Math.floor(
  new Date('2026-09-16T21:30:00Z').getTime() / 1000,
)
const TEAMMATE_7D_RESET = Math.floor(
  new Date('2026-09-22T09:15:00Z').getTime() / 1000,
)

/** Which account getOauthAccountInfo() reports; undefined = API-key traffic. */
let activeAccountUuid: string | undefined
let storedAccounts: Record<string, StoredClaudeAccount> = {}
/** Stands in for the on-disk global config so no test touches the real one. */
let fakeGlobalConfig: Record<string, unknown> = {}
let freshImportCounter = 0

let limits: LimitsModule
let report: ReportModule
let accountSwitch: AccountSwitchModule

function makeAccountInfo(accountUuid: string): AccountInfo {
  return { accountUuid, emailAddress: `${accountUuid}@oauth.example` }
}

/** A stored account as the secure store holds it. */
function storedAccount(options: {
  uuid: string
  email?: string
  label?: string
}): StoredClaudeAccount {
  return {
    accessToken: `access-${options.uuid}`,
    refreshToken: `refresh-${options.uuid}`,
    expiresAt: new Date('2027-01-01T00:00:00Z').getTime(),
    scopes: ['user:inference'],
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.email === undefined
      ? {}
      : { tokenAccount: { uuid: options.uuid, emailAddress: options.email } }),
  }
}

/**
 * Install the stubs and hand back FRESH report/limits instances, so each case
 * starts from an empty cache and an empty quota store.
 *
 * The stubs go in before the dynamic imports, so the real accountSwitch and
 * the real claudeAiLimits are exercised - only their credential store, their
 * account identity and the global config are stood in for. accountUsageLabel
 * and readAccounts are therefore the production functions.
 */
async function loadModules(): Promise<void> {
  mock.module('src/utils/auth.js', () => ({
    ...realAuthModule,
    getOauthAccountInfo: () =>
      activeAccountUuid === undefined
        ? undefined
        : makeAccountInfo(activeAccountUuid),
    isClaudeAISubscriber: () => true,
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
  mock.module('src/utils/secureStorage/index.js', () => ({
    ...realStorageModule,
    getSecureStorage: () => ({
      name: 'test-storage',
      read: (): SecureStorageData => ({
        claudeAiOauthAccounts: storedAccounts,
        ...(activeAccountUuid === undefined
          ? {}
          : { claudeAiOauthActive: activeAccountUuid }),
      }),
      readAsync: async (): Promise<SecureStorageData> => ({
        claudeAiOauthAccounts: storedAccounts,
      }),
      update: () => {
        throw new Error('the usage report must never write secure storage')
      },
      delete: () => {
        throw new Error('the usage report must never delete secure storage')
      },
    }),
  }))
  limits = await import('../../services/claudeAiLimits.js')
  accountSwitch = await import('../../utils/accountSwitch.js')
  report = await import(`./report.js?h3-usage-accounts=${freshImportCounter++}`)
}

/**
 * Quota headers for one response. `reset5h`/`reset7d` are epoch seconds and
 * land verbatim in the rendered `resets` stamp, so they are what says which
 * account a rendered row came from.
 */
function quotaHeaders(options: {
  utilization5h: number
  reset5h: number
  utilization7d: number
  reset7d: number
}): globalThis.Headers {
  return new Headers({
    'anthropic-ratelimit-unified-5h-utilization': String(
      options.utilization5h,
    ),
    'anthropic-ratelimit-unified-5h-reset': String(options.reset5h),
    'anthropic-ratelimit-unified-7d-utilization': String(
      options.utilization7d,
    ),
    'anthropic-ratelimit-unified-7d-reset': String(options.reset7d),
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(options.reset5h),
  })
}

/** Headers from a response that reported status but no utilization window. */
function windowlessHeaders(): globalThis.Headers {
  return new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' })
}

function noFetchers() {
  return {
    fetchClaudeUtilization: async () => null,
    fetchCodexUsage: async () => {
      throw new Error('unexpected codex fetch')
    },
    fetchMiniMaxUsage: async () => {
      throw new Error('unexpected minimax fetch')
    },
  }
}

function liveUtilization(utilization: number, resetsAt: string): Utilization {
  return { five_hour: { utilization, resets_at: resetsAt } }
}

/** Generic so a filtered section keeps every field the caller asserts on. */
function firstPartySections<T extends { provider: string }>(
  providers: T[],
): T[] {
  return providers.filter(section => section.provider === 'firstParty')
}

/** The rendered block for the one section whose header starts with `header`. */
function sectionBlock(text: string, header: string): string {
  const blocks = text.split('\n\n').filter(block => block.startsWith(header))
  // The premise of every assertion made against the block: exactly one
  // section is named this way.
  expect(blocks.length).toBe(1)
  return blocks[0]
}

/** Timestamps move with the clock; the shape of their lines does not. */
function normalizeStamps(text: string): string {
  return text
    .replace(/resets \S+ \([^)]*\)/g, 'resets <RESET>')
    .replace(/last updated: \S+ \([^)]*\)/g, 'last updated: <STAMP>')
}

function capturedAtFor(accountKey: string): number {
  const snapshot = limits
    .listAccountUsageSnapshots()
    .find(entry => entry.accountUuid === accountKey)
  if (!snapshot) {
    throw new Error(`no captured snapshot for ${accountKey}`)
  }
  return snapshot.capturedAt
}

/** Real elapsed time, so two captures get two distinct capturedAt values. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 12))
}

beforeEach(async () => {
  await acquireSharedMutationLock('report.accounts.test.ts')
  for (const key of MANAGED_ENV_KEYS) delete process.env[key]
  activeAccountUuid = LEAD
  storedAccounts = {}
  fakeGlobalConfig = { cachedExtraUsageDisabledReason: null }
  await loadModules()
  limits.clearAccountUsageForTests()
  report.clearUsageReportCache()
})

afterEach(() => {
  try {
    limits.clearAccountUsageForTests()
    report.clearUsageReportCache()
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    mock.restore()
    mock.module('src/utils/auth.js', () => ({ ...realAuthModule }))
    mock.module('src/utils/config.js', () => ({ ...realConfigModule }))
    mock.module('src/utils/secureStorage/index.js', () => ({
      ...realStorageModule,
    }))
  } finally {
    releaseSharedMutationLock()
  }
})

test('criterion 1: two accounts render two sections with their own figures', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({
      uuid: LEAD,
      email: 'lead.person@corp.example',
      label: 'day job',
    }),
    [TEAMMATE]: storedAccount({
      uuid: TEAMMATE,
      email: 'teammate.person@corp.example',
    }),
  }

  // The lead is barely into its window; the account a teammate is routed onto
  // is exhausted and resets in a window matching neither of the lead's. This
  // is the observed symptom the unit exists for.
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )
  await tick()
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.99,
      reset5h: TEAMMATE_5H_RESET,
      utilization7d: 0.72,
      reset7d: TEAMMATE_7D_RESET,
    }),
    TEAMMATE,
  )

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  const sections = firstPartySections(built.providers)
  // Asserted explicitly: this is the number that goes back to 1 if the
  // accounts ever collapse into one section again.
  expect(sections.length).toBe(2)

  const text = report.renderUsageReport(built)
  const leadBlock = sectionBlock(
    text,
    'Anthropic (day job) (firstParty) — active — supported',
  )
  const teammateBlock = sectionBlock(
    text,
    'Anthropic (22222222…) (firstParty) — supported',
  )

  // Each account's own percentages, under its own name.
  expect(leadBlock).toContain('5h window: 1% used')
  expect(leadBlock).toContain('7d window: 4% used')
  expect(teammateBlock).toContain('5h window: 99% used')
  expect(teammateBlock).toContain('7d window: 72% used')
  expect(leadBlock).not.toContain(': 99% used')
  expect(leadBlock).not.toContain(': 72% used')
  expect(teammateBlock).not.toContain(': 1% used')
  expect(teammateBlock).not.toContain(': 4% used')

  // Each account's own reset stamps, and neither carries the other's.
  expect(leadBlock).toContain('resets 2026-09-16T18:00:00.000Z')
  expect(leadBlock).toContain('resets 2026-09-20T06:00:00.000Z')
  expect(teammateBlock).toContain('resets 2026-09-16T21:30:00.000Z')
  expect(teammateBlock).toContain('resets 2026-09-22T09:15:00.000Z')
  expect(leadBlock).not.toContain('2026-09-16T21:30:00.000Z')
  expect(teammateBlock).not.toContain('2026-09-16T18:00:00.000Z')

  // Each account's own lastUpdated. The two captures are asserted to differ
  // first, so a section that borrowed the active account's timestamp fails
  // here instead of passing on a coincidence.
  const leadCapturedAt = capturedAtFor(LEAD)
  const teammateCapturedAt = capturedAtFor(TEAMMATE)
  expect(leadCapturedAt).not.toBe(teammateCapturedAt)
  expect(sections[0].lastUpdated).toBe(
    new Date(leadCapturedAt).toISOString(),
  )
  expect(sections[1].lastUpdated).toBe(
    new Date(teammateCapturedAt).toISOString(),
  )
  expect(leadBlock).toContain(
    `last updated: ${new Date(leadCapturedAt).toISOString()}`,
  )
  expect(teammateBlock).toContain(
    `last updated: ${new Date(teammateCapturedAt).toISOString()}`,
  )

  // Only the account the user is spending is marked active.
  expect(sections[0].isActive).toBe(true)
  expect(sections[1].isActive).toBe(false)
  expect(text.match(/— active —/g)?.length).toBe(1)
})

test('the provider filter still reaches every account, and a name narrows to one', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({ uuid: LEAD, label: 'day job' }),
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE, label: 'side project' }),
  }
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.99,
      reset5h: TEAMMATE_5H_RESET,
      utilization7d: 0.72,
      reset7d: TEAMMATE_7D_RESET,
    }),
    TEAMMATE,
  )

  const all = await report.buildUsageReport({
    providerFilter: 'firstparty',
    fetchers: noFetchers(),
  })
  expect(firstPartySections(all.providers).length).toBe(2)

  const one = await report.buildUsageReport({
    providerFilter: 'side project',
    fetchers: noFetchers(),
  })
  expect(one.providers.length).toBe(1)
  expect(one.providers[0].label).toBe('Anthropic (side project)')
  expect(one.providers[0].rows?.[0]).toMatchObject({ usedPercent: 99 })
})

test('criterion 4: an account known by its email is never named by it', async () => {
  const leadEmail = 'lead.person@corp.example'
  const teammateEmail = 'teammate.person@corp.example'
  storedAccounts = {
    [LEAD]: storedAccount({ uuid: LEAD, email: leadEmail }),
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE, email: teammateEmail }),
  }

  // Premise of the absence assertions below: the address really is in the
  // store, and the on-screen naming really would have printed it. Without
  // this, an empty fixture would pass every not.toContain in this test.
  const stored = accountSwitch.readAccounts()
  const leadSummary = stored.find(account => account.key === LEAD)
  expect(leadSummary?.emailAddress).toBe(leadEmail)
  expect(accountSwitch.accountDisplayName(leadSummary!)).toBe(leadEmail)

  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.99,
      reset5h: TEAMMATE_5H_RESET,
      utilization7d: 0.72,
      reset7d: TEAMMATE_7D_RESET,
    }),
    TEAMMATE,
  )

  const text = report.renderUsageReport(
    await report.buildUsageReport({ fetchers: noFetchers() }),
  )

  expect(firstPartySections(
    (await report.buildUsageReport({ fetchers: noFetchers() })).providers,
  ).length).toBe(2)
  expect(text).not.toContain('@')
  expect(text).not.toContain(leadEmail)
  expect(text).not.toContain(teammateEmail)
  expect(text).not.toContain('lead.person')
  expect(text).not.toContain('teammate.person')
  expect(text).not.toContain('corp.example')
  // Named by the key's first block instead, the same cut error text makes.
  expect(text).toContain('Anthropic (11111111…) (firstParty) — active')
  expect(text).toContain('Anthropic (22222222…) (firstParty) — supported')
})

test('criterion 5: one API-key session renders exactly what it rendered before', async () => {
  activeAccountUuid = undefined
  storedAccounts = {}
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    limits.NO_ACCOUNT_USAGE_KEY,
  )

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  const text = normalizeStamps(report.renderUsageReport(built))
  // Printed so the same case can be rendered by the pre-change code in a
  // detached worktree and the two strings compared directly.
  console.log(`[CRITERION-5-API-KEY]\n${text}\n[/CRITERION-5-API-KEY]`)

  expect(text).toBe(
    [
      'Session: 0 input tokens, 0 output tokens, $0.00',
      '',
      'Anthropic (firstParty) — active — supported',
      '  5h window: 1% used, resets <RESET> [response headers]',
      '  7d window: 4% used, resets <RESET> [response headers]',
      '  last updated: <STAMP>',
    ].join('\n'),
  )
  expect(built.providers.length).toBe(1)
  expect(built.providers[0].provider).toBe('firstParty')
  expect(built.providers[0].label).toBe('Anthropic')
})

test('criterion 5: a single oauth account gains no account annotation', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({
      uuid: LEAD,
      email: 'lead.person@corp.example',
      label: 'day job',
    }),
  }
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  const text = normalizeStamps(report.renderUsageReport(built))
  console.log(`[CRITERION-5-ONE-ACCOUNT]\n${text}\n[/CRITERION-5-ONE-ACCOUNT]`)

  expect(text).toBe(
    [
      'Session: 0 input tokens, 0 output tokens, $0.00',
      '',
      'Anthropic (firstParty) — active — supported',
      '  5h window: 1% used, resets <RESET> [response headers]',
      '  7d window: 4% used, resets <RESET> [response headers]',
      '  last updated: <STAMP>',
    ].join('\n'),
  )
  // The label the user set is not in the header, and neither is the key.
  expect(built.providers[0].label).toBe('Anthropic')
  expect(text).not.toContain('day job')
  expect(text).not.toContain('11111111')
})

test('a live fetch is cached per account, and clearing still clears everything', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({ uuid: LEAD, label: 'day job' }),
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE, label: 'side project' }),
  }

  activeAccountUuid = LEAD
  await report.buildUsageReport({
    refresh: true,
    fetchers: {
      ...noFetchers(),
      fetchClaudeUtilization: async () =>
        liveUtilization(7, '2026-09-16T19:00:00Z'),
    },
  })

  // The switch a routed teammate causes: a second live fetch used to
  // overwrite the first, leaving one figure standing for both accounts.
  activeAccountUuid = TEAMMATE
  const after = await report.buildUsageReport({
    refresh: true,
    fetchers: {
      ...noFetchers(),
      fetchClaudeUtilization: async () =>
        liveUtilization(96, '2026-09-16T23:00:00Z'),
    },
  })

  const sections = firstPartySections(after.providers)
  expect(sections.length).toBe(2)
  const text = report.renderUsageReport(after)
  const activeBlock = sectionBlock(
    text,
    'Anthropic (side project) (firstParty) — active',
  )
  expect(activeBlock).toContain(
    '5h window: 96% used, resets 2026-09-16T23:00:00Z',
  )
  expect(activeBlock).toContain('[live fetch]')
  expect(activeBlock).not.toContain('7% used')
  const keptBlock = sectionBlock(
    text,
    'Anthropic (day job) (firstParty) — supported',
  )
  expect(keptBlock).toContain('5h window: 7% used, resets 2026-09-16T19:00:00Z')
  expect(keptBlock).toContain('[live fetch]')
  expect(keptBlock).not.toContain('96% used')

  report.clearUsageReportCache()
  const cleared = await report.buildUsageReport({ fetchers: noFetchers() })
  expect(firstPartySections(cleared.providers).length).toBe(1)
  expect(cleared.providers[0].rows).toBeUndefined()
  expect(cleared.providers[0].note).toContain(
    'no utilization headers captured yet',
  )
})

test('an account whose capture carried no window gets no section', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({ uuid: LEAD, label: 'day job' }),
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE, label: 'side project' }),
  }
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )
  limits.extractQuotaStatusFromHeaders(windowlessHeaders(), TEAMMATE)

  // The premise: the teammate's slot really was captured, so the report is
  // choosing not to invent a section rather than never having seen it.
  expect(capturedAtFor(TEAMMATE)).toBeGreaterThan(0)

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  expect(firstPartySections(built.providers).length).toBe(1)
  const text = report.renderUsageReport(built)
  expect(text).not.toContain('side project')
  expect(text).not.toContain('22222222')
  // One account with figures, so no annotation either.
  expect(built.providers[0].label).toBe('Anthropic')
})

test('two accounts sharing a key block are numbered apart', async () => {
  storedAccounts = {
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE }),
    [TEAMMATE_TWIN]: storedAccount({ uuid: TEAMMATE_TWIN }),
  }
  activeAccountUuid = TEAMMATE
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    TEAMMATE,
  )
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.99,
      reset5h: TEAMMATE_5H_RESET,
      utilization7d: 0.72,
      reset7d: TEAMMATE_7D_RESET,
    }),
    TEAMMATE_TWIN,
  )

  // Premise: the PII-safe name really is the same for both accounts.
  expect(
    accountSwitch.accountUsageLabel({ key: TEAMMATE, isActive: true }),
  ).toBe(accountSwitch.accountUsageLabel({ key: TEAMMATE_TWIN, isActive: false }))

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  const sections = firstPartySections(built.providers)
  expect(sections.length).toBe(2)
  expect(sections[0].label).toBe('Anthropic (22222222… #1)')
  expect(sections[1].label).toBe('Anthropic (22222222… #2)')
  expect(sections[0].label).not.toBe(sections[1].label)
})

test('switching to a never-seen account adds no section', async () => {
  storedAccounts = {
    [LEAD]: storedAccount({ uuid: LEAD, label: 'day job' }),
    [TEAMMATE]: storedAccount({ uuid: TEAMMATE, label: 'side project' }),
  }
  limits.extractQuotaStatusFromHeaders(
    quotaHeaders({
      utilization5h: 0.01,
      reset5h: LEAD_5H_RESET,
      utilization7d: 0.04,
      reset7d: LEAD_7D_RESET,
    }),
    LEAD,
  )

  // What an account switch now does: projectActiveAccountLimits reaches
  // writableSlot, so the teammate's account gets a SLOT without ever having
  // answered a request. An empty slot is not data.
  activeAccountUuid = TEAMMATE
  limits.projectActiveAccountLimits()
  expect(
    limits
      .listAccountUsageSnapshots()
      .some(entry => entry.accountUuid === TEAMMATE),
  ).toBe(false)

  const built = await report.buildUsageReport({ fetchers: noFetchers() })
  const sections = firstPartySections(built.providers)
  // The active account has nothing to show, so it keeps its honest note; the
  // lead's captured figures stay on their own section. Two sections, and the
  // empty slot is not one of them.
  expect(sections.length).toBe(2)
  expect(sections[0].isActive).toBe(true)
  expect(sections[0].rows).toBeUndefined()
  expect(sections[0].note).toContain('no utilization headers captured yet')
  expect(sections[1].rows?.length).toBe(2)
  const text = report.renderUsageReport(built)
  expect(text.match(/\(firstParty\)/g)?.length).toBe(2)
})
