/**
 * Multi-account bookkeeping for Claude subscription OAuth credentials.
 *
 * Credentials used to live in a single `claudeAiOauth` slot, so logging into a
 * second account destroyed the first one's refresh token. This module keeps a
 * map of accounts beside that slot, and keeps the slot itself as a mirror of
 * whichever account is active:
 *
 *   claudeAiOauth        <- mirror of the active account (legacy readers)
 *   claudeAiOauthAccounts <- every account, keyed by account UUID
 *   claudeAiOauthActive   <- which key the mirror reflects
 *
 * Keeping the mirror is what makes a downgrade safe: an older build reads and
 * writes only `claudeAiOauth`, and because every writer of the credentials
 * file does a whole-object read-modify-write, the accounts map survives
 * untouched. The cost is that the mirror can drift ahead of the map whenever
 * an old build (or a token refresh that predates this module) writes it —
 * which is why every read path goes through `migrateAndReconcile`.
 *
 * Everything above `withCredentialLock` is pure: it maps one
 * `SecureStorageData` to another and touches no disk.
 */

import { mkdir } from 'fs/promises'
import type { OAuthTokens } from '../services/oauth/types.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { lock } from './lockfile.js'
import {
  getSecureStorage,
  type SecureStorage,
  type SecureStorageData,
  type StoredClaudeAccount,
} from './secureStorage/index.js'

/**
 * Key used for a pre-existing credential whose account UUID we cannot
 * recover. Migration must never drop tokens just because the token blob
 * predates the account identity fields.
 */
export const LEGACY_ACCOUNT_KEY = 'default'

/** A single account as the UI wants to see it. */
export type AccountSummary = {
  key: string
  label?: string
  emailAddress?: string
  isActive: boolean
}

/**
 * The non-secret identity the CALLER already holds for an account, keyed by
 * the same account UUID the credential map uses — the shape
 * `config.oauthAccounts` stores, narrowed to the one field naming needs.
 *
 * It is a PARAMETER rather than a config read because everything above
 * `withCredentialLock` is pure; `readAccounts` in `accountSwitch.ts` is the
 * designated meeting point of the two halves and is where it is supplied.
 */
export type AccountIdentities = Record<string, { emailAddress?: string }>

// --- pure helpers -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality over JSON-shaped values, used to decide `changed`. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((value, index) => deepEqual(value, b[index]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false
  }
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every(
    key =>
      Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  )
}

/** Strip the label so the legacy mirror stays a plain `OAuthTokens`. */
function toMirror(account: StoredClaudeAccount): OAuthTokens {
  const { label: _label, ...tokens } = account
  return tokens
}

/**
 * Best-effort account UUID for a token blob. Tokens saved before account
 * identity was recorded have neither field, and get `undefined`.
 */
export function accountKeyForTokens(tokens: OAuthTokens): string | undefined {
  return tokens.tokenAccount?.uuid ?? tokens.profile?.account.uuid
}

function emailForTokens(tokens: OAuthTokens): string | undefined {
  return tokens.tokenAccount?.emailAddress ?? tokens.profile?.account.email
}

/** Apply the accounts map, active key and mirror as one consistent triple. */
function withAccounts(
  data: SecureStorageData,
  accounts: Record<string, StoredClaudeAccount>,
  activeKey: string | undefined,
): SecureStorageData {
  const next: SecureStorageData = { ...data }
  const keys = Object.keys(accounts)

  if (keys.length === 0) {
    delete next.claudeAiOauthAccounts
    delete next.claudeAiOauthActive
    delete next.claudeAiOauth
    return next
  }

  const active = activeKey !== undefined && accounts[activeKey] ? activeKey : keys[0]!
  next.claudeAiOauthAccounts = accounts
  next.claudeAiOauthActive = active
  next.claudeAiOauth = toMirror(accounts[active]!)
  return next
}

/**
 * Bring a credentials blob up to the multi-account shape, and heal drift
 * between the mirror and the map.
 *
 * - A legacy blob with only `claudeAiOauth` gains a one-entry map.
 * - If both exist, the MIRROR WINS for the active key: a token refresh or an
 *   older build writes the mirror only, so it is the fresher of the two. The
 *   stored label is preserved because the mirror cannot carry one.
 * - Accounts other than the active one are never touched.
 *
 * `changed` is false when nothing needed doing, so callers can skip the write.
 */
export function migrateAndReconcile(
  data: SecureStorageData,
  preferredKey?: string,
): { data: SecureStorageData; changed: boolean } {
  const accounts: Record<string, StoredClaudeAccount> = {
    ...(data.claudeAiOauthAccounts ?? {}),
  }
  const mirror = data.claudeAiOauth
  let active = data.claudeAiOauthActive

  if (mirror) {
    // The mirror's own identity decides whose entry it heals — never the
    // active key. An older build that logs in as a different account writes
    // the mirror and leaves `claudeAiOauthActive` pointing at the previous
    // one; trusting that stale key here would copy the new account's tokens
    // over the old account's refresh token and log it out for good.
    // `active` is consulted only for blobs that carry no identity at all.
    const key =
      accountKeyForTokens(mirror) ??
      preferredKey ??
      active ??
      LEGACY_ACCOUNT_KEY
    const existingLabel = accounts[key]?.label
    accounts[key] =
      existingLabel === undefined
        ? { ...mirror }
        : { ...mirror, label: existingLabel }
    active = key
  }

  const next = withAccounts(data, accounts, active)
  const changed = !deepEqual(
    {
      accounts: data.claudeAiOauthAccounts,
      active: data.claudeAiOauthActive,
      mirror: data.claudeAiOauth,
    },
    {
      accounts: next.claudeAiOauthAccounts,
      active: next.claudeAiOauthActive,
      mirror: next.claudeAiOauth,
    },
  )
  return { data: next, changed }
}

/**
 * Every stored account, active one first-class via `isActive`.
 *
 * `identities` names an account whose own token blob carries none — which is
 * every credential written before the identity fields existed, so in practice
 * every account already on a user's disk. Without it such an entry can only
 * be printed as a raw UUID, and a query by email cannot match it at all.
 *
 * It fills a hole and never overrides one: the token blob is the account the
 * credential actually belongs to, while the identity map is a mirror that can
 * lag behind a re-login. An entry keyed `default` has no account UUID by
 * definition, so nothing can be joined to it.
 */
export function listAccounts(
  data: SecureStorageData,
  identities: AccountIdentities = {},
): AccountSummary[] {
  const accounts = data.claudeAiOauthAccounts ?? {}
  const active = data.claudeAiOauthActive
  return Object.entries(accounts).map(([key, account]) => ({
    key,
    label: account.label,
    emailAddress: emailForTokens(account) ?? identities[key]?.emailAddress,
    isActive: key === active,
  }))
}

/** Why the client cannot vouch for a stored account as an auto-switch target. */
export type AccountVouchFailure = 'no-refresh-token' | 'expired' | 'unnameable'

/**
 * Whether the client can vouch for `account` as an AUTOMATIC switch target.
 *
 * A usage-limit 429 moves the user onto another stored account without asking
 * them, so the bar is higher than "an entry exists": the client must be able
 * to obtain a live credential for it and to say whose account it is. An entry
 * that fails is neither repaired nor pruned here — it stays on disk exactly as
 * it is and merely stops being selectable.
 *
 * Returns the FIRST failing condition, or undefined when the account is
 * vouchable. The order is fixed and observable, because each condition has a
 * test built from a fixture that fails exactly one of them:
 *
 *   1. 'no-refresh-token' — no credential could be obtained for it.
 *   2. 'expired'          — see the strictness note below.
 *   3. 'unnameable'       — no account UUID, so nothing the user would
 *                           recognise could be printed for it either.
 *
 * Both value checks are structural rather than nullish on purpose. Stored
 * credentials are parsed JSON that these types have never validated, so a
 * legacy blob can simply omit a field `OAuthTokens` declares required:
 * `expiresAt` is typed `number | null`, so an `=== null` check typechecks
 * perfectly clean while letting a blob carrying no `expiresAt` key at all
 * through as vouchable — the exact silent hole this guard exists to close.
 */
export function vouchForAccount(
  account: StoredClaudeAccount,
  now: number,
): AccountVouchFailure | undefined {
  // undefined, null and '' are all "no refresh token": only a non-empty string
  // is a credential that could actually be presented. The value is inspected
  // for emptiness and nothing else — never read, returned or logged.
  if (typeof account.refreshToken !== 'string' || account.refreshToken === '') {
    return 'no-refresh-token'
  }
  // `<= now` because a token expiring this millisecond is already useless.
  // Strict on purpose: an idle account with a real refresh token and a stale
  // access token IS excluded, because presenting a stored refresh token is
  // itself the suspected trigger of the revocations this guard was written
  // for. Relaxing it belongs with that investigation, not here.
  if (typeof account.expiresAt !== 'number' || account.expiresAt <= now) {
    return 'expired'
  }
  // Nameability is the module's own `tokenAccount ?? profile` identity rule —
  // either identity alone is enough, so this is "neither", not "not both".
  if (accountKeyForTokens(account) === undefined) {
    return 'unnameable'
  }
  return undefined
}

/**
 * Keys of every stored account the client can vouch for as a switch target.
 *
 * Pure: no disk, no mutation. `readVouchableAccountKeys` in `accountSwitch.ts`
 * is the reading counterpart.
 */
export function vouchableAccountKeys(
  data: SecureStorageData,
  now: number,
): Set<string> {
  const accounts = data.claudeAiOauthAccounts ?? {}
  const vouchable = new Set<string>()
  for (const [key, account] of Object.entries(accounts)) {
    if (vouchForAccount(account, now) === undefined) {
      vouchable.add(key)
    }
  }
  return vouchable
}

/** The active account, or null when nobody is logged in. */
export function getActiveAccount(
  data: SecureStorageData,
): { key: string; account: StoredClaudeAccount } | null {
  const active = data.claudeAiOauthActive
  const account = active ? data.claudeAiOauthAccounts?.[active] : undefined
  if (!active || !account) {
    return null
  }
  return { key: active, account }
}

/** Switch the active account, re-pointing the mirror. Throws on unknown key. */
export function setActiveAccount(
  data: SecureStorageData,
  key: string,
): SecureStorageData {
  const accounts = data.claudeAiOauthAccounts ?? {}
  if (!accounts[key]) {
    throw new Error(`No stored Claude account with key ${key}`)
  }
  return withAccounts(data, { ...accounts }, key)
}

/** Add or replace an account. Activating it also re-points the mirror. */
export function addAccount(
  data: SecureStorageData,
  key: string,
  tokens: OAuthTokens,
  options?: { label?: string; activate?: boolean },
): SecureStorageData {
  const accounts = { ...(data.claudeAiOauthAccounts ?? {}) }
  const label = options?.label ?? accounts[key]?.label
  accounts[key] =
    label === undefined ? { ...tokens } : { ...tokens, label }
  const activate = options?.activate ?? true
  return withAccounts(
    data,
    accounts,
    activate ? key : data.claudeAiOauthActive,
  )
}

/**
 * Forget one account. Removing the active one promotes a survivor rather than
 * leaving the CLI logged out; removing the last one clears the slot entirely.
 */
export function removeAccount(
  data: SecureStorageData,
  key: string,
): SecureStorageData {
  const accounts = { ...(data.claudeAiOauthAccounts ?? {}) }
  if (!accounts[key]) {
    return data
  }
  delete accounts[key]
  const active = data.claudeAiOauthActive === key ? undefined : data.claudeAiOauthActive
  return withAccounts(data, accounts, active)
}

// --- IO ---------------------------------------------------------------------

const MAX_LOCK_RETRIES = 5
const LOCK_RETRY_BASE_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Raised when the credential lock could not be taken within the retries. */
export class CredentialLockError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'CredentialLockError'
  }
}

/**
 * Run `fn` holding the credential lock.
 *
 * The lock target is the config directory itself — deliberately the same one
 * `checkAndRefreshOAuthTokenIfNeeded` takes, so an account switch and a token
 * refresh in another process cannot interleave their read-modify-writes and
 * lose one of them.
 */
export async function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = getClaudeConfigHomeDir()
  await mkdir(configDir, { recursive: true })

  let release: (() => Promise<void>) | undefined
  for (let attempt = 0; attempt <= MAX_LOCK_RETRIES; attempt++) {
    try {
      release = await lock(configDir)
      break
    } catch (e: unknown) {
      if (getErrnoCode(e) !== 'ELOCKED') {
        throw e
      }
      if (attempt === MAX_LOCK_RETRIES) {
        throw new CredentialLockError(
          `Could not acquire the credential lock after ${MAX_LOCK_RETRIES + 1} attempts`,
          e,
        )
      }
      await sleep(
        LOCK_RETRY_BASE_MS * 2 ** attempt + Math.random() * LOCK_RETRY_BASE_MS,
      )
    }
  }

  try {
    return await fn()
  } finally {
    await release?.()
  }
}

/**
 * Read the credentials, reconcile them, apply `mutate`, and write the result —
 * all under the credential lock, so the read and the write cannot be split by
 * a concurrent writer.
 */
export async function mutateAccountsLocked(
  mutate: (data: SecureStorageData) => SecureStorageData,
  options?: {
    allowPlainTextFallback?: boolean
    /** Injection seam for tests; defaults to the platform storage. */
    storage?: SecureStorage
  },
): Promise<{ success: boolean; warning?: string }> {
  const storage =
    options?.storage ??
    getSecureStorage({ allowPlainTextFallback: options?.allowPlainTextFallback })

  return withCredentialLock(async () => {
    const current = (await storage.readAsync()) ?? {}
    const reconciled = migrateAndReconcile(current).data
    return storage.update(mutate(reconciled))
  })
}
