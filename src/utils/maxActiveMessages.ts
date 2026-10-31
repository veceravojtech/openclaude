export const DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP = 1000

// Context window the message-count defaults were tuned for (#1949): the
// MODEL_CONTEXT_WINDOW_DEFAULT of utils/context.ts, inlined so this module
// stays import-free. A model with a larger window gets a proportionally larger
// hard cap, and the implicit default limit does not apply to it at all (see
// resolveMaxActiveMessagesLimit).
const BASELINE_CONTEXT_WINDOW = 200_000

type MaxActiveMessagesEnv = Record<string, string | undefined>

function isAboveBaselineContextWindow(
  contextWindow: number | undefined,
): contextWindow is number {
  return (
    contextWindow !== undefined &&
    Number.isFinite(contextWindow) &&
    contextWindow > BASELINE_CONTEXT_WINDOW
  )
}

/**
 * Scale a built-in message limit (the default hard cap) to the model's context
 * window. Limits at or below the baseline window are returned as-is, as are
 * disabled (0) limits. Never applied to a limit the user set by hand.
 */
export function scaleActiveMessageLimitToContextWindow(
  limit: number,
  contextWindow: number | undefined,
): number {
  if (limit <= 0 || !isAboveBaselineContextWindow(contextWindow)) {
    return limit
  }
  return Math.round(limit * (contextWindow / BASELINE_CONTEXT_WINDOW))
}

export function parseMaxActiveMessagesLimit(value: string | undefined): number {
  if (!value) {
    return 0
  }
  const trimmed = value.trim()
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    return 0
  }
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

export function getMaxActiveMessagesHardCap(
  env: MaxActiveMessagesEnv = process.env,
  // When given, the default cap scales with the model's context window. An
  // explicit env override is always honored as written.
  contextWindow?: number,
): number {
  const hardCapOverride =
    env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
  if (hardCapOverride === undefined) {
    return scaleActiveMessageLimitToContextWindow(
      DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP,
      contextWindow,
    )
  }
  const trimmed = hardCapOverride.trim()
  if (trimmed === '0') {
    return 0
  }
  const parsed = parseMaxActiveMessagesLimit(trimmed)
  return parsed > 0
    ? parsed
    : scaleActiveMessageLimitToContextWindow(
        DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP,
        contextWindow,
      )
}

export function resolveMaxActiveMessagesLimit(
  configSetting: string | undefined,
  envSetting: string | undefined,
  options?: {
    // Model context window. Scales the hard cap, and decides whether the
    // implicit default applies.
    contextWindow?: number
    // Set when configSetting is the implicit default rather than a value the
    // user chose.
    implicitDefault?: boolean
  },
): number {
  const hardCap = getMaxActiveMessagesHardCap(
    process.env,
    options?.contextWindow,
  )
  // The implicit 200-message default bounds per-turn latency on the 200k
  // window it was tuned for (#1949), and cannot be scaled to a larger one: it
  // counts transcript records — every thinking, text and tool_use block and
  // every attachment is its own record — and those average roughly 400 tokens,
  // not the 1000 a linear scale assumes. Scaled to 1000 messages, it compacted
  // a 1M session at ~400k. Above the baseline the token threshold governs, and
  // the window-scaled hard cap stays as the count-based safety net. A limit
  // the user set is honored as written on every window.
  if (
    options?.implicitDefault &&
    isAboveBaselineContextWindow(options.contextWindow)
  ) {
    return hardCap
  }
  const configuredLimit =
    configSetting !== undefined && configSetting !== 'off'
      ? parseMaxActiveMessagesLimit(configSetting)
      : parseMaxActiveMessagesLimit(envSetting)
  if (configuredLimit > 0 && hardCap > 0) {
    return Math.min(configuredLimit, hardCap)
  }
  return configuredLimit > 0 ? configuredLimit : hardCap
}

export function isAboveMaxActiveMessagesLimit(
  messageCount: number,
  limit = getMaxActiveMessagesHardCap(),
): boolean {
  return limit > 0 && messageCount > limit
}

export function shouldCompactActiveMessageHistory({
  messageCount,
  tokenCount,
  tokenThreshold,
  activeMessageLimit = getMaxActiveMessagesHardCap(),
}: {
  messageCount: number
  tokenCount: number
  tokenThreshold: number
  activeMessageLimit?: number
}): boolean {
  return (
    tokenCount > tokenThreshold ||
    isAboveMaxActiveMessagesLimit(messageCount, activeMessageLimit)
  )
}
