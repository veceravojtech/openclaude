import type { SetAppState } from '../../../Task.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { enqueueAgentNotification } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { logForDebugging } from '../../debug.js'
import {
  TEAMMATE_GRACE_MS,
  updateTaskState,
} from '../../task/framework.js'
import {
  readMailbox,
  isIdleNotification,
  isTeammateStartupNotification,
} from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import {
  readTeamFileAsync,
  recordMemberTmuxSocket,
  removeTeammateFromTeamFile,
} from '../teamHelpers.js'
import { retireTeammateFromLeaderView } from '../teammateRetirement.js'
import { unassignTeammateTasks } from '../../tasks.js'
import { getBackendByType } from './registry.js'
import {
  isPaneBackend,
  type BackendType,
  type PaneLiveness,
  type PanePresence,
} from './types.js'

/**
 * First-contact + absence-of-progress watchdog for out-of-process (pane)
 * teammates.
 *
 * WHY THIS EXISTS. A pane teammate's task is registered with a hardcoded
 * status:'running' and nothing in the leader's process ever transitions it:
 * the terminal transitions live in inProcessRunner, which pane teammates do
 * have. The child DOES report — its Stop hook (teammateInit) writes an idle
 * notification to the lead's mailbox at the end of every turn — EXCEPT when
 * the turn ends in an API error, where query.ts deliberately skips Stop hooks
 * (error → hook blocking → retry → error death spiral). So the exact spawn
 * most likely to need reporting (a model route that does not resolve) is the
 * one that reports nothing: the child dies on its first turn, the pane's
 * shell keeps the pane alive, and the task row says 'running' forever.
 *
 * THE MECHANISM is absence of progress, not cause. A hung teammate is ALIVE
 * — an idle REPL is a live process with the foreground — so no liveness
 * probe can catch the incident. What distinguishes a healthy child from the
 * incident is that a healthy child eventually WRITES to the lead's mailbox
 * (idle notification, permission request, or DM) and marks itself active in
 * the team file at turn start. The watchdog arms at spawn and fails the task
 * when those signals fail to arrive:
 *
 * - FIRST-CONTACT deadline: neither the team-file isActive:true turn-start
 *   write nor any mailbox message has been seen. The child never started
 *   working (instant crash, bad flag, pane never got the command).
 * - PROGRESS deadline: the child started but has been silent ever since —
 *   the incident signature. Any mailbox message from the teammate (including
 *   permission requests and DMs, which active teammates emit constantly)
 *   re-anchors this deadline, so a long but genuinely working first turn
 *   does not trip it.
 *
 * The landed `isPaneAlive?` probe is consulted ONLY after a deadline has
 * already expired, to pick the error message: a dead pane is reported as a
 * pane exit, an alive pane as unresponsive. 'unknown' is never treated as
 * death — it defers the failure through a bounded retry budget so one tmux
 * hiccup cannot fail every teammate at once. Note the primary signal is
 * filesystem-based (mailboxes are files), so a leader whose tmux is entirely
 * unreachable still sees completions and still arms the no-progress failure.
 *
 * SUCCESS is reported too: the idle notification that disarms the failure
 * watchdog also transitions the task to completed and enqueues the
 * task-notification, so a healthy pane teammate's task stops saying 'running'
 * the moment its first turn ends. `idleReason: 'parked'` (account-wide usage
 * limit) is proof of life, not completion: the failure deadlines stand down
 * while the teammate waits out the window, because a parked teammate is
 * alive and resumable.
 *
 * All boundaries are injectable for tests: clock, mailbox, team file, pane
 * probe and timers.
 */

/** Environment override for the first-contact deadline, in milliseconds. */
export const PANE_TEAMMATE_FIRST_CONTACT_TIMEOUT_ENV =
  'OPENCLAUDE_PANE_TEAMMATE_FIRST_CONTACT_TIMEOUT_MS'

/** Environment override for the progress deadline, in milliseconds. */
export const PANE_TEAMMATE_PROGRESS_TIMEOUT_ENV =
  'OPENCLAUDE_PANE_TEAMMATE_PROGRESS_TIMEOUT_MS'

/**
 * How long a pane child has to show its first sign of life: the team-file
 * `isActive: true` write its first `onQuery` fires (REPL.tsx, before any API
 * call) or any message in the lead's mailbox. Generous on purpose — it has to
 * cover node boot, MCP server startup and the first 1s mailbox poll.
 */
export const PANE_TEAMMATE_FIRST_CONTACT_TIMEOUT_MS = 180_000

/**
 * How long a pane child that HAS started may stay silent before the task is
 * failed: no idle notification, no permission request, no DM — nothing in
 * the lead's mailbox. Active teammates emit these constantly, so this is the
 * "started, then went permanently silent" signature of the original incident
 * (API error on the first turn, Stop hooks skipped, child back at its prompt
 * forever). Re-anchored by every signal.
 *
 * 30 minutes because a healthy teammate's FIRST turn routinely runs tens of
 * minutes — the idle notification that disarms this deadline only comes at
 * END of turn, so until then a merely-slow child is indistinguishable from a
 * hung one. Sizing this below the normal workload fails working teammates:
 * the inverse bug of the silent hang this watchdog exists to fix, and
 * noisier. A spurious failure is an accepted, bounded cost because a late
 * real completion WINS: the watchdog keeps watching a task it failed itself,
 * and the arriving idle notification flips it to completed and emits the
 * completion — one spurious failure notification is the price of the
 * self-correction. Env-tunable for workloads with known-longer silent turns.
 */
export const PANE_TEAMMATE_PROGRESS_TIMEOUT_MS = 1_800_000

/** How often the watchdog scans the lead's mailbox and deadlines. */
export const PANE_TEAMMATE_WATCHDOG_SCAN_INTERVAL_MS = 5_000

/**
 * Consecutive scans that must confirm a roster member's pane is GONE before
 * the ghost sweep retires it.
 *
 * Two, at the 5s cadence above, is the whole guard: roughly 5-10s of a pane
 * reading dead. It has to be short because the point of the sweep is that the
 * roster stops lying about a pane a human already killed, and the acceptance
 * for this step is removal within one scan cycle of the kill. It must not be
 * zero because a pane legitimately reads dead mid-lifecycle: a teammate pane
 * runs a shell with the CLI typed into it, so between that CLI exiting and a
 * respawn typing a new one in, the foreground command IS a shell — one scan
 * of 'dead' is ordinary churn, two consecutive ones are a pane nobody is
 * coming back to. A time-based grace instead of a count would either exceed
 * the acceptance window or be too short to mean anything; a count is also
 * deterministic to test.
 */
export const PANE_TEAMMATE_GHOST_SWEEP_SCANS = 2

/** Spacing between pane-probe retries while the probe answers 'unknown'. */
export const PANE_TEAMMATE_UNKNOWN_RETRY_DELAY_MS = 30_000

/**
 * How many times an expired deadline re-probes an 'unknown' pane before the
 * failure fires anyway (with the no-progress message — never a pane-exit
 * claim). Bounded so a leader whose tmux stays unreachable still gets the
 * failure; small so a transient hiccup cannot cause it.
 */
export const PANE_TEAMMATE_MAX_UNKNOWN_RETRIES = 3

/**
 * Slack when deciding whether a mailbox message predates the spawn. Clocks
 * are the same machine, but the child's first write can race the leader's
 * spawn timestamp at millisecond granularity.
 */
const TIMESTAMP_SLACK_MS = 1_000

/** Mailbox message shape the watchdog needs. Subset of TeammateMessage. */
export type PaneWatchdogMailboxMessage = {
  from: string
  text: string
  timestamp?: string
}

/** Team-file shape the watchdog needs. Subset of TeamFile. */
export type PaneWatchdogTeamFile = {
  leadAgentId?: string
  /** Session that owns this team; a sweep must never touch another session's. */
  leadSessionId?: string
  members?: Array<{
    name: string
    agentId?: string
    isActive?: boolean
    /** Present on pane-backed members: needed by the ghost sweep. */
    backendType?: BackendType
    tmuxPaneId?: string
    /** tmux socket the pane was spawned on; absent on legacy rows. */
    tmuxSocket?: string
  }>
}

/** Test seams. Every boundary of the watchdog, overridable per arm. */
export type PaneTeammateWatchdogDeps = {
  now?: () => number
  /** The session id to attribute this watchdog's sweep to. */
  currentSessionId?: string
  readLeadMailbox?: (
    leadName: string,
    teamName: string,
  ) => Promise<PaneWatchdogMailboxMessage[]>
  readTeamFile?: (teamName: string) => Promise<PaneWatchdogTeamFile | null>
  probePane?: () => Promise<PaneLiveness>
  /** Probe for any pane of the team, used by the ghost sweep. */
  probeMemberPane?: (
    backendType: BackendType,
    paneId: string,
    socketName?: string,
  ) => Promise<PaneLiveness>
  /**
   * Pane presence probe for the ghost sweep: absent/present/unknown. Distinct
   * from `probeMemberPane` — the sweep must delete a record only for an
   * ABSENT pane, never a pane that merely has a shell in the foreground.
   */
  probeMemberPanePresence?: (
    backendType: BackendType,
    paneId: string,
    socketName?: string,
  ) => Promise<PanePresence>
  /** Enumerate reachable tmux socket names (for discovery-backfill). */
  discoverReachableSockets?: () => Promise<string[]>
  /** Record a discovered socket on a roster member (the backfill write). */
  recordMemberSocket?: (
    teamName: string,
    agentId: string,
    socketName: string,
  ) => boolean
  /** Remove a member from the team file (the ghost sweep's roster edit). */
  removeMemberFromTeamFile?: (
    teamName: string,
    member: { agentId: string },
  ) => boolean
  /** Unassign a swept teammate's open tasks; returns the lead-facing notice. */
  unassignMemberTasks?: (
    teamName: string,
    member: { agentId: string; name: string },
  ) => Promise<string>
  /** null disables the interval — tests drive scan() manually. */
  scanIntervalMs?: number | null
  firstContactTimeoutMs?: number
  progressTimeoutMs?: number
  unknownRetryDelayMs?: number
  maxUnknownRetries?: number
}

export type PaneTeammateWatchdogHandle = {
  /** One polling step. Safe to call after dispose (no-op). */
  scan(): Promise<void>
  /** Disarm: stop the interval, ignore every future signal. */
  dispose(): void
  readonly disposed: boolean
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// ---------------------------------------------------------------------------
// Team-scoped ghost sweeper.
//
// The sweep that reconciles the roster with pane reality must outlive any
// single teammate's watchdog: a teammate that self-reports a failed turn
// disposes its own watchdog inside the same scan (idleReason 'failed' →
// dispose()), so a sweep owned by that watchdog would stop exactly when it is
// most needed — the sole pane teammate of a team would never be reconciled. A
// module-level Map arms exactly one sweeper per team, lazily, beside the
// per-teammate watchdog; it runs its own interval and self-disposes once the
// team file is gone (teardown: nothing left to mutate).
// ---------------------------------------------------------------------------

type SweepDeps = {
  teamName: string
  currentSessionId: string
  readTeamFile: (teamName: string) => Promise<PaneWatchdogTeamFile | null>
  probeMemberPanePresence: (
    backendType: BackendType,
    paneId: string,
    socketName?: string,
  ) => Promise<PanePresence>
  discoverReachableSockets: () => Promise<string[]>
  recordMemberSocket: (
    teamName: string,
    agentId: string,
    socketName: string,
  ) => boolean
  removeMember: (teamName: string, member: { agentId: string }) => boolean
  unassignMemberTasks: (
    teamName: string,
    member: { agentId: string; name: string },
  ) => Promise<string>
  setAppState: SetAppState
  now: () => number
  /**
   * True once the owning sweeper has been disposed. Re-checked immediately
   * before every mutation, because a scan awaits many probes and a dispose()
   * landing mid-pass must stop the in-flight scan from writing.
   */
  isDisposed: () => boolean
}

/**
 * Discovery-backfill: resolve the socket a socket-less tmux member's pane
 * lives on, on positive proof only.
 *
 * - exactly one reachable server owns the pane → record it, return 'present'
 * - anything else — enumeration failed, a server failed to answer, more than
 *   one owner, or no owner at all — is 'unknown'. Discovery can prove
 *   ownership but can never prove non-existence over a socket space it does
 *   not fully see (a custom `-S` path, or a `TMUX_TMPDIR` elsewhere), so a
 *   pane that lives on a server outside the enumerated directory must never
 *   be mistaken for a dead one.
 */
async function resolveMemberSocket(
  deps: SweepDeps,
  member: { agentId: string; backendType: BackendType; tmuxPaneId: string },
): Promise<PanePresence> {
  let sockets: string[]
  try {
    sockets = await deps.discoverReachableSockets()
  } catch {
    return 'unknown'
  }

  const owners: string[] = []
  for (const socket of sockets) {
    const presence = await deps.probeMemberPanePresence(
      member.backendType,
      member.tmuxPaneId,
      socket,
    )
    if (presence === 'unknown') {
      // A socket whose server did not answer leaves the set incomplete.
      return 'unknown'
    }
    if (presence === 'present') {
      owners.push(socket)
    }
  }

  if (owners.length === 1) {
    if (deps.isDisposed()) return 'unknown'
    deps.recordMemberSocket(deps.teamName, member.agentId, owners[0]!)
    // The pane exists on exactly one server: present, so not a sweep target.
    return 'present'
  }
  if (owners.length > 1) {
    return 'unknown'
  }
  // No enumerated server owns it. Discovery cannot prove non-existence over a
  // space it does not fully see (a custom `-S` path, or a `TMUX_TMPDIR`
  // elsewhere), so the verdict is 'unknown', never 'absent' — an enumerable
  // socket set that all disclaim the pane is not evidence the pane is gone.
  return 'unknown'
}

/** One sweep of the roster: retire members whose pane is confirmed absent. */
async function sweepRosterOnce(
  deps: SweepDeps,
  absentPaneScans: Map<string, { paneId: string; count: number }>,
): Promise<void> {
  const teamFile = await deps.readTeamFile(deps.teamName)
  const members = teamFile?.members
  if (!members) return

  // Team files are shared across sessions; only the session that owns this
  // team may reap or backfill its members. `leadSessionId` is the same field
  // resolveStoppableTask uses to refuse cross-session stops. An absent value
  // (a legacy file predating the field) is unprovable ownership — the same
  // class of doubt as an unrecorded socket — so it is neither swept nor
  // backfilled: never destroy without proof.
  if (teamFile.leadSessionId !== deps.currentSessionId) {
    return
  }

  const rosterIds = new Set<string>()
  for (const member of members) {
    if (!member.agentId) continue
    if (member.name === TEAM_LEAD_NAME) continue
    rosterIds.add(member.agentId)

    const backendType = member.backendType
    const tmuxPaneId = member.tmuxPaneId
    if (!backendType || !isPaneBackend(backendType) || !tmuxPaneId) {
      // Not a sweep candidate — an in-process member or a row with no pane.
      absentPaneScans.delete(member.agentId)
      continue
    }

    let presence: PanePresence
    if (!member.tmuxSocket && backendType === 'tmux') {
      presence = await resolveMemberSocket(deps, {
        agentId: member.agentId,
        backendType,
        tmuxPaneId,
      })
    } else {
      presence = await deps.probeMemberPanePresence(
        backendType,
        tmuxPaneId,
        member.tmuxSocket,
      )
    }

    if (presence !== 'absent') {
      absentPaneScans.delete(member.agentId)
      continue
    }

    const seen = absentPaneScans.get(member.agentId)
    const count = seen?.paneId === tmuxPaneId ? seen.count + 1 : 1
    if (count < PANE_TEAMMATE_GHOST_SWEEP_SCANS) {
      absentPaneScans.set(member.agentId, { paneId: tmuxPaneId, count })
      continue
    }
    absentPaneScans.delete(member.agentId)

    // Dispose landed while the probes above were awaiting: the sweeper is
    // gone, so its in-flight scan must not mutate the roster.
    if (deps.isDisposed()) return

    const swept = { agentId: member.agentId, name: member.name }
    // Roster first, by agentId ONLY — removeTeammateFromTeamFile's name match
    // is an OR, and a respawned member reusing the ghost's name must survive.
    if (!deps.removeMember(deps.teamName, { agentId: member.agentId })) continue
    const notificationMessage = await deps.unassignMemberTasks(
      deps.teamName,
      swept,
    )
    retireTeammateFromLeaderView({
      teammateId: swept.agentId,
      notificationMessage,
      setAppState: deps.setAppState,
      now: deps.now,
    })
    logForDebugging(
      `[PaneWatchdog] swept ghost member ${swept.agentId} (pane ${tmuxPaneId} confirmed absent on ${count} consecutive scans)`,
    )
  }

  // Drop counts for members that have left the roster entirely.
  for (const key of absentPaneScans.keys()) {
    if (!rosterIds.has(key)) {
      absentPaneScans.delete(key)
    }
  }
}

export type TeamSweeperHandle = {
  scan(): Promise<void>
  dispose(): void
  readonly disposed: boolean
}

const teamSweepers = new Map<string, TeamSweeperHandle>()

/**
 * Arm (idempotently) the team-scoped ghost sweeper for `teamName`. Exactly one
 * sweeper runs per team; subsequent calls return the existing handle.
 */
export function ensureTeamSweeper({
  teamName,
  currentSessionId,
  setAppState,
  deps,
}: {
  teamName: string
  currentSessionId: string
  setAppState: SetAppState
  deps?: PaneTeammateWatchdogDeps
}): TeamSweeperHandle {
  const existing = teamSweepers.get(teamName)
  if (existing) return existing

  const now = deps?.now ?? Date.now
  const readTeamFile = deps?.readTeamFile ?? readTeamFileAsync
  const probeMemberPanePresence =
    deps?.probeMemberPanePresence ??
    (async (
      memberBackend: BackendType,
      memberPane: string,
      memberSocket?: string,
    ) => {
      if (!isPaneBackend(memberBackend)) {
        return 'unknown' satisfies PanePresence
      }
      try {
        const backend = getBackendByType(memberBackend)
        if (backend?.isPanePresentOnSocket) {
          return await backend.isPanePresentOnSocket(memberPane, memberSocket)
        }
        if (backend?.isPaneAlive) {
          const liveness = await backend.isPaneAlive(memberPane)
          if (liveness === 'dead') return 'absent' satisfies PanePresence
          if (liveness === 'alive') return 'present' satisfies PanePresence
        }
      } catch {
        // Fail open: no evidence of absence.
      }
      return 'unknown' satisfies PanePresence
    })
  const discoverReachableSockets =
    deps?.discoverReachableSockets ??
    (async () => {
      const { discoverTmuxSockets } = await import('./detection.js')
      return discoverTmuxSockets()
    })
  const recordMemberSocket =
    deps?.recordMemberSocket ??
    ((team: string, agentId: string, socketName: string) =>
      recordMemberTmuxSocket(team, agentId, socketName))
  const removeMember =
    deps?.removeMemberFromTeamFile ??
    ((team: string, member: { agentId: string }) =>
      removeTeammateFromTeamFile(team, member))
  const unassignMemberTasks =
    deps?.unassignMemberTasks ??
    (async (team: string, member: { agentId: string; name: string }) => {
      const { notificationMessage } = await unassignTeammateTasks(
        team,
        member.agentId,
        member.name,
        'shutdown',
      )
      return notificationMessage
    })
  const scanInterval =
    deps?.scanIntervalMs === undefined
      ? PANE_TEAMMATE_WATCHDOG_SCAN_INTERVAL_MS
      : deps.scanIntervalMs

  const absentPaneScans = new Map<string, { paneId: string; count: number }>()
  let disposed = false
  // Re-entrancy guard: the interval fires whether or not the previous scan
  // finished, and overlapping scans share `absentPaneScans` across their
  // awaits — collapsing the two-scan debounce. Skip the tick rather than
  // queueing.
  let scanning = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sweepDeps: SweepDeps = {
    teamName,
    currentSessionId,
    readTeamFile,
    probeMemberPanePresence,
    discoverReachableSockets,
    recordMemberSocket,
    removeMember,
    unassignMemberTasks,
    setAppState,
    now,
    isDisposed: () => disposed,
  }

  async function scan(): Promise<void> {
    if (disposed || scanning) return
    scanning = true
    try {
      // Teardown guard: once the team file is gone there is nothing to mutate,
      // so the sweeper retires itself.
      const teamFile = await readTeamFile(teamName)
      if (!teamFile?.members) {
        dispose()
        return
      }
      await sweepRosterOnce(sweepDeps, absentPaneScans)
    } finally {
      scanning = false
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    teamSweepers.delete(teamName)
  }

  if (scanInterval !== null) {
    timer = setInterval(() => {
      void scan().catch(error => {
        logForDebugging(
          `[PaneWatchdog] team sweep for ${teamName} failed: ${String(error)}`,
        )
      })
    }, scanInterval)
    // Never hold the event loop open for a sweeper.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const handle: TeamSweeperHandle = {
    scan,
    dispose,
    get disposed() {
      return disposed
    },
  }
  teamSweepers.set(teamName, handle)
  return handle
}

/** The team sweeper currently armed for `teamName`, if any (test seam). */
export function getTeamSweeper(teamName: string): TeamSweeperHandle | undefined {
  return teamSweepers.get(teamName)
}

/**
 * Arm the watchdog for one out-of-process teammate task.
 *
 * Called from registerOutOfProcessTeammateTask right after the task is
 * registered. Returns the handle so tests can drive scans deterministically;
 * production callers ignore it.
 */
export function armPaneTeammateWatchdog({
  taskId,
  description,
  teammateName,
  teamName,
  paneId,
  tmuxSocket,
  backendType,
  toolUseId,
  setAppState,
  signal,
  deps,
}: {
  taskId: string
  description: string
  teammateName: string
  teamName: string
  paneId: string
  tmuxSocket?: string
  backendType: BackendType
  toolUseId?: string
  setAppState: SetAppState
  signal?: AbortSignal
  deps?: PaneTeammateWatchdogDeps
}): PaneTeammateWatchdogHandle {
  const now = deps?.now ?? Date.now
  const currentSessionId = deps?.currentSessionId ?? getSessionId()
  const readLeadMailbox =
    deps?.readLeadMailbox ?? ((lead, team) => readMailbox(lead, team))
  const readTeamFile = deps?.readTeamFile ?? readTeamFileAsync
  /**
   * The landed liveness probe, for ANY pane of the team — this watchdog's own
   * and, for the ghost sweep, its teammates'. 'unknown' covers both a backend
   * that cannot answer and a non-pane backend: no evidence either way, and the
   * sweep only acts on positive evidence of death.
   */
  const probeMemberPane =
    deps?.probeMemberPane ??
    (async (
      memberBackend: BackendType,
      memberPane: string,
      memberSocket?: string,
    ) => {
      if (!isPaneBackend(memberBackend)) {
        return 'unknown' satisfies PaneLiveness
      }
      const backend = getBackendByType(memberBackend)
      if (backend?.isPaneAliveOnSocket) {
        return backend.isPaneAliveOnSocket(memberPane, memberSocket)
      }
      if (!backend?.isPaneAlive) {
        return 'unknown' satisfies PaneLiveness
      }
      return backend.isPaneAlive(memberPane)
    })
  const probePane =
    deps?.probePane ?? (() => probeMemberPane(backendType, paneId, tmuxSocket))
  const firstContactTimeoutMs =
    deps?.firstContactTimeoutMs ??
    envPositiveInt(PANE_TEAMMATE_FIRST_CONTACT_TIMEOUT_ENV) ??
    PANE_TEAMMATE_FIRST_CONTACT_TIMEOUT_MS
  const progressTimeoutMs =
    deps?.progressTimeoutMs ??
    envPositiveInt(PANE_TEAMMATE_PROGRESS_TIMEOUT_ENV) ??
    PANE_TEAMMATE_PROGRESS_TIMEOUT_MS
  const unknownRetryDelayMs =
    deps?.unknownRetryDelayMs ?? PANE_TEAMMATE_UNKNOWN_RETRY_DELAY_MS
  const maxUnknownRetries =
    deps?.maxUnknownRetries ?? PANE_TEAMMATE_MAX_UNKNOWN_RETRIES
  const scanInterval =
    deps?.scanIntervalMs === undefined
      ? PANE_TEAMMATE_WATCHDOG_SCAN_INTERVAL_MS
      : deps.scanIntervalMs

  const armedAt = now()
  // True once the child shows any sign of life: the team-file turn-start
  // write, or any mailbox message. Gates the first-contact deadline.
  let booted = false
  // Anchor of the progress deadline. Every signal from the teammate moves it.
  let lastSignalAt = armedAt
  // True while the teammate is parked on a usage limit: failure deadlines
  // stand down (parked is alive and resumable), completion still watched for.
  let parked = false
  // True once THIS watchdog failed the task on a deadline. The watchdog then
  // keeps watching for the child's idle notification: a merely-slow teammate
  // was failed spuriously, and its late completion must WIN — the task flips
  // to completed and the completion is emitted. Deliberately not set when
  // the task went terminal by another hand (killed): that is not ours to
  // revisit.
  let watchdogFailedTask = false
  // Count of probes that answered 'unknown' at an expired deadline. The first
  // unknown defers for free; maxUnknownRetries then bound the re-probes.
  let unknownProbes = 0
  let lastProbeAt = Number.NEGATIVE_INFINITY
  let disposed = false
  let leadName: string | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  function dispose(): void {
    if (disposed) {
      return
    }
    disposed = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  /**
   * Flip the task terminal with the in-process transition shape (endTime +
   * retain/grace pair, cf. inProcessRunner's completion tail). Does NOT set
   * `notified` — enqueueAgentNotification owns that flag, which is what makes
   * the emission exactly-once against a later real completion.
   * Returns false when the task was already terminal (or gone): not ours to
   * transition.
   *
   * The one sanctioned rewrite of a terminal state: `fromWatchdogFailure`
   * allows failed → completed, the self-correcting late completion. It also
   * clears `error` and re-arms `notified: false` so the completion is EMITTED
   * — the guard that normally prevents double-emission would otherwise
   * swallow the later, different status.
   */
  function transitionTerminal(
    status: 'completed' | 'failed',
    error?: string,
    options?: { fromWatchdogFailure?: boolean },
  ): boolean {
    let transitioned = false
    updateTaskState(taskId, setAppState, task => {
      if (task.status !== 'running') {
        if (
          options?.fromWatchdogFailure &&
          task.status === 'failed' &&
          status === 'completed'
        ) {
          transitioned = true
          const at = now()
          return {
            ...task,
            status,
            error: undefined,
            endTime: at,
            notified: false,
            retain: false,
            evictAfter: at + TEAMMATE_GRACE_MS,
          }
        }
        return task
      }
      transitioned = true
      const at = now()
      return {
        ...task,
        status,
        ...(error !== undefined ? { error } : {}),
        endTime: at,
        retain: false,
        evictAfter: at + TEAMMATE_GRACE_MS,
      }
    })
    return transitioned
  }

  function emit(
    status: 'completed' | 'failed',
    error?: string,
    finalMessage?: string,
  ): void {
    enqueueAgentNotification({
      taskId,
      description,
      status,
      error,
      finalMessage,
      setAppState,
      toolUseId,
    })
  }

  function noProgressError(elapsedMs: number, liveness: PaneLiveness): string {
    const seconds = Math.round(elapsedMs / 1000)
    if (liveness === 'alive') {
      return `Teammate emitted no lifecycle signal within ${seconds}s (pane alive but unresponsive)`
    }
    if (liveness === 'unknown') {
      return `Teammate emitted no lifecycle signal within ${seconds}s (pane state unknown after ${unknownProbes} probes)`
    }
    return `Teammate emitted no lifecycle signal within ${seconds}s`
  }

  /**
   * Fail the task, notify the lead once, disarm. The error text lands on the
   * task state AND in the notification summary — transitionTerminal is what
   * writes the state, emit is what reaches the lead's conversation.
   */
  function failTask(error: string): void {
    if (transitionTerminal('failed', error)) {
      watchdogFailedTask = true
      emit('failed', error)
      // Do NOT dispose: a merely-slow child was failed spuriously, and its
      // late idle notification must still be able to complete the task.
      return
    }
    dispose()
  }

  async function scan(): Promise<void> {
    if (disposed) {
      return
    }

    // Still our task to watch? A task that is terminal by another hand
    // (killed by TaskStop) or already evicted means the watchdog's job is
    // done — disarm without a word. The one exception is a task THIS
    // watchdog failed on a deadline: it stays watched so a merely-slow
    // child's late idle notification can still complete it.
    let taskSeen = false
    let taskStatusNow: string | undefined
    updateTaskState(taskId, setAppState, task => {
      taskSeen = true
      taskStatusNow = task.status
      return task
    })
    if (!taskSeen) {
      dispose()
      return
    }
    const watchingLateCompletion =
      watchdogFailedTask && taskStatusNow === 'failed'
    if (taskStatusNow !== 'running' && !watchingLateCompletion) {
      dispose()
      return
    }

    // Resolve the lead's mailbox name once, from the same team file the
    // child's Stop hook reads its lead's name from.
    if (leadName === null) {
      const teamFile = await readTeamFile(teamName)
      leadName =
        teamFile?.members?.find(m => m.agentId === teamFile?.leadAgentId)
          ?.name ?? TEAM_LEAD_NAME
    }

    // 1. Mailbox signals from this teammate.
    const messages = await readLeadMailbox(leadName, teamName)
    const qualifying = messages.filter(m => {
      if (m.from !== teammateName) {
        return false
      }
      if (!m.timestamp) {
        return true // Untimestamped: be lenient, never fail on a missing stamp
      }
      const at = Date.parse(m.timestamp)
      return Number.isFinite(at) && at >= armedAt - TIMESTAMP_SLACK_MS
    })

    if (qualifying.length > 0) {
      booted = true
      for (const message of qualifying) {
        const at = message.timestamp ? Date.parse(message.timestamp) : now()
        if (Number.isFinite(at) && at > lastSignalAt) {
          lastSignalAt = at
        }
      }
      // The LATEST idle notification in the batch decides the outcome.
      let latestIdle: ReturnType<typeof isIdleNotification> = null
      for (const message of qualifying) {
        const idle = isIdleNotification(message.text)
        if (idle) {
          latestIdle = idle
        }
      }
      if (latestIdle) {
        if (latestIdle.idleReason === 'parked') {
          parked = true
          logForDebugging(
            `[PaneWatchdog] ${teammateName} parked (usage limit); failure deadlines stand down`,
          )
          return
        }
        parked = false
        if (latestIdle.idleReason === 'failed') {
          const reason =
            latestIdle.failureReason ?? 'Teammate reported a failed turn'
          if (transitionTerminal('failed', reason)) {
            emit('failed', reason)
          }
        } else {
          // 'available' and 'interrupted' both mean the turn is over and the
          // teammate is back at its prompt — the one-shot task is done. The
          // fromWatchdogFailure option is what lets this WIN over a watchdog
          // failure that fired on a merely-slow child.
          if (
            transitionTerminal('completed', undefined, {
              fromWatchdogFailure: true,
            })
          ) {
            emit('completed', undefined, latestIdle.summary)
          }
        }
        dispose()
        return
      }
      for (const message of qualifying) {
        const startup = isTeammateStartupNotification(message.text)
        if (startup) {
          logForDebugging(
            `[PaneWatchdog] ${teammateName} ready: model=${startup.model}, provider=${startup.provider}, transport=${startup.transport}`,
          )
        }
      }
      // Non-idle traffic (DM, permission request) is proof of progress; the
      // deadline re-anchor above already accounts for it.
      parked = false
    }

    // A task this watchdog already failed has no deadlines left to mind —
    // the late-completion watch above is its only remaining job.
    if (watchingLateCompletion) {
      return
    }

    // 2. Turn-start boot signal: the team-file isActive write.
    if (!booted) {
      const teamFile = await readTeamFile(teamName)
      if (
        teamFile?.members?.find(m => m.name === teammateName)?.isActive === true
      ) {
        booted = true
      }
    }

    if (parked) {
      return
    }

    // 3. Deadlines. Only absence of progress fails a task — never a cause.
    const nowMs = now()
    const firstContactExpired =
      !booted && nowMs - armedAt >= firstContactTimeoutMs
    const progressExpired = nowMs - lastSignalAt >= progressTimeoutMs
    if (!firstContactExpired && !progressExpired) {
      return
    }

    // 4. Probe, secondarily, to name the failure. An 'unknown' pane defers
    // through the bounded retry budget rather than firing — never treat
    // 'unknown' as death.
    if (unknownProbes > 0 && nowMs - lastProbeAt < unknownRetryDelayMs) {
      return
    }
    const liveness = await probePane()
    lastProbeAt = nowMs
    const elapsed = nowMs - (booted ? lastSignalAt : armedAt)
    if (liveness === 'unknown') {
      unknownProbes++
      if (unknownProbes <= maxUnknownRetries + 1) {
        logForDebugging(
          `[PaneWatchdog] ${teammateName} silent past deadline but pane state unknown; deferring (${unknownProbes}/${maxUnknownRetries + 1})`,
        )
        return
      }
      failTask(noProgressError(elapsed, 'unknown'))
      return
    }
    if (liveness === 'dead') {
      failTask('Pane exited without completing')
      return
    }
    failTask(noProgressError(elapsed, 'alive'))
  }

  signal?.addEventListener('abort', () => dispose(), { once: true })

  // The ghost sweep is owned by a team-scoped sweeper, not this watchdog — a
  // teammate that self-reports a failure disposes its own watchdog in the same
  // scan, so the sweep must outlive it. Arming is idempotent: one per team.
  ensureTeamSweeper({ teamName, currentSessionId, setAppState, deps })

  if (scanInterval !== null) {
    timer = setInterval(() => {
      void scan().catch(error => {
        logForDebugging(
          `[PaneWatchdog] scan for ${teammateName} failed: ${String(error)}`,
        )
      })
    }, scanInterval)
    // Never hold the event loop open for a watchdog.
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    scan,
    dispose,
    get disposed() {
      return disposed
    },
  }
}
