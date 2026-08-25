import type { ZeroTokenProviderId } from "./types";
import type { ChatGPTConversation } from "./ChatGPTSession";

export type WebAIMessageRole = "system" | "user" | "assistant";

export interface WebAIMessage {
  role: WebAIMessageRole;
  content: string;
}

export type WebAIErrorCode =
  | "LOGIN_REQUIRED"
  | "SESSION_EXPIRED"
  | "NETWORK_ERROR"
  | "MODEL_UNAVAILABLE";

export class WebAIError extends Error {
  constructor(
    readonly code: WebAIErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "WebAIError";
  }
}

export function isWebAIError(error: unknown): error is WebAIError {
  return error instanceof WebAIError;
}

export interface WebAICompletionOptions {
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface WebAICompletion {
  role: "assistant";
  content: string;
}

export interface WebAIAvailability {
  provider: ZeroTokenProviderId;
  available: boolean;
  code?: WebAIErrorCode;
  detail: string;
}

/** Provider-specific page automation hidden behind the WebAIClient boundary. */
export interface WebAIProviderAdapter {
  readonly provider: ZeroTokenProviderId;
  chatCompletion(messages: WebAIMessage[], options?: WebAICompletionOptions): Promise<WebAICompletion>;
  streamCompletion(messages: WebAIMessage[], options?: WebAICompletionOptions): Promise<WebAICompletion>;
  checkAvailability(): Promise<WebAIAvailability>;
  createConversation(): Promise<ChatGPTConversation>;
  continueConversation(): Promise<ChatGPTConversation>;
  resetConversation(): Promise<ChatGPTConversation>;
  abortGeneration(): Promise<boolean>;
}

export interface WebAIClient {
  chatCompletion(
    provider: ZeroTokenProviderId,
    messages: WebAIMessage[],
    options?: WebAICompletionOptions,
  ): Promise<WebAICompletion>;
  streamCompletion(
    provider: ZeroTokenProviderId,
    messages: WebAIMessage[],
    options?: WebAICompletionOptions,
  ): Promise<WebAICompletion>;
  checkAvailability(provider: ZeroTokenProviderId): Promise<WebAIAvailability>;
  createConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation>;
  continueConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation>;
  resetConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation>;
  abortGeneration(provider: ZeroTokenProviderId): Promise<boolean>;
}

/** Dispatches the neutral WebAI contract to a concrete web-provider adapter. */
export class DefaultWebAIClient implements WebAIClient {
  private readonly adapters: ReadonlyMap<ZeroTokenProviderId, WebAIProviderAdapter>;

  constructor(adapters: WebAIProviderAdapter[] = []) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  chatCompletion(
    provider: ZeroTokenProviderId,
    messages: WebAIMessage[],
    options?: WebAICompletionOptions,
  ): Promise<WebAICompletion> {
    return this.adapter(provider).chatCompletion(messages, options);
  }

  streamCompletion(
    provider: ZeroTokenProviderId,
    messages: WebAIMessage[],
    options?: WebAICompletionOptions,
  ): Promise<WebAICompletion> {
    return this.adapter(provider).streamCompletion(messages, options);
  }

  checkAvailability(provider: ZeroTokenProviderId): Promise<WebAIAvailability> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      return Promise.resolve({
        provider,
        available: false,
        code: "MODEL_UNAVAILABLE",
        detail: `${provider} Web Provider 尚未接入`,
      });
    }
    return adapter.checkAvailability();
  }

  createConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation> {
    return this.adapter(provider).createConversation();
  }

  continueConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation> {
    return this.adapter(provider).continueConversation();
  }

  resetConversation(provider: ZeroTokenProviderId): Promise<ChatGPTConversation> {
    return this.adapter(provider).resetConversation();
  }

  abortGeneration(provider: ZeroTokenProviderId): Promise<boolean> {
    return this.adapter(provider).abortGeneration();
  }

  private adapter(provider: ZeroTokenProviderId): WebAIProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new WebAIError("MODEL_UNAVAILABLE", `${provider} Web Provider 尚未接入`);
    return adapter;
  }
}

export function createWebAIClient(adapters?: WebAIProviderAdapter[]): WebAIClient {
  return new DefaultWebAIClient(adapters);
}
