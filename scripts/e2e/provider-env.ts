/**
 * The environment an e2e harness hands its private tmux server, and through
 * it every CLI it starts: the harness's own environment with every ambient
 * provider selection removed.
 *
 * A harness talks to a fake Anthropic Messages API on loopback. Run from a
 * shell that is bound to a provider — an OpenClaude teammate pane, or a
 * developer with `CLAUDE_CODE_USE_OPENAI=1` / `OPENAI_MODEL` exported — the
 * CLI inherited that route instead and failed before reaching the feature
 * under test. `tmux new-session -e` only ADDS variables, and the tmux server
 * takes its global environment from the process that starts it, so the
 * strip has to happen at the spawn of the server itself.
 *
 * Removed:
 * - every `CLAUDE_CODE_USE_*` switch (the provider switches — OPENAI,
 *   GEMINI, MISTRAL, GITHUB, BEDROCK, VERTEX, FOUNDRY, ANTHROPIC — and the
 *   few feature switches sharing the prefix: a hermetic run uses defaults);
 * - provider-profile and teammate-route state (`CLAUDE_CODE_PROVIDER_*`,
 *   `OPENCLAUDE_TEAMMATE_*`);
 * - provider endpoints, keys and models (`ANTHROPIC_*`, `OPENAI_*`,
 *   `AZURE_OPENAI_*`, `GEMINI_*`, `MISTRAL_*`, `CODEX_*`, `DEEPSEEK_*`,
 *   `OLLAMA_*`, `MINIMAX_*`, `NVIDIA_*`, `GITHUB_COPILOT_*`). The harness sets
 *   the `ANTHROPIC_*` it needs (base URL, key, model) explicitly.
 */
const STRIPPED_PREFIXES = [
  'CLAUDE_CODE_USE_',
  'CLAUDE_CODE_PROVIDER_',
  'OPENCLAUDE_TEAMMATE_',
  'ANTHROPIC_',
  'OPENAI_',
  'AZURE_OPENAI_',
  'GEMINI_',
  'MISTRAL_',
  'CODEX_',
  'DEEPSEEK_',
  'OLLAMA_',
  'MINIMAX_',
  'NVIDIA_',
  'GITHUB_COPILOT_',
] as const

/** Whether `name` selects or configures a model provider. */
export function isProviderEnvVar(name: string): boolean {
  return STRIPPED_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** `env` without any provider selection, as a plain string map. */
export function providerFreeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isProviderEnvVar(name)) continue
    out[name] = value
  }
  return out
}

/** The model the fake Messages API is addressed with; it answers any. */
export const E2E_FAKE_MODEL = 'claude-sonnet-4-5'
