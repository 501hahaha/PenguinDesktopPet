import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  ModelProviderChatRequest,
  ModelProviderClient,
  ModelProviderMessage,
  ModelProviderProgressListener,
} from "../../runtime/types";
import { ZeroTokenRequestQueue, type ZeroTokenRequestHandle } from "../ZeroTokenRequestQueue";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3456;
const DEFAULT_MODEL = "chatgpt-web";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1_024 * 1_024;

type HealthProvider = ModelProviderClient & {
  healthCheck?: () => Promise<{ login: boolean; available: boolean; latency: number; code?: string; detail?: string }>;
  abortGeneration?: () => Promise<boolean>;
};

export interface ZeroTokenApiServerOptions {
  /** The server is intentionally restricted to IPv4 loopback. */
  host?: string;
  port?: number;
  provider: ModelProviderClient | (() => ModelProviderClient);
  maxBodyBytes?: number;
  /** Auth is main-process-only; the token is never sent through preload or renderer IPC. */
  auth?: {
    enabled: boolean;
    token?: string;
  };
}

export interface ZeroTokenApiServerAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
  baseURL: string;
}

export interface ZeroTokenApiModel {
  id: string;
  object: "model";
  created: number;
  owned_by: "zerotoken";
}

export interface ZeroTokenApiModelsResponse {
  object: "list";
  data: ZeroTokenApiModel[];
}

export interface ZeroTokenApiTestModelRequest {
  model?: string;
  messages: ModelProviderMessage[];
  stream?: boolean;
  timeoutMs?: number;
}

class ZeroTokenApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ZeroTokenApiRequestError";
  }
}

/**
 * Local OpenAI-compatible HTTP facade for the embedded ZeroToken provider.
 * Only the Electron main process owns this server; it never serializes or
 * exposes browser cookies, session data, or authentication tokens.
 */
export class ZeroTokenApiServer {
  private readonly host: typeof LOOPBACK_HOST;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly provider: ModelProviderClient | (() => ModelProviderClient);
  private readonly authEnabled: boolean;
  private readonly authToken: string | null;
  private readonly requestQueue = new ZeroTokenRequestQueue();
  private server: Server | null = null;
  private addressInfo: ZeroTokenApiServerAddress | null = null;
  private startPromise: Promise<ZeroTokenApiServerAddress> | null = null;

  constructor(options: ZeroTokenApiServerOptions) {
    if ((options.host ?? LOOPBACK_HOST) !== LOOPBACK_HOST) {
      throw new Error("ZERO_TOKEN_API_HOST_NOT_ALLOWED: ZeroToken API only listens on 127.0.0.1");
    }
    if (!Number.isInteger(options.port ?? DEFAULT_PORT) || (options.port ?? DEFAULT_PORT) < 0 || (options.port ?? DEFAULT_PORT) > 65_535) {
      throw new Error("ZERO_TOKEN_API_INVALID_PORT: port must be between 0 and 65535");
    }
    this.host = LOOPBACK_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.maxBodyBytes = Math.max(1_024, options.maxBodyBytes ?? MAX_BODY_BYTES);
    this.provider = options.provider;
    this.authEnabled = options.auth?.enabled === true;
    this.authToken = options.auth?.token?.trim() || null;
    if (this.authEnabled && !this.authToken) {
      throw new Error("ZERO_TOKEN_API_AUTH_TOKEN_REQUIRED: auth token is required when API auth is enabled");
    }
  }

  get isRunning(): boolean {
    return this.server !== null && this.addressInfo !== null;
  }

  get address(): ZeroTokenApiServerAddress | null {
    return this.addressInfo ? { ...this.addressInfo } : null;
  }

  get baseURL(): string | null {
    return this.addressInfo?.baseURL ?? null;
  }

  get authEnabledState(): boolean {
    return this.authEnabled;
  }

  async start(): Promise<ZeroTokenApiServerAddress> {
    if (this.addressInfo) return { ...this.addressInfo };
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<ZeroTokenApiServerAddress>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        this.server = null;
        this.addressInfo = null;
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const boundAddress = server.address();
        const boundPort = typeof boundAddress === "object" && boundAddress ? boundAddress.port : this.port;
        this.server = server;
        this.addressInfo = {
          host: LOOPBACK_HOST,
          port: boundPort,
          baseURL: `http://${LOOPBACK_HOST}:${boundPort}`,
        };
        resolve({ ...this.addressInfo });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.requestQueue.cancelAll();
    const server = this.server;
    this.server = null;
    this.addressInfo = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setCommonHeaders(response);
    try {
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!this.isAuthorized(request)) {
        throw new ZeroTokenApiRequestError(401, "UNAUTHORIZED", "Authorization Bearer token is required");
      }

      if (request.method === "GET" && url.pathname === "/health") {
        await this.handleHealth(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const models = await this.enqueueRequest(() => Promise.resolve(this.modelsResponse()), request, response);
        if (!response.destroyed) this.writeJson(response, 200, models);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await this.readJson(request);
        await this.handleChatCompletion(body, request, response);
        return;
      }

      throw new ZeroTokenApiRequestError(404, "NOT_FOUND", "OpenAI-compatible endpoint was not found");
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.writableEnded && !response.destroyed) response.end();
        return;
      }
      this.writeError(response, error);
    }
  }

  private async handleHealth(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const provider = this.resolveProvider() as HealthProvider;
    const health = await this.enqueueRequest(async () => {
      if (provider.healthCheck) return provider.healthCheck();
      return { login: true, available: true, latency: 0 };
    }, request, response);
    if (response.destroyed) return;
    this.writeJson(response, 200, {
      status: health.login && health.available ? "ready" : health.login ? "error" : "login_required",
      provider: "chatgpt-web",
      login: health.login,
      model: "chatgpt-web",
    });
  }

  private modelsResponse(): ZeroTokenApiModelsResponse {
    return {
      object: "list",
      data: [{
        id: DEFAULT_MODEL,
        object: "model",
        created: Math.floor(Date.now() / 1_000),
        owned_by: "zerotoken",
      }],
    };
  }

  private async handleChatCompletion(rawBody: unknown, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new ZeroTokenApiRequestError(400, "INVALID_REQUEST", "Request body must be a JSON object");
    }

    const body = rawBody as Record<string, unknown>;
    const messages = this.normalizeMessages(body.messages);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
    const stream = body.stream === true;
    const timeoutMs = this.normalizeTimeout(body.timeout_ms ?? body.timeoutMs);
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1_000);
    const provider = this.resolveProvider() as HealthProvider;
    let queueHandle: ZeroTokenRequestHandle<string> | null = null;
    let completed = false;
    const disconnect = (): void => {
      if (completed) return;
      queueHandle?.cancel();
      void provider.abortGeneration?.().catch(() => undefined);
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);

    try {
      if (!stream) {
        queueHandle = this.requestQueue.enqueue(
          () => provider.chatCompletion({ model, messages, timeoutMs }),
          { timeoutMs },
        );
        const completion = await queueHandle.promise;
        if (response.destroyed) return;
        this.writeJson(response, 200, {
          id: requestId,
          object: "chat.completion",
          created,
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: completion },
            finish_reason: "stop",
          }],
        });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      let streamedContent = "";
      const writeDelta: ModelProviderProgressListener = (_status, delta) => {
        if (!delta || response.destroyed || response.writableEnded) return;
        streamedContent += delta;
        this.writeSse(response, {
          id: requestId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        });
      };
      queueHandle = this.requestQueue.enqueue(
        () => provider.chatCompletion({ model, messages, timeoutMs, onProgress: writeDelta }),
        { timeoutMs },
      );
      const completion = await queueHandle.promise;
      if (response.destroyed || response.writableEnded) return;
      const remainder = completion.startsWith(streamedContent)
        ? completion.slice(streamedContent.length)
        : streamedContent.length ? "" : completion;
      if (remainder) writeDelta("thinking", remainder);
      this.writeSse(response, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      response.write("data: [DONE]\n\n");
      response.end();
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) {
          this.writeSse(response, { error: this.publicError(error) });
          response.write("data: [DONE]\n\n");
          response.end();
        } else {
          this.writeError(response, error);
        }
      }
    } finally {
      completed = true;
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
    }
  }

  private resolveProvider(): ModelProviderClient {
    return typeof this.provider === "function" ? this.provider() : this.provider;
  }

  private async enqueueRequest<T>(
    operation: () => Promise<T>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<T> {
    let handle: ZeroTokenRequestHandle<T> | null = null;
    let disconnected = false;
    const disconnect = (): void => {
      disconnected = true;
      handle?.cancel();
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    try {
      handle = this.requestQueue.enqueue(() => operation(), {});
      return await handle.promise;
    } finally {
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      if (disconnected) handle?.cancel();
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.authEnabled) return true;
    const header = request.headers.authorization;
    if (!header || !this.authToken) return false;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return Boolean(match && match[1].trim() === this.authToken);
  }

  private normalizeMessages(rawMessages: unknown): ModelProviderMessage[] {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new ZeroTokenApiRequestError(400, "INVALID_MESSAGES", "messages must be a non-empty array");
    }
    if (rawMessages.length > 100) {
      throw new ZeroTokenApiRequestError(400, "INVALID_MESSAGES", "messages may contain at most 100 items");
    }

    return rawMessages.map((rawMessage, index) => {
      if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
        throw new ZeroTokenApiRequestError(400, "INVALID_MESSAGES", `messages[${index}] must be an object`);
      }
      const message = rawMessage as Record<string, unknown>;
      const role = message.role;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        throw new ZeroTokenApiRequestError(400, "INVALID_MESSAGES", `messages[${index}].role is invalid`);
      }
      const content = this.normalizeContent(message.content);
      if (!content.trim()) {
        throw new ZeroTokenApiRequestError(400, "INVALID_MESSAGES", `messages[${index}].content cannot be empty`);
      }
      return { role, content };
    });
  }

  private normalizeContent(rawContent: unknown): string {
    if (typeof rawContent === "string") return rawContent;
    if (!Array.isArray(rawContent)) return "";
    return rawContent
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private normalizeTimeout(rawTimeout: unknown): number {
    if (rawTimeout === undefined) return DEFAULT_TIMEOUT_MS;
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new ZeroTokenApiRequestError(400, "INVALID_TIMEOUT", "timeout_ms must be a positive number");
    }
    return Math.min(Math.floor(rawTimeout), MAX_TIMEOUT_MS);
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      request.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > this.maxBodyBytes) {
          reject(new ZeroTokenApiRequestError(413, "REQUEST_TOO_LARGE", "request body is too large"));
          request.destroy();
          return;
        }
        chunks.push(buffer);
      });
      request.once("end", () => resolve());
      request.once("error", reject);
      request.once("aborted", () => reject(new ZeroTokenApiRequestError(400, "REQUEST_ABORTED", "request was aborted")));
    });

    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new ZeroTokenApiRequestError(400, "INVALID_JSON", "request body must contain valid JSON");
    }
  }

  private setCommonHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  private writeSse(response: ServerResponse, payload: unknown): void {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private writeError(response: ServerResponse, error: unknown): void {
    const apiError = error instanceof ZeroTokenApiRequestError
      ? error
      : this.providerError(error);
    this.writeJson(response, apiError.statusCode, {
      error: {
        message: apiError.message,
        type: apiError.code === "LOGIN_REQUIRED" || apiError.code === "UNAUTHORIZED" ? "authentication_error" : "server_error",
        code: apiError.code,
      },
    });
  }

  private providerError(error: unknown): ZeroTokenApiRequestError {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/\b(LOGIN_REQUIRED|SESSION_EXPIRED|NETWORK_ERROR|MODEL_UNAVAILABLE|REQUEST_CANCELLED|REQUEST_TIMEOUT)\b/i);
    const code = match?.[1]?.toUpperCase() ?? "PROVIDER_ERROR";
    const statusCode = code === "LOGIN_REQUIRED" || code === "SESSION_EXPIRED" ? 401 : code === "REQUEST_TIMEOUT" ? 504 : 502;
    return new ZeroTokenApiRequestError(statusCode, code, this.publicError(error));
  }

  private publicError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/cookie|session|authorization|token/gi, "credential").slice(0, 2_000);
  }
}
