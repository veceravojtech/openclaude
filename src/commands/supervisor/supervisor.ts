import {
  isCoordinatorMode,
  isCoordinatorStrict,
} from '../../coordinator/coordinatorMode.js'
import type { LocalCommandCall } from '../../types/command.js'

/**
 * Supervision is on by default (see isCoordinatorMode). This command is how a
 * session opts out, or tightens to strict.
 *
 * Both toggles write the env vars the mode functions read live, so the system
 * prompt follows on the next turn. The tool pool does not: useMergedTools
 * memoizes it, so a soft/strict switch only reshapes the available tools on
 * the next start — which the output says rather than pretending otherwise.
 */
function describeState(): string {
  if (!isCoordinatorMode()) {
    return 'Supervisor mode is OFF — this session does the work itself.'
  }
  return isCoordinatorStrict()
    ? 'Supervisor mode is ON (strict) — delegation tools only, no hands.'
    : 'Supervisor mode is ON (soft) — every tool available, delegation scored.'
}

export const call: LocalCommandCall = async (args) => {
  const arg = args.trim().toLowerCase()

  switch (arg) {
    case '':
    case 'status':
      return { type: 'text', value: describeState() }

    case 'on':
      process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
      return {
        type: 'text',
        value: `${describeState()}\nTakes effect on your next message.`,
      }

    case 'off':
      process.env.CLAUDE_CODE_COORDINATOR_MODE = '0'
      return {
        type: 'text',
        value: `${describeState()}\nTakes effect on your next message.`,
      }

    case 'strict':
      process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
      process.env.CLAUDE_CODE_COORDINATOR_STRICT = '1'
      return {
        type: 'text',
        value:
          `${describeState()}\nThe prompt changes on your next message; the tool pool is cut at the next start.`,
      }

    case 'soft':
      process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
      process.env.CLAUDE_CODE_COORDINATOR_STRICT = '0'
      return {
        type: 'text',
        value:
          `${describeState()}\nThe prompt changes on your next message; the tool pool is restored at the next start.`,
      }

    default:
      return {
        type: 'text',
        value: `Unknown option "${arg}". Usage: /supervisor [on|off|strict|soft]\n${describeState()}`,
      }
  }
}
