/**
 * Shared utilities for spawning teammates across different backends.
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * Gets the command to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise falls back to the
 * current process executable path.
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (permissionMode === 'fullAccess') {
    flags.push('--permission-mode fullAccess')
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Splits a flag string into shell tokens, keeping each token's ORIGINAL text
 * (quotes and escapes intact) so the tokens can be re-joined unchanged.
 *
 * Splitting on `' '` is not good enough here. These flags are built with
 * `quote()` (shell-quote), which emits four different shapes depending on the
 * value: bare `plain-model`, backslash-escaped `claude-opus-5\[1m\]`,
 * single-quoted `'my custom model'`, and double-quoted `"it's"`. Two of those
 * can contain spaces, so a space-split tears the value apart: dropping only
 * the first fragment left the remainder, plus an unbalanced quote, spliced
 * into the spawn command.
 */
function splitShellTokens(flags: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quoteChar: "'" | '"' | null = null

  for (let i = 0; i < flags.length; i++) {
    const char = flags[i]!
    // Backslash escapes the next character everywhere except inside single
    // quotes, matching bash — and matching what quote() assumes when it emits
    // an escaped form.
    if (char === '\\' && quoteChar !== "'") {
      current += char + (flags[i + 1] ?? '')
      i++
      started = true
      continue
    }
    if (quoteChar) {
      current += char
      if (char === quoteChar) {
        quoteChar = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quoteChar = char
      current += char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

/**
 * Removes every `--model <value>` pair from a flag string, where `<value>` is
 * one whole shell token however it happens to be quoted.
 */
function stripModelFlag(flags: string): string {
  const tokens = splitShellTokens(flags)
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--model') {
      // Drop the flag AND the value token that follows it.
      i++
      continue
    }
    // `--model=value` is not a shape buildInheritedCliFlags emits, but a
    // survivor of that form would reintroduce the exact bug this strip exists
    // to prevent, so it goes too.
    if (token.startsWith('--model=')) {
      continue
    }
    kept.push(token)
  }
  return kept.join(' ')
}

/**
 * Settle the `--model` flag of a pane/window teammate's spawn command.
 *
 * Three outcomes, in precedence order:
 *
 * 1. `model` given → it replaces any inherited `--model` (the leader's own
 *    `--model` override is not the teammate's model).
 * 2. no `model`, but a provider-profile binding that carries `OPENAI_MODEL` →
 *    NO `--model` at all, including the inherited one. The child resolves its
 *    model from `OPENAI_MODEL`, which is the whole point of the binding: a
 *    `--model` on the command line wins over the env var, so leaving one there
 *    sent the leader's Anthropic model to a Codex/ChatGPT backend and the
 *    child died on its first request with `400 ... model is not supported when
 *    using Codex with a ChatGPT account`. Stripping the INHERITED flag matters
 *    as much as not adding one: a leader started with `--model` propagates it
 *    through buildInheritedCliFlags and would reintroduce the same failure.
 * 3. neither → flags pass through untouched.
 */
export function applyTeammateModelFlag(
  inheritedFlags: string,
  options: {
    /** The teammate's resolved model, or undefined to let the binding decide. */
    model?: string
    /** Provider-profile env for this spawn (AgentTool's provider_profile). */
    providerEnv?: Record<string, string>
  },
): string {
  const { model, providerEnv } = options
  if (providerEnv?.OPENCLAUDE_TEAMMATE_PROFILE_ID) {
    const tokens = splitShellTokens(stripModelFlag(inheritedFlags))
    const kept: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token === '--provider' || token === '--provider-env-file') { i++; continue }
      if (token.startsWith('--provider=') || token.startsWith('--provider-env-file=')) continue
      kept.push(token)
    }
    const effectiveModel = model ?? providerEnv.OPENCLAUDE_TEAMMATE_MODEL
    if (effectiveModel) kept.push(`--model ${quote([effectiveModel])}`)
    return kept.join(' ')
  }
  if (model) {
    const stripped = stripModelFlag(inheritedFlags)
    return stripped ? `${stripped} --model ${quote([model])}` : `--model ${quote([model])}`
  }
  if (providerEnv?.OPENAI_MODEL) {
    return stripModelFlag(inheritedFlags)
  }
  return inheritedFlags
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'MISTRAL_MODEL',
  'MISTRAL_BASE_URL',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  // Config directory override (preferred name + legacy alias)
  'OPENCLAUDE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Source builds may rely on user shell PATH for rg/node/bun and other tools.
  // Forward it so teammates resolve the same toolchain as the parent session.
  'PATH',
] as const

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 *
 * @param extra - Per-spawn env vars for this teammate only. The allowlist above
 *   can only forward the parent's values, so a teammate pinned to a different
 *   provider than the leader needs its route passed in here. Entries are
 *   appended after the inherited ones, and `env` applies assignments left to
 *   right, so a key given here overrides the inherited value of the same key.
 *   Empty values are skipped, matching the inherited-var guard.
 */
export function buildInheritedEnvVars(extra?: Record<string, string>): string {
  if (extra?.OPENCLAUDE_TEAMMATE_PROFILE_ID) {
    const values: Record<string, string> = {
      CLAUDECODE: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      OPENCLAUDE_TEAMMATE_PROFILE_ID: extra.OPENCLAUDE_TEAMMATE_PROFILE_ID,
      OPENCLAUDE_TEAMMATE_MODEL: extra.OPENCLAUDE_TEAMMATE_MODEL ?? '',
    }
    for (const key of ['OPENCLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'PATH', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR']) {
      if (process.env[key]) values[key] = process.env[key]!
    }
    return Object.entries(values).map(([key, value]) => `${key}=${quote([value])}`).join(' ')
  }
  const envVars = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    // Teammates should inherit the leader-selected provider route instead of
    // replaying persisted ~/.claude or settings.env provider defaults.
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1',
  ]

  for (const key of TEAMMATE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  // Appended last on purpose: `env` applies assignments left to right, so a
  // per-spawn value here wins over the inherited one for the same key.
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}
