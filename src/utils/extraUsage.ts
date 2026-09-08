import { isOpusAtLeast } from './model/opusVersion.js'
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'

export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
  isOpus1mMerged: boolean,
): boolean {
  if (!isClaudeAISubscriber()) return false
  if (isFastMode) return true
  if (model === null || !has1mContext(model)) return false

  const m = model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .trim()
  // Keep this in sync with the Opus families modelSupports1M recognizes — the
  // first-party default is now claude-opus-4-8, and 4.7 is the 3P default.
  const isOpus = m === 'opus' || isOpusAtLeast(m, 4, 6)
  const isSonnet46 = m === 'sonnet' || m.includes('sonnet-4-6')

  if (isOpus && isOpus1mMerged) return false

  return isOpus || isSonnet46
}
