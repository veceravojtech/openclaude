import { AsyncLocalStorage } from 'node:async_hooks'
import { getCyberMode } from '../../bootstrap/state.js'
import { isTeammate } from '../teammate.js'

const escalationContext = new AsyncLocalStorage<string>()
export function withCyberScope<T>(scope: string, action: () => T): T {
  return escalationContext.run(scope, action)
}

import { getAllGateways, getAllModels, getAllVendors } from '../../integrations/index.js'

export const CYBER_MODELS = {
  lead: 'glm-5.3',
  worker: 'claude-opus-4-6',
  easy: 'deepseek-v4-pro',
  escalation: 'claude-opus-4-8',
} as const

// Legacy provider catalogs use separate descriptors for these exact models.
const PROVIDER_DESCRIPTOR_IDS: Readonly<Record<string, string>> = {
  'accounts/fireworks/models/deepseek-v4-pro': CYBER_MODELS.easy,
  'anthropic/claude-opus-4-6': CYBER_MODELS.worker,
  'anthropic/claude-opus-4-8': CYBER_MODELS.escalation,
}

/** Exact catalog identity, never family/prefix matching. */
export function cyberModelId(model: string): string | undefined {
  const normalized = model.trim().toLowerCase()
  const canonical = Object.values(CYBER_MODELS).find(id => id === normalized)
  if (canonical) return canonical
  for (const gateway of [...getAllGateways(), ...getAllVendors()]) {
    for (const entry of gateway.catalog?.models ?? []) {
      if ([entry.id, entry.apiName, ...(entry.aliases ?? [])].some(id => id.toLowerCase() === normalized)) {
        const descriptorId = entry.modelDescriptorId && (PROVIDER_DESCRIPTOR_IDS[entry.modelDescriptorId] ?? entry.modelDescriptorId)
        if (descriptorId && Object.values(CYBER_MODELS).some(id => id === descriptorId)) {
          return descriptorId
        }
      }
    }
  }
  for (const descriptor of getAllModels()) {
    if (Object.values(CYBER_MODELS).some(id => id === descriptor.id) &&
      [descriptor.defaultModel, ...Object.values(descriptor.providerModelMap ?? {})].some(id => id?.toLowerCase() === normalized)) {
      return descriptor.id
    }
  }
  return undefined
}

export type CyberModelCheckOptions = {
  /** The user is choosing this lead model right now (/model, picker, /provider, --model). */
  explicitChoice?: boolean
  /** The check guards the lead's own main-loop request, which may run the user's explicit choice. */
  leadQuery?: boolean
}

function comparableModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[\d+m\]$/, '')
}

/**
 * Whether `model` is the lead model the user explicitly chose while Cyber mode
 * is on. Aliases are resolved and a context suffix (`[1m]`) is ignored, so
 * `claude-opus-5-5` and `claude-opus-5-5[1m]` are the same choice.
 */
export function isExplicitCyberLeadModel(model: string): boolean {
  const { explicitLeadModel, explicitLeadModelResolved } = getCyberMode()
  if (!explicitLeadModel) return false
  const target = comparableModel(model)
  return comparableModel(explicitLeadModel) === target ||
    (explicitLeadModelResolved !== undefined && comparableModel(explicitLeadModelResolved) === target)
}

/**
 * Lead main-loop request sources; teammates and subagents never qualify. The
 * REPL tags the main loop `repl_main_thread:outputStyle:*` under a non-default
 * output style, so match the prefix too.
 */
export function isCyberMainLoopSource(querySource: string | undefined): boolean {
  return typeof querySource === 'string' &&
    (querySource === 'repl_main_thread' || querySource.startsWith('repl_main_thread:') || querySource === 'sdk')
}

export function isCyberLeadQuerySource(querySource: string | undefined): boolean {
  return !isTeammate() && isCyberMainLoopSource(querySource)
}

export function isCyberModelAllowed(
  model: string,
  scope: string | undefined = escalationContext.getStore(),
  allowEscalationModel = false,
  options?: CyberModelCheckOptions,
): boolean {
  const state = getCyberMode()
  if (!state.enabled) return true
  if (options?.explicitChoice) return true
  if (options?.leadQuery && !isTeammate() && isExplicitCyberLeadModel(model)) return true
  const id = cyberModelId(model)
  if (id === undefined) return false
  if (id !== CYBER_MODELS.escalation) return true
  return allowEscalationModel || (scope !== undefined && state.escalationScopes.has(scope))
}

export function assertCyberModelAllowed(
  model: string,
  scope?: string,
  allowEscalationModel = false,
  options?: CyberModelCheckOptions,
): void {
  if (!isCyberModelAllowed(model, scope, allowEscalationModel, options)) {
    throw new Error(`Cyber mode blocks '${model}'. Allowed models: glm-5.3, claude-opus-4-6, deepseek-v4-pro; claude-opus-4-8 requires a scoped escalation. To use another model for the lead, choose it explicitly with /model.`)
  }
}

/**
 * Whether the escalation model may run outside a scoped escalation because the
 * query belongs to a directly-spawned agent (a teammate or subagent), not the
 * leader's own main loop. The spawn path vets the model; this mirrors that
 * allowance into the agent's own API calls so a direct spawn is not blocked on
 * its first request.
 */
export function isCyberSpawnQuerySource(querySource: string | undefined): boolean {
  return isTeammate() || (typeof querySource === 'string' && querySource.startsWith('agent:'))
}
