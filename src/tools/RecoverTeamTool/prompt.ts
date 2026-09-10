import { RECOVER_TEAM_TOOL_NAME } from './constants.js'

export function getPrompt(): string {
  return `
# ${RECOVER_TEAM_TOOL_NAME}

Recover a sub-team whose lead died abnormally.

A sub-team is a team one of your teammates leads (\`<your team>/<teammate name>\`). Only its lead
reads its inbox and hands out its task list, so when that teammate's run ends abnormally its
members keep working but their reports reach nobody. You are told when this happens; this tool is
how you act on it.

Actions:

- \`list\` — every sub-team below your own team, with its state (\`led\`, \`orphaned\`, \`adopted\`,
  \`respawning\`), whether its lead is actually running, its still-running members, and why the
  previous lead failed. Read-only; use it when you are not sure what needs recovering.
- \`respawn\` — bring the sub-lead back: it is resumed from its own transcript where one survives,
  and the sub-team is re-attached to it. The team goes back to working exactly as before, so
  prefer this whenever the sub-team still has work to coordinate. Pass \`prompt\` to tell the
  resumed lead what to do first; the default tells it to take stock and carry on.
- \`adopt\` — take the orphaned sub-team yourself: its members keep their own task list and keep
  working, and their reports start arriving in YOUR inbox instead of their dead lead's. Use it
  when you would rather supervise the remaining work directly than run a sub-lead. A later
  \`respawn\` still takes the team back.

\`team_name\` is the sub-team's full name, e.g. \`email/supervisor\`. You may only recover a
sub-team of the team you lead. Neither action stops, restarts or re-teams any member, and neither
removes anything: an orphaned or adopted sub-team is still cleaned up with its parent.
`.trim()
}
