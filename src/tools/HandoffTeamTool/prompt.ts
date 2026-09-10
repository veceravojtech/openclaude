import { HANDOFF_TEAM_TOOL_NAME } from './constants.js'

export function getPrompt(): string {
  return `
# ${HANDOFF_TEAM_TOOL_NAME}

Hand the sub-team you lead to a fresh successor and retire.

Use it when your own context is nearly full, or has drifted far enough that a clean start would
coordinate the remaining work better than you can. Your successor is a new run with the SAME
identity as you: it inherits your sub-team's members, its task list, its inboxes and your
assigned work, and it starts by reading the handoff notes you write here. Nothing is stopped,
deleted or reassigned — your members keep working throughout.

Only the teammate that LEADS a sub-team can call this, and only for its own sub-team: there is
no team argument, because the team is you. If you lead no sub-team there is nothing to hand
over — shut down normally instead.

Write \`synthesis\` for a reader with none of your context: what the work is, what you have
established, what you decided and why, what is settled and what is not. List what is still
outstanding in \`open_items\`. Add \`first_instruction\` when the successor should do something
specific before anything else, and \`reason\` so your lead knows why the handoff happened.

Your run ends as soon as this returns. Say everything you want your successor to know in the
input — you will not get another turn.
`.trim()
}
