import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../ink.js'
import {
  type AppState,
  AppStateProvider,
  useAppStateStore,
} from '../state/AppState.js'
import type { AppStateStore } from '../state/AppStateStore.js'
import {
  CRASH_MATE,
  CRASH_MATE_ID,
  crashLeadState,
  crasherRow,
  expectCleanRelease,
  expectCrashOutcome,
  killPaneAndSweep,
  mailJson,
  registerCrasher,
  setUpPaneCrashFiles,
} from '../test/fixtures/paneCrashWorld.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { PaneTeammateWatchdogHandle } from '../utils/swarm/backends/paneTeammateWatchdog.js'
import type { PanePresence } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  createShutdownApprovedMessage,
  createShutdownRequestMessage,
} from '../utils/teammateMailbox.js'
import { useInboxPoller } from './useInboxPoller.js'

/**
 * The interactive lead's REAL inbox poller, over REAL mailbox files (no
 * module mock), beside the real watchdog and team sweeper of a pane teammate
 * that holds team task #1. Only tmux is injected.
 *
 * The bug: `tmux kill-pane` on a working teammate reached the lead as the
 * same "has shut down … task(s) were unassigned" a requested shutdown gives —
 * no failed notification, no attention item, the task released unheld. The
 * lead must be able to tell the two apart, from evidence, not timing.
 */

let teardownFiles: () => Promise<void>
let watchdog: PaneTeammateWatchdogHandle | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useInboxPoller.paneCrash.test.tsx')
  teardownFiles = (await setUpPaneCrashFiles()).teardown
  watchdog = undefined
})

afterEach(async () => {
  try {
    watchdog?.dispose()
    await teardownFiles()
  } finally {
    releaseSharedMutationLock()
  }
})

function Harness({
  onStore,
}: {
  onStore: (store: AppStateStore) => void
}): React.ReactNode {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: () => true,
  })
  const store = useAppStateStore()
  React.useEffect(() => onStore(store), [store, onStore])
  return null
}

/** Mount the lead's poller over `initialState`; returns its live store. */
async function mountLead(initialState: AppState): Promise<{
  store: AppStateStore
  unmount: () => Promise<void>
}> {
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
  let store: AppStateStore | undefined
  root.render(
    <AppStateProvider initialState={initialState}>
      <Harness
        onStore={next => {
          store = next
        }}
      />
    </AppStateProvider>,
  )
  for (let attempt = 0; attempt < 40 && !store; attempt++) await Bun.sleep(10)
  if (!store) throw new Error('the lead harness never mounted')
  return {
    store,
    async unmount() {
      root.unmount()
      await Bun.sleep(30)
      stdin.end()
      stdout.end()
    },
  }
}

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (cond()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the lead poller + sweep: an UNREQUESTED pane kill is a crash (failed notification, one item, held task), not a shutdown', async () => {
  const pane: { state: PanePresence } = { state: 'present' }
  const lead = await mountLead(crashLeadState(process.cwd()))
  try {
    watchdog = registerCrasher(lead.store.setState, pane)
    // The teammate is mid-turn: it announced itself and nothing else. The
    // poller reads the lead's real inbox the whole time.
    await mailJson(TEAM_LEAD_NAME, CRASH_MATE, {
      type: 'teammate_startup',
      from: CRASH_MATE,
    })
    await watchdog.scan()
    await Bun.sleep(50) // the poller's initial poll runs with nothing to act on
    expect(crasherRow(lead.store.getState()).status).toBe('running')

    await killPaneAndSweep(pane)

    await expectCrashOutcome(lead.store.getState)
  } finally {
    await lead.unmount()
  }
})

test('the lead poller + sweep: a REQUESTED shutdown (request sent, approval in the real inbox) is a clean release', async () => {
  const pane: { state: PanePresence } = { state: 'present' }
  const lead = await mountLead(crashLeadState(process.cwd()))
  try {
    watchdog = registerCrasher(lead.store.setState, pane)
    await mailJson(
      CRASH_MATE,
      TEAM_LEAD_NAME,
      createShutdownRequestMessage({ requestId: 'shutdown-1@crasher', from: TEAM_LEAD_NAME }),
    )
    // No paneId on the approval: the poller would otherwise ask the real
    // tmux backend to kill a pane; the injected pane goes away below instead.
    await mailJson(
      TEAM_LEAD_NAME,
      CRASH_MATE,
      createShutdownApprovedMessage({ requestId: 'shutdown-1@crasher', from: CRASH_MATE }),
    )
    // The poller handles the approval: member removed, tasks released.
    await until(
      () => !(CRASH_MATE_ID in (lead.store.getState().teamContext?.teammates ?? {})),
      'the poller to process the shutdown approval',
    )

    await killPaneAndSweep(pane)

    await expectCleanRelease(lead.store.getState)
    // Retired by the poller's approval branch, as today: completed, not failed.
    expect(crasherRow(lead.store.getState()).status).toBe('completed')
  } finally {
    await lead.unmount()
  }
})
