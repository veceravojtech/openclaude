import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/** Set to a truthy value to turn Agent Teams off for a session. */
export const DISABLE_AGENT_TEAMS_ENV = 'CLAUDE_CODE_DISABLE_AGENT_TEAMS'

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Agent Teams are ON by default. They can be turned off explicitly with
 * CLAUDE_CODE_DISABLE_AGENT_TEAMS=1, and the GrowthBook killswitch
 * 'tengu_amber_flint' is still respected for non-ant users.
 *
 * The former opt-ins - CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS and the
 * --agent-teams flag - are accepted and ignored so existing launch scripts
 * keep working (teammate processes are still spawned with the env var set).
 */
export function isAgentSwarmsEnabled(): boolean {
  // Explicit opt-out wins over everything, including ant builds.
  if (isEnvTruthy(process.env[DISABLE_AGENT_TEAMS_ENV])) {
    return false
  }

  // Ant: always on
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
