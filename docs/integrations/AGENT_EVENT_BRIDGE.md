# Agent 事件桥接入说明

桌宠运行后会监听本机事件桥：

```text
Windows: \\.\pipe\penguin-pet-agent-events
```

宿主必须主动发出生命周期事件。桌宠不抓取窗口、聊天正文或私有会话数据。

## Codex

当前项目提供复用器，避免覆盖 Codex 原有的 `codex-computer-use` 完成处理。配置形式为：

```toml
notify = ["<NODE_EXECUTABLE>", "<PROJECT_DIR>/scripts/codex-notify-multiplexer.mjs", "<原 notify 命令>", "<原固定参数>"]
```

当前机器已经完成配置：复用原来的 `codex-computer-use.exe turn-ended`，并转发 `agent-turn-complete` 完成事件。不会发送 `last-assistant-message` 或 `input-messages` 到桌宠。

## Claude Code

在现有 Claude Code Hooks 中使用：

```text
node <PROJECT_DIR>/scripts/claude-agent-hook.mjs
```

建议覆盖 `UserPromptSubmit`、`Notification`、`Stop`、`StopFailure`、`TaskCompleted`。适配器从 stdin 读取 hook JSON，把它转换为运行、等待输入、完成或失败事件。

## 宿主标识

可在宿主进程环境设置：

```text
PENGUIN_AGENT_SURFACE=desktop | vscode | cli
PENGUIN_AGENT_ID=<agent-id>
PENGUIN_AGENT_NAME=<display-name>
```

## Companion Bridge delegation and follow-up messages

An online desktop or VS Code Companion Bridge may register `dispatch`, `observe`, `result`, and `input` capabilities. After `/delegate <workspace>: <task>`, the pet sends an authenticated local bridge frame:

```json
{"type":"dispatch","requestId":"request:<id>","taskId":"delegation:<id>","title":"task title","instruction":"task instruction","workspaceId":"workspace:<id>"}
```

Follow-up messages from the same bot conversation reuse `taskId` and, when known, `sessionId`:

```json
{"type":"message","requestId":"request:<next-id>","taskId":"delegation:<id>","sessionId":"<session-id>","message":"follow-up","workspaceId":"workspace:<id>"}
```

The `message` frame is sent only through the authenticated local named pipe/user socket and is not written to ordinary logs or settings data. A desktop/VS Code Companion must actually handle this frame and advertise `input`; an observation-only endpoint is explicitly rejected for follow-up delivery.


手动验证：

```powershell
node scripts/agent-event-bridge.mjs --source manual-test '{"eventId":"manual-1","agentId":"codex","surface":"desktop","lifecycle":"completed","taskId":"task-1","displayName":"Codex 桌面端","detail":"任务已完成"}'
```

## VS Code endpoint contract

Companion endpoints should register with `endpointId`, `agentId`, `displayName`, `kind`, `surface`, `hostId`, optional `workspaceId`/`workspaceLabel`, and a capability list. Send `heartbeat` with the same `endpointId` and `hostId`; send `unregister` before shutdown when possible. The bridge reports `degraded` while the local listener is unavailable or before it reaches `listening`.

Lifecycle events should carry the same endpoint identity plus `sessionId`, `taskId`, and `requestId` when available. The task observer marks events as `matched` only when the endpoint is registered, `unmatched` when the worker event has no registered endpoint, and `discovered` for process/registry observations. Process presence alone is never treated as active work.
