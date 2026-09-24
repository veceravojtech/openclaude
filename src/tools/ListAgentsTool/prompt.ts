import { TEAM_FILE_ONLY_MARKER } from './collectAddressableAgents.js'

export const DESCRIPTION = 'List the agents you can message with SendMessage'

export function getPrompt(): string {
  return `List every agent you can currently address with SendMessage: teammates in your team (in-process and pane/tmux), named background agents launched with Agent(name=...), the lead of your team when you are a teammate, plus — when your team is a sub-team — the root team's lead, and the members of the sub-team you lead. That is your neighbourhood in the team tree. You are never included.

Takes no parameters.

## When to Use This Tool

- Before SendMessage, when you don't know a peer's exact name
- To check whether a teammate is self-idle, waiting on descendants, or busy, or whether a background agent has finished
- To confirm an agent still exists before messaging it

## Output

One line per agent: \`name  kind  status  to=<value>  [task=<id>]  [marker]  - description\`

- **kind**: 'team_lead', 'teammate', or 'background_agent'
- **status**: 'idle' | 'waiting' | 'busy' for teammates; 'running' | 'completed' | 'failed' | 'killed' for background agents; 'unknown' when not tracked. 'waiting' means self-idle with working or unconfirmed descendants. Idle and parked owners retain their objectives; neither means permission to spawn a replacement.
- **delegated**: recursive descendant activity and names; roster-only descendants are explicitly unknown, not proof of work or completion.
- **to**: the exact value to pass as SendMessage's \`to\` — copy it verbatim
- **task=**: the task id, present when a live local task backs the row. This is the id TaskStop takes; a row without it cannot be stopped from here.
- **${TEAM_FILE_ONLY_MARKER}**: the row comes from the team file on disk and nothing else. The file is written when a teammate spawns and is not corrected when one dies, so such an agent may have died at startup or may belong to another session. Its status is always 'unknown' — treat it as unconfirmed, and do not assume a reply will come.

An agent in a team is addressed as \`<name>@<team>\`, so two rows can share a name and differ only in their \`to\` (both leads are called \`team-lead\`: your own team's lead and, from inside a sub-team, the root's). A bare name in SendMessage is resolved against your own team first, then the team above yours, then the sub-team you lead — \`to\` values from this list skip that search.

Messaging a completed, failed, or killed background agent resumes it with your message.`
}
