import type { BotPlatform, BotChannelEvent } from "../channels/types";
import type { AgentProvider } from "../../settings/types";

export type PetPerceptionSource = "agent-runtime" | "agent-task" | "bot-channel" | "controller" | "agent-perception";

/** Agent 任务来自哪个宿主界面；process 只代表发现了进程，不代表任务正在运行。 */
export type AgentTaskSurface = "desktop" | "vscode" | "cli" | "gateway" | "service" | "internal";
export type AgentTaskState = "running" | "needs-input" | "ready" | "blocked" | "idle" | "unknown";
export type AgentTaskConfidence = "event" | "process" | "registry";
export type AgentTaskMatchState = "matched" | "unmatched" | "discovered";
export type AgentTaskSource = "app-event" | "codex-app-server" | "process" | "registry" | "codex-notify" | "claude-hook" | "manual-test" | "delegation" | "event-bridge" | "gateway";
/**
 * Agent 任务角色：描述观察对象在桌宠体系中的职责，而不是瞬时状态。
 * - controller：桌宠主 Agent（settings.activeAgentId 选中的本地控制器）的普通回复/规划活动；
 * - worker：外部工作 Agent 任务（delegation/event-bridge/codex-app-server/codex-notify/claude-hook/gateway）；
 * - discovered：进程探针/注册表条目，只证明宿主存在，不代表任务在运行；
 * - diagnostic：manual-test 等手动测试来源，只用于诊断/设置观察，不进入生产 Dock。
 */
export type AgentTaskRole = "controller" | "worker" | "discovered" | "diagnostic";
/** Agent 当前正在做什么；只保留阶段类别，不携带正文、命令参数或文件路径。 */
export type AgentTaskActivity =
  | "starting"
  | "thinking"
  | "tool"
  | "editing"
  | "command"
  | "network"
  | "waiting"
  | "response-ready";

export interface AgentTaskObservation {
  id: string;
  /** External lifecycle event identity, when the observation came from an event bridge. */
  eventId?: string;
  endpointId?: string;
  agentId: string;
  displayName: string;
  /** 任务角色。旧快照可能缺失，读取时用 resolveAgentTaskRole 按来源安全推导。 */
  role?: AgentTaskRole;
  surface: AgentTaskSurface;
  hostId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  sessionId?: string;
  requestId?: string;
  taskId?: string;
  state: AgentTaskState;
  confidence: AgentTaskConfidence;
  /** Stable endpoint correlation state. Process/registry observations are discovered, not active work. */
  matchState?: AgentTaskMatchState;
  source: AgentTaskSource;
  activity?: AgentTaskActivity;
  detail: string;
  taskTitle: string | null;
  startedAt: string | null;
  pid: number | null;
  observedAt: string;
}

export interface AgentTaskCompletion {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  endpointId?: string;
  agentId: string;
  displayName: string;
  /** 与产生该完成的观察同源；旧快照可能缺失，读取时按 source 推导。 */
  role?: AgentTaskRole;
  surface: AgentTaskSurface;
  hostId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  sessionId?: string;
  requestId?: string;
  source?: AgentTaskSource;
  /** 终态结果；interrupted 使用红色中断提示，但不归类为失败。 */
  terminalState?: "completed" | "failed" | "interrupted";
  success: boolean;
  detail: string;
  /** 任务开始时间，用于移动端完成通知显示耗时；旧快照可缺失。 */
  startedAt?: string | null;
  completedAt: string;
}

/** 事件桥/通知来源：detail 是宿主自述文本，不是可信完成事实，不能原样转发给完成通知。 */
const EXTERNAL_EVENT_BACKED_SOURCES: ReadonlySet<AgentTaskSource> = new Set([
  "codex-notify",
  "codex-app-server",
  "claude-hook",
  "event-bridge",
  "gateway",
  "manual-test",
]);

/** 外部任务异常终态的稳定结束语：不携带宿主自述文本，只引导用户到对应宿主界面查看。 */
export const EXTERNAL_TASK_ABNORMAL_END_WORDING = "目标 Agent 报告任务异常结束，请到对应宿主界面查看";

/**
 * 是否外部事件背书的完成：桥/通知来源的 detail 最多是脱敏后的宿主自述文本，
 * 不是完成事实；本地 app-event（controller）诊断与本地委派结果仍视为可信。
 * 旧快照可能缺失 source，按 role 保守兜底：worker 视为外部，宁可不转发。
 */
function isExternalEventBackedCompletion(completion: Pick<AgentTaskCompletion, "source" | "role">): boolean {
  if (completion.role === "controller") return false;
  if (completion.source) return EXTERNAL_EVENT_BACKED_SOURCES.has(completion.source);
  return completion.role === "worker";
}

/**
 * 完成通知展示文案。外部事件背书的完成：成功终态不再附加任何 detail，
 * 失败/取消/停止终态只使用稳定结束语并指向宿主界面；本地来源保持原逻辑，
 * 仅去掉与周围通知重复的通用终态文案。
 */
export function completionDetailForDisplay(completion: Pick<AgentTaskCompletion, "displayName" | "success" | "detail" | "source" | "role" | "terminalState">): string {
  if (isExternalEventBackedCompletion(completion)) {
    if (completion.terminalState === "interrupted") return "\u4efb\u52a1\u5df2\u4e2d\u65ad";
    return completion.success ? "" : EXTERNAL_TASK_ABNORMAL_END_WORDING;
  }
  const detail = completion.detail.replace(/\s+/g, " ").trim();
  if (!detail) return "";
  if (completion.success && (detail === "任务已完成" || detail === "已完成一个任务" || detail === `${completion.displayName} 任务已完成`)) return "";
  return detail;
}

/** 按来源稳定推导任务角色；构造方与旧快照读取方共用，避免两处规则漂移。 */
export function agentTaskRoleForSource(source: AgentTaskSource): AgentTaskRole {
  if (source === "app-event") return "controller";
  if (source === "manual-test") return "diagnostic";
  if (source === "process" || source === "registry") return "discovered";
  return "worker";
}

/** 读取任务角色：优先使用观察自带 role，缺失时按来源安全推导（兼容旧快照）。 */
export function resolveAgentTaskRole(task: Pick<AgentTaskObservation, "role" | "source">): AgentTaskRole {
  const role = task.role;
  if (role === "controller" || role === "worker" || role === "discovered" || role === "diagnostic") return role;
  return agentTaskRoleForSource(task.source);
}

export interface AgentTaskSnapshot {
  enabled: boolean;
  observedAt: string;
  tasks: AgentTaskObservation[];
  recentCompletions: AgentTaskCompletion[];
}

/**
 * 外部 Agent 事件桥来源：第三方宿主（Codex CLI notify、Codex app-server、
 * Claude Code hook）以及本地手动测试，经本机命名管道/Unix Socket 推入桌宠。
 * 该来源只传输经桥接器校验、归一化的生命周期事件，不携带聊天正文或凭据。
 */
export type AgentExternalEventSource = "codex-notify" | "codex-app-server" | "claude-hook" | "manual-test" | "delegation" | "event-bridge" | "gateway";

/** 外部事件声称的宿主界面；桥接器会在缺失时默认补为 cli。 */
export type AgentExternalSurface = "desktop" | "vscode" | "cli" | "gateway" | "service";

/** 外部任务生命周期状态，与内部 AgentTaskState 的映射见 AgentTaskObserver。 */
export type AgentExternalLifecycle = "accepted" | "starting" | "planning" | "progress" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "stopped" | "needs-input";

/**
 * 外部 Agent 生命周期事件（窄合同）。桥接器只保留下列字段：
 * eventId 必填且全局去重；sessionId/turnId/taskId 用于把同一任务的多次
 * 生命周期更新归并到同一条观察；detail/cwd/displayName 会被脱敏限长；
 * occurredAt 缺省时取桥接器接收时刻。绝不包含聊天正文、token、凭据或完整路径。
 */
export interface AgentExternalEvent {
  source: AgentExternalEventSource;
  surface: AgentExternalSurface;
  lifecycle: AgentExternalLifecycle;
  eventId: string;
  endpointId?: string;
  hostId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  requestId?: string;
  agentId: string;
  displayName?: string;
  activity?: AgentTaskActivity;
  detail?: string;
  cwd?: string;
  occurredAt?: string;
}

export type PetPerceptionPhase =
  | "offline"
  | "online"
  | "starting"
  | "working"
  | "waiting"
  | "received"
  | "success"
  | "error";

export interface PetPerceptionEvent {
  source: PetPerceptionSource;
  phase: PetPerceptionPhase;
  agentId?: string;
  platform?: BotPlatform;
  detail: string;
  occurredAt: string;
  transient: boolean;
}

export interface PetPerceptionAgentSummary {
  id: string;
  displayName: string;
  provider: AgentProvider;
  runtime: "offline" | "online" | "unknown";
  controller: "available" | "unavailable" | "unknown";
  observedAt: string | null;
}

export type PetPerceptionRunState = "idle" | "running" | "completed" | "partial" | "failed";
export type PetPerceptionParticipantState = "queued" | "running" | "success" | "error" | "skipped";

export interface PetPerceptionParticipant {
  agentId: string;
  displayName: string;
  state: PetPerceptionParticipantState;
  detail: string;
  resultPreview: string | null;
  updatedAt: string;
}

export interface PetPerceptionRun {
  id: string;
  signalPreview: string;
  state: PetPerceptionRunState;
  detail: string;
  startedAt: string;
  completedAt: string | null;
  participants: PetPerceptionParticipant[];
}

export type PetPerceptionChannelState = "online" | "offline" | "unknown";

/**
 * 单个通道的连接状态摘要，只含稳定标识与脱敏状态。
 * 不包含账号凭据、通道密钥、会话正文、命令或消息 ID。
 */
export interface PetPerceptionChannelSummary {
  channelId: string;
  platform: BotPlatform;
  state: PetPerceptionChannelState;
  observedAt: string | null;
}

/**
 * 多来源聚合摘要，供设置页展示“正在处理 N 个任务 · X/Y 个 Agent 可用 · A/B 个 Bot 在线”。
 * 全部字段均为脱敏计数或预构造文案，不包含正文/凭据/路径/命令/消息 ID。
 */
export interface PetPerceptionAggregateStatus {
  phase: PetPerceptionPhase;
  detail: string;
  configuredAgentCount: number;
  availableAgentCount: number;
  configuredChannelCount: number;
  connectedChannelCount: number;
  activeTaskCount: number;
  updatedAt: string;
}

export interface PetPerceptionSnapshot {
  enabled: boolean;
  primaryAgentId: string;
  primaryAgentPhase: PetPerceptionPhase;
  agents: PetPerceptionAgentSummary[];
  channels: PetPerceptionChannelSummary[];
  aggregate: PetPerceptionAggregateStatus;
  agentTasks: AgentTaskSnapshot;
  lastEvent: PetPerceptionEvent | null;
  lastRun: PetPerceptionRun | null;
}

export type PetPerceptionListener = (event: PetPerceptionEvent) => void;

/**
 * 快照订阅契约，与瞬时事件订阅（PetPerceptionListener）相互独立。
 *
 * 监听器只在快照发生实质变化时收到一份克隆快照：启用/停用开关、配置 Agent 增删改、
 * 运行时/控制器状态变化、任务数增减、通道在线/离线、以及非瞬时关键事件。
 * 不会按固定频率心跳推送，也不会退化成第二事件流——外部任务的安全活动阶段
 * （如 thinking→command→editing）会随真实事件进入任务快照，供设置页、桌宠
 * 状态提示和 QQ 查询共用；聊天正文、工具输出和瞬时消息内容仍不进入快照。
 * 订阅方应先通过 getStatus() 拉取当前值，再依赖本订阅接收后续变化。
 */
export type PetPerceptionSnapshotListener = (snapshot: PetPerceptionSnapshot) => void;

export type PetPerceptionChannelEvent = Extract<BotChannelEvent, {
  type: "status" | "message" | "agent-status" | "reply" | "error";
}>;
