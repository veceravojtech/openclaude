import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

// Capture the genuine growthbook module once, through a query-suffixed specifier
// so the capture can never pick up an already-registered mock. A plain
// `import * as … from '../services/analytics/growthbook.js'` binds the LIVE
// namespace, which `mock.module()` mutates in place — restoring from it is a
// no-op that re-installs the killswitch stub. Precedent: src/utils/auth.test.ts:8-10.
const realGrowthbook = (await import(
  `../services/analytics/growthbook.js?fileTestRealGrowthbook=${Date.now()}-${Math.random()}`
)) as typeof import('../services/analytics/growthbook.js')

async function importFileModuleWithKillswitchEnabled(
  killswitchEnabled: boolean,
) {
  mock.module('../services/analytics/growthbook.js', () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: () => killswitchEnabled,
  }))

  return import(`./file.js?ts=${Date.now()}-${Math.random()}`)
}

beforeAll(async () => {
  await acquireSharedMutationLock('utils/file.test.ts')
})

afterAll(() => {
  try {
    // Re-register the genuine module BEFORE mock.restore(): Bun's
    // `mock.restore()` never unregisters a `mock.module()` registration, so the
    // killswitch stub would otherwise outlive this file process-wide.
    mock.module('../services/analytics/growthbook.js', () => ({
      ...realGrowthbook,
    }))
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('addLineNumbers', () => {
  test('uses unambiguous arrow compact prefix and preserves leading tabs', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(false)

    const result = addLineNumbers({
      content: '\tfirst\n\t\tsecond',
      startLine: 41,
    })

    expect(result).toBe('41→\tfirst\n42→\t\tsecond')
  })

  test('keeps padded arrow format when compact mode is disabled', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(true)

    const result = addLineNumbers({
      content: 'alpha\nbeta',
      startLine: 1,
    })

    expect(result).toBe('     1→alpha\n     2→beta')
  })
})

describe('stripLineNumberPrefix', () => {
  test('strips compact arrow, padded arrow, and legacy tab prefixes', async () => {
    const { stripLineNumberPrefix } = await importFileModuleWithKillswitchEnabled(
      false,
    )

    expect(stripLineNumberPrefix('41→\tfirst')).toBe('\tfirst')
    expect(stripLineNumberPrefix('     2→beta')).toBe('beta')
    expect(stripLineNumberPrefix('7\t\tlegacy-tab')).toBe('\tlegacy-tab')
  })
})
