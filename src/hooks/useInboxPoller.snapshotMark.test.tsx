import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../ink.js'
import { type AppState, AppStateProvider } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../utils/envUtils.js'
import { useInboxPoller } from './useInboxPoller.js'

/**
 * Phase 3 item 1 (A): the lead's inbox poller read a lock-free snapshot, did
 * other work, then marked EVERY unread message read — including a message
 * that landed after the snapshot. That message was never submitted and never
 * read again: a teammate's report reached the file and was still lost.
 *
 * The mailbox here is the real one on disk. The only seam is the snapshot
 * read, wrapped so a second message is written right after it, i.e. exactly
 * in the window between the read and the mark.
 */

const MAILBOX_MODULE = '../utils/teammateMailbox.js'
const TEAM = 'alpha'
const LEAD_AGENT_ID = 'lead-agent'

type MailboxModule = typeof import('../utils/teammateMailbox.js')

let actualMailbox: MailboxModule
let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useInboxPoller.snapshotMark.test.tsx')
  actualMailbox = await import(`${MAILBOX_MODULE}?actual=${Date.now()}`)
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-poller-snapshot-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    mock.module(MAILBOX_MODULE, () => ({ ...actualMailbox }))
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function leadState(): AppState {
  return {
    ...getDefaultAppState(),
    teamContext: {
      teamName: TEAM,
      teamFilePath: '',
      leadAgentId: LEAD_AGENT_ID,
      teammates: {
        [LEAD_AGENT_ID]: {
          name: 'team-lead',
          tmuxSessionName: 's',
          tmuxPaneId: '%0',
          cwd: '/tmp',
          spawnedAt: 1_700_000_000_000,
        },
      },
    },
  }
}

function Harness({
  onSubmit,
}: {
  onSubmit: (formatted: string) => void
}): React.ReactNode {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: formatted => {
      onSubmit(formatted)
      return true
    },
  })
  return null
}

async function mountPoller(
  onSubmit: (formatted: string) => void,
): Promise<() => Promise<void>> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider initialState={leadState()}>
      <Harness onSubmit={onSubmit} />
    </AppStateProvider>,
  )
  return async () => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
  }
}

function report(text: string): {
  from: string
  text: string
  timestamp: string
} {
  return { from: 'worker', text, timestamp: new Date().toISOString() }
}

test('a message that lands between the snapshot and the mark stays unread and is delivered by the next poll', async () => {
  await actualMailbox.writeToMailbox('team-lead', report('first report'), TEAM)

  let injected = false
  mock.module(MAILBOX_MODULE, () => ({
    ...actualMailbox,
    readUnreadMailboxEntries: async (agentName: string, teamName?: string) => {
      const snapshot = await actualMailbox.readUnreadMailboxEntries(
        agentName,
        teamName,
      )
      if (!injected) {
        injected = true
        // After the snapshot, before this poll marks anything read.
        await actualMailbox.writeToMailbox(
          agentName,
          report('late report'),
          teamName,
        )
      }
      return snapshot
    },
  }))

  const submitted: string[] = []
  const cleanup = await mountPoller(formatted => submitted.push(formatted))
  try {
    // The mount poll takes the first report; the interval (1s) the next one.
    for (let i = 0; i < 120; i++) {
      if (submitted.length >= 2) break
      await Bun.sleep(25)
    }
    expect(injected).toBe(true)
    expect(submitted).toHaveLength(2)
    expect(submitted[0]).toContain('first report')
    expect(submitted[0]).not.toContain('late report')
    expect(submitted[1]).toContain('late report')

    // Both delivered, both read — once each.
    for (let i = 0; i < 40; i++) {
      const inbox = await actualMailbox.readMailbox('team-lead', TEAM)
      if (inbox.every(m => m.read)) break
      await Bun.sleep(25)
    }
    const inbox = await actualMailbox.readMailbox('team-lead', TEAM)
    expect(inbox.map(m => [m.text, m.read])).toEqual([
      ['first report', true],
      ['late report', true],
    ])
  } finally {
    await cleanup()
  }
})
