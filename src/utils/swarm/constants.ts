export const TEAM_LEAD_NAME = 'team-lead'
export const SWARM_SESSION_NAME = 'claude-swarm'
export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'
export const TMUX_COMMAND = 'tmux'
export const HIDDEN_SESSION_NAME = 'claude-hidden'

/**
 * How long a resolved answer to "do I lead a sub-team?" is trusted before the
 * team file is read again.
 *
 * Shared by the two places that ask: the runner's idle poll loop
 * (`createSubTeamInboxResolver`, inProcessRunner.ts) and the per-tool-round
 * mid-turn drain (`resolveLedSubTeamName`, attachments.ts). The answer has to
 * be re-read at all because a sub-team may be created after the teammate
 * started; it is cached at all because a team-file read on every 500ms poll
 * and every tool round of every teammate is not worth the answer. One constant
 * so the two cannot drift apart.
 */
export const SUB_TEAM_RECHECK_INTERVAL_MS = 5_000

/**
 * How long a delivered `shutdown_request` is given to actually stop a teammate
 * before the executor escalates to a force kill.
 *
 * A shutdown request is only ever a PROMPT: the teammate's model has to notice
 * it and answer with `shutdown_response`. A model is free to ignore it, so
 * without a deadline `terminate()` is unbounded cooperation and a teammate can
 * refuse to die. One model turn — including its tool calls — is what the
 * deadline has to cover, hence a minute rather than a couple of seconds.
 *
 * NOT `TEAMMATE_GRACE_MS` (utils/task/framework): that is how long a DEAD
 * teammate keeps its UI row, which has nothing to do with how long a live one
 * may take to stop. The two must not be conflated, however close their values
 * drift.
 */
export const TEAMMATE_SHUTDOWN_DEADLINE_MS = 60_000

/** How often the shutdown deadline re-checks whether the teammate has stopped. */
export const TEAMMATE_SHUTDOWN_POLL_INTERVAL_MS = 250

/**
 * Gets the socket name for external swarm sessions (when user is not in tmux).
 * Uses a separate socket to isolate swarm operations from user's tmux sessions.
 * Includes PID to ensure multiple Claude instances don't conflict.
 */
export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}

/**
 * Environment variable to override the command used to spawn teammate instances.
 * If not set, defaults to process.execPath (the current Claude binary).
 * This allows customization for different environments or testing.
 */
export const TEAMMATE_COMMAND_ENV_VAR = 'CLAUDE_CODE_TEAMMATE_COMMAND'

/**
 * Environment variable set on spawned teammates to indicate their assigned color.
 * Used for colored output and pane identification.
 */
export const TEAMMATE_COLOR_ENV_VAR = 'CLAUDE_CODE_AGENT_COLOR'

/**
 * Environment variable set on spawned teammates to require plan mode before implementation.
 * When set to 'true', teammates must enter plan mode and get approval before writing code.
 */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'CLAUDE_CODE_PLAN_MODE_REQUIRED'
