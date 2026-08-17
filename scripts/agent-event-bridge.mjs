#!/usr/bin/env node
// 本地 Agent 事件桥发送器：向 PenguinDesktopPet 的命名管道/Unix Socket
// 推送一条脱敏生命周期事件，供 Codex notify、Claude hooks 与手动测试复用。
//
// 用法：
//   node scripts/agent-event-bridge.mjs --source codex-notify '{"eventId":"e1","agentId":"codex","lifecycle":"running"}'
//   echo '{"eventId":"e2","agentId":"codex","lifecycle":"completed"}' | node scripts/agent-event-bridge.mjs --source codex-notify
//   node scripts/agent-event-bridge.mjs --source manual-test --endpoint "\\.\pipe\penguin-pet-agent-events" @event.json
//
// 选项：
//   --source <codex-notify|codex-app-server|claude-hook|manual-test>  设置/覆盖事件来源
//   --endpoint <path>                                                 覆盖本地端点（默认按平台取管道或 Socket）
//   --help                                                            显示本说明
//
// 退出码：0 = 已投递（含被去重的重复事件）；1 = 输入非法、被服务端拒绝或投递失败。
// 本脚本永不打印载荷内容；成功时静默，失败原因输出到 stderr。

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeToken } from "./agent-event-adapter-utils.mjs";

const PIPE_NAME = "\\\\.\\pipe\\penguin-pet-agent-events";
const SOCKET_BASENAME = "penguin-pet-agent-events";
const CONNECT_TIMEOUT_MS = 5_000;
const ACK_TIMEOUT_MS = 5_000;
const SOURCES = new Set(["codex-notify", "codex-app-server", "claude-hook", "manual-test"]);

function fail(message) {
  console.error(`agent-event-bridge: ${message}`);
  process.exit(1);
}

function defaultEndpoint() {
  if (process.platform === "win32") return PIPE_NAME;
  const base = (process.env.XDG_RUNTIME_DIR ?? "").trim() || tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return join(base, `${SOCKET_BASENAME}${uid ? `-${uid}` : ""}.sock`);
}

function parseArgs(argv) {
  const args = { source: undefined, endpoint: process.env.PENGUIN_AGENT_BRIDGE_ENDPOINT, payloadArg: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--source") {
      args.source = argv[++index];
      if (!args.source) fail("--source requires a value");
      if (!SOURCES.has(args.source)) fail(`unsupported source \"${args.source}\"`);
    } else if (arg === "--endpoint") {
      args.endpoint = argv[++index];
      if (!args.endpoint) fail("--endpoint requires a value");
    } else if (arg === "-") {
      args.payloadArg = arg;
    } else if (arg.startsWith("-")) {
      fail(`unknown option \"${arg}\" (see --help)`);
    } else {
      args.payloadArg = arg;
    }
  }
  return args;
}

function readPayload(payloadArg) {
  let text = "";
  if (payloadArg === undefined || payloadArg === "-") text = readFileSync(0, "utf8").trim();
  else if (payloadArg.startsWith("@")) text = readFileSync(payloadArg.slice(1), "utf8").trim();
  else text = payloadArg.trim();
  if (!text) fail("no payload: pass inline JSON, @file, or pipe stdin");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("payload is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) fail("payload must be a single JSON object");
  return payload;
}

function deliver(endpoint, payload, source) {
  const token = bridgeToken();
  if (!token) fail("missing bridge authentication; set PENGUIN_AGENT_BRIDGE_TOKEN or PENGUIN_AGENT_BRIDGE_TOKEN_FILE");
  const body = source === undefined ? payload : { ...payload, source };
  const frame = `${JSON.stringify(body)}\n`;
  const socket = connect({ path: endpoint });
  let ackBuffer = "";
  const timeout = setTimeout(() => {
    socket.destroy();
    fail(`no response from bridge at ${endpoint} (is PenguinDesktopPet running?)`);
  }, CONNECT_TIMEOUT_MS + ACK_TIMEOUT_MS);

  socket.on("error", (error) => {
    clearTimeout(timeout);
    fail(`cannot reach bridge at ${endpoint}: ${error.message}`);
  });
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
    let authenticated = false;
    socket.on("data", (chunk) => {
      ackBuffer += String(chunk);
      while (true) {
        const newlineIndex = ackBuffer.indexOf("\n");
        if (newlineIndex < 0) return;
        const line = ackBuffer.slice(0, newlineIndex);
        ackBuffer = ackBuffer.slice(newlineIndex + 1);
        let ack;
        try { ack = JSON.parse(line); }
        catch { fail(`bridge returned an unreadable acknowledgement from ${endpoint}`); }
        if (!authenticated) {
          if (ack && ack.ok === true && ack.authenticated === true) {
            authenticated = true;
            socket.write(frame);
            continue;
          }
          clearTimeout(timeout);
          socket.destroy();
          fail(`bridge authentication rejected by ${endpoint}: ${ack?.error ?? "unknown reason"}`);
        }
        clearTimeout(timeout);
        socket.destroy();
        if (ack && ack.ok === true) process.exit(0);
        fail(`bridge rejected the event from ${endpoint}: ${ack?.error ?? "unknown reason"}`);
      }
    });
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/agent-event-bridge.mjs --source <source> <json|@file|->");
    return;
  }
  const payload = readPayload(args.payloadArg);
  deliver(args.endpoint ?? defaultEndpoint(), payload, args.source);
}

main();
