/**
 * JEV decision benchmark: data model, runner and training export.
 *
 * The runner drives the REAL teammate dispatcher (`chooseTeammateRoute`) over a
 * set of task scenarios and records, per run, what the dispatcher decided and
 * what JEV itself answered (the raw typed answers, before Rule A and the hard
 * rules touched them). Statistics live in benchmarkAnalysis.ts, the text report
 * in benchmarkReport.ts, the seed scenarios and environments in
 * benchmarkFixtures.ts.
 *
 * Two modes:
 * - baseline: JEV is not called. The dispatcher still builds — and we capture —
 *   the exact request it would send, then falls back to its keyword heuristic
 *   and tier table. Free, offline, deterministic.
 * - live: the request goes to the real JEV endpoint, with the client's cache
 *   off so repeats are independent samples. This costs money and sends the
 *   scenario text to a third party, so use synthetic prompts.
 *
 * Scenarios may carry gold labels. They let the analysis score JEV (accuracy,
 * calibration, Rule A threshold sweep) and let `buildTrainingExamples` export
 * request -> gold pairs for fine-tuning.
 *
 * The dispatcher's only injection seam is `_setTeammateDispatchDepsForTesting`.
 * The runner installs its dependencies around each dispatch and always resets
 * them, so a benchmark never leaves the dispatcher patched.
 */
import { createHash } from 'crypto'
import type { ProviderProfile } from '../../utils/config.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import {
  _setTeammateDispatchDepsForTesting,
  chooseTeammateRoute,
  DISPATCH_TIERS,
  listSpawnableModels,
  readTeammateDispatchSettings,
  TEAMMATE_ROLES,
  vendorOf,
  type AgentTypeOption,
  type DispatchComplexity,
  type DispatchTier,
  type ModelVendor,
  type SpawnableModel,
  type TeammateRole,
  type TeammateRouteDecision,
  type TeamMemberLike,
} from '../api/smartRouting/teammate.js'
import * as jevClient from './client.js'
import type { JevRequest, JevResult } from './client.js'

export const BENCH_SCHEMA = 'openclaude.jev-bench/1'

/** Team name given to scenarios that declare implementers. */
export const BENCH_TEAM = 'jev-bench'

export const COMPLEXITY_LEVELS: readonly DispatchComplexity[] = [
  'trivial',
  'moderate',
  'hard',
]

// ---------------------------------------------------------------------------
// Scenarios and gold labels
// ---------------------------------------------------------------------------

/**
 * What an acceptable model looks like. Every field that is set must hold, so
 * `{ tier: 'deep', vision: true }` means "a deep-tier model with vision".
 */
export type ModelGold = {
  /**
   * Policy tier(s): the model's dispatch family must be one the effective
   * policy lists for the tier (`teammateDispatch.policy.tiers`, else the
   * defaults). Any listed tier satisfies it.
   */
  tier?: DispatchTier | readonly DispatchTier[]
  /** Exact model ids (case-insensitive); any one of them. */
  anyOf?: readonly string[]
  /** Vendors; any one of them. */
  vendors?: readonly ModelVendor[]
  /** true: the model must accept images. */
  vision?: boolean
  /** Minimum context window in tokens; an unknown window fails. */
  minContext?: number
  /** Ids that must not be picked. */
  notIn?: readonly string[]
}

/** A field given as an array is a set of acceptable answers. */
export type ScenarioGold = {
  role?: TeammateRole | readonly TeammateRole[]
  complexity?: DispatchComplexity | readonly DispatchComplexity[]
  needsLongContext?: boolean
  /** An agent type from the environment's definitions, or `default`. */
  agentType?: string | readonly string[]
  model?: ModelGold
}

export type BenchScenario = {
  /** Letters, digits, `.`, `_`, `-`: usable on a command line and in a file name. */
  id: string
  /** The Agent tool's `description` for the delegated task. */
  description: string
  /** The task prompt the lead would hand the teammate. */
  prompt: string
  name?: string
  /** An explicit agent type: JEV is then not asked to choose one. */
  subagentType?: string
  spawnPath?: 'teammate' | 'subagent'
  /**
   * Models teammates already implementing in the same team run on. They feed
   * the review/verify separation rule and the cross-vendor preference.
   */
  implementers?: readonly string[]
  tags?: readonly string[]
  notes?: string
  gold?: ScenarioGold
}

export function asList<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? ([...value] as T[]) : [value as T]
}

/** Throws one error listing every problem found. */
export function validateScenarios(scenarios: readonly BenchScenario[]): void {
  const problems: string[] = []
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('invalid scenarios: expected a non-empty array')
  }
  const seen = new Set<string>()
  const roles: readonly string[] = TEAMMATE_ROLES
  const tiers: readonly string[] = DISPATCH_TIERS
  const levels: readonly string[] = COMPLEXITY_LEVELS
  scenarios.forEach((s, index) => {
    const at = typeof s?.id === 'string' && s.id ? `scenario "${s.id}"` : `scenario #${index + 1}`
    if (typeof s !== 'object' || s === null) {
      problems.push(`${at}: not an object`)
      return
    }
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.id)) {
      problems.push(`${at}: id must match [A-Za-z0-9._-]+`)
    } else if (seen.has(s.id)) {
      problems.push(`${at}: duplicate id`)
    } else {
      seen.add(s.id)
    }
    if (typeof s.description !== 'string' || s.description.trim() === '') {
      problems.push(`${at}: description is required`)
    }
    if (typeof s.prompt !== 'string') problems.push(`${at}: prompt must be a string`)
    if (s.spawnPath !== undefined && s.spawnPath !== 'teammate' && s.spawnPath !== 'subagent') {
      problems.push(`${at}: spawnPath must be "teammate" or "subagent"`)
    }
    for (const field of ['implementers', 'tags'] as const) {
      const value = s[field]
      if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) {
        problems.push(`${at}: ${field} must be an array of strings`)
      }
    }
    const gold = s.gold
    if (gold === undefined) return
    for (const role of asList(gold.role)) {
      if (!roles.includes(role)) problems.push(`${at}: unknown gold role "${role}"`)
    }
    for (const level of asList(gold.complexity)) {
      if (!levels.includes(level)) problems.push(`${at}: unknown gold complexity "${level}"`)
    }
    if (gold.needsLongContext !== undefined && typeof gold.needsLongContext !== 'boolean') {
      problems.push(`${at}: gold.needsLongContext must be a boolean`)
    }
    for (const tier of asList(gold.model?.tier)) {
      if (!tiers.includes(tier)) problems.push(`${at}: unknown gold model tier "${tier}"`)
    }
  })
  if (problems.length > 0) throw new Error(`invalid scenarios:\n - ${problems.join('\n - ')}`)
}

/** Accepts an array of scenarios or `{ scenarios: [...] }`. */
export function parseScenarioFile(json: unknown): BenchScenario[] {
  const list =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as { scenarios?: unknown }).scenarios
      : json
  if (!Array.isArray(list)) {
    throw new Error('invalid scenarios: expected an array or { "scenarios": [...] }')
  }
  validateScenarios(list as BenchScenario[])
  return list as BenchScenario[]
}

// ---------------------------------------------------------------------------
// Environment, results
// ---------------------------------------------------------------------------

/** The world the dispatcher sees. Nothing here reads the machine's own config. */
export type BenchEnvironment = {
  leaderRoute: string
  anthropicAuth: boolean
  profiles: readonly ProviderProfile[]
  /** Carries teammateModelAllowlist and teammateDispatch (thresholds, timeout, policy). */
  settings: SettingsJson
  agentTypes: readonly AgentTypeOption[]
}

export type BenchMode = 'baseline' | 'live'

/** A model the dispatcher was allowed to offer JEV, with the facts gold labels use. */
export type BenchCandidate = Pick<
  SpawnableModel,
  | 'id'
  | 'route'
  | 'provider'
  | 'family'
  | 'separationFamily'
  | 'contextWindow'
  | 'vision'
  | 'reasoning'
  | 'priceTier'
> & { vendor?: ModelVendor }

export type BenchRun = {
  scenarioId: string
  /** 1-based; 0 for the single baseline pass of a live run. */
  repeat: number
  mode: BenchMode
  decision: TeammateRouteDecision
  /** Key into `BenchResults.requests` for the request the dispatcher built. */
  requestKey?: string
  /** The real JEV result (live mode only; absent in baseline mode). */
  jev?: JevResult
  /** Wall time of the whole dispatch, JEV call included. */
  wallMs: number
  error?: string
}

export type BenchConfig = {
  mode: BenchMode
  repeat: number
  endpoint: string
  jevModel: string
  /** Rule A thresholds the dispatcher used. */
  minP: number
  minMargin: number
  timeoutMs: number
  allowlist: string[]
  leaderRoute: string
  profiles: string[]
  agentTypes: string[]
  /** Effective policy: what a gold `tier` resolves to. */
  tierFamilies: Record<DispatchTier, string[]>
  roleTiers: Record<TeammateRole, DispatchTier>
  withBaseline: boolean
  zeroDataRetention: boolean
}

export type BenchResults = {
  schema: typeof BENCH_SCHEMA
  createdAt: string
  config: BenchConfig
  scenarios: BenchScenario[]
  /** What the dispatcher could offer JEV, per scenario id. */
  candidates: Record<string, BenchCandidate[]>
  /** Requests by content hash: repeats of a scenario share one entry. */
  requests: Record<string, JevRequest>
  runs: BenchRun[]
  /** One JEV-off pass per scenario, present when a live run asked for it. */
  baseline: BenchRun[]
  aborted: boolean
}

export function isBenchResults(value: unknown): value is BenchResults {
  const v = value as Partial<BenchResults> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.schema === BENCH_SCHEMA &&
    Array.isArray(v.scenarios) &&
    Array.isArray(v.runs) &&
    typeof v.config === 'object' &&
    v.config !== null &&
    typeof v.candidates === 'object' &&
    typeof v.requests === 'object'
  )
}

// ---------------------------------------------------------------------------
// Gold evaluation
// ---------------------------------------------------------------------------

/**
 * Whether a candidate satisfies a model gold. `undefined` when there is
 * nothing to judge (no gold, or the model is not a known candidate).
 */
export function evaluateModelGold(
  gold: ModelGold | undefined,
  candidate: BenchCandidate | undefined,
  tierFamilies: Readonly<Record<DispatchTier, readonly string[]>>,
): boolean | undefined {
  if (!gold || !candidate) return undefined
  const id = candidate.id.toLowerCase()
  if (gold.anyOf && !gold.anyOf.some(m => m.toLowerCase() === id)) return false
  if (gold.notIn?.some(m => m.toLowerCase() === id)) return false
  if (gold.vendors && (!candidate.vendor || !gold.vendors.includes(candidate.vendor))) return false
  if (gold.vision !== undefined && candidate.vision !== gold.vision) return false
  if (gold.minContext !== undefined && (candidate.contextWindow ?? 0) < gold.minContext) {
    return false
  }
  if (gold.tier !== undefined) {
    const families = asList(gold.tier).flatMap(t => tierFamilies[t] ?? [])
    if (!candidate.family || !families.includes(candidate.family)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type EvaluateFn = (
  request: JevRequest,
  opts?: { timeoutMs?: number },
) => Promise<JevResult>

export type RunOptions = {
  mode: BenchMode
  environment: BenchEnvironment
  /** Repetitions per scenario (default 1). Use several to measure stability. */
  repeat?: number
  /** Live mode: also run each scenario once with JEV off, for an agreement check. */
  withBaseline?: boolean
  /** Live mode: replaces the real client (tests). */
  evaluate?: EvaluateFn
  zeroDataRetention?: boolean
  signal?: AbortSignal
  onRun?: (info: { run: BenchRun; done: number; total: number }) => void
}

/** What a baseline run's JEV stub answers: the dispatcher then falls back. */
const STUB_RESULT: JevResult = { ok: false, reason: 'no_key', latencyMs: 0 }

function candidateOf(model: SpawnableModel): BenchCandidate {
  const vendor = vendorOf(model.id)
  return {
    id: model.id,
    route: model.route,
    provider: model.provider,
    ...(model.family ? { family: model.family } : {}),
    separationFamily: model.separationFamily,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    vision: model.vision,
    reasoning: model.reasoning,
    priceTier: model.priceTier,
    ...(vendor ? { vendor } : {}),
  }
}

export function requestKey(request: JevRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 12)
}

function implementerMembers(scenario: BenchScenario): TeamMemberLike[] {
  return (scenario.implementers ?? []).map((model, index) => ({
    name: `implementer-${index + 1}`,
    model,
    role: 'implement',
  }))
}

/** Installs the dispatcher's dependencies, runs `fn`, and always resets them. */
async function withDispatcherDeps<T>(
  scenario: BenchScenario,
  environment: BenchEnvironment,
  evaluateJev: (request: JevRequest, opts?: { timeoutMs?: number }) => Promise<JevResult>,
  fn: () => Promise<T>,
): Promise<T> {
  const members = implementerMembers(scenario)
  _setTeammateDispatchDepsForTesting({
    // Always "configured": in baseline mode the stub below answers instead.
    isJevConfigured: () => true,
    evaluateJev,
    readTeamMembers: () => members,
    leaderRoute: () => environment.leaderRoute,
    hasAnthropicAuth: () => environment.anthropicAuth,
    providerProfiles: () => environment.profiles,
    isModelAllowed: () => true,
    // Usage-aware dispatch would make results depend on the machine's quota.
    routeUsage: route => ({ route, level: 'unknown' }),
  })
  try {
    return await fn()
  } finally {
    _setTeammateDispatchDepsForTesting(undefined)
  }
}

function dispatchInput(scenario: BenchScenario, environment: BenchEnvironment) {
  const path = scenario.spawnPath ?? 'teammate'
  return {
    description: scenario.description,
    prompt: scenario.prompt,
    ...(scenario.name ? { name: scenario.name } : {}),
    ...(scenario.subagentType ? { subagent_type: scenario.subagentType } : {}),
    ...(scenario.implementers && scenario.implementers.length > 0
      ? { teamName: BENCH_TEAM }
      : {}),
    settings: environment.settings,
    agentTypes: environment.agentTypes,
    spawnPath: path,
    // In-process spawns share the leader's provider env: no profile binding.
    allowProfileBinding: path !== 'subagent',
  }
}

function buildConfig(options: RunOptions, repeat: number): BenchConfig {
  const { environment } = options
  const dispatch = readTeammateDispatchSettings(environment.settings)
  return {
    mode: options.mode,
    repeat,
    endpoint: jevClient.JEV_ENDPOINT,
    jevModel: jevClient.JEV_MODEL,
    minP: dispatch.jev.minP ?? jevClient.RULE_A_MIN_P,
    minMargin: dispatch.jev.minMargin ?? jevClient.RULE_A_MIN_MARGIN,
    timeoutMs: dispatch.jev.timeoutMs ?? 3000,
    allowlist: [...(environment.settings.teammateModelAllowlist ?? [])],
    leaderRoute: environment.leaderRoute,
    profiles: environment.profiles.map(p => p.name),
    agentTypes: environment.agentTypes.map(a => a.agentType),
    tierFamilies: {
      deep: [...dispatch.tierFamilies.deep],
      standard: [...dispatch.tierFamilies.standard],
      fast: [...dispatch.tierFamilies.fast],
    },
    roleTiers: { ...dispatch.roleTiers },
    withBaseline: Boolean(options.withBaseline),
    zeroDataRetention: Boolean(options.zeroDataRetention),
  }
}

export async function runBenchmark(
  scenarios: readonly BenchScenario[],
  options: RunOptions,
): Promise<BenchResults> {
  validateScenarios(scenarios)
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1))
  const live = options.mode === 'live'
  const evaluate: EvaluateFn =
    options.evaluate ??
    ((request, opts) =>
      jevClient.evaluateJev(request, {
        ...opts,
        cache: false,
        zeroDataRetention: options.zeroDataRetention === true,
      }))
  const results: BenchResults = {
    schema: BENCH_SCHEMA,
    createdAt: new Date().toISOString(),
    config: buildConfig(options, repeat),
    scenarios: [...scenarios],
    candidates: {},
    requests: {},
    runs: [],
    baseline: [],
    aborted: false,
  }
  const total = scenarios.length * repeat + (live && options.withBaseline ? scenarios.length : 0)
  let done = 0

  const runOne = async (
    scenario: BenchScenario,
    mode: BenchMode,
    repeatIndex: number,
  ): Promise<BenchRun> => {
    let captured: { request: JevRequest; result: JevResult } | undefined
    const started = Date.now()
    let decision: TeammateRouteDecision
    let error: string | undefined
    try {
      decision = await withDispatcherDeps(
        scenario,
        options.environment,
        async (request, opts) => {
          let result: JevResult = STUB_RESULT
          if (mode === 'live') {
            const callStarted = Date.now()
            try {
              result = await evaluate(request, opts)
            } catch (e) {
              // The real client never throws; an injected one might. Record it
              // as a failed call rather than losing the call.
              result = {
                ok: false,
                reason: 'network_error',
                detail: e instanceof Error ? e.message : String(e),
                latencyMs: Date.now() - callStarted,
              }
            }
          }
          captured = { request, result }
          return result
        },
        () => chooseTeammateRoute(dispatchInput(scenario, options.environment)),
      )
    } catch (e) {
      // chooseTeammateRoute does not throw outside cyber mode; keep the run anyway.
      error = e instanceof Error ? e.message : String(e)
      decision = {
        role: 'implement',
        tier: 'standard',
        source: 'heuristic',
        mode: 'auto',
        reason: `benchmark error: ${error}`,
        warning: error,
      }
    }
    const key = captured ? requestKey(captured.request) : undefined
    if (captured && key) results.requests[key] = captured.request
    return {
      scenarioId: scenario.id,
      repeat: repeatIndex,
      mode,
      decision,
      ...(key ? { requestKey: key } : {}),
      ...(captured && mode === 'live' ? { jev: captured.result } : {}),
      wallMs: Date.now() - started,
      ...(error ? { error } : {}),
    }
  }

  for (const scenario of scenarios) {
    const path = scenario.spawnPath ?? 'teammate'
    results.candidates[scenario.id] = await withDispatcherDeps(
      scenario,
      options.environment,
      async () => STUB_RESULT,
      async () =>
        listSpawnableModels({
          settings: options.environment.settings,
          allowProfileBinding: path !== 'subagent',
        }).candidates.map(candidateOf),
    )
  }

  const record = (run: BenchRun, into: BenchRun[]) => {
    into.push(run)
    done += 1
    options.onRun?.({ run, done, total })
  }

  outer: for (const scenario of scenarios) {
    for (let index = 1; index <= repeat; index++) {
      if (options.signal?.aborted) {
        results.aborted = true
        break outer
      }
      record(await runOne(scenario, options.mode, index), results.runs)
    }
  }
  if (live && options.withBaseline && !results.aborted) {
    for (const scenario of scenarios) {
      if (options.signal?.aborted) {
        results.aborted = true
        break
      }
      record(await runOne(scenario, 'baseline', 0), results.baseline)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Training export
// ---------------------------------------------------------------------------

/** One supervised example: what JEV was asked, and what a good answer is. */
export type TrainingExample = {
  id: string
  tags: string[]
  /** Exactly the request the dispatcher built (unredacted). */
  request: JevRequest
  gold: {
    role?: { choices: string[]; distribution: Record<string, number> }
    complexity?: { levels: string[]; scores: number[] }
    needs_long_context?: { value: boolean }
    agent_type?: { choices: string[]; distribution: Record<string, number> }
    /** Offered model ids that satisfy the scenario's model gold. */
    model?: {
      acceptable: string[]
      distribution: Record<string, number>
      constraints: ModelGold
    }
  }
}

function uniform(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map(k => [k, 1 / keys.length]))
}

function offeredKeys(request: JevRequest, question: string): string[] {
  const q = request.questions[question]
  return q?.type === 'choice' ? Object.keys(q.criteria) : []
}

/**
 * Scenarios that have gold labels and a captured request, as training
 * examples. Choices are restricted to what the request actually offered: a
 * gold answer JEV could not have given is dropped, not exported.
 */
export function buildTrainingExamples(results: BenchResults): TrainingExample[] {
  const all = [...results.runs, ...results.baseline]
  const out: TrainingExample[] = []
  for (const scenario of results.scenarios) {
    const g = scenario.gold
    if (!g) continue
    const run = all.find(r => r.scenarioId === scenario.id && r.requestKey)
    const request = run?.requestKey ? results.requests[run.requestKey] : undefined
    if (!request) continue
    const gold: TrainingExample['gold'] = {}

    const roles = asList(g.role).filter(r => offeredKeys(request, 'role').includes(r))
    if (roles.length > 0) gold.role = { choices: roles, distribution: uniform(roles) }

    const levels = asList(g.complexity)
    if (levels.length > 0) {
      gold.complexity = { levels, scores: levels.map(l => COMPLEXITY_LEVELS.indexOf(l)) }
    }
    if (g.needsLongContext !== undefined) {
      gold.needs_long_context = { value: g.needsLongContext }
    }

    const types = asList(g.agentType).filter(t => offeredKeys(request, 'agent_type').includes(t))
    if (types.length > 0) gold.agent_type = { choices: types, distribution: uniform(types) }

    if (g.model) {
      const byId = new Map((results.candidates[scenario.id] ?? []).map(c => [c.id, c]))
      const acceptable = offeredKeys(request, 'model').filter(
        id => evaluateModelGold(g.model, byId.get(id), results.config.tierFamilies) === true,
      )
      if (acceptable.length > 0) {
        gold.model = { acceptable, distribution: uniform(acceptable), constraints: g.model }
      }
    }
    if (Object.keys(gold).length === 0) continue
    out.push({ id: scenario.id, tags: [...(scenario.tags ?? [])], request, gold })
  }
  return out
}

export function trainingExamplesToJsonl(examples: readonly TrainingExample[]): string {
  return examples.map(e => JSON.stringify(e)).join('\n') + (examples.length > 0 ? '\n' : '')
}
