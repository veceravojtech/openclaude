# Cyber mode

`/cyber on` enables a session-only model policy and switches the lead to `glm-5.3`.
`/cyber off` restores its previous model override. Nothing is saved to settings.
`/cyber status` shows role assignments, active escalation scopes and Binary Ninja connectivity.

## Model policy

- Lead and background requests: GLM 5.3 (`glm-5.3`).
- Easy/standard workers: DeepSeek V4 Pro (`deepseek-v4-pro`).
- Hard/deep workers: Opus 4.6 (`claude-opus-4-6`). Complexity uses the existing dispatcher heuristic and tier signal.
- Review/verification: GLM 5.3 first. If unavailable, use Opus for DeepSeek work or DeepSeek for Opus work. Opus 4.8 and 4.6 are the same review-separation family.
- Existing worker assignments are retained when re-tasked.

Exact catalog identities and aliases are accepted, including gateway forms. Family names are resolved before enforcement; they cannot bypass the policy. GLM 5.3 Flash is not GLM 5.3. Organization `availableModels` restrictions still apply, as do teammate route availability and allowlists. If no eligible worker route exists, dispatch fails instead of silently using another model.

## Escalation

`CyberEscalate` accepts a required reason and the task/work so far. It requests a bounded Opus 4.8 second opinion and returns the answer to the original worker. `/cyber escalate` requests the same second opinion with the current conversation. Neither changes the worker's model or unlocks Opus for another request.

After normal connection/server-error retries are exhausted, a GLM request falls back once to Opus 4.8; an Opus 4.6 request falls back once to DeepSeek V4 Pro. The same request context is retried. Request-local async scope authorizes Opus only during that call and is cleaned up on completion, error or cancellation. Credentials and provider access to these models are still required.

## Tools and background work

Binary Ninja MCP schemas are loaded eagerly while cyber mode is enabled; all other tools remain available. The lead and workers are instructed to prefer Binary Ninja for binary analysis, beginning with `load_binary` and `analysis_progress`, then decompilation, xrefs, strings, types and renaming. Enabling without Binary Ninja warns once but does not prevent activation.

Titles, compaction, tool-use/agent/away summaries, web-fetch summaries and other non-foreground API queries use GLM 5.3. The small-fast selector and advisor model are also overridden. Pane/tmux children inherit `OPENCLAUDE_CYBER_MODE=1`, including provider-profile-bound children, without inheriting the lead's GLM model assignment.
