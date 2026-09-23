import { describe, expect, test } from 'bun:test'
import { createCompactBoundaryMessage } from '../../utils/messages/systemFactories.js'

/**
 * A forced compaction previously recorded a bare `trigger: 'auto'`, which is
 * indistinguishable from a normal token-threshold compaction. Diagnosing one
 * from a transcript therefore required reconstructing the whole decision by
 * hand. The boundary must record WHY it fired.
 */
describe('compact boundary records the force reason', () => {
  test('memory-pressure forced compaction records its reason', () => {
    const boundary = createCompactBoundaryMessage(
      'auto',
      402_204,
      undefined,
      undefined,
      undefined,
      'memory-pressure',
    )

    expect(boundary.compactMetadata.forceReason).toBe('memory-pressure')
    // `trigger` keeps its existing meaning so old transcripts stay readable.
    expect(boundary.compactMetadata.trigger).toBe('auto')
    expect(boundary.compactMetadata.preTokens).toBe(402_204)
  })

  test('message-count forced compaction records its reason', () => {
    const boundary = createCompactBoundaryMessage(
      'auto',
      123_456,
      undefined,
      undefined,
      undefined,
      'message-count',
    )

    expect(boundary.compactMetadata.forceReason).toBe('message-count')
  })

  test('an unforced compaction records no reason', () => {
    const boundary = createCompactBoundaryMessage('auto', 950_001)

    expect(boundary.compactMetadata.forceReason).toBeUndefined()
    expect(boundary.compactMetadata.trigger).toBe('auto')
  })

  test('a manual compaction is still trigger=manual with no reason', () => {
    const boundary = createCompactBoundaryMessage('manual', 10_000)

    expect(boundary.compactMetadata.trigger).toBe('manual')
    expect(boundary.compactMetadata.forceReason).toBeUndefined()
  })
})
