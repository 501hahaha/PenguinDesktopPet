import { existsSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentExternalEvent,
  AgentExternalEventSource,
  AgentExternalLifecycle,
  AgentExternalSurface,
} from "./perceptionTypes";
import { normalizeAgentEndpointBridgeMessage } from "../agents/orchestrationTypes";
import type { AgentTaskRequest, AgentEndpointBridgeMessage } from "../agents/orchestrationTypes";
import { workspaceLabelFromPath } from "./taskNotificationFormatter";

/**
 * 本地 Agent 事件桥：只在本机接受外部宿主（Codex CLI notify / Codex app-server /
 * Claude Code hook / 手动测试）推送的脱敏生命周期事件，不做任何跨主机暴露。
 *
 * 传输层：Windows 使用命名管道，其他平台回退到用户级 Unix Socket；
 * 不监听 TCP 端口，不对外网暴露。协议为单行 JSON（NDJSON），服务端逐行
 * 校验、归一化、按 eventId 去重后，通过类型化监听器发布。
 *
 * 安全边界：桥接器不落盘任何内容，日志只记录端点与计数；校验只保留窄合同
 * 字段，detail/cwd/displayName 做控制字符剥离、限长与凭据脱敏；
 * 聊天正文、token、Cookie、完整路径一律不进入归一化事件，cwd 只用于
 * 观察层提取最后一级工作区名称。
 */

export const AGENT_BRIDGE_PIPE_NAME = "\\\\.\\pipe\\penguin-pet-agent-events";
export const AGENT_BRIDGE_SOCKET_BASENAME = "penguin-pet-agent-events";

const MAX_FRAME_BYTES = 16 * 1024;
const DEDUPE_CAPACITY = 1024;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_REFERENCE_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_DETAIL_LENGTH = 160;
const MAX_CWD_LENGTH = 200;
const MAX_WORKSPACE_LABEL_LENGTH = 120;

const EXTERNAL_SOURCES = new Set<string>(["codex-notify", "codex-app-server", "claude-hook", "manual-test", "delegation", "event-bridge", "gateway"]);
const EXTERNAL_LIFECYCLES = new Set<string>(["accepted", "starting", "planning", "progress", "running", "waiting", "completed", "failed", "cancelled", "stopped", "needs-input"]);
const EXTERNAL_SURFACES = new Set<string>(["desktop", "vscode", "cli", "gateway", "service"]);

function defaultSocketPath(): string {
  const base = (process.env.XDG_RUNTIME_DIR ?? "").trim() || tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return join(base, `${AGENT_BRIDGE_SOCKET_BASENAME}${uid ? `-${uid}` : ""}.sock`);
}

/** 去掉控制字符、折叠空白、限长。id/名称字段只做这层清理。 */
function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** detail/cwd 这类自由文本额外做凭据模式脱敏，避免 token/路径进入桌宠气泡。 */
function sanitizeFreeText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b(bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>");
  return sanitizeText(redacted, maxLength);
}

/** 可选的会话/轮次/任务引用 ID：缺失或非字符串时按无引用处理。 */
function boundedReferenceId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return null;
  return sanitizeText(value, MAX_REFERENCE_ID_LENGTH) || null;
}

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

export type AgentExternalEventNormalization =
  | { ok: true; event: AgentExternalEvent }
  | { ok: false; error: string };

/**
 * 把外部传入的原始对象校验并归一化为窄合同事件。
 * 未知字段被丢弃；类型错误/字段超限/未知枚举会被拒绝，保证进入
 * 观察者的只有经过脱敏的固定字段。
 */
export function normalizeAgentExternalEvent(raw: unknown): AgentExternalEventNormalization {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "payload must be a single JSON object" };
  }
  const record = raw as Record<string, unknown>;

  if (typeof record.source !== "string" || !EXTERNAL_SOURCES.has(record.source)) {
    return { ok: false, error: "unsupported or missing source" };
  }
  const source = record.source as AgentExternalEventSource;

  let surface: AgentExternalSurface = "cli";
  if (record.surface !== undefined) {
    if (typeof record.surface !== "string" || !EXTERNAL_SURFACES.has(record.surface)) {
      return { ok: false, error: "unsupported or malformed surface" };
    }
    surface = record.surface as AgentExternalSurface;
  }

  if (typeof record.lifecycle !== "string" || !EXTERNAL_LIFECYCLES.has(record.lifecycle)) {
    return { ok: false, error: "unsupported or missing lifecycle" };
  }
  const lifecycle = record.lifecycle as AgentExternalLifecycle;

  if (typeof record.eventId !== "string") return { ok: false, error: "eventId must be a string" };
  const eventId = sanitizeText(record.eventId, MAX_EVENT_ID_LENGTH);
  if (!eventId) return { ok: false, error: "eventId must not be empty" };

  if (typeof record.agentId !== "string") return { ok: false, error: "agentId must be a string" };
  const agentId = sanitizeText(record.agentId, MAX_AGENT_ID_LENGTH);
  if (!agentId) return { ok: false, error: "agentId must not be empty" };

  let displayName: string | undefined;
  if (record.displayName !== undefined) {
    if (typeof record.displayName !== "string") return { ok: false, error: "displayName must be a string" };
    const cleaned = sanitizeText(record.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (cleaned) displayName = cleaned;
  }

  let detail: string | undefined;
  if (record.detail !== undefined) {
    if (typeof record.detail !== "string") return { ok: false, error: "detail must be a string" };
    const cleaned = sanitizeFreeText(record.detail, MAX_DETAIL_LENGTH);
    if (cleaned) detail = cleaned;
  }

  let cwd: string | undefined;
  const derivedWorkspaceLabel = typeof record.cwd === "string"
    ? workspaceLabelFromPath(record.cwd)
    : undefined;
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string") return { ok: false, error: "cwd must be a string" };
    const cleaned = sanitizeFreeText(record.cwd, MAX_CWD_LENGTH);
    if (cleaned) cwd = cleaned;
  }

  let occurredAt: string | undefined;
  if (record.occurredAt !== undefined) {
    if (typeof record.occurredAt !== "string") return { ok: false, error: "occurredAt must be a string" };
    const timestamp = Date.parse(record.occurredAt);
    if (Number.isNaN(timestamp)) return { ok: false, error: "occurredAt must be a valid timestamp" };
    occurredAt = new Date(timestamp).toISOString();
  }

  return {
    ok: true,
    event: {
      source,
      surface,
      lifecycle,
      eventId,
      endpointId: boundedReferenceId(record.endpointId) ?? undefined,
      hostId: boundedReferenceId(record.hostId) ?? undefined,
      workspaceId: boundedReferenceId(record.workspaceId) ?? undefined,
      workspaceLabel: typeof record.workspaceLabel === "string"
        ? workspaceLabelFromPath(record.workspaceLabel) ?? (sanitizeText(record.workspaceLabel, MAX_WORKSPACE_LABEL_LENGTH) || undefined)
        : derivedWorkspaceLabel,
      agentId,
      displayName,
      detail,
      cwd,
      occurredAt,
      sessionId: boundedReferenceId(record.sessionId) ?? undefined,
      turnId: boundedReferenceId(record.turnId) ?? undefined,
      taskId: boundedReferenceId(record.taskId) ?? undefined,
      requestId: boundedReferenceId(record.requestId) ?? undefined,
    },
  };
}

type AgentExternalEventListener = (event: AgentExternalEvent) => void;
type AgentEndpointListener = (message: AgentEndpointBridgeMessage) => void;

export interface AgentEventBridgeOptions {
  /** Per-user secret created by the Electron main process; never expose this to renderer code. */
  authToken: string;
  /** 仅测试用：覆盖 Windows 命名管道路径。 */
  pipeName?: string;
  /** 仅测试用：覆盖非 Windows 平台 Socket 路径。 */
  socketPath?: string;
  onStateChange?: (state: "offline" | "listening" | "degraded") => void;
}

/**
 * 本地事件桥服务器。start() 后接受本机客户端按行推送的事件；
 * stop() 关闭监听并销毁存量连接。监听失败（例如已有另一个实例占用
 * 管道）不会影响主进程，只记录警告并保持未运行状态。
 */
export class AgentEventBridge {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly listeners = new Set<AgentExternalEventListener>();
  private readonly options: AgentEventBridgeOptions;
  private readonly authToken: string;
  private readonly seenEventIds = new Map<string, true>();
  private readonly endpointListeners = new Set<AgentEndpointListener>();
  private readonly endpointSockets = new Map<string, Socket>();
  private readonly socketEndpointIds = new Map<Socket, Set<string>>();
  private readonly authenticatedSockets = new Set<Socket>();
  private running = false;

  constructor(options: AgentEventBridgeOptions) {
    const authToken = options.authToken.trim();
    if (!authToken) throw new Error("Agent event bridge requires an authentication token");
    this.options = options;
    this.authToken = authToken;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 当前生效的本地端点：Windows 命名管道名或 Unix Socket 路径。 */
  get endpointPath(): string {
    if (process.platform === "win32") return this.options.pipeName ?? AGENT_BRIDGE_PIPE_NAME;
    return this.options.socketPath ?? defaultSocketPath();
  }

  start(): void {
    if (this.running || this.server) return;
    this.running = true;
    this.options.onStateChange?.("degraded");
    const endpoint = this.endpointPath;

    if (process.platform !== "win32") {
      // Unix Socket 可能在崩溃后残留；先清理陈旧文件再监听。
      try {
        if (existsSync(endpoint)) unlinkSync(endpoint);
      } catch {
        // best effort
      }
    }

    const server = createServer((socket) => this.handleConnection(socket));
    server.on("error", (error) => {
      // EADDRINUSE：另一个 Penguin 实例已占用管道；EACCES：目录不可写。
      // 两种情况都不致命：本实例退化为无桥接状态，其他感知来源继续工作。
      console.warn(`Agent event bridge unavailable on ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      this.stop(false);
      this.options.onStateChange?.("degraded");
    });
    server.listen(endpoint, () => {
      if (this.running) console.log(`Agent event bridge listening on ${endpoint}`);
      if (this.running) this.options.onStateChange?.("listening");
    });
    this.server = server;
  }

  stop(notifyState = true): void {
    this.running = false;
    const server = this.server;
    this.server = null;
    if (server) server.close(() => undefined);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.authenticatedSockets.clear();
    this.endpointSockets.clear();
    this.socketEndpointIds.clear();
    if (notifyState) this.options.onStateChange?.("offline");
    if (process.platform !== "win32") {
      try {
        if (existsSync(this.endpointPath)) unlinkSync(this.endpointPath);
      } catch {
        // best effort
      }
    }
    // 订阅者属于应用生命周期；停止桥时不应意外清掉主进程转发监听。
  }

  subscribe(listener: AgentExternalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeEndpoint(listener: AgentEndpointListener): () => void {
    this.endpointListeners.add(listener);
    return () => this.endpointListeners.delete(listener);
  }

  send(endpointId: string, request: AgentTaskRequest): { ok: boolean; detail: string } {
    const socket = this.endpointSockets.get(endpointId);
    if (!socket || socket.destroyed) {
      this.endpointSockets.delete(endpointId);
      return { ok: false, detail: "目标 Agent 宿主未保持 Companion Bridge 连接" };
    }
    try {
      socket.write(`${JSON.stringify(request)}\n`);
      return {
        ok: true,
        detail: request.type === "message" ? "后续消息已发送，等待目标宿主确认" : "委派请求已发送，等待目标宿主确认",
      };
    } catch {
      return { ok: false, detail: "目标 Agent 宿主连接不可写" };
    }
  }

  dispatch(endpointId: string, request: Extract<AgentTaskRequest, { type: "dispatch" }>): { ok: boolean; detail: string } {
    return this.send(endpointId, request);
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.authenticatedSockets.delete(socket);
      const endpointIds = this.socketEndpointIds.get(socket);
      if (endpointIds) {
        for (const endpointId of endpointIds) {
          if (this.endpointSockets.get(endpointId) === socket) this.endpointSockets.delete(endpointId);
        }
        this.socketEndpointIds.delete(socket);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        this.writeAck(socket, { ok: false, error: "frame exceeds size limit" });
        socket.destroy();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed.trim()) continue;
        this.handleFrame(socket, trimmed);
      }
    });
  }

  private handleFrame(socket: Socket, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.writeAck(socket, { ok: false, error: "invalid JSON payload" });
      return;
    }

    if (!this.authenticatedSockets.has(socket)) {
      if (this.authenticate(socket, raw)) return;
      this.writeAck(socket, { ok: false, error: "authentication required" });
      socket.end();
      return;
    }

    if (this.isAuthFrame(raw)) {
      this.writeAck(socket, { ok: false, error: "connection is already authenticated" });
      return;
    }

    const endpointMessage = normalizeAgentEndpointBridgeMessage(raw);
    if (endpointMessage.handled) {
      if (!endpointMessage.ok) {
        this.writeAck(socket, { ok: false, error: endpointMessage.error });
        return;
      }
      for (const listener of [...this.endpointListeners]) {
        try {
          listener(structuredClone(endpointMessage.message));
        } catch (error) {
          console.warn("Agent endpoint bridge listener failed.", error);
        }
      }
      if (endpointMessage.message.type === "register") {
        const endpointId = endpointMessage.message.endpoint.endpointId;
        this.endpointSockets.set(endpointId, socket);
        const endpointIds = this.socketEndpointIds.get(socket) ?? new Set<string>();
        endpointIds.add(endpointId);
        this.socketEndpointIds.set(socket, endpointIds);
      } else if (endpointMessage.message.type === "unregister") {
        if (this.endpointSockets.get(endpointMessage.message.endpointId) === socket) {
          this.endpointSockets.delete(endpointMessage.message.endpointId);
          this.socketEndpointIds.get(socket)?.delete(endpointMessage.message.endpointId);
        }
      }
      const endpointId = endpointMessage.message.type === "register"
        ? endpointMessage.message.endpoint.endpointId
        : endpointMessage.message.endpointId;
      this.writeAck(socket, { ok: true, endpointId });
      return;
    }

    const normalized = normalizeAgentExternalEvent(raw);
    if (normalized.ok === false) {
      this.writeAck(socket, { ok: false, error: normalized.error });
      return;
    }
    const event = normalized.event;

    if (this.seenEventIds.has(event.eventId)) {
      // 同一事件重复投递（发送方重试）只回执，不重复发布。
      this.writeAck(socket, { ok: true, eventId: event.eventId, deduplicated: true });
      return;
    }
    this.seenEventIds.set(event.eventId, true);
    if (this.seenEventIds.size > DEDUPE_CAPACITY) {
      const oldest = this.seenEventIds.keys().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }

    const cloned = structuredClone(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(cloned);
      } catch (error) {
        console.warn("Agent event bridge listener failed.", error);
      }
    }
    this.writeAck(socket, { ok: true, eventId: event.eventId });
  }

  private authenticate(socket: Socket, raw: unknown): boolean {
    if (!this.isAuthFrame(raw)) return false;
    const token = (raw as { token?: unknown }).token;
    if (typeof token !== "string" || !tokensMatch(token, this.authToken)) {
      this.writeAck(socket, { ok: false, error: "invalid bridge authentication" });
      socket.end();
      return true;
    }
    this.authenticatedSockets.add(socket);
    this.writeAck(socket, { ok: true, authenticated: true });
    return true;
  }

  private isAuthFrame(raw: unknown): raw is { type: "auth"; token: string } {
    return typeof raw === "object"
      && raw !== null
      && !Array.isArray(raw)
      && (raw as Record<string, unknown>).type === "auth";
  }

  private writeAck(socket: Socket, ack: { ok: boolean; authenticated?: boolean; eventId?: string; endpointId?: string; deduplicated?: boolean; error?: string }): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(ack)}\n`);
  }
}
