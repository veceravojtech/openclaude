import React from 'react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { renderToString } from '../../utils/staticRender.js'
import * as realCommandQueue from '../../hooks/useCommandQueue.js'
import { AppStateProvider } from 'src/state/AppState.js'

// Snapshots taken before any mock.module() call. mock.module() mutates the
// live namespace object in place, so restoring from the namespace (or from a
// spread of it) would re-install the stub instead of undoing it.
const pristineRealCommandQueue = { ...realCommandQueue }

describe('PromptInputQueuedCommands', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('components/PromptInput/PromptInputQueuedCommands.test.tsx')
    mock.module('../../hooks/useCommandQueue.js', () => ({
      useCommandQueue: () => [
        {
          value: 'Use another library',
          mode: 'prompt',
        },
      ],
    }))

  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../hooks/useCommandQueue.js', () => ({ ...pristineRealCommandQueue }))
    } finally {
      releaseSharedMutationLock()
    }
  })

  it('shows a next-turn guidance banner for queued prompt messages', async () => {
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(
      <AppStateProvider>
        <PromptInputQueuedCommands />
      </AppStateProvider>,
      100,
    )

    expect(output).toContain('1 message queued for next turn')
    expect(output).toContain('Use another library')
  })
})
