import { isFirstPartyAnthropicBaseUrlForEnv } from './anthropicBaseUrl.js'

/**
 * Set alongside CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when OpenClaude applied
 * that switch as its own startup default, so a switch the user set can be told
 * apart from the one OpenClaude chose for them. Inherited by child processes
 * (split-pane teammates, hooks) together with the switch itself, so they make
 * the same decision.
 */
export const EXPERIMENTAL_BETAS_DEFAULTED_ENV =
  'OPENCLAUDE_EXPERIMENTAL_BETAS_DEFAULTED'

/**
 * OpenClaude's startup default: experimental API betas are off unless the user
 * configured CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS themselves (any value,
 * including an empty string, counts as configured — the same test as the `??=`
 * this replaces). Marks the default so tool search can be exempted from it.
 */
export function applyExperimentalBetasDefault(env: NodeJS.ProcessEnv): void {
  if (env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS != null) {
    return
  }
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 'true'
  env[EXPERIMENTAL_BETAS_DEFAULTED_ENV] = '1'
}

/**
 * Whether tool search is exempt from the experimental-betas kill switch.
 *
 * The default exists because, in April 2026, tool search (defer_loading and
 * tool_reference blocks) returned 500s to external accounts. Official Claude
 * Code now defers MCP tools on those accounts with the same beta headers
 * OpenClaude sends, and a live OpenClaude request against Anthropic's API
 * completed the full deferral round trip (ToolSearch -> tool_reference ->
 * deferred MCP call) at ~39k tokens per request instead of ~198k, with no API
 * error. Without deferral every MCP tool schema is sent on every request.
 *
 * Deliberately narrow:
 * - only OpenClaude's DEFAULTED switch — a switch the user set (the escape
 *   hatch for gateways that reject beta shapes) still disables tool search;
 * - only Anthropic's own API — a custom ANTHROPIC_BASE_URL and every other
 *   Anthropic-wire provider (Bedrock, Vertex, Foundry, MiniMax) keep today's
 *   behaviour, since nothing has verified tool search there;
 * - only tool search — the other betas the switch covers (context management,
 *   global cache scope, first-party-only betas) stay off by default.
 *
 * Both halves of tool search consult this: resolveToolSearchMode (whether to
 * defer) and the tool-schema stripper in api.ts (which would otherwise remove
 * defer_loading and send every deferred tool in full after all).
 */
export function isToolSearchExemptFromDefaultedBetasSwitch(
  env: NodeJS.ProcessEnv,
  provider: string,
): boolean {
  return (
    env[EXPERIMENTAL_BETAS_DEFAULTED_ENV] === '1' &&
    provider === 'firstParty' &&
    isFirstPartyAnthropicBaseUrlForEnv(env)
  )
}
