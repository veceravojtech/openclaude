import type { SettingsJson } from '../../utils/settings/types.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { parseModelFlagValue } from '../../utils/cliArgs.js'
import { argsBeforeModelOwningSubcommand } from '../../utils/printFlag.js'
import { resolveRouteIdFromBaseUrl } from '../../integrations/routeMetadata.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import {
  findProviderProfilesForModel,
  findCodexOAuthProfileForModel,
  findProviderProfileRouteForModel,
} from '../../utils/providerProfiles.js'
import type { ProviderProfile } from '../../utils/config.js'

/**
 * Provider override resolved from agent routing config.
 * When present, the API client should use these instead of global env vars.
 */
export interface ProviderOverride {
  /** Model name to send to the API (e.g. "deepseek-chat", "gpt-4o") */
  model: string
  /** OpenAI-compatible base URL */
  baseURL: string
  /** API key for this provider */
  apiKey: string
}

/** A saved provider profile route. The child resolves credentials by id. */
export interface AgentProviderProfileRoute {
  /** Saved profile id or name. Never a credential or endpoint. */
  providerProfile: string
  /** Optional model override; omitted means the profile's primary model. */
  model?: string
}

/** A model-only route: reuse the session's current provider, just change the model. */
export type AgentModelOnly = { model: string }

/** A resolved agent route — a full cross-provider override or a model-only swap. */
export type AgentRoute = ProviderOverride | AgentModelOnly | AgentProviderProfileRoute

/** Narrow an AgentRoute to a full cross-provider ProviderOverride. */
export function isProviderOverride(route: AgentRoute): route is ProviderOverride {
  return 'apiKey' in route && 'baseURL' in route
}

/** Narrow an AgentRoute to an identity-only saved-profile route. */
export function isProviderProfileRoute(
  route: AgentRoute,
): route is AgentProviderProfileRoute {
  return 'providerProfile' in route
}

export interface AgentRunModelRouting {
  mainLoopModel: string
  providerOverride?: ProviderOverride
}

type AgentModelConfig = NonNullable<SettingsJson['agentModels']>[string]

const PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'NVIDIA_NIM',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'MISTRAL_MODEL',
  'MISTRAL_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
] as const

/**
 * Normalize an agent identifier for case-insensitive, hyphen/underscore-agnostic matching.
 */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

/**
 * Turn one agentModels entry into a route. A broken entry (provider_profile
 * mixed with credentials, or only one of base_url/api_key) warns and yields
 * null by default; with `strict` it throws instead, so a caller that reached
 * the entry through an explicit agentRouting key never silently falls back
 * to the leader's model.
 */
function toAgentRoute(
  configuredModelKey: string,
  modelConfig: AgentModelConfig | undefined,
  options?: { strict?: boolean },
): AgentRoute | null {
  if (!modelConfig) return null
  const reject = (message: string): null => {
    if (options?.strict) throw new Error(message)
    console.error(`[agentRouting] Warning: ${message} Skipping this route.`)
    return null
  }

  const model = modelConfig.model?.trim()
  const baseURL = modelConfig.base_url?.trim()
  const apiKey = modelConfig.api_key?.trim()

  const providerProfile = modelConfig.provider_profile?.trim()
  if (providerProfile) {
    if (baseURL || apiKey) {
      return reject(
        `agentModels entry "${configuredModelKey}" cannot combine provider_profile with base_url/api_key.`,
      )
    }
    return {
      providerProfile,
      ...(model ? { model } : {}),
    }
  }

  const effectiveModel = model || configuredModelKey

  // Model-only route: no credentials → reuse the active provider, swap the model.
  if (!baseURL && !apiKey) return { model: effectiveModel }

  // Misconfiguration: a cross-provider route needs BOTH endpoint and key.
  if (!baseURL || !apiKey) {
    return reject(
      `agentModels entry "${configuredModelKey}" has only one of base_url/api_key; both are required for cross-provider routing.`,
    )
  }

  return { model: effectiveModel, baseURL, apiKey }
}

/**
 * Look up agent.routing by name or subagent_type, then resolve via agent.models.
 *
 * Priority: name > subagentType > "default" > null (use global provider)
 *
 * A matched routing key is an explicit instruction, so it never degrades to
 * the leader's model: a key naming a missing agentModels entry, or a
 * half-configured one, throws with the key and the entry named.
 */
export function resolveAgentProvider(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
): AgentRoute | null {
  if (!settings) return null

  const routing = settings.agentRouting
  const models = settings.agentModels
  if (!routing) return null

  // Build normalized lookup from routing config.
  // Warn on duplicate normalized keys (e.g. "explore-agent" and "explore_agent"
  // both normalize to "exploreagent") to prevent silent shadowing.
  const normalizedRouting = new Map<string, { key: string; value: string }>()
  for (const [key, value] of Object.entries(routing)) {
    const nk = normalize(key)
    if (normalizedRouting.has(nk)) {
      console.error(
        `[agentRouting] Warning: routing key "${key}" collides with an existing key after normalization (both map to "${nk}"). First entry wins.`,
      )
    }
    if (!normalizedRouting.has(nk)) {
      normalizedRouting.set(nk, { key, value })
    }
  }

  // Try name first, then subagentType, then "default"
  const candidates = [name, subagentType, 'default'].filter(Boolean) as string[]
  let matched: { key: string; value: string } | undefined

  for (const candidate of candidates) {
    const match = normalizedRouting.get(normalize(candidate))
    if (match?.value) {
      matched = match
      break
    }
  }

  if (!matched) return null

  const modelName = matched.value
  const entry = models?.[modelName]
  if (!entry) {
    throw new Error(
      `agentRouting key "${matched.key}" points to agentModels entry "${modelName}", which does not exist. Add it to agentModels or remove the routing entry.`,
    )
  }
  try {
    return toAgentRoute(modelName, entry, { strict: true })
  } catch (error) {
    throw new Error(
      `agentRouting key "${matched.key}": ${(error as Error).message}`,
    )
  }
}

/**
 * Resolve an agent route directly from a requested model name (cross-provider or model-only).
 * Checks for an exact match in agentModels. Does not fuzzy match or normalize case.
 *
 * With no usable agentModels entry, a session on Anthropic's own API also looks
 * for a saved provider profile that serves a non-Claude model (see
 * resolveProviderProfileRoute). An explicit agentModels entry always wins.
 *
 * `strict` is for an EXPLICIT model argument (the Agent tool's `model`, a
 * teammate's `--model`). When that argument names an agentModels key, the key
 * is an instruction, just like an agentRouting key: a broken entry throws with
 * the key named, instead of being skipped. Skipping it would run the teammate
 * on the leader's provider with the raw key as its model id — silently on the
 * leader's credentials, or failing at the first API call. A model that is not
 * an agentModels key resolves exactly as it does without `strict`.
 */
export function resolveAgentModelProvider(
  modelName: string | undefined,
  settings: SettingsJson | null,
  options?: { strict?: boolean },
): AgentRoute | null {
  if (!modelName) return null

  const trimmedModelName = modelName.trim()
  const configured = settings?.agentModels
    ? toAgentRoute(trimmedModelName, settings.agentModels[trimmedModelName], {
        strict: options?.strict,
      })
    : null
  return configured ?? resolveProviderProfileRoute(trimmedModelName)
}

/**
 * Positive-knowledge guard for model-only pane/window teammate spawns:
 * returns the saved OAuth Codex profile when ALL of the following hold —
 * the session runs on Anthropic's own API, the requested model is not a
 * Claude model (so first-party provably cannot serve it), nothing routes it
 * (no agentModels entry, no API-key provider profile), and an OAuth Codex
 * profile explicitly lists it (findCodexOAuthProfileForModel). That last
 * match is the point: it proves both the user's intended provider and that
 * model routing structurally cannot carry it — OAuth profiles have no API
 * key, the one thing a route needs.
 *
 * Deliberately NARROWER than the up-front refusal tried and removed with
 * 4962e860: that one rejected ANY unservable model and broke existing
 * contracts that spawn placeholder/custom ids as-is. Under the conditions
 * above a null return means "none of the caller's business", and only the
 * positive OAuth match means "refuse with guidance" — so 'forbidden-model',
 * 'allowed-model', 'custom-provider-model' and 'gpt-5-mini' (the removed
 * attempt's casualties) still spawn untouched.
 *
 * This is also the seam a future auto-bind would use: the same lookup,
 * binding the returned profile instead of refusing.
 */
export function findUnroutableCodexOAuthProfile(
  modelName: string | undefined,
  settings: SettingsJson | null,
): ProviderProfile | null {
  if (!modelName) return null
  const trimmed = modelName.trim()
  if (!trimmed) return null
  if (!isAnthropicFirstPartySession()) return null
  if (isPossiblyClaudeModel(trimmed)) return null
  if (resolveAgentModelProvider(trimmed, settings) !== null) return null
  return findCodexOAuthProfileForModel(trimmed)
}

/**
 * Whether a requested model could be a Claude model: an alias, `inherit`, or an
 * id naming a Claude family. Deliberately broad — a false "Claude" only skips
 * the profile fallback, while a false "not Claude" would reroute a model
 * Anthropic's API may well serve.
 */
function isPossiblyClaudeModel(model: string): boolean {
  return (
    model === 'inherit' ||
    isModelAlias(model) ||
    /claude|opus|sonnet|haiku/i.test(model)
  )
}

/** Whether this session's requests go to Anthropic's own API. */
function isAnthropicFirstPartySession(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * A saved provider profile's route for a model, used only when the session runs
 * on Anthropic's own API and the model is not a Claude model.
 *
 * That is the one case where the model cannot run on the session's provider at
 * all: without a route, an agent or teammate asked for e.g. `glm-5.3` sent it to
 * Anthropic and died at once with "There's an issue with the selected model". A
 * matching profile yields exactly the route an equivalent agentModels entry
 * would, so the user need not repeat its endpoint and key in settings.
 *
 * Scoped this narrowly so no working setup changes: on any other provider, or
 * for a Claude model, resolution is exactly what it was.
 */
function resolveProviderProfileRoute(model: string): ProviderOverride | null {
  if (!isAnthropicFirstPartySession() || isPossiblyClaudeModel(model)) {
    return null
  }
  return findProviderProfileRouteForModel(model)
}

/**
 * Resolve a model-only route's model to what should actually run. A bare
 * built-in alias ("sonnet"/"haiku"/"opus"/"inherit") is sent through the same
 * provider-aware path as the agent model selector (getAgentModel), so on
 * non-Claude-native providers it inherits the parent model instead of being
 * sent literally and failing with a provider "model not found". A real model id
 * (a configured agentModels key for the active provider) passes through as-is.
 */
export function resolveModelOnlyModel(
  model: string,
  parentModel: string,
  permissionMode?: PermissionMode,
): string {
  if (model === 'inherit' || isModelAlias(model)) {
    return getAgentModel(model, parentModel, undefined, permissionMode)
  }
  return model
}

export function resolveAgentRunModelRouting({
  resolvedAgentModel,
  parentModel,
  toolSpecifiedModel,
  agentName,
  subagentType,
  agentDefinitionModel,
  settings,
  permissionMode,
}: {
  resolvedAgentModel: string
  parentModel: string
  toolSpecifiedModel?: string
  agentName?: string
  subagentType?: string
  agentDefinitionModel?: string
  settings: SettingsJson | null
  permissionMode?: PermissionMode
}): AgentRunModelRouting {
  const toolRequestedModel = toolSpecifiedModel?.trim()
  if (toolRequestedModel) {
    // Tool-specified models are explicit. If the request is not a configured
    // agentModels key, preserve getAgentModel() alias/inherit/custom-ID behavior
    // instead of falling through to persistent agentRouting.
    const route = resolveAgentModelProvider(toolRequestedModel, settings, {
      strict: true,
    })
    if (!route) return { mainLoopModel: resolvedAgentModel }
    if (isProviderOverride(route)) {
      return { mainLoopModel: route.model, providerOverride: route }
    }
    if (isProviderProfileRoute(route)) {
      throw new Error(
        'agentModels provider_profile routes require a pane/window teammate; in-process agents cannot switch provider environments.',
      )
    }
    return {
      mainLoopModel: resolveModelOnlyModel(route.model, parentModel, permissionMode),
    }
  }

  const route =
    resolveAgentProvider(agentName, subagentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  if (!route) return { mainLoopModel: resolvedAgentModel }
  if (isProviderOverride(route)) {
    return { mainLoopModel: route.model, providerOverride: route }
  }
  if (isProviderProfileRoute(route)) {
    throw new Error(
      'agentModels provider_profile routes require a pane/window teammate; in-process agents cannot switch provider environments.',
    )
  }
  return {
    mainLoopModel: resolveModelOnlyModel(route.model, parentModel, permissionMode),
  }
}

/**
 * Whether the org model allowlist must be enforced for a resolved agent run.
 * Enforce whenever routing changed the model: a cross-provider override is set,
 * or a model-only route changed the effective model from what getAgentModel()
 * resolved. An unchanged inherited model was already vetted upstream.
 */
export function shouldEnforceModelAllowlist(
  resolvedAgentModel: string,
  effectiveModel: string,
  hasProviderOverride: boolean,
): boolean {
  return hasProviderOverride || effectiveModel !== resolvedAgentModel
}

/**
 * Resolve provider routing for a teammate that will run as its own CLI process.
 *
 * Pane/window teammates do not enter runAgent() in the parent process. They
 * become the child process's main loop, so the child startup path must resolve
 * the same configured agentModels route from its CLI identity.
 */
type OutOfProcessTeammateRouteInput = {
  cliModel?: string
  agentName?: string
  agentType?: string
  agentDefinitionModel?: string
  settings: SettingsJson | null
}

/**
 * Discover a saved profile for a model only when the caller has not already
 * selected an agentModels route. A positive profile match is safe to bind;
 * an unknown model remains untouched, while multiple matches fail closed so a
 * teammate never silently switches accounts.
 */
function resolveDiscoveredProviderProfileRoute(
  model: string | undefined,
): AgentProviderProfileRoute | null {
  const requested = model?.trim()
  if (!requested) return null

  const matches = findProviderProfilesForModel(requested)
  if (matches.length === 0) return null
  if (matches.length > 1) {
    const candidates = matches
      .map(profile => `${profile.name} (${profile.id})`)
      .join(', ')
    throw new Error(
      `Model '${requested}' is advertised by multiple saved provider profiles: ${candidates}. Select one with provider_profile or configure an explicit agentModels route.`,
    )
  }

  return {
    providerProfile: matches[0]!.id,
    model: requested,
  }
}

/** Resolve the complete route, including identity-only saved profile routes. */
function resolveOutOfProcessTeammateRoute({
  cliModel,
  agentName,
  agentType,
  agentDefinitionModel,
  settings,
}: OutOfProcessTeammateRouteInput): AgentRoute | null {
  const requestedModel = cliModel?.trim()
  if (requestedModel) {
    const route = resolveAgentModelProvider(requestedModel, settings, {
      strict: true,
    })
    return route ?? resolveDiscoveredProviderProfileRoute(requestedModel)
  }

  const route =
    resolveAgentProvider(agentName, agentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  if (route) return route
  return resolveDiscoveredProviderProfileRoute(agentDefinitionModel)
}

export function resolveOutOfProcessTeammateProvider({
  ...input
}: OutOfProcessTeammateRouteInput): ProviderOverride | null {
  const route = resolveOutOfProcessTeammateRoute(input)
  return route && isProviderOverride(route) ? route : null
}

/**
 * Resolve an identity-only saved profile for a pane/window teammate. The
 * returned model is the requested model when auto-discovered; explicit
 * provider_profile routes may omit it and let the child use the profile's
 * primary model.
 */
export function resolveOutOfProcessTeammateProviderProfile({
  ...input
}: OutOfProcessTeammateRouteInput): AgentProviderProfileRoute | null {
  const route = resolveOutOfProcessTeammateRoute(input)
  return route && isProviderProfileRoute(route) ? route : null
}

/**
 * Resolve the model a pane/window teammate should run when its configured route
 * is model-only (no cross-provider override). The provider twin above filters to
 * ProviderOverride, so model-only routes the menu writes (e.g. agentRouting set
 * to a plain agentModels key) are dropped and the teammate inherits the parent.
 * This returns that route's provider-aware model so the spawn path can apply it.
 * Mirrors resolveAgentRunModelRouting's lookup order (tool model, then agent
 * name/type, then agent-definition model). Returns undefined when there is no
 * model-only route, so the caller keeps the inherit-parent default.
 */
export function resolveOutOfProcessTeammateModelOnly({
  cliModel,
  agentName,
  agentType,
  agentDefinitionModel,
  parentModel,
  permissionMode,
  settings,
}: {
  cliModel?: string
  agentName?: string
  agentType?: string
  agentDefinitionModel?: string
  parentModel: string
  permissionMode?: PermissionMode
  settings: SettingsJson | null
}): string | undefined {
  const requestedModel = cliModel?.trim()
  if (requestedModel) {
    const route = resolveAgentModelProvider(requestedModel, settings, {
      strict: true,
    })
    return route && !isProviderOverride(route) && !isProviderProfileRoute(route)
      ? resolveModelOnlyModel(route.model, parentModel, permissionMode)
      : undefined
  }

  const route =
    resolveAgentProvider(agentName, agentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  return route && !isProviderOverride(route) && !isProviderProfileRoute(route)
    ? resolveModelOnlyModel(route.model, parentModel, permissionMode)
    : undefined
}

export function resolveOutOfProcessTeammateProviderFromCliArgs(
  args: readonly string[],
  settings: SettingsJson | null,
): ProviderOverride | null {
  if (hasCliFlag(args, '--provider')) return null

  const agentName = parseCliFlag(args, '--agent-name')
  const teamName = parseCliFlag(args, '--team-name')
  if (!agentName || !teamName) return null

  return resolveOutOfProcessTeammateProvider({
    cliModel: parseModelFlagValue(argsBeforeModelOwningSubcommand(args)),
    agentName,
    agentType: parseCliFlag(args, '--agent-type'),
    settings,
  })
}

function hasCliFlag(args: readonly string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
}

function parseCliFlag(args: readonly string[], flag: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1)
      return value || undefined
    }
  }
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) return undefined
  return value
}

/**
 * Apply an agentModels provider override to a child process environment.
 *
 * agentModels entries are OpenAI-compatible routes. Clear competing route
 * selectors and stale model/endpoint/header knobs first because provider
 * detection gives several selectors higher priority than CLAUDE_CODE_USE_OPENAI.
 */
export function applyAgentProviderOverrideToEnv(
  providerOverride: ProviderOverride,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  for (const key of PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE) {
    delete env[key]
  }

  env.CLAUDE_CODE_USE_OPENAI = '1'
  env.OPENAI_MODEL = providerOverride.model
  env.OPENAI_BASE_URL = providerOverride.baseURL
  env.OPENAI_API_KEY = providerOverride.apiKey
  if (resolveRouteIdFromBaseUrl(providerOverride.baseURL) === 'commandcode') {
    env.CMD_API_KEY = providerOverride.apiKey
  }
}
