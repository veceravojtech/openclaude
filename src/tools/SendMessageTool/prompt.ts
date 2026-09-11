import { feature } from 'bun:bundle'
import { isInProcessTeammate } from '../../utils/teammateContext.js'

export const DESCRIPTION = 'Send a message to another agent'

/**
 * When a message addressed to this agent actually arrives.
 *
 * Only an in-process teammate is served mid-turn: its own tool rounds drain
 * its inbox (`getTeammateMailboxAttachments`, attachments.ts), so a message
 * that lands while it is working is handed to it at its next tool call.
 * Everyone else — a lead, a tmux/iTerm2 teammate — is served by
 * `useInboxPoller`, which queues what arrives mid-turn and submits it once the
 * agent is idle. Promising the lead mid-turn delivery told it to expect an
 * answer inside the turn it was already spending.
 *
 * The tool re-evaluates its prompt per request (`SendMessageTool.prompt()`),
 * so this is resolved from the ambient context at the moment it is rendered.
 */
function deliveryTiming(inProcessTeammate: boolean): string {
  return inProcessTeammate
    ? 'They arrive at your next tool call, or as your next turn when you have no tool call left to make — so a message sent while you are working reaches you without waiting for you to finish.'
    : 'They arrive as your next turn, once you are idle — a message sent while you are working reaches you when you finish, not inside the turn you are in.'
}

export function getPrompt(
  inProcessTeammate: boolean = isInProcessTeammate(),
): string {
  const udsRow = feature('UDS_INBOX')
    ? `\n| \`"uds:/path/to.sock"\` | Local Claude session's socket (same machine; use \`ListPeers\`) |
| \`"bridge:session_..."\` | Remote Control peer session (cross-machine; use \`ListPeers\`) |`
    : ''
  const udsSection = feature('UDS_INBOX')
    ? `\n\n## Cross-session

Use \`ListPeers\` to discover targets, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**`
    : ''
  return `
# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"researcher@email/supervisor"\` | Agent in another team of the tree — \`<name>@<team>\` |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |${udsRow}

Use \`ListAgents\` to see who is addressable right now (teammates, named background agents, and \`team-lead\` when you are a teammate) with the exact \`to\` for each.

## Addressing across teams

A teammate can lead a sub-team named \`<its team>/<its name>\`, so the same name can exist in more than one team. \`<name>@<team>\` always means that team's agent; a bare name is resolved against the rosters you can see, in order:

1. your own team,
2. the team above yours,
3. the sub-team you lead.

\`team-lead\` is the lead of YOUR team — from inside a sub-team that is your sub-lead, not the root lead. Address the root lead explicitly as \`team-lead@<root team>\`. Copy a \`to\` from \`ListAgents\` and it resolves to exactly the agent on that row.

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages addressed to you are delivered automatically; you don't check an inbox. ${deliveryTiming(inProcessTeammate)} Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.${udsSection}

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.
`.trim()
}
