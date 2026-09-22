import { afterEach, beforeEach, expect, test } from 'bun:test'

import { getVertexRegionForModel } from './envUtils.js'

const VERTEX_ENV_KEYS = [
  'CLOUD_ML_REGION',
  'VERTEX_REGION_CLAUDE_5_0_OPUS',
  'VERTEX_REGION_CLAUDE_5_5_OPUS',
] as const

const SAVED: Partial<Record<(typeof VERTEX_ENV_KEYS)[number], string>> = {}

beforeEach(() => {
  for (const key of VERTEX_ENV_KEYS) {
    SAVED[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of VERTEX_ENV_KEYS) {
    const saved = SAVED[key]
    if (saved === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved
    }
  }
})

test('claude-opus-5-5 reads its own Vertex region override', () => {
  process.env.VERTEX_REGION_CLAUDE_5_5_OPUS = 'europe-west1'
  expect(getVertexRegionForModel('claude-opus-5-5')).toBe('europe-west1')
})

// Regression: VERTEX_REGION_OVERRIDES is scanned in order with startsWith, and
// 'claude-opus-5-5'.startsWith('claude-opus-5') is true. If the 5.5 row is ever
// moved below the 5.0 row, 5.5 silently inherits the 5.0 region with no error.
test('claude-opus-5-5 does not inherit the Opus 5.0 Vertex region', () => {
  process.env.VERTEX_REGION_CLAUDE_5_0_OPUS = 'us-west4'
  expect(getVertexRegionForModel('claude-opus-5-5')).not.toBe('us-west4')
  expect(getVertexRegionForModel('claude-opus-5-5')).toBe('us-east5')
  // The 5.0 row itself still resolves, so the new row did not shadow it.
  expect(getVertexRegionForModel('claude-opus-5')).toBe('us-west4')
})

test('each Opus 5 variant honours its own override independently', () => {
  process.env.VERTEX_REGION_CLAUDE_5_0_OPUS = 'us-west4'
  process.env.VERTEX_REGION_CLAUDE_5_5_OPUS = 'europe-west1'
  expect(getVertexRegionForModel('claude-opus-5')).toBe('us-west4')
  expect(getVertexRegionForModel('claude-opus-5-5')).toBe('europe-west1')
})
