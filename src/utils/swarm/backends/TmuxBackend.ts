import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../../utils/debug.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { logError } from '../../../utils/log.js'
import { count } from '../../array.js'
import { sleep } from '../../sleep.js'
import {
  getSwarmSocketName,
  HIDDEN_SESSION_NAME,
  SWARM_SESSION_NAME,
  SWARM_VIEW_WINDOW_NAME,
  TMUX_COMMAND,
} from '../constants.js'
import {
  getLeaderPaneId,
  getUserTmuxSocketName,
  isInsideTmux as isInsideTmuxFromDetection,
  isTmuxAvailable,
} from './detection.js'
import { registerTmuxBackend } from './registry.js'
import type {
  CreatePaneResult,
  PaneBackend,
  PaneId,
  PaneLiveness,
  PanePresence,
} from './types.js'

// Track whether the first pane has been used for external swarm session
let firstPaneUsedForExternal = false

// Cached leader window target (session:window format) to avoid repeated queries
let cachedLeaderWindowTarget: string | null = null

// Lock mechanism to prevent race conditions when spawning teammates in parallel
let paneCreationLock: Promise<void> = Promise.resolve()

// Delay after pane creation to allow shell initialization (loading rc files, prompts, etc.)
// 200ms is enough for most shell configurations including slow ones like starship/oh-my-zsh
const PANE_SHELL_INIT_DELAY_MS = 200

function waitForPaneShellReady(): Promise<void> {
  return sleep(PANE_SHELL_INIT_DELAY_MS)
}

/**
 * Separator between the fields `isPaneAlive` asks tmux for. A comma is safe:
 * a pane id is `%N`, `#{pane_dead}` is 0 or 1 and `#{pane_current_command}`
 * is a process name, so none of them can contain one.
 */
const TMUX_PANE_STATE_SEPARATOR = ','

/**
 * The fields `isPaneAlive` asks tmux for, in order.
 *
 * `#{pane_id}` comes FIRST because it is the existence proof. A query about a
 * pane that is not there is not an error to tmux: it answers with an empty
 * expansion and exit 0. On tmux 3.6b a killed pane and an id that never
 * existed both answer with empty fields, which is why the two-field query
 * this used to ask could not tell "the pane is gone" from "tmux cannot be
 * reached" — both came back empty and both read as 'unknown'. Echoing the id
 * back separates them: an empty id in an answer that arrived at all means the
 * id resolved to nothing ON THE SERVER WE ASKED. Whether that is death or a
 * foreign server is settled by the positive-server-identity check in
 * `isPaneAliveOnSocket`, never by the empty id alone.
 */
const TMUX_PANE_QUERY_FORMAT = `#{pane_id}${TMUX_PANE_STATE_SEPARATOR}#{pane_dead}${TMUX_PANE_STATE_SEPARATOR}#{pane_current_command}`

/**
 * Command names that mean "no child is running here".
 *
 * A teammate pane is created running a shell and the CLI is typed into it, so
 * the shell is the pane's foreground command exactly when the CLI is not
 * running — either it has not started yet or it has exited. Callers make that
 * distinction with a startup grace period, not here.
 */
const SHELL_COMMANDS = new Set([
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'login',
  'sh',
  'tcsh',
  'zsh',
])

/**
 * Turns `<pane_id>,<pane_dead>,<pane_current_command>` into a liveness verdict.
 *
 * Exported for testing: this is the whole field-level judgement, and it must
 * be provable without a live tmux server.
 *
 * - a `pane_id` that is empty is tmux telling us the id resolved to nothing ON
 *   THE SERVER WE ASKED. That is death only when the caller has positively
 *   established that server is the one owning this pane (`serverIdentityConfirmed`);
 *   otherwise it is doubt. A foreign socket answers exactly the same empty
 *   fields for a live pane it does not host, so an empty id alone is never
 *   enough to declare `'dead'`.
 * - `pane_dead` is 1 for a pane whose process finished under
 *   `remain-on-exit` — unambiguously dead.
 * - a shell in the foreground means the child is not running (see
 *   SHELL_COMMANDS): the pane runs a shell and the CLI is typed into it, so
 *   the shell is what the pane shows once that CLI has exited.
 * - anything unparseable is 'unknown', never 'dead'.
 */
export function interpretTmuxPaneState(
  raw: string,
  serverIdentityConfirmed: boolean,
): PaneLiveness {
  const trimmed = raw.trim()
  if (!trimmed) {
    // Not an answer at all — tmux could not be reached, or nothing came back.
    // Never evidence of death.
    return 'unknown'
  }

  const fields = trimmed.split(TMUX_PANE_STATE_SEPARATOR)
  if (fields.length < 3) {
    // Not the shape we asked for.
    return 'unknown'
  }

  const paneId = fields[0]!.trim()
  const deadFlag = fields[1]!.trim()
  // A pane id cannot contain a comma, so whatever follows the second one is
  // the command — nothing is lost by not capping the split.
  const command = fields
    .slice(2)
    .join(TMUX_PANE_STATE_SEPARATOR)
    .trim()
    // A shell started as a login shell is reported with a leading '-'.
    .replace(/^-/, '')

  if (!paneId) {
    return serverIdentityConfirmed ? 'dead' : 'unknown'
  }
  if (deadFlag === '1') {
    return 'dead'
  }
  if (deadFlag !== '0') {
    return 'unknown'
  }
  if (!command) {
    return 'unknown'
  }

  return SHELL_COMMANDS.has(command) ? 'dead' : 'alive'
}

/**
 * The shape `isPaneAliveOnSocket` gets back from one `tmux` invocation.
 */
export type TmuxPaneQueryResult = {
  code: number
  stdout: string
  stderr: string
}

/**
 * The full socket-explicit probe judgement, exported for hermetic tests.
 *
 * Handles the non-zero exit path (an unreachable socket vs. a server that
 * explicitly names a missing pane) and then defers the field judgement to
 * {@link interpretTmuxPaneState} with the caller's positive-server-identity
 * answer.
 */
export function interpretTmuxPaneProbe(
  query: TmuxPaneQueryResult,
  serverIdentityConfirmed: boolean,
): PaneLiveness {
  if (query.code !== 0) {
    const missingPane = /can't find pane|no such pane/i.test(query.stderr)
    return missingPane ? 'dead' : 'unknown'
  }
  return interpretTmuxPaneState(query.stdout, serverIdentityConfirmed)
}

/**
 * Turns `<pane_id>,<pane_dead>,<pane_current_command>` into a PRESENCE verdict:
 * does the pane still exist, ignoring what runs in its foreground.
 *
 * This is the destructive-decision twin of {@link interpretTmuxPaneState}. That
 * function must answer "is the CLI running", so it folds "pane exists, shell in
 * the foreground" into 'dead' — the sweep must not, because that pane is a
 * still-standing record it would wrongly delete. Only an empty pane id on a
 * positively-confirmed server, or a `remain-on-exit` pane (`pane_dead` 1), is
 * 'absent'. A non-empty id with `pane_dead` 0 is 'present' no matter what the
 * foreground command is.
 */
export function interpretTmuxPanePresence(
  raw: string,
  serverIdentityConfirmed: boolean,
): PanePresence {
  const trimmed = raw.trim()
  if (!trimmed) {
    return 'unknown'
  }

  const fields = trimmed.split(TMUX_PANE_STATE_SEPARATOR)
  if (fields.length < 3) {
    return 'unknown'
  }

  const paneId = fields[0]!.trim()
  const deadFlag = fields[1]!.trim()

  if (!paneId) {
    return serverIdentityConfirmed ? 'absent' : 'unknown'
  }
  if (deadFlag === '1') {
    return 'absent'
  }
  if (deadFlag !== '0') {
    return 'unknown'
  }
  return 'present'
}

/**
 * The full socket-explicit presence judgement, exported for hermetic tests.
 * Mirrors {@link interpretTmuxPaneProbe} but answers absence rather than death.
 */
export function interpretTmuxPaneProbePresence(
  query: TmuxPaneQueryResult,
  serverIdentityConfirmed: boolean,
): PanePresence {
  if (query.code !== 0) {
    const missingPane = /can't find pane|no such pane/i.test(query.stderr)
    return missingPane ? 'absent' : 'unknown'
  }
  return interpretTmuxPanePresence(query.stdout, serverIdentityConfirmed)
}

/**
 * Whether a successful 3-field reply carries an empty `pane_id` — the one
 * answer that is ambiguous between "gone" and "asked a foreign server".
 */
function paneReplyHasEmptyId(stdout: string): boolean {
  const trimmed = stdout.trim()
  if (!trimmed) return false
  const fields = trimmed.split(TMUX_PANE_STATE_SEPARATOR)
  return fields.length >= 3 && fields[0]!.trim() === ''
}

/**
 * Acquires a lock for pane creation, ensuring sequential execution.
 * Returns a release function that must be called when done.
 */
function acquirePaneCreationLock(): Promise<() => void> {
  let release: () => void
  const newLock = new Promise<void>(resolve => {
    release = resolve
  })

  const previousLock = paneCreationLock
  paneCreationLock = newLock

  return previousLock.then(() => release!)
}

/**
 * Gets the tmux color name for a given agent color.
 * These are tmux's built-in color names that work with pane-border-style.
 */
function getTmuxColorName(color: AgentColorName): string {
  const tmuxColors: Record<AgentColorName, string> = {
    red: 'red',
    blue: 'blue',
    green: 'green',
    yellow: 'yellow',
    purple: 'magenta',
    orange: 'colour208',
    pink: 'colour205',
    cyan: 'cyan',
  }
  return tmuxColors[color]
}

/**
 * Runs a tmux command in the user's original tmux session (no socket override).
 * Use this for operations that interact with the user's tmux panes (split-pane with leader).
 */
function runTmuxInUserSession(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(TMUX_COMMAND, args)
}

/**
 * Runs a tmux command in the external swarm socket.
 * Use this for operations in the standalone swarm session (when user is not in tmux).
 */
function runTmuxInSwarm(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(TMUX_COMMAND, ['-L', getSwarmSocketName(), ...args])
}

/**
 * Runs a tmux command against an explicitly named socket (`-L <socketName>`).
 * This is the probe path: unlike the user-session/swarm runners, the socket is
 * chosen by the caller from the roster's recorded value, never from the
 * probing process's own environment.
 */
function runTmuxInSocket(
  socketName: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(TMUX_COMMAND, ['-L', socketName, ...args])
}

/**
 * TmuxBackend implements PaneBackend using tmux for pane management.
 *
 * When running INSIDE tmux (leader is in tmux):
 * - Splits the current window to add teammates alongside the leader
 * - Leader stays on left (30%), teammates on right (70%)
 *
 * When running OUTSIDE tmux (leader is in regular terminal):
 * - Creates a claude-swarm session with a swarm-view window
 * - All teammates are equally distributed (no leader pane)
 */
export class TmuxBackend implements PaneBackend {
  readonly type = 'tmux' as const
  readonly displayName = 'tmux'
  readonly supportsHideShow = true

  /**
   * Checks if tmux is installed and available.
   * Delegates to detection.ts for consistent detection logic.
   */
  async isAvailable(): Promise<boolean> {
    return isTmuxAvailable()
  }

  /**
   * Checks if we're currently running inside a tmux session.
   * Delegates to detection.ts for consistent detection logic.
   */
  async isRunningInside(): Promise<boolean> {
    return isInsideTmuxFromDetection()
  }

  /**
   * Creates a new teammate pane in the swarm view.
   * Uses a lock to prevent race conditions when multiple teammates are spawned in parallel.
   */
  async createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    const releaseLock = await acquirePaneCreationLock()

    try {
      const insideTmux = await this.isRunningInside()

      if (insideTmux) {
        return await this.createTeammatePaneWithLeader(name, color)
      }

      return await this.createTeammatePaneExternal(name, color)
    } finally {
      releaseLock()
    }
  }

  /**
   * Sends a command to a specific pane.
   */
  async sendCommandToPane(
    paneId: PaneId,
    command: string,
    useExternalSession = false,
  ): Promise<void> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    const result = await runTmux(['send-keys', '-t', paneId, command, 'Enter'])

    if (result.code !== 0) {
      throw new Error(
        `Failed to send command to pane ${paneId}: ${result.stderr}`,
      )
    }
  }

  /**
   * Reports whether the CLI that was typed into a pane is still running.
   *
   * See `interpretTmuxPaneState` for what the three format fields mean. A pane
   * that no longer exists is 'dead' too: a caller asking "is this teammate
   * still there" is answered by absence either way, and the shell-foreground
   * rule below only covers the pane that is still standing.
   *
   * The socket is derived from the boolean, matching the historical contract.
   * Callers that know the pane's backing socket (the roster) should use
   * {@link isPaneAliveOnSocket} instead, so a probing process attached to a
   * different server cannot misread a live pane.
   */
  async isPaneAlive(
    paneId: PaneId,
    useExternalSession = false,
  ): Promise<PaneLiveness> {
    const socketName = useExternalSession
      ? getSwarmSocketName()
      : (getUserTmuxSocketName() ?? 'default')
    return this.isPaneAliveOnSocket(paneId, socketName)
  }

  /**
   * Reports liveness by probing the pane on an explicitly named socket — the
   * socket the pane was spawned on, recorded in the roster. A live pane can
   * never be read as 'dead' just because the probing process is attached to a
   * different server: the empty `pane_id` reply is only treated as death once
   * the named socket is confirmed reachable (positive server identity), and a
   * missing socket fails open as 'unknown'.
   */
  async isPaneAliveOnSocket(
    paneId: PaneId,
    socketName?: string,
  ): Promise<PaneLiveness> {
    if (!socketName) {
      // No recorded socket means we cannot prove which server owns this pane.
      // A wrong-but-reachable server would answer the same empty fields for a
      // live pane, so fail open rather than risk a destructive false 'dead'.
      logForDebugging(
        `[TmuxBackend] isPaneAliveOnSocket(${paneId}) has no recorded socket; answering unknown`,
      )
      return 'unknown'
    }

    const result = await runTmuxInSocket(socketName, [
      'display-message',
      '-p',
      '-t',
      paneId,
      TMUX_PANE_QUERY_FORMAT,
    ])

    if (result.code !== 0) {
      // Two very different failures share this exit path: the pane is gone
      // (some tmux versions say so by name on stderr), or tmux itself could
      // not be reached — no server, a transient error. Only the first is
      // evidence of death; the second must stay 'unknown' or a hiccup in the
      // leader's environment would fail every healthy teammate at once.
      logForDebugging(
        `[TmuxBackend] isPaneAliveOnSocket(${paneId}) query failed (exit ${result.code}): ${result.stderr}`,
      )
      return interpretTmuxPaneProbe(result, false)
    }

    // The empty-id reply is the only answer that is ambiguous between "gone"
    // and "asked a foreign server". A non-empty id already proves the pane
    // resolved on this socket, so no second query is needed for those.
    const needsIdentity = paneReplyHasEmptyId(result.stdout)
    const serverIdentityConfirmed = needsIdentity
      ? await this.socketServerReachable(socketName)
      : false

    return interpretTmuxPaneProbe(result, serverIdentityConfirmed)
  }

  /**
   * Reports whether the pane still exists, independent of what runs in its
   * foreground. The ghost sweep's probe: it must delete a roster record only
   * for a pane that is genuinely gone, never for a pane whose CLI has exited
   * but whose shell still keeps the pane standing.
   *
   * Same socket contract as {@link isPaneAliveOnSocket}: no recorded socket
   * fails open as 'unknown', and an empty `pane_id` reply is only 'absent'
   * once the named socket is confirmed reachable.
   */
  async isPanePresentOnSocket(
    paneId: PaneId,
    socketName?: string,
  ): Promise<PanePresence> {
    if (!socketName) {
      logForDebugging(
        `[TmuxBackend] isPanePresentOnSocket(${paneId}) has no recorded socket; answering unknown`,
      )
      return 'unknown'
    }

    const result = await runTmuxInSocket(socketName, [
      'display-message',
      '-p',
      '-t',
      paneId,
      TMUX_PANE_QUERY_FORMAT,
    ])

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] isPanePresentOnSocket(${paneId}) query failed (exit ${result.code}): ${result.stderr}`,
      )
      return interpretTmuxPaneProbePresence(result, false)
    }

    const needsIdentity = paneReplyHasEmptyId(result.stdout)
    const serverIdentityConfirmed = needsIdentity
      ? await this.socketServerReachable(socketName)
      : false

    return interpretTmuxPaneProbePresence(result, serverIdentityConfirmed)
  }

  /**
   * Whether the named socket answers `list-panes` — i.e. a server is actually
   * running on it. This is the positive-server-identity check an empty
   * `pane_id` reply requires before it may be read as death.
   */
  private async socketServerReachable(socketName: string): Promise<boolean> {
    const result = await runTmuxInSocket(socketName, [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}',
    ])
    return result.code === 0
  }

  /**
   * Sets the border color for a specific pane.
   */
  async setPaneBorderColor(
    paneId: PaneId,
    color: AgentColorName,
    useExternalSession = false,
  ): Promise<void> {
    const tmuxColor = getTmuxColorName(color)
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // Set pane-specific border style using pane options (requires tmux 3.2+)
    await runTmux([
      'select-pane',
      '-t',
      paneId,
      '-P',
      `bg=default,fg=${tmuxColor}`,
    ])

    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-border-style',
      `fg=${tmuxColor}`,
    ])

    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-active-border-style',
      `fg=${tmuxColor}`,
    ])
  }

  /**
   * Sets the title for a pane (shown in pane border if pane-border-status is set).
   */
  async setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession = false,
  ): Promise<void> {
    const tmuxColor = getTmuxColorName(color)
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // Set the pane title
    await runTmux(['select-pane', '-t', paneId, '-T', name])

    // Enable pane border status with colored format
    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-border-format',
      `#[fg=${tmuxColor},bold] #{pane_title} #[default]`,
    ])
  }

  /**
   * Enables pane border status for a window (shows pane titles).
   */
  async enablePaneBorderStatus(
    windowTarget?: string,
    useExternalSession = false,
  ): Promise<void> {
    const target = windowTarget || (await this.getCurrentWindowTarget())
    if (!target) {
      return
    }

    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    await runTmux([
      'set-option',
      '-w',
      '-t',
      target,
      'pane-border-status',
      'top',
    ])
  }

  /**
   * Rebalances panes to achieve the desired layout.
   */
  async rebalancePanes(
    windowTarget: string,
    hasLeader: boolean,
  ): Promise<void> {
    if (hasLeader) {
      await this.rebalancePanesWithLeader(windowTarget)
    } else {
      await this.rebalancePanesTiled(windowTarget)
    }
  }

  /**
   * Kills/closes a specific pane.
   */
  async killPane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    const result = await runTmux(['kill-pane', '-t', paneId])
    return result.code === 0
  }

  /**
   * Kills a pane on an explicitly named socket (`-L <socketName>`), chosen
   * from the roster's recorded value rather than the caller's environment.
   *
   * Without a recorded socket there is no positive proof of which server owns
   * the pane, and a guessed socket could kill a pane on the wrong server — so
   * an undefined socket fails closed as `false` instead of guessing.
   */
  async killPaneOnSocket(paneId: PaneId, socketName?: string): Promise<boolean> {
    if (!socketName) {
      logForDebugging(
        `[TmuxBackend] killPaneOnSocket(${paneId}) has no recorded socket; refusing to kill on a guessed socket`,
      )
      return false
    }
    const result = await runTmuxInSocket(socketName, ['kill-pane', '-t', paneId])
    return result.code === 0
  }

  /**
   * Hides a pane by moving it to a detached hidden session.
   * Creates the hidden session if it doesn't exist, then uses break-pane to move the pane there.
   */
  async hidePane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // Create hidden session if it doesn't exist (detached, not visible)
    await runTmux(['new-session', '-d', '-s', HIDDEN_SESSION_NAME])

    // Move the pane to the hidden session
    const result = await runTmux([
      'break-pane',
      '-d',
      '-s',
      paneId,
      '-t',
      `${HIDDEN_SESSION_NAME}:`,
    ])

    if (result.code === 0) {
      logForDebugging(`[TmuxBackend] Hidden pane ${paneId}`)
    } else {
      logForDebugging(
        `[TmuxBackend] Failed to hide pane ${paneId}: ${result.stderr}`,
      )
    }

    return result.code === 0
  }

  /**
   * Shows a previously hidden pane by joining it back into the target window.
   * Uses `tmux join-pane` to move the pane back, then reapplies main-vertical layout
   * with leader at 30%.
   */
  async showPane(
    paneId: PaneId,
    targetWindowOrPane: string,
    useExternalSession = false,
  ): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // join-pane -s: source pane to move
    // -t: target window/pane to join into
    // -h: join horizontally (side by side)
    const result = await runTmux([
      'join-pane',
      '-h',
      '-s',
      paneId,
      '-t',
      targetWindowOrPane,
    ])

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to show pane ${paneId}: ${result.stderr}`,
      )
      return false
    }

    logForDebugging(
      `[TmuxBackend] Showed pane ${paneId} in ${targetWindowOrPane}`,
    )

    // Reapply main-vertical layout with leader at 30%
    await runTmux(['select-layout', '-t', targetWindowOrPane, 'main-vertical'])

    // Get the first pane (leader) and resize to 30%
    const panesResult = await runTmux([
      'list-panes',
      '-t',
      targetWindowOrPane,
      '-F',
      '#{pane_id}',
    ])

    const panes = panesResult.stdout.trim().split('\n').filter(Boolean)
    if (panes[0]) {
      await runTmux(['resize-pane', '-t', panes[0], '-x', '30%'])
    }

    return true
  }

  // Private helper methods

  /**
   * Gets the leader's pane ID.
   * Uses the TMUX_PANE env var captured at module load to ensure we always
   * get the leader's original pane, even if the user has switched panes.
   */
  private async getCurrentPaneId(): Promise<string | null> {
    // Use the pane ID captured at startup (from TMUX_PANE env var)
    const leaderPane = getLeaderPaneId()
    if (leaderPane) {
      return leaderPane
    }

    // Fallback to dynamic query (shouldn't happen if we're inside tmux)
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'display-message',
      '-p',
      '#{pane_id}',
    ])

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to get current pane ID (exit ${result.code}): ${result.stderr}`,
      )
      return null
    }

    return result.stdout.trim()
  }

  /**
   * Gets the leader's window target (session:window format).
   * Uses the leader's pane ID to query for its window, ensuring we get the
   * correct window even if the user has switched to a different window.
   * Caches the result since the leader's window won't change.
   */
  private async getCurrentWindowTarget(): Promise<string | null> {
    // Return cached value if available
    if (cachedLeaderWindowTarget) {
      return cachedLeaderWindowTarget
    }

    // Build the command - use -t to target the leader's pane specifically
    const leaderPane = getLeaderPaneId()
    const args = ['display-message']
    if (leaderPane) {
      args.push('-t', leaderPane)
    }
    args.push('-p', '#{session_name}:#{window_index}')

    const result = await execFileNoThrow(TMUX_COMMAND, args)

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to get current window target (exit ${result.code}): ${result.stderr}`,
      )
      return null
    }

    cachedLeaderWindowTarget = result.stdout.trim()
    return cachedLeaderWindowTarget
  }

  /**
   * Gets the number of panes in a window.
   */
  private async getCurrentWindowPaneCount(
    windowTarget?: string,
    useSwarmSocket = false,
  ): Promise<number | null> {
    const target = windowTarget || (await this.getCurrentWindowTarget())
    if (!target) {
      return null
    }

    const args = ['list-panes', '-t', target, '-F', '#{pane_id}']
    const result = useSwarmSocket
      ? await runTmuxInSwarm(args)
      : await runTmuxInUserSession(args)

    if (result.code !== 0) {
      logError(
        new Error(
          `[TmuxBackend] Failed to get pane count for ${target} (exit ${result.code}): ${result.stderr}`,
        ),
      )
      return null
    }

    return count(result.stdout.trim().split('\n'), Boolean)
  }

  /**
   * Checks if a tmux session exists in the swarm socket.
   */
  private async hasSessionInSwarm(sessionName: string): Promise<boolean> {
    const result = await runTmuxInSwarm(['has-session', '-t', sessionName])
    return result.code === 0
  }

  /**
   * Creates the swarm session with a single window for teammates when running outside tmux.
   */
  private async createExternalSwarmSession(): Promise<{
    windowTarget: string
    paneId: string
  }> {
    const sessionExists = await this.hasSessionInSwarm(SWARM_SESSION_NAME)

    if (!sessionExists) {
      const result = await runTmuxInSwarm([
        'new-session',
        '-d',
        '-s',
        SWARM_SESSION_NAME,
        '-n',
        SWARM_VIEW_WINDOW_NAME,
        '-P',
        '-F',
        '#{pane_id}',
      ])

      if (result.code !== 0) {
        throw new Error(
          `Failed to create swarm session: ${result.stderr || 'Unknown error'}`,
        )
      }

      const paneId = result.stdout.trim()
      const windowTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`

      logForDebugging(
        `[TmuxBackend] Created external swarm session with window ${windowTarget}, pane ${paneId}`,
      )

      return { windowTarget, paneId }
    }

    // Session exists, check if swarm-view window exists
    const listResult = await runTmuxInSwarm([
      'list-windows',
      '-t',
      SWARM_SESSION_NAME,
      '-F',
      '#{window_name}',
    ])

    const windows = listResult.stdout.trim().split('\n').filter(Boolean)
    const windowTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`

    if (windows.includes(SWARM_VIEW_WINDOW_NAME)) {
      const paneResult = await runTmuxInSwarm([
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = paneResult.stdout.trim().split('\n').filter(Boolean)
      return { windowTarget, paneId: panes[0] || '' }
    }

    // Create the swarm-view window
    const createResult = await runTmuxInSwarm([
      'new-window',
      '-t',
      SWARM_SESSION_NAME,
      '-n',
      SWARM_VIEW_WINDOW_NAME,
      '-P',
      '-F',
      '#{pane_id}',
    ])

    if (createResult.code !== 0) {
      throw new Error(
        `Failed to create swarm-view window: ${createResult.stderr || 'Unknown error'}`,
      )
    }

    return { windowTarget, paneId: createResult.stdout.trim() }
  }

  /**
   * Creates a teammate pane when running inside tmux (with leader).
   */
  private async createTeammatePaneWithLeader(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    const currentPaneId = await this.getCurrentPaneId()
    const windowTarget = await this.getCurrentWindowTarget()

    if (!currentPaneId || !windowTarget) {
      throw new Error('Could not determine current tmux pane/window')
    }

    const paneCount = await this.getCurrentWindowPaneCount(windowTarget)
    if (paneCount === null) {
      throw new Error('Could not determine pane count for current window')
    }
    const isFirstTeammate = paneCount === 1

    let splitResult
    if (isFirstTeammate) {
      // First teammate: split horizontally from the leader pane
      splitResult = await execFileNoThrow(TMUX_COMMAND, [
        'split-window',
        '-t',
        currentPaneId,
        '-h',
        '-l',
        '70%',
        '-P',
        '-F',
        '#{pane_id}',
      ])
    } else {
      // Additional teammates: split from an existing teammate pane
      const listResult = await execFileNoThrow(TMUX_COMMAND, [
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = listResult.stdout.trim().split('\n').filter(Boolean)
      const teammatePanes = panes.slice(1)
      const teammateCount = teammatePanes.length

      const splitVertically = teammateCount % 2 === 1
      const targetPaneIndex = Math.floor((teammateCount - 1) / 2)
      const targetPane =
        teammatePanes[targetPaneIndex] ||
        teammatePanes[teammatePanes.length - 1]

      splitResult = await execFileNoThrow(TMUX_COMMAND, [
        'split-window',
        '-t',
        targetPane!,
        splitVertically ? '-v' : '-h',
        '-P',
        '-F',
        '#{pane_id}',
      ])
    }

    if (splitResult.code !== 0) {
      throw new Error(`Failed to create teammate pane: ${splitResult.stderr}`)
    }

    const paneId = splitResult.stdout.trim()
    logForDebugging(
      `[TmuxBackend] Created teammate pane for ${teammateName}: ${paneId}`,
    )

    await this.setPaneBorderColor(paneId, teammateColor)
    await this.setPaneTitle(paneId, teammateName, teammateColor)
    await this.rebalancePanesWithLeader(windowTarget)

    // Wait for shell to initialize before returning, so commands can be sent immediately
    await waitForPaneShellReady()

    return { paneId, isFirstTeammate }
  }

  /**
   * Creates a teammate pane when running outside tmux (no leader in tmux).
   */
  private async createTeammatePaneExternal(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    const { windowTarget, paneId: firstPaneId } =
      await this.createExternalSwarmSession()

    const paneCount = await this.getCurrentWindowPaneCount(windowTarget, true)
    if (paneCount === null) {
      throw new Error('Could not determine pane count for swarm window')
    }
    const isFirstTeammate = !firstPaneUsedForExternal && paneCount === 1

    let paneId: string

    if (isFirstTeammate) {
      paneId = firstPaneId
      firstPaneUsedForExternal = true
      logForDebugging(
        `[TmuxBackend] Using initial pane for first teammate ${teammateName}: ${paneId}`,
      )

      await this.enablePaneBorderStatus(windowTarget, true)
    } else {
      const listResult = await runTmuxInSwarm([
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = listResult.stdout.trim().split('\n').filter(Boolean)
      const teammateCount = panes.length

      const splitVertically = teammateCount % 2 === 1
      const targetPaneIndex = Math.floor((teammateCount - 1) / 2)
      const targetPane = panes[targetPaneIndex] || panes[panes.length - 1]

      const splitResult = await runTmuxInSwarm([
        'split-window',
        '-t',
        targetPane!,
        splitVertically ? '-v' : '-h',
        '-P',
        '-F',
        '#{pane_id}',
      ])

      if (splitResult.code !== 0) {
        throw new Error(`Failed to create teammate pane: ${splitResult.stderr}`)
      }

      paneId = splitResult.stdout.trim()
      logForDebugging(
        `[TmuxBackend] Created teammate pane for ${teammateName}: ${paneId}`,
      )
    }

    await this.setPaneBorderColor(paneId, teammateColor, true)
    await this.setPaneTitle(paneId, teammateName, teammateColor, true)
    await this.rebalancePanesTiled(windowTarget)

    // Wait for shell to initialize before returning, so commands can be sent immediately
    await waitForPaneShellReady()

    return { paneId, isFirstTeammate }
  }

  /**
   * Rebalances panes in a window with a leader.
   */
  private async rebalancePanesWithLeader(windowTarget: string): Promise<void> {
    const listResult = await runTmuxInUserSession([
      'list-panes',
      '-t',
      windowTarget,
      '-F',
      '#{pane_id}',
    ])

    const panes = listResult.stdout.trim().split('\n').filter(Boolean)
    if (panes.length <= 2) {
      return
    }

    await runTmuxInUserSession([
      'select-layout',
      '-t',
      windowTarget,
      'main-vertical',
    ])

    const leaderPane = panes[0]
    await runTmuxInUserSession(['resize-pane', '-t', leaderPane!, '-x', '30%'])

    logForDebugging(
      `[TmuxBackend] Rebalanced ${panes.length - 1} teammate panes with leader`,
    )
  }

  /**
   * Rebalances panes in a window without a leader (tiled layout).
   */
  private async rebalancePanesTiled(windowTarget: string): Promise<void> {
    const listResult = await runTmuxInSwarm([
      'list-panes',
      '-t',
      windowTarget,
      '-F',
      '#{pane_id}',
    ])

    const panes = listResult.stdout.trim().split('\n').filter(Boolean)
    if (panes.length <= 1) {
      return
    }

    await runTmuxInSwarm(['select-layout', '-t', windowTarget, 'tiled'])

    logForDebugging(
      `[TmuxBackend] Rebalanced ${panes.length} teammate panes with tiled layout`,
    )
  }
}

// Register the backend with the registry when this module is imported.
// This side effect is intentional - the registry needs backends to self-register to avoid circular dependencies.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerTmuxBackend(TmuxBackend)
