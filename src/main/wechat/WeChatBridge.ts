import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultAgentConfigs, resolveActiveAgentId } from "../../agents/types";
import type { AgentConfig } from "../../agents/types";
import { stripControllerRoutingPrefix, type AgentDelegationCompletion, type AgentDelegationFollowUpResult, type AgentDelegationPreview } from "../agents/AgentDelegationService";
import type { ChatHistorySummary } from "../../settings/types";
import { defaultZeroTokenSettings } from "../../settings/types";
import type { AgentProvider, PetSettings } from "../../settings/types";
import type { PetState } from "../../pet/PetStateMachine";
import { loadConfig, type WeChatConfig } from "./config";
import {
  extractText,
  getUpdates,
  loadSession,
  sendImageMessage,
  sendTextMessage,
  type WeChatMessage,
  type WeChatSession,
} from "./iLinkClient";
import { ChatHistoryStore, isLiveStateQuery, type RecentChatMessage } from "./chatHistory";
import { credentialId, WeChatCredentialStore } from "./credentialStore";
import { WeChatEventLog } from "./eventLog";
import { loginWithQr } from "./qrLogin";
import { extractMediaDirective, generateReply, shutdownAgents } from "./replyGenerator";
import type { ChannelSendResult, OutboundMediaMessage, OutboundMessage } from "../channels/types";
import { normalizeSafeText } from "../agents/orchestrationTypes";
import { prefixWorkspaceReply } from "../agents/workspaceReply";
import { captureDesktopScreenshot } from "../media/DesktopCaptureService";
import type { AgentWindowSnapshot } from "../media/AgentWindowTracker";
import { elapsedSecondsBetween, formatAgentEventNotification } from "../pet/taskNotificationFormatter";
import {
  inferAction,
  summarize,
  type AgentStatus,
  type WeChatConnectionState,
  type WeChatEvent,
  type WeChatEventListener,
  type WeChatStatus,
} from "./events";

const INITIAL_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 5;
const QR_CONNECTION_TIMEOUT_MS = 60_000;
/** 导入/切换会话时等待首个轮询确认连接的窗口上限。 */
const IMPORT_SESSION_CONNECTION_TIMEOUT_MS = 60_000;
/** 带稳定 wire id 的入站消息去重窗口：服务端重投按 id 幂等吸收。 */
const INBOUND_MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
/** 无 wire id 的兜底去重窗口：只覆盖服务端短窗重投，避免吞掉正常重复消息。 */
const INBOUND_MESSAGE_FALLBACK_DEDUPE_TTL_MS = 30_000;
const MAX_PROCESSED_INBOUND_MESSAGES = 2048;
type WeChatRuntimeSettings = Pick<PetSettings, "agentProvider" | "activeAgentId" | "agentConfigs" | "wechatTokenFile" | "wechatEnabled" | "wechatAllowedUserIds" | "agentPermissionPolicy" | "saveChatHistory" | "codexSandboxMode" | "petName" | "userName" | "screenCaptureDisplayId" | "zeroToken"> & {
  agentConfigFor?: () => AgentConfig;
  captureDisplayForAgent?: (agent: AgentConfig) => Promise<AgentWindowSnapshot | null>;
  memoryContextFor?: (userId: string, query?: string) => string;
  rememberExplicit?: (userId: string, text: string) => { ok: boolean; detail: string; entry?: { content: string }; entries?: Array<{ content: string }> } | null;
  forgetExplicit?: (userId: string, text: string) => { ok: boolean; detail: string } | null;
  observeMemory?: (userId: string, userMessage: string, assistantMessage: string, agentConfig: AgentConfig, messageId?: string) => void;
};

export interface WeChatDelegationHandler {
  preview: (message: string) => AgentDelegationPreview | null;
  listIfRequested?: (message: string) => string | null;
  followUp?: (parentConversationId: string, message: string) => AgentDelegationFollowUpResult;
  start: (
    preview: AgentDelegationPreview,
    parentConversationId: string,
    onCompletion: (completion: AgentDelegationCompletion) => Promise<void> | void,
  ) => { ok: boolean; detail: string };
}

function requiresWeChatContextRefresh(message: string): boolean {
  return /(?:ret|errcode|retcode)=-(?:2|14)\b/i.test(message)
    || /(?:context|session).*(?:expired|timeout|invalid|stale)/i.test(message);
}

function agentDisplayName(provider: PetSettings["agentProvider"]): string {
  // 不把 Codex 的具体通道（app-server/CLI）当成必然事实：只有已知切换或实际路径时才单独说明通道。
  if (provider === "codex") return "Codex 主 Agent";
  if (provider === "hermes") return "Hermes CLI";
  if (provider === "custom") return "自定义 Agent";
  return "Claude Code";
}

function activeAgentConfig(settings: WeChatRuntimeSettings): AgentConfig {
  if (settings.agentConfigFor) return settings.agentConfigFor();
  const activeId = resolveActiveAgentId(settings.activeAgentId, settings.agentConfigs, settings.agentProvider);
  return settings.agentConfigs.find((config) => config.id === activeId) ?? defaultAgentConfigs()[0];
}

function isDesktopScreenshotRequest(text: string): boolean {
  return /(桌面|屏幕)/.test(text) && /(截图|截屏)/.test(text);
}

export class WeChatBridge {
  private config: WeChatConfig;
  private session: WeChatSession | null = null;
  private polling = false;
  private pollPromise: Promise<void> | null = null;
  private getUpdatesBuf = "";
  private readonly listeners = new Set<WeChatEventListener>();
  private readonly history: ChatHistoryStore;
  private readonly credentials: WeChatCredentialStore;
  private readonly eventLog: WeChatEventLog;
  private paused = false;
  private lastFrom = "";
  private lastContextToken = "";
  private readonly contextTokensByUser = new Map<string, string>();
  /** sendmessage 拒绝旧上下文后，等待该用户新的入站消息刷新 token。 */
  private readonly staleContextUsers = new Set<string>();
  /** 单一登录用户的上下文失效后，无上下文发送仅尝试一次，避免重复触发服务端限流。 */
  private readonly contextlessFallbackUsers = new Set<string>();
  private lastAction: PetState | null = null;
  private connectionState: WeChatConnectionState = "disconnected";
  private lastError = "";
  private retryCount = 0;
  private nextRetryAt: number | null = null;
  private lastConnectionKey: string | null = null;
  private qrLoginController: AbortController | null = null;
  private qrLoginPromise: Promise<void> | null = null;
  private qrLoginAccount: { tokenFile: string; accountId: string } | null = null;
  private qrLoginSnapshot: Extract<WeChatEvent, { type: "qr-login" }> | null = null;
  private readonly processedInboundMessageIds = new Map<string, { at: number; ttlMs: number }>();
  private pendingReplyCount = 0;
  /** 会话代际：切换/登出/重连时递增，旧代际的在途发送一律丢弃。 */
  private sessionEpoch = 0;
  /** 同一活动会话内所有对外发送的串行队列（回执/回复/委派/通知共用）。 */
  private sendChain: Promise<void> = Promise.resolve();
  /** 导入/切换/重连等生命周期操作必须串行，避免两个操作互相覆盖会话。 */
  private sessionTransition: Promise<void> = Promise.resolve();
  private pollController: AbortController | null = null;

  constructor(
    private readonly getRuntimeSettings: () => WeChatRuntimeSettings = () => ({
      agentProvider: "claude",
      activeAgentId: "claude",
      agentConfigs: defaultAgentConfigs(),
      wechatTokenFile: "",
      wechatEnabled: true,
      wechatAllowedUserIds: [],
      agentPermissionPolicy: "allow-tools",
      petName: "企鹅",
      userName: "主人",
      saveChatHistory: true,
      codexSandboxMode: "read-only",
      screenCaptureDisplayId: "",
      zeroToken: defaultZeroTokenSettings(),
    }),
    historyFile = join(homedir(), ".cc-weixin", "penguin-chat-history.json"),
    credentialsFile = join(homedir(), ".cc-weixin", "penguin-credentials.json"),
    eventLogFile = join(homedir(), ".cc-weixin", "penguin-events.jsonl"),
    private readonly delegationHandler?: WeChatDelegationHandler,
  ) {
    const runtimeSettings = this.getRuntimeSettings();
    this.config = loadConfig(runtimeSettings.wechatTokenFile, runtimeSettings.wechatEnabled);
    this.history = new ChatHistoryStore(historyFile, this.getRuntimeSettings().saveChatHistory);
    this.credentials = new WeChatCredentialStore(credentialsFile);
    this.eventLog = new WeChatEventLog(eventLogFile);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get hasPendingReplies(): boolean {
    return this.pendingReplyCount > 0;
  }

  get status(): WeChatStatus {
    const accountId = this.session?.accountId || undefined;
    let detail: string;
    switch (this.connectionState) {
      case "connecting":
        detail = accountId
          ? `历史会话已恢复，正在连接微信 Bot（Bot: ${accountId}）…`
          : "正在连接微信 Bot…";
        break;
      case "connected":
        detail = `已连接（Bot: ${accountId || "微信"}）`;
        break;
      case "paused":
        detail = "已暂停接收消息";
        break;
      case "reconnecting":
        detail = this.nextRetryAt
          ? `连接异常，将在 ${new Date(this.nextRetryAt).toLocaleTimeString()} 自动重试`
          : "连接异常，准备重试";
        break;
      case "failed":
        detail = this.nextRetryAt
          ? `连接失败，将在 ${new Date(this.nextRetryAt).toLocaleTimeString()} 再试`
          : "连接失败，可点击重新连接";
        break;
      case "logged-out":
        detail = "可重新扫码或导入";
        break;
      default:
        detail = "可点击“微信扫码添加 Bot”开始连接";
        break;
    }

    if (this.connectionState === "connected" && this.staleContextUsers.size > 0) {
      detail = "\u5df2\u8fde\u63a5\uff0c\u4f46\u5386\u53f2\u4f1a\u8bdd\u4e0a\u4e0b\u6587\u5df2\u5931\u6548\uff1b\u4e3b\u52a8\u901a\u77e5\u4f1a\u7ee7\u7eed\u5c1d\u8bd5\u53d1\u9001";
    }

    return {
      state: this.connectionState,
      connected: this.connectionState === "connected",
      detail,
      lastError: this.lastError,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt,
      accountId,
    };
  }

  subscribe(listener: WeChatEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.polling) return;

    if (!this.config.enabled) {
      this.setConnectionState(this.connectionState === "logged-out" ? "logged-out" : "disconnected");
      return;
    }

    this.paused = false;
    this.lastError = "";
    this.retryCount = 0;
    this.nextRetryAt = null;
    // 保留显式恢复的会话对象；首次启动、切换会话和重连时 session 为空，
    // 才从凭据存储加载，避免导入失败回滚时又误读新账号。
    this.session = this.session ?? this.loadStoredSession();
    if (!this.session) {
      this.setConnectionState("disconnected");
      return;
    }
    // 只有历史会话实际恢复后才发布 connecting，避免启动时先短暂显示一个
    // 没有账号身份的“连接中”，让用户误以为会话没有被自动加载。
    this.setConnectionState("connecting");
    this.markSessionChanged();

    // The old cc-weixin daemon polls the same Bot session. Stop it before the
    // app takes ownership, otherwise both processes may consume/reply to messages.
    this.stopExternalDaemon();
    this.polling = true;
    this.pollPromise = this.pollUpdates();
    await Promise.resolve();
  }

  async pause(): Promise<void> {
    if (!this.session && !this.polling) return;
    this.paused = true;
    await this.stopPolling();
    this.setConnectionState("paused");
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.start();
  }

  async reconnect(): Promise<{ ok: boolean; detail: string }> {
    return this.enqueueSessionTransition(() => this.reconnectInternal());
  }

  private async reconnectInternal(): Promise<{ ok: boolean; detail: string }> {
    if (this.qrLoginPromise) return { ok: false, detail: "二维码登录进行中，请先完成或取消扫码" };
    this.paused = false;
    await this.stopPolling();
    this.session = null;
    this.markSessionChanged();
    this.getUpdatesBuf = "";
    this.config = loadConfig(this.config.tokenFile, true);
    await this.start();
    if (!this.status.connected) {
      try {
        await this.waitForConnected(null, IMPORT_SESSION_CONNECTION_TIMEOUT_MS, true);
      } catch (error) {
        await this.stop();
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    return this.status.connected
      ? { ok: true, detail: this.status.detail }
      : { ok: false, detail: this.status.detail };
  }

  async importSession(tokenFile: string): Promise<{ ok: boolean; detail: string }> {
    return this.enqueueSessionTransition(() => this.importSessionInternal(tokenFile));
  }

  private async importSessionInternal(tokenFile: string): Promise<{ ok: boolean; detail: string }> {
    const nextConfig = loadConfig(tokenFile, true);
    const importedSession = loadSession(nextConfig.tokenFile);
    if (!importedSession) {
      return { ok: false, detail: "会话文件无效：未找到 token 或 baseUrl" };
    }

    const previousConfig = this.config;
    const previousSession = this.session;
    const previousUpdatesBuf = this.getUpdatesBuf;
    const previousPolling = this.polling;
    const previousPaused = this.paused;

    const restorePreviousSession = async (detail: string): Promise<{ ok: boolean; detail: string }> => {
      await this.stop();
      this.config = previousConfig;
      this.session = previousSession;
      this.getUpdatesBuf = previousUpdatesBuf;
      this.markSessionChanged();
      this.paused = previousPaused;
      if (previousPolling && previousSession && previousConfig.enabled) {
        await this.start();
      } else if (previousPaused) {
        this.setConnectionState("paused");
      } else {
        this.setConnectionState("disconnected");
      }
      return { ok: false, detail };
    };

    await this.stop();
    const storedInCredentialManager = this.credentials.save(tokenFile, importedSession);
    this.config = nextConfig;
    this.session = null;
    this.getUpdatesBuf = "";
    this.markSessionChanged();
    await this.start();
    if (!this.status.connected) {
      // 轮询已开始但首轮尚未确认连接：等待首轮结果（有界超时；首个轮询
      // 错误即视为激活失败），成功前不认为会话已切换。
      try {
        await this.waitForConnected(null, IMPORT_SESSION_CONNECTION_TIMEOUT_MS, true);
      } catch (error) {
        return restorePreviousSession(error instanceof Error ? error.message : String(error));
      }
    }
    if (!this.status.connected) return restorePreviousSession(this.status.detail);
    return {
      ok: true,
      detail: `${this.status.detail}${storedInCredentialManager ? "（系统凭据已加密保存）" : "（系统凭据不可用，继续使用会话文件）"}`,
    };
  }

  async beginQrLogin(): Promise<{ ok: boolean; detail: string }> {
    if (this.qrLoginPromise) return { ok: false, detail: "二维码登录已经在进行中" };

    const controller = new AbortController();
    this.qrLoginController = controller;
    this.qrLoginAccount = null;
    this.emit({ type: "qr-login", status: "requesting", detail: "正在申请微信登录二维码" });

    const loginPromise = loginWithQr(
      (progress) => this.emit({ type: "qr-login", ...progress }),
      controller.signal,
    )
      .then(async (session) => {
        const tokenFile = this.qrSessionFile(session.accountId || session.userId);
        if (!this.credentials.save(tokenFile, session)) {
          throw new Error("系统加密凭据不可用，二维码登录未保存");
        }

        this.emit({
          type: "qr-login",
          status: "connecting",
          detail: "授权成功，正在连接微信机器人",
          accountId: session.accountId || session.userId || undefined,
        });
        await this.stop();
        this.config = loadConfig(tokenFile, true);
        this.session = null;
        await this.start();
        try {
          await this.waitForConnected(controller.signal);
        } catch (error) {
          await this.stop();
          throw error;
        }

        const accountId = session.accountId || session.userId || "微信 Bot";
        this.qrLoginAccount = { tokenFile, accountId };
        this.emit({
          type: "qr-login",
          status: "confirmed",
          detail: `微信 Bot 已登录（${accountId}）`,
          accountId,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          this.emit({ type: "qr-login", status: "cancelled", detail: "二维码登录已取消" });
          return;
        }
        this.emit({
          type: "qr-login",
          status: "error",
          detail: `二维码登录失败：${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        if (this.qrLoginController === controller) this.qrLoginController = null;
        if (this.qrLoginPromise === loginPromise) this.qrLoginPromise = null;
      });

    this.qrLoginPromise = loginPromise;
    return { ok: true, detail: "正在申请二维码" };
  }

  async cancelQrLogin(): Promise<{ ok: boolean; detail: string }> {
    if (!this.qrLoginController) return { ok: false, detail: "当前没有进行中的二维码登录" };
    this.qrLoginController.abort();
    return { ok: true, detail: "正在取消二维码登录" };
  }

  getQrLoginStatus(): Extract<WeChatEvent, { type: "qr-login" }> | null {
    if (!this.qrLoginSnapshot) return null;
    return ["requesting", "waiting", "scanned", "connecting"].includes(this.qrLoginSnapshot.status)
      ? this.qrLoginSnapshot
      : null;
  }

  consumeQrLoginAccount(): { tokenFile: string; accountId: string } | null {
    const account = this.qrLoginAccount;
    this.qrLoginAccount = null;
    return account;
  }

  async switchSession(tokenFile: string): Promise<{ ok: boolean; detail: string }> {
    return this.importSession(tokenFile);
  }

  async logout(): Promise<{ ok: boolean; detail: string }> {
    return this.enqueueSessionTransition(() => this.logoutInternal());
  }

  private async logoutInternal(): Promise<{ ok: boolean; detail: string }> {
    this.qrLoginController?.abort();
    await this.stop();
    this.session = null;
    this.markSessionChanged();
    this.getUpdatesBuf = "";
    this.credentials.remove(this.config.tokenFile);
    this.config = { ...this.config, enabled: false };
    this.setConnectionState("logged-out");
    return { ok: true, detail: "可重新扫码或导入" };
  }

  async stop(): Promise<void> {
    this.paused = false;
    await this.stopPolling();
    if (this.connectionState !== "logged-out") this.setConnectionState("disconnected");
  }

  private async stopPolling(): Promise<void> {
    // 停止也会使在途回复失效；暂停、登出和切换都必须阻止旧代际继续发送。
    this.markSessionChanged();
    this.polling = false;
    this.pollController?.abort();
    this.pollController = null;
    await this.pollPromise;
    this.pollPromise = null;
    await shutdownAgents();
  }

  private waitForConnected(
    signal: AbortSignal | null,
    timeoutMs = QR_CONNECTION_TIMEOUT_MS,
    failOnFirstError = false,
  ): Promise<void> {
    if (this.status.connected) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      let settled = false;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        unsubscribe();
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error("二维码登录已取消"));
      unsubscribe = this.subscribe((event) => {
        if (event.type !== "connection") return;
        if (event.connected) {
          finish();
          return;
        }
        if (event.state === "failed" || (failOnFirstError && event.state === "reconnecting")) {
          finish(new Error(event.lastError || event.detail));
        }
      });

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        finish(new Error(this.status.lastError || `微信 Bot 连接超时（${timeoutMs / 1000} 秒）`));
      }, timeoutMs);

      if (signal?.aborted) {
        onAbort();
      } else if (this.status.connected) {
        finish();
      }
    });
  }

  private loadStoredSession(): WeChatSession | null {
    const stored = this.credentials.load(this.config.tokenFile);
    if (stored) return stored;

    const session = loadSession(this.config.tokenFile);
    if (session) this.credentials.save(this.config.tokenFile, session);
    return session;
  }

  private qrSessionFile(accountId: string): string {
    const identity = accountId.trim() || "anonymous";
    return join(homedir(), ".cc-weixin", "penguin-qr", `${credentialId(`qr:${identity}`)}.json`);
  }

  /** 当前会话的账号身份：accountId 优先，兼容旧会话文件回退到 userId；未连接时为空。 */
  get accountIdentity(): string {
    return this.session ? (this.session.accountId || this.session.userId) : "";
  }

  /** 当前激活会话的 token 文件（配置账号 id 即其 hash），供通知目标按真实账号归属。 */
  get activeTokenFile(): string {
    return this.config.tokenFile;
  }

  /** 二维码授权时返回的微信用户，是单 Bot 模式下的默认收件人。 */
  get defaultConversationId(): string {
    return this.session?.userId?.trim() ?? "";
  }

  private markSessionChanged(): void {
    this.sessionEpoch += 1;
    this.lastFrom = "";
    this.lastContextToken = "";
    this.contextTokensByUser.clear();
    this.staleContextUsers.clear();
    this.contextlessFallbackUsers.clear();
  }

  /**
   * 串行执行一次对外发送。所有微信出站（回执/回复/委派/通知/媒体）走同一条链，
   * 保证同一活动会话内不并发、不乱序；任务执行时若会话代际已变则直接丢弃。
   */
  private enqueueSend<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.sendChain;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    this.sendChain = previous.catch(() => undefined).then(() => hold);
    return previous.catch(() => undefined).then(task).finally(release);
  }

  private enqueueSessionTransition<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.sessionTransition;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    this.sessionTransition = previous.catch(() => undefined).then(() => hold);
    return previous.catch(() => undefined).then(task).finally(release);
  }

  async sendReply(text: string): Promise<boolean> {
    if (!this.lastFrom) return this.sendReplyTo("", text, this.lastContextToken);
    return this.sendReplyTo(this.lastFrom, text, this.lastContextToken);
  }

  async sendMedia(
    message: OutboundMediaMessage,
    epoch = this.sessionEpoch,
    session = this.session,
  ): Promise<ChannelSendResult> {
    const target = message.conversationId || this.lastFrom || this.defaultConversationId;
    if (!target) return { ok: false, detail: "微信尚未建立可回复的会话，请先向机器人发送一条消息", retryable: false };
    if (!session || !this.status.connected) return { ok: false, detail: "微信机器人尚未连接，媒体暂未发送", retryable: true };
    if (message.media.kind !== "image") {
      return { ok: false, detail: "微信当前 iLink Bot 实现仅打通图片媒体发送；文件发送在现有协议实现中不可用。请改用支持文件发送的 QQ 或飞书通道。", retryable: false };
    }
    return this.enqueueSend(async () => {
      if (epoch !== this.sessionEpoch || this.session !== session) {
        return { ok: false, detail: "微信会话已切换或断开，图片未发送", retryable: true };
      }
      try {
        await sendImageMessage(this.config, session, target, message.media.source, message.contextToken, message.media.caption);
        return { ok: true, detail: "微信图片已发送" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.emit({ type: "error", message: `微信媒体发送失败：${detail}`, category: "delivery" });
        return { ok: false, detail, retryable: true };
      }
    });
  }

  async sendReplyTo(
    to: string,
    text: string,
    contextToken = "",
    expectedAccountId = "",
    historyProvider?: AgentProvider,
  ): Promise<boolean> {
    const target = to.trim() || this.defaultConversationId;
    if (!target) {
      this.emit({ type: "error", message: "还没有建立机器人对话，请先向机器人发送一条消息", category: "target" });
      return false;
    }
    if (!this.config.enabled || !this.session || !this.status.connected) {
      this.emit({ type: "error", message: "微信机器人尚未连接，正在等待可用会话", category: "connection" });
      return false;
    }
    // 目标会话若绑定在另一微信账号下，拒绝发送：不静默换账号、不跨账号复用
    // 旧 context token。需新账号收到新入站消息后重新建立目标。
    if (expectedAccountId && this.accountIdentity && expectedAccountId !== this.accountIdentity) {
      console.warn("[WeChatBridge] reply target belongs to another WeChat account; delivery refused (send a new message to re-establish)");
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) return false;
    // 历史 token 失效后仍允许主动通知继续走无 context_token 的发送路径。
    // 新入站消息会刷新 token，但主动通知不应被强制绑定到用户再次发消息。
    const resolvedContextToken = this.staleContextUsers.has(target)
      ? ""
      : contextToken || this.contextTokensByUser.get(target) || (target === this.lastFrom ? this.lastContextToken : "");

    // 捕获发起时的会话代际：排队期间发生切换/登出/重连则丢弃，不借新会话发送。
    const epoch = this.sessionEpoch;
    const session = this.session;
    return this.enqueueSend(async () => {
      if (epoch !== this.sessionEpoch || this.session !== session) return false;
      try {
        await sendTextMessage(this.config, session, target, trimmed, resolvedContextToken);
        this.recordAssistantMessage(target, trimmed, historyProvider);
        this.emit({ type: "reply", to: target, text: trimmed });
        return true;
      } catch (err) {
        const message = (err as Error).message;
        if (requiresWeChatContextRefresh(message)) {
          this.contextTokensByUser.delete(target);
          if (target === this.lastFrom) this.lastContextToken = "";

          // The official client omits context_token when it is unavailable.
          // Retry once without the expired token for the current/default
          // conversation (including the last inbound conversation), while
          // still refusing arbitrary historical targets.
          const isKnownCurrentConversation = target === session.userId.trim()
            || target === this.lastFrom
            || this.contextTokensByUser.has(target);
          const canUseContextlessFallback = isKnownCurrentConversation
            && !this.contextlessFallbackUsers.has(target);
          if (canUseContextlessFallback) {
            this.contextlessFallbackUsers.add(target);
            try {
              await sendTextMessage(this.config, session, target, trimmed);
              this.staleContextUsers.delete(target);
              this.emitConnectionIfChanged(true);
              this.recordAssistantMessage(target, trimmed, historyProvider);
              this.emit({ type: "reply", to: target, text: trimmed });
              return true;
            } catch (fallbackError) {
              console.warn("[WeChatBridge] contextless WeChat fallback rejected:", fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
            }
          }

          const firstFailure = !this.staleContextUsers.has(target);
          this.staleContextUsers.add(target);
          this.emitConnectionIfChanged(true);
          if (firstFailure) {
            const detail = "微信通道已连接，但历史会话上下文已失效；通知已保留并会自动重试";
            console.warn(`[WeChatBridge] ${detail}`);
            this.emit({ type: "error", message: `发送失败：${detail}`, category: "target" });
          }
          return false;
        }
        console.warn("[WeChatBridge] reply send rejected:", message);
        this.emit({ type: "error", message: `发送失败：${message}`, category: "delivery" });
        return false;
      }
    });
  }

  get lastInferredAction(): PetState | null {
    return this.lastAction;
  }

  private async pollUpdates(): Promise<void> {
    while (this.polling && this.session) {
      // 捕获本轮会话快照：轮询期间切换会话时，旧会话的响应不得推进游标或标记连接。
      const session = this.session;
      const controller = new AbortController();
      this.pollController = controller;
      try {
        const response = await getUpdates(this.config, session, this.getUpdatesBuf, controller.signal);
        if (!this.polling || this.session !== session) break;
        // HTTP 200 的业务失败不能视为已连接：ret 非 0 时按连接异常重试。
        if (typeof response.ret === "number" && response.ret !== 0) {
          throw new Error(`微信 getupdates 业务失败（ret=${response.ret}）`);
        }
        this.retryCount = 0;
        this.nextRetryAt = null;
        this.setConnectionState("connected");
        for (const message of response.msgs ?? []) {
          await this.handleMessage(message);
        }
        // 整批处理完成后再推进游标：中途异常时服务端会重新下发同一批，
        // 已处理的消息由入站去重表吸收，既不丢消息也不重复回复。
        if (response.get_updates_buf !== undefined) {
          this.getUpdatesBuf = response.get_updates_buf;
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        this.retryCount += 1;
        const retryDelay = Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, this.retryCount - 1),
          MAX_RETRY_DELAY_MS,
        );
        this.nextRetryAt = Date.now() + retryDelay;
        this.setConnectionState(this.retryCount >= MAX_RETRY_ATTEMPTS ? "failed" : "reconnecting");
        this.emit({ type: "error", message: `微信连接异常（第 ${this.retryCount} 次）：${message}`, category: "connection" });
        await this.waitForRetry(retryDelay);
        this.nextRetryAt = null;
        if (this.polling && !this.paused) this.setConnectionState("connecting");
      } finally {
        if (this.pollController === controller) this.pollController = null;
      }
    }
    if (this.paused) this.setConnectionState("paused");
    else if (this.connectionState !== "logged-out") this.setConnectionState("disconnected");
  }

  private async handleMessage(message: WeChatMessage): Promise<void> {
    if (message.message_type !== undefined && message.message_type !== 1) return;

    const from = message.from_user_id ?? "";
    const text = extractText(message);
    if (!from || !text) return;

    const { key: messageId, wireId } = this.buildInboundMessageKey(message, from, text);
    if (!this.rememberInboundMessage(messageId, wireId ? INBOUND_MESSAGE_DEDUPE_TTL_MS : INBOUND_MESSAGE_FALLBACK_DEDUPE_TTL_MS)) return;
    if (!this.session) return;
    console.info(`[Memory] message received messageId=${messageId.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96) || "unknown"} source=wechat`);

    // 捕获本条入站所属的会话代际：切换/登出/重连后，旧代际的回执、回复与
    // 委派完成通知一律丢弃，绝不借新会话发送旧账号的内容。
    const messageEpoch = this.sessionEpoch;
    const messageSession = this.session;

    const runtimeSettings = this.getRuntimeSettings();
    const allowedUserIds = runtimeSettings.wechatAllowedUserIds;
    if (allowedUserIds.length > 0 && !allowedUserIds.includes(from)) {
      this.emit({ type: "blocked", from });
      return;
    }

    this.lastFrom = from;
    this.lastContextToken = message.context_token ?? "";
    this.contextTokensByUser.set(from, this.lastContextToken);
    this.staleContextUsers.delete(from);
    this.contextlessFallbackUsers.delete(from);
    this.emitConnectionIfChanged(true);
    this.lastAction = inferAction(text);
    const memoryCapture = runtimeSettings.rememberExplicit?.(from, text) ?? null;
    const forgetCapture = runtimeSettings.forgetExplicit?.(from, text) ?? null;
    const conversationContext = this.getConversationContext(from, text);
    const activeAgent = activeAgentConfig(runtimeSettings);
    const formatReply = (value: string): string => prefixWorkspaceReply(value, activeAgent, this.config.agentWorkspace);
    this.recordUserMessage(from, text);
    this.emit({
      type: "message",
      id: messageId,
      from,
      text,
      action: this.lastAction,
      contextToken: this.lastContextToken,
      accountId: this.accountIdentity || undefined,
    });

    const agentListText = memoryCapture || forgetCapture ? null : this.delegationHandler?.listIfRequested?.(text) ?? null;
    const delegationPreview = memoryCapture || forgetCapture || agentListText ? null : this.delegationHandler?.preview(text) ?? null;
    const delegationResult = delegationPreview
      ? this.delegationHandler?.start(
        delegationPreview,
        this.agentContextKey(from),
        (completion) => this.sendDelegationCompletion(
          from,
          this.contextTokensByUser.get(from) ?? this.lastContextToken,
          completion,
          messageEpoch,
          messageSession,
        ),
      ) ?? { ok: false, detail: "委派服务尚未启动" }
      : null;
    const followUp = memoryCapture || forgetCapture || agentListText || delegationPreview
      ? null
      : this.delegationHandler?.followUp?.(this.agentContextKey(from), text) ?? null;
    const acknowledgement = formatReply(memoryCapture
      ? memoryCapture.ok
        ? `已记住：${(memoryCapture.entries ?? (memoryCapture.entry ? [memoryCapture.entry] : [])).map((entry) => entry.content).join("\n") || "这条信息"}`
        : `这条记忆没有保存：${memoryCapture.detail}`
      : forgetCapture
      ? forgetCapture.ok
        ? "已删除匹配的长期记忆。"
        : `没有删除记忆：${forgetCapture.detail}`
      : agentListText
      ? agentListText
      : followUp?.handled
      ? followUp.ok
        ? followUp.detail
        : `这次补充信息没有发送：${followUp.detail}`
      : delegationResult
      ? delegationResult.ok
        ? `已收到委派请求。${delegationResult.detail}；我会继续盯着目标 Agent 的真实进度。`
        : `这次委派还没有开始：${delegationResult.detail}`
      : `${runtimeSettings.petName}收到啦，先给${runtimeSettings.userName}报个到～我马上继续处理喵！`);
    try {
      const ackDelivered = await this.enqueueSend(async () => {
        if (messageEpoch !== this.sessionEpoch || this.session !== messageSession) return false;
        await sendTextMessage(this.config, messageSession, from, acknowledgement, this.lastContextToken);
        return true;
      });
      if (ackDelivered) this.emit({ type: "reply", to: from, text: acknowledgement });
    } catch (error) {
      this.emit({ type: "error", message: `即时回执发送失败：${(error as Error).message}`, category: "delivery" });
    }

    if (memoryCapture || forgetCapture || agentListText || delegationPreview || followUp?.handled) return;

    const provider = activeAgent.provider;
    this.emit({
      type: "agent-status",
      status: "starting",
      detail: `${agentDisplayName(provider)} 正在启动……`,
      from,
      messageId,
    });
    this.pendingReplyCount += 1;
    void this.replyTo(from, stripControllerRoutingPrefix(text), this.lastContextToken, conversationContext, messageId, messageEpoch, messageSession).finally(() => {
      this.pendingReplyCount = Math.max(0, this.pendingReplyCount - 1);
    });
  }

  /**
   * 入站消息去重键：优先使用服务端 wire id（msg_id/message_id/client_id），
   * 这样正常的重复内容不会被吞；没有 wire id 时退化为内容摘要键，
   * 且只给予短去重窗口（仅覆盖服务端同窗重投）。
   */
  private buildInboundMessageKey(message: WeChatMessage, from: string, text: string): { key: string; wireId: string | null } {
    const wireId = (message.msg_id ?? message.message_id ?? message.client_id ?? "").trim();
    if (wireId) return { key: `wechat:${from}:${wireId}`, wireId };
    const contextToken = message.context_token ?? "";
    const timeBucket = contextToken ? "" : String(Math.floor(Date.now() / 30_000));
    const source = [from, contextToken, text, timeBucket].join("\u0000");
    return {
      key: `wechat:${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 24)}`,
      wireId: null,
    };
  }

  private rememberInboundMessage(key: string, ttlMs: number): boolean {
    const now = Date.now();
    for (const [id, entry] of this.processedInboundMessageIds) {
      if (now - entry.at >= entry.ttlMs) this.processedInboundMessageIds.delete(id);
    }
    if (this.processedInboundMessageIds.has(key)) return false;
    this.processedInboundMessageIds.set(key, { at: now, ttlMs });
    while (this.processedInboundMessageIds.size > MAX_PROCESSED_INBOUND_MESSAGES) {
      const oldestId = this.processedInboundMessageIds.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.processedInboundMessageIds.delete(oldestId);
    }
    return true;
  }

  private async replyTo(
    from: string,
    incomingText: string,
    contextToken: string,
    conversationContext: string,
    messageId: string,
    messageEpoch: number,
    messageSession: WeChatSession,
  ): Promise<void> {
    const runtimeSettings = this.getRuntimeSettings();
    const activeAgent = activeAgentConfig(runtimeSettings);
    const provider = activeAgent.provider;
    const formatReply = (value: string): string => prefixWorkspaceReply(value, activeAgent, this.config.agentWorkspace);
    const sessionStale = (): boolean =>
      messageEpoch !== this.sessionEpoch || this.session !== messageSession;
    /** 串行发送一次并返回是否真正发出；会话代际已变则丢弃（false）。 */
    const deliver = (task: () => Promise<unknown>): Promise<boolean> =>
      this.enqueueSend(async () => {
        if (sessionStale()) return false;
        await task();
        return true;
      });
    const dropReport = (): void => {
      this.emitAgentStatus("failed", "微信会话已切换或断开，回复未发送", from, messageId);
    };
    try {
      if (isDesktopScreenshotRequest(incomingText) && runtimeSettings.agentPermissionPolicy === "allow-tools") {
        this.emitAgentStatus("tool", "正在截取当前桌面……", from, messageId);
        const screenshotAgent = runtimeSettings.agentConfigFor?.() ?? activeAgent;
        const agentSnapshot = runtimeSettings.captureDisplayForAgent
          ? await runtimeSettings.captureDisplayForAgent(screenshotAgent)
          : null;
        const screenshotPath = await captureDesktopScreenshot(runtimeSettings.screenCaptureDisplayId, agentSnapshot);
        try {
          this.emitAgentStatus("sending", "桌面截图已生成，正在发送到微信……", from, messageId);
          const screenshotCaption = formatReply("这是当前桌面截图～");
          const delivered = await deliver(() =>
            sendImageMessage(this.config, messageSession, from, screenshotPath, contextToken, screenshotCaption));
          if (!delivered) {
            dropReport();
            return;
          }
          this.recordAssistantMessage(from, `${screenshotCaption}\n[图片]`, provider);
          this.emitAgentStatus("completed", "桌面截图已发送", from, messageId);
          this.emit({ type: "reply", to: from, text: screenshotCaption });
          runtimeSettings.observeMemory?.(from, incomingText, screenshotCaption, activeAgent, messageId);
        } finally {
          await rm(screenshotPath, { force: true }).catch(() => {});
        }
        return;
      }

      const reply = await generateReply(
        this.config,
        incomingText,
        provider,
        conversationContext,
        runtimeSettings.codexSandboxMode,
        (status, detail) => this.emitAgentStatus(status, detail, from, messageId),
        this.agentContextKey(from),
        activeAgent,
        runtimeSettings.agentPermissionPolicy,
        "微信",
        runtimeSettings.petName,
        runtimeSettings.userName,
        runtimeSettings.zeroToken,
      );
      const mediaDirective = extractMediaDirective(reply);
      const displayText = formatReply((mediaDirective?.text ?? reply).trim());
      if (!displayText && !mediaDirective) throw new Error("Agent 没有返回可发送的文本或媒体");
      this.emitAgentStatus("sending", "回复已生成，正在发送到微信…", from, messageId);
      let textDelivered = true;
      if (displayText) {
        textDelivered = await deliver(() =>
          sendTextMessage(this.config, messageSession, from, displayText, contextToken));
      }
      if (!textDelivered) {
        dropReport();
        return;
      }
      if (mediaDirective) {
        const mediaResult = await this.sendMedia(
          {
            conversationId: from,
            media: { kind: mediaDirective.kind, source: mediaDirective.source, caption: "" },
            contextToken,
          },
          messageEpoch,
          messageSession,
        );
        if (!mediaResult.ok) throw new Error(mediaResult.detail);
      }
      const historyText = displayText || (mediaDirective?.kind === "file" ? "文件已发送" : "图片已发送");
      this.recordAssistantMessage(from, historyText, provider);
      this.emitAgentStatus("completed", "回复已发送", from, messageId);
      this.emit({ type: "reply", to: from, text: historyText });
      runtimeSettings.observeMemory?.(from, incomingText, historyText, activeAgent, messageId);
      return;
    } catch (err) {
      const errorText = formatReply(`回复失败（${agentDisplayName(provider)}）：${(err as Error).message}`);
      this.emitAgentStatus("failed", errorText, from, messageId);
      this.emit({ type: "error", message: errorText, category: "agent" });
      this.recordAssistantMessage(from, errorText, provider, "fallback");
      runtimeSettings.observeMemory?.(from, incomingText, errorText, activeAgent, messageId);
      await this.enqueueSend<void>(async () => {
        if (sessionStale()) return;
        await sendTextMessage(this.config, messageSession, from, errorText, contextToken).catch(() => {});
      });
    }
  }

  private async sendDelegationCompletion(
    from: string,
    contextToken: string,
    completion: AgentDelegationCompletion,
    messageEpoch: number,
    messageSession: WeChatSession,
  ): Promise<void> {
    const settings = this.getRuntimeSettings();
    const detail = normalizeSafeText(completion.result ?? completion.detail, 1200);
    const text = formatAgentEventNotification({
      status: completion.ok ? "completed" : "failed",
      sourceName: completion.task.agentId,
      title: completion.task.title || "委派任务",
      message: detail || (completion.ok ? "任务完成" : "任务失败"),
      workspaceLabel: completion.task.workspaceLabel,
      surface: completion.task.surface,
      elapsedSeconds: elapsedSecondsBetween(completion.task.startedAt, completion.task.completedAt),
    });
    try {
      const delivered = await this.enqueueSend(async () => {
        if (messageEpoch !== this.sessionEpoch || this.session !== messageSession) return false;
        await sendTextMessage(this.config, messageSession, from, text.slice(0, 1800), contextToken);
        return true;
      });
      if (!delivered) {
        console.warn("[WeChatBridge] delegation completion dropped: WeChat session changed before delivery");
        return;
      }
      this.recordAssistantMessage(from, text.slice(0, 1800), activeAgentConfig(settings).provider);
      this.emit({ type: "reply", to: from, text: text.slice(0, 1800) });
    } catch (error) {
      this.emit({ type: "error", message: `委派结果发送失败：${(error as Error).message}`, category: "delivery" });
    }
  }

  private emitAgentStatus(status: AgentStatus, detail: string, from: string, messageId: string): void {
    this.emit({ type: "agent-status", status, detail, from, messageId });
  }

  private stopExternalDaemon(): void {
    try {
      if (!existsSync(this.config.daemonPidFile)) return;
      const pid = Number.parseInt(readFileSync(this.config.daemonPidFile, "utf8").trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
      process.kill(pid, 0);

      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(pid);
      }
      unlinkSync(this.config.daemonPidFile);
    } catch {
      // A stale PID file or an already stopped daemon is harmless.
    }
  }

  private async waitForRetry(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.polling && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  private getConversationContext(userId: string, incomingText = ""): string {
    const runtimeSettings = this.getRuntimeSettings();
    if (isLiveStateQuery(incomingText)) return "";
    return [
      runtimeSettings.saveChatHistory ? this.history.contextFor(userId, runtimeSettings.petName, runtimeSettings.userName) : "",
      runtimeSettings.memoryContextFor?.(userId, incomingText) ?? "",
    ].filter(Boolean).join("\n\n");
  }

  private agentContextKey(userId: string): string {
    const accountKey = this.accountIdentity || this.config.tokenFile || "active-account";
    return `bot:wechat:${accountKey}:${userId}`;
  }

  private recordUserMessage(userId: string, text: string): void {
    if (!this.getRuntimeSettings().saveChatHistory) return;
    this.history.append(userId, { role: "user", text });
  }

  private recordAssistantMessage(userId: string, text: string, provider = this.getRuntimeSettings().agentProvider, source: "agent" | "fallback" = "agent"): void {
    if (!this.getRuntimeSettings().saveChatHistory) return;
    this.history.append(userId, { role: "assistant", text, provider, source });
  }

  clearChatHistory(): void {
    this.history.clear();
  }

  getChatHistorySummary(): ChatHistorySummary {
    return this.history.summary();
  }

  listRecentChatMessages(limit = 200): RecentChatMessage[] {
    return this.history.recentMessages(limit);
  }

  isCredentialStoreAvailable(): boolean {
    return this.credentials.available;
  }

  private setConnectionState(state: WeChatConnectionState): void {
    this.connectionState = state;
    this.emitConnectionIfChanged();
  }

  private emitConnectionIfChanged(force = false): void {
    const status = this.status;
    const key = JSON.stringify(status);
    if (!force && this.lastConnectionKey === key) return;
    this.lastConnectionKey = key;
    this.emit({ type: "connection", ...status });
  }

  private emit(event: WeChatEvent): void {
    if (event.type === "qr-login") {
      this.qrLoginSnapshot = ["requesting", "waiting", "scanned", "connecting"].includes(event.status)
        ? event
        : null;
    }
    this.eventLog.record(event);
    // 监听器属于主进程其它模块，单个监听器异常不能反向打断轮询批次；
    // 否则游标不会推进，而已记录的去重键会让重试看起来像“消息消失”。
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.warn("[WeChatBridge] event listener failed:", error instanceof Error ? error.message : String(error));
      }
    });
  }
}

export async function startWeChatBridge(
  getRuntimeSettings: () => WeChatRuntimeSettings = () => ({
    agentProvider: "claude",
    activeAgentId: "claude",
    agentConfigs: defaultAgentConfigs(),
    wechatTokenFile: "",
    wechatEnabled: true,
    wechatAllowedUserIds: [],
    agentPermissionPolicy: "allow-tools",
    petName: "企鹅",
    userName: "主人",
      saveChatHistory: true,
      codexSandboxMode: "read-only",
      screenCaptureDisplayId: "",
      zeroToken: defaultZeroTokenSettings(),
  }),
  historyFile = join(homedir(), ".cc-weixin", "penguin-chat-history.json"),
  credentialsFile = join(homedir(), ".cc-weixin", "penguin-credentials.json"),
  eventLogFile = join(homedir(), ".cc-weixin", "penguin-events.jsonl"),
  delegationHandler?: WeChatDelegationHandler,
): Promise<WeChatBridge> {
  const bridge = new WeChatBridge(getRuntimeSettings, historyFile, credentialsFile, eventLogFile, delegationHandler);
  await bridge.start();
  return bridge;
}

export { summarize };
