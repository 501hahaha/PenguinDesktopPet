import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../../agents/types";
import type { PetSettings } from "../../settings/types";
import type { AgentStatus } from "../wechat/events";
import type {
  AgentDispatchRequest,
  AgentTaskMessageRequest,
  AgentEndpoint,
  AgentEndpointCapability,
  AgentEndpointSurface,
  AgentTaskIdentity,
  DelegationTask,
  OrchestrationActivity,
} from "./orchestrationTypes";
import { agentTaskIdentityKey, normalizeSafeText } from "./orchestrationTypes";
import { EXTERNAL_TASK_ABNORMAL_END_WORDING } from "../pet/perceptionTypes";
import type { AgentExternalEvent } from "../pet/perceptionTypes";

const TASK_RETENTION_MS = 15 * 60 * 1000;
const MAX_FOLLOW_UP_MESSAGE_LENGTH = 4_000;

interface DelegationIntent {
  targetQuery: string;
  instruction: string;
}

export interface AgentDelegationPreview {
  intent: DelegationIntent;
  endpoint: AgentEndpoint | null;
  config?: AgentConfig;
  ambiguous: AgentEndpoint[];
  detail?: string;
}

export interface AgentDelegationCompletion {
  task: DelegationTask;
  ok: boolean;
  detail: string;
  result?: string;
}

export interface AgentDelegationFollowUpResult {
  handled: boolean;
  ok: boolean;
  detail: string;
  task?: DelegationTask;
}

export interface AgentDelegationRuntime {
  getSettings: () => PetSettings;
  getEndpoints: () => AgentEndpoint[];
  dispatch: (endpointId: string, request: AgentDispatchRequest) => { ok: boolean; detail: string };
  send: (endpointId: string, request: AgentTaskMessageRequest) => { ok: boolean; detail: string };
  generateLocal: (
    config: AgentConfig,
    instruction: string,
    onProgress: (status: AgentStatus, detail: string) => void,
    conversationId: string,
  ) => Promise<string>;
  emitEvent: (event: AgentExternalEvent) => void;
  onCompletion: (completion: AgentDelegationCompletion) => Promise<void> | void;
}

export function stripControllerRoutingPrefix(message: string): string {
  const stripped = message.replace(/^\/(?:pet\b|主控(?=\s|$))\s*/iu, "").trim();
  return stripped || message.trim();
}

interface ActiveDelegation {
  task: DelegationTask;
  completed: boolean;
  onCompletion?: (completion: AgentDelegationCompletion) => Promise<void> | void;
}

function surfaceForConfig(config: AgentConfig): AgentEndpointSurface {
  if (config.sourceApp === "claude-desktop") return "desktop";
  if (config.sourceApp === "openclaw" || /(?:^|[\\/])openclaw(?:\.cmd|\.exe)?$/i.test(config.command.trim())) return "gateway";
  if (config.sourceApp === "codex" || config.sourceApp === "claude-code" || config.sourceApp === "hermes" || config.provider) return "cli";
  return "internal";
}

function endpointForConfig(config: AgentConfig): AgentEndpoint {
  return {
    endpointId: `local:${config.id}`,
    agentId: config.id,
    displayName: config.displayName,
    kind: surfaceForConfig(config) === "gateway" ? "gateway" : "cli",
    surface: surfaceForConfig(config),
    hostId: "local-machine",
    workspaceId: config.workingDirectory.trim() ? `workspace:${config.id}` : undefined,
    workspaceLabel: config.workingDirectory.trim() ? config.displayName : undefined,
    connection: config.enabled ? "connected" : "offline",
    capabilities: ["dispatch", "observe", "result"],
    source: "registry",
    lastSeenAt: new Date().toISOString(),
  };
}

function endpointCanDispatch(endpoint: AgentEndpoint): boolean {
  return endpoint.capabilities.includes("dispatch" as AgentEndpointCapability)
    && endpoint.connection !== "offline";
}

function eventMatchesTask(event: AgentExternalEvent, task: DelegationTask): boolean {
  const endpointMatches = event.endpointId === task.targetEndpointId;
  if (event.endpointId && !endpointMatches) return false;
  if (event.agentId && event.agentId !== task.agentId) return false;
  // A registered endpoint is the stronger identity. Some legacy adapters omit
  // surface and are normalized to cli, so do not reject a correctly bound
  // endpoint solely because its compatibility surface is different.
  if (!endpointMatches && event.surface && event.surface !== task.surface) return false;
  if (event.hostId && event.hostId !== task.hostId) return false;
  if (event.workspaceId && task.workspaceId && event.workspaceId !== task.workspaceId) return false;
  return event.taskId === task.taskId || event.requestId === task.requestId;
}

function parseIntent(text: string): DelegationIntent | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const quoted = normalized.match(/^(?:\/delegate|\/委派|\/委托|委派给|委托给|派给)\s+["“「]([^"”」]+)["”」]\s*(?::|：)?\s*([\s\S]+)$/i);
  if (quoted) return { targetQuery: quoted[1].trim(), instruction: quoted[2].trim() };

  const simple = normalized.match(/^(?:\/delegate|\/委派|\/委托|委派给|委托给|派给)\s+([^\s:：,，]+)\s*(?::|：|,|，)?\s*([\s\S]+)$/i);
  if (simple) return { targetQuery: simple[1].trim(), instruction: simple[2].trim() };

  const mention = normalized.match(/^@([^\s:：,，]+)\s*(?::|：|,|，)?\s*([\s\S]+)$/i);
  if (mention) return { targetQuery: mention[1].trim(), instruction: mention[2].trim() };
  return null;
}

interface FollowUpIntent {
  explicit: boolean;
  targetQuery?: string;
  message: string;
}

function parseFollowUpIntent(text: string): FollowUpIntent | null {
  const normalized = text.trim();
  if (!normalized || /^(?:\/delegate|\/delegat|\/委派|委派给|@)/iu.test(normalized)) return null;
  if (/^\/(?:pet\b|主控(?=\s|$))/iu.test(normalized)) return null;

  const explicitStable = normalized.match(/^\/(?:followup|follow-up|continue|继续|跟进)\b\s+((?:delegation|workspace|request):[^\s:：]+)\s*[:：]\s*([\s\S]+)$/iu);
  if (explicitStable) {
    return { explicit: true, targetQuery: explicitStable[1].trim(), message: explicitStable[2].trim() };
  }
  const explicit = normalized.match(/^\/(?:followup|follow-up|continue|继续|跟进)\b(?:\s+([^:：]+?))?\s*[:：]\s*([\s\S]+)$/iu);
  if (explicit) {
    return {
      explicit: true,
      targetQuery: explicit[1]?.trim() || undefined,
      message: explicit[2].trim(),
    };
  }
  if (/^\/(?:followup|follow-up|continue|继续|跟进)\b/iu.test(normalized)) {
    const message = normalized.replace(/^\/(?:followup|follow-up|continue|继续|跟进)\b\s*/iu, "").trim();
    return message ? { explicit: true, message } : null;
  }
  return { explicit: false, message: normalized };
}

function boundedFollowUpMessage(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_FOLLOW_UP_MESSAGE_LENGTH);
}

function agentDisplayName(agentId: string, surface: AgentEndpointSurface): string {
  if (agentId === "codex" && surface === "desktop") return "Codex Desktop";
  if (agentId === "codex" && surface === "cli") return "Codex CLI";
  return agentId;
}

function surfaceLabel(endpoint: Pick<AgentEndpoint, "agentId" | "surface">): string {
  if (endpoint.agentId === "codex" && endpoint.surface === "desktop") return "Codex Desktop";
  if (endpoint.agentId === "codex" && endpoint.surface === "cli") return "Codex CLI";
  if (endpoint.surface === "vscode") return "VS Code";
  if (endpoint.surface === "desktop") return "桌面版";
  if (endpoint.surface === "cli") return "CLI";
  if (endpoint.surface === "gateway") return "Gateway";
  if (endpoint.surface === "service") return "服务";
  return "内部";
}

function endpointMatches(endpoint: AgentEndpoint, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const fields = [endpoint.endpointId, endpoint.agentId, endpoint.displayName, endpoint.hostId, endpoint.workspaceId, endpoint.workspaceLabel]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLocaleLowerCase());
  if (fields.includes(normalizedQuery)) return 100;
  if (fields.some((value) => value.includes(normalizedQuery))) return 60;
  return 0;
}

function safeTaskTitle(instruction: string): string {
  return normalizeSafeText(instruction, 80) || "未命名委派任务";
}

function taskIdentity(task: DelegationTask): AgentTaskIdentity {
  return {
    agentId: task.agentId,
    surface: task.surface,
    hostId: task.hostId,
    workspaceId: task.workspaceId,
    reference: task.taskId,
    taskId: task.taskId,
  };
}

function lifecycleForProgress(status: AgentStatus): { lifecycle: AgentExternalEvent["lifecycle"]; activity?: OrchestrationActivity } {
  if (status === "waiting") return { lifecycle: "waiting", activity: "waiting" };
  if (status === "starting") return { lifecycle: "planning", activity: "starting" };
  if (status === "thinking") return { lifecycle: "progress", activity: "thinking" };
  if (status === "tool") return { lifecycle: "progress", activity: "tool" };
  if (status === "command") return { lifecycle: "progress", activity: "command" };
  if (status === "network") return { lifecycle: "progress", activity: "network" };
  if (status === "response-ready" || status === "sending") return { lifecycle: "progress", activity: "response-ready" };
  return { lifecycle: "progress" };
}

/** 解析并执行“机器人 -> 指定 Worker Agent”的第一条真实委派闭环。 */
export class AgentDelegationService {
  private readonly activeTasks = new Map<string, ActiveDelegation>();

  constructor(private readonly runtime: AgentDelegationRuntime) {}

  listIfRequested(message: string): string | null {
    if (!/^(?:\/agents?|在线\s*agent(?:s)?|查看在线工作区|查看在线 Agent)\s*[!?。！。]*$/iu.test(message.trim())) return null;
    const endpoints = this.onlineExternalEndpoints();
    if (endpoints.length === 0) {
      return "当前没有可委派的在线工作区 Agent。请先打开桌面版或 VS Code Agent，并确认它已连接 Companion Bridge。";
    }
    const rows = endpoints.map((endpoint, index) => {
      const workspace = endpoint.workspaceLabel || endpoint.workspaceId || endpoint.hostId;
      const inputState = endpoint.capabilities.includes("input") ? "可继续" : "仅可委派";
      return `${index + 1}. ${normalizeSafeText(endpoint.displayName, 48)} · 工作区 ${normalizeSafeText(workspace, 64)} · ${surfaceLabel(endpoint)} · ${inputState}`;
    });
    return [
      "当前在线工作区 Agent：",
      ...rows,
      "委派格式：/delegate <工作区或 Agent 名>: <任务>",
      "后续补充：直接发送消息，或使用 /继续 <工作区>: <补充信息>",
    ].join("\n");
  }

  followUp(parentConversationId: string, message: string): AgentDelegationFollowUpResult {
    const intent = parseFollowUpIntent(message);
    if (!intent || !intent.message) return { handled: false, ok: false, detail: "" };

    const candidates = [...this.activeTasks.values()]
      .filter(({ task }) => task.parentConversationId === parentConversationId)
      .filter(({ task }) => task.surface !== "internal" && !task.targetEndpointId.startsWith("local:"));
    if (candidates.length === 0 && !intent.explicit) return { handled: false, ok: false, detail: "" };
    if (candidates.length === 0) return { handled: true, ok: false, detail: "当前会话没有可继续的外部 Agent 任务，请先使用 /delegate 指定在线工作区。" };

    let matches = candidates;
    if (intent.targetQuery) {
      matches = candidates.filter(({ task }) => {
        const endpoint = this.runtime.getEndpoints().find((item) => item.endpointId === task.targetEndpointId);
        return endpoint
          ? endpointMatches(endpoint, intent.targetQuery!) > 0 || task.taskId.toLocaleLowerCase() === intent.targetQuery!.toLocaleLowerCase()
          : task.taskId.toLocaleLowerCase() === intent.targetQuery!.toLocaleLowerCase();
      });
      if (matches.length === 0) return { handled: true, ok: false, detail: `没有找到与“${normalizeSafeText(intent.targetQuery, 50)}”匹配的已委派任务。` };
    }
    if (matches.length > 1) {
      const labels = matches.slice(0, 5).map(({ task }) => `${task.workspaceLabel || task.agentId}（${task.taskId}）`);
      return { handled: true, ok: false, detail: `当前会话有多个委派任务，请使用 /继续 <工作区或任务号>: <补充信息>。可选：${labels.join("、")}` };
    }

    const active = matches[0];
    const task = active.task;
    const endpoint = this.runtime.getEndpoints().find((item) => item.endpointId === task.targetEndpointId);
    if (!endpoint || endpoint.connection === "offline" || endpoint.connection === "unknown") {
      return { handled: true, ok: false, detail: `${task.workspaceLabel || task.agentId} 当前不在线，补充信息没有发送。` };
    }
    if (!endpoint.capabilities.includes("input")) {
      return { handled: true, ok: false, detail: `${endpoint.displayName} 当前只上报任务状态，未声明 input 能力，暂不能继续发送消息。` };
    }
    const nextMessage = boundedFollowUpMessage(intent.message);
    if (!nextMessage) return { handled: true, ok: false, detail: "补充信息为空，没有发送。" };

    const previous = {
      requestId: task.requestId,
      status: task.status,
      acceptedAt: task.acceptedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      latestActivity: task.latestActivity,
      latestSafeDetail: task.latestSafeDetail,
      completed: active.completed,
    };
    const requestId = `request:${randomUUID()}`;
    task.requestId = requestId;
    task.status = "queued";
    task.acceptedAt = undefined;
    task.completedAt = undefined;
    task.updatedAt = new Date().toISOString();
    task.latestActivity = "starting";
    task.latestSafeDetail = "补充信息已发送，等待目标 Agent 处理";
    active.completed = false;

    const sent = this.runtime.send(endpoint.endpointId, {
      type: "message",
      requestId,
      taskId: task.taskId,
      message: nextMessage,
      sessionId: task.sessionId,
      workspaceId: task.workspaceId,
    });
    if (!sent.ok) {
      task.requestId = previous.requestId;
      task.status = previous.status;
      task.acceptedAt = previous.acceptedAt;
      task.completedAt = previous.completedAt;
      task.updatedAt = previous.updatedAt;
      task.latestActivity = previous.latestActivity;
      task.latestSafeDetail = previous.latestSafeDetail;
      active.completed = previous.completed;
      return { handled: true, ok: false, detail: sent.detail };
    }

    task.status = "accepted";
    task.acceptedAt = task.updatedAt;
    task.latestSafeDetail = sent.detail;
    this.emit(task, "accepted", sent.detail, "starting");
    return { handled: true, ok: true, detail: `已把补充信息发送给 ${endpoint.displayName}，继续沿用任务 ${task.taskId}。`, task: structuredClone(task) };
  }

  private onlineExternalEndpoints(): AgentEndpoint[] {
    const unique = new Map<string, AgentEndpoint>();
    for (const endpoint of this.runtime.getEndpoints()) {
      if (endpoint.surface === "internal" || endpoint.connection === "offline" || endpoint.connection === "unknown") continue;
      if (!endpointCanDispatch(endpoint)) continue;
      unique.set(endpoint.endpointId, endpoint);
    }
    return [...unique.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  preview(message: string): AgentDelegationPreview | null {
    const intent = parseIntent(message);
    if (!intent || !intent.instruction) return null;
    const settings = this.runtime.getSettings();
    const endpoints = [
      ...this.onlineExternalEndpoints(),
      ...settings.agentConfigs.filter((config) => config.enabled).map(endpointForConfig),
    ];
    const unique = new Map<string, AgentEndpoint>();
    for (const endpoint of endpoints) unique.set(endpoint.endpointId, endpoint);
    const ranked = [...unique.values()]
      .map((endpoint) => ({ endpoint, score: endpointMatches(endpoint, intent.targetQuery) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score
        || Number(endpointCanDispatch(right.endpoint)) - Number(endpointCanDispatch(left.endpoint))
        || left.endpoint.displayName.localeCompare(right.endpoint.displayName));
    if (ranked.length === 0) {
      return { intent, endpoint: null, ambiguous: [], detail: `没有找到名为“${normalizeSafeText(intent.targetQuery, 50)}”的可用 Agent 宿主` };
    }
    const topScore = ranked[0].score;
    const top = ranked.filter((item) => item.score === topScore).map((item) => item.endpoint);
    const endpoint = top.length === 1 ? top[0] : null;
    const config = endpoint?.endpointId.startsWith("local:")
      ? settings.agentConfigs.find((item) => `local:${item.id}` === endpoint.endpointId)
      : undefined;
    return {
      intent,
      endpoint,
      config,
      ambiguous: endpoint ? [] : top,
      detail: endpoint ? undefined : "目标 Agent 名称匹配到多个宿主，请补充工作区或宿主名称",
    };
  }

  start(
    preview: AgentDelegationPreview,
    parentConversationId: string,
    onCompletion?: (completion: AgentDelegationCompletion) => Promise<void> | void,
  ): { ok: boolean; detail: string; task?: DelegationTask } {
    if (!preview.endpoint) return { ok: false, detail: preview.detail ?? "委派目标不明确" };
    const endpoint = preview.endpoint;
    const task: DelegationTask = {
      taskId: `delegation:${randomUUID()}`,
      requestId: `request:${randomUUID()}`,
      parentConversationId,
      controllerAgentId: this.runtime.getSettings().activeAgentId,
      targetEndpointId: endpoint.endpointId,
      agentId: endpoint.agentId,
      surface: endpoint.surface,
      hostId: endpoint.hostId,
      workspaceId: endpoint.workspaceId,
      workspaceLabel: endpoint.workspaceLabel,
      title: safeTaskTitle(preview.intent.instruction),
      status: "queued",
      latestSafeDetail: "委派请求已创建，等待目标宿主处理",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config = preview.config;
    if (config) {
      task.status = "accepted";
      task.acceptedAt = new Date().toISOString();
      this.activeTasks.set(task.taskId, { task, completed: false, onCompletion });
      this.emit(task, "accepted", "目标本机 Agent 已接收委派请求");
      void this.runLocal(task, config, preview.intent.instruction);
      return { ok: true, detail: `已委派给 ${endpoint.displayName}，任务号 ${task.taskId}`, task: structuredClone(task) };
    }

    if (!endpointCanDispatch(endpoint)) {
      return { ok: false, detail: `${endpoint.displayName} 当前只可观察，尚不支持委派` };
    }
    const active: ActiveDelegation = { task, completed: false, onCompletion };
    // Register before writing to the bridge. A local Companion may answer
    // synchronously, and that terminal event must not be dropped.
    this.activeTasks.set(task.taskId, active);
    const dispatch = this.runtime.dispatch(endpoint.endpointId, {
      type: "dispatch",
      requestId: task.requestId,
      taskId: task.taskId,
      title: task.title,
      instruction: preview.intent.instruction,
      workspaceId: task.workspaceId,
    });
    if (!dispatch.ok) {
      if (this.activeTasks.get(task.taskId) === active) this.activeTasks.delete(task.taskId);
      return { ok: false, detail: dispatch.detail };
    }
    if (active.completed) return { ok: true, detail: dispatch.detail, task: structuredClone(task) };
    task.status = "accepted";
    task.acceptedAt = new Date().toISOString();
    task.latestSafeDetail = dispatch.detail;
    this.emit(task, "accepted", dispatch.detail);
    return { ok: true, detail: `已发送给 ${endpoint.displayName}，任务号 ${task.taskId}；等待目标宿主确认`, task: structuredClone(task) };
  }

  handleExternalEvent(event: AgentExternalEvent): void {
    if (!event.requestId && !event.taskId) return;
    const active = [...this.activeTasks.values()].find(({ task }) => eventMatchesTask(event, task));
    if (!active || active.completed) return;
    const receivedAt = new Date().toISOString();
    active.task.updatedAt = event.occurredAt ?? receivedAt;
    if (event.sessionId) active.task.sessionId = event.sessionId;
    active.task.latestSafeDetail = normalizeSafeText(event.detail, 160) || active.task.latestSafeDetail;
    if (event.lifecycle === "completed" || event.lifecycle === "failed" || event.lifecycle === "cancelled" || event.lifecycle === "stopped") {
      active.completed = true;
      active.task.status = event.lifecycle === "completed" ? "completed" : event.lifecycle === "cancelled" ? "cancelled" : "failed";
      active.task.completedAt = receivedAt;
      active.task.updatedAt = receivedAt;
      // 外部宿主终态事件：event.detail 是宿主自述文本，不是可信完成事实，
      // 不能作为结果转发给机器人通道。只下发稳定结束语，成功态由接收方回退文案兜底。
      const terminalDetail = event.lifecycle === "completed"
        ? "目标 Agent 已返回结果，请查看任务面板"
        : EXTERNAL_TASK_ABNORMAL_END_WORDING;
      void (active.onCompletion ?? this.runtime.onCompletion)({
        task: structuredClone(active.task),
        ok: event.lifecycle === "completed",
        detail: terminalDetail,
      });
    }
  }

  private async runLocal(task: DelegationTask, config: AgentConfig, instruction: string): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    this.emit(task, "running", "本机 Worker Agent 正在执行委派");
    try {
      const result = await this.runtime.generateLocal(config, instruction, (status, detail) => {
        const progress = lifecycleForProgress(status);
        task.updatedAt = new Date().toISOString();
        task.latestActivity = progress.activity;
        task.latestSafeDetail = normalizeSafeText(detail, 160) || task.latestSafeDetail;
        task.status = progress.lifecycle === "waiting" ? "waiting-input" : "running";
        this.emit(task, progress.lifecycle, task.latestSafeDetail ?? "目标 Agent 进度已更新", progress.activity);
      }, task.requestId);
      const active = this.activeTasks.get(task.taskId);
      if (!active || active.completed) return;
      active.completed = true;
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      task.latestActivity = "response-ready";
      task.latestSafeDetail = "目标 Agent 已返回结果";
      this.emit(task, "completed", task.latestSafeDetail, "response-ready");
      await (active.onCompletion ?? this.runtime.onCompletion)({ task: structuredClone(task), ok: true, detail: task.latestSafeDetail, result });
    } catch (error) {
      const active = this.activeTasks.get(task.taskId);
      if (!active || active.completed) return;
      active.completed = true;
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      task.latestSafeDetail = normalizeSafeText(error instanceof Error ? error.message : String(error), 160) || "目标 Agent 执行失败";
      this.emit(task, "failed", task.latestSafeDetail);
      await (active.onCompletion ?? this.runtime.onCompletion)({ task: structuredClone(task), ok: false, detail: task.latestSafeDetail });
    } finally {
      setTimeout(() => this.activeTasks.delete(task.taskId), TASK_RETENTION_MS);
    }
  }

  private emit(task: DelegationTask, lifecycle: AgentExternalEvent["lifecycle"], detail: string, activity?: OrchestrationActivity): void {
    this.runtime.emitEvent({
      source: "delegation",
      endpointId: task.targetEndpointId,
      surface: task.surface === "internal" ? "cli" : task.surface,
      lifecycle,
      eventId: `delegation-event:${randomUUID()}`,
      sessionId: task.sessionId ?? task.requestId,
      taskId: task.taskId,
      requestId: task.requestId,
      agentId: task.agentId,
      displayName: task.workspaceLabel ? `${agentDisplayName(task.agentId, task.surface)} · ${task.workspaceLabel}` : agentDisplayName(task.agentId, task.surface),
      activity,
      detail: normalizeSafeText(detail, 160),
      occurredAt: new Date().toISOString(),
    });
  }
}

export function taskIdentityForDelegation(task: DelegationTask): string {
  return agentTaskIdentityKey(taskIdentity(task));
}
