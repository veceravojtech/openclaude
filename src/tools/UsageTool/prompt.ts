export const DESCRIPTION =
  'Show remaining usage limits for the active provider and every provider used this session'

export function getPrompt(): string {
  return `Report remaining usage/quota limits per provider. All data is passive: it comes from quota fields already captured on API responses this session, plus the session's own token/cost spend. The tool never polls and never fabricates numbers — any field that was not captured is reported as \`unknown\` (nothing captured yet) or \`not exposed by provider\` (the vendor declares no usage endpoint and sent no rate-limit headers).

## When to Use This Tool

- Before starting a long task, to check how much of the current quota window is left
- When a request fails or behaves like it was throttled, to see the last known limit state
- To report session spend (tokens and cost) alongside provider quotas

## Parameters

- \`provider\` (optional): case-insensitive substring filter on provider id/label (e.g. \`anthropic\`, \`codex\`, \`minimax\`, \`zai\`, or a host). Omit to report all providers.
- \`refresh\` (optional, default false): by default only already-cached data is shown. With \`refresh: true\` the tool makes one authenticated usage request for the active provider when that provider exposes one (Anthropic subscription, Codex, MiniMax). Generic OpenAI-compatible providers have no usage endpoint; for them captured rate-limit headers are the only source and refresh changes nothing.

## Output

One section per provider:

- capability: \`supported\` / \`not exposed by provider\` / \`unknown\` (no vendor metadata)
- captured quota fields with units, each stamped with its source (\`response headers\` or \`live fetch\`) and \`lastUpdated\` (ISO plus relative)
- reset times as wall-clock plus relative, when the provider reports them
- \`unknown\` or \`not exposed by provider\` wherever nothing was captured
- a session line with input/output tokens and cost in USD

Anthropic windows come from \`anthropic-ratelimit-unified-*\` response headers captured on every response; Codex and MiniMax report used-percent per plan window. GLM/Z.ai and most coding-plan backends send none of these — \`not exposed by provider\` is the correct answer for them, not a bug.`
}
