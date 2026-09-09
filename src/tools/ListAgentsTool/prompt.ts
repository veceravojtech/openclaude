export const DESCRIPTION = 'List the agents you can message with SendMessage'

export function getPrompt(): string {
  return `List every agent you can currently address with SendMessage: teammates in your team (in-process and pane/tmux), named background agents launched with Agent(name=...), the lead of your team when you are a teammate, plus — when your team is a sub-team — the root team's lead, and the members of the sub-team you lead. That is your neighbourhood in the team tree. You are never included.

Takes no parameters.

## When to Use This Tool

- Before SendMessage, when you don't know a peer's exact name
- To check whether a teammate is idle (free for work) or busy, or whether a background agent has finished
- To confirm an agent still exists before messaging it

## Output

One line per agent: \`name  kind  status  to=<value>  - description\`

- **kind**: 'team_lead', 'teammate', or 'background_agent'
- **status**: 'idle' | 'busy' for teammates; 'running' | 'completed' | 'failed' | 'killed' for background agents; 'unknown' when not tracked
- **to**: the exact value to pass as SendMessage's \`to\` — copy it verbatim

An agent in a team is addressed as \`<name>@<team>\`, so two rows can share a name and differ only in their \`to\` (both leads are called \`team-lead\`: your own team's lead and, from inside a sub-team, the root's). A bare name in SendMessage is resolved against your own team first, then the team above yours, then the sub-team you lead — \`to\` values from this list skip that search.

Messaging a completed, failed, or killed background agent resumes it with your message.`
}
