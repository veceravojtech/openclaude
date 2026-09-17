import type { SetAppState } from '../../../Task.js'
import { enqueueAgentNotification } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { logForDebugging } from '../../debug.js'
import {
  TEAMMATE_GRACE_MS,
  updateTaskState,
} from '../../task/framework.js'
import { readMailbox, isIdleNotification } from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import { readTeamFileAsync } from '../teamHelpers.js'
import { getBackendByType } from './registry.js'
import { isPaneBackend, type BackendType, type PaneLiveness } from './types.js'

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
 * The trade-off is real: a first turn that legitimately runs longer than this
 * without once messaging the lead is failed early. The alternative — the
 * permanent silent 'running' row this replaces — is strictly worse, the
 * failure is visible and recoverable (respawn), and a late real completion
 * cannot double-notify (the `notified` guard in enqueueAgentNotification).
 * Env-tunable for workloads with known-long silent turns.
 */
export const PANE_TEAMMATE_PROGRESS_TIMEOUT_MS = 600_000

/** How often the watchdog scans the lead's mailbox and deadlines. */
export const PANE_TEAMMATE_WATCHDOG_SCAN_INTERVAL_MS = 5_000

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
  members?: Array<{ name: string; agentId?: string; isActive?: boolean }>
}

/** Test seams. Every boundary of the watchdog, overridable per arm. */
export type PaneTeammateWatchdogDeps = {
  now?: () => number
  readLeadMailbox?: (
    leadName: string,
    teamName: string,
  ) => Promise<PaneWatchdogMailboxMessage[]>
  readTeamFile?: (teamName: string) => Promise<PaneWatchdogTeamFile | null>
  probePane?: () => Promise<PaneLiveness>
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
  insideTmux,
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
  insideTmux: boolean
  backendType: BackendType
  toolUseId?: string
  setAppState: SetAppState
  signal?: AbortSignal
  deps?: PaneTeammateWatchdogDeps
}): PaneTeammateWatchdogHandle {
  const now = deps?.now ?? Date.now
  const readLeadMailbox =
    deps?.readLeadMailbox ?? ((lead, team) => readMailbox(lead, team))
  const readTeamFile = deps?.readTeamFile ?? readTeamFileAsync
  const probePane =
    deps?.probePane ??
    (async () => {
      if (!isPaneBackend(backendType)) {
        return 'unknown' satisfies PaneLiveness
      }
      const backend = getBackendByType(backendType)
      if (!backend?.isPaneAlive) {
        return 'unknown' satisfies PaneLiveness
      }
      return backend.isPaneAlive(paneId, !insideTmux)
    })
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
   */
  function transitionTerminal(
    status: 'completed' | 'failed',
    error?: string,
  ): boolean {
    let transitioned = false
    updateTaskState(taskId, setAppState, task => {
      if (task.status !== 'running') {
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
      emit('failed', error)
    }
    dispose()
  }

  async function scan(): Promise<void> {
    if (disposed) {
      return
    }

    // Still our task to watch? A task that is terminal (killed by TaskStop,
    // transitioned elsewhere) or already evicted means the watchdog's job is
    // done — disarm without a word.
    let taskSeen = false
    let taskRunning = false
    updateTaskState(taskId, setAppState, task => {
      taskSeen = true
      taskRunning = task.status === 'running'
      return task
    })
    if (!taskSeen || !taskRunning) {
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
          // teammate is back at its prompt — the one-shot task is done.
          if (transitionTerminal('completed')) {
            emit('completed', undefined, latestIdle.summary)
          }
        }
        dispose()
        return
      }
      // Non-idle traffic (DM, permission request) is proof of progress; the
      // deadline re-anchor above already accounts for it.
      parked = false
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
