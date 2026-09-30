import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  resetAtomicReplaceFaultInjectorForTesting,
  setAtomicReplaceFaultInjectorForTesting,
} from './atomicReplace.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import * as lockfile from './lockfile.js'
import {
  clearMailbox,
  getInboxPath,
  markMailboxEntriesAsRead,
  readMailbox,
  readUnreadMailboxEntries,
  writeToMailbox,
} from './teammateMailbox.js'

/**
 * Phase 3 item 1: a teammate's report must not be lost between the file and
 * the lead. Covers the three mailbox-level causes: marking messages read that
 * were never seen (A), silent write failures (B), and torn writes seen by the
 * lock-free readers.
 */

const TEAM = 'delivery'
const LEAD = 'team-lead'

let configDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('utils/teammateMailbox.delivery.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'openclaude-mailbox-delivery-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(() => {
  try {
    resetAtomicReplaceFaultInjectorForTesting()
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function mail(text: string, from = 'worker') {
  return { from, text, timestamp: new Date().toISOString() }
}

function inboxDirEntries(): string[] {
  return readdirSync(dirname(getInboxPath(LEAD, TEAM))).sort()
}

test('marking a snapshot leaves a message that arrived after it unread', async () => {
  await writeToMailbox(LEAD, mail('first'), TEAM)
  const snapshot = await readUnreadMailboxEntries(LEAD, TEAM)
  await writeToMailbox(LEAD, mail('late'), TEAM)

  await markMailboxEntriesAsRead(LEAD, TEAM, snapshot)

  expect((await readMailbox(LEAD, TEAM)).map(m => [m.text, m.read])).toEqual([
    ['first', true],
    ['late', false],
  ])
})

test('an identical twin written after the snapshot is not marked with it', async () => {
  // Same sender, text and timestamp: a content key alone cannot tell these
  // apart, the index can.
  const twin = mail('build is red')
  await writeToMailbox(LEAD, twin, TEAM)
  const snapshot = await readUnreadMailboxEntries(LEAD, TEAM)
  await writeToMailbox(LEAD, twin, TEAM)

  await markMailboxEntriesAsRead(LEAD, TEAM, snapshot)

  expect((await readMailbox(LEAD, TEAM)).map(m => m.read)).toEqual([
    true,
    false,
  ])
})

test('an index whose message changed since the snapshot is left unread', async () => {
  // The inbox was rewritten in between (cleared, team re-created): index 0 now
  // holds a message the reader never saw. A bare index would mark it.
  await writeToMailbox(LEAD, mail('old'), TEAM)
  const snapshot = await readUnreadMailboxEntries(LEAD, TEAM)
  await clearMailbox(LEAD, TEAM)
  await writeToMailbox(LEAD, mail('new, unseen'), TEAM)

  await markMailboxEntriesAsRead(LEAD, TEAM, snapshot)

  expect((await readMailbox(LEAD, TEAM)).map(m => [m.text, m.read])).toEqual([
    ['new, unseen', false],
  ])
})

test('clearMailbox really empties the inbox', async () => {
  await writeToMailbox(LEAD, mail('a long message '.repeat(20)), TEAM)
  await clearMailbox(LEAD, TEAM)
  expect(readFileSync(getInboxPath(LEAD, TEAM), 'utf-8')).toBe('[]')
})

test('an inbox rewrite goes through a temp file and a rename, so a lock-free reader never sees a partial array', async () => {
  await writeToMailbox(LEAD, mail('first'), TEAM)
  const inboxPath = getInboxPath(LEAD, TEAM)

  const seenAtRename: Array<{ tempPath?: string; inbox: unknown }> = []
  setAtomicReplaceFaultInjectorForTesting((stage, context) => {
    if (stage !== 'rename' || context.targetPath !== inboxPath) return
    // The replacement is fully written to the temp file, the inbox is not yet
    // touched: a reader here parses the OLD array, whole.
    seenAtRename.push({
      tempPath: context.tempPath,
      inbox: JSON.parse(readFileSync(inboxPath, 'utf-8')),
    })
  })

  await writeToMailbox(LEAD, mail('second'), TEAM)
  const snapshot = await readUnreadMailboxEntries(LEAD, TEAM)
  await markMailboxEntriesAsRead(LEAD, TEAM, snapshot)

  expect(seenAtRename).toHaveLength(2)
  expect(seenAtRename[0]!.tempPath).toStartWith(dirname(inboxPath))
  expect(
    (seenAtRename[0]!.inbox as Array<{ text: string }>).map(m => m.text),
  ).toEqual(['first'])
  expect(
    (seenAtRename[1]!.inbox as Array<{ read: boolean }>).map(m => m.read),
  ).toEqual([false, false])
  expect((await readMailbox(LEAD, TEAM)).map(m => m.read)).toEqual([
    true,
    true,
  ])
  // No temp file left behind.
  expect(inboxDirEntries()).toEqual([`${LEAD}.json`])
})

test('a write that fails midway rejects, leaves the inbox intact and cleans up its temp file', async () => {
  await writeToMailbox(LEAD, mail('first'), TEAM)
  const inboxPath = getInboxPath(LEAD, TEAM)
  setAtomicReplaceFaultInjectorForTesting((stage, context) => {
    if (stage === 'stream-write' && context.targetPath === inboxPath) {
      throw new Error('ENOSPC: no space left on device')
    }
  })

  await expect(writeToMailbox(LEAD, mail('lost?'), TEAM)).rejects.toThrow(
    'ENOSPC',
  )

  resetAtomicReplaceFaultInjectorForTesting()
  expect((await readMailbox(LEAD, TEAM)).map(m => m.text)).toEqual(['first'])
  expect(inboxDirEntries()).toEqual([`${LEAD}.json`])
})

test('writeToMailbox rejects when the inbox lock cannot be acquired, instead of reporting nothing', async () => {
  await writeToMailbox(LEAD, mail('first'), TEAM)
  const inboxPath = getInboxPath(LEAD, TEAM)
  const release = await lockfile.lock(inboxPath, {
    lockfilePath: `${inboxPath}.lock`,
  })
  try {
    await expect(writeToMailbox(LEAD, mail('second'), TEAM)).rejects.toThrow()
  } finally {
    await release()
  }
  expect((await readMailbox(LEAD, TEAM)).map(m => m.text)).toEqual(['first'])
})
