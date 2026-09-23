import {
  isFableAtLeast,
  modelRequiresAlwaysOnThinking,
  modelSupportsCustomTemperature,
  modelSupportsForcedToolChoice,
} from '../../utils/model/opusVersion.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Per-model request constraints applied at the last point before a Messages
 * API request is sent (queryModel's params builder and sideQuery), so every
 * caller is covered without patching each call site.
 *
 * Claude Fable 5.1+:
 * - rejects forced tool use (`tool_choice` `{type:'tool'}` / `{type:'any'}`)
 *   with an API error, so it is downgraded to `{type:'auto'}`. Callers that
 *   need a tool_use block must tolerate a text-only reply.
 * - always runs adaptive thinking, so `thinking: {type:'disabled'}` is
 *   dropped and a budgeted `{type:'enabled'}` becomes `{type:'adaptive'}`.
 * - only accepts `temperature: 1` (or unset), `top_p: 0.99` (or unset), never
 *   both, and no `top_k`. Anything else is stripped.
 */

type ConstrainableParams = {
  model: string
  tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean } | undefined
  thinking?: { type: string; budget_tokens?: number } | undefined
  temperature?: number | undefined
  top_p?: number | undefined
  top_k?: number | undefined
}

function modelHasRestrictedSampling(model: string): boolean {
  return isFableAtLeast(model, 5, 1)
}

export function applyModelRequestConstraints<T extends ConstrainableParams>(
  params: T,
  model: string = params.model,
): T {
  const forcedToolChoice =
    params.tool_choice?.type === 'tool' || params.tool_choice?.type === 'any'
  const restrictedSampling = modelHasRestrictedSampling(model)
  if (
    !restrictedSampling &&
    (!forcedToolChoice || modelSupportsForcedToolChoice(model))
  ) {
    return params
  }

  const out = { ...params }

  if (forcedToolChoice && !modelSupportsForcedToolChoice(model)) {
    const previous = params.tool_choice!
    out.tool_choice = {
      type: 'auto',
      ...(previous.disable_parallel_tool_use !== undefined && {
        disable_parallel_tool_use: previous.disable_parallel_tool_use,
      }),
    }
    logForDebugging(
      `[model constraints] ${model} rejects forced tool_choice ` +
        `(${previous.type}${previous.name ? `:${previous.name}` : ''}); ` +
        'downgraded to auto',
    )
  }

  if (modelRequiresAlwaysOnThinking(model)) {
    if (out.thinking?.type === 'disabled') {
      delete out.thinking
    } else if (out.thinking?.type === 'enabled') {
      out.thinking = { type: 'adaptive' }
    }
  }
  if (!modelSupportsCustomTemperature(model)) {
    if (out.temperature !== undefined && out.temperature !== 1) {
      delete out.temperature
    }
  }
  if (restrictedSampling) {
    if (out.top_p !== undefined && out.top_p !== 0.99) {
      delete out.top_p
    }
    if (out.temperature !== undefined && out.top_p !== undefined) {
      delete out.top_p
    }
    if (out.top_k !== undefined) {
      delete out.top_k
    }
  }

  return out
}
