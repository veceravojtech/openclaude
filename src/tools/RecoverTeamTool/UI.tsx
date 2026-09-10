import React from 'react'
import { jsonParse } from '../../utils/slowOperations.js'
import type { Input, Output } from './RecoverTeamTool.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return input.team_name
    ? `recover team: ${input.action} ${input.team_name}`
    : `recover team: ${input.action ?? 'list'}`
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
