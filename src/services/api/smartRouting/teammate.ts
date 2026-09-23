/**
 * Teammate dispatch: pick a model for each spawned teammate from its role.
 *
 * One JEV call per dispatch (auto and suggest mode) asks role, complexity,
 * needs_long_context, `model` — a choice over EVERY spawnable model: each
 * catalog id on each configured route (Anthropic OAuth Claude ids, every
 * saved profile's models), filtered by teammateModelAllowlist and the
 * organization allowlist — and `agent_type` — a choice over the loaded agent
 * definitions plus `default`. Explicit models and types are never asked about.
 *
 * Hard rules hold before and after asking: a review/verify teammate never
 * gets a model family used by an implementer in the same team (a family is
 * a vendor model line — every Claude Opus version is one, every GPT-5.x is
 * one; see separationFamilyOf), and computer_use needs vision. A pick that
 * breaks a rule or fails Rule A falls to the best rule-abiding option by
 * probability (Rule A on the renormalized rest), else to the heuristic: a
 * keyword role guess and the role → tier → family table.
 *
 * Two soft preferences sit under the hard rules. Usage-aware dispatch
 * (teammateDispatch.usage, routeUsage.ts): a route at or over `exhausted`
 * leaves the candidate list (unless nothing rule-abiding would remain), a
 * route at or over `high` is demoted behind calmer providers, unknown
 * counts as calm. Cross-vendor review: a review/verify teammate prefers a
 * vendor no implementer used (a Claude implementer gets a GPT reviewer when
 * one is available), ranked ahead in the tier table and hinted to JEV; a
 * confident same-vendor JEV pick still stands.
 *
 * Never throws. Never blocks longer than the JEV timeout. When nothing
 * qualifies the teammate spawns on today's default model with a warning —
 * except a review/verify teammate with implementers to avoid, which gets a
 * refusal: the default model may be the implementer's own family. The
 * caller re-checks separation on the FINAL model whatever its source.
 */
import type { ProviderProfile } from '../../../utils/config.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import {
  getAllowedTeammateEntries,
  normalizeTeammateModelId,
  resolveTeammateProviderRoute,
  TEAMMATE_MODEL_ALLOWLIST_WILDCARD,
  TEAMMATE_MODEL_MATRIX,
  TEAMMATE_MODEL_FAMILY_KEYS,
  type TeammateMatrixEntry,
  type TeammateModelFamilyKey,
} from '../../../utils/model/teammateModelMatrix.js'
import {
  findProviderProfilesForModel,
  getProviderProfiles,
} from '../../../utils/providerProfiles.js'
import {
  getCatalogEntriesForRoute,
  getModel as getCatalogModel,
} from '../../../integrations/registry.js'
import { LEGACY_PROVIDER_MODEL_CONFIGS } from '../../../utils/model/configs.js'
import { parseModelList } from '../../../utils/providerModels.js'
import { ensureIntegrationsLoaded } from '../../../integrations/index.js'
import { parseUserSpecifiedModel } from '../../../utils/model/model.js'
import { readTeamFile } from '../../../utils/swarm/teamHelpers.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isModelAllowed } from '../../../utils/model/modelAllowlist.js'
import { hasAnthropicApiKeyAuth, isAnthropicAuthEnabled } from '../../../utils/auth.js'
import * as jevClient from '../../jev/client.js'
import type { JevAnswer, JevRequest, JevResult } from '../../jev/client.js'
import { formatRouteUsage, readRouteUsage, type RouteUsageLevel } from './routeUsage.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const TEAMMATE_ROLES = [
  'research',
  'implement',
  'review',
  'verify',
  'design',
  'computer_use',
] as const
export type TeammateRole = (typeof TEAMMATE_ROLES)[number]

export const DISPATCH_TIERS = ['deep', 'standard', 'fast'] as const
export type DispatchTier = (typeof DISPATCH_TIERS)[number]

export type DispatchFamily = TeammateModelFamilyKey | 'gpt-5.6'

export type DispatchComplexity = 'trivial' | 'moderate' | 'hard'

export type TeammateDispatchMode = 'auto' | 'suggest' | 'off'

export type TeammateRouteInput = {
  description?: string
  prompt?: string
  name?: string
  subagent_type?: string
  /** The model the caller (or agent definition) set; enforces separation only. */
  explicitModel?: string
  teamName?: string
  settings: SettingsJson | null | undefined
  /** The leader's resolved model, for members that inherit it. */
  leaderModel?: string
  /** Loaded agent definitions; set to let JEV choose the agent type. */
  agentTypes?: readonly AgentTypeOption[]
  /** Teammates cannot be built-in types; subagents can. Default 'teammate'. */
  spawnPath?: 'teammate' | 'subagent'
  /** The caller resolves an explicit model later: ask role and type only. */
  modelIsExplicit?: boolean
  /** Reuse this decision's role (no JEV call) — the explicit-model recheck. */
  prior?: TeammateRouteDecision
  /**
   * False for in-process spawns (subagents, in-process teammates): they share
   * the leader's provider env, so only leader-route candidates are usable.
   */
  allowProfileBinding?: boolean
}

/** An implementer's separation family (see separationFamilyOf). */
export type TeammateRouteExclusion = { family: string; by: string }

export type TeammateRouteDecision = {
  role: TeammateRole
  tier: DispatchTier
  family?: DispatchFamily
  model?: string
  /** Saved provider profile id to bind when the model is not on the leader's route. */
  providerProfile?: string
  source: 'jev' | 'heuristic' | 'explicit' | 'off'
  /**
   * Where the model came from, when it differs from the role's source:
   * `jev` (JEV's pick), `tier` (the tier table, e.g. after JEV's pick was
   * rejected), `explicit`, or `none` (nothing qualified).
   */
  modelSource?: 'jev' | 'tier' | 'explicit' | 'none'
  mode: TeammateDispatchMode
  reason: string
  complexity?: DispatchComplexity
  /** Where the role came from, and why. */
  roleSource?: 'jev' | 'heuristic'
  roleReason?: string
  /** Role probabilities from JEV. */
  probabilities?: Record<string, number>
  /** Model-choice probabilities from JEV. */
  modelProbabilities?: Record<string, number>
  /** Chosen agent type (`default` = none), and JEV's p for it. */
  agentType?: string
  agentTypeP?: number
  agentTypeProbabilities?: Record<string, number>
  costUsd?: number
  latencyMs?: number
  excluded?: TeammateRouteExclusion[]
  /** Models removed from the candidate list, with why. */
  excludedModels?: ModelExclusion[]
  /**
   * Set when the separation rule refuses the spawn: an explicit/inherited
   * model in an implementer's family, or no allowed model for a
   * review/verify teammate at all.
   */
  refusal?: string
  /** Set when nothing qualified and the default model is used. */
  warning?: string
  /** Usage level of every route a candidate was on (usage-aware dispatch). */
  routeUsage?: Record<string, RouteUsageLevel['level']>
}

/** Compact form stored on the team member and in the startup record. */
export type TeammateDispatchRecord = {
  role: TeammateRole
  family?: string
  model?: string
  agentType?: string
  agentTypeP?: number
  source: TeammateRouteDecision['source']
  mode: TeammateDispatchMode
  reason: string
  probabilities?: Record<string, number>
  costUsd?: number
  routeUsage?: Record<string, RouteUsageLevel['level']>
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

export const DEFAULT_ROLE_TIERS: Readonly<Record<TeammateRole, DispatchTier>> = {
  review: 'deep',
  design: 'deep',
  implement: 'standard',
  verify: 'standard',
  research: 'standard',
  computer_use: 'fast',
}

export const DEFAULT_TIER_FAMILIES: Readonly<
  Record<DispatchTier, readonly DispatchFamily[]>
> = {
  deep: ['fable-5.1', 'opus-5.5', 'gpt-6'],
  standard: ['sonnet-5', 'deepseek-v4-pro', 'glm-5.3', 'gpt-5.6'],
  fast: ['deepseek-v4.1-flash', 'glm-5.3', 'gpt-5.6'],
}

type DispatchFamilyDef = {
  entries: readonly TeammateMatrixEntry[]
  /** Ids of this family to use per tier; absent → every entry. */
  tierIds?: Partial<Record<DispatchTier, readonly string[]>>
}

/**
 * The dispatcher's own candidate table: the teammate matrix plus the
 * `gpt-5.6` pseudo-family (Codex), which deliberately is NOT in
 * TEAMMATE_MODEL_MATRIX and is only usable under a `["*"]` allowlist.
 */
export const DISPATCH_FAMILIES: Readonly<Record<DispatchFamily, DispatchFamilyDef>> = {
  ...(Object.fromEntries(
    TEAMMATE_MODEL_FAMILY_KEYS.map(key => [
      key,
      { entries: TEAMMATE_MODEL_MATRIX[key].entries as readonly TeammateMatrixEntry[] },
    ]),
  ) as Record<TeammateModelFamilyKey, DispatchFamilyDef>),
  'glm-5.3': {
    entries: TEAMMATE_MODEL_MATRIX['glm-5.3'].entries,
    tierIds: {
      fast: ['glm-5.3-flash', 'z-ai/glm-5.3-flash'],
      standard: ['glm-5.3'],
      deep: ['glm-5.3'],
    },
  },
  'gpt-5.6': {
    entries: [
      { route: 'codex', id: 'gpt-5.6-sol' },
      { route: 'codex', id: 'gpt-5.6-luna' },
    ],
    tierIds: {
      fast: ['gpt-5.6-luna'],
      standard: ['gpt-5.6-sol'],
      deep: ['gpt-5.6-sol'],
    },
  },
}

const DISPATCH_FAMILY_KEYS = Object.keys(DISPATCH_FAMILIES) as DispatchFamily[]

function isDispatchFamily(value: string): value is DispatchFamily {
  return Object.hasOwn(DISPATCH_FAMILIES, value)
}
function isRole(value: string): value is TeammateRole {
  return (TEAMMATE_ROLES as readonly string[]).includes(value)
}
function isTier(value: string): value is DispatchTier {
  return (DISPATCH_TIERS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type NormalizedTeammateDispatch = {
  mode: TeammateDispatchMode
  roleTiers: Record<TeammateRole, DispatchTier>
  tierFamilies: Record<DispatchTier, DispatchFamily[]>
  jev: { enabled: boolean; timeoutMs?: number; minP?: number; minMargin?: number }
  /** Lower-cased exact ids the user pruned (teammateDispatch.excludeModels). */
  excludeModels: string[]
  /** Usage-aware dispatch thresholds (teammateDispatch.usage). */
  usage: { enabled: boolean; high: number; exhausted: number }
}

export const DEFAULT_USAGE_HIGH = 0.8
export const DEFAULT_USAGE_EXHAUSTED = 0.95

const warnedPolicyEntries = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedPolicyEntries.has(key)) return
  warnedPolicyEntries.add(key)
  console.warn(`[teammateDispatch] ${message}`)
}

/** Exported for tests. */
export function _resetTeammateDispatchWarningsForTesting(): void {
  warnedPolicyEntries.clear()
}

export function readTeammateDispatchSettings(
  settings: SettingsJson | null | undefined,
): NormalizedTeammateDispatch {
  const raw = settings?.teammateDispatch
  const mode: TeammateDispatchMode =
    raw?.mode === 'off' || raw?.mode === 'suggest' ? raw.mode : 'auto'
  const roleTiers: Record<TeammateRole, DispatchTier> = { ...DEFAULT_ROLE_TIERS }
  for (const [role, tier] of Object.entries(raw?.policy?.roles ?? {})) {
    if (!isRole(role)) {
      warnOnce(`role:${role}`, `Ignoring unknown role "${role}" in policy.roles (roles: ${TEAMMATE_ROLES.join(', ')}).`)
      continue
    }
    if (typeof tier !== 'string' || !isTier(tier)) {
      warnOnce(`roletier:${role}:${String(tier)}`, `Ignoring unknown tier "${String(tier)}" for role "${role}" (tiers: ${DISPATCH_TIERS.join(', ')}).`)
      continue
    }
    roleTiers[role] = tier
  }
  const tierFamilies: Record<DispatchTier, DispatchFamily[]> = {
    deep: [...DEFAULT_TIER_FAMILIES.deep],
    standard: [...DEFAULT_TIER_FAMILIES.standard],
    fast: [...DEFAULT_TIER_FAMILIES.fast],
  }
  for (const [tier, families] of Object.entries(raw?.policy?.tiers ?? {})) {
    if (!isTier(tier)) {
      warnOnce(`tier:${tier}`, `Ignoring unknown tier "${tier}" in policy.tiers (tiers: ${DISPATCH_TIERS.join(', ')}).`)
      continue
    }
    if (!Array.isArray(families)) continue
    const known: DispatchFamily[] = []
    for (const family of families) {
      if (typeof family === 'string' && isDispatchFamily(family.trim())) {
        known.push(family.trim() as DispatchFamily)
      } else {
        warnOnce(`family:${String(family)}`, `Ignoring unknown family "${String(family)}" in policy.tiers.${tier} (families: ${DISPATCH_FAMILY_KEYS.join(', ')}).`)
      }
    }
    tierFamilies[tier] = known
  }
  const jev = raw?.jev
  const usageRaw = raw?.usage
  const high = probability(usageRaw?.high) ?? DEFAULT_USAGE_HIGH
  let exhausted = probability(usageRaw?.exhausted) ?? DEFAULT_USAGE_EXHAUSTED
  if (exhausted < high) {
    warnOnce(`usage:${high}:${exhausted}`, `teammateDispatch.usage.exhausted (${exhausted}) is below high (${high}); using ${high} for both.`)
    exhausted = high
  }
  return {
    mode,
    roleTiers,
    tierFamilies,
    jev: {
      enabled: jev?.enabled !== false,
      timeoutMs: positiveNumber(jev?.timeoutMs),
      minP: probability(jev?.minP),
      minMargin: probability(jev?.minMargin),
    },
    excludeModels: Array.isArray(raw?.excludeModels)
      ? raw.excludeModels
          .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
          .map(id => id.trim().toLowerCase())
      : [],
    usage: { enabled: usageRaw?.enabled !== false, high, exhausted },
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}
function probability(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined
}

// ---------------------------------------------------------------------------
// Stage 1a: heuristic role classification
// ---------------------------------------------------------------------------

const ROLE_PATTERNS: Record<TeammateRole, RegExp[]> = {
  computer_use: [
    /\bbrowser\b/, /\bplaywright\b/, /\bpuppeteer\b/, /\bselenium\b/,
    /\bscreenshots?\b/, /\bclick(?:s|ing)?\b/, /\bgui\b/, /\bdesktop automation\b/,
    /\bcomputer[- ]use\b/, /\bweb ?ui\b/, /\bchrome\b/, /\bnavigate to\b/,
  ],
  review: [
    /\breview(?:s|ing|er)?\b/, /\bcritique\b/, /\bcode[- ]review\b/,
    /\baudit\b/, /\bthe diff\b/, /\bfeedback on\b/,
  ],
  verify: [
    /\bverif(?:y|ies|ication|ier)\b/, /\bprove\b/, /\bqa\b/, /\bvalidat(?:e|ion)\b/,
    /\btests?\b/, /\btesting\b/, /\bregression\b/, /\bedge cases\b/,
  ],
  design: [
    /\bplan(?:ning)?\b/, /\bdesign\b/, /\barchitect(?:ure)?\b/, /\broot cause\b/,
    /\bdebug(?:ging)?\b/, /\btrade-?offs?\b/, /\bspec\b/,
  ],
  research: [
    /\bexplor(?:e|ation)\b/, /\bread\b/, /\bfind\b/, /\binvestigat(?:e|ion)\b/,
    /\bresearch(?:er)?\b/, /\blook into\b/, /\bsurvey\b/, /\blocate\b/,
    /\breport findings\b/, /\bsearch\b/, /\bscout\b/,
  ],
  implement: [
    /\bimplement(?:s|ation|er)?\b/, /\bwrite\b/, /\bmodify\b/, /\bfix(?:es|ing)?\b/,
    /\brefactor\b/, /\badd\b/, /\bedit\b/, /\bcommit\b/, /\bdev(?:eloper)?\b/,
    /\bbuild (?:the|a)\b/, /\bchange\b/,
  ],
}

/** agent-definition types and teammate-name stems with a known role. */
const NAME_ROLES: Array<[RegExp, TeammateRole]> = [
  [/review|critic|audit/, 'review'],
  [/verif|tester|\bqa\b|^qa|test/, 'verify'],
  [/brows|playwright|gui|computer|click|screenshot/, 'computer_use'],
  [/^plan$|planner|design|architect/, 'design'],
  [/explore|research|investigat|scout|finder|reader/, 'research'],
  [/^dev|implement|coder|builder|fixer|engineer/, 'implement'],
]

const NEGATED = /\b(?:do not|don't|dont|never|without|no need to|not)\s+(?:\w+\s+)?(?:modify|modifying|edit|editing|write|writing|change|changing|commit|committing|fix|touch)\w*\b[^.\n]*/g

function stripNegations(text: string): string {
  return text.replace(NEGATED, ' ')
}

export type HeuristicRole = {
  role?: TeammateRole
  confident: boolean
  scores: Record<TeammateRole, number>
  complexity?: DispatchComplexity
  matched?: string
}

export function classifyRoleHeuristic(input: {
  description?: string
  prompt?: string
  name?: string
  subagent_type?: string
}): HeuristicRole {
  const scores = Object.fromEntries(TEAMMATE_ROLES.map(r => [r, 0])) as Record<TeammateRole, number>
  let matched: string | undefined
  const identity = [input.name, input.subagent_type]
    .filter((v): v is string => !!v)
    .map(v => v.toLowerCase())
  for (const id of identity) {
    for (const [pattern, role] of NAME_ROLES) {
      if (pattern.test(id)) {
        scores[role] += 3
        matched ??= `name '${id}'`
        break
      }
    }
  }
  const description = stripNegations((input.description ?? '').toLowerCase())
  const prompt = stripNegations((input.prompt ?? '').slice(0, 2000).toLowerCase())
  // The leading verb of the description is the strongest signal: "Verify
  // the fix" is verification, not implementation.
  const leadVerb = description.trim().split(/\s+/, 1)[0] ?? ''
  if (leadVerb) {
    for (const role of TEAMMATE_ROLES) {
      if (ROLE_PATTERNS[role].some(pattern => pattern.test(leadVerb))) {
        scores[role] += 2
        matched ??= `'${leadVerb}' in description`
        break
      }
    }
  }
  for (const role of TEAMMATE_ROLES) {
    for (const pattern of ROLE_PATTERNS[role]) {
      if (pattern.test(description)) {
        scores[role] += 2
        if (!matched) matched = `'${description.match(pattern)?.[0]}' in description`
      }
      if (pattern.test(prompt)) scores[role] += 1
    }
  }
  const ranked = TEAMMATE_ROLES.map(r => [r, scores[r]] as const).sort(
    (a, b) => b[1] - a[1],
  )
  const [top, second] = ranked
  const role = top && top[1] > 0 ? top[0] : undefined
  const topScore = top?.[1] ?? 0
  const secondScore = second?.[1] ?? 0
  const confident = role !== undefined && topScore >= 3 && topScore >= 2 * secondScore
  const text = `${description} ${prompt}`
  const complexity: DispatchComplexity | undefined =
    /\b(?:hard|complex|tricky|subtle|race condition|deadlock|large refactor|across the codebase)\b/.test(text)
      ? 'hard'
      : /\b(?:trivial|quick|one[- ]line|simple lookup|typo)\b/.test(text)
        ? 'trivial'
        : undefined
  return {
    role,
    confident,
    scores,
    complexity,
    matched: role ? matched : undefined,
  }
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export type TeamMemberLike = {
  agentId?: string
  name: string
  model?: string
  role?: string
  family?: string
}

export type TeammateDispatchDeps = {
  evaluateJev: (req: JevRequest, opts?: { timeoutMs?: number }) => Promise<JevResult>
  isJevConfigured: () => boolean
  acceptChoice: (answer: JevAnswer | undefined, rule?: { minP?: number; minMargin?: number }) => string | null
  /** Members of the team (lead excluded), or [] when the team is unknown. */
  readTeamMembers: (teamName: string) => TeamMemberLike[]
  /** Route id the leader's own env serves (resolveTeammateProviderRoute). */
  leaderRoute: () => string
  /** Whether the Anthropic OAuth/API route is actually authenticated. */
  hasAnthropicAuth: () => boolean
  providerProfiles: () => readonly ProviderProfile[]
  supportsVision: (modelId: string, family?: DispatchFamily) => boolean
  /** Catalog ids (with context/vision/reasoning) a route serves. */
  routeCatalog: (route: string) => CatalogFacts[]
  /** Organization model allowlist (availableModels). */
  isModelAllowed: (model: string) => boolean
  /** Passive usage level of a provider route (routeUsage.ts). */
  routeUsage: (route: string) => RouteUsageLevel
}

function catalogVision(modelId: string, family?: DispatchFamily): boolean {
  ensureIntegrationsLoaded()
  const lookups = [
    modelId,
    modelId.split('/').pop() ?? modelId,
    (modelId.split('/').pop() ?? modelId).replace(/:cloud$/, ''),
    family ? DISPATCH_FAMILIES[family].entries[0]?.id : undefined,
  ]
  for (const id of lookups) {
    if (!id) continue
    const found = getCatalogModel(id)
    if (found) return found.capabilities?.supportsVision === true
  }
  return false
}

function defaultReadTeamMembers(teamName: string): TeamMemberLike[] {
  const file = readTeamFile(teamName)
  if (!file) return []
  return file.members
    .filter(m => m.agentId !== file.leadAgentId)
    .map(m => ({
      agentId: m.agentId,
      name: m.name,
      model: m.model,
      role: m.role,
      family: m.family,
    }))
}

function defaultHasAnthropicAuth(): boolean {
  try {
    return isAnthropicAuthEnabled() || hasAnthropicApiKeyAuth()
  } catch {
    return false
  }
}

const DEFAULT_DEPS: TeammateDispatchDeps = {
  evaluateJev: (req, opts) => jevClient.evaluateJev(req, opts),
  // Never reach the network from a test run that forgot to stub JEV.
  isJevConfigured: () =>
    process.env.NODE_ENV !== 'test' && jevClient.isJevConfigured(),
  acceptChoice: (answer, rule) => jevClient.acceptChoice(answer, rule),
  readTeamMembers: defaultReadTeamMembers,
  leaderRoute: () => resolveTeammateProviderRoute({}),
  hasAnthropicAuth: defaultHasAnthropicAuth,
  providerProfiles: () => getProviderProfiles(),
  supportsVision: catalogVision,
  routeCatalog: route => defaultRouteCatalog(route),
  isModelAllowed: model => isModelAllowed(model),
  routeUsage: route => readRouteUsage(route),
}

let depsOverride: Partial<TeammateDispatchDeps> | undefined

/** Exported for tests: override dispatcher dependencies (undefined resets). */
export function _setTeammateDispatchDepsForTesting(
  deps: Partial<TeammateDispatchDeps> | undefined,
): void {
  depsOverride = deps
}

function getDeps(): TeammateDispatchDeps {
  return { ...DEFAULT_DEPS, ...depsOverride }
}


// ---------------------------------------------------------------------------
// Spawnable models: every catalog id on every configured route
// ---------------------------------------------------------------------------

export type PriceTier = 'low' | 'mid' | 'high'

/** One model the teammate could be spawned on, with catalog facts for JEV. */
export type SpawnableModel = {
  id: string
  route: string
  /** Saved profile to bind; absent when the leader's own route serves it. */
  providerProfile?: string
  /** Human label of the serving provider (profile name or route id). */
  provider: string
  /** Matrix family, when the id is one (display + tier-table ranking). */
  family?: DispatchFamily
  /** Family for the separation rule: a vendor model line (separationFamilyOf). */
  separationFamily: string
  contextWindow?: number
  vision: boolean
  reasoning: boolean
  priceTier: PriceTier
}

export type ModelExclusion = { model: string; reason: string }

/** Every route id whose Claude ids live in the legacy provider config. */
const CLAUDE_CONFIG_KEY: Readonly<Record<string, 'firstParty' | 'vertex' | 'bedrock' | 'foundry'>> = {
  anthropic: 'firstParty',
  vertex: 'vertex',
  bedrock: 'bedrock',
  foundry: 'foundry',
}

type CatalogFacts = { id: string; contextWindow?: number; vision?: boolean; reasoning?: boolean }

/** The catalog ids a route serves (codex → the openai catalog's GPT-5/6 ids). */
function defaultRouteCatalog(route: string): CatalogFacts[] {
  ensureIntegrationsLoaded()
  const claudeKey = CLAUDE_CONFIG_KEY[route]
  if (claudeKey) {
    const ids = new Set<string>()
    for (const config of Object.values(LEGACY_PROVIDER_MODEL_CONFIGS)) {
      if (/^claude-3/.test(config.firstParty)) continue // retired
      const id = (config as Record<string, string>)[claudeKey]
      if (id) ids.add(id)
    }
    return [...ids].map(id => ({ id, ...factsFromDescriptor(id) }))
  }
  const catalogRoute = route === 'codex' ? 'openai' : route
  return getCatalogEntriesForRoute(catalogRoute)
    .filter(entry => route !== 'codex' || /^gpt-(?:5|6)/.test(entry.apiName))
    .filter(entry => route !== 'codex' || !/mini|nano/.test(entry.apiName))
    .map(entry => {
      const descriptor = factsFromDescriptor(entry.modelDescriptorId ?? entry.apiName)
      return {
        id: entry.apiName,
        contextWindow: entry.contextWindow ?? descriptor.contextWindow,
        vision: entry.capabilities?.supportsVision ?? descriptor.vision,
        reasoning: entry.capabilities?.supportsReasoning ?? descriptor.reasoning,
      }
    })
}

function factsFromDescriptor(id: string): Omit<CatalogFacts, 'id'> {
  const found = getCatalogModel(id) ?? getCatalogModel(id.split('/').pop() ?? id)
  if (!found) return {}
  return {
    contextWindow: found.contextWindow,
    vision: found.capabilities?.supportsVision,
    reasoning: found.capabilities?.supportsReasoning,
  }
}

function priceTierOf(id: string): PriceTier {
  const n = id.toLowerCase()
  if (/opus|fable|gpt-6/.test(n)) return 'high'
  if (/flash|luna|mini|nano|haiku|air|turbo|deepseek|glm|kimi|minimax/.test(n)) return 'low'
  return 'mid'
}

/**
 * The bare vendor id: lower-cased, provider prefixes and suffixes removed
 * (`accounts/fireworks/models/`, `deepseek-ai/`, `us.anthropic.`,
 * `anthropic.`, `:cloud`, `[1m]`, Bedrock `-v1:0`, Vertex `@date`).
 */
function bareModelId(model: string): string {
  let n = normalizeTeammateModelId(model)
  n = n.split('/').pop() ?? n
  n = n.replace(/:cloud$/, '')
  n = n.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
  n = n.replace(/-v\d+(?::\d+)?$/, '')
  return n
}

/** A trailing release date: `-20250514`, `@20250514`, `-2025-05-14`. */
const DATE_SUFFIX = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2})$/

/**
 * The separation family of a model: its vendor model LINE. Every version of
 * a line is one family, so a reviewer never runs on any version of the
 * implementer's line:
 *   claude-opus* · claude-sonnet* · claude-haiku* · claude-fable*
 *   gpt-6* · gpt-5 (every 5.x tier and version) · glm · deepseek
 * Anything else: the bare id without `[1m]` and a release date.
 */
export function separationFamilyOf(model: string | undefined): string | undefined {
  if (!model || model === 'inherit') return undefined
  let resolved = model
  try {
    resolved = parseUserSpecifiedModel(model)
  } catch {
    // keep raw
  }
  const n = bareModelId(resolved)
  const claude = n.match(/^claude-(?:[\d.-]+-)?(opus|sonnet|haiku|fable)(?:$|[-.@\d])/)
    ?? n.match(/^(opus|sonnet|haiku|fable)(?:$|[-.@\d])/)
  if (claude) return `claude-${claude[1]}`
  if (/^gpt-6(?:$|[-.])/.test(n)) return 'gpt-6'
  if (/^gpt-5(?:$|[-.])/.test(n)) return 'gpt-5'
  if (/^glm-/.test(n)) return 'glm'
  if (/^deepseek-/.test(n)) return 'deepseek'
  return n.replace(DATE_SUFFIX, '')
}

/** Ids known unusable on a route even though its catalog lists them. */
const ROUTE_UNSUPPORTED: Readonly<Record<string, readonly RegExp[]>> = {
  // Codex Spark is refused on ChatGPT-account Codex auth ("not supported
  // when using Codex with a ChatGPT account"); the catalog has no flag for
  // plan entitlement, so it is excluded explicitly.
  codex: [/codex-spark/, /^codexspark$/],
}

/**
 * Prune a route's catalog to spawnable ids: drop ids the route cannot serve
 * (ROUTE_UNSUPPORTED) and dated legacy Claude ids superseded by an undated
 * id of the same line on the route (claude-opus-4-20250514 goes when
 * claude-opus-5-5 is there; claude-haiku-4-5-20251001 stays while it is
 * the only Haiku).
 */
export function pruneRouteCatalog<T extends { id: string }>(route: string, entries: readonly T[]): T[] {
  const unsupported = ROUTE_UNSUPPORTED[route] ?? []
  const usable = entries.filter(e => !unsupported.some(re => re.test(bareModelId(e.id))))
  const undatedLines = new Set<string>()
  for (const e of usable) {
    const family = separationFamilyOf(e.id)
    if (family?.startsWith('claude-') && !DATE_SUFFIX.test(bareModelId(e.id))) undatedLines.add(family)
  }
  return usable.filter(e => {
    const family = separationFamilyOf(e.id)
    if (!family?.startsWith('claude-')) return true
    return !(DATE_SUFFIX.test(bareModelId(e.id)) && undatedLines.has(family))
  })
}

function allowedByTeammateAllowlist(
  route: string,
  id: string,
  allowed: TeammateMatrixEntry[] | null,
  wildcard: boolean,
): boolean {
  if (wildcard || allowed === null) return true
  const n = normalizeTeammateModelId(id)
  return allowed.some(a => a.route === route && normalizeTeammateModelId(a.id) === n)
}

type RouteContext = {
  allowed: TeammateMatrixEntry[] | null
  wildcard: boolean
  leaderRoute: string
  anthropicAuth: boolean
  profiles: readonly ProviderProfile[]
  allowProfileBinding: boolean
  /** Lower-cased exact ids from teammateDispatch.excludeModels. */
  excludeModels: ReadonlySet<string>
}

function buildRouteContext(
  input: TeammateRouteInput,
  deps: TeammateDispatchDeps,
): RouteContext {
  const wildcard = (input.settings?.teammateModelAllowlist ?? []).some(
    item => item.trim() === TEAMMATE_MODEL_ALLOWLIST_WILDCARD,
  )
  const leaderRoute = deps.leaderRoute()
  let profiles: readonly ProviderProfile[] = []
  try {
    profiles = deps.providerProfiles()
  } catch {
    profiles = []
  }
  return {
    allowed: getAllowedTeammateEntries(input.settings?.teammateModelAllowlist),
    wildcard,
    leaderRoute,
    anthropicAuth: leaderRoute === 'anthropic' && deps.hasAnthropicAuth(),
    profiles,
    allowProfileBinding: input.allowProfileBinding !== false,
    excludeModels: new Set(readTeammateDispatchSettings(input.settings).excludeModels),
  }
}

/**
 * Every model the teammate could run on: the leader route's catalog (Claude
 * ids when Anthropic is authenticated), then — for out-of-process spawns —
 * each saved profile's models and its route's catalog. Filtered by the
 * teammate allowlist (under "*" everything) and the organization allowlist.
 * First occurrence of an id wins, so the leader route (no binding) is preferred.
 */
function listCandidates(
  ctx: RouteContext,
  deps: TeammateDispatchDeps,
): { candidates: SpawnableModel[]; excluded: ModelExclusion[] } {
  const candidates: SpawnableModel[] = []
  const excluded: ModelExclusion[] = []
  const seen = new Set<string>()
  const add = (facts: CatalogFacts, route: string, provider: string, profile?: string) => {
    const key = facts.id.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    if (ctx.excludeModels.has(key)) {
      excluded.push({ model: facts.id, reason: 'teammateDispatch.excludeModels' })
      return
    }
    if (!allowedByTeammateAllowlist(route, facts.id, ctx.allowed, ctx.wildcard)) {
      excluded.push({ model: facts.id, reason: 'teammateModelAllowlist' })
      return
    }
    if (!deps.isModelAllowed(facts.id)) {
      excluded.push({ model: facts.id, reason: 'organization model allowlist' })
      return
    }
    const family = familyOfModel(facts.id)
    candidates.push({
      id: facts.id,
      route,
      provider,
      ...(profile ? { providerProfile: profile } : {}),
      ...(family ? { family } : {}),
      separationFamily: separationFamilyOf(facts.id) ?? `model:${key}`,
      ...(facts.contextWindow ? { contextWindow: facts.contextWindow } : {}),
      vision: facts.vision ?? deps.supportsVision(facts.id, family),
      reasoning: facts.reasoning === true,
      priceTier: priceTierOf(facts.id),
    })
  }

  const leaderUsable = ctx.leaderRoute !== 'anthropic' || ctx.anthropicAuth
  if (leaderUsable) {
    for (const facts of safeCatalog(deps, ctx.leaderRoute)) {
      add(facts, ctx.leaderRoute, ctx.leaderRoute)
    }
  }
  if (!ctx.allowProfileBinding) return { candidates, excluded }
  for (const profile of ctx.profiles) {
    let route: string
    try {
      route = resolveTeammateProviderRoute({ profile })
    } catch {
      continue
    }
    const listed = parseModelList(profile.model ?? '')
      .filter(id => !/^codex/i.test(id))
      .map(id => ({ id, ...factsFromDescriptor(id) }))
    const fromCatalog = safeCatalog(deps, route)
    const byId = new Map<string, CatalogFacts>()
    for (const facts of [...listed, ...fromCatalog]) {
      const prior = byId.get(facts.id.toLowerCase())
      byId.set(facts.id.toLowerCase(), prior ? { ...facts, ...prior, contextWindow: prior.contextWindow ?? facts.contextWindow, vision: prior.vision ?? facts.vision, reasoning: prior.reasoning ?? facts.reasoning } : facts)
    }
    for (const facts of pruneRouteCatalog(route, [...byId.values()])) {
      if (findProviderProfilesForModel(facts.id, [profile]).length === 0) continue
      let modelRoute = route
      try {
        modelRoute = resolveTeammateProviderRoute({ model: facts.id, profile })
      } catch {
        // keep profile route
      }
      add(facts, modelRoute, profile.name || modelRoute, profile.id)
    }
  }
  return { candidates, excluded }
}

function safeCatalog(deps: TeammateDispatchDeps, route: string): CatalogFacts[] {
  try {
    return pruneRouteCatalog(route, deps.routeCatalog(route))
  } catch {
    return []
  }
}

/** Exported for tests and diagnostics: the model candidates for this spawn. */
export function listSpawnableModels(
  input: Pick<TeammateRouteInput, 'settings' | 'allowProfileBinding'>,
): { candidates: SpawnableModel[]; excluded: ModelExclusion[] } {
  const deps = getDeps()
  return listCandidates(buildRouteContext(input as TeammateRouteInput, deps), deps)
}

function formatContext(tokens: number | undefined): string {
  if (!tokens) return 'unknown context'
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`
  return `${Math.round(tokens / 1000)}K context`
}

/** JEV criterion text for one model, built from catalog data. */
export function describeSpawnableModel(model: SpawnableModel): string {
  return [
    `provider ${model.provider}`,
    formatContext(model.contextWindow),
    `price ${model.priceTier}`,
    model.vision ? 'vision' : 'no vision',
    model.reasoning ? 'reasoning' : 'no reasoning',
    ...(model.family ? [`family ${model.family}`] : []),
  ].join('; ')
}

/**
 * Hard rules, independent of JEV: a review/verify teammate never shares an
 * implementer's separation family; computer_use needs vision.
 */
function hardRuleViolation(
  model: { separationFamily?: string; vision?: boolean },
  role: TeammateRole | undefined,
  excludedFamilies: ReadonlySet<string>,
): string | undefined {
  if (role && SEPARATED_ROLES.has(role) && model.separationFamily && excludedFamilies.has(model.separationFamily)) {
    return `separation: ${model.separationFamily} is an implementer's family`
  }
  if (role === 'computer_use' && model.vision === false) return 'computer_use needs vision'
  return undefined
}

// ---------------------------------------------------------------------------
// Usage-aware dispatch and vendor preference
// ---------------------------------------------------------------------------

export type ModelVendor = 'anthropic' | 'openai' | 'zai' | 'deepseek'

/**
 * The vendor of a model id, dispatch family or separation family:
 * anthropic (every claude-, opus, sonnet, haiku, fable id), openai (gpt-),
 * zai (glm-), deepseek (deepseek-). Undefined for anything else.
 */
export function vendorOf(modelOrFamily: string | undefined): ModelVendor | undefined {
  if (!modelOrFamily || modelOrFamily === 'inherit') return undefined
  const n = bareModelId(modelOrFamily)
  if (/^claude(?:$|[-\d])/.test(n) || /^(?:opus|sonnet|haiku|fable)(?:$|[-.\d])/.test(n)) return 'anthropic'
  if (/^gpt-?\d/.test(n) || /^o\d(?:$|-)/.test(n)) return 'openai'
  if (/^glm(?:$|[-\d])/.test(n)) return 'zai'
  if (/^deepseek(?:$|[-\d])/.test(n)) return 'deepseek'
  return undefined
}

export type UsageBand = 'ok' | 'high' | 'exhausted'

/**
 * The usage level of every route touched by one dispatch, read once per
 * route through deps.routeUsage. Disabled → every route is `unknown`, which
 * ranks as `ok`, so the old behaviour holds exactly.
 */
class UsageView {
  private readonly cache = new Map<string, RouteUsageLevel>()
  constructor(
    private readonly config: NormalizedTeammateDispatch['usage'],
    private readonly deps: TeammateDispatchDeps,
  ) {}

  of(route: string): RouteUsageLevel {
    const cached = this.cache.get(route)
    if (cached) return cached
    let usage: RouteUsageLevel = { route, level: 'unknown' }
    if (this.config.enabled) {
      try {
        usage = this.deps.routeUsage(route)
      } catch {
        usage = { route, level: 'unknown' }
      }
    }
    this.cache.set(route, usage)
    return usage
  }

  /** 0..1, with unknown as 0 (treated as below high). */
  level(route: string): number {
    const usage = this.of(route)
    return usage.level === 'unknown' ? 0 : usage.level
  }

  band(route: string): UsageBand {
    const level = this.of(route).level
    if (level === 'unknown') return 'ok'
    if (level >= this.config.exhausted) return 'exhausted'
    if (level >= this.config.high) return 'high'
    return 'ok'
  }

  describe(route: string): string {
    return formatRouteUsage(this.of(route))
  }

  /** Every route queried so far, for the record and the debug line. */
  snapshot(): Record<string, RouteUsageLevel['level']> | undefined {
    if (!this.config.enabled || this.cache.size === 0) return undefined
    return Object.fromEntries([...this.cache.values()].map(u => [u.route, u.level]))
  }
}

const BAND_RANK: Record<UsageBand, number> = { ok: 0, high: 1, exhausted: 2 }

/**
 * Split candidates by usage band. `offered` is what JEV may choose from:
 * the `ok` ones when any exist; else the `high` ones (the least-used route
 * question is then JEV's, with the percentages in the instruction); else —
 * every route exhausted — all of them, with a warning. Dropped candidates
 * come back with a reason so a JEV pick of one is corrected.
 */
function applyUsageToOffer<T extends { id: string; route: string }>(
  candidates: readonly T[],
  usage: UsageView,
): { offered: T[]; dropped: Map<string, string>; warning?: string } {
  const bands = new Map<T, UsageBand>(candidates.map(c => [c, usage.band(c.route)]))
  const keep: UsageBand = bands.size === 0
    ? 'ok'
    : [...bands.values()].reduce<UsageBand>((best, b) => (BAND_RANK[b] < BAND_RANK[best] ? b : best), 'exhausted')
  const offered: T[] = []
  const dropped = new Map<string, string>()
  for (const candidate of candidates) {
    const band = bands.get(candidate)!
    if (BAND_RANK[band] <= BAND_RANK[keep]) offered.push(candidate)
    else dropped.set(candidate.id, `usage: ${usage.describe(candidate.route)}, ${band === 'exhausted' ? 'excluded' : 'demoted'}`)
  }
  const warning =
    keep === 'exhausted' && offered.length > 0
      ? `every usable provider route is at or over the exhausted threshold (${[...new Set(offered.map(c => usage.describe(c.route)))].join(', ')}); keeping them`
      : undefined
  return { offered, dropped, ...(warning ? { warning } : {}) }
}

/** The vendors implementers in the team used, from their separation families. */
function implementerVendors(excluded: readonly TeammateRouteExclusion[]): Set<ModelVendor> {
  const out = new Set<ModelVendor>()
  for (const e of excluded) {
    const vendor = vendorOf(e.family)
    if (vendor) out.add(vendor)
  }
  return out
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_TYPE_KEY = 'default'

/** The fields of an agent definition (loadAgentsDir.ts) the dispatcher reads. */
export type AgentTypeOption = {
  agentType: string
  whenToUse?: string
  source?: string
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  model?: string
}

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const BROWSER_TOOL = /playwright|chrome|browser|puppeteer|computer/i

function inheritsAllTools(def: AgentTypeOption): boolean {
  return def.tools === undefined || def.tools.includes('*')
}

export function agentTypeCanEdit(def: AgentTypeOption): boolean {
  return EDIT_TOOLS.some(tool => {
    const listed = inheritsAllTools(def) || def.tools!.includes(tool)
    return listed && !(def.disallowedTools ?? []).includes(tool)
  })
}

export function agentTypeCanBrowse(def: AgentTypeOption): boolean {
  if (inheritsAllTools(def)) {
    return !(def.disallowedTools ?? []).some(tool => BROWSER_TOOL.test(tool) && /^mcp__\w+$|\*$/.test(tool))
  }
  return def.tools!.some(tool => BROWSER_TOOL.test(tool))
}

/**
 * The agent types JEV may choose: loaded definitions (built-ins only on the
 * subagent path — teammates cannot be built-ins) plus `default`.
 */
export function agentTypeOptionsFor(
  defs: readonly AgentTypeOption[] | undefined,
  path: 'teammate' | 'subagent',
): AgentTypeOption[] {
  const out: AgentTypeOption[] = []
  for (const def of defs ?? []) {
    if (!def.agentType || def.agentType === DEFAULT_AGENT_TYPE_KEY) continue
    if (path === 'teammate' && def.source === 'built-in') continue
    // `default` already stands for general-purpose on the subagent path.
    if (path === 'subagent' && def.agentType === 'general-purpose') continue
    if (out.some(o => o.agentType === def.agentType)) continue
    out.push(def)
  }
  return out
}

export function buildAgentTypeCriteria(
  options: readonly AgentTypeOption[],
  path: 'teammate' | 'subagent',
): Record<string, string> {
  const criteria: Record<string, string> = {
    [DEFAULT_AGENT_TYPE_KEY]:
      path === 'teammate'
        ? 'a general teammate with the full tool set; use when no specialised type clearly fits'
        : 'the general-purpose agent with the full tool set; use when no specialised type clearly fits',
  }
  for (const def of options) {
    const caps = [
      agentTypeCanEdit(def) ? 'can edit files' : 'read-only',
      ...(agentTypeCanBrowse(def) ? ['can drive a browser'] : []),
    ].join(', ')
    const when = (def.whenToUse ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
    criteria[def.agentType] = `${when || def.agentType} (${caps})`
  }
  return criteria
}

function agentTypeFits(def: AgentTypeOption, role: TeammateRole): string | undefined {
  if (role === 'implement' && !agentTypeCanEdit(def)) return 'cannot edit files'
  if (role === 'computer_use' && !agentTypeCanBrowse(def)) return 'cannot use a browser'
  return undefined
}

// ---------------------------------------------------------------------------
// Stage 1: JEV (every dispatch in auto/suggest mode)
// ---------------------------------------------------------------------------

const ROLE_CRITERIA: Record<TeammateRole, string> = {
  research: 'explore, read, find or investigate code or docs; reports findings without changing code',
  implement: 'write or modify code, fix a bug, refactor, commit changes',
  review: 'code review: critique a diff or change for correctness and quality',
  verify: 'test, prove or QA that a change works; run tests and edge cases',
  design: 'plan, design architecture, or debug a hard problem to its root cause',
  computer_use: 'drive a browser, GUI or desktop: clicking, screenshots, Playwright',
}

const COMPLEXITY_LEVELS: DispatchComplexity[] = ['trivial', 'moderate', 'hard']

const SEPARATED_ROLES: ReadonlySet<TeammateRole> = new Set(['review', 'verify'])

function buildInstruction(
  config: NormalizedTeammateDispatch,
  opts: {
    askModel: boolean
    askType: boolean
    excluded: readonly TeammateRouteExclusion[]
    /** Routes at or over the high threshold that are still offered, described. */
    busyRoutes?: readonly string[]
    /** Vendors the implementers used, for the cross-vendor review preference. */
    implementerVendors?: ReadonlySet<ModelVendor>
  },
): string {
  const parts = [
    'Route a task a lead is delegating to a coding-agent teammate.',
    'role: what the teammate will mainly do. complexity: how hard the task is. needs_long_context: whether it must hold a large amount of code or text in context at once.',
  ]
  if (opts.askModel) {
    const byTier = new Map<DispatchTier, TeammateRole[]>()
    for (const role of TEAMMATE_ROLES) {
      const tier = config.roleTiers[role]
      byTier.set(tier, [...(byTier.get(tier) ?? []), role])
    }
    const tierText = DISPATCH_TIERS.filter(t => byTier.has(t))
      .map(t => `${byTier.get(t)!.join('/')} → ${t} tier (prefer ${config.tierFamilies[t].join(', ') || 'any'})`)
      .join('; ')
    parts.push(
      `model: the model to run the teammate on. Match the role's tier: ${tierText}. Deep means the strongest reasoning; fast means cheap and quick. Prefer a cheaper model for trivial tasks and a larger context when the task needs long context. computer_use requires a vision model.`,
    )
    if (opts.excluded.length > 0) {
      parts.push(
        `A review or verify teammate must not use an implementer's model family: ${describeExclusions(opts.excluded)}.`,
      )
      const vendors = [...(opts.implementerVendors ?? [])]
      if (vendors.length > 0) {
        parts.push(
          `For a review or verify teammate prefer a model from a different vendor than the implementer (implementer vendor${vendors.length > 1 ? 's' : ''}: ${vendors.join(', ')}); another family from the same vendor is acceptable when it is clearly the better fit.`,
        )
      }
    }
    if (opts.busyRoutes && opts.busyRoutes.length > 0) {
      parts.push(
        `Provider usage is high: ${opts.busyRoutes.join('; ')}; prefer other providers, and among these the least used.`,
      )
    }
  }
  if (opts.askType) {
    parts.push(
      'agent_type: the agent definition that best fits the task; default when none clearly fits. An implementing teammate needs a type that can edit files; a computer_use teammate needs one that can drive a browser.',
    )
  }
  return parts.join(' ')
}

type JevCall =
  | { ok: true; answers: Record<string, JevAnswer>; costUsd?: number; latencyMs: number }
  | { ok: false; why: string; latencyMs?: number }

async function callJev(
  request: JevRequest,
  config: NormalizedTeammateDispatch,
  deps: TeammateDispatchDeps,
): Promise<JevCall> {
  let configured = false
  try {
    configured = config.jev.enabled && deps.isJevConfigured()
  } catch {
    configured = false
  }
  if (!configured) {
    return { ok: false, why: config.jev.enabled ? 'jev not configured' : 'jev disabled' }
  }
  const timeoutMs = config.jev.timeoutMs
  let result: JevResult
  try {
    // Belt and braces over the client's own timeout: a spawn is never held
    // longer than the JEV budget, even by a misbehaving fetch.
    const budget = (timeoutMs ?? 3000) + 250
    let timer: ReturnType<typeof setTimeout> | undefined
    result = await Promise.race([
      deps.evaluateJev(request, timeoutMs ? { timeoutMs } : undefined),
      new Promise<JevResult>(resolve => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: 'timeout', latencyMs: budget }),
          budget,
        )
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    if (timer) clearTimeout(timer)
  } catch (error) {
    return { ok: false, why: `jev error: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result.ok) return { ok: false, why: `jev ${result.reason}`, latencyMs: result.latencyMs }
  return { ok: true, answers: result.answers, costUsd: result.costUsd, latencyMs: result.latencyMs }
}

type RulePick = { key: string; p?: number; corrected?: string }

/**
 * Rule A on the answer; when the pick breaks a hard rule or fails Rule A,
 * the best remaining option by probability — renormalized over the options
 * that pass the rules — if THAT passes Rule A. Otherwise null.
 */
function pickWithRules(
  answer: JevAnswer | undefined,
  violation: (key: string) => string | undefined,
  deps: TeammateDispatchDeps,
  rule: { minP?: number; minMargin?: number },
): RulePick | null {
  if (!answer || answer.type !== 'choice') return null
  const accepted = deps.acceptChoice(answer, rule)
  if (accepted && !violation(accepted)) {
    return { key: accepted, p: answer.probabilities[accepted] }
  }
  const why = accepted
    ? `${accepted} ${violation(accepted)}`
    : `${answer.choice} p=${(answer.probabilities[answer.choice] ?? 0).toFixed(2)} failed rule A`
  const valid = Object.entries(answer.probabilities).filter(
    ([key, p]) => typeof p === 'number' && p > 0 && !violation(key),
  )
  const total = valid.reduce((sum, [, p]) => sum + p, 0)
  if (valid.length === 0 || total <= 0) return null
  const renormalized = Object.fromEntries(valid.map(([key, p]) => [key, p / total]))
  const best = valid.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  const again = deps.acceptChoice({ type: 'choice', choice: best, probabilities: renormalized }, rule)
  return again ? { key: again, p: answer.probabilities[again], corrected: why } : null
}

function top3(probabilities: Record<string, number> | undefined): string {
  if (!probabilities) return '-'
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => `${k}:${p.toFixed(2)}`)
    .join(',')
}

function choiceProbabilities(answer: JevAnswer | undefined): Record<string, number> | undefined {
  return answer?.type === 'choice' ? answer.probabilities : undefined
}

// ---------------------------------------------------------------------------
// Stage 2: tier-table fallback + helpers
// ---------------------------------------------------------------------------

/** The family a model id belongs to, or undefined for off-matrix models. */
export function familyOfModel(model: string | undefined): DispatchFamily | undefined {
  if (!model || model === 'inherit') return undefined
  let resolved = model
  try {
    resolved = parseUserSpecifiedModel(model)
  } catch {
    // keep raw
  }
  const wanted = [normalizeTeammateModelId(resolved), normalizeTeammateModelId(model)]
  for (const family of DISPATCH_FAMILY_KEYS) {
    for (const entry of DISPATCH_FAMILIES[family].entries) {
      const id = normalizeTeammateModelId(entry.id)
      if (wanted.some(w => w === id || (w.startsWith('claude-') && w.startsWith(`${id}-`)))) {
        return family
      }
    }
  }
  return undefined
}

type Candidate = {
  family: DispatchFamily
  model: string
  route: string
  providerProfile?: string
}

function tierFallbackOrder(tier: DispatchTier): DispatchTier[] {
  const index = DISPATCH_TIERS.indexOf(tier)
  const lower = DISPATCH_TIERS.slice(index + 1)
  const higher = DISPATCH_TIERS.slice(0, index).reverse()
  return [tier, ...lower, ...higher]
}

function allowedByAllowlist(
  family: DispatchFamily,
  entry: TeammateMatrixEntry,
  allowed: TeammateMatrixEntry[] | null,
  wildcard: boolean,
): boolean {
  if (family === 'gpt-5.6') {
    // Not in TEAMMATE_MODEL_MATRIX: checkTeammateModelAllowed would refuse it
    // under any allowlist other than the wildcard.
    return wildcard
  }
  return allowedByTeammateAllowlist(entry.route, entry.id, allowed, wildcard)
}

function resolveCandidate(
  family: DispatchFamily,
  tier: DispatchTier,
  ctx: RouteContext,
): Candidate | undefined {
  const def = DISPATCH_FAMILIES[family]
  const tierIds = def.tierIds?.[tier]
  const entries = tierIds
    ? tierIds.flatMap(id => def.entries.filter(e => e.id === id))
    : def.entries
  // Prefer the leader's own route (no binding needed), then saved profiles.
  for (const entry of entries) {
    if (!allowedByAllowlist(family, entry, ctx.allowed, ctx.wildcard)) continue
    if (entry.route !== ctx.leaderRoute) continue
    if (entry.route === 'anthropic' && !ctx.anthropicAuth) continue
    return { family, model: entry.id, route: entry.route }
  }
  if (!ctx.allowProfileBinding) return undefined
  for (const entry of entries) {
    if (!allowedByAllowlist(family, entry, ctx.allowed, ctx.wildcard)) continue
    const profile = findProviderProfilesForModel(entry.id, ctx.profiles).find(p => {
      try {
        return resolveTeammateProviderRoute({ model: entry.id, profile: p }) === entry.route
      } catch {
        return false
      }
    })
    if (profile) {
      return { family, model: entry.id, route: entry.route, providerProfile: profile.id }
    }
  }
  return undefined
}

/**
 * Families a review/verify teammate must avoid: every implementer's
 * separation family, and — for members with no recorded role (teams from
 * before dispatch) — every non-review member's family.
 */
export function collectExcludedFamilies(
  members: readonly TeamMemberLike[],
  leaderModel: string | undefined,
): TeammateRouteExclusion[] {
  const out: TeammateRouteExclusion[] = []
  for (const member of members) {
    const role = member.role
    if (role && role !== 'implement') continue
    if (role === undefined && member.name && /review/i.test(member.name)) continue
    const fromModel = member.model ? separationFamilyOf(member.model) : undefined
    const fromRecord =
      member.family && isDispatchFamily(member.family)
        ? separationFamilyOf(DISPATCH_FAMILIES[member.family].entries[0]?.id) ?? member.family
        : undefined
    const family = fromModel ?? fromRecord ?? separationFamilyOf(leaderModel)
    if (family && !out.some(e => e.family === family && e.by === member.name)) {
      out.push({ family, by: member.name })
    }
  }
  return out
}

function describeExclusions(excluded: readonly TeammateRouteExclusion[]): string {
  const byFamily = new Map<string, string[]>()
  for (const e of excluded) {
    byFamily.set(e.family, [...(byFamily.get(e.family) ?? []), e.by])
  }
  return [...byFamily]
    .map(([family, by]) => `${family} used by ${by.join(', ')}`)
    .join('; ')
}

/**
 * Whether settings-level agentRouting names this agent (by teammate name or
 * agent type — not the `default` key). Such a route is an explicit choice the
 * dispatcher must not override. Mirrors agentRouting's key normalization.
 */
export function hasNamedAgentRouting(
  name: string | undefined,
  agentType: string | undefined,
  settings: SettingsJson | null | undefined,
): boolean {
  const routing = settings?.agentRouting
  if (!routing) return false
  const norm = (key: string) => key.toLowerCase().replace(/[-_]/g, '')
  const keys = new Set(Object.keys(routing).map(norm))
  return [name, agentType].some(v => !!v && keys.has(norm(v)))
}

function suggestFamilies(
  tier: DispatchTier,
  excluded: ReadonlySet<string>,
  config: NormalizedTeammateDispatch,
): DispatchFamily[] {
  const out: DispatchFamily[] = []
  for (const t of tierFallbackOrder(tier)) {
    for (const family of config.tierFamilies[t]) {
      const sep = separationFamilyOf(DISPATCH_FAMILIES[family].entries[0]?.id) ?? family
      if (!excluded.has(family) && !excluded.has(sep) && !out.includes(family)) out.push(family)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function chooseTeammateRoute(
  input: TeammateRouteInput,
): Promise<TeammateRouteDecision> {
  let config: NormalizedTeammateDispatch
  try {
    config = readTeammateDispatchSettings(input.settings)
  } catch {
    config = readTeammateDispatchSettings(undefined)
  }
  if (config.mode === 'off') {
    return {
      role: 'implement',
      tier: 'standard',
      source: 'off',
      mode: 'off',
      reason: 'teammateDispatch.mode is off',
    }
  }
  let decision: TeammateRouteDecision
  try {
    decision = await chooseTeammateRouteInner(input, config, getDeps())
  } catch (error) {
    logForDebugging(`[teammateDispatch] failed: ${error instanceof Error ? error.message : String(error)}`)
    decision = {
      role: 'implement',
      tier: 'standard',
      source: 'heuristic',
      mode: config.mode,
      reason: 'dispatcher error; using the default model',
      warning: `dispatcher error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  logDecision(input, decision)
  return decision
}

/** One debug line per decision (D): model, role, type, source, top-3s, cost, latency, exclusions. */
function logDecision(input: TeammateRouteInput, d: TeammateRouteDecision): void {
  const excluded = [
    ...(d.excluded ?? []).map(e => `${e.family}: separation (used by ${e.by})`),
    ...(d.excludedModels ?? []).map(e => `${e.model}: ${e.reason}`),
  ]
  logForDebugging(
    `[teammateDispatch] ${input.name ?? input.subagent_type ?? 'agent'}: model=${d.model ?? 'default'} role=${d.role} type=${d.agentType ?? '-'} source=${d.source} mode=${d.mode}` +
      ` top3.model=${top3(d.modelProbabilities)} top3.role=${top3(d.probabilities)} top3.type=${top3(d.agentTypeProbabilities)}` +
      ` cost=${d.costUsd !== undefined ? `$${d.costUsd.toFixed(5)}` : '-'} latency=${d.latencyMs !== undefined ? `${d.latencyMs}ms` : '-'}` +
      ` usage=[${formatUsageSnapshot(d.routeUsage)}] excluded=[${excluded.join('; ')}]${d.warning ? ` warning=${d.warning}` : ''}`,
  )
}

async function chooseTeammateRouteInner(
  input: TeammateRouteInput,
  config: NormalizedTeammateDispatch,
  deps: TeammateDispatchDeps,
): Promise<TeammateRouteDecision> {
  const heuristic = classifyRoleHeuristic(input)
  const prior = input.prior

  // Implementer families in the team: the separation rule's input.
  let excluded: TeammateRouteExclusion[] = []
  if (input.teamName) {
    try {
      excluded = collectExcludedFamilies(
        deps.readTeamMembers(input.teamName).filter(m => m.name !== input.name),
        input.leaderModel,
      )
    } catch {
      excluded = []
    }
  }
  const excludedFamilies = new Set(excluded.map(e => e.family))

  // What to ask. An explicit model / subagent_type is never asked about.
  const modelIsExplicit = input.explicitModel !== undefined || input.modelIsExplicit === true
  const path = input.spawnPath ?? 'teammate'
  const askType = !prior && !input.subagent_type && input.agentTypes !== undefined
  const typeOptions = askType ? agentTypeOptionsFor(input.agentTypes, path) : []
  const ctx = buildRouteContext(input, deps)
  const listing = modelIsExplicit || prior ? { candidates: [], excluded: [] } : listCandidates(ctx, deps)

  // Hard rules before asking, by the best role guess we have.
  const preRole = heuristic.role
  const excludedModels: ModelExclusion[] = [...listing.excluded]
  const ruleAbiding: SpawnableModel[] = []
  for (const candidate of listing.candidates) {
    const violation = hardRuleViolation(candidate, preRole, excludedFamilies)
    if (violation) excludedModels.push({ model: candidate.id, reason: violation })
    else ruleAbiding.push(candidate)
  }
  // Usage after the hard rules: a busy route's models leave the offer only
  // when a rule-abiding model on a calmer route remains.
  const usage = new UsageView(config.usage, deps)
  const offer = applyUsageToOffer(ruleAbiding, usage)
  const offered = offer.offered
  for (const [model, reason] of offer.dropped) excludedModels.push({ model, reason })
  const usageWarnings: string[] = offer.warning ? [offer.warning] : []
  const busyRoutes = [...new Set(offered.map(c => c.route))]
    .filter(route => usage.band(route) !== 'ok')
    .map(route => usage.describe(route))
  const askModel = offered.length > 0
  const vendorsToAvoid = implementerVendors(excluded)

  // Always ask JEV (auto and suggest); the heuristic is only the fallback.
  let jev: JevCall = { ok: false, why: 'reused prior classification' }
  let request: JevRequest | undefined
  if (!prior) {
    const questions: JevRequest['questions'] = {
      role: { type: 'choice', criteria: { ...ROLE_CRITERIA } },
      complexity: {
        type: 'score',
        criteria: [
          'trivial: a lookup or one-line change',
          'moderate: an ordinary focused task',
          'hard: subtle, multi-file or deep reasoning required',
        ],
      },
      needs_long_context: { type: 'boolean' },
    }
    if (askModel) {
      questions.model = {
        type: 'choice',
        criteria: Object.fromEntries(offered.map(m => [m.id, describeSpawnableModel(m)])),
      }
    }
    if (askType) {
      questions.agent_type = { type: 'choice', criteria: buildAgentTypeCriteria(typeOptions, path) }
    }
    request = {
      instruction: buildInstruction(config, {
        askModel,
        askType,
        excluded,
        busyRoutes,
        // The hint only matters for review/verify; the role is unknown before
        // asking, so it is given whenever implementers exist.
        implementerVendors: vendorsToAvoid,
      }),
      state: {
        description: input.description ?? '',
        name: input.name ?? '',
        subagent_type: input.subagent_type ?? '',
        prompt: (input.prompt ?? '').slice(0, 4000),
      },
      questions,
    }
    jev = await callJev(request, config, deps)
  }
  const answers = jev.ok ? jev.answers : {}
  const rule = { minP: config.jev.minP, minMargin: config.jev.minMargin }

  // Role.
  let role: TeammateRole
  let roleSource: 'jev' | 'heuristic'
  let roleReason: string
  const roleAnswer = answers.role
  const roleProbabilities = prior?.probabilities ?? choiceProbabilities(roleAnswer)
  const acceptedRole = jev.ok ? deps.acceptChoice(roleAnswer, rule) : null
  if (prior) {
    role = prior.role
    roleSource = prior.roleSource ?? (prior.source === 'jev' ? 'jev' : 'heuristic')
    roleReason = prior.roleReason ?? `${roleSource} ${role}`
  } else if (acceptedRole && isRole(acceptedRole)) {
    role = acceptedRole
    roleSource = 'jev'
    const p = roleProbabilities?.[acceptedRole]
    roleReason = `jev${p !== undefined ? ` p=${p.toFixed(2)}` : ''}`
  } else {
    const why = !jev.ok
      ? jev.why
      : `jev not confident${roleAnswer?.type === 'choice' ? `: ${roleAnswer.choice}${roleProbabilities?.[roleAnswer.choice] !== undefined ? ` p=${roleProbabilities[roleAnswer.choice]!.toFixed(2)}` : ''}` : ''}`
    role = heuristic.role ?? 'implement'
    roleSource = 'heuristic'
    roleReason = heuristic.role
      ? heuristic.confident
        ? `heuristic ${heuristic.matched ?? heuristic.role} (${why})`
        : `heuristic best guess ${heuristic.matched ?? heuristic.role} (${why})`
      : `default implement (${why})`
  }
  const complexityAnswer = answers.complexity
  const complexity =
    complexityAnswer?.type === 'score'
      ? COMPLEXITY_LEVELS[Math.max(0, Math.min(COMPLEXITY_LEVELS.length - 1, Math.round(complexityAnswer.score)))]
      : prior?.complexity ?? heuristic.complexity
  const longAnswer = answers.needs_long_context
  const needsLongContext = longAnswer?.type === 'boolean' ? longAnswer.probability >= 0.5 : undefined

  let tier = config.roleTiers[role]
  if (role === 'implement' && complexity === 'hard' && tier !== 'deep') {
    tier = DISPATCH_TIERS[DISPATCH_TIERS.indexOf(tier) - 1] ?? tier
  }
  if (role === 'research' && complexity === 'trivial' && needsLongContext !== true) tier = 'fast'

  // Separation only binds review/verify teammates.
  const bindingExclusions = SEPARATED_ROLES.has(role) ? excluded : []
  const exclusionNote = bindingExclusions.length > 0 ? `; excluded ${describeExclusions(bindingExclusions)}` : ''

  // Agent type (C).
  let agentType: string | undefined = input.subagent_type
  let agentTypeP: number | undefined
  let agentTypeNote = ''
  let chosenDef: AgentTypeOption | undefined
  const typeAnswer = answers.agent_type
  if (askType) {
    const byType = new Map(typeOptions.map(def => [def.agentType, def]))
    const typeViolation = (key: string): string | undefined => {
      if (key === DEFAULT_AGENT_TYPE_KEY) return undefined
      const def = byType.get(key)
      if (!def) return 'unknown type'
      const fit = agentTypeFits(def, role)
      if (fit) return fit
      if (def.model !== undefined && modelIsExplicit === false) {
        const model = def.model === 'inherit' ? input.leaderModel : def.model
        const violation = hardRuleViolation(
          { separationFamily: separationFamilyOf(model), vision: model ? deps.supportsVision(model, familyOfModel(model)) : undefined },
          role,
          excludedFamilies,
        )
        if (violation) return `model ${def.model}: ${violation}`
      }
      return undefined
    }
    const picked = jev.ok ? pickWithRules(typeAnswer, typeViolation, deps, rule) : null
    if (picked) {
      agentType = picked.key
      agentTypeP = picked.p
      chosenDef = byType.get(picked.key)
      if (picked.corrected) agentTypeNote = `; type corrected from ${picked.corrected}`
    } else {
      agentType = DEFAULT_AGENT_TYPE_KEY
      agentTypeP = choiceProbabilities(typeAnswer)?.[DEFAULT_AGENT_TYPE_KEY]
      agentTypeNote = jev.ok ? '; type default (no confident fitting pick)' : ''
    }
  }
  const agentTypeProbabilities = choiceProbabilities(typeAnswer)

  const base = {
    role,
    tier,
    mode: config.mode,
    roleSource,
    roleReason,
    complexity,
    probabilities: roleProbabilities,
    ...(jev.ok ? { costUsd: jev.costUsd, latencyMs: jev.latencyMs } : jev.latencyMs !== undefined ? { latencyMs: jev.latencyMs } : {}),
    ...(prior ? { costUsd: prior.costUsd, latencyMs: prior.latencyMs } : {}),
    ...(bindingExclusions.length > 0 ? { excluded: bindingExclusions } : {}),
    ...(excludedModels.length > 0 ? { excludedModels } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(agentTypeP !== undefined ? { agentTypeP } : {}),
    ...(agentTypeProbabilities ? { agentTypeProbabilities } : {}),
    ...(choiceProbabilities(answers.model) ? { modelProbabilities: choiceProbabilities(answers.model) } : {}),
  }
  /** Adds the route-usage snapshot (read lazily, so taken at return time). */
  const withUsage = <T extends object>(decision: T): T & { routeUsage?: TeammateRouteDecision['routeUsage'] } => {
    const snapshot = usage.snapshot()
    return snapshot ? { ...decision, routeUsage: snapshot } : decision
  }
  const usageWarningNote = usageWarnings.length > 0 ? `; WARNING: ${usageWarnings.join('; ')}` : ''

  // Explicit model — the caller's, or the chosen definition's frontmatter:
  // respected, enforcing only the separation rule.
  const frontmatterModel =
    !modelIsExplicit && chosenDef?.model !== undefined
      ? chosenDef.model === 'inherit'
        ? input.leaderModel
        : chosenDef.model
      : undefined
  if (input.explicitModel !== undefined || frontmatterModel !== undefined) {
    const explicit = (input.explicitModel ?? frontmatterModel)!
    const family = familyOfModel(explicit)
    const sep = separationFamilyOf(explicit)
    if (SEPARATED_ROLES.has(role) && sep && excludedFamilies.has(sep)) {
      const implementers = excluded.filter(e => e.family === sep).map(e => `'${e.by}'`)
      const suggestions = suggestFamilies(tier, excludedFamilies, config)
      return {
        ...base,
        ...(family ? { family } : {}),
        model: explicit,
        source: 'explicit',
        modelSource: 'explicit',
        reason: `${roleReason}; explicit ${explicit}`,
        refusal: `Refusing to spawn ${role} teammate${input.name ? ` '${input.name}'` : ''} on '${explicit}' (${sep}): ${implementers.join(', ')} implemented with ${sep} in team '${input.teamName}'. A ${role} teammate must use a different model family than the implementer. Pass model with a model from another family${suggestions.length > 0 ? ` (one of: ${suggestions.join(', ')})` : ''}, or omit model to let the dispatcher choose; if nothing else is allowed, widen teammateModelAllowlist.`,
      }
    }
    return {
      ...base,
      ...(family ? { family } : {}),
      model: explicit,
      source: 'explicit',
      modelSource: 'explicit',
      reason: `${roleReason}; ${input.explicitModel !== undefined ? 'explicit model respected' : `model from ${agentType} definition`}${agentTypeNote}${exclusionNote}`,
    }
  }
  if (input.modelIsExplicit) {
    // The caller resolves the model; this call only chose role and type.
    return { ...base, source: roleSource, reason: `${roleReason}${agentTypeNote}` }
  }

  // Model (B): JEV's pick, corrected by the hard rules and by usage. A
  // same-vendor pick for a reviewer is a preference miss, not a violation:
  // it stands.
  const byId = new Map(listing.candidates.map(m => [m.id, m]))
  const modelViolation = (key: string): string | undefined => {
    const candidate = byId.get(key)
    if (!candidate) return 'not a spawnable model'
    return hardRuleViolation(candidate, role, excludedFamilies) ?? offer.dropped.get(key)
  }
  let jevModelNote = ''
  if (askModel && jev.ok) {
    const picked = pickWithRules(answers.model, modelViolation, deps, rule)
    if (picked) {
      const candidate = byId.get(picked.key)!
      return withUsage({
        ...base,
        ...(candidate.family ? { family: candidate.family } : {}),
        model: candidate.id,
        ...(candidate.providerProfile ? { providerProfile: candidate.providerProfile } : {}),
        source: 'jev',
        modelSource: 'jev',
        reason: `role ${roleReason}; model jev p=${(picked.p ?? 0).toFixed(2)}${picked.corrected ? ` (corrected from ${picked.corrected})` : ''}${agentTypeNote}${exclusionNote}${usageWarningNote}`,
        ...(usageWarnings.length > 0 ? { warning: usageWarnings.join('; ') } : {}),
      })
    }
    const modelAnswer = answers.model
    if (modelAnswer?.type === 'choice') {
      const top = modelAnswer.choice
      const p = modelAnswer.probabilities[top] ?? 0
      const violation = modelViolation(top)
      jevModelNote = violation
        ? `, jev top ${top} rejected: ${violation}`
        : `, jev top ${top} p=${p.toFixed(2)} < ${(config.jev.minP ?? 0.75).toFixed(2)}`
    } else {
      jevModelNote = ', jev gave no model'
    }
  }

  // Fallback: the tier table. Every usable entry is ranked: calm routes
  // before busy ones (busy ones by usage, least used first), then the
  // role's tier before the fallback tiers, then — for review/verify — a
  // vendor the implementers did not use, then table order. The plain table
  // order (tier, then position) is what the old dispatcher chose; when the
  // ranking picks something else the reason says why.
  const needsVision = role === 'computer_use'
  type Ranked = { candidate: Candidate; family: DispatchFamily; tier: DispatchTier; tierIndex: number; order: number; band: UsageBand; level: number; otherVendor: boolean }
  const ranked: Ranked[] = []
  const preferOtherVendor = SEPARATED_ROLES.has(role) && vendorsToAvoid.size > 0
  let order = 0
  tierFallbackOrder(tier).forEach((candidateTier, tierIndex) => {
    for (const family of config.tierFamilies[candidateTier]) {
      const candidate = resolveCandidate(family, candidateTier, ctx)
      if (!candidate) continue
      if (ctx.excludeModels.has(candidate.model.toLowerCase())) continue
      const sep = separationFamilyOf(candidate.model) ?? family
      if (bindingExclusions.some(e => e.family === family || e.family === sep)) continue
      if (needsVision && !deps.supportsVision(candidate.model, family)) continue
      if (!deps.isModelAllowed(candidate.model)) continue
      const vendor = vendorOf(candidate.model) ?? vendorOf(family)
      ranked.push({
        candidate,
        family,
        tier: candidateTier,
        tierIndex,
        order: order++,
        band: usage.band(candidate.route),
        level: usage.level(candidate.route),
        otherVendor: preferOtherVendor && (vendor === undefined || !vendorsToAvoid.has(vendor)),
      })
    }
  })
  if (ranked.length > 0) {
    const plain = ranked[0]!
    const sorted = [...ranked].sort((a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band]
      || (a.band !== 'ok' ? a.level - b.level : 0)
      || a.tierIndex - b.tierIndex
      || Number(b.otherVendor) - Number(a.otherVendor)
      || a.order - b.order,
    )
    const best = sorted[0]!
    const tierNote = best.tier === tier ? '' : `; ${tier} tier unavailable, used ${best.tier}`
    let usageNote = ''
    if (best !== plain && plain.band !== 'ok' && best.band === 'ok') {
      usageNote = `: ${usage.describe(plain.candidate.route)} → ${best.family}`
    } else if (best !== plain && plain.band !== 'ok' && best.candidate.route !== plain.candidate.route) {
      usageNote = `: ${usage.describe(plain.candidate.route)} → ${best.family} (least used, ${usage.describe(best.candidate.route)})`
    }
    const vendorNote =
      best !== plain && !usageNote && best.otherVendor && !plain.otherVendor
        ? `; other vendor than ${[...vendorsToAvoid].join('/')} preferred`
        : ''
    const warnings =
      best.band === 'exhausted'
        ? [`every usable provider route is at or over the exhausted threshold; using the least used (${usage.describe(best.candidate.route)})`]
        : [...usageWarnings]
    const warningNote = warnings.length > 0 ? `; WARNING: ${warnings.join('; ')}` : ''
    return withUsage({
      ...base,
      tier: best.tier,
      family: best.family,
      model: best.candidate.model,
      ...(best.candidate.providerProfile ? { providerProfile: best.candidate.providerProfile } : {}),
      source: roleSource,
      modelSource: 'tier',
      reason: `role ${roleReason}; model tier${usageNote}${vendorNote}${jevModelNote}${tierNote}${agentTypeNote}${exclusionNote}${warningNote}`,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    })
  }
  if (bindingExclusions.length > 0) {
    // A review/verify teammate with nothing rule-abiding to run on must not
    // silently fall back to the default model: that may be the
    // implementer's own family.
    const implementers = describeExclusions(bindingExclusions)
    const refusal = `Refusing to spawn ${role} teammate${input.name ? ` '${input.name}'` : ''}: no allowed${needsVision ? ' vision-capable' : ''} model outside the implementer's model family (${implementers}${input.teamName ? ` in team '${input.teamName}'` : ''}). A ${role} teammate must use a different model family than the implementer. Widen teammateModelAllowlist (e.g. add a model from another family, or "*"), or pass model with a model from another family.`
    return withUsage({
      ...base,
      source: roleSource,
      modelSource: 'none',
      reason: `role ${roleReason}; model none${jevModelNote}${agentTypeNote}${exclusionNote}`,
      refusal,
    })
  }
  const warning = `no configured${needsVision ? ' vision-capable' : ''} model is allowed for ${role}; spawning on the default model`
  return withUsage({
    ...base,
    source: roleSource,
    modelSource: 'none',
    reason: `role ${roleReason}; model none${jevModelNote}${agentTypeNote}; WARNING: ${warning}`,
    warning,
  })
}

function formatUsageSnapshot(snapshot: TeammateRouteDecision['routeUsage']): string {
  if (!snapshot) return '-'
  return Object.entries(snapshot)
    .map(([route, level]) => `${route}:${level === 'unknown' ? 'unknown' : `${Math.round(level * 100)}%`}`)
    .join(',')
}

/**
 * One line for the Agent tool result, e.g.
 * "dispatch: review → fable-5.1 as reviewer (jev p=0.86 / type p=0.81)".
 */
export function formatDispatchSummary(decision: TeammateRouteDecision): string {
  const target = decision.family ?? decision.model ?? 'default model'
  const as = decision.agentType ? ` as ${decision.agentType}` : ''
  const typeP = decision.agentTypeP !== undefined ? ` / type p=${decision.agentTypeP.toFixed(2)}` : ''
  const suffix = decision.mode === 'suggest' ? ' [suggest only — not applied]' : ''
  return `dispatch: ${decision.role} → ${target}${as} (${decision.reason}${typeP})${suffix}`
}

export function toDispatchRecord(
  decision: TeammateRouteDecision,
  applied: { family?: string; model?: string } = decision,
): TeammateDispatchRecord {
  return {
    role: decision.role,
    ...(applied.family ? { family: applied.family } : {}),
    ...(applied.model ? { model: applied.model } : {}),
    ...(decision.agentType ? { agentType: decision.agentType } : {}),
    ...(decision.agentTypeP !== undefined ? { agentTypeP: decision.agentTypeP } : {}),
    source: decision.source,
    mode: decision.mode,
    reason: decision.reason,
    ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
    ...(decision.costUsd !== undefined ? { costUsd: decision.costUsd } : {}),
    ...(decision.routeUsage ? { routeUsage: decision.routeUsage } : {}),
  }
}
