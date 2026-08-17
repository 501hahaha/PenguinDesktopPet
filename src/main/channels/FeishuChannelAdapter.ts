import type {
  LarkChannel,
  LarkChannelError,
  Logger,
  NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type {
  BotChannelAdapter,
  ChannelActionResult,
  ChannelEventListener,
  ChannelSendResult,
  ChannelStatus,
  OutboundMediaMessage,
  OutboundMessage,
} from "./types";
import { inferOutboundMediaFileName, prepareOutboundMediaSource } from "../media/OutboundMediaSource";

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

export interface FeishuChannelConfig {
  channelId: string;
  appId: string;
  appSecret: string;
}

export class FeishuChannelAdapter implements BotChannelAdapter {
  readonly platform = "feishu" as const;
  private readonly listeners = new Set<ChannelEventListener>();
  private channel: LarkChannel | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribers: Array<() => void> = [];
  private generation = 0;
  private state: ChannelStatus["state"] = "disconnected";
  private lastError = "";
  private retryCount = 0;
  private nextRetryAt: number | null = null;

  constructor(private readonly config: FeishuChannelConfig) {}

  get channelId(): string {
    return this.config.channelId;
  }

  async start(): Promise<void> {
    if (this.channel && this.state === "connected") return;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    const stopGeneration = ++this.generation;
    const channel = this.channel;
    this.channel = null;
    this.detachListeners();
    this.closeTransport(channel);
    await channel?.disconnect().catch(() => undefined);
    if (this.generation !== stopGeneration) return;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("disconnected");
  }

  async reconnect(): Promise<ChannelActionResult> {
    await this.stop();
    try {
      await this.start();
      return { ok: true, detail: this.getStatus().detail };
    } catch (error) {
      return { ok: false, detail: this.safeError(error) };
    }
  }

  getStatus(): ChannelStatus {
    return {
      channelId: this.channelId,
      platform: this.platform,
      accountId: this.config.appId,
      state: this.state,
      connected: this.state === "connected",
      detail: this.statusDetail(),
      lastError: this.lastError,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt,
    };
  }

  async send(message: OutboundMessage): Promise<boolean> {
    const channel = this.channel;
    const text = message.text.trim();
    const chatId = this.chatIdFromConversation(message.conversationId);
    if (!channel || this.state !== "connected" || !chatId || !text) return false;

    try {
      await channel.send(
        chatId,
        { text },
        message.replyToMessageId ? { replyTo: message.replyToMessageId } : undefined,
      );
      return true;
    } catch (error) {
      this.emit({
        type: "error",
        channelId: this.channelId,
        platform: this.platform,
        message: `飞书消息发送失败：${this.safeError(error)}`,
      });
      return false;
    }
  }

  async sendMedia(message: OutboundMediaMessage): Promise<ChannelSendResult> {
    const channel = this.channel;
    const chatId = this.chatIdFromConversation(message.conversationId);
    if (!channel || this.state !== "connected") {
      return { ok: false, detail: "飞书机器人尚未连接，媒体暂未发送", retryable: true };
    }
    if (!chatId) {
      return { ok: false, detail: "飞书未找到可回复的会话目标，请先收到一条新消息", retryable: false };
    }

    const prepared = await prepareOutboundMediaSource(
      message.media.source,
      message.media.kind,
      message.media.kind === "file"
        ? inferOutboundMediaFileName(message.media.source, "file", message.media.fileName)
        : undefined,
    );
    try {
      if (message.media.caption?.trim()) {
        await channel.send(
          chatId,
          { text: message.media.caption.trim() },
          message.replyToMessageId ? { replyTo: message.replyToMessageId } : undefined,
        );
      }
      if (message.media.kind === "image") {
        await channel.send(
          chatId,
          { image: { source: prepared.path } },
          message.replyToMessageId ? { replyTo: message.replyToMessageId } : undefined,
        );
      } else {
        await channel.send(
          chatId,
          { file: { source: prepared.path, fileName: prepared.fileName } },
          message.replyToMessageId ? { replyTo: message.replyToMessageId } : undefined,
        );
      }
      return { ok: true, detail: `飞书${message.media.kind === "image" ? "图片" : "文件"}已发送` };
    } catch (error) {
      const detail = this.safeError(error);
      this.emit({
        type: "error",
        channelId: this.channelId,
        platform: this.platform,
        message: `飞书媒体发送失败：${detail}`
      });
      const isSizeLimit = /(?:413|too\s+large|payload|size|文件.*大|图片.*大|超过|超限)/iu.test(detail);
      return { ok: false, detail, retryable: !isSizeLimit };
    } finally {
      await prepared.cleanup();
    }
  }

  subscribe(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async startInternal(): Promise<void> {
    if (!FEISHU_APP_ID_PATTERN.test(this.config.appId)) {
      const detail = "飞书 AppID 格式无效，应为 cli_ 开头的应用 ID";
      this.setState("failed", detail);
      throw new Error(detail);
    }
    if (!this.config.appSecret.trim()) {
      const detail = "飞书机器人未配置 AppSecret";
      this.setState("failed", detail);
      throw new Error(detail);
    }

    const generation = ++this.generation;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("connecting");

    const { createLarkChannel, Domain, LoggerLevel } = await import("@larksuiteoapi/node-sdk");
    if (!this.isCurrent(generation)) throw new Error("飞书连接已取消");

    const channel = createLarkChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      transport: "websocket",
      domain: Domain.Feishu,
      source: "penguin-desktop-pet",
      logger: this.createLogger(generation),
      loggerLevel: LoggerLevel.warn,
      includeRawEvent: false,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 15 },
      policy: {
        dmMode: "open",
        requireMention: true,
        respondToMentionAll: false,
      },
      safety: {
        dedup: { ttl: 60 * 60_000, maxEntries: 2048 },
        chatQueue: { enabled: false },
        staleMessageWindowMs: 5 * 60_000,
      },
      outbound: {
        retry: { maxAttempts: 3, baseDelayMs: 500 },
      },
    });
    this.channel = channel;
    this.unsubscribers = [
      channel.on("message", (message) => this.handleMessage(generation, channel, message)),
      channel.on("reconnecting", () => this.handleReconnecting(generation, channel)),
      channel.on("reconnected", () => this.handleReconnected(generation, channel)),
      channel.on("error", (error) => this.handleError(generation, channel, error)),
    ];

    try {
      await channel.connect();
      if (!this.isCurrent(generation, channel)) throw new Error("飞书连接已取消");
      this.retryCount = 0;
      this.nextRetryAt = null;
      this.setState("connected");
    } catch (error) {
      if (this.isCurrent(generation, channel)) {
        this.channel = null;
        this.detachListeners();
        this.closeTransport(channel);
        await channel.disconnect().catch(() => undefined);
        this.setState("failed", this.safeError(error));
      }
      throw new Error(this.safeError(error));
    }
  }

  private handleMessage(generation: number, channel: LarkChannel, message: NormalizedMessage): void {
    if (!this.isCurrent(generation, channel)) return;
    const text = message.content.trim();
    if (!text || !message.messageId || !message.chatId || !message.senderId) return;

    this.emit({
      type: "message",
      message: {
        id: message.messageId,
        channelId: this.channelId,
        platform: this.platform,
        accountId: this.config.appId,
        conversationId: `chat:${message.chatId}`,
        senderId: message.senderId,
        senderName: message.senderName,
        conversationType: message.chatType === "p2p" ? "direct" : "group",
        text,
        timestamp: Number.isFinite(message.createTime) && message.createTime > 0 ? message.createTime : Date.now(),
      },
    });
  }

  private handleReconnecting(generation: number, channel: LarkChannel): void {
    if (!this.isCurrent(generation, channel)) return;
    const status = channel.getConnectionStatus();
    this.retryCount = status?.reconnectAttempts ?? this.retryCount + 1;
    this.nextRetryAt = status?.nextConnectTime ?? null;
    this.setState("reconnecting", "飞书长连接中断，正在自动重连");
  }

  private handleReconnected(generation: number, channel: LarkChannel): void {
    if (!this.isCurrent(generation, channel)) return;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("connected");
  }

  private handleError(generation: number, channel: LarkChannel, error: LarkChannelError): void {
    if (!this.isCurrent(generation, channel)) return;
    const detail = this.safeError(error);
    const connection = channel.getConnectionStatus();
    if (connection?.state === "failed") this.setState("failed", detail);
    this.emit({ type: "error", channelId: this.channelId, platform: this.platform, message: detail });
  }

  private chatIdFromConversation(conversationId?: string): string {
    if (!conversationId) return "";
    return conversationId.startsWith("chat:") ? conversationId.slice(5) : conversationId;
  }

  private isCurrent(generation: number, channel?: LarkChannel): boolean {
    return this.generation === generation && (!channel || this.channel === channel);
  }

  private detachListeners(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /**
   * The Feishu SDK's force-close path calls ws.terminate() without guarding
   * CONNECTING sockets. A handshake timeout can therefore throw outside the
   * adapter and crash Electron's main process. Closing is best effort here;
   * the SDK's disconnect/reconnect state remains the source of truth.
   */
  private closeTransport(channel: LarkChannel | null): void {
    if (!channel?.rawWsClient) return;
    try {
      channel.rawWsClient.close({ force: true });
    } catch (error) {
      console.warn(`[Feishu ${this.config.appId}] websocket close skipped: ${this.safeError(error)}`);
    }
  }

  private createLogger(generation: number): Logger {
    const report = (...values: unknown[]): void => {
      if (!this.isCurrent(generation)) return;
      const detail = values.map((value) => value instanceof Error ? value.message : String(value)).join(" ");
      if (detail) console.warn(`[Feishu ${this.config.appId}] ${this.safeText(detail)}`);
    };
    return {
      error: report,
      warn: report,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    };
  }

  private statusDetail(): string {
    if (this.state === "connected") return `已连接 · AppID ${this.config.appId}`;
    if (this.state === "connecting") return "正在连接飞书长连接…";
    if (this.state === "reconnecting") return "连接中断，正在自动重连…";
    if (this.state === "failed") return this.lastError ? `连接失败：${this.lastError}` : "连接失败";
    return "未连接";
  }

  private setState(state: ChannelStatus["state"], lastError = ""): void {
    this.state = state;
    if (lastError) this.lastError = this.safeText(lastError);
    else if (state === "connected" || state === "disconnected") this.lastError = "";
    this.emit({ type: "status", status: this.getStatus() });
  }

  private safeError(error: unknown): string {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const detail = error instanceof Error ? error.message : String(error);
    const lowered = `${code} ${detail}`.toLowerCase();
    if (lowered.includes("99991663") || lowered.includes("permission_denied") || lowered.includes("forbidden")) {
      return "飞书应用权限不足，请重新扫码授权消息权限";
    }
    if (lowered.includes("99991661") || lowered.includes("unauthorized") || lowered.includes("invalid app")) {
      return "飞书 AppID 或 AppSecret 无效";
    }
    if (lowered.includes("timeout") || detail.includes("超时")) {
      return "连接飞书超时，请检查网络后重试";
    }
    return this.safeText(detail || "未知错误");
  }

  private safeText(value: string): string {
    return value.replaceAll(this.config.appSecret, "***").trim();
  }

  private emit(event: Parameters<ChannelEventListener>[0]): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
