export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- task_id may be a task ID, a teammate's name@team address (the form ListAgents reports), or an unambiguous bare teammate name
- Returns a success or failure status; failures say which one it is (unknown, ambiguous, or a teammate owned by another session)
- Use this tool when you need to terminate a long-running task
`
