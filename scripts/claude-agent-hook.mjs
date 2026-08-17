#!/usr/bin/env node
// Claude Code Hooks 适配器。Claude hook JSON 从 stdin 传入。
// 建议接入 UserPromptSubmit、Notification、Stop、StopFailure、TaskCompleted。
// 不转发 message、transcript_path 或任何聊天正文。

import {
  agentIdentity,
  envValue,
  readJsonInput,
  sendToPet,
  stableEventId,
  surfaceFromEnv,
} from "./agent-event-adapter-utils.mjs";

const input = readJsonInput();
const hookName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
const notificationType = typeof input.notification_type === "string" ? input.notification_type : "";

const lifecycleByHook = {
  SessionStart: "starting",
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  Stop: "completed",
  StopFailure: "failed",
  TaskCompleted: "completed",
  SessionEnd: "stopped",
};
let lifecycle = lifecycleByHook[hookName];
if (hookName === "Notification") {
  lifecycle = /permission|input|question/i.test(notificationType) ? "needs-input" : "waiting";
}
if (!lifecycle) process.exit(0);

const identity = agentIdentity("claude", "Claude Code");
const detail = lifecycle === "completed"
  ? envValue("PENGUIN_CLAUDE_COMPLETION_DETAIL", "Claude Code 任务已完成")
  : lifecycle === "failed"
    ? "Claude Code 任务失败"
    : lifecycle === "needs-input"
      ? "Claude Code 正在等待输入"
      : lifecycle === "waiting"
        ? "Claude Code 正在等待"
        : "Claude Code 正在处理";

sendToPet("claude-hook", {
  source: "claude-hook",
  surface: surfaceFromEnv(),
  lifecycle,
  eventId: stableEventId("claude-hook", hookName, sessionId, notificationType, cwd, lifecycle === "completed" ? Date.now() : ""),
  sessionId: sessionId || undefined,
  agentId: identity.agentId,
  displayName: identity.displayName,
  detail,
  cwd,
  occurredAt: new Date().toISOString(),
});
