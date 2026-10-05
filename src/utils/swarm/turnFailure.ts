/**
 * The one place that decides "this agent/teammate turn ended in failure".
 *
 * Most provider failures never throw out of a turn: `services/api/claude.ts`
 * and `services/api/errors.ts` turn them into an assistant message with
 * `isApiErrorMessage: true` and the turn then ends as if it had succeeded. A
 * usage-policy refusal (`stop_reason: 'refusal'`), a 401, an overloaded or
 * context-too-long response all take that route. Every reporting path
 * (in-process teammate, pane teammate, background agent) therefore asks this
 * module instead of trusting "the generator finished" to mean "it worked".
 *
 * Dependency-light on purpose: it is imported from the teammate runner, the
 * agent lifecycle and the pane REPL.
 */

import type { Message } from '../../types/message.js'
import { INTERRUPT_MESSAGE } from '../messages/factories.js'
import {
  classifyTeammateApiError,
  type TeammateFailureKind,
} from './teammateFailureReasons.js'

export type TurnFailure = {
  kind: Exclude<TeammateFailureKind, 'runtime'>
  /** The original error text as the user would have seen it. */
  errorText: string
}

// ERROR_MESSAGE_USER_ABORT lives in services/compact (heavy imports); the
// text is stable and an abort is a stop, not a failure.
const USER_ABORT_PREFIXES = [
  'API Error: Request was aborted',
  INTERRUPT_MESSAGE,
]

function assistantText(message: Message): string {
  if (message.type !== 'assistant') return ''
  const content = message.message.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * The failure a turn ended in, or undefined when it ended normally.
 *
 * A turn failed when the LAST assistant message it produced is an API-error
 * message: an error followed by a later successful assistant message (a
 * retry, a fallback model) was recovered and is not reported. A user abort is
 * a stop, not a failure.
 */
export function findTurnFailure(
  messages: readonly Message[],
): TurnFailure | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'assistant') continue
    if (message.isApiErrorMessage !== true) return undefined
    const errorText = assistantText(message).trim()
    if (USER_ABORT_PREFIXES.some(prefix => errorText.startsWith(prefix))) {
      return undefined
    }
    return {
      kind: classifyTeammateApiError(
        typeof message.error === 'string' ? message.error : undefined,
        errorText || undefined,
        typeof message.apiError === 'string' ? message.apiError : undefined,
      ),
      errorText,
    }
  }
  return undefined
}
