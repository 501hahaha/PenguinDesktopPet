#!/usr/bin/env node
// 兼容已有 Codex notify：保留 Codex 内置结束处理，同时把同一个完成事件
// 转发给 PenguinDesktopPet。Codex 会把通知 JSON 追加为最后一个参数。
// 用法：node codex-notify-multiplexer.mjs <原通知命令> <原固定参数...> <notify-json>

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const payloadIndex = [...args].reverse().findIndex((value) => {
  const text = String(value ?? "").trim();
  return text.startsWith("{") && text.endsWith("}");
});
const payloadPosition = payloadIndex < 0 ? -1 : args.length - 1 - payloadIndex;
const payload = payloadPosition >= 0 ? args[payloadPosition] : undefined;
const delegateArgs = payloadPosition >= 0 ? args.slice(1, payloadPosition) : args.slice(1);
const delegateCommand = args[0];

let delegateExit = 0;
if (delegateCommand) {
  const result = spawnSync(delegateCommand, [...delegateArgs, ...(payload ? [payload] : [])], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  if (typeof result.status === "number") delegateExit = result.status;
  else if (result.error) delegateExit = 1;
}

if (payload) {
  const sender = fileURLToPath(new URL("./codex-agent-notify.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [sender, payload], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    timeout: 2_500,
    killSignal: "SIGTERM",
  });
  // 事件桥是旁路通知，不能让它的失败阻断 Codex 原有 notify。
  if (delegateExit === 0 && process.env.PENGUIN_AGENT_BRIDGE_REQUIRED === "1" && (result.error || result.status !== 0)) delegateExit = 1;
}

process.exitCode = delegateExit;
