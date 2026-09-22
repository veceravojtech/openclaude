import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as realModel from '../../utils/model/model.js'

// The cyber-risk reminder exemption used to be a hardcoded Set of 4.6/4.7/4.8
// ids, so every Opus released after it was written silently lost the exemption
// and took the reminder on every file read that the then-current default did
// not. The floor is version-parsed now: these cases must hold for 5.x AND for
// an Opus that does not exist yet.

const SAVED_DISABLE = process.env.OPENCLAUDE_DISABLE_TOOL_REMINDERS

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/FileReadTool/FileReadTool.mitigationExemption.test.ts',
  )
  delete process.env.OPENCLAUDE_DISABLE_TOOL_REMINDERS
})

afterEach(() => {
  try {
    mock.restore()
    if (SAVED_DISABLE === undefined) {
      delete process.env.OPENCLAUDE_DISABLE_TOOL_REMINDERS
    } else {
      process.env.OPENCLAUDE_DISABLE_TOOL_REMINDERS = SAVED_DISABLE
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function includesMitigationFor(model: string): Promise<boolean> {
  mock.module('../../utils/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => model,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const { shouldIncludeFileReadMitigation } = (await import(
    `./FileReadTool.js?ts=${nonce}`
  )) as typeof import('./FileReadTool.js')
  return shouldIncludeFileReadMitigation()
}

describe('cyber risk mitigation exemption floor', () => {
  test.each([
    ['claude-opus-4-6', 'the original exempt floor'],
    ['claude-opus-4-7', 'an exempt id from the old Set'],
    ['claude-opus-4-8', 'an exempt id from the old Set'],
  ])('%s stays exempt (%s)', async model => {
    expect(await includesMitigationFor(model)).toBe(false)
  })

  test.each([
    ['claude-opus-5', 'Opus 5'],
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-6', 'a major that does not exist yet'],
    ['claude-opus-6-2', 'a future minor'],
  ])('%s is exempt too — %s', async model => {
    // These are exactly the models the hardcoded Set silently dropped.
    expect(await includesMitigationFor(model)).toBe(false)
  })

  test.each([
    ['claude-opus-4-5', 'below the 4.6 floor'],
    ['claude-opus-4-1', 'below the 4.6 floor'],
    ['claude-opus-4', 'below the 4.6 floor'],
    ['claude-3-opus-20240229', 'Claude 3 era, unparseable as a version'],
    ['claude-sonnet-4-6', 'not an Opus at all'],
    ['claude-haiku-4-5', 'not an Opus at all'],
  ])('%s still gets the reminder (%s)', async model => {
    expect(await includesMitigationFor(model)).toBe(true)
  })

  test('the disable-reminders env var still wins over an exempt model', async () => {
    process.env.OPENCLAUDE_DISABLE_TOOL_REMINDERS = '1'
    expect(await includesMitigationFor('claude-opus-4-5')).toBe(false)
  })
})
