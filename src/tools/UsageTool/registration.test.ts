import { afterAll, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import { USAGE_TOOL_NAME } from './constants.js'

await acquireSharedMutationLock('tools/UsageTool/registration.test.ts')

afterAll(() => {
  releaseSharedMutationLock()
})

test('UsageTool is part of the base tool pool', () => {
  expect(getAllBaseTools().map(tool => tool.name)).toContain(USAGE_TOOL_NAME)
})

test('UsageTool is usable without special permissions or conditions', () => {
  const permissionContext = getEmptyToolPermissionContext()
  const tools = getTools(permissionContext).map(tool => tool.name)
  expect(tools).toContain(USAGE_TOOL_NAME)

  const usage = getTools(permissionContext).find(
    tool => tool.name === USAGE_TOOL_NAME,
  )
  expect(usage?.isReadOnly({})).toBe(true)
})
