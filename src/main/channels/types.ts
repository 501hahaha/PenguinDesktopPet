import type { PetState } from "../../pet/PetStateMachine";

export type BotPlatform = "wechat" | "qq" | "feishu" | "dingtalk";

export type ChannelConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "paused"
  | "reconnecting"
  | "failed"
  | "logged-out";

export interface ChannelStatus {
  channelId: string;
  platform: BotPlatform;
  accountId?: string;
  state: ChannelConnectionState;
  connected: boolean;
  detail: string;
  lastError: string;
  retryCount: number;
  nextRetryAt: number | null;
}

export interface NormalizedInboundMessage {
  id: string;
  channelId: string;
  platform: BotPlatform;
  accountId?: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  conversationType: "direct" | "group";
  text: string;
  timestamp: number;
  action?: PetState;
  /** Platform-specific conversation context used by WeChat's sendmessage API. */
  contextToken?: string;
  raw?: unknown;
}

export interface OutboundMessage {
  conversationId?: string;
  conversationType?: "direct" | "group" | "channel";
  text: string;
  replyToMessageId?: string;
  /** Platform-specific conversation context used by WeChat's sendmessage API. */
  contextToken?: string;
}

export interface OutboundMediaMessage {
  conversationId?: string;
  conversationType?: "direct" | "group" | "channel";
  media: {
    kind: "image" | "file";
    source: string;
    caption?: string;
    fileName?: string;
  };
  replyToMessageId?: string;
  /** Platform-specific conversation context used by WeChat's sendmessage API. */
  contextToken?: string;
}

export interface ChannelSendResult {
  ok: boolean;
  detail: string;
  /** False means retrying will not change the outcome (for example, unsupported media). */
  retryable?: boolean;
}

export interface ChannelActionResult {
  ok: boolean;
  detail: string;
}

export type ChannelAgentStatus =
  | "starting"
  | "thinking"
  | "tool"
  | "command"
  | "network"
  | "waiting"
  | "response-ready"
  | "sending"
  | "completed"
  | "failed";

export type BotChannelEvent =
  | { type: "status"; status: ChannelStatus }
  | { type: "message"; message: NormalizedInboundMessage }
  | {
      type: "agent-status";
      channelId: string;
      platform: BotPlatform;
      conversationId: string;
      messageId?: string;
      status: ChannelAgentStatus;
      detail: string;
    }
  | {
      type: "reply";
      channelId: string;
      platform: BotPlatform;
      conversationId: string;
      messageId?: string;
      text: string;
      delivered: boolean;
    }
  | {
      type: "error";
      channelId: string;
      platform: BotPlatform;
      message: string;
      messageId?: string;
      category?: "connection" | "delivery" | "agent" | "target";
    };

export type ChannelEventListener = (event: BotChannelEvent) => void;

export interface BotChannelAdapter {
  readonly channelId: string;
  readonly platform: BotPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<ChannelActionResult>;
  getStatus(): ChannelStatus;
  send(message: OutboundMessage): Promise<boolean>;
  sendMedia(message: OutboundMediaMessage): Promise<ChannelSendResult>;
  subscribe(listener: ChannelEventListener): () => void;
}
