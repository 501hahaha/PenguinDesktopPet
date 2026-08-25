import type { AgentStatus } from "../wechat/events";

export type RuntimeProviderStatus = "stopped" | "starting" | "ready" | "login_required" | "error";
export type ModelProviderProgressListener = (status: AgentStatus, detail: string) => void;

/** A locally managed model runtime. Secrets and browser session data never cross this boundary. */
export interface RuntimeProvider {
  id: string;
  type: "api" | "zerotoken";
  name: string;
  status: RuntimeProviderStatus;
  baseURL: string;
  port: number;
  models: string[];
  pid?: number;
  error?: string;
  updatedAt?: number;
}

/** Main-process-only settings for the loopback ZeroToken API. */
export interface ZeroTokenApiSettings {
  auth: {
    enabled: boolean;
  };
}

export type ModelProviderId = "api" | "ccs" | "deepseek" | "zerotoken";

export interface ModelProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelProviderChatRequest {
  model?: string;
  messages: ModelProviderMessage[];
  timeoutMs?: number;
  onProgress?: ModelProviderProgressListener;
}

/** Transport contract consumed by Agents; Agent identity stays outside this layer. */
export interface ModelProviderClient {
  readonly id: ModelProviderId;
  readonly name: string;
  chatCompletion(request: ModelProviderChatRequest): Promise<string>;
}

export type RuntimeLogLevel = "info" | "warn" | "error";

export interface RuntimeLogEntry {
  timestamp: number;
  level: RuntimeLogLevel;
  message: string;
}
