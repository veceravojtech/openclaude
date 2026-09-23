/**
 * Teammate dispatch: pick a model for each spawned teammate from its role.
 *
 * Two stages:
 *   1. ROLE — a cheap keyword heuristic first; when it is not confident, one
 *      JEV call (role / complexity / needs_long_context). JEV failure or a
 *      low-confidence answer falls back to the heuristic's best guess, then
 *      to `implement`.
 *   2. POLICY — role → tier → ordered family list, intersected with what this
 *      machine can actually serve (teammate allowlist ∩ configured routes),
 *      minus the SEPARATION RULE: a review/verify teammate never gets a model
 *      family used by an implementer in the same team.
 *
 * Never throws. Never blocks longer than the JEV timeout. When nothing
 * qualifies the teammate spawns on today's default model with a warning.
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
import { getModel as getCatalogModel } from '../../../integrations/registry.js'
import { ensureIntegrationsLoaded } from '../../../integrations/index.js'
import { parseUserSpecifiedModel } from '../../../utils/model/model.js'
import { readTeamFile } from '../../../utils/swarm/teamHelpers.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isModelAllowed } from '../../../utils/model/modelAllowlist.js'
import { hasAnthropicApiKeyAuth, isAnthropicAuthEnabled } from '../../../utils/auth.js'
import * as jevClient from '../../jev/client.js'
import type { JevAnswer, JevRequest, JevResult } from '../../jev/client.js'

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
  /**
   * False for in-process spawns (subagents, in-process teammates): they share
   * the leader's provider env, so only leader-route candidates are usable.
   */
  allowProfileBinding?: boolean
}

export type TeammateRouteExclusion = { family: DispatchFamily; by: string }

export type TeammateRouteDecision = {
  role: TeammateRole
  tier: DispatchTier
  family?: DispatchFamily
  model?: string
  /** Saved provider profile id to bind when the model is not on the leader's route. */
  providerProfile?: string
  source: 'jev' | 'heuristic' | 'explicit' | 'off'
  mode: TeammateDispatchMode
  reason: string
  complexity?: DispatchComplexity
  probabilities?: Record<string, number>
  costUsd?: number
  latencyMs?: number
  excluded?: TeammateRouteExclusion[]
  /** Set when the separation rule refuses an explicit model. */
  refusal?: string
  /** Set when nothing qualified and the default model is used. */
  warning?: string
}

/** Compact form stored on the team member and in the startup record. */
export type TeammateDispatchRecord = {
  role: TeammateRole
  family?: string
  model?: string
  source: TeammateRouteDecision['source']
  mode: TeammateDispatchMode
  reason: string
  probabilities?: Record<string, number>
  costUsd?: number
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
}

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
  supportsVision: (modelId: string, family: DispatchFamily) => boolean
  /** Organization model allowlist (availableModels). */
  isModelAllowed: (model: string) => boolean
}

function catalogVision(modelId: string, family: DispatchFamily): boolean {
  ensureIntegrationsLoaded()
  const lookups = [
    modelId,
    modelId.split('/').pop() ?? modelId,
    (modelId.split('/').pop() ?? modelId).replace(/:cloud$/, ''),
    DISPATCH_FAMILIES[family].entries[0]?.id,
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
  isModelAllowed: model => isModelAllowed(model),
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
// Stage 1b: JEV
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

type RoleClassification = {
  role: TeammateRole
  source: 'jev' | 'heuristic'
  reason: string
  complexity?: DispatchComplexity
  needsLongContext?: boolean
  probabilities?: Record<string, number>
  costUsd?: number
  latencyMs?: number
}

async function classifyRole(
  input: TeammateRouteInput,
  config: NormalizedTeammateDispatch,
  deps: TeammateDispatchDeps,
): Promise<RoleClassification> {
  const heuristic = classifyRoleHeuristic(input)
  if (heuristic.confident && heuristic.role) {
    return {
      role: heuristic.role,
      source: 'heuristic',
      reason: `heuristic ${heuristic.matched ?? heuristic.role}`,
      complexity: heuristic.complexity,
    }
  }
  const fallback = (why: string, extra?: Partial<RoleClassification>): RoleClassification => ({
    role: heuristic.role ?? 'implement',
    source: 'heuristic',
    reason: heuristic.role
      ? `heuristic best guess ${heuristic.matched ?? heuristic.role} (${why})`
      : `default implement (${why})`,
    complexity: heuristic.complexity,
    ...extra,
  })
  let configured = false
  try {
    configured = config.jev.enabled && deps.isJevConfigured()
  } catch {
    configured = false
  }
  if (!configured) {
    return fallback(config.jev.enabled ? 'jev not configured' : 'jev disabled')
  }

  const request: JevRequest = {
    instruction:
      'Classify the task a lead is delegating to a coding-agent teammate. role: what the teammate will mainly do. complexity: how hard the task is. needs_long_context: whether it must hold a large amount of code or text in context at once.',
    state: {
      description: input.description ?? '',
      name: input.name ?? '',
      subagent_type: input.subagent_type ?? '',
      prompt: (input.prompt ?? '').slice(0, 4000),
    },
    questions: {
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
    },
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
    return fallback(`jev error: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!result.ok) {
    return fallback(`jev ${result.reason}`, { latencyMs: result.latencyMs })
  }
  const roleAnswer = result.answers.role
  const accepted = deps.acceptChoice(roleAnswer, {
    minP: config.jev.minP,
    minMargin: config.jev.minMargin,
  })
  const probabilities =
    roleAnswer?.type === 'choice' ? roleAnswer.probabilities : undefined
  const complexityAnswer = result.answers.complexity
  const complexity =
    complexityAnswer?.type === 'score'
      ? COMPLEXITY_LEVELS[
          Math.max(0, Math.min(COMPLEXITY_LEVELS.length - 1, Math.round(complexityAnswer.score)))
        ]
      : undefined
  const longAnswer = result.answers.needs_long_context
  const needsLongContext =
    longAnswer?.type === 'boolean' ? longAnswer.probability >= 0.5 : undefined
  const meta = {
    probabilities,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    needsLongContext,
  }
  if (accepted && isRole(accepted)) {
    const p = probabilities?.[accepted]
    return {
      role: accepted,
      source: 'jev',
      reason: `jev${p !== undefined ? ` p=${p.toFixed(2)}` : ''}`,
      complexity: complexity ?? heuristic.complexity,
      ...meta,
    }
  }
  const best = roleAnswer?.type === 'choice' ? roleAnswer.choice : undefined
  const bestP = best ? probabilities?.[best] : undefined
  return fallback(
    `jev not confident${best ? `: ${best}${bestP !== undefined ? ` p=${bestP.toFixed(2)}` : ''}` : ''}`,
    { ...meta, complexity: complexity ?? heuristic.complexity },
  )
}

// ---------------------------------------------------------------------------
// Stage 2: policy + candidates
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
  if (allowed === null) return true
  const id = normalizeTeammateModelId(entry.id)
  return allowed.some(
    a => a.route === entry.route && normalizeTeammateModelId(a.id) === id,
  )
}

function resolveCandidate(
  family: DispatchFamily,
  tier: DispatchTier,
  ctx: {
    allowed: TeammateMatrixEntry[] | null
    wildcard: boolean
    leaderRoute: string
    anthropicAuth: boolean
    profiles: readonly ProviderProfile[]
    allowProfileBinding: boolean
  },
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
 * Families a review/verify teammate must avoid: every implementer's family,
 * and — for members with no recorded role (teams from before dispatch) —
 * every non-review member's family.
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
    const family =
      (member.family && isDispatchFamily(member.family) ? member.family : undefined) ??
      familyOfModel(member.model ?? leaderModel)
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SEPARATED_ROLES: ReadonlySet<TeammateRole> = new Set(['review', 'verify'])

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
  try {
    return await chooseTeammateRouteInner(input, config, getDeps())
  } catch (error) {
    logForDebugging(`[teammateDispatch] failed: ${error instanceof Error ? error.message : String(error)}`)
    return {
      role: 'implement',
      tier: 'standard',
      source: 'heuristic',
      mode: config.mode,
      reason: 'dispatcher error; using the default model',
      warning: `dispatcher error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function chooseTeammateRouteInner(
  input: TeammateRouteInput,
  config: NormalizedTeammateDispatch,
  deps: TeammateDispatchDeps,
): Promise<TeammateRouteDecision> {
  const classified = await classifyRole(input, config, deps)
  const { role } = classified
  const baseTier = config.roleTiers[role]
  let tier = baseTier
  if (role === 'implement' && classified.complexity === 'hard' && tier !== 'deep') {
    tier = DISPATCH_TIERS[DISPATCH_TIERS.indexOf(tier) - 1] ?? tier
  }
  if (
    role === 'research' &&
    classified.complexity === 'trivial' &&
    classified.needsLongContext !== true
  ) {
    tier = 'fast'
  }

  let excluded: TeammateRouteExclusion[] = []
  if (SEPARATED_ROLES.has(role) && input.teamName) {
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

  const base = {
    role,
    tier,
    mode: config.mode,
    complexity: classified.complexity,
    probabilities: classified.probabilities,
    costUsd: classified.costUsd,
    latencyMs: classified.latencyMs,
    ...(excluded.length > 0 ? { excluded } : {}),
  }
  const exclusionNote = excluded.length > 0 ? `; excluded ${describeExclusions(excluded)}` : ''

  // Explicit model: respect it, enforcing only the separation rule.
  if (input.explicitModel !== undefined) {
    const family = familyOfModel(input.explicitModel)
    if (family && excludedFamilies.has(family)) {
      const implementers = excluded.filter(e => e.family === family).map(e => `'${e.by}'`)
      const suggestions = suggestFamilies(tier, excludedFamilies, config)
      return {
        ...base,
        family,
        model: input.explicitModel,
        source: 'explicit',
        reason: `${classified.reason}; explicit ${input.explicitModel}`,
        refusal: `Refusing to spawn ${role} teammate${input.name ? ` '${input.name}'` : ''} on '${input.explicitModel}' (${family}): ${implementers.join(', ')} implemented with ${family} in team '${input.teamName}'. A ${role} teammate must use a different model family than the implementer. Use ${suggestions.length > 0 ? `one of: ${suggestions.join(', ')}` : 'a different model family'}, or omit model to let the dispatcher choose.`,
      }
    }
    return {
      ...base,
      ...(family ? { family } : {}),
      model: input.explicitModel,
      source: 'explicit',
      reason: `${classified.reason}; explicit model respected${exclusionNote}`,
    }
  }

  const wildcard = (input.settings?.teammateModelAllowlist ?? []).some(
    item => item.trim() === TEAMMATE_MODEL_ALLOWLIST_WILDCARD,
  )
  const ctx = {
    allowed: getAllowedTeammateEntries(input.settings?.teammateModelAllowlist),
    wildcard,
    leaderRoute: deps.leaderRoute(),
    anthropicAuth: false,
    profiles: [] as readonly ProviderProfile[],
    allowProfileBinding: input.allowProfileBinding !== false,
  }
  ctx.anthropicAuth = ctx.leaderRoute === 'anthropic' && deps.hasAnthropicAuth()
  try {
    ctx.profiles = deps.providerProfiles()
  } catch {
    ctx.profiles = []
  }
  const needsVision = role === 'computer_use'

  for (const candidateTier of tierFallbackOrder(tier)) {
    for (const family of config.tierFamilies[candidateTier]) {
      if (excludedFamilies.has(family)) continue
      const candidate = resolveCandidate(family, candidateTier, ctx)
      if (!candidate) continue
      if (needsVision && !deps.supportsVision(candidate.model, family)) continue
      if (!deps.isModelAllowed(candidate.model)) continue
      const tierNote = candidateTier === tier ? '' : `; ${tier} tier unavailable, used ${candidateTier}`
      return {
        ...base,
        tier: candidateTier,
        family,
        model: candidate.model,
        ...(candidate.providerProfile ? { providerProfile: candidate.providerProfile } : {}),
        source: classified.source,
        reason: `${classified.reason}${tierNote}${exclusionNote}`,
      }
    }
  }
  const warning = `no configured${needsVision ? ' vision-capable' : ''} model is allowed for ${role}${excluded.length > 0 ? ` after excluding ${describeExclusions(excluded)}` : ''}; spawning on the default model`
  return {
    ...base,
    source: classified.source,
    reason: `${classified.reason}; WARNING: ${warning}`,
    warning,
  }
}

function suggestFamilies(
  tier: DispatchTier,
  excluded: ReadonlySet<DispatchFamily>,
  config: NormalizedTeammateDispatch,
): DispatchFamily[] {
  const out: DispatchFamily[] = []
  for (const t of tierFallbackOrder(tier)) {
    for (const family of config.tierFamilies[t]) {
      if (!excluded.has(family) && !out.includes(family)) out.push(family)
    }
  }
  return out
}

/** One line for the Agent tool result, e.g. "dispatch: review → fable-5.1 (jev p=0.86; …)". */
export function formatDispatchSummary(decision: TeammateRouteDecision): string {
  const target = decision.family ?? decision.model ?? 'default model'
  const suffix = decision.mode === 'suggest' ? ' [suggest only — not applied]' : ''
  return `dispatch: ${decision.role} → ${target} (${decision.reason})${suffix}`
}

export function toDispatchRecord(
  decision: TeammateRouteDecision,
  applied: { family?: string; model?: string } = decision,
): TeammateDispatchRecord {
  return {
    role: decision.role,
    ...(applied.family ? { family: applied.family } : {}),
    ...(applied.model ? { model: applied.model } : {}),
    source: decision.source,
    mode: decision.mode,
    reason: decision.reason,
    ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
    ...(decision.costUsd !== undefined ? { costUsd: decision.costUsd } : {}),
  }
}
