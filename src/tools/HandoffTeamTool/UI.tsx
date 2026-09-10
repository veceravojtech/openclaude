import React from 'react'
import { jsonParse } from '../../utils/slowOperations.js'
import type { Input, Output } from './HandoffTeamTool.js'

export function renderToolUseMessage(_input: Partial<Input>): React.ReactNode {
  return 'hand the sub-team to a fresh successor'
}

export function renderToolResultMessage(
  content: Output | string,
  _progressMessages: unknown,
  { verbose: _verbose }: { verbose: boolean },
): React.ReactNode {
  const result: Output =
    typeof content === 'string' ? jsonParse(content) : content
  return result.message
}
