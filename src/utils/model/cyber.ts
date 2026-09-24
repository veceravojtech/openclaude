import { AsyncLocalStorage } from 'node:async_hooks'
import { getCyberMode } from '../../bootstrap/state.js'

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

export function isCyberModelAllowed(model: string, scope: string | undefined = escalationContext.getStore()): boolean {
  const state = getCyberMode()
  if (!state.enabled) return true
  const id = cyberModelId(model)
  return id !== undefined && (id !== CYBER_MODELS.escalation ||
    (scope !== undefined && state.escalationScopes.has(scope)))
}

export function assertCyberModelAllowed(model: string, scope?: string): void {
  if (!isCyberModelAllowed(model, scope)) {
    throw new Error(`Cyber mode blocks '${model}'. Allowed models: glm-5.3, claude-opus-4-6, deepseek-v4-pro; claude-opus-4-8 requires a scoped escalation.`)
  }
}
