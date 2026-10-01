import { ATTENTION_GUIDANCE } from '../../utils/attentionItemStore.js'

export const DESCRIPTION =
  'Record the one decision (retry, patch, continue or abort) for a failure that needs your attention'

export function getPrompt(): string {
  return `Record your decision on an attention item: a failure you must act on before new work can be spawned.

Attention items are created automatically when a worker run fails, a verifier's verdict is FAIL, PARTIAL or missing, or a final review finds GAPs. Every undecided item is listed in a system reminder each turn, and while any item is undecided the Agent tool (and resuming a stopped agent) refuses to spawn new work. Tasks the failed worker held are kept from being claimed by other teammates until you decide.

Each item takes exactly one decision; a second decision on the same item is rejected.

- **retry**: the failure was transient (provider error, rate limit, quota, a dead pane). Allowed only on items marked transient, and only once per worker. Releases the held tasks; spawn the worker again afterwards.
- **patch**: the input was wrong. Fix the earliest wrong input (the scope, the spec or the method you gave), then redo the work. Requires root_cause: scope, spec, method, environment or unknown. Releases the held tasks. On a final-review gap item it also re-files any GAP task that is missing.
- **continue**: accept the outcome as it is, with a reason. This is a recorded acceptance only: it does not satisfy requiresVerification or requiresFinalReview, which still need a PASS verdict or a DONE review.
- **abort**: give the work up. Cancels every linked task that is not finished (nothing is killed).

${ATTENTION_GUIDANCE} Before you retry, ask whether the same input would fail the same way; if so, patch instead.

Only the root lead can decide; teammates and subagents cannot use this tool.

Parameters:
- id: the attention item id from the reminder (e.g. "failure-<taskId>-0", "verdict-<agentId>", "gap-<agentId>")
- decision: retry | patch | continue | abort
- reason: why (required, non-empty)
- root_cause: scope | spec | method | environment | unknown (required for patch)`
}
