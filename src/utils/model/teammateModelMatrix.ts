/**
 * Provider-compatible model matrix for teammates.
 *
 * A teammate may only be spawned on a (provider route, model) pair listed
 * here, restricted further by the `teammateModelAllowlist` setting. Without
 * it, a bogus or wrong-provider model passed every up-front check and only
 * failed at the teammate's first API request — a pane teammate then sat
 * 'running' until the 30-minute watchdog fired.
 *
 * The matrix is keyed on descriptor ROUTE ids (routeMetadata), not on
 * getAPIProvider(): the legacy provider collapses Z.ai, DeepSeek, Fireworks,
 * Ollama, OpenCode and more into 'openai', which cannot tell whether
 * `deepseek-v4-pro` is servable. First-party Anthropic is the route id
 * 'anthropic'; Foundry is 'foundry'; Codex OAuth is 'codex'.
 *
 * Every id is covered by a drift guard (teammateModelMatrix.test.ts) that
 * asserts it exists in the model catalog for its route.
 */
import type { ProviderProfile } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
  normalizeComparableBaseUrl,
  getRouteDefaultBaseUrl,
} from '../../integrations/routeMetadata.js'
import { resolveProfileRoute } from '../../integrations/profileResolver.js'
import {
  isCodexBaseUrl,
  shouldUseCodexTransport,
} from '../../services/api/providerConfig.js'
import { CLAUDE_FABLE_5_1_CONFIG, CLAUDE_OPUS_5_5_CONFIG } from './configs.js'

/** One servable (route, model id) pair. */
export type TeammateMatrixEntry = {
  /** Descriptor route id, plus 'codex' and 'foundry'. */
  route: string
  /** Exact model id sent to the API on that route. */
  id: string
}

export type TeammateModelFamily = {
  label: string
  entries: readonly TeammateMatrixEntry[]
}

const onRoutes = (
  routes: readonly string[],
  id: string,
): TeammateMatrixEntry[] => routes.map(route => ({ route, id }))

/**
 * Family key → the exact ids that serve it on each route. Claude ids are
 * derived from the legacy provider config so they cannot drift from the
 * first-party default.
 */
export const TEAMMATE_MODEL_MATRIX = {
  'opus-5.5': {
    label: 'Claude Opus 5.5',
    entries: [
      { route: 'anthropic', id: CLAUDE_OPUS_5_5_CONFIG.firstParty },
      { route: 'vertex', id: CLAUDE_OPUS_5_5_CONFIG.vertex },
      { route: 'foundry', id: CLAUDE_OPUS_5_5_CONFIG.foundry },
      { route: 'bedrock', id: CLAUDE_OPUS_5_5_CONFIG.bedrock },
    ],
  },
  'glm-5.3': {
    label: 'GLM 5.3',
    entries: [
      { route: 'zai', id: 'glm-5.3' },
      { route: 'zai', id: 'glm-5.3-flash' },
      { route: 'commandcode', id: 'z-ai/glm-5.3-flash' },
    ],
  },
  'gpt-6': {
    label: 'GPT-6',
    entries: onRoutes(['openai', 'codex'], 'gpt-6-astra'),
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    entries: [
      { route: 'deepseek', id: 'deepseek-v4-pro' },
      { route: 'nvidia-nim', id: 'deepseek-ai/deepseek-v4-pro' },
      { route: 'fireworks', id: 'accounts/fireworks/models/deepseek-v4-pro' },
      { route: 'ollama', id: 'deepseek-v4-pro:cloud' },
      ...onRoutes(['opencode', 'opencode-go'], 'deepseek-v4-pro'),
      { route: 'atlas-cloud', id: 'deepseek-ai/deepseek-v4-pro' },
      ...onRoutes(['llmtr', 'commandcode'], 'deepseek/deepseek-v4-pro'),
      { route: 'clinepass', id: 'cline-pass/deepseek-v4-pro' },
      { route: 'hicap', id: 'deepseek-v4-pro' },
    ],
  },
  'fable-5.1': {
    label: 'Claude Fable 5.1',
    entries: [
      { route: 'anthropic', id: CLAUDE_FABLE_5_1_CONFIG.firstParty },
      { route: 'vertex', id: CLAUDE_FABLE_5_1_CONFIG.vertex },
      { route: 'foundry', id: CLAUDE_FABLE_5_1_CONFIG.foundry },
      { route: 'bedrock', id: CLAUDE_FABLE_5_1_CONFIG.bedrock },
    ],
  },
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    entries: [
      { route: 'deepseek', id: 'deepseek-flash' },
      { route: 'fireworks', id: 'accounts/fireworks/models/deepseek-v4p1-flash' },
    ],
  },
} as const satisfies Record<string, TeammateModelFamily>

export type TeammateModelFamilyKey = keyof typeof TEAMMATE_MODEL_MATRIX

export const TEAMMATE_MODEL_FAMILY_KEYS = Object.keys(
  TEAMMATE_MODEL_MATRIX,
) as TeammateModelFamilyKey[]

/** Routes whose ids live in the legacy Claude provider config, not a catalog. */
export const CLAUDE_NATIVE_TEAMMATE_ROUTES = [
  'anthropic',
  'vertex',
  'foundry',
  'bedrock',
] as const

/** Setting value that disables the check (custom/local models). */
export const TEAMMATE_MODEL_ALLOWLIST_WILDCARD = '*'

/**
 * Comparable form of a model id: drops the Anthropic `[1m]` context tag and
 * any `?reasoning=` query, lower-cased. `claude-opus-5-5[1m]` is the same
 * model on the wire as `claude-opus-5-5`.
 */
export function normalizeTeammateModelId(model: string): string {
  const trimmed = model.trim().replace(/\[1m]$/i, '')
  return (trimmed.split('?', 1)[0] ?? trimmed).toLowerCase()
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

const GENERIC_OPENAI_ROUTES = new Set(['openai', 'custom', 'unknown-fallback'])

function codexOr(
  route: string,
  model: string | undefined,
  baseUrl: string | undefined,
): string {
  if (!GENERIC_OPENAI_ROUTES.has(route)) return route
  if (isCodexBaseUrl(baseUrl)) return 'codex'
  if (model && shouldUseCodexTransport(model, baseUrl)) return 'codex'
  return route
}

function routeFromOpenAIBaseUrl(baseUrl: string | undefined): string {
  const matched = resolveRouteIdFromBaseUrl(baseUrl)
  if (matched) return matched
  const normalized = normalizeComparableBaseUrl(baseUrl)
  if (
    !normalized ||
    normalized === normalizeComparableBaseUrl(getRouteDefaultBaseUrl('openai'))
  ) {
    return 'openai'
  }
  return 'custom'
}

/**
 * The provider route a teammate will actually run on — the key into
 * TEAMMATE_MODEL_MATRIX. Precedence mirrors how the child process is set up:
 *
 * 1. a bound provider profile (provider_profile / agentRouting profile route);
 * 2. an agentModels cross-provider override (its base URL);
 * 3. otherwise the environment the teammate inherits from the leader — the
 *    live process env, which startup has already populated from the active
 *    provider profile (the same source getAPIProvider() reads).
 *
 * openai/custom resolves to 'codex' when the Codex transport would be used:
 * a Codex base URL, or — with no explicit base URL — a Codex alias such as
 * gpt-6-astra or codexplan (shouldUseCodexTransport). That matches
 * resolveProviderRequest, which picks the codex_responses transport in the
 * same cases, and Codex OAuth serves a different model set than OpenAI.
 */
export function resolveTeammateProviderRoute({
  model,
  profile,
  overrideBaseUrl,
  env = process.env,
}: {
  model?: string
  profile?: Pick<ProviderProfile, 'provider' | 'baseUrl'>
  overrideBaseUrl?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}): string {
  if (profile) {
    const route = resolveProfileRoute(profile.provider).routeId
    const baseRoute = GENERIC_OPENAI_ROUTES.has(route)
      ? routeFromOpenAIBaseUrl(profile.baseUrl)
      : route
    return codexOr(baseRoute, model, profile.baseUrl)
  }
  if (overrideBaseUrl) {
    return codexOr(routeFromOpenAIBaseUrl(overrideBaseUrl), model, overrideBaseUrl)
  }
  if (isEnvTruthy(env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  const route = resolveActiveRouteIdFromEnv(env as NodeJS.ProcessEnv) ?? 'anthropic'
  const baseUrl = env.OPENAI_BASE_URL || env.OPENAI_API_BASE || undefined
  return codexOr(route, model, baseUrl)
}

// ---------------------------------------------------------------------------
// Allowlist + decision
// ---------------------------------------------------------------------------

const warnedUnknownEntries = new Set<string>()

/** Exported for tests: forget which unknown allowlist entries were warned. */
export function _resetTeammateAllowlistWarningsForTesting(): void {
  warnedUnknownEntries.clear()
}

function isFamilyKey(key: string): key is TeammateModelFamilyKey {
  return Object.hasOwn(TEAMMATE_MODEL_MATRIX, key)
}

const ALL_MATRIX_IDS = new Set(
  TEAMMATE_MODEL_FAMILY_KEYS.flatMap(key =>
    TEAMMATE_MODEL_MATRIX[key].entries.map(entry =>
      normalizeTeammateModelId(entry.id),
    ),
  ),
)

/**
 * The matrix entries the allowlist admits. Unset → every family. An entry is
 * a family key (whole family) or an exact matrix id (that id on every route
 * that lists it). Anything else warns once and is ignored — never a crash.
 * Returns null for the `*` wildcard: the check is disabled.
 */
export function getAllowedTeammateEntries(
  allowlist: readonly string[] | undefined,
): TeammateMatrixEntry[] | null {
  const all = TEAMMATE_MODEL_FAMILY_KEYS.flatMap(
    key => TEAMMATE_MODEL_MATRIX[key].entries as readonly TeammateMatrixEntry[],
  )
  if (allowlist === undefined) return all
  if (allowlist.some(item => item.trim() === TEAMMATE_MODEL_ALLOWLIST_WILDCARD)) {
    return null
  }
  const allowed: TeammateMatrixEntry[] = []
  for (const raw of allowlist) {
    const item = raw.trim()
    if (isFamilyKey(item)) {
      allowed.push(...TEAMMATE_MODEL_MATRIX[item].entries)
      continue
    }
    const id = normalizeTeammateModelId(item)
    if (ALL_MATRIX_IDS.has(id)) {
      allowed.push(
        ...all.filter(entry => normalizeTeammateModelId(entry.id) === id),
      )
      continue
    }
    if (!warnedUnknownEntries.has(item)) {
      warnedUnknownEntries.add(item)
      console.warn(
        `[teammateModelAllowlist] Ignoring unknown entry "${item}": not a teammate model family (${TEAMMATE_MODEL_FAMILY_KEYS.join(', ')}) or a model id from one. Use "*" to allow any model.`,
      )
    }
  }
  return allowed
}

export type TeammateModelCheckInput = {
  /** The model the teammate will actually run (aliases/inherit expanded). */
  resolvedModel: string
  /**
   * What the caller asked for, when it differs (an alias such as
   * 'codexplan' → 'gpt-5.6-sol'). Only used to name both in the message.
   */
  requestedModel?: string
  /** The route from resolveTeammateProviderRoute. */
  providerRoute: string
  /**
   * True when the teammate simply runs the leader's own current model on the
   * leader's own provider (no model param, no routing, no profile). That pair
   * is already proven to work by the leader itself, so it is always allowed —
   * even for a custom or local model the matrix has never heard of.
   */
  isInheritingLeader: boolean
  /** settings.teammateModelAllowlist. */
  allowlist: readonly string[] | undefined
}

/** Null when allowed, else the refusal message. */
export function checkTeammateModelAllowed({
  resolvedModel,
  requestedModel,
  providerRoute,
  isInheritingLeader,
  allowlist,
}: TeammateModelCheckInput): string | null {
  if (isInheritingLeader) return null
  const allowed = getAllowedTeammateEntries(allowlist)
  if (allowed === null) return null

  const model = normalizeTeammateModelId(resolvedModel)
  const onRoute = allowed.filter(entry => entry.route === providerRoute)
  if (onRoute.some(entry => normalizeTeammateModelId(entry.id) === model)) {
    return null
  }
  const here = [...new Set(onRoute.map(entry => entry.id))]
  const wire = resolvedModel.trim()
  const asked = requestedModel?.trim()
  const named =
    asked && normalizeTeammateModelId(asked) !== model
      ? `'${asked}' (resolves to '${wire}')`
      : `'${wire}'`
  return `Model ${named} is not allowed for teammates on provider '${providerRoute}'. Allowed here: ${here.length > 0 ? here.join(', ') : 'none'}. Configure teammateModelAllowlist to change this.`
}

/** Throwing wrapper around checkTeammateModelAllowed. */
export function assertTeammateModelCheck(input: TeammateModelCheckInput): void {
  const refusal = checkTeammateModelAllowed(input)
  if (refusal) throw new Error(refusal)
}
