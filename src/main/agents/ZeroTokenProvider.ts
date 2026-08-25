import type { AgentProgressListener } from "../wechat/replyGenerator";
import type { ZeroTokenSettings } from "../../settings/types";
import { ZeroTokenRuntime } from "../zerotoken/ZeroTokenRuntime";
import type { ZeroTokenProviderStatus as EmbeddedProviderStatus, ZeroTokenProviderId } from "../zerotoken/types";
import type { ModelProviderChatRequest, ModelProviderClient, RuntimeLogEntry, RuntimeProvider } from "../runtime/types";
import type { WebModelRuntimeState } from "./WebModelRuntimeTypes";
import { createWebAIClient, isWebAIError, type WebAIAvailability, type WebAIClient } from "../zerotoken/WebAIClient";
import type { ChatGPTConversation } from "../zerotoken/ChatGPTSession";
import { ZeroTokenMetrics, type ZeroTokenMetricsSnapshot } from "../zerotoken/ZeroTokenMetrics";

export type ZeroTokenServiceState = "connected" | "unavailable" | "error";

/**
 * Compatibility status shape consumed by the existing settings surface.
 * Phase 1 deliberately reports no port, PID, model, or external runtime.
 */
export interface ZeroTokenProviderStatus {
  state: ZeroTokenServiceState;
  status: WebModelRuntimeState["status"] | "logging_in";
  provider: ZeroTokenProviderId;
  providerName: string;
  baseUrl: string;
  port: null;
  pid: null;
  spawnedByApp: false;
  model: null;
  models: string[];
  providers: string[];
  detail: string;
  lastError: string | null;
  checkedAt: number;
  runtimeProvider: RuntimeProvider;
  logs: RuntimeLogEntry[];
}

export interface ZeroTokenMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ZeroTokenHealthStatus {
  login: boolean;
  available: boolean;
  latency: number;
  code?: string;
  detail?: string;
}

let configuredRuntime: ZeroTokenRuntime | null = null;
let configuredWebAIClient: WebAIClient | null = null;

export function configureZeroTokenRuntime(runtime: ZeroTokenRuntime): void {
  configuredRuntime = runtime;
}

export function getZeroTokenRuntime(): ZeroTokenRuntime {
  if (!configuredRuntime) throw new Error("ZERO_TOKEN_UNKNOWN_ERROR: Zero Token Runtime is not configured");
  return configuredRuntime;
}

export function configureZeroTokenWebAIClient(client: WebAIClient): void {
  configuredWebAIClient = client;
}

function getWebAIClient(): WebAIClient {
  return configuredWebAIClient ?? createWebAIClient();
}

function stateFromEmbedded(status: EmbeddedProviderStatus): ZeroTokenProviderStatus {
  const state: ZeroTokenServiceState = status.status === "ready" || status.status === "login_required" || status.status === "logging_in"
    ? "connected"
    : status.status === "error" ? "error" : "unavailable";
  const runtimeStatus = status.status === "logging_in" ? "starting" : status.status;
  return {
    state,
    status: runtimeStatus,
    provider: status.provider,
    providerName: status.name,
    baseUrl: `embedded://zerotoken/${status.provider}`,
    port: null,
    pid: null,
    spawnedByApp: false,
    model: null,
    models: [],
    providers: [status.provider],
    detail: status.detail,
    lastError: status.lastError,
    checkedAt: status.updatedAt,
    runtimeProvider: {
      id: "zerotoken",
      type: "zerotoken",
      name: status.name,
      status: runtimeStatus,
      baseURL: `embedded://zerotoken/${status.provider}`,
      port: 0,
      models: [],
      ...(status.lastError ? { error: status.lastError } : {}),
      updatedAt: status.updatedAt,
    },
    logs: [],
  };
}

export function statusFromEmbedded(status: EmbeddedProviderStatus): ZeroTokenProviderStatus {
  return stateFromEmbedded(status);
}

/** Kept for old imports while the previous Runtime manager is retired. */
export function statusFromRuntime(runtime: WebModelRuntimeState): ZeroTokenProviderStatus {
  const provider: ZeroTokenProviderId = "chatgpt-web";
  const status: EmbeddedProviderStatus = {
    provider,
    name: "ChatGPT Web",
    status: runtime.status === "starting" ? "logging_in" : runtime.status,
    detail: runtime.detail,
    lastError: runtime.lastError,
    updatedAt: runtime.updatedAt,
  };
  return stateFromEmbedded(status);
}

export class ZeroTokenProvider implements ModelProviderClient {
  readonly id = "zerotoken" as const;
  readonly name = "Zero Token Web Provider";
  readonly metrics = new ZeroTokenMetrics();

  constructor(
    private readonly config: ZeroTokenSettings,
    private readonly webAIClient: WebAIClient = getWebAIClient(),
  ) {}

  async chatCompletion(request: ModelProviderChatRequest): Promise<string> {
    const startedAt = Date.now();
    this.metrics.recordRequest();
    try {
      const result = await this.webAIClient.chatCompletion(this.config.provider, request.messages, {
        model: request.model || undefined,
        timeoutMs: request.timeoutMs,
        onDelta: (delta) => request.onProgress?.("thinking", delta),
      });
      this.metrics.recordSuccess(Date.now() - startedAt);
      return result.content;
    } catch (error) {
      this.metrics.recordFailure(error, Date.now() - startedAt);
      throw this.normalizeError(error);
    }
  }

  getMetrics(): ZeroTokenMetricsSnapshot {
    return this.metrics.snapshot();
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  async start(): Promise<ZeroTokenProviderStatus> {
    const runtime = getZeroTokenRuntime();
    await runtime.initialize();
    return statusFromEmbedded(await runtime.getStatus(this.config.provider));
  }

  async stop(): Promise<ZeroTokenProviderStatus> {
    const runtime = getZeroTokenRuntime();
    return statusFromEmbedded(await runtime.stop(this.config.provider));
  }

  async restart(): Promise<ZeroTokenProviderStatus> {
    await this.stop();
    return this.start();
  }

  checkAvailability(): Promise<WebAIAvailability> {
    return this.webAIClient.checkAvailability(this.config.provider);
  }

  async healthCheck(): Promise<ZeroTokenHealthStatus> {
    const startedAt = Date.now();
    const availability = await this.checkAvailability();
    return {
      login: availability.code !== "LOGIN_REQUIRED" && availability.code !== "SESSION_EXPIRED",
      available: availability.available,
      latency: Date.now() - startedAt,
      ...(availability.code ? { code: availability.code } : {}),
      detail: availability.detail,
    };
  }

  createConversation(): Promise<ChatGPTConversation> {
    return this.webAIClient.createConversation(this.config.provider);
  }

  continueConversation(): Promise<ChatGPTConversation> {
    return this.webAIClient.continueConversation(this.config.provider);
  }

  resetConversation(): Promise<ChatGPTConversation> {
    return this.webAIClient.resetConversation(this.config.provider);
  }

  abortGeneration(): Promise<boolean> {
    return this.webAIClient.abortGeneration(this.config.provider);
  }

  private normalizeError(error: unknown): Error {
    if (isWebAIError(error)) return new Error(error.message);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`NETWORK_ERROR: ${message || "Zero Token Web Provider 请求失败"}`);
  }
}

export function createZeroTokenProvider(config: ZeroTokenSettings, webAIClient?: WebAIClient): ZeroTokenProvider {
  return new ZeroTokenProvider(config, webAIClient);
}

export function resolveZeroTokenModel(_config: ZeroTokenSettings, _advertisedModels: string[] = []): string | null {
  return null;
}

export async function checkZeroTokenConnection(config: ZeroTokenSettings): Promise<ZeroTokenProviderStatus> {
  const runtime = getZeroTokenRuntime();
  const status = await runtime.getStatus(config.provider);
  return stateFromEmbedded(status);
}

export async function generateZeroTokenReply(
  config: ZeroTokenSettings,
  messages: ZeroTokenMessage[],
  onProgress?: AgentProgressListener,
): Promise<string> {
  return new ZeroTokenProvider(config).chatCompletion({ messages, onProgress });
}
