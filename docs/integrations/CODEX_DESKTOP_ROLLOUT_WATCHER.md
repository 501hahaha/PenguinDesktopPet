# Codex Desktop automatic task notification

Codex Desktop uses a private app-server process and does not reliably invoke
the CLI `notify` command for the desktop conversation. Penguin therefore also
watches the local Codex rollout directory:

```text
%CODEX_HOME%\sessions\**\*.jsonl
```

`src/main/pet/CodexRolloutWatcher.ts` reads only `session_meta`, task lifecycle
records, and a small allowlist of activity markers. The allowlist includes
`agent_reasoning`, `response_item` reasoning/plan/message/tool records,
`mcp_tool_call_end`, `web_search_end`, and `patch_apply_end`. It emits the same
narrow `codex-app-server` event contract as the pipe bridge, so the pet status,
settings observation row, QQ query, progress brief, completion notice, and
deduplication paths stay unified.

Phase markers update the existing session/turn task instead of creating a new
task. The normalized activity is one of `starting`, `thinking`, `command`,
`editing`, `tool`, `network`, `waiting`, or `response-ready`; fixed detail text
describes the stage without forwarding the underlying reasoning, command
arguments, tool output, file paths, or message text. This keeps the scheduled
QQ brief on the current Codex phase rather than repeating the initial "task
started" detail indefinitely.

Each Codex session/turn is tracked as its own task. The settings page and pet
status indicator retain multiple simultaneous tasks and show counts for active,
waiting-for-input, completed, and abnormal states. Completion events from the
same snapshot are queued so no task completion is silently overwritten or
skipped; the initial snapshot is only a baseline and does not replay old
completion notices.

The watcher ignores prompts, assistant messages, tool output, cwd, and other
transcript content. It starts with the Electron main process, stops during
shutdown, and uses interval scanning as a fallback for Windows file watcher
limitations.

Completion notices use one shared display formatter. A generic terminal detail
such as `Codex 桌面端 任务已完成` is omitted when the surrounding notice already
says `已完成一个任务`; diagnostic failure details are preserved.

The latest bot conversation target is stored locally in
`agent-notification-target.json` and restored after restart. Completion notices
are sent to that target automatically. A task started directly from the desktop
with no known bot conversation still produces the local pet notice; there is no
safe remote recipient until the user has started at least one bot conversation.

QQ also consumes the same task snapshot through two bounded paths:

- Queries that explicitly ask about Codex/Desktop tasks, progress, or status are
  answered from the local snapshot instead of being delegated to the Agent, so
  the response cannot invent a current task.
- When a confirmed Codex Desktop task is running and the configured notification
  target exists, the
  existing long-task scheduler sends the configured progress brief. A changed
  phase/detail is preferred and is rate-limited to one update per 15 seconds;
  unchanged state uses exponential backoff from the configured base interval
  (`1x`, `2x`, `4x`, ...), capped at 15 minutes. A phase/detail change resets
  the backoff. The brief uses the event-backed start time and stops when the
  task reaches a terminal state. Process-only observations never start a remote
  brief.
- The persisted latest bot target is restored into the progress scheduler at
  startup, so an already-running Codex Desktop task can continue reporting
  after the pet restarts without requiring a new QQ message first.

The notification outlet is configurable in the Bot Center. It defaults to QQ,
and can be switched to a configured WeChat, Feishu, or DingTalk bot. Each
platform keeps its own latest valid conversation target; changing the outlet
does not change ordinary chat routing and never silently falls back to another
platform. A platform must have a connected bot and at least one received
message before it can receive Codex task notifications.
