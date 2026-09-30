import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  initTaskOutput,
} from '../../utils/task/diskOutput.js'

/**
 * Test helper: point the task-output dir at a fresh temp dir and create
 * `taskId`'s output file there, so a notification advertises <output-file>
 * (it only does when the file exists). Pending output ops from earlier tests
 * are drained first — a late transcript symlink would race the create.
 * Returns the restore function; await it in `finally`.
 */
export async function withTaskOutputFile(
  taskId: string,
): Promise<() => Promise<void>> {
  await _clearOutputsForTest()
  const originalTmpDir = process.env.CLAUDE_CODE_TMPDIR
  const root = await mkdtemp(join(tmpdir(), 'openclaude-task-output-'))
  process.env.CLAUDE_CODE_TMPDIR = root
  getClaudeTempDir.cache?.clear?.()
  _resetTaskOutputDirForTest()
  await initTaskOutput(taskId)
  return async () => {
    await _clearOutputsForTest()
    if (originalTmpDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
    else process.env.CLAUDE_CODE_TMPDIR = originalTmpDir
    getClaudeTempDir.cache?.clear?.()
    _resetTaskOutputDirForTest()
    await rm(root, { recursive: true, force: true })
  }
}
