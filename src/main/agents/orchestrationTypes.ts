import type { TaskNotificationPlatform } from "../../settings/types";

/**
 * Agent 编排的跨层类型契约。
 *
 * 这些类型只描述可展示、可关联的身份和安全摘要，不承载 prompt、聊天正文、
 * 命令参数、工具输出、凭据或插件私有数据。具体的执行适配器、事件桥和通知
 * 路由会在后续阶段实现。
 */

export type AgentEndpointKind = "cli" | "desktop" | "vscode-extension" | "gateway" | "service";
export type AgentEndpointSurface = "internal" | "desktop" | "cli" | "vscode" | "gateway" | "service";
export type AgentEndpointConnection = "offline" | "discovered" | "connected" | "degraded" | "unknown";
export type AgentEndpointCapability = "dispatch" | "observe" | "cancel" | "pause" | "resume" | "input" | "result";
export type AgentEndpointSource = "registry" | "process" | "event-bridge" | "app-server" | "gateway" | "manual";

export interface AgentEndpoint {
  endpointId: string;
  agentId: string;
  displayName: string;
  kind: AgentEndpointKind;
  surface: AgentEndpointSurface;
  hostId: string;
  workspaceId?: string;
  workspaceLabel?: string;
  connection: AgentEndpointConnection;
  capabilities: readonly AgentEndpointCapability[];
  source: AgentEndpointSource;
  lastSeenAt: string;
}

export interface AgentEndpointRegisterMessage {
  type: "register";
  endpoint: Omit<AgentEndpoint, "connection" | "source" | "lastSeenAt">;
}

export interface AgentEndpointHeartbeatMessage {
  type: "heartbeat";
  endpointId: string;
  hostId?: string;
  occurredAt: string;
}

export interface AgentEndpointUnregisterMessage {
  type: "unregister";
  endpointId: string;
  hostId?: string;
}

export type AgentEndpointBridgeMessage =
  | AgentEndpointRegisterMessage
  | AgentEndpointHeartbeatMessage
  | AgentEndpointUnregisterMessage;

/** 主 Agent 发给已注册 Worker/插件宿主的短期委派请求，不会写入端点注册表。 */
export interface AgentDispatchRequest {
  type: "dispatch";
  requestId: string;
  taskId: string;
  title: string;
  instruction: string;
  workspaceId?: string;
}

/** 已委派任务的后续输入；保持 taskId/sessionId，让宿主继续原有工作区会话。 */
export interface AgentTaskMessageRequest {
  type: "message";
  requestId: string;
  taskId: string;
  message: string;
  sessionId?: string;
  workspaceId?: string;
}

export type AgentTaskRequest = AgentDispatchRequest | AgentTaskMessageRequest;

export type AgentEndpointBridgeMessageNormalization =
  | { handled: false }
  | { handled: true; ok: true; message: AgentEndpointBridgeMessage }
  | { handled: true; ok: false; error: string };

export type DelegationTaskStatus =
  | "queued"
  | "accepted"
  | "planning"
  | "running"
  | "waiting-input"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationActivity =
  | "starting"
  | "thinking"
  | "tool"
  | "editing"
  | "command"
  | "network"
  | "waiting"
  | "response-ready";

export interface DelegationTask {
  taskId: string;
  requestId: string;
  parentConversationId?: string;
  controllerAgentId: string;
  targetEndpointId: string;
  agentId: string;
  surface: AgentEndpointSurface;
  hostId: string;
  workspaceId?: string;
  workspaceLabel?: string;
  sessionId?: string;
  title: string;
  status: DelegationTaskStatus;
  latestActivity?: OrchestrationActivity;
  latestSafeDetail?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  acceptedAt?: string;
  completedAt?: string;
}

export type AgentTaskEventLifecycle =
  | "accepted"
  | "planning"
  | "running"
  | "waiting-input"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTaskEventConfidence = "event" | "discovered" | "unknown";

export interface AgentTaskEvent {
  eventId: string;
  source: AgentEndpointSource;
  endpointId?: string;
  agentId: string;
  surface: AgentEndpointSurface;
  hostId: string;
  workspaceId?: string;
  workspaceLabel?: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  requestId?: string;
  lifecycle: AgentTaskEventLifecycle;
  activity?: OrchestrationActivity;
  safeDetail?: string;
  occurredAt: string;
  confidence: AgentTaskEventConfidence;
}

export interface NotificationRoute {
  routeId: string;
  enabled: boolean;
  target: {
    platform: TaskNotificationPlatform;
    accountId?: string;
    conversationId?: string;
  };
  sourceFilter: {
    agentIds?: string[];
    surfaces?: AgentEndpointSurface[];
    hostIds?: string[];
    workspaceIds?: string[];
    includeInternal?: boolean;
  };
  eventPolicy: {
    accepted: boolean;
    planning: boolean;
    progress: boolean;
    waitingInput: boolean;
    completed: boolean;
    failed: boolean;
    cancelled: boolean;
  };
  deliveryMode: "smart" | "each-task" | "completion-only" | "digest";
  quietHours?: { start: string; end: string };
  priority: number;
}

export type MemoryScope =
  | "global"
  | "user"
  | "pet"
  | "workspace"
  | "session"
  | `project:${string}`
  | `agent:${string}`
  | `project:${string}:agent:${string}`;
/** Stable long-term memory taxonomy. `kind` remains for compatibility with the first memory schema. */
export type MemoryEntryType =
  | "user_profile"
  | "preference"
  | "project"
  | "decision"
  | "skill"
  | "behavior"
  | "knowledge"
  | "temporary";
export type MemoryEntryKind = "preference" | "fact" | "rule" | "experience" | "project_fact" | "decision" | "agent_rule" | "workflow";
export type MemoryEntryOperation = "add" | "replace" | "remove";
export type MemoryEntryStatus = "pending" | "approved" | "rejected" | "archived";
export type MemoryReviewState = "none" | "review";
export type MemoryEntrySource = "explicit-user" | "learning-candidate" | "approved-learning" | "auto-extractor" | "agent" | "system";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryEntryKind;
  /** New taxonomy used by the automatic memory pipeline. */
  type?: MemoryEntryType;
  operation: MemoryEntryOperation;
  targetId?: string;
  content: string;
  source: MemoryEntrySource;
  status: MemoryEntryStatus;
  workspaceId?: string;
  taskId?: string;
  summary?: string;
  /** JSON encoded local lexical embedding; no external embedding service is used. */
  embedding?: string;
  importance?: number;
  confidence?: number;
  /** 0-100 MemoryRanker score. */
  rankScore?: number;
  reviewState?: MemoryReviewState;
  lastAccessedAt?: string;
  lastUsedAt?: string;
  accessCount?: number;
  createdAt: string;
  updatedAt: string;
}

export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_IDENTITY_FIELD_LENGTH = 128;
export const MAX_DISPLAY_TEXT_LENGTH = 120;
export const MAX_SAFE_DETAIL_LENGTH = 160;

function sanitizeIdentityText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeEventId(value: unknown, maxLength = MAX_EVENT_ID_LENGTH): string | null {
  if (typeof value !== "string") return null;
  return sanitizeIdentityText(value, maxLength) || null;
}

export function normalizeIdentityId(value: unknown, maxLength = MAX_IDENTITY_FIELD_LENGTH): string | null {
  if (typeof value !== "string") return null;
  return sanitizeIdentityText(value, maxLength) || null;
}

const ENDPOINT_KINDS = new Set<AgentEndpointKind>(["cli", "desktop", "vscode-extension", "gateway", "service"]);
const ENDPOINT_SURFACES = new Set<AgentEndpointSurface>(["internal", "desktop", "cli", "vscode", "gateway", "service"]);
const ENDPOINT_CAPABILITIES = new Set<AgentEndpointCapability>(["dispatch", "observe", "cancel", "pause", "resume", "input", "result"]);

function requiredIdentityField(record: Record<string, unknown>, field: string): string | null {
  return normalizeIdentityId(record[field]);
}

/** 解析 Companion Bridge 的注册/心跳/注销帧；未携带 type 的帧交给生命周期事件解析器。 */
export function normalizeAgentEndpointBridgeMessage(raw: unknown): AgentEndpointBridgeMessageNormalization {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { handled: false };
  const record = raw as Record<string, unknown>;
  if (record.type !== "register" && record.type !== "heartbeat" && record.type !== "unregister") {
    return { handled: false };
  }

  if (record.type === "heartbeat" || record.type === "unregister") {
    const endpointId = requiredIdentityField(record, "endpointId");
    if (!endpointId) return { handled: true, ok: false, error: "endpointId must not be empty" };
    const hostId = normalizeIdentityId(record.hostId) ?? undefined;
    if (record.type === "unregister") return { handled: true, ok: true, message: { type: "unregister", endpointId, hostId } };
    const rawOccurredAt = typeof record.occurredAt === "string" ? record.occurredAt : "";
    const occurredAt = Number.isNaN(Date.parse(rawOccurredAt)) ? new Date().toISOString() : new Date(rawOccurredAt).toISOString();
    return { handled: true, ok: true, message: { type: "heartbeat", endpointId, hostId, occurredAt } };
  }

  if (!record.endpoint || typeof record.endpoint !== "object" || Array.isArray(record.endpoint)) {
    return { handled: true, ok: false, error: "register frame requires an endpoint object" };
  }
  const endpoint = record.endpoint as Record<string, unknown>;
  const endpointId = requiredIdentityField(endpoint, "endpointId");
  const agentId = requiredIdentityField(endpoint, "agentId");
  const hostId = requiredIdentityField(endpoint, "hostId");
  const displayName = normalizeSafeText(endpoint.displayName, MAX_DISPLAY_TEXT_LENGTH);
  if (!endpointId || !agentId || !hostId || !displayName) {
    return { handled: true, ok: false, error: "register frame requires endpointId, agentId, hostId and displayName" };
  }
  if (typeof endpoint.kind !== "string" || !ENDPOINT_KINDS.has(endpoint.kind as AgentEndpointKind)) {
    return { handled: true, ok: false, error: "unsupported endpoint kind" };
  }
  if (typeof endpoint.surface !== "string" || !ENDPOINT_SURFACES.has(endpoint.surface as AgentEndpointSurface)) {
    return { handled: true, ok: false, error: "unsupported endpoint surface" };
  }
  if (!Array.isArray(endpoint.capabilities)) return { handled: true, ok: false, error: "endpoint capabilities must be an array" };
  const capabilities = endpoint.capabilities.filter((value): value is AgentEndpointCapability => typeof value === "string" && ENDPOINT_CAPABILITIES.has(value as AgentEndpointCapability));
  const workspaceId = normalizeIdentityId(endpoint.workspaceId) ?? undefined;
  const workspaceLabel = normalizeSafeText(endpoint.workspaceLabel, MAX_DISPLAY_TEXT_LENGTH) || undefined;
  return {
    handled: true,
    ok: true,
    message: {
      type: "register",
      endpoint: {
        endpointId,
        agentId,
        displayName,
        kind: endpoint.kind as AgentEndpointKind,
        surface: endpoint.surface as AgentEndpointSurface,
        hostId,
        workspaceId,
        workspaceLabel,
        capabilities: [...new Set(capabilities)],
      },
    },
  };
}

/** 自由文本只保留安全短摘要，任何凭据模式或本机路径都不会进入通用事件。 */
export function normalizeSafeText(value: unknown, maxLength = MAX_SAFE_DETAIL_LENGTH): string {
  if (typeof value !== "string") return "";
  const redacted = value
    .replace(/\b(bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>");
  return sanitizeIdentityText(redacted, maxLength);
}

export interface AgentTaskIdentity {
  agentId?: string;
  surface?: string;
  hostId?: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  turnId?: string;
  reference?: string;
}

/**
 * 任务身份固定包含 Agent、宿主界面、宿主实例、工作区和会话维度，最后才用
 * task/turn/event 引用补足。缺失字段保留为空槽位，避免不同工作区的同名 Agent
 * 被合并，也避免两个并发任务互相覆盖。
 */
export function agentTaskIdentityKey(identity: AgentTaskIdentity): string {
  const reference = identity.taskId ?? identity.turnId ?? identity.reference ?? "";
  return [
    identity.agentId ?? "",
    identity.surface ?? "",
    identity.hostId ?? "",
    identity.workspaceId ?? "",
    identity.sessionId ?? "",
    reference,
  ]
    .map((part) => encodeURIComponent(sanitizeIdentityText(part, MAX_IDENTITY_FIELD_LENGTH)))
    .join("|");
}
