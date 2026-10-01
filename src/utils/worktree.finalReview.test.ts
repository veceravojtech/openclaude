import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  createDetachedReviewWorktree,
  removeDetachedReviewWorktree,
} from './worktree.js'

// Phase 4: the final reviewer's checkout is a clean detached worktree of one
// commit — no branch, no setup copied in, none of the caller's dirty files.

let repo: string
let first: string
let second: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'openclaude-review-repo-')))
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  first = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'second')
  second = git(repo, 'rev-parse', 'HEAD')
  // The caller's dirty state: must never reach the review checkout.
  writeFileSync(join(repo, 'a.txt'), 'uncommitted\n')
  writeFileSync(join(repo, 'untracked.txt'), 'secret\n')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

test('creates a detached checkout at the resolved sha with no dirty or untracked files, then removes it', async () => {
  const wt = await createDetachedReviewWorktree(repo, 'HEAD~1')
  try {
    expect(wt.commit).toBe(first)
    expect(wt.gitRoot).toBe(repo)
    expect(realpathSync(wt.worktreePath)).toBe(wt.worktreePath)
    expect(git(wt.worktreePath, 'rev-parse', 'HEAD')).toBe(first)
    // Detached: no branch.
    expect(git(wt.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(git(wt.worktreePath, 'status', '--short')).toBe('')
    expect(readdirSync(wt.worktreePath).sort()).toEqual(['.git', 'a.txt'])
    expect(
      execFileSync('cat', [join(wt.worktreePath, 'a.txt')], { encoding: 'utf-8' }),
    ).toBe('one\n')
    // The caller's checkout is untouched and no branch was created.
    expect(git(repo, 'branch', '--list').split('\n').length).toBe(1)
  } finally {
    expect(await removeDetachedReviewWorktree(wt)).toBe(true)
  }
  expect(existsSync(wt.worktreePath)).toBe(false)
  expect(existsSync(dirname(wt.worktreePath))).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(git(repo, 'status', '--short')).toContain('untracked.txt')
})

test('a full sha resolves to itself', async () => {
  const wt = await createDetachedReviewWorktree(repo, second)
  try {
    expect(wt.commit).toBe(second)
  } finally {
    await removeDetachedReviewWorktree(wt)
  }
})

test.each(['no-such-ref', '-q', ''])(
  'an unresolvable or option-like ref %p is refused and leaves nothing behind',
  async ref => {
    await expect(createDetachedReviewWorktree(repo, ref)).rejects.toThrow(
      /review_commit/,
    )
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  },
)

test('removing an already-removed checkout reports false and does not throw', async () => {
  const wt = await createDetachedReviewWorktree(repo, 'HEAD')
  expect(await removeDetachedReviewWorktree(wt)).toBe(true)
  expect(await removeDetachedReviewWorktree(wt)).toBe(false)
})
