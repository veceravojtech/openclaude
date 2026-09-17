import { expect, test } from 'bun:test'
import { FORK_AGENT } from './forkSubagent.js'

test('a fork sub-agent has no turn cap of its own, like every other sub-agent', () => {
  // Regression: forks stopped at 200 turns while ordinary sub-agents and
  // in-process teammates are bounded only by their context.
  expect((FORK_AGENT as { maxTurns?: number }).maxTurns).toBeUndefined()
})
