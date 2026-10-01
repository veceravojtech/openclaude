import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attentionDirIn,
  attentionPathIn,
  classifyFailureText,
  createAttentionItemIn,
  decideAttentionItemIn,
  failureItemId,
  isHoldActiveIn,
  listAttentionItemsIn,
  listUndecidedAttentionItemsIn,
  type NewAttentionItem,
  readAttentionItemIn,
  supersedeAttentionItemIn,
} from './attentionItemStore.js'

// Phase 5: the store behind attention items. Pure (tasksDir passed in), so
// these tests need no task list and no config home.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openclaude-attention-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function failure(overrides: Partial<NewAttentionItem> = {}): NewAttentionItem {
  return {
    id: failureItemId('t1', 0),
    kind: 'failure',
    source: { taskId: 't1', backend: 'local_agent' },
    summary: 'worker failed: boom',
    transient: true,
    transientReason: 'provider rate limit',
    retryKey: 'task:t1',
    ...overrides,
  }
}

describe('create', () => {
  test('exactly once: concurrent creates of one id write one item', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createAttentionItemIn(dir, failure({ summary: `attempt ${i}` })),
      ),
    )
    expect(results.filter(r => r.created)).toHaveLength(1)
    const winner = results.find(r => r.created)!.item!
    // Losers get the item that won, not their own.
    for (const r of results) expect(r.item?.summary).toBe(winner.summary)
    const files = readdirSync(attentionDirIn(dir))
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1)
    expect(files.some(f => f.includes('.tmp.'))).toBe(false)
    expect(await listUndecidedAttentionItemsIn(dir)).toHaveLength(1)
  })

  test('a repeat create after a decision does not reopen the item', async () => {
    await createAttentionItemIn(dir, failure())
    await decideAttentionItemIn(dir, failure().id, { choice: 'continue', reason: 'fine' })
    const again = await createAttentionItemIn(dir, failure())
    expect(again.created).toBe(false)
    expect(again.item?.status).toBe('decided')
  })

  test('ids that sanitize alike get separate files', async () => {
    await createAttentionItemIn(dir, failure({ id: 'verdict-a/b' }))
    await createAttentionItemIn(dir, failure({ id: 'verdict-a:b' }))
    expect(attentionPathIn(dir, 'verdict-a/b')).not.toBe(attentionPathIn(dir, 'verdict-a:b'))
    expect((await listAttentionItemsIn(dir)).map(i => i.id).sort()).toEqual([
      'verdict-a/b',
      'verdict-a:b',
    ])
  })

  test('the retry cap: a transient failure on an already-retried key is created non-transient', async () => {
    await createAttentionItemIn(dir, failure())
    await decideAttentionItemIn(dir, failure().id, { choice: 'retry', reason: 'flaky provider' })
    const second = await createAttentionItemIn(dir, failure({ id: failureItemId('t1', 1) }))
    expect(second.created).toBe(true)
    expect(second.item?.transient).toBe(false)
    expect(second.item?.transientReason).toContain('retry already used')
    // A different worker is not capped.
    const other = await createAttentionItemIn(
      dir,
      failure({ id: failureItemId('t2', 0), retryKey: 'task:t2' }),
    )
    expect(other.item?.transient).toBe(true)
  })
})

describe('decide', () => {
  test('one decision wins under contention; the rest are rejected as already decided', async () => {
    await createAttentionItemIn(dir, failure())
    const choices = ['retry', 'patch', 'continue', 'abort', 'continue', 'patch'] as const
    const settled = await Promise.allSettled(
      choices.map(choice =>
        decideAttentionItemIn(dir, failure().id, {
          choice,
          reason: `decided ${choice}`,
          ...(choice === 'patch' ? { rootCause: 'spec' as const } : {}),
        }),
      ),
    )
    const won = settled.filter(s => s.status === 'fulfilled')
    expect(won).toHaveLength(1)
    const stored = await readAttentionItemIn(dir, failure().id)
    expect(stored?.status).toBe('decided')
    const winner = (won[0] as PromiseFulfilledResult<{ decision?: { choice: string } }>).value
    expect(String(stored?.decision?.choice)).toBe(winner.decision!.choice)
    for (const s of settled) {
      if (s.status === 'rejected') {
        expect(String(s.reason)).toContain(`already decided: ${stored!.decision!.choice}`)
      }
    }
  })

  test('a second decision is rejected and changes nothing', async () => {
    await createAttentionItemIn(dir, failure())
    await decideAttentionItemIn(dir, failure().id, { choice: 'continue', reason: 'accepted' })
    await expect(
      decideAttentionItemIn(dir, failure().id, { choice: 'abort', reason: 'changed my mind' }),
    ).rejects.toThrow('already decided: continue')
    expect((await readAttentionItemIn(dir, failure().id))?.decision?.reason).toBe('accepted')
  })

  test('retry is refused on a non-transient item; patch needs a root cause; reason must be non-empty', async () => {
    await createAttentionItemIn(dir, failure({ transient: false, transientReason: 'authentication failure' }))
    await expect(
      decideAttentionItemIn(dir, failure().id, { choice: 'retry', reason: 'try again' }),
    ).rejects.toThrow(/not a transient failure \(authentication failure\)/)
    await expect(
      decideAttentionItemIn(dir, failure().id, { choice: 'patch', reason: 'fix' }),
    ).rejects.toThrow(/root_cause/)
    await expect(
      decideAttentionItemIn(dir, failure().id, { choice: 'continue', reason: '   ' }),
    ).rejects.toThrow(/non-empty reason/)
    // None of the refusals decided it.
    expect((await readAttentionItemIn(dir, failure().id))?.status).toBe('undecided')
    const decided = await decideAttentionItemIn(dir, failure().id, {
      choice: 'patch',
      reason: 'the spec named the wrong file',
      rootCause: 'spec',
    })
    expect(decided.decision).toMatchObject({ choice: 'patch', rootCause: 'spec' })
  })

  test('retry is refused when the same worker was already retried by another item', async () => {
    // Both failures exist (undecided) before either is retried: the cap is
    // re-checked at decision time, not only at creation.
    await createAttentionItemIn(dir, failure())
    await createAttentionItemIn(dir, failure({ id: failureItemId('t1', 1) }))
    await decideAttentionItemIn(dir, failure().id, { choice: 'retry', reason: 'flaky' })
    await expect(
      decideAttentionItemIn(dir, failureItemId('t1', 1), { choice: 'retry', reason: 'flaky again' }),
    ).rejects.toThrow(/already retried once/)
  })

  test('deciding a missing item fails clearly', async () => {
    await expect(
      decideAttentionItemIn(dir, 'failure-nope-0', { choice: 'continue', reason: 'x' }),
    ).rejects.toThrow("No attention item 'failure-nope-0'")
  })
})

describe('supersede and holds', () => {
  test('supersede marks an undecided item and never touches a decided one', async () => {
    await createAttentionItemIn(dir, failure())
    await createAttentionItemIn(dir, failure({ id: 'failure-t9-0' }))
    await decideAttentionItemIn(dir, 'failure-t9-0', { choice: 'continue', reason: 'ok' })
    expect(await supersedeAttentionItemIn(dir, failure().id, 'late-completion')).toBe(true)
    expect(await supersedeAttentionItemIn(dir, 'failure-t9-0', 'late-completion')).toBe(false)
    expect(await supersedeAttentionItemIn(dir, 'failure-missing-0', 'late-completion')).toBe(false)
    expect(await readAttentionItemIn(dir, failure().id)).toMatchObject({
      status: 'superseded',
      supersededReason: 'late-completion',
    })
    expect((await readAttentionItemIn(dir, 'failure-t9-0'))?.status).toBe('decided')
    await expect(
      decideAttentionItemIn(dir, failure().id, { choice: 'continue', reason: 'x' }),
    ).rejects.toThrow(/superseded/)
  })

  test('a hold counts only while its item is undecided', async () => {
    expect(await isHoldActiveIn(dir, { attentionHold: failure().id })).toBeUndefined()
    await createAttentionItemIn(dir, failure())
    expect(await isHoldActiveIn(dir, { attentionHold: failure().id })).toBe(failure().id)
    expect(await isHoldActiveIn(dir, {})).toBeUndefined()
    await decideAttentionItemIn(dir, failure().id, { choice: 'continue', reason: 'ok' })
    expect(await isHoldActiveIn(dir, { attentionHold: failure().id })).toBeUndefined()
  })
})

describe('reading', () => {
  test('malformed, partial and foreign files are skipped, not fatal', async () => {
    await createAttentionItemIn(dir, failure())
    const d = attentionDirIn(dir)
    writeFileSync(join(d, 'garbage-000000000000.json'), '{not json')
    writeFileSync(join(d, 'wrong-shape-000000000000.json'), JSON.stringify({ id: 'x', kind: 'nope' }))
    writeFileSync(join(d, 'empty-000000000000.json'), '')
    writeFileSync(join(d, 'notes.txt'), 'ignored')
    mkdirSync(join(d, 'subdir.json'))
    const items = await listAttentionItemsIn(dir)
    expect(items.map(i => i.id)).toEqual([failure().id])
    // A file at an item's path whose embedded id differs is not that item.
    writeFileSync(attentionPathIn(dir, 'gap-r1'), JSON.stringify({ ...failure(), status: 'undecided', createdAt: 'x' }))
    expect(await readAttentionItemIn(dir, 'gap-r1')).toBeUndefined()
  })

  test('no store yet: list is empty', async () => {
    expect(await listAttentionItemsIn(join(dir, 'nope'))).toEqual([])
  })
})

test('classifyFailureText: rate limit and quota are transient; auth and unknown are not', () => {
  expect(classifyFailureText('429 Too Many Requests').transient).toBe(true)
  expect(classifyFailureText('Rate limit reached').transient).toBe(true)
  expect(classifyFailureText('You exceeded your current quota').transient).toBe(true)
  expect(classifyFailureText('OAuth token has been revoked').transient).toBe(false)
  expect(classifyFailureText('TypeError: x is undefined').transient).toBe(false)
  expect(classifyFailureText(undefined).transient).toBe(false)
})
