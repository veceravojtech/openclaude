import { getCyberMode, setCyberExplicitLeadModel } from '../../bootstrap/state.js'
import { CYBER_MODELS, cyberModelId } from './cyber.js'
import { parseUserSpecifiedModel } from './model.js'

/**
 * Record a lead model the user chose explicitly (/model, the picker,
 * /provider, --model, SDK set_model). Call this ONLY from user entry points:
 * automatic changes (rate-limit fallback, /fast) must not unlock a model.
 * Choosing null (default) or the Cyber lead model clears the choice.
 *
 * Lives outside cyber.ts because it needs model.ts, and model.ts reaches
 * cyber.ts through the allowlist; importing model.ts from cyber.ts would make
 * that a cycle.
 */
export function recordCyberLeadModelChoice(model: string | null | undefined): void {
  if (!getCyberMode().enabled) return
  const trimmed = model?.trim()
  if (!trimmed || cyberModelId(trimmed) === CYBER_MODELS.lead) {
    setCyberExplicitLeadModel(undefined)
    return
  }
  let resolved: string | undefined
  try {
    resolved = parseUserSpecifiedModel(trimmed)
  } catch {
    resolved = undefined
  }
  setCyberExplicitLeadModel(trimmed, resolved)
}
