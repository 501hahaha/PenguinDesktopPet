import type { WeChatBridge } from "../wechat/WeChatBridge";
import type { WeChatEvent } from "../wechat/events";
import type {
  BotChannelAdapter,
  ChannelActionResult,
  ChannelEventListener,
  ChannelSendResult,
  ChannelStatus,
  OutboundMediaMessage,
  OutboundMessage,
} from "./types";

export class WeChatChannelAdapter implements BotChannelAdapter {
  readonly platform = "wechat" as const;

  constructor(
    private readonly bridge: WeChatBridge,
    readonly channelId = "wechat:active",
  ) {}

  start(): Promise<void> {
    return this.bridge.start();
  }

  stop(): Promise<void> {
    return this.bridge.stop();
  }

  reconnect(): Promise<ChannelActionResult> {
    return this.bridge.reconnect();
  }

  getStatus(): ChannelStatus {
    const status = this.bridge.status;
    return {
      channelId: this.channelId,
      platform: this.platform,
      accountId: status.accountId,
      state: status.state,
      connected: status.connected,
      detail: status.detail,
      lastError: status.lastError,
      retryCount: status.retryCount,
      nextRetryAt: status.nextRetryAt,
    };
  }

  send(message: OutboundMessage): Promise<boolean> {
    return message.conversationId
      ? this.bridge.sendReplyTo(message.conversationId, message.text, message.contextToken)
      : this.bridge.sendReply(message.text);
  }

  sendMedia(message: OutboundMediaMessage): Promise<ChannelSendResult> {
    return this.bridge.sendMedia(message);
  }

  subscribe(listener: ChannelEventListener): () => void {
    return this.bridge.subscribe((event) => this.mapEvent(event, listener));
  }

  private mapEvent(event: WeChatEvent, listener: ChannelEventListener): void {
    if (event.type === "connection") {
      listener({ type: "status", status: this.getStatus() });
      return;
    }

    if (event.type === "message") {
      const status = this.getStatus();
      listener({
        type: "message",
        message: {
          id: event.id,
          channelId: this.channelId,
          platform: this.platform,
          accountId: status.accountId,
          conversationId: event.from,
          senderId: event.from,
          conversationType: "direct",
          text: event.text,
          timestamp: Date.now(),
          action: event.action,
          contextToken: event.contextToken,
          raw: event,
        },
      });
      return;
    }

    if (event.type === "error") {
      listener({
        type: "error",
        channelId: this.channelId,
        platform: this.platform,
        message: event.message,
        category: event.category,
      });
    }
  }
}
