import type { AgentTaskSurface } from "./perceptionTypes";

export type TaskNotificationUiStatus =
  | "processing"
  | "completed"
  | "failed"
  | "interrupted"
  | "waiting"
  | "need_reply";

export interface TaskNotificationFormatInput {
  status: TaskNotificationUiStatus;
  agentLabel?: string;
  workspaceLabel?: string;
  surface?: AgentTaskSurface | string;
  elapsedSeconds?: number;
  detail?: string;
}

export interface AgentEventNotificationFormatInput {
  status: "processing" | "completed" | "failed" | "interrupted" | "waiting" | "input_required";
  sourceName?: string;
  title?: string;
  message?: string;
  workspaceLabel?: string;
  surface?: AgentTaskSurface | string;
  elapsedSeconds?: number;
}

const STATUS_LABELS: Record<TaskNotificationUiStatus, string> = {
  interrupted: "\u4e2d\u65ad",
  processing: "处理中",
  completed: "完成",
  failed: "失败",
  waiting: "等待",
  need_reply: "需要回复",
};

const STATUS_ICONS: Record<TaskNotificationUiStatus, string> = {
  interrupted: "\uD83D\uDD34",
  processing: "🟡",
  completed: "🟢",
  failed: "🔴",
  waiting: "⏸",
  need_reply: "💬",
};

const EVENT_STATUS_LABELS: Record<AgentEventNotificationFormatInput["status"], string> = {
  processing: "处理中",
  completed: "任务完成",
  failed: "任务失败",
  interrupted: "任务中断",
  waiting: "等待中",
  input_required: "需要回复",
};

const EVENT_STATUS_ICONS: Record<AgentEventNotificationFormatInput["status"], string> = {
  processing: "🟡",
  completed: "🟢",
  failed: "🔴",
  interrupted: "🔴",
  waiting: "⏸",
  input_required: "💬",
};

const MAX_LINE_LENGTH = 150;
const MAX_MESSAGE_LENGTH = 420;

function compactText(value: string | undefined, maxLength = MAX_LINE_LENGTH): string {
  return (value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function compactAgentLabel(value: string | undefined): string {
  const label = compactText(value, 48);
  if (!label) return "Agent";
  if (/codex/i.test(label)) return "Codex";
  if (/claude/i.test(label)) return "Claude";
  if (/hermes/i.test(label)) return "Hermes";
  return label.replace(/\s+(?:Code|CLI|Agent)$/i, "").trim() || "Agent";
}

function compactSurfaceLabel(value: AgentTaskSurface | string | undefined): string {
  switch (value) {
    case "desktop":
      return "ChatGPT";
    case "vscode":
      return "VS Code";
    case "cli":
      return "CLI";
    case "gateway":
      return "Gateway";
    case "service":
      return "服务";
    case "internal":
      return "桌宠";
    default:
      return compactText(value, 40);
  }
}

function compactElapsed(elapsedSeconds: number | undefined): string {
  if (!Number.isFinite(elapsedSeconds) || (elapsedSeconds ?? 0) < 0) return "";
  const total = Math.max(0, Math.floor(elapsedSeconds ?? 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function secondLine(input: TaskNotificationFormatInput): string {
  const workspace = workspaceLabelFromPath(input.workspaceLabel) ?? compactText(input.workspaceLabel, 80);
  const surface = compactSurfaceLabel(input.surface);
  switch (input.status) {
    case "processing":
      return [workspace, surface].filter(Boolean).join(" · ") || "正在处理";
    case "completed":
      return [workspace, compactElapsed(input.elapsedSeconds)].filter(Boolean).join(" · ") || "已结束";
    case "failed":
      return [workspace, "点击查看原因"].filter(Boolean).join(" · ");
    case "interrupted":
      return [workspace, "任务中断"].filter(Boolean).join(" · ");
    case "waiting":
      return [workspace, compactText(input.detail) || "等待工具执行"].filter(Boolean).join(" · ");
    case "need_reply":
      return compactText(input.detail) || "请回复以继续";
  }
}

/** Mobile-safe task notice: exactly one status line plus one bounded context line. */
export function formatTaskNotification(input: TaskNotificationFormatInput): string {
  const line1 = `${STATUS_ICONS[input.status]} ${compactAgentLabel(input.agentLabel)} ${STATUS_LABELS[input.status]}`;
  return `${line1}\n${secondLine(input)}`.slice(0, MAX_MESSAGE_LENGTH);
}

/** Unified event notice: keeps the event title/message instead of falling back to the legacy two-line formatter. */
export function formatAgentEventNotification(input: AgentEventNotificationFormatInput): string {
  const source = compactAgentLabel(input.sourceName);
  const title = compactText(input.title, 120);
  const message = compactText(input.message, 180);
  const workspace = workspaceLabelFromPath(input.workspaceLabel);
  const surface = compactSurfaceLabel(input.surface);
  const elapsed = compactElapsed(input.elapsedSeconds);
  const context = [workspace, surface, elapsed].filter(Boolean).join(" · ");
  const lines = [
    `${EVENT_STATUS_ICONS[input.status]} ${source} · ${EVENT_STATUS_LABELS[input.status]}`,
    title,
    message && message !== title ? message : "",
    context,
  ].filter(Boolean);
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

export function elapsedSecondsBetween(startedAt?: string | null, completedAt?: string | null): number | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function workspaceLabelFromPath(value: string | undefined): string | undefined {
  const normalized = compactText(value, 240).replace(/[\\/]+$/, "");
  if (!normalized || normalized === "<local-path>" || normalized === "<redacted>" || /^[A-Za-z]:$/.test(normalized)) return undefined;
  const segment = normalized.split(/[\\/]/).at(-1)?.trim();
  return segment ? compactText(segment, 80) : undefined;
}
