/**
 * Where a SendMessage `to` lands, and how a listable address is spelled.
 *
 * One team is a flat roster, but a teammate can lead a sub-team named
 * `<its team>/<its name>`, so a name alone stopped being unique across the
 * tree. The address form is the one agent ids already use — `name@team`
 * (`formatAgentId`) — and a `to` of that shape addresses that team's inbox
 * directly, wherever in the tree the sender sits.
 *
 * A bare name still works, and resolves against the rosters the sender can
 * see: its own team first, then the team above it, then the sub-team it
 * leads. `team-lead` is deliberately not searched that way — it names the
 * lead of the sender's OWN team, which for a member of a sub-team is its
 * sub-lead, not the root. `team-lead@<root>` is how the root lead is reached
 * from down there.
 *
 * This module is the whole addressing contract: SendMessage resolves through
 * `resolveRecipient`, and ListAgents spells every row's `to` with
 * `formatRecipientAddress`, so a listed row is by construction a `to` that
 * resolves back to the agent it names.
 */

import { formatAgentId, parseAgentId } from '../../utils/agentId.js'
import type { CallerIdentity } from '../../utils/agentIdentity.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  getParentTeamName,
  readSubTeamLedBy,
  readTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'

/** Which rule placed a recipient in a team. */
export type RecipientResolution =
  /** `to` was `name@team`: that team, no search. */
  | 'qualified'
  /** `team-lead`: the lead of the sender's own team. */
  | 'team-lead'
  | 'own-team'
  | 'parent-team'
  | 'sub-team'
  /** No roster claims the name — delivered to the sender's own team. */
  | 'unplaced'

export type ResolvedRecipient = {
  /** Mailbox owner, as `writeToMailbox` wants it (never pre-sanitized). */
  recipientName: string
  /** Team whose inboxes hold it; undefined outside any team. */
  teamName: string | undefined
  via: RecipientResolution
}

/**
 * The `to` that addresses `name` in `teamName`.
 *
 * Teamless agents — named background subagents — keep their bare name: they
 * are resolved through the agent-name registry, not through a roster.
 */
export function formatRecipientAddress(
  name: string,
  teamName: string | undefined,
): string {
  return teamName ? formatAgentId(name, teamName) : name
}

/**
 * The team the caller itself belongs to.
 *
 * A teammate's identity is `name@team`, so its own team is in its id. A
 * subagent's id carries no team, so it inherits the team of the teammate it
 * was spawned inside. Everything else — the lead, a subagent of the lead — is
 * placed by the session's own team context.
 */
export function resolveCallerTeamName(
  caller: Pick<CallerIdentity, 'agentId' | 'spawnerAgentId'>,
  sessionTeamName: string | undefined,
): string | undefined {
  const own = caller.agentId ? parseAgentId(caller.agentId) : null
  if (own?.teamName) return own.teamName
  const spawner = caller.spawnerAgentId
    ? parseAgentId(caller.spawnerAgentId)
    : null
  if (spawner?.teamName) return spawner.teamName
  return sessionTeamName
}

/**
 * The root of the tree a team hangs in: `email/supervisor` roots at `email`,
 * a root team is its own root.
 */
export function getRootTeamName(teamName: string): string {
  let current = teamName
  for (
    let parent = getParentTeamName(current);
    parent !== undefined;
    parent = getParentTeamName(current)
  ) {
    current = parent
  }
  return current
}

/** Whether a roster holds this name (rosters are case-insensitive on names). */
async function teamHasMember(
  teamName: string,
  name: string,
): Promise<boolean> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) return false
  return teamFile.members.some(
    member => member.name.toLowerCase() === name.toLowerCase(),
  )
}

/**
 * Resolve a SendMessage `to` to the mailbox it names.
 *
 * `caller` comes from `resolveCallerIdentity()` — never from an ambient
 * identity read — and `sessionTeamName` is the team of the session the tool
 * call runs in, which is what places a lead and its subagents.
 */
export async function resolveRecipient(
  to: string,
  caller: CallerIdentity,
  sessionTeamName: string | undefined,
): Promise<ResolvedRecipient> {
  const qualified = parseAgentId(to)
  if (qualified && qualified.agentName && qualified.teamName) {
    return {
      recipientName: qualified.agentName,
      teamName: qualified.teamName,
      via: 'qualified',
    }
  }

  const ownTeam = resolveCallerTeamName(caller, sessionTeamName)

  // The lead of the sender's own team, not of the tree: a member of
  // `email/supervisor` that says `team-lead` means its sub-lead.
  if (to === TEAM_LEAD_NAME) {
    return { recipientName: to, teamName: ownTeam, via: 'team-lead' }
  }

  if (ownTeam) {
    if (await teamHasMember(ownTeam, to)) {
      return { recipientName: to, teamName: ownTeam, via: 'own-team' }
    }
    const parentTeam = getParentTeamName(ownTeam)
    if (parentTeam && (await teamHasMember(parentTeam, to))) {
      return { recipientName: to, teamName: parentTeam, via: 'parent-team' }
    }
  }

  // Only a teammate leads a sub-team; `readSubTeamLedBy` also proves the team
  // file on disk really is this caller's, not a root team that sanitizes to
  // the same directory.
  const subTeam = await readSubTeamLedBy(caller)
  if (
    subTeam?.members.some(
      member => member.name.toLowerCase() === to.toLowerCase(),
    )
  ) {
    return { recipientName: to, teamName: subTeam.name, via: 'sub-team' }
  }

  // Nothing claims the name: keep today's behaviour and write it into the
  // sender's own team, where a roster-less recipient (a name the team file
  // has not caught up with) still receives it.
  return { recipientName: to, teamName: ownTeam, via: 'unplaced' }
}
