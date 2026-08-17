#!/usr/bin/env node
// Codex notify 适配器。Codex 会把 agent-turn-complete JSON 作为命令参数传入。
// 它只发送“完成”生命周期，不转发 last-assistant-message 或 input-messages。
// 示例（写入 Codex config.toml 的 notify）：
//   notify = ["node", "E:/.../scripts/codex-agent-notify.mjs"]

import {
  agentIdentity,
  envValue,
  readJsonInput,
  sendToPet,
  stableEventId,
  surfaceFromEnv,
} from "./agent-event-adapter-utils.mjs";

const input = readJsonInput();
const identity = agentIdentity("codex", "Codex");
const eventType = typeof input.type === "string" ? input.type : "agent-turn-complete";
if (eventType !== "agent-turn-complete") process.exit(0);

const threadId = typeof input["thread-id"] === "string" ? input["thread-id"] : "";
const turnId = typeof input["turn-id"] === "string" ? input["turn-id"] : "";
const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
sendToPet("codex-notify", {
  source: "codex-notify",
  // Codex 的桌面端全局 notify 默认走这里；命令行接入可用环境变量覆盖为 cli。
  surface: surfaceFromEnv("desktop"),
  lifecycle: "completed",
  eventId: stableEventId("codex-notify", eventType, threadId, turnId, cwd, Date.now()),
  sessionId: threadId || undefined,
  turnId: turnId || undefined,
  taskId: turnId || threadId || undefined,
  agentId: identity.agentId,
  displayName: identity.displayName,
  detail: envValue("PENGUIN_CODEX_COMPLETION_DETAIL", "Codex 任务已完成"),
  cwd,
  occurredAt: new Date().toISOString(),
});
