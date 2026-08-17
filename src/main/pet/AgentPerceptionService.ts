import type { BotPlatform, ChannelAgentStatus, ChannelStatus } from "../channels/types";
import type { AgentControllerStatus, AgentConfig } from "../../agents/types";
import { probeAgentRuntime } from "../agents/processProbe";
import type { PetSettings } from "../../settings/types";
import type { WeChatEvent } from "../wechat/events";
import type {
  PetPerceptionAgentSummary,
  PetPerceptionAggregateStatus,
  PetPerceptionChannelEvent,
  PetPerceptionChannelSummary,
  PetPerceptionEvent,
  PetPerceptionListener,
  PetPerceptionParticipant,
  PetPerceptionPhase,
  PetPerceptionRun,
  PetPerceptionSnapshot,
  PetPerceptionSnapshotListener,
  AgentTaskSnapshot,
} from "./perceptionTypes";

const RUNTIME_POLL_INTERVAL_MS = 5_000;
const FAILURE_BACKOFF_MS = 20_000;
/** 聚合 phase 在任务结束后短暂保持任务结果（success/error）的窗口，之后回退到运行时语义。 */
const TASK_PHASE_HOLD_MS = 60_000;
/** 微信通道的稳定 channelId（与 WeChatChannelAdapter 保持一致）。 */
const WECHAT_CHANNEL_ID = "wechat:active";
/** 微信事件不携带会话/消息标识，任务计数使用单个稳定回退键，绝不对 renderer 暴露。 */
const WECHAT_TASK_FALLBACK_KEY = "wechat:active:fallback";
const MAX_PERCEPTION_SIGNAL_LENGTH = 320;

interface AgentPerceptionServiceOptions {
  getSettings: () => PetSettings;
  getControllerStatus: () => Promise<AgentControllerStatus>;
  runAgentPerception: (config: AgentConfig, signal: string) => Promise<string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyAgentTaskSnapshot(): AgentTaskSnapshot {
  return { enabled: false, observedAt: "", tasks: [], recentCompletions: [] };
}

function safeDetail(detail: string): string {
  return detail
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>")
    .replace(/\b(?:bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/\r?\n+/g, " ")
    .trim()
    .slice(0, 96);
}

function phaseForRuntime(runtime: PetPerceptionAgentSummary["runtime"]): PetPerceptionPhase {
  return runtime === "online" ? "online" : runtime === "offline" ? "offline" : "waiting";
}

function channelLabel(platform: PetPerceptionEvent["platform"]): string {
  return platform === "wechat" ? "微信" : platform === "qq" ? "QQ" : platform === "feishu" ? "飞书" : "钉钉";
}

function mapAgentStatus(status: Extract<PetPerceptionChannelEvent, { type: "agent-status" }>["status"]): PetPerceptionPhase {
  if (status === "starting") return "starting";
  if (status === "waiting") return "waiting";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "working";
}

export class AgentPerceptionService {
  private settings: PetSettings;
  private running = false;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<PetPerceptionListener>();
  private snapshotListeners = new Set<PetPerceptionSnapshotListener>();
  private snapshot: PetPerceptionSnapshot;
  /** 活跃任务内部键（platform + channelId + conversationId + 可选 messageId），仅用于计数，绝不暴露。 */
  private readonly activeTasks = new Set<string>();
  /** 各通道最近一次连接状态，channelId 为稳定标识。 */
  private readonly channelStates = new Map<string, PetPerceptionChannelSummary>();
  /** 最近一次任务结果（success/error），用于聚合 phase 的短暂保持；随停用感知一并清除。 */
  private taskResult: { phase: "success" | "error"; occurredAt: string } | null = null;
  private perceptionRunPromise: Promise<PetPerceptionRun> | null = null;

  constructor(private readonly options: AgentPerceptionServiceOptions) {
    this.settings = options.getSettings();
    this.snapshot = this.buildInitialSnapshot(this.settings);
  }

  getSnapshot(): PetPerceptionSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: PetPerceptionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 订阅快照变化；每次收到的是实质变化后的克隆快照，与瞬时事件订阅相互独立。 */
  subscribeSnapshot(listener: PetPerceptionSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  setSettings(settings: PetSettings): void {
    const wasEnabled = this.settings.petPerception.enabled;
    this.settings = settings;
    if (!settings.petPerception.enabled) this.clearTransientState();
    this.commitSnapshot(this.withAgentConfiguration(this.snapshot, settings));
    if (!settings.petPerception.enabled) {
      this.stopPolling();
      return;
    }
    if (this.running && !wasEnabled) this.schedulePoll(0);
  }

  start(): void {
    this.running = true;
    if (this.settings.petPerception.enabled) this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    this.stopPolling();
    this.listeners.clear();
    this.snapshotListeners.clear();
  }

  /** 将独立任务观察器的结果并入总快照，供桌宠与设置页共享同一份状态。 */
  setAgentTaskSnapshot(agentTasks: AgentTaskSnapshot): void {
    if (JSON.stringify(this.snapshot.agentTasks) === JSON.stringify(agentTasks)) return;
    const next = {
      ...this.snapshot,
      agentTasks: structuredClone(agentTasks),
      aggregate: this.computeAggregate(this.snapshot.agents, this.snapshot.primaryAgentId, agentTasks),
    };
    this.commitSnapshot(next);
  }

  /** 显式发起一次感知：所有已加入且启用的 Agent 并行参与，结果只保留脱敏短摘要。 */
  async trigger(rawSignal: string): Promise<PetPerceptionRun> {
    if (this.perceptionRunPromise) return this.perceptionRunPromise;
    const promise = this.runPerception(rawSignal);
    this.perceptionRunPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.perceptionRunPromise === promise) this.perceptionRunPromise = null;
    }
  }

  handleChannelEvent(event: PetPerceptionChannelEvent): void {
    const settings = this.settings.petPerception;
    if (!settings.enabled) return;
    if (event.type === "agent-status") {
      // 任务计数属于聚合摘要，与任务事件反馈开关相互独立，保证“正在处理 N 个任务”始终可信。
      this.updateTaskState(this.channelTaskKey(event), event.status);
      if (!settings.taskActivity) return;
      this.publishEvent({
        source: "agent-task",
        phase: mapAgentStatus(event.status),
        platform: event.platform,
        detail: "Agent 任务状态已更新",
        transient: true,
      });
      return;
    }
    if (event.type === "status") {
      // 通道连接状态属于聚合摘要，独立于 botActivity 反馈开关保留，保证“A/B 个 Bot 在线”始终可信。
      this.retainChannelState(event.status);
      if (!settings.botActivity) return;
      this.publishEvent({
        source: "bot-channel",
        phase: event.status.connected ? "online" : "offline",
        platform: event.status.platform,
        detail: `${channelLabel(event.status.platform)}通道${event.status.connected ? "在线" : "离线"}`,
        transient: false,
      });
      return;
    }
    if (!settings.botActivity) return;
    // WeChat error events are also delivered directly by WeChatBridge, where
    // their target/delivery/connection category is preserved. Avoid publishing
    // the same categorized failure a second time through the generic adapter.
    if (event.type === "error" && event.platform === "wechat" && event.category) return;
    if (event.type === "message") {
      this.publishEvent({
        source: "bot-channel",
        phase: "received",
        platform: event.message.platform,
        detail: `${channelLabel(event.message.platform)}收到消息`,
        transient: true,
      });
      return;
    }
    if (event.type === "reply") {
      this.publishEvent({
        source: "bot-channel",
        phase: event.delivered ? "success" : "error",
        platform: event.platform,
        detail: event.delivered ? `${channelLabel(event.platform)}回复已发送` : `${channelLabel(event.platform)}回复发送失败`,
        transient: true,
      });
      return;
    }
    if (event.type === "error" && event.platform === "wechat" && event.category) {
      if (event.category === "target") {
        this.publishEvent({ source: "bot-channel", phase: "waiting", platform: "wechat", detail: "微信等待会话目标", transient: true });
        return;
      }
      if (event.category === "delivery") {
        this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信消息发送失败", transient: true });
        return;
      }
      if (event.category === "agent") {
        this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信 Agent 处理失败", transient: true });
        return;
      }
      this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信通道连接异常", transient: true });
      return;
    }
    this.publishEvent({
      source: "bot-channel",
      phase: "error",
      platform: event.platform,
      detail: `${channelLabel(event.platform)}通道出现异常`,
      transient: true,
    });
  }

  handleWeChatEvent(event: WeChatEvent): void {
    if (!this.settings.petPerception.enabled) return;
    if (event.type === "connection") {
      this.handleChannelEvent({
        type: "status",
        status: {
          channelId: WECHAT_CHANNEL_ID,
          platform: "wechat",
          accountId: event.accountId,
          state: event.state,
          connected: event.connected,
          detail: "",
          lastError: "",
          retryCount: 0,
          nextRetryAt: null,
        },
      });
      return;
    }
    if (event.type === "message") {
      this.handleChannelEvent({
        type: "message",
        message: {
          id: event.id,
          channelId: WECHAT_CHANNEL_ID,
          platform: "wechat",
          conversationId: "",
          senderId: "",
          conversationType: "direct",
          text: "",
          timestamp: Date.now(),
        },
      });
      return;
    }
    if (event.type === "thinking") {
      this.updateTaskState(WECHAT_TASK_FALLBACK_KEY, "thinking");
      if (!this.settings.petPerception.taskActivity) return;
      this.publishEvent({ source: "agent-task", phase: "working", detail: "Agent 正在处理", transient: true });
      return;
    }
    if (event.type === "agent-status") {
      this.updateTaskState(WECHAT_TASK_FALLBACK_KEY, event.status);
      if (!this.settings.petPerception.taskActivity) return;
      this.publishEvent({ source: "agent-task", phase: mapAgentStatus(event.status), detail: "Agent 任务状态已更新", transient: true });
      return;
    }
    if (event.type === "reply") {
      if (!this.settings.petPerception.botActivity) return;
      this.publishEvent({ source: "bot-channel", phase: "success", platform: "wechat", detail: "微信回复已发送", transient: true });
      return;
    }
    if (event.type === "error") {
      if (!this.settings.petPerception.botActivity) return;
      if (event.category === "target") {
        this.publishEvent({ source: "bot-channel", phase: "waiting", platform: "wechat", detail: "微信等待会话目标", transient: true });
        return;
      }
      if (event.category === "delivery") {
        this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信消息发送失败", transient: true });
        return;
      }
      if (event.category === "agent") {
        this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信 Agent 处理失败", transient: true });
        return;
      }
      if (event.category === "connection") {
        const waiting = /尚未连接|等待可用会话|正在等待/.test(event.message);
        this.publishEvent({
          source: "bot-channel",
          phase: waiting ? "waiting" : "error",
          platform: "wechat",
          detail: waiting ? "微信等待通道连接" : "微信通道出现异常",
          transient: true,
        });
        return;
      }
      this.publishEvent({ source: "bot-channel", phase: "error", platform: "wechat", detail: "微信通道出现异常", transient: true });
    }
  }

  /** 快照只覆盖用户可见且已启用的配置 Agent；禁用项不进入可信状态来源。 */
  private visibleEnabledConfigs(settings: PetSettings): AgentConfig[] {
    return settings.agentConfigs.filter((config) => config.enabled && config.agentCardVisible !== false);
  }

  private participatingEnabledConfigs(settings: PetSettings): AgentConfig[] {
    return settings.agentConfigs.filter((config) => config.enabled);
  }

  private buildInitialSnapshot(settings: PetSettings): PetPerceptionSnapshot {
    const agents = this.visibleEnabledConfigs(settings).map((config) => this.emptyAgent(config));
    const channels = this.channelSummaries();
    return {
      enabled: settings.petPerception.enabled,
      primaryAgentId: settings.activeAgentId,
      primaryAgentPhase: "waiting",
      agents,
      channels,
      aggregate: {
        phase: settings.petPerception.enabled ? phaseForRuntime("unknown") : "offline",
        detail: this.aggregateDetail(agents),
        configuredAgentCount: agents.length,
        availableAgentCount: this.availableAgentCount(agents),
        configuredChannelCount: channels.length,
        connectedChannelCount: 0,
        activeTaskCount: 0,
        updatedAt: nowIso(),
      },
      agentTasks: {
        enabled: settings.petPerception.enabled,
        observedAt: nowIso(),
        tasks: [],
        recentCompletions: [],
      },
      lastEvent: null,
      lastRun: null,
    };
  }

  private withAgentConfiguration(snapshot: PetPerceptionSnapshot, settings: PetSettings): PetPerceptionSnapshot {
    const previous = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const agents = this.visibleEnabledConfigs(settings).map((config) => previous.get(config.id) ?? this.emptyAgent(config));
    return {
      ...snapshot,
      enabled: settings.petPerception.enabled,
      primaryAgentId: settings.activeAgentId,
      agents,
      channels: this.channelSummaries(),
      aggregate: this.computeAggregate(agents, settings.activeAgentId),
    };
  }

  private emptyAgent(config: AgentConfig): PetPerceptionAgentSummary {
    return {
      id: config.id,
      displayName: config.displayName,
      provider: config.provider,
      runtime: "unknown",
      controller: "unknown",
      observedAt: null,
    };
  }

  // ---------------------------------------------------------------------------
  // 多来源聚合：活跃任务计数、通道连接状态、聚合摘要
  // ---------------------------------------------------------------------------

  /** agent-status 事件的稳定内部键：platform + channelId + conversationId + 可选 messageId。 */
  private channelTaskKey(event: Extract<PetPerceptionChannelEvent, { type: "agent-status" }>): string {
    return `${event.platform}:${event.channelId}:${event.conversationId}:${event.messageId ?? ""}`;
  }

  /** 维护活跃任务集合：任务态进入，completed/failed 移除，并记录最近任务结果供 phase 短暂保持。 */
  private updateTaskState(key: string, status: ChannelAgentStatus): void {
    if (status === "completed" || status === "failed") {
      this.activeTasks.delete(key);
      this.taskResult = { phase: status === "completed" ? "success" : "error", occurredAt: nowIso() };
    } else {
      this.activeTasks.add(key);
    }
    // 任务计数/结果属于聚合摘要：立即重算并只在实质变化时提交。
    // 放在事件发布之前执行，保证事件反馈开关关闭或事件被去重时计数依然可信。
    this.refreshAggregate();
  }

  /** 保留通道最近一次连接状态，只记稳定 channelId/platform 与脱敏状态。 */
  private retainChannelState(status: ChannelStatus): void {
    this.channelStates.set(status.channelId, {
      channelId: status.channelId,
      platform: status.platform,
      state: status.connected ? "online" : "offline",
      observedAt: nowIso(),
    });
  }

  /** 设置中已启用的 Bot 通道（仅依赖设置字段，不读取凭据）。 */
  private configuredChannels(): Array<{ channelId: string; platform: BotPlatform }> {
    const settings = this.settings;
    const channels: Array<{ channelId: string; platform: BotPlatform }> = [];
    if (settings.wechatEnabled && settings.wechatTokenFile.trim() !== "") {
      channels.push({ channelId: WECHAT_CHANNEL_ID, platform: "wechat" });
    }
    for (const account of settings.qqAccounts) {
      if (account.enabled) channels.push({ channelId: account.id.startsWith("qq:") ? account.id : `qq:${account.id}`, platform: "qq" });
    }
    for (const account of settings.feishuAccounts) {
      if (account.enabled) channels.push({ channelId: account.id.startsWith("feishu:") ? account.id : `feishu:${account.id}`, platform: "feishu" });
    }
    for (const account of settings.dingtalkAccounts) {
      if (account.enabled) channels.push({ channelId: account.id.startsWith("dingtalk:") ? account.id : `dingtalk:${account.id}`, platform: "dingtalk" });
    }
    return channels;
  }

  /** 快照 channels 列表：每个已配置通道一行；未收到过状态事件的通道为 unknown。 */
  private channelSummaries(): PetPerceptionChannelSummary[] {
    return this.configuredChannels().map(({ channelId, platform }) =>
      this.channelStates.get(channelId) ?? { channelId, platform, state: "unknown", observedAt: null },
    );
  }

  /** 只统计“已配置且当前在线”的通道，移除/停用的通道不会以残留状态计数。 */
  private connectedChannelCount(): number {
    let count = 0;
    for (const { channelId } of this.configuredChannels()) {
      if (this.channelStates.get(channelId)?.state === "online") count += 1;
    }
    return count;
  }

  /** 与设置页 Agent 行一致的口径：运行时在线或控制器可用即视为可用。 */
  private availableAgentCount(agents: PetPerceptionAgentSummary[]): number {
    return agents.filter((agent) => agent.runtime === "online" || agent.controller === "available").length;
  }

  /** 聚合 phase：任务优先，其次短暂保持任务结果，最后回退运行时语义；感知关闭时为 offline。 */
  private aggregatePhase(primaryRuntime: PetPerceptionAgentSummary["runtime"], agentTasks: AgentTaskSnapshot = this.snapshot?.agentTasks ?? emptyAgentTaskSnapshot()): PetPerceptionPhase {
    if (!this.settings.petPerception.enabled) return "offline";
    if (this.observedActiveTaskCount(agentTasks) > 0) return "working";
    const result = this.taskResult;
    if (result) {
      const elapsed = Date.now() - Date.parse(result.occurredAt);
      if (Number.isFinite(elapsed) && elapsed < TASK_PHASE_HOLD_MS) return result.phase;
    }
    return phaseForRuntime(primaryRuntime);
  }

  /** 聚合详情只含脱敏计数，不含正文、凭据、路径、命令或消息 ID。 */
  private aggregateDetail(agents: PetPerceptionAgentSummary[], agentTasks: AgentTaskSnapshot = this.snapshot?.agentTasks ?? emptyAgentTaskSnapshot()): string {
    if (!this.settings.petPerception.enabled) return "感知已关闭，未在监听任务与通道状态";
    const parts: string[] = [];
    const activeTaskCount = this.observedActiveTaskCount(agentTasks);
    if (activeTaskCount > 0) parts.push(`正在处理 ${activeTaskCount} 个任务`);
    parts.push(agents.length > 0 ? `${this.availableAgentCount(agents)}/${agents.length} 个 Agent 可用` : "未配置 Agent");
    const channels = this.configuredChannels();
    parts.push(channels.length > 0 ? `${this.connectedChannelCount()}/${channels.length} 个 Bot 在线` : "未配置 Bot 通道");
    return parts.join(" · ");
  }

  /** 聚合内容未变时复用当前对象（updatedAt 保持稳定，不产生心跳）；变化时携带新 updatedAt。 */
  private computeAggregate(agents: PetPerceptionAgentSummary[], primaryAgentId: string, agentTasks: AgentTaskSnapshot = this.snapshot?.agentTasks ?? emptyAgentTaskSnapshot()): PetPerceptionAggregateStatus {
    const current = this.snapshot.aggregate;
    const primary = agents.find((agent) => agent.id === primaryAgentId);
    const content = {
      phase: this.aggregatePhase(primary?.runtime ?? "unknown", agentTasks),
      detail: this.aggregateDetail(agents, agentTasks),
      configuredAgentCount: agents.length,
      availableAgentCount: this.availableAgentCount(agents),
      configuredChannelCount: this.configuredChannels().length,
      connectedChannelCount: this.connectedChannelCount(),
      activeTaskCount: this.observedActiveTaskCount(agentTasks),
    };
    const candidate: PetPerceptionAggregateStatus = { ...content, updatedAt: current.updatedAt };
    if (JSON.stringify(candidate) === JSON.stringify(current)) return current;
    return { ...content, updatedAt: nowIso() };
  }

  /** 重算聚合：内容实质变化才替换并推送快照，避免快照退化成第二事件流或产生心跳。 */
  private refreshAggregate(): void {
    const aggregate = this.computeAggregate(this.snapshot.agents, this.snapshot.primaryAgentId);
    if (aggregate === this.snapshot.aggregate) return;
    this.commitSnapshot({ ...this.snapshot, aggregate });
  }

  /** 停用感知时清除全部瞬时运行态（任务计数、通道连接状态、任务结果保持）。 */
  private clearTransientState(): void {
    this.activeTasks.clear();
    this.channelStates.clear();
    this.taskResult = null;
  }

  private publishEvent(event: Omit<PetPerceptionEvent, "occurredAt">): void {
    const nextEvent: PetPerceptionEvent = { ...event, detail: safeDetail(event.detail), occurredAt: nowIso() };
    const previous = this.snapshot.lastEvent;
    const dedupeKey = `${nextEvent.source}:${nextEvent.phase}:${nextEvent.platform ?? ""}:${nextEvent.agentId ?? ""}:${nextEvent.detail}`;
    const previousKey = previous
      ? `${previous.source}:${previous.phase}:${previous.platform ?? ""}:${previous.agentId ?? ""}:${previous.detail}`
      : "";
    if (dedupeKey === previousKey && nextEvent.transient === previous?.transient) return;
    const nextSnapshot: PetPerceptionSnapshot = {
      ...this.snapshot,
      primaryAgentPhase: nextEvent.agentId && nextEvent.agentId !== this.snapshot.primaryAgentId
        ? this.snapshot.primaryAgentPhase
        : nextEvent.phase,
      lastEvent: nextEvent,
    };
    if (nextEvent.transient) {
      // 瞬时事件（任务/消息流）只更新内部状态并走事件订阅；
      // 聚合变化（任务起止/结果）已在 updateTaskState 中单独提交，快照推送不演变成第二事件流。
      this.snapshot = nextSnapshot;
    } else {
      // 非瞬时状态变化（如通道在线/离线）属于快照的实质变化。
      this.commitSnapshot({
        ...nextSnapshot,
        channels: this.channelSummaries(),
        aggregate: this.computeAggregate(this.snapshot.agents, this.snapshot.primaryAgentId),
      });
    }
    this.listeners.forEach((listener) => listener(nextEvent));
  }

  private schedulePoll(delayMs: number): void {
    this.stopPolling();
    if (!this.running || !this.settings.petPerception.enabled) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollRuntime();
    }, delayMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollRuntime(): Promise<void> {
    if (this.pollInFlight || !this.running || !this.settings.petPerception.enabled) return;
    this.pollInFlight = true;
    const settings = this.options.getSettings();
    try {
      const [controller, runtime] = await Promise.all([
        this.options.getControllerStatus(),
        settings.petPerception.agentRuntime
          ? probeAgentRuntime(this.visibleEnabledConfigs(settings))
          : Promise.resolve({} as Record<string, PetPerceptionAgentSummary["runtime"]>),
      ]);
      // 轮询期间服务被停止或设置已变化：丢弃本次探测结果，避免旧状态回填。
      if (!this.running || !this.settings.petPerception.enabled) return;
      if (this.settings !== settings) {
        this.schedulePoll(0);
        return;
      }
      const controllerMap = new Map(controller.agents.map((agent) => [agent.id, agent]));
      const now = nowIso();
      const agents = this.visibleEnabledConfigs(settings).map((config) => {
        const previous = this.snapshot.agents.find((agent) => agent.id === config.id);
        const nextRuntime = settings.petPerception.agentRuntime ? runtime[config.id] ?? "unknown" : previous?.runtime ?? "unknown";
        const controllerState = controllerMap.get(config.id)?.state;
        const nextController = controllerState === "available" ? "available" : controllerState === "unavailable" ? "unavailable" : "unknown";
        const changed = previous?.runtime !== nextRuntime || previous?.controller !== nextController;
        return {
          id: config.id,
          displayName: config.displayName,
          provider: config.provider,
          runtime: nextRuntime,
          controller: nextController,
          observedAt: changed || !previous?.observedAt ? now : previous.observedAt,
        } satisfies PetPerceptionAgentSummary;
      });
      const primary = agents.find((agent) => agent.id === settings.activeAgentId);
      const nextPhase = this.snapshot.lastEvent?.transient
        ? this.snapshot.primaryAgentPhase
        : phaseForRuntime(primary?.runtime ?? "unknown");
      this.commitSnapshot({
        ...this.snapshot,
        enabled: settings.petPerception.enabled,
        primaryAgentId: settings.activeAgentId,
        primaryAgentPhase: nextPhase,
        agents,
        channels: this.channelSummaries(),
        aggregate: this.computeAggregate(agents, settings.activeAgentId),
      });
      this.schedulePoll(RUNTIME_POLL_INTERVAL_MS);
    } catch (error) {
      if (this.running && this.settings.petPerception.enabled && this.settings === settings) {
        this.commitSnapshot({ ...this.snapshot, primaryAgentPhase: "waiting" });
      }
      this.schedulePoll(FAILURE_BACKOFF_MS);
    } finally {
      this.pollInFlight = false;
    }
  }

  private observedActiveTaskCount(agentTasks: AgentTaskSnapshot = this.snapshot?.agentTasks ?? emptyAgentTaskSnapshot()): number {
    const externalActiveCount = agentTasks.tasks.filter((task) =>
      task.source !== "app-event" && (task.state === "running" || task.state === "needs-input"),
    ).length;
    return this.activeTasks.size + externalActiveCount;
  }

  private async runPerception(rawSignal: string): Promise<PetPerceptionRun> {
    const signal = typeof rawSignal === "string" ? rawSignal.trim() : "";
    if (!signal) return this.storeFailedRun("", "请输入本次要让 Agent 感知的信号");
    if (signal.length > MAX_PERCEPTION_SIGNAL_LENGTH) {
      return this.storeFailedRun(safeDetail(signal), `感知信号过长，请控制在 ${MAX_PERCEPTION_SIGNAL_LENGTH} 字以内`);
    }

    const settings = this.options.getSettings();
    if (!settings.petPerception.enabled) return this.storeFailedRun(safeDetail(signal), "桌宠感知未开启，请先打开感知总开关");

    const configs = this.participatingEnabledConfigs(settings);
    const startedAt = nowIso();
    const run: PetPerceptionRun = {
      id: `perception-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      signalPreview: safeDetail(signal),
      state: "running",
      detail: configs.length > 0 ? `正在让 ${configs.length} 个 Agent 共同感知` : "没有可参与的已启用 Agent",
      startedAt,
      completedAt: null,
      participants: configs.map((config) => this.queuedParticipant(config, startedAt)),
    };
    this.commitSnapshot({ ...this.snapshot, lastRun: run });
    this.publishEvent({
      source: "agent-perception",
      phase: "starting",
      detail: run.detail,
      transient: true,
    });

    if (configs.length === 0) return this.finishPerceptionRun(run.id);
    if (settings.agentPermissionPolicy === "chat-only") {
      for (const config of configs) {
        this.updatePerceptionParticipant(run.id, config.id, {
          state: "skipped",
          detail: "当前权限为仅聊天，未调用本机 Agent",
          resultPreview: null,
        });
      }
      this.publishEvent({
        source: "agent-perception",
        phase: "error",
        detail: "当前权限为仅聊天，Agent 感知未执行",
        transient: true,
      });
      return this.finishPerceptionRun(run.id);
    }

    const taskKeys = configs.map((config) => this.perceptionTaskKey(run.id, config.id));
    taskKeys.forEach((key) => this.activeTasks.add(key));
    this.refreshAggregate();
    await Promise.all(configs.map(async (config) => {
      this.updatePerceptionParticipant(run.id, config.id, {
        state: "running",
        detail: "正在调用本机 Agent",
        resultPreview: null,
      });
      this.publishEvent({
        source: "agent-perception",
        phase: "working",
        agentId: config.id,
        detail: `${config.displayName} 正在参与感知`,
        transient: true,
      });
      try {
        const result = await this.options.runAgentPerception(config, signal);
        const preview = safeDetail(result);
        this.updatePerceptionParticipant(run.id, config.id, {
          state: "success",
          detail: preview || "Agent 已完成感知",
          resultPreview: preview || null,
        });
        this.publishEvent({
          source: "agent-perception",
          phase: "success",
          agentId: config.id,
          detail: `${config.displayName} 已完成感知`,
          transient: true,
        });
      } catch (error) {
        const detail = safeDetail(error instanceof Error ? error.message : String(error)) || "Agent 感知失败";
        this.updatePerceptionParticipant(run.id, config.id, {
          state: "error",
          detail,
          resultPreview: null,
        });
        this.publishEvent({
          source: "agent-perception",
          phase: "error",
          agentId: config.id,
          detail: `${config.displayName} 感知失败：${detail}`,
          transient: true,
        });
      } finally {
        this.activeTasks.delete(this.perceptionTaskKey(run.id, config.id));
        this.refreshAggregate();
      }
    }));

    return this.finishPerceptionRun(run.id);
  }

  private queuedParticipant(config: AgentConfig, updatedAt: string): PetPerceptionParticipant {
    return {
      agentId: config.id,
      displayName: config.displayName,
      state: "queued",
      detail: "等待调用",
      resultPreview: null,
      updatedAt,
    };
  }

  private perceptionTaskKey(runId: string, agentId: string): string {
    return `perception:${runId}:${agentId}`;
  }

  private updatePerceptionParticipant(
    runId: string,
    agentId: string,
    update: Pick<PetPerceptionParticipant, "state" | "detail" | "resultPreview">,
  ): void {
    const run = this.snapshot.lastRun;
    if (!run || run.id !== runId) return;
    const participants = run.participants.map((participant) => participant.agentId === agentId
      ? { ...participant, ...update, updatedAt: nowIso() }
      : participant);
    this.commitSnapshot({ ...this.snapshot, lastRun: { ...run, participants } });
  }

  private storeFailedRun(signalPreview: string, detail: string): PetPerceptionRun {
    const now = nowIso();
    const run: PetPerceptionRun = {
      id: `perception-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      signalPreview,
      state: "failed",
      detail,
      startedAt: now,
      completedAt: now,
      participants: [],
    };
    this.commitSnapshot({ ...this.snapshot, lastRun: run });
    if (this.settings.petPerception.enabled) {
      this.publishEvent({ source: "agent-perception", phase: "error", detail, transient: true });
    }
    return run;
  }

  private finishPerceptionRun(runId: string): PetPerceptionRun {
    const current = this.snapshot.lastRun;
    if (!current || current.id !== runId) {
      return this.storeFailedRun("", "感知状态已失效，请重试");
    }
    const successCount = current.participants.filter((participant) => participant.state === "success").length;
    const errorCount = current.participants.filter((participant) => participant.state === "error").length;
    const skippedCount = current.participants.filter((participant) => participant.state === "skipped").length;
    const total = current.participants.length;
    const state: PetPerceptionRun["state"] = total === 0 || successCount === 0
      ? "failed"
      : successCount === total
        ? "completed"
        : "partial";
    const detail = total === 0
      ? "没有可参与的已启用 Agent"
      : `${successCount}/${total} 个 Agent 已完成感知${errorCount > 0 ? `，${errorCount} 个失败` : ""}${skippedCount > 0 ? `，${skippedCount} 个跳过` : ""}`;
    const finished: PetPerceptionRun = {
      ...current,
      state,
      detail,
      completedAt: nowIso(),
    };
    this.commitSnapshot({ ...this.snapshot, lastRun: finished });
    this.publishEvent({
      source: "agent-perception",
      phase: state === "completed" ? "success" : state === "failed" ? "error" : "working",
      detail,
      transient: true,
    });
    return finished;
  }

  /** 仅在快照内容发生实质变化时替换状态并推送克隆快照；不产生固定频率心跳。 */
  private commitSnapshot(next: PetPerceptionSnapshot): void {
    const cloned = structuredClone(next);
    if (JSON.stringify(cloned) === JSON.stringify(this.snapshot)) return;
    this.snapshot = cloned;
    this.snapshotListeners.forEach((listener) => listener(structuredClone(cloned)));
  }
}
