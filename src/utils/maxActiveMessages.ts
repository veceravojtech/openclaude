export const DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP = 1000

// Context window the message-count defaults were tuned for (#1949): the
// MODEL_CONTEXT_WINDOW_DEFAULT of utils/context.ts, inlined so this module
// stays import-free. A model with a larger window gets proportionally more
// messages before the count-based guards fire — otherwise a 1M session is
// compacted at ~200k, a fifth of its budget.
const BASELINE_CONTEXT_WINDOW = 200_000

type MaxActiveMessagesEnv = Record<string, string | undefined>

/**
 * Scale a message limit that the user did not choose explicitly to the model's
 * context window. Limits at or below the baseline window are returned as-is,
 * as are disabled (0) limits and limits the user set by hand.
 */
export function scaleActiveMessageLimitToContextWindow(
  limit: number,
  contextWindow: number | undefined,
): number {
  if (limit <= 0 || contextWindow === undefined) {
    return limit
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= BASELINE_CONTEXT_WINDOW) {
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
    // Model context window, used to scale the window-agnostic defaults.
    contextWindow?: number
    // Set when configSetting is the implicit default rather than a value the
    // user chose, so only the default is scaled to contextWindow.
    scaleDefault?: boolean
  },
): number {
  const configuredLimit =
    configSetting !== undefined && configSetting !== 'off'
      ? parseMaxActiveMessagesLimit(configSetting)
      : parseMaxActiveMessagesLimit(envSetting)
  const scaledLimit = options?.scaleDefault
    ? scaleActiveMessageLimitToContextWindow(
        configuredLimit,
        options.contextWindow,
      )
    : configuredLimit
  const hardCap = getMaxActiveMessagesHardCap(
    process.env,
    options?.contextWindow,
  )
  if (scaledLimit > 0 && hardCap > 0) {
    return Math.min(scaledLimit, hardCap)
  }
  return scaledLimit > 0 ? scaledLimit : hardCap
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
