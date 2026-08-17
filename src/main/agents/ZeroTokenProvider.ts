import type { AgentProgressListener } from "../wechat/replyGenerator";
import type { ZeroTokenSettings } from "../../settings/types";
import {
  WebModelRuntimeManager,
  ZeroTokenRuntimeError,
  type ZeroTokenErrorCode,
} from "./WebModelRuntimeManager";
import type { WebModelRuntimeState } from "./WebModelRuntimeTypes";
import { zeroTokenModelLabel } from "./ZeroTokenModel";

export type ZeroTokenServiceState = "connected" | "unavailable" | "error";

export interface ZeroTokenProviderStatus {
  state: ZeroTokenServiceState;
  status: WebModelRuntimeState["status"];
  baseUrl: string;
  port: number | null;
  pid: number | null;
  spawnedByApp: boolean;
  model: string | null;
  models: string[];
  providers: string[];
  detail: string;
  lastError: string | null;
  checkedAt: number;
}

export interface ZeroTokenMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let configuredRuntimeManager: WebModelRuntimeManager | null = null;

export function configureZeroTokenRuntimeManager(manager: WebModelRuntimeManager): void {
  configuredRuntimeManager = manager;
}

export function getZeroTokenRuntimeManager(): WebModelRuntimeManager {
  if (!configuredRuntimeManager) {
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_UNKNOWN_ERROR", "WebModel runtime manager is not configured");
  }
  return configuredRuntimeManager;
}

function normalizedBaseUrl(config: ZeroTokenSettings): string {
  const base = config.baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function dashboardBaseUrl(config: ZeroTokenSettings): string {
  return normalizedBaseUrl(config).replace(/\/v1$/, "");
}

function boundedTimeout(config: ZeroTokenSettings): number {
  return Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : 120_000;
}

function errorCode(error: unknown, fallback: ZeroTokenErrorCode): ZeroTokenErrorCode {
  if (error instanceof ZeroTokenRuntimeError) return error.code;
  return fallback;
}

function errorDetail(error: unknown, fallback: string): string {
  if (error instanceof ZeroTokenRuntimeError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${fallback}: ${message.replace(/\s+/g, " ").trim().slice(0, 180)}`;
}

export function statusFromRuntime(runtime: WebModelRuntimeState): ZeroTokenProviderStatus {
  const connected = runtime.status === "ready" || runtime.status === "login_required";
  return {
    state: connected ? "connected" : runtime.status === "error" ? "error" : "unavailable",
    status: runtime.status,
    baseUrl: runtime.baseUrl,
    port: runtime.port,
    pid: runtime.pid,
    spawnedByApp: runtime.spawnedByApp,
    model: runtime.selectedModelId,
    models: runtime.models.map((model) => model.id),
    providers: runtime.providers.map((provider) => provider.id),
    detail: runtime.detail,
    lastError: runtime.lastError,
    checkedAt: runtime.updatedAt,
  };
}

export function resolveZeroTokenModel(config: ZeroTokenSettings, advertisedModels: string[] = []): string | null {
  return config.model.trim() || advertisedModels[0] || null;
}

export async function checkZeroTokenConnection(config: ZeroTokenSettings): Promise<ZeroTokenProviderStatus> {
  const manager = getZeroTokenRuntimeManager();
  try {
    const runtime = await manager.detect(config);
    return statusFromRuntime(runtime);
  } catch (error) {
    const code = errorCode(error, "ZERO_TOKEN_SERVICE_UNAVAILABLE");
    const runtime = manager.getState();
    return {
      ...statusFromRuntime(runtime),
      state: "error",
      detail: errorDetail(error, code),
      lastError: errorDetail(error, code),
      checkedAt: Date.now(),
    };
  }
}

function extractReply(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.error) return "";
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const first = choices[0] as Record<string, unknown>;
  const message = first.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
        ? (item as Record<string, unknown>).text as string
        : "").join("");
    }
  }
  const delta = first.delta;
  return delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string"
    ? (delta as Record<string, unknown>).content as string
    : "";
}

function responseErrorCode(status: number): ZeroTokenErrorCode {
  if (status === 401 || status === 403) return "ZERO_TOKEN_SESSION_EXPIRED";
  if (status === 404) return "ZERO_TOKEN_MODEL_UNAVAILABLE";
  return "ZERO_TOKEN_UNKNOWN_ERROR";
}

async function readSseReply(response: Response, onProgress?: AgentProgressListener, deadline = Number.POSITIVE_INFINITY): Promise<string> {
  if (!response.body) throw new ZeroTokenRuntimeError("ZERO_TOKEN_STREAM_INTERRUPTED", "Response stream is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let done = false;
  while (!done) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new ZeroTokenRuntimeError("ZERO_TOKEN_TIMEOUT", "WebModel stream timed out");
      }
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_STREAM_INTERRUPTED", error instanceof Error ? error.message : String(error));
    }
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        continue;
      }
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>).error) {
        const error = (payload as Record<string, unknown>).error;
        const message = error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
          ? (error as Record<string, unknown>).message as string
          : "WebModel stream error";
        throw new ZeroTokenRuntimeError("ZERO_TOKEN_UNKNOWN_ERROR", message);
      }
      const piece = extractReply(payload);
      if (piece) {
        reply += piece;
        onProgress?.("network", "Zero Token 正在接收 WebModel 流式回复…");
      }
    }
    if (result.done) break;
  }
  if (buffer.startsWith("data:")) {
    const data = buffer.slice(5).trim();
    if (data && data !== "[DONE]") {
      try { reply += extractReply(JSON.parse(data) as unknown); } catch { /* incomplete terminal frame */ }
    }
  }
  if (!reply.trim()) throw new ZeroTokenRuntimeError("ZERO_TOKEN_STREAM_INTERRUPTED", "WebModel returned an empty stream");
  return reply.trim();
}

export async function generateZeroTokenReply(
  config: ZeroTokenSettings,
  messages: ZeroTokenMessage[],
  onProgress?: AgentProgressListener,
): Promise<string> {
  const manager = getZeroTokenRuntimeManager();
  let runtime: WebModelRuntimeState;
  try {
    runtime = await manager.ensureRunning(config);
  } catch (error) {
    throw new ZeroTokenRuntimeError(errorCode(error, "ZERO_TOKEN_SERVICE_UNAVAILABLE"), errorDetail(error, "WebModel request failed"));
  }
  if (runtime.status === "login_required" && !runtime.models.length) {
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_LOGIN_REQUIRED", runtime.detail);
  }
  const model = runtime.selectedModelId || resolveZeroTokenModel(config, runtime.models.map((item) => item.id));
  if (!model) throw new ZeroTokenRuntimeError("ZERO_TOKEN_MODEL_UNAVAILABLE", "WebModel returned no available model");
  const baseUrl = runtime.baseUrl || normalizedBaseUrl(config);
  onProgress?.("starting", `Zero Token 正在通过 WebModel 请求 ${zeroTokenModelLabel(model)}…`);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: 1024, stream: true }),
      signal: AbortSignal.timeout(boundedTimeout(config)),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_TIMEOUT", `WebModel request timed out after ${boundedTimeout(config)}ms`);
    }
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", errorDetail(error, "WebModel request failed"));
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    throw new ZeroTokenRuntimeError(responseErrorCode(response.status), detail || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const reply = contentType.includes("text/event-stream")
    ? await readSseReply(response, onProgress, Date.now() + boundedTimeout(config))
    : extractReply(await response.json());
  if (!reply.trim()) throw new ZeroTokenRuntimeError("ZERO_TOKEN_STREAM_INTERRUPTED", "WebModel returned empty content");
  onProgress?.("response-ready", "Zero Token 已生成回复，正在准备发送…");
  return reply.trim();
}

export function zeroTokenDashboardUrl(config: ZeroTokenSettings): string {
  return `${dashboardBaseUrl(config)}/`;
}
