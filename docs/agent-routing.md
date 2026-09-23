# Agent Routing and Step Limits

OpenClaude can route different agents to different models, and custom agents
can cap how many tool-use steps they may execute. Both features live in
settings and agent frontmatter — no code changes required.

## Agent step limits

Custom agents can define `maxSteps` as a positive integer to cap how many
tool-use steps a sub-agent may execute. When the limit is reached, OpenClaude
stops additional tool calls and asks the sub-agent for a concise final summary
covering completed work, findings, remaining tasks, and whether another run is
needed. Omitting `maxSteps`, or setting it to an invalid value such as `0` or
malformed input, preserves the default unlimited behavior.

```markdown
---
name: bounded-researcher
description: Use for focused research with bounded tool use
maxSteps: 8
---

You are a focused research agent.
```

## Explicit teammate provider profiles

For pane/window teammates, Agent's `provider_profile` accepts a saved `/provider`
profile ID or name (ID matches take precedence). It supports native Anthropic,
OpenAI-compatible, OAuth Codex, and local profiles. The child loads the selected
profile locally; credentials and custom authentication headers are not embedded
in its launch command. This does not change the globally active profile.

The selected profile's default model is used unless the Agent call supplies an
explicit model. The binding takes precedence over inherited provider/model flags
and persisted agent routing, and survives settings refreshes. Unknown profiles
fail closed. In-process and idle teammates cannot use this binding because they
share the leader's process environment.

## Agent routing

OpenClaude can route different agents to different models through
settings-based routing. This is useful for cost optimization or splitting work
by model strength.

Add to `~/.openclaude/settings.json`:

> **Note:** `api_key` values in `settings.json` are stored in plaintext. Keep this file private and do not commit it to version control.

```json
{
  "agentModels": {
    "deepseek-v4-flash": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-your-key"
    },
    "zai-default": {
      "model": "glm-5.2",
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "sk-your-key"
    },
    "gpt-4o": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-key"
    }
  },
  "agentRouting": {
    "Explore": "deepseek-v4-flash",
    "Plan": "gpt-4o",
    "general-purpose": "gpt-4o",
    "frontend-dev": "zai-default",
    "default": "gpt-4o"
  }
}
```

When no routing match is found, the global provider remains the fallback.

`agentRouting` values and explicit Agent tool `model` overrides match keys in
`agentModels`. By default, that key is also the model string sent to the
provider. Set `agentModels.<key>.model` when you want a local route key such
as `zai-default` to call a different provider model name such as `glm-5.2`.

A matched `agentRouting` key is never silently ignored. If it names an
`agentModels` entry that does not exist, or a half-configured one (only one of
`base_url`/`api_key`, or `provider_profile` mixed with credentials), the agent
fails with an error naming the routing key and the entry, instead of quietly
running on the leader's model. This applies to every agent the key reaches:
teammates (refused before any pane is created) and in-process subagents alike.
For example:

```text
agentRouting key "reviewer" points to agentModels entry "gone", which does not exist. Add it to agentModels or remove the routing entry.
agentRouting key "Plan": agentModels entry "half-entry" has only one of base_url/api_key; both are required for cross-provider routing.
```

With no `agentRouting` at all, or no key matching the agent, nothing changes:
the agent runs on the global provider as before. An Agent tool `model` that
names a half-configured `agentModels` entry is still only warned about and
skipped, since it is not a routing instruction.

### Teammate model allowlist

Teammates (agents spawned with `name`) can only run a model from the teammate
model matrix, and only on a provider that serves it. The check uses the
resolved model (after `inherit`, aliases, routing and `provider_profile`
binding) and the provider the teammate will actually run on:

| Family | Provider → model id |
| --- | --- |
| `opus-5.5` | Anthropic / Vertex / Foundry `claude-opus-5-5`; Bedrock `us.anthropic.claude-opus-5-5-v1` |
| `fable-5.1` | Anthropic / Vertex / Foundry `claude-fable-5-1`; Bedrock `us.anthropic.claude-fable-5-1` |
| `sonnet-5` | Anthropic / Vertex / Foundry `claude-sonnet-5`; Bedrock `us.anthropic.claude-sonnet-5` |
| `glm-5.3` | Z.ai `glm-5.3`, `glm-5.3-flash`; CommandCode `z-ai/glm-5.3-flash` |
| `gpt-6` | OpenAI and Codex (OAuth) `gpt-6-astra` |
| `deepseek-v4-pro` | DeepSeek, OpenCode, OpenCode Go, HiCap `deepseek-v4-pro`; NVIDIA NIM, Atlas Cloud `deepseek-ai/deepseek-v4-pro`; Fireworks `accounts/fireworks/models/deepseek-v4-pro`; Ollama `deepseek-v4-pro:cloud`; llmtr, CommandCode `deepseek/deepseek-v4-pro`; ClinePass `cline-pass/deepseek-v4-pro` |
| `deepseek-v4.1-flash` | DeepSeek `deepseek-flash`; Fireworks `accounts/fireworks/models/deepseek-v4p1-flash` |

Aliases are resolved first, so `opus` is judged as the model it names. The
provider is the one the teammate will actually run on: a `provider_profile`
binding, then an `agentModels` cross-provider route, then the leader's own
provider. An OpenAI-compatible session counts as Codex when it uses a Codex
base URL, or has no explicit base URL and a Codex alias model such as
`gpt-6-astra` or `codexplan`; Codex's `codexplan` resolves to `gpt-5.6-sol`,
which is not in the matrix, so pin `gpt-6-astra` for Codex teammates.

A teammate that simply inherits the leader's own model and provider (no
`model`, `inherit`, or the leader's exact model, with no routing and no
profile) is always allowed, even on a custom or local model. Anything else is
refused before a pane, task or team member is created, for example:

```text
Model 'gpt-99-fake' is not allowed for teammates on provider 'deepseek'. Allowed here: deepseek-v4-pro, deepseek-flash. Configure teammateModelAllowlist to change this.
```

Narrow or disable the check with `teammateModelAllowlist`:

```json
{
  "teammateModelAllowlist": ["deepseek-v4-pro", "glm-5.3-flash"]
}
```

Entries are family keys or exact model ids from the matrix. Unset allows every
family; `["*"]` disables the check, which is the escape hatch for custom and
local models. An unknown entry is ignored with a one-time warning.

> **Note:** `/provider` changes the global/parent provider for your current
> session. `agentModels` and `agentRouting` are specifically for configuring
> per-agent provider overrides while keeping the parent session unchanged.

> **Note:** `api_key` values in `settings.json` are stored in plaintext. Keep
> this file private and do not commit it to version control.

**Model-only routes (same provider):** Omit `base_url` and `api_key` to run an
agent on a different model using your *current* provider's endpoint and key —
no credential duplication:

```json
{
  "agentModels": {
    "mini": { "model": "gpt-5-mini" }
  },
  "agentRouting": {
    "verification": "mini"
  }
}
```

**Saved-profile routes:** Use `provider_profile` when the route should use a
saved profile's native transport, OAuth, local endpoint, or custom headers.
Only the profile identity crosses into the teammate process; credentials stay
in the child's local profile store. `provider_profile` cannot be combined with
`base_url` or `api_key`.

```json
{
  "agentModels": {
    "codex-worker": { "provider_profile": "codex-oauth" },
    "deepseek-worker": {
      "provider_profile": "deepseek-saved",
      "model": "deepseek-chat"
    }
  },
  "agentRouting": {
    "reviewer": "codex-worker",
    "default": "deepseek-worker"
  }
}
```

Pane and window teammates also discover a saved profile automatically when a
requested model is explicitly listed by exactly one profile. This works across
leader providers. A configured `agentModels` entry always wins; unknown model
ids remain unchanged; multiple matching profiles produce an actionable error
so account selection is never silent. In-process subagents cannot use saved
profile routes because they share the leader process environment.

After startup, the child sends a credential-free readiness message containing
its resolved model, provider, and transport. If the first provider turn ends
with an authentication, unsupported-model, or runtime error, the child sends a
fixed failure notification even though normal Stop hooks are skipped for API
errors. The leader can therefore fail the teammate task promptly instead of
leaving it busy until the pane watchdog deadline.

**Built-in agents are routable by their type name.** Useful keys:
`verification` (the read-only auditor that runs before completion; **feature-gated**: requires `VERIFICATION_AGENT` and `tengu_hive_evidence` flag), `Explore`
and `Plan` (if feature-gated on), and `code-reviewer` (requires diff inline). For example, `"agentRouting": { "verification": "mini" }` runs the
verifier on `gpt-5-mini` while your main session stays on its model, but only when the verification gate is active. Absent
any entry, the verifier inherits the main-loop model.

### Teammate dispatch

When a teammate (or subagent) is spawned with no `model` from the call, its
agent definition, a `provider_profile` or a named `agentRouting` entry, a
dispatcher picks one from the teammate's **role**:

| Role | What it covers | Default tier |
| --- | --- | --- |
| `review` | code review, critiquing a diff | deep |
| `design` | planning, architecture, hard debugging | deep |
| `implement` | writing or modifying code, fixes | standard (deep when JEV rates it hard) |
| `verify` | tests, proving a change works, QA | standard |
| `research` | exploring, reading, finding, investigating | standard (fast when trivial) |
| `computer_use` | browser/GUI/desktop automation, screenshots, Playwright | fast, vision-capable only |

| Tier | Families, in order |
| --- | --- |
| deep | `fable-5.1`, `opus-5.5`, `gpt-6` |
| standard | `sonnet-5`, `deepseek-v4-pro`, `glm-5.3`, `gpt-5.6` (sol) |
| fast | `deepseek-v4.1-flash`, `glm-5.3` (flash), `gpt-5.6` (luna) |

When JEV is configured (`AI_GATEWAY_API_KEY`), every dispatch makes one JEV
call. It asks for the role, the complexity and whether the task needs long
context. It also asks two choice questions:

- `model`: every model this machine can spawn. That covers each catalog id on
  each configured route: the Claude ids when Anthropic is logged in, plus every
  saved profile's models, such as Z.AI, DeepSeek and Codex. The list is
  filtered by `teammateModelAllowlist` (`["*"]` keeps all of them) and by the
  organization's `availableModels`. Each option is described from catalog data:
  provider, context, price tier, vision and reasoning. The tier table below is
  sent as the preference.
- `agent_type`: the loaded agent definitions plus `default`. Built-in types are
  offered to subagents but never to teammates.

A model or agent type you pass explicitly is never asked about. A chosen
type's `model` frontmatter counts as explicit.

Hard rules are applied before the question and again to the answer. A review
or verify teammate never uses an implementer's model family, and every Claude
Sonnet version counts as one family. A `computer_use` teammate needs a vision
model. An implementer's agent type must be able to edit files, and a
`computer_use` teammate's type must be able to use a browser.

If a pick breaks a rule or fails the confidence rule (p ≥ 0.75 with a 0.15
margin), the best remaining option by probability is used, provided it passes
the same rule once the remaining options are renormalized. If none does, the
model falls back to the tier table and the type to `default`. When JEV is not
configured or fails, the role comes from a keyword heuristic and the model from
the tier table. A spawn never waits longer than the JEV timeout. Every decision
writes one debug-log line (`[teammateDispatch]`) with the model, role, type,
source, top-3 probabilities, cost, latency and every excluded model with its
reason.

When the tier table decides, the first family in the tier that is actually usable wins: it must be admitted
by `teammateModelAllowlist`, served on this machine (the leader's own route —
the Anthropic route needs Anthropic login or API key — or a saved provider
profile, which is bound to the teammate like `provider_profile`) and, for
`computer_use`, marked `supportsVision` in the model catalog. `gpt-5.6` is not
in the teammate matrix, so it is only a candidate with
`"teammateModelAllowlist": ["*"]`. If a tier has nothing usable the dispatcher
tries the lower tiers, then the higher ones; if nothing qualifies at all the
teammate spawns on the default model and the result says so.

**Separation rule.** A `review` or `verify` teammate never gets a model family
an `implement` teammate in the same team used. Each member's role and family are
recorded in the team's `config.json`; for older members with no role, every
non-review member's family is avoided. An explicit `model` that breaks the rule
is refused:

```text
Refusing to spawn review teammate 'rev' on 'claude-sonnet-5' (sonnet-5): 'dev' implemented with sonnet-5 in team 'auth-fix'. A review teammate must use a different model family than the implementer. Use one of: fable-5.1, opus-5.5, gpt-6, deepseek-v4-pro, glm-5.3, gpt-5.6, deepseek-v4.1-flash, or omit model to let the dispatcher choose.
```

Every teammate spawn result ends with the decision, and the same decision is
added to the teammate's `teammate_startup` record:

```text
dispatch: review → opus-5.5 (jev p=0.86; excluded sonnet-5 used by dev)
```

Configure it with `teammateDispatch`:

```json
{
  "teammateDispatch": {
    "mode": "auto",
    "policy": {
      "roles": { "research": "fast" },
      "tiers": { "deep": ["opus-5.5", "fable-5.1"] }
    },
    "jev": { "enabled": true, "timeoutMs": 3000, "minP": 0.75, "minMargin": 0.15 }
  }
}
```

- `mode`: `auto` (default) applies the choice; `suggest` only reports it (and
  reports, rather than refuses, a separation conflict); `off` restores the
  previous behaviour.
- `policy.roles` / `policy.tiers` override the tables above. Unknown roles,
  tiers or families log one warning and are ignored.
- `jev`: `enabled` (default `true`), `timeoutMs`, and the acceptance thresholds
  `minP` / `minMargin`.

## GitHub Copilot sub-agent optimization

When `CLAUDE_CODE_USE_GITHUB=1`, OpenClaude serializes sub-agent execution to
reduce GitHub Copilot Premium Request consumption. Default behavior is
`GITHUB_COPILOT_MAX_SUBAGENTS=1` (synchronous, one sub-agent at a time).
Tuning vars (all optional):

| Var | Effect |
|---|---|
| `GITHUB_COPILOT_MAX_SUBAGENTS=0` | Suppress sub-agents entirely (sub-agents throw an error). |
| `GITHUB_COPILOT_MAX_SUBAGENTS=1` | Force synchronous execution. **Default.** |
| `GITHUB_COPILOT_MAX_SUBAGENTS=2..10` | Parsed/clamped but not enforced differently from `=1` (any positive cap = synchronous). |
| `GITHUB_COPILOT_ALLOW_SUBAGENTS=1` | Re-enable parallel/background sub-agents, overriding the cap. |
| `GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS=1` | Force synchronous execution regardless of cap. |
| `GITHUB_COPILOT_OPTIMIZATION_DISABLED=1` | Disable all of the above; sub-agents run as before this feature. |

The `is_async` field reported in the `tengu_agent_tool_selected` event and the
agent metadata reflects the final execution mode (i.e., `false` when
synchronous is forced). See `.env.example` for the full descriptions.

For best results, use models with strong tool/function calling support.
