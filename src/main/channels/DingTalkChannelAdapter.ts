import type { DWClient, DWClientDownStream, RobotMessage } from "dingtalk-stream";
import type {
  BotChannelAdapter,
  ChannelActionResult,
  ChannelEventListener,
  ChannelSendResult,
  ChannelStatus,
  OutboundMediaMessage,
  OutboundMessage,
} from "./types";

const READY_TIMEOUT_MS = 15_000;
const MONITOR_INTERVAL_MS = 4_000;
const MAX_REPLY_TARGET_CACHE_ENTRIES = 512;

interface DingTalkChannelConfig {
  channelId: string;
  clientId: string;
  clientSecret: string;
}

interface ReplyTarget {
  conversationId: string;
  sessionWebhook: string;
  senderStaffId: string;
  expiresAt: number;
}

interface DingTalkTextReply {
  at: {
    atUserIds: string[];
    isAtAll: boolean;
  };
  text: { content: string };
  msgtype: "text";
}

export class DingTalkChannelAdapter implements BotChannelAdapter {
  readonly platform = "dingtalk" as const;
  private readonly listeners = new Set<ChannelEventListener>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private client: DWClient | null = null;
  private startPromise: Promise<void> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private stopping = false;
  private state: ChannelStatus["state"] = "disconnected";
  private lastError = "";
  private retryCount = 0;
  private nextRetryAt: number | null = null;

  constructor(private readonly config: DingTalkChannelConfig) {}

  get channelId(): string {
    return this.config.channelId;
  }

  async start(): Promise<void> {
    if (this.client && this.state === "connected") return;
    if (this.startPromise) return this.startPromise;
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    const stopGeneration = ++this.generation;
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    const client = this.client;
    this.client = null;
    client?.disconnect();
    this.replyTargets.clear();
    if (this.generation !== stopGeneration) return;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.stopping = false;
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
      accountId: this.config.clientId,
      state: this.state,
      connected: this.state === "connected",
      detail: this.statusDetail(),
      lastError: this.lastError,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt,
    };
  }

  async send(message: OutboundMessage): Promise<boolean> {
    const client = this.client;
    const text = message.text.trim();
    if (!client || this.state !== "connected" || !text) return false;
    const target = this.resolveReplyTarget(message);
    if (!target || target.expiresAt <= Date.now()) return false;

    try {
      const accessToken = String(await client.getAccessToken());
      const body: DingTalkTextReply = {
        at: {
          atUserIds: target.senderStaffId ? [target.senderStaffId] : [],
          isAtAll: false,
        },
        text: { content: text },
        msgtype: "text",
      };
      const response = await fetch(target.sessionWebhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.emit({
        type: "error",
        channelId: this.channelId,
        platform: this.platform,
        message: `钉钉消息发送失败：${this.safeError(error)}`,
      });
      return false;
    }
  }

  async sendMedia(_message: OutboundMediaMessage): Promise<ChannelSendResult> {
    return {
      ok: false,
      detail: "DingTalk Stream replies currently use sessionWebhook (Webhook mode); according to DingTalk official docs, Webhook mode supports text/markdown/link/action_card/feedCard only, not image or file. Sending files would require the separate API-based robot messaging flow.",
      retryable: false,
    };
  }

  subscribe(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async startInternal(): Promise<void> {
    if (!this.config.clientId.trim() || !this.config.clientSecret.trim()) {
      const detail = "钉钉机器人未配置 Client ID 或 Client Secret";
      this.setState("failed", detail);
      throw new Error(detail);
    }

    const generation = ++this.generation;
    this.stopping = false;
    this.retryCount = 0;
    this.nextRetryAt = null;
    this.setState("connecting");

    const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");
    if (!this.isCurrent(generation)) throw new Error("钉钉连接已取消");

    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      keepAlive: true,
      debug: false,
      ua: "penguin-desktop-pet",
    });
    this.client = client;
    client.registerCallbackListener(TOPIC_ROBOT, (streamMessage) => {
      this.handleStreamMessage(generation, client, streamMessage);
    });
    this.monitorTimer = setInterval(() => this.monitorConnection(generation, client), MONITOR_INTERVAL_MS);

    try {
      await client.connect();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (this.isCurrent(generation, client) && !client.connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!this.isCurrent(generation, client)) throw new Error("钉钉连接已取消");
      if (!client.connected) throw new Error("钉钉 Stream 连接超时，请检查 Client ID、Client Secret 和网络");
      this.retryCount = 0;
      this.nextRetryAt = null;
      this.setState("connected");
    } catch (error) {
      if (this.isCurrent(generation, client)) {
        this.cleanupClient(client);
        this.setState("failed", this.safeError(error));
      }
      throw new Error(this.safeError(error));
    }
  }

  private handleStreamMessage(generation: number, client: DWClient, streamMessage: DWClientDownStream): void {
    if (!this.isCurrent(generation, client)) return;
    // DingTalk retries callback messages when no response is sent within a short window.
    // Acknowledge before parsing or routing so Agent execution never holds the Stream socket.
    client.socketCallBackResponse(streamMessage.headers.messageId, { status: "SUCCESS" });

    let message: RobotMessage;
    try {
      message = JSON.parse(streamMessage.data) as RobotMessage;
    } catch {
      return;
    }
    if (message.msgtype !== "text") return;
    const text = message.text?.content?.trim();
    const messageId = message.msgId?.trim();
    const conversationId = message.conversationId?.trim();
    const sessionWebhook = message.sessionWebhook?.trim();
    if (!text || !messageId || !conversationId || !message.senderStaffId || !sessionWebhook) return;

    const expiresAt = Number.isFinite(message.sessionWebhookExpiredTime) && message.sessionWebhookExpiredTime > 0
      ? message.sessionWebhookExpiredTime
      : Date.now() + 5 * 60_000;
    const target: ReplyTarget = {
      conversationId,
      sessionWebhook,
      senderStaffId: message.senderStaffId,
      expiresAt,
    };
    this.rememberReplyTarget(`${this.channelId}:${messageId}`, target);
    this.rememberReplyTarget(`conversation:${conversationId}`, target);
    this.emit({
      type: "message",
      message: {
        id: `${this.channelId}:${messageId}`,
        channelId: this.channelId,
        platform: this.platform,
        accountId: this.config.clientId,
        conversationId: `conversation:${conversationId}`,
        senderId: message.senderStaffId,
        senderName: message.senderNick,
        conversationType: message.conversationType === "1" ? "direct" : "group",
        text,
        timestamp: Number.isFinite(message.createAt) && message.createAt > 0 ? message.createAt : Date.now(),
        raw: { conversationType: message.conversationType, msgtype: message.msgtype },
      },
    });
  }

  private monitorConnection(generation: number, client: DWClient): void {
    if (!this.isCurrent(generation, client) || this.stopping) return;
    if (client.connected) {
      if (this.state !== "connected") {
        this.retryCount = 0;
        this.nextRetryAt = null;
        this.setState("connected");
      }
      return;
    }
    if (this.state === "connected") {
      this.retryCount += 1;
      this.nextRetryAt = Date.now() + 1_000;
      this.setState("reconnecting", "钉钉 Stream 连接中断，正在自动重连");
    }
  }

  private rememberReplyTarget(key: string, target: ReplyTarget): void {
    this.replyTargets.set(key, target);
    while (this.replyTargets.size > MAX_REPLY_TARGET_CACHE_ENTRIES) {
      const oldestKey = this.replyTargets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.replyTargets.delete(oldestKey);
    }
  }

  private resolveReplyTarget(message: OutboundMessage): ReplyTarget | null {
    const byMessage = message.replyToMessageId ? this.replyTargets.get(message.replyToMessageId) : undefined;
    const byConversation = message.conversationId ? this.replyTargets.get(message.conversationId) : undefined;
    const target = byMessage ?? byConversation;
    if (!target) return null;
    if (target.expiresAt <= Date.now()) {
      if (message.replyToMessageId) this.replyTargets.delete(message.replyToMessageId);
      if (message.conversationId) this.replyTargets.delete(message.conversationId);
      return null;
    }
    return target;
  }

  private cleanupClient(client: DWClient): void {
    if (this.client === client) this.client = null;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    client.disconnect();
  }

  private isCurrent(generation: number, client?: DWClient): boolean {
    return this.generation === generation && (!client || this.client === client);
  }

  private statusDetail(): string {
    if (this.state === "connected") return `已连接 · Client ID ${this.config.clientId}`;
    if (this.state === "connecting") return "正在连接钉钉 Stream";
    if (this.state === "reconnecting") return "连接中断，正在自动重连";
    if (this.state === "failed") return this.lastError ? `连接失败：${this.lastError}` : "连接失败";
    return "未连接";
  }

  private setState(state: ChannelStatus["state"], lastError = ""): void {
    this.state = state;
    if (lastError) this.lastError = this.safeError(lastError);
    else if (state === "connected" || state === "disconnected") this.lastError = "";
    this.emit({ type: "status", status: this.getStatus() });
  }

  private safeError(error: unknown): string {
    let detail = error instanceof Error ? error.message : String(error);
    if (this.config.clientId) detail = detail.replaceAll(this.config.clientId, "***");
    if (this.config.clientSecret) detail = detail.replaceAll(this.config.clientSecret, "***");
    detail = detail.replace(/https?:\/\/\S+/gi, "[钉钉服务地址]");
    return detail.trim() || "未知错误";
  }

  private emit(event: Parameters<ChannelEventListener>[0]): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

export type { DingTalkChannelConfig };
