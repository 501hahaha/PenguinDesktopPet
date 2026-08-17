import type {
  Logger,
  QQBot as QQBotClient,
  QQBotInboundMessage,
  ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import type {
  BotChannelAdapter,
  ChannelActionResult,
  ChannelEventListener,
  ChannelSendResult,
  ChannelStatus,
  OutboundMediaMessage,
  OutboundMessage,
} from "./types";
import type { QQChannelConfig } from "./qqConfig";
import { inferOutboundMediaFileName, normalizeOutboundMediaSource } from "../media/OutboundMediaSource";

const READY_TIMEOUT_MS = 30_000;
const MAX_REPLY_TARGET_CACHE_ENTRIES = 512;

/**
 * QQ Bot 的 API/网关会把一次请求超时通过 error 回调抛出来，但 WebSocket
 * 连接和机器人本身仍然可能可用。此类瞬时网络抖动不能直接把桌宠标成
 * “QQ 通道异常”，否则下一次成功发送前用户会看到错误状态。
 */
function isTransientNetworkError(value: unknown): boolean {
  const detail = value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value);
  return /(?:fetch failed|network error|connect timeout|connection reset|econnreset|econnrefused|socket hang up|etimedout|enotfound)/i.test(detail);
}

export class QQChannelAdapter implements BotChannelAdapter {
  readonly platform = "qq" as const;
  private readonly listeners = new Set<ChannelEventListener>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private bot: QQBotClient | null = null;
  private runPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private stopping = false;
  private state: ChannelStatus["state"] = "disconnected";
  private lastError = "";
  private retryCount = 0;
  private nextRetryAt: number | null = null;

  constructor(
    private readonly config: QQChannelConfig,
  ) {}

  get channelId(): string {
    return this.config.channelId;
  }

  async start(): Promise<void> {
    if (this.bot) return;
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
    this.stopping = true;
    const bot = this.bot;
    const runPromise = this.runPromise;
    this.bot = null;

    bot?.stop();
    if (runPromise) await runPromise.catch(() => undefined);

    if (this.generation !== stopGeneration) return;
    this.runPromise = null;
    this.replyTargets.clear();
    this.stopping = false;
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
    const bot = this.bot;
    const text = message.text.trim();
    if (!bot || this.state !== "connected" || !message.conversationId) return false;

    const target = this.resolveReplyTarget(message);
    if (!target) return false;

    try {
      if (!text) return false;
      await bot.sendText(target, text);
      this.markDeliverySuccess();
      return true;
    } catch (error) {
      // BotChannelManager 会负责重试；不要在单次重试失败时先把桌宠
      // 切到 QQ 异常，避免后续实际发送成功时仍残留错误提示。
      console.warn(`[QQ ${this.config.appId}] message delivery attempt failed: ${this.safeError(error)}`);
      return false;
    }
  }

  async sendMedia(message: OutboundMediaMessage): Promise<ChannelSendResult> {
    const bot = this.bot;
    if (!bot || this.state !== "connected" || !message.conversationId) {
      return { ok: false, detail: "QQ 机器人尚未连接，媒体暂未发送", retryable: true };
    }
    const target = this.resolveReplyTarget(message);
    if (!target) return { ok: false, detail: "QQ 未找到可回复的会话目标，请先收到一条新消息", retryable: false };

    try {
      const source = normalizeOutboundMediaSource(message.media.source);
      const sourceInput = /^https?:\/\//i.test(source) ? { url: source } : { localPath: source };
      if (message.media.kind === "image") {
        await bot.sendImage(target, sourceInput, { content: message.media.caption });
      } else {
        await bot.sendFile(target, sourceInput, {
          content: message.media.caption,
          fileName: inferOutboundMediaFileName(message.media.source, "file", message.media.fileName),
        });
      }
      this.markDeliverySuccess();
      return { ok: true, detail: "QQ 媒体已发送" };
    } catch (error) {
      const detail = this.safeError(error);
      const isSizeLimit = /(?:413|too\s+large|file\s+size|size\s+limit|payload\s+too\s+large|超限|超过|文件大小|附件过大)/iu.test(detail);
      console.warn(`[QQ ${this.config.appId}] media delivery attempt failed: ${detail}`);
      return { ok: false, detail, retryable: !isSizeLimit };
    }
  }

  subscribe(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async startInternal(): Promise<void> {
    if (!this.config.clientSecret) {
      const detail = this.config.accessToken
        ? "新版 QQ 通道需要 AppSecret，原有 Access Token 不能用于扫码连接，请重新扫码或填写 AppSecret"
        : "QQ 机器人未配置 AppSecret，请重新扫码或填写 AppSecret";
      this.setState("failed", detail);
      throw new Error(detail);
    }

    const generation = ++this.generation;
    this.stopping = false;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("connecting");

    // Both Tencent packages are ESM-only. Keep this as a native dynamic import
    // so Electron does not route the package through CommonJS require().
    const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
    if (!this.isCurrent(generation)) throw new Error("QQ 连接已取消");

    let initialSettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (): void => {
      if (initialSettled) return;
      initialSettled = true;
      resolveReady();
    };
    const settleFailure = (error: unknown): void => {
      if (initialSettled) return;
      initialSettled = true;
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    };

    const bot = new QQBot({
      appId: this.config.appId,
      appSecret: this.config.clientSecret,
      accountId: this.channelId,
      logger: this.createLogger(generation, settleFailure),
      tokenPrefetch: "sync",
      transport: "websocket",
    });
    this.bot = bot;

    const markReady = (): void => {
      if (!this.isCurrent(generation, bot)) return;
      this.retryCount = 0;
      this.nextRetryAt = null;
      this.setState("connected");
      settleReady();
    };
    bot.on("ready", markReady);
    bot.on("resumed", markReady);
    bot.on("error", (error) => this.handleSdkError(generation, bot, error));
    bot.on("message", (_context, message) => this.emitMessage(generation, bot, message));

    const runPromise = bot.start()
      .then(() => {
        if (!initialSettled) {
          settleFailure(new Error(this.stopping ? "QQ 连接已取消" : "QQ 网关在就绪前停止"));
        }
        if (this.isCurrent(generation, bot) && !this.stopping && this.state !== "failed") {
          this.setState("failed", "QQ 网关连接已停止");
        }
      })
      .catch((error: unknown) => {
        settleFailure(error);
        if (this.isCurrent(generation, bot) && !this.stopping) {
          this.setState("failed", this.safeError(error));
        }
      });
    this.runPromise = runPromise;

    const timeout = setTimeout(() => {
      settleFailure(new Error("连接 QQ 网关超时，请检查网络后重试"));
    }, READY_TIMEOUT_MS);

    try {
      await readyPromise;
    } catch (error) {
      if (this.isCurrent(generation, bot)) {
        this.bot = null;
        bot.stop();
        await runPromise.catch(() => undefined);
        if (!this.stopping) this.setState("failed", this.safeError(error));
      }
      throw new Error(this.safeError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitMessage(generation: number, bot: QQBotClient, message: QQBotInboundMessage): void {
    if (!this.isCurrent(generation, bot) || message.senderIsBot) return;
    const text = message.content.trim();
    if (!text || !message.senderId || !message.messageId) return;
    this.markDeliverySuccess();

    const conversationType = message.replyTarget.scope === "c2c" ? "direct" : "group";
    const conversationId = `${message.replyTarget.scope}:${message.replyTarget.targetId}`;
    const normalizedMessageId = `${this.channelId}:${message.messageId}`;
    this.rememberReplyTarget(normalizedMessageId, conversationId, message.replyTarget);

    const parsedTimestamp = Date.parse(message.timestamp);
    this.emit({
      type: "message",
      message: {
        id: normalizedMessageId,
        channelId: this.channelId,
        platform: this.platform,
        accountId: this.config.appId,
        conversationId,
        senderId: message.senderId,
        senderName: message.senderName,
        conversationType,
        text,
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
        raw: message.raw,
      },
    });
  }

  private rememberReplyTarget(messageId: string, conversationId: string, target: ReplyTarget): void {
    const snapshot = { ...target };
    this.replyTargets.set(messageId, snapshot);
    this.replyTargets.set(conversationId, snapshot);
    while (this.replyTargets.size > MAX_REPLY_TARGET_CACHE_ENTRIES) {
      const oldestKey = this.replyTargets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.replyTargets.delete(oldestKey);
    }
  }

  private resolveReplyTarget(message: OutboundMessage | OutboundMediaMessage): ReplyTarget | null {
    if (message.replyToMessageId) {
      const replyTarget = this.replyTargets.get(message.replyToMessageId);
      if (replyTarget) return { ...replyTarget };
    }

    const recentTarget = message.conversationId
      ? this.replyTargets.get(message.conversationId)
      : undefined;
    if (recentTarget) return { ...recentTarget };

    const conversationId = message.conversationId;
    if (!conversationId) return null;
    const separator = conversationId.indexOf(":");
    if (separator > 0) {
      const scope = conversationId.slice(0, separator);
      const targetId = conversationId.slice(separator + 1);
      if ((scope === "c2c" || scope === "group") && targetId) return { scope, targetId };
    }

    if (message.conversationType === "direct") return { scope: "c2c", targetId: conversationId };
    if (message.conversationType === "group") return { scope: "group", targetId: conversationId };
    return null;
  }

  private createLogger(generation: number, onFatal: (error: Error) => void): Logger {
    return {
      info: (message) => {
        if (!this.isCurrent(generation) || this.stopping) return;
        if (message.includes("WebSocket closed")) {
          this.retryCount += 1;
          this.setState("reconnecting", "QQ 连接中断，正在自动重连");
        }
      },
      warn: (message) => {
        if (!this.isCurrent(generation) || this.stopping) return;
        console.warn(`[QQ ${this.config.appId}] ${this.safeText(message)}`);
      },
      error: (message) => {
        if (!this.isCurrent(generation) || this.stopping) return;
        const detail = this.safeText(message);
        if (message.includes("Bot is offline")) {
          const fatalDetail = "QQ Bot 尚未上线，或当前仅允许沙箱连接";
          this.setState("failed", fatalDetail);
          onFatal(new Error(fatalDetail));
          return;
        }
        if (message.includes("Bot is banned")) {
          const fatalDetail = "QQ Bot 网关权限已被禁用，请检查开放平台状态";
          this.setState("failed", fatalDetail);
          onFatal(new Error(fatalDetail));
          return;
        }
        if (message.includes("Max reconnect attempts reached")) {
          const fatalDetail = "QQ 网关重连失败，请手动重试";
          this.setState("failed", fatalDetail);
          onFatal(new Error(fatalDetail));
          return;
        }
        if (isTransientNetworkError(message)) {
          // 这是单次 API/网络请求抖动，不等于 QQ 网关已经掉线。保留
          // 当前连接状态，避免微信的异常表现被用户误认为 QQ 异常。
          console.warn(`[QQ ${this.config.appId}] transient network warning: ${detail}`);
          return;
        }
        if (message.includes("Connection failed") && this.state === "connected") {
          this.retryCount += 1;
          this.setState("reconnecting", "QQ 连接中断，正在自动重连");
        }
        console.warn(`[QQ ${this.config.appId}] ${detail}`);
      },
      debug: () => undefined,
    };
  }

  private handleSdkError(generation: number, bot: QQBotClient, error: Error): void {
    if (!this.isCurrent(generation, bot) || this.stopping) return;
    if (isTransientNetworkError(error)) {
      console.warn(`[QQ ${this.config.appId}] transient SDK network warning: ${this.safeError(error)}`);
      return;
    }
    this.retryCount += 1;
    this.setState(
      this.state === "connected" || this.state === "reconnecting" ? "reconnecting" : "connecting",
      this.safeError(error),
    );
  }

  private isCurrent(generation: number, bot?: QQBotClient): boolean {
    return this.generation === generation && (!bot || this.bot === bot);
  }

  private statusDetail(): string {
    if (this.state === "connected") return `已连接 · AppID ${this.config.appId}`;
    if (this.state === "connecting") return "正在连接 QQ 网关…";
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

  private markDeliverySuccess(): void {
    if (this.state === "connected" && !this.lastError && this.retryCount === 0 && this.nextRetryAt === null) return;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("connected");
  }

  private safeError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const lowered = detail.toLowerCase();
    if (lowered.includes("401") || lowered.includes("unauthorized") || lowered.includes("invalid app")) {
      return "AppID 或 AppSecret 无效，请重新扫码";
    }
    if (lowered.includes("timeout") || detail.includes("超时")) {
      return "连接 QQ 网关超时，请检查网络后重试";
    }
    return this.safeText(detail || "未知错误");
  }

  private safeText(value: string): string {
    let sanitized = value;
    if (this.config.clientSecret) sanitized = sanitized.replaceAll(this.config.clientSecret, "***");
    if (this.config.accessToken) sanitized = sanitized.replaceAll(this.config.accessToken, "***");
    return sanitized.trim();
  }

  private emit(event: Parameters<ChannelEventListener>[0]): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
