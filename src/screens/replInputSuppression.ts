/**
 * Whether a keystroke the user just made is text they are typing, rather than
 * a shortcut. Dialogs defer on it, and so do the teammate-tree letter keys
 * ('f'/'k') in useBackgroundTaskNavigation.
 *
 * `isTypingElsewhere` covers the typing surfaces that are NOT the prompt
 * buffer. Ctrl+R history search is one: PromptInput unfocuses the prompt
 * TextInput while `isSearchingHistory` and HistorySearchInput keeps its query
 * in its own local state, so `isPromptInputActive`/`inputValue` both read an
 * active search as an idle prompt. It is optional and defaults to false so
 * callers with no such surface stay unchanged.
 */
export function isPromptTypingSuppressionActive(
  isPromptInputActive: boolean,
  inputValue: string,
  isTypingElsewhere = false,
): boolean {
  return isPromptInputActive || inputValue.trim().length > 0 || isTypingElsewhere
}
