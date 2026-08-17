import type { PetState } from "../../pet/PetStateMachine";

export type AgentStatus =
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

export type WeChatQrLoginStatus =
  | "requesting"
  | "waiting"
  | "scanned"
  | "connecting"
  | "confirmed"
  | "expired"
  | "cancelled"
  | "error";

export type WeChatConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "paused"
  | "reconnecting"
  | "failed"
  | "logged-out";

export type WeChatErrorCategory = "connection" | "delivery" | "agent" | "target";

export interface WeChatStatus {
  state: WeChatConnectionState;
  connected: boolean;
  detail: string;
  lastError: string;
  retryCount: number;
  nextRetryAt: number | null;
  accountId?: string;
}

export interface WeChatQrLoginProgress {
  status: Exclude<WeChatQrLoginStatus, "requesting" | "connecting" | "confirmed" | "cancelled" | "error">;
  detail: string;
  qrDataUrl?: string;
}

export type WeChatEvent =
  | ({ type: "connection" } & WeChatStatus)
  | { type: "message"; id: string; from: string; text: string; action: PetState; contextToken?: string; accountId?: string }
  | { type: "blocked"; from: string }
  | { type: "qr-login"; status: WeChatQrLoginStatus; detail: string; qrDataUrl?: string; accountId?: string }
  | { type: "thinking"; detail: string }
  | { type: "agent-status"; status: AgentStatus; detail: string; from?: string; messageId?: string }
  | { type: "reply"; to: string; text: string }
  | { type: "error"; message: string; category?: WeChatErrorCategory };

export interface WeChatActions {
  sendReply(text: string): Promise<boolean>;
  getStatus(): Promise<WeChatStatus>;
}

export type WeChatEventListener = (event: WeChatEvent) => void;

export function inferAction(text: string): PetState {
  const positive = /happy|good|thanks|okay|ok|hello|hi/i;
  const sad = /sad|cry|disappoint|upset|sorry/i;
  const angry = /angry|mad|furious|!!|❌/i;
  const sleepy = /sleep|good night|good morning|zzz|😴/i;
  const eating = /eat|food|hungry|breakfast|lunch|dinner/i;
  const walking = /walk|outside|go out|stroll|leave/i;
  const shy = /shy|embarrass|blush|😳|🙈/i;

  if (angry.test(text)) return "angry";
  if (sad.test(text) || text.includes(":(")) return "shy";
  if (sleepy.test(text)) return "sleep";
  if (eating.test(text)) return "eat";
  if (walking.test(text)) return "walk";
  if (shy.test(text)) return "shy";
  if (positive.test(text)) return "happy";
  return "happy";
}

export function summarize(text: string, maxLength = 24): string {
  const singleLine = text.split(" ").filter(Boolean).join(" ");
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}
