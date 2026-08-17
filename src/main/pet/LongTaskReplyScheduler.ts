import type { PetSettings, TaskNotificationMode } from "../../settings/types";
import type { WeChatEvent } from "../wechat/events";
import type { BotChannelEvent, BotPlatform, ChannelAgentStatus, OutboundMessage } from "../channels/types";
import type { AgentTaskObservation, AgentTaskSnapshot } from "./perceptionTypes";
import { isCodexDesktopTask, isCodexDesktopTaskActive } from "./codexDesktopTaskStatus";
import {
  formatAgentEventNotification,
  type TaskNotificationUiStatus,
} from "./taskNotificationFormatter";

const LONG_RUNNING_STATUSES = new Set<ChannelAgentStatus>([
  "starting",
  "thinking",
  "tool",
  "command",
  "network",
  "waiting",
]);
const TERMINAL_STATUSES = new Set<ChannelAgentStatus>([
  "response-ready",
  "sending",
  "completed",
  "failed",
]);
const MAX_PROGRESS_DETAIL_LENGTH = 140;
const PHASE_UPDATE_MIN_GAP_MS = 15_000;
const MAX_UNCHANGED_BACKOFF_MS = 15 * 60_000;
const MAX_UNCHANGED_BACKOFF_LEVEL = 8;

function supportsProgressReports(settings: PetSettings, mode = settings.taskNotificationMode): boolean {
  return settings.petPerception.longTaskReplyEnabled
    && (mode === "detail" || mode === "timed" || mode === "plan");
}

function notificationModeForTask(task: Pick<ActiveLongTask, "notificationMode">, settings: PetSettings): TaskNotificationMode {
  return task.notificationMode ?? settings.taskNotificationMode;
}

export interface LongTaskReplyTarget {
  channelId: string;
  platform: BotPlatform;
  botAccountId?: string;
  conversationId: string;
  conversationType: "direct" | "group" | "channel";
  messageId: string;
  contextToken?: string;
  /** 捕获该目标时的微信账号身份；换账号后用于识别过期目标（仅 wechat 设置）。 */
  accountId?: string;
}

export interface LongTaskReplyRoute {
  routeId: string;
  target: LongTaskReplyTarget;
  mode: TaskNotificationMode;
}

interface ActiveLongTask {
  key: string;
  kind: "channel" | "codex-desktop" | "external";
  agentLabel?: string;
  workspaceLabel?: string;
  surface?: AgentTaskObservation["surface"];
  uiStatus: TaskNotificationUiStatus;
  taskTitle?: string | null;
  target: LongTaskReplyTarget;
  notificationMode?: TaskNotificationMode;
  startedAt: number;
  lastSentAt: number;
  lastSentFingerprint: string;
  unchangedBackoffLevel: number;
  status: ChannelAgentStatus;
  phase: number;
  detail: string;
  startNotified: boolean;
  /** 启动通知是否已有在途请求；失败后保持 false，由后续生命周期 tick 重试。 */
  startNoticePending: boolean;
  /** 启动通知失败后的退避时间，避免失效目标持续刷发送请求。 */
  startNoticeRetryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  waitingNoticeFingerprint: string;
}

interface LongTaskReplySchedulerOptions {
  getSettings: () => PetSettings;
  getExternalNotificationRoutes?: () => LongTaskReplyRoute[];
  send: (target: LongTaskReplyTarget, message: OutboundMessage) => Promise<boolean>;
  publish: (event: BotChannelEvent) => void;
}

function targetScope(target: LongTaskReplyTarget): string {
  return `${target.channelId}:${target.botAccountId ?? target.accountId ?? "default"}:${target.conversationId}`;
}

function taskKey(target: LongTaskReplyTarget): string {
  return `${targetScope(target)}:${target.messageId}`;
}

function progressFingerprint(status: ChannelAgentStatus, detail: string): string {
  return `${status}\u0000${detail}`;
}

function sanitizeProgressDetail(detail: string): string {
  return detail
    .replace(/\b(bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROGRESS_DETAIL_LENGTH);
}

function externalTaskStatus(observation: AgentTaskObservation): ChannelAgentStatus {
  if (observation.state === "needs-input") return "waiting";
  if (observation.activity === "editing") return "tool";
  if (observation.activity === "command" || observation.activity === "network" || observation.activity === "tool" || observation.activity === "thinking" || observation.activity === "starting" || observation.activity === "waiting") return observation.activity;
  return "thinking";
}

function uiStatusForObservation(observation: AgentTaskObservation): TaskNotificationUiStatus {
  if (observation.state === "needs-input") return "need_reply";
  if (observation.activity === "waiting") return "waiting";
  return "processing";
}

function uiStatusForChannel(status: ChannelAgentStatus): TaskNotificationUiStatus {
  return status === "waiting" ? "need_reply" : "processing";
}

function renderTemplate(_template: string, task: ActiveLongTask): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
  const status = task.uiStatus === "need_reply"
    ? "input_required"
    : task.uiStatus === "waiting" ? "waiting" : "processing";
  return formatAgentEventNotification({
    status,
    sourceName: task.agentLabel,
    title: task.taskTitle ?? "任务进度",
    message: sanitizeProgressDetail(task.detail) || (status === "processing" ? "正在处理" : status === "waiting" ? "等待继续" : "请回复以继续"),
    workspaceLabel: task.workspaceLabel,
    surface: task.surface,
    elapsedSeconds,
  });
}

function botAccountIdForInbound(
  settings: PetSettings,
  platform: BotPlatform,
  accountId = "",
  channelId = "",
): string {
  const identity = accountId.trim() || channelId.trim();
  const accounts: Array<{ id: string; tokenFile?: string; appId?: string; clientId?: string }> = platform === "wechat"
    ? settings.wechatAccounts
    : platform === "qq"
      ? settings.qqAccounts
      : platform === "feishu"
        ? settings.feishuAccounts
        : settings.dingtalkAccounts;
  const matched = accounts.find((account) => [account.id, account.tokenFile, account.appId, account.clientId, `${platform}:${account.appId ?? account.clientId ?? ""}`]
    .filter(Boolean)
    .includes(identity));
  if (matched) return matched.id;
  if (platform === "wechat" && channelId === "wechat:active") return settings.activeWeChatAccountId || identity;
  return identity;
}

export class LongTaskReplyScheduler {
  private readonly active = new Map<string, ActiveLongTask>();
  private readonly latestTargets = new Map<string, LongTaskReplyTarget>();
  private readonly targetsByMessageId = new Map<string, LongTaskReplyTarget>();
  private readonly latestTargetByBot = new Map<string, LongTaskReplyTarget>();
  private latestWeChatTarget: LongTaskReplyTarget | null = null;
  private latestTarget: LongTaskReplyTarget | null = null;
  private latestAgentTaskSnapshot: AgentTaskSnapshot | null = null;

  constructor(private readonly options: LongTaskReplySchedulerOptions) {}

  /** The most recent inbound bot conversation, used for automatic completion notices. */
  getLatestTarget(): LongTaskReplyTarget | null {
    return this.latestTarget ? { ...this.latestTarget } : null;
  }

  setSettings(settings: PetSettings): void {
    if (!settings.petPerception.enabled) {
      this.stopAll();
      return;
    }
    for (const task of this.active.values()) {
      const mode = task.notificationMode ?? settings.taskNotificationMode;
      if (supportsProgressReports(settings, mode)) this.schedule(task, 0);
      else if (task.timer) {
        clearTimeout(task.timer);
        task.timer = null;
      }
    }
    this.syncExternalTasks();
    this.syncCodexDesktopTasks();
  }

  handleChannelEvent(event: BotChannelEvent): void {
    if (event.type === "message") {
      this.rememberTarget({
        channelId: event.message.channelId,
        platform: event.message.platform,
        botAccountId: botAccountIdForInbound(this.options.getSettings(), event.message.platform, event.message.accountId, event.message.channelId),
        conversationId: event.message.conversationId,
        conversationType: event.message.conversationType,
        messageId: event.message.id,
        contextToken: event.message.contextToken,
        accountId: event.message.accountId,
      });
      this.syncExternalTasks();
      this.syncCodexDesktopTasks();
      return;
    }
    if (event.type !== "agent-status") return;

    const botAccountId = botAccountIdForInbound(this.options.getSettings(), event.platform, "", event.channelId);
    const remembered = this.latestTargets.get(`${event.channelId}:${botAccountId}:${event.conversationId}`)
      ?? [...this.latestTargets.values()].find((target) => target.channelId === event.channelId
        && target.platform === event.platform
        && target.conversationId === event.conversationId);
    const target: LongTaskReplyTarget | null = event.messageId
      ? {
          channelId: event.channelId,
          platform: event.platform,
          botAccountId: remembered?.botAccountId ?? botAccountId,
          conversationId: event.conversationId,
          conversationType: remembered?.conversationType ?? "direct",
          messageId: event.messageId,
          contextToken: remembered?.contextToken,
        }
      : remembered ?? null;
    if (!target) return;

    this.updateStatus(target, event.status, event.detail);
  }

  handleWeChatEvent(event: WeChatEvent): void {
    if (event.type === "message") {
      const target = {
        channelId: "wechat:active",
        platform: "wechat",
        botAccountId: botAccountIdForInbound(this.options.getSettings(), "wechat", event.accountId, "wechat:active"),
        conversationId: event.from,
        conversationType: "direct",
        messageId: event.id,
        contextToken: event.contextToken,
        accountId: event.accountId,
      } satisfies LongTaskReplyTarget;
      this.latestWeChatTarget = target;
      this.rememberTarget(target);
      this.syncExternalTasks();
      this.syncCodexDesktopTasks();
      return;
    }
    if (event.type !== "agent-status") return;
    const target = event.messageId
      ? this.targetsByMessageId.get(event.messageId)
      : event.from
        ? [...this.latestTargets.values()].find((candidate) => candidate.platform === "wechat" && candidate.channelId === "wechat:active" && candidate.conversationId === event.from)
        : this.latestWeChatTarget;
    if (target) this.updateStatus(target, event.status, event.detail);
  }

  handleAgentTaskSnapshot(snapshot: AgentTaskSnapshot): void {
    this.latestAgentTaskSnapshot = snapshot;
    this.syncExternalTasks();
    this.syncCodexDesktopTasks();
  }

  /** Restore persisted bot conversations before the next external task arrives. */
  restoreTargets(targets: LongTaskReplyTarget[]): void {
    for (const target of targets) this.rememberTarget(target);
    this.syncExternalTasks();
    this.syncCodexDesktopTasks();
  }

  stopAll(): void {
    for (const task of this.active.values()) this.stop(task.key);
  }

  private rememberTarget(target: LongTaskReplyTarget): void {
    const settings = this.options.getSettings();
    const normalized = {
      ...target,
      botAccountId: target.botAccountId || botAccountIdForInbound(settings, target.platform, target.accountId, target.channelId),
    };
    this.latestTargets.set(targetScope(normalized), normalized);
    this.targetsByMessageId.set(normalized.messageId, normalized);
    this.latestTargetByBot.set(`${normalized.platform}:${normalized.botAccountId}`, normalized);
    this.latestTarget = normalized;
  }

  private externalNotificationRoutes(settings: PetSettings): LongTaskReplyRoute[] {
    const provided = this.options.getExternalNotificationRoutes?.();
    if (provided) return provided;
    return [...this.latestTargetByBot.entries()].flatMap(([routeId, target]) => {
      const accountId = target.botAccountId || botAccountIdForInbound(settings, target.platform, target.accountId, target.channelId);
      const accounts: Array<{ id: string; taskNotificationEnabled: boolean; taskNotificationMode: TaskNotificationMode }> = target.platform === "wechat"
        ? settings.wechatAccounts
        : target.platform === "qq"
          ? settings.qqAccounts
          : target.platform === "feishu"
            ? settings.feishuAccounts
            : settings.dingtalkAccounts;
      const account = accounts.find((item) => item.id === accountId);
      if (!account?.taskNotificationEnabled) return [];
      return [{ routeId, target, mode: account.taskNotificationMode }];
    });
  }

  private syncCodexDesktopTasks(): void {
    const settings = this.options.getSettings();
    const snapshot = this.latestAgentTaskSnapshot;
    const routes = this.externalNotificationRoutes(settings);
    if (!snapshot || routes.length === 0 || !settings.petPerception.enabled) {
      const hasActiveCodexTasks = snapshot?.tasks.some(
        (observation) => isCodexDesktopTask(observation) && isCodexDesktopTaskActive(observation),
      ) ?? false;
      if (hasActiveCodexTasks && routes.length === 0 && settings.petPerception.enabled) {
        console.info("[LongTaskReply] no bot notification target; Codex Desktop progress stays desktop-only");
      }
      for (const [key, task] of this.active) {
        if (task.kind === "codex-desktop") this.stop(key);
      }
      return;
    }

    const activeKeys = new Set<string>();
    for (const route of routes) for (const observation of snapshot.tasks.filter(isCodexDesktopTask)) {
      if (!isCodexDesktopTaskActive(observation)) continue;
      const key = `codex-desktop:${route.routeId}:${observation.id}`;
      activeKeys.add(key);
      const status: ChannelAgentStatus = observation.state === "needs-input"
        ? "waiting"
        : observation.activity === "editing"
          ? "tool"
          : observation.activity ?? "thinking";
      const existing = this.active.get(key);
      const parsedStartedAt = Date.parse(observation.startedAt ?? observation.observedAt);
      const startedAt = Number.isFinite(parsedStartedAt) && parsedStartedAt <= Date.now()
        ? parsedStartedAt
        : Date.now();
      const task: ActiveLongTask = existing ?? {
        key,
        kind: "codex-desktop",
        target: route.target,
        notificationMode: route.mode,
        surface: observation.surface,
        uiStatus: uiStatusForObservation(observation),
        startedAt,
        lastSentAt: 0,
        lastSentFingerprint: "",
        unchangedBackoffLevel: 0,
        status,
        phase: 1,
        detail: observation.detail,
        startNotified: false,
        startNoticePending: false,
        startNoticeRetryAt: 0,
        timer: null,
        sending: false,
        waitingNoticeFingerprint: "",
      };
      const targetChanged = existing && (
        task.target.messageId !== route.target.messageId
        || task.target.contextToken !== route.target.contextToken
        || task.target.accountId !== route.target.accountId
      );
      task.target = route.target;
      task.notificationMode = route.mode;
      task.agentLabel = observation.displayName;
      task.workspaceLabel = observation.workspaceLabel ?? task.workspaceLabel;
      task.surface = observation.surface;
      task.uiStatus = uiStatusForObservation(observation);
      task.taskTitle = observation.taskTitle;
      if (targetChanged) {
        task.startNoticeRetryAt = 0;
        if (!task.sending) this.schedule(task, 0);
      }
      const observationChanged = existing && (task.status !== status || task.detail !== observation.detail);
      if (observationChanged) {
        task.phase = Math.min(99, task.phase + 1);
        task.unchangedBackoffLevel = 0;
      }
      task.status = status;
      task.detail = observation.detail;
      this.active.set(key, task);
      if (!existing) this.notifyTaskStart(task, settings);
      if (observationChanged && task.uiStatus === "need_reply") this.notifyWaitingInput(task, settings);
      if (observationChanged && task.uiStatus === "waiting") this.notifyWaiting(task, settings);
      if (supportsProgressReports(settings, route.mode)) {
        if (!existing) this.schedule(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000);
        else if (observationChanged && !task.sending && route.mode === "detail") {
          this.schedule(task, this.nextPhaseUpdateDelay(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000));
        }
      }
    }

    for (const [key, task] of this.active) {
      if (task.kind === "codex-desktop" && !activeKeys.has(key)) this.stop(key);
    }
  }

  /**
   * 通用外部 Host 任务通知：Codex Desktop 继续走下方的兼容规划模式，其他
   * VS Code/CLI/Gateway/Service 任务共用同一套关键节点、阶段变化和指数退避。
   */
  private syncExternalTasks(): void {
    const settings = this.options.getSettings();
    const snapshot = this.latestAgentTaskSnapshot;
    const routes = this.externalNotificationRoutes(settings);
    const observations = snapshot?.tasks.filter((observation) =>
      observation.confidence === "event"
      && observation.surface !== "internal"
      && observation.source !== "app-event"
      && observation.source !== "delegation"
      && !isCodexDesktopTask(observation)
      && (observation.state === "running" || observation.state === "needs-input"),
    ) ?? [];
    if (!snapshot || routes.length === 0 || !settings.petPerception.enabled) {
      for (const [key, task] of this.active) {
        if (task.kind === "external") this.stop(key);
      }
      if (observations.length > 0 && routes.length === 0 && settings.petPerception.enabled) {
        console.info("[LongTaskReply] no bot notification target; external Host progress stays desktop-only");
      }
      return;
    }

    const activeKeys = new Set<string>();
    for (const route of routes) for (const observation of observations) {
      const key = `external:${route.routeId}:${observation.id}`;
      activeKeys.add(key);
      const status = externalTaskStatus(observation);
      const existing = this.active.get(key);
      const parsedStartedAt = Date.parse(observation.startedAt ?? observation.observedAt);
      const startedAt = Number.isFinite(parsedStartedAt) && parsedStartedAt <= Date.now() ? parsedStartedAt : Date.now();
      const task: ActiveLongTask = existing ?? {
        key,
        kind: "external",
        agentLabel: observation.displayName,
        workspaceLabel: observation.workspaceLabel,
        surface: observation.surface,
        uiStatus: uiStatusForObservation(observation),
        taskTitle: observation.taskTitle,
        target: route.target,
        notificationMode: route.mode,
        startedAt,
        lastSentAt: 0,
        lastSentFingerprint: "",
        unchangedBackoffLevel: 0,
        status,
        phase: 1,
        detail: observation.detail,
        startNotified: false,
        startNoticePending: false,
        startNoticeRetryAt: 0,
        timer: null,
        sending: false,
        waitingNoticeFingerprint: "",
      };
      const targetChanged = existing && (
        task.target.messageId !== route.target.messageId
        || task.target.contextToken !== route.target.contextToken
        || task.target.accountId !== route.target.accountId
      );
      task.target = route.target;
      task.notificationMode = route.mode;
      task.agentLabel = observation.displayName;
      task.workspaceLabel = observation.workspaceLabel ?? task.workspaceLabel;
      task.surface = observation.surface;
      task.uiStatus = uiStatusForObservation(observation);
      task.taskTitle = observation.taskTitle;
      if (targetChanged) {
        task.startNoticeRetryAt = 0;
        if (!task.sending) this.schedule(task, 0);
      }
      const observationChanged = Boolean(existing && (task.status !== status || task.detail !== observation.detail));
      if (observationChanged) {
        task.phase = Math.min(99, task.phase + 1);
        task.unchangedBackoffLevel = 0;
      }
      task.status = status;
      task.detail = observation.detail;
      this.active.set(key, task);
      if (!existing) this.notifyTaskStart(task, settings);
      if (observationChanged && task.uiStatus === "need_reply") this.notifyWaitingInput(task, settings);
      if (observationChanged && task.uiStatus === "waiting") this.notifyWaiting(task, settings);
      if (supportsProgressReports(settings, route.mode)) {
        if (!existing) this.schedule(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000);
        else if (observationChanged && !task.sending && route.mode === "detail") {
          this.schedule(task, this.nextPhaseUpdateDelay(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000));
        }
      }
    }

    for (const [key, task] of this.active) {
      if (task.kind === "external" && !activeKeys.has(key)) this.stop(key);
    }
  }

  private updateStatus(target: LongTaskReplyTarget, status: ChannelAgentStatus, detail: string): void {
    const settings = this.options.getSettings();
    const key = taskKey(target);
    if (TERMINAL_STATUSES.has(status)) {
      this.stop(key);
      return;
    }
    if (!LONG_RUNNING_STATUSES.has(status)) return;
    if (!settings.petPerception.enabled) return;

    const existing = this.active.get(key);
    const task: ActiveLongTask = existing ?? {
      key,
      kind: "channel",
      target,
      uiStatus: uiStatusForChannel(status),
      startedAt: Date.now(),
      lastSentAt: 0,
      lastSentFingerprint: "",
      unchangedBackoffLevel: 0,
      status,
      phase: 1,
      detail,
      startNotified: false,
      startNoticePending: false,
      startNoticeRetryAt: 0,
      timer: null,
      sending: false,
      waitingNoticeFingerprint: "",
    };
    task.target = target;
    task.uiStatus = uiStatusForChannel(status);
    const statusChanged = existing && (task.status !== status || task.detail !== detail);
    if (statusChanged) {
      task.phase = Math.min(99, task.phase + 1);
      task.unchangedBackoffLevel = 0;
    }
    task.status = status;
    task.detail = detail;
    this.active.set(key, task);
    if (!existing) this.notifyTaskStart(task, settings);
    if (statusChanged && task.uiStatus === "need_reply") this.notifyWaitingInput(task, settings);
    const mode = notificationModeForTask(task, settings);
    if (supportsProgressReports(settings, mode)) {
      if (!existing) this.schedule(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000);
      else if (statusChanged && !task.sending && mode === "detail") {
        this.schedule(task, this.nextPhaseUpdateDelay(task, settings.petPerception.longTaskReplyIntervalSeconds * 1000));
      }
    }
  }

  private notifyTaskStart(task: ActiveLongTask, settings: PetSettings): void {
    if (task.startNotified) return;
    if (task.startNoticePending) return;
    if (Date.now() < task.startNoticeRetryAt) return;
    // 仅在发送被接受后才置位 startNotified：失败保留 pending=false，
    // 由后续生命周期 tick 重试启动通知，不会重复发送（在途有 pending 护栏）。
    task.startNoticePending = true;
    void settings;
    const text = renderTemplate("", task);
    void this.options.send(task.target, {
      conversationId: task.target.conversationId,
      conversationType: task.target.conversationType,
      replyToMessageId: task.target.messageId,
      contextToken: task.target.contextToken,
      text,
    }).then((delivered) => {
      if (!delivered) {
        task.startNoticePending = false;
        task.startNoticeRetryAt = Date.now() + 60_000;
        console.warn(`[LongTaskReply] start delivery failed ${task.kind} ${task.target.platform}`);
        return;
      }
      task.startNotified = true;
      task.startNoticePending = false;
      task.startNoticeRetryAt = 0;
      this.options.publish({
        type: "reply",
        channelId: task.target.channelId,
        platform: task.target.platform,
        conversationId: task.target.conversationId,
        messageId: task.target.messageId,
        text,
        delivered: true,
      });
    }).catch((error) => {
      task.startNoticePending = false;
      task.startNoticeRetryAt = Date.now() + 60_000;
      console.warn("Unable to send task start notice.", error);
    });
  }

  private notifyWaitingInput(task: ActiveLongTask, settings: PetSettings): void {
    const fingerprint = `need_reply\u0000${task.detail}`;
    if (task.waitingNoticeFingerprint === fingerprint || task.sending) return;
    task.waitingNoticeFingerprint = fingerprint;
    void settings;
    const text = renderTemplate("", { ...task, uiStatus: "need_reply" });
    void this.options.send(task.target, {
      conversationId: task.target.conversationId,
      conversationType: task.target.conversationType,
      replyToMessageId: task.target.messageId,
      contextToken: task.target.contextToken,
      text,
    }).then((delivered) => {
      if (delivered) {
        task.lastSentAt = Date.now();
        this.options.publish({
          type: "reply",
          channelId: task.target.channelId,
          platform: task.target.platform,
          conversationId: task.target.conversationId,
          messageId: task.target.messageId,
          text,
          delivered: true,
        });
      } else {
        console.warn(`[LongTaskReply] waiting-input delivery failed ${task.kind} ${task.target.platform}`);
      }
    }).catch((error) => {
      console.warn("Unable to send waiting-input notice.", error);
    });
  }

  private notifyWaiting(task: ActiveLongTask, settings: PetSettings): void {
    const fingerprint = `waiting\u0000${task.detail}`;
    if (task.waitingNoticeFingerprint === fingerprint || task.sending) return;
    task.waitingNoticeFingerprint = fingerprint;
    void settings;
    const text = renderTemplate("", { ...task, uiStatus: "waiting" });
    void this.options.send(task.target, {
      conversationId: task.target.conversationId,
      conversationType: task.target.conversationType,
      replyToMessageId: task.target.messageId,
      contextToken: task.target.contextToken,
      text,
    }).then((delivered) => {
      if (delivered) {
        task.lastSentAt = Date.now();
        this.options.publish({
          type: "reply",
          channelId: task.target.channelId,
          platform: task.target.platform,
          conversationId: task.target.conversationId,
          messageId: task.target.messageId,
          text,
          delivered: true,
        });
      } else {
        console.warn(`[LongTaskReply] waiting delivery failed ${task.kind} ${task.target.platform}`);
      }
    }).catch((error) => {
      console.warn("Unable to send waiting notice.", error);
    });
  }

  private schedule(task: ActiveLongTask, delayMs?: number): void {
    if (task.timer) clearTimeout(task.timer);
    const settings = this.options.getSettings();
    const intervalMs = settings.petPerception.longTaskReplyIntervalSeconds * 1000;
    const reference = task.lastSentAt || task.startedAt;
    const remaining = Math.max(0, intervalMs - (Date.now() - reference));
    task.timer = setTimeout(() => {
      task.timer = null;
      void this.tick(task.key);
    }, Math.max(0, delayMs ?? remaining));
  }

  private nextPhaseUpdateDelay(task: ActiveLongTask, intervalMs: number): number {
    const reference = task.lastSentAt || task.startedAt;
    const minGapMs = task.lastSentAt ? Math.min(PHASE_UPDATE_MIN_GAP_MS, intervalMs) : intervalMs;
    return Math.max(0, minGapMs - (Date.now() - reference));
  }

  private unchangedReportDelay(task: ActiveLongTask, intervalMs: number): number {
    return Math.min(
      MAX_UNCHANGED_BACKOFF_MS,
      intervalMs * Math.pow(2, task.unchangedBackoffLevel),
    );
  }

  private async tick(key: string): Promise<void> {
    const task = this.active.get(key);
    if (!task) return;
    const settings = this.options.getSettings();
    const mode = notificationModeForTask(task, settings);
    if (!settings.petPerception.enabled || !supportsProgressReports(settings, mode)) {
      this.stop(key);
      return;
    }
    if (!LONG_RUNNING_STATUSES.has(task.status)) {
      this.stop(key);
      return;
    }
    // 启动通知失败后，在后续生命周期 tick 上重试（startNotified 仅在成功后置位，
    // pending 护栏保证不重复发送）。
    if (!task.startNotified) {
      this.notifyTaskStart(task, settings);
      if (!task.startNotified) {
        const retryDelay = task.startNoticePending
          ? 1_000
          : Math.max(1_000, task.startNoticeRetryAt - Date.now());
        this.schedule(task, retryDelay);
        return;
      }
    }
    if (task.sending) return;

    const intervalMs = settings.petPerception.longTaskReplyIntervalSeconds * 1000;
    const reference = task.lastSentAt || task.startedAt;
    const elapsedSinceReference = Date.now() - reference;
    const fingerprint = progressFingerprint(task.status, task.detail);
    const phaseChanged = fingerprint !== task.lastSentFingerprint;
    const firstReport = task.lastSentAt === 0;
    const dueDelayMs = firstReport
      ? intervalMs
      : phaseChanged && mode === "detail"
        ? Math.min(PHASE_UPDATE_MIN_GAP_MS, intervalMs)
        : mode === "timed"
          ? intervalMs
          : this.unchangedReportDelay(task, intervalMs);
    if (elapsedSinceReference < dueDelayMs) {
      this.schedule(task, dueDelayMs - elapsedSinceReference);
      return;
    }

    const text = renderTemplate(settings.petPerception.longTaskReplyTemplate, task);
    if (!text) {
      this.stop(key);
      return;
    }
    task.sending = true;
    try {
      const delivered = await this.options.send(task.target, {
        conversationId: task.target.conversationId,
        conversationType: task.target.conversationType,
        replyToMessageId: task.target.messageId,
        contextToken: task.target.contextToken,
        text,
      });
      task.lastSentAt = Date.now();
      if (delivered) {
        task.lastSentFingerprint = fingerprint;
        task.unchangedBackoffLevel = phaseChanged
          ? 0
          : Math.min(task.unchangedBackoffLevel + 1, MAX_UNCHANGED_BACKOFF_LEVEL);
        console.info(`[LongTaskReply] delivered ${task.kind} ${task.target.platform} phase=${task.phase} reason=${phaseChanged ? "phase-change" : "backoff-heartbeat"} backoff=${task.unchangedBackoffLevel}`);
        this.options.publish({
          type: "reply",
          channelId: task.target.channelId,
          platform: task.target.platform,
          conversationId: task.target.conversationId,
          messageId: task.target.messageId,
          text,
          delivered: true,
        });
      } else {
        console.warn(`[LongTaskReply] delivery failed ${task.kind} ${task.target.platform} phase=${task.phase}`);
      }
    } catch (error) {
      task.lastSentAt = Date.now();
      console.warn("Unable to send long-task progress reply.", error);
    } finally {
      task.sending = false;
      if (this.active.get(key) === task) {
        const currentFingerprint = progressFingerprint(task.status, task.detail);
        const mode = notificationModeForTask(task, settings);
        const delay = currentFingerprint !== task.lastSentFingerprint && mode === "detail"
          ? this.nextPhaseUpdateDelay(task, intervalMs)
          : mode === "timed"
            ? intervalMs
            : this.unchangedReportDelay(task, intervalMs);
        this.schedule(task, delay);
      }
    }
  }

  private stop(key: string): void {
    const task = this.active.get(key);
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    this.active.delete(key);
  }
}
