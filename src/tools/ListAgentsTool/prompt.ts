export const DESCRIPTION = 'List the agents you can message with SendMessage'

export function getPrompt(): string {
  return `List every agent you can currently address with SendMessage: teammates in your team (in-process and pane/tmux), named background agents launched with Agent(name=...), and the team lead when you are a teammate. You are never included.

Takes no parameters.

## When to Use This Tool

- Before SendMessage, when you don't know a peer's exact name
- To check whether a teammate is idle (free for work) or busy, or whether a background agent has finished
- To confirm an agent still exists before messaging it

## Output

One line per agent: \`name  kind  status  to=<value>  - description\`

- **kind**: 'team_lead', 'teammate', or 'background_agent'
- **status**: 'idle' | 'busy' for teammates; 'running' | 'completed' | 'failed' | 'killed' for background agents; 'unknown' when not tracked
- **to**: the exact value to pass as SendMessage's \`to\`

Messaging a completed, failed, or killed background agent resumes it with your message.`
}
