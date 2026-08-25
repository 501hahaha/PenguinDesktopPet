import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, screen, shell, Tray, type OpenDialogOptions, type SaveDialogOptions } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverLocalAgents, testAgentRequest, testLocalAgent } from "./agents/discovery";
import { AgentEndpointRegistry } from "./agents/AgentEndpointRegistry";
import { AgentDelegationService, stripControllerRoutingPrefix, type AgentDelegationCompletion } from "./agents/AgentDelegationService";
import { normalizeSafeText } from "./agents/orchestrationTypes";
import { prefixWorkspaceReply } from "./agents/workspaceReply";
import { MemoryStore } from "./memory/MemoryStore";
import { MemoryObserver } from "./memory/MemoryObserver";
import { MemoryRetriever } from "./memory/MemoryRetriever";
import { needsMemoryReorganization } from "./memory/MemoryExtractor";
import type { MemoryOperationStats, MemoryRebuildResult } from "./memory/memoryTypes";
import { readCcSwitchProfilesCached, readCcSwitchRuntimeConfig, readCcSwitchStatus } from "./ccSwitch";
import { checkZeroTokenConnection, configureZeroTokenRuntime, configureZeroTokenWebAIClient, createZeroTokenProvider, statusFromEmbedded, type ZeroTokenProviderStatus } from "./agents/ZeroTokenProvider";
import { WebModelRuntimeManager } from "./agents/WebModelRuntimeManager";
import type { WebModelRuntimeState } from "./agents/WebModelRuntimeTypes";
import { ZeroTokenRuntime } from "./zerotoken/ZeroTokenRuntime";
import { createWebAIClient } from "./zerotoken/WebAIClient";
import { ChatGPTWebAdapter } from "./zerotoken/providers/ChatGPTWebAdapter";
import { ZeroTokenApiServer } from "./zerotoken/api/ZeroTokenApiServer";
import { ZERO_TOKEN_PROVIDERS, type ZeroTokenProviderId } from "./zerotoken/types";
import type { ZeroTokenApiSettings } from "./runtime/types";
import { checkForUpdate } from "./updateService";
import type { CcSwitchAgentProfile, CcSwitchImportResult, CcSwitchStatus, UpdateCheckResult } from "./systemTypes";
import {
  defaultAgentCapabilityPolicy,
  fullAgentCapabilityPolicy,
  defaultAgentConfigs,
  agentModelOptionId,
  canonicalizeAgentConfigs,
  migrateLegacyCcSwitchAgentConfigs,
  normalizeAgentApprovalMode,
  normalizeAgentCapabilityPolicy,
  normalizeAgentConfigs,
  normalizeAgentModelOptions,
  normalizeAgentFallbackIds,
  resolveActiveAgentId,
  isAgentAdded,
} from "../agents/types";
import type { AgentConfig, AgentControllerStatus, AgentModelOption, CcSwitchCurrentConfig, LocalAgentInfo } from "../agents/types";
import { BotChannelManager } from "./channels/BotChannelManager";
import { DingTalkChannelAdapter } from "./channels/DingTalkChannelAdapter";
import type { DingTalkChannelConfig } from "./channels/DingTalkChannelAdapter";
import { DingTalkCredentialStore } from "./channels/dingtalkCredentialStore";
import { FeishuChannelAdapter } from "./channels/FeishuChannelAdapter";
import type { FeishuChannelConfig } from "./channels/FeishuChannelAdapter";
import { FeishuCredentialStore } from "./channels/feishuCredentialStore";
import { FeishuQrLoginManager } from "./channels/feishuQrLogin";
import type { FeishuQrCredentials, FeishuQrLoginEvent } from "./channels/feishuQrLogin";
import { loadQQChannelConfig } from "./channels/qqConfig";
import type { QQChannelConfig } from "./channels/qqConfig";
import { QQChannelAdapter } from "./channels/QQChannelAdapter";
import { QQCredentialStore, type QQCredential } from "./channels/qqCredentialStore";
import { QQQrLoginManager } from "./channels/qqQrLogin";
import type { QQQrLoginEvent, QrConnectCredentials } from "./channels/qqQrLogin";
import { WeChatChannelAdapter } from "./channels/WeChatChannelAdapter";
import type { BotChannelEvent, BotPlatform, OutboundMediaMessage } from "./channels/types";
import { AgentEventBridge } from "./pet/AgentEventBridge";
import { AgentPerceptionService } from "./pet/AgentPerceptionService";
import { AgentTaskObserver } from "./pet/AgentTaskObserver";
import { CodexRolloutWatcher } from "./pet/CodexRolloutWatcher";
import { ClaudeRolloutWatcher } from "./pet/ClaudeRolloutWatcher";
import { LongTaskReplyScheduler, type LongTaskReplyRoute } from "./pet/LongTaskReplyScheduler";
import { formatCodexDesktopTaskStatus, isCodexDesktopTaskQuery } from "./pet/codexDesktopTaskStatus";
import { startWeChatBridge, WeChatBridge } from "./wechat/WeChatBridge";
import { ChatHistoryStore, isLiveStateQuery, type RecentChatMessage } from "./wechat/chatHistory";
import { loadConfig } from "./wechat/config";
import { extractMediaDirective, generateAgentPerception, generateReply, shutdownAgents } from "./wechat/replyGenerator";
import { credentialId } from "./wechat/credentialStore";
import { loadSession } from "./wechat/iLinkClient";
import { preparePetStyleVideo } from "./petStyleVideo";
import { DEFAULT_PET_NAME, DEFAULT_TASK_NOTIFICATION_MODE, DEFAULT_TASK_NOTIFICATION_PLATFORM, DEFAULT_USER_NAME, defaultPetPerceptionSettings, defaultZeroTokenSettings, normalizeCallName, normalizePetPerceptionSettings, normalizeTaskNotificationMode, normalizeTaskNotificationPlatform, normalizeZeroTokenSettings } from "../settings/types";
import type { AgentPermissionPolicy, AgentProvider, ChatHistorySummary, CodexSandboxMode, DingTalkAccount, FeishuAccount, LocalDataActionResult, LocalDataSummary, PetSettings, PetSettingsUpdate, PetStyle, PetStyleActionResult, PetStyleAssetUrls, PetStyleCustomState, PetStyleSource, PetTheme, QQAccount, TaskNotificationMode, TaskNotificationPlatform, WeChatAccount } from "../settings/types";
import { PET_STATES, type PetState } from "../pet/PetStateMachine";
import type { WeChatStatus } from "./wechat/events";
import { completionDetailForDisplay } from "./pet/perceptionTypes";
import type { AgentTaskCompletion } from "./pet/perceptionTypes";
import { elapsedSecondsBetween, formatAgentEventNotification, formatTaskNotification } from "./pet/taskNotificationFormatter";
import { getSystemDefaultDisplay, listDesktopCaptureDisplays } from "./media/DesktopCaptureService";
import { AgentWindowTracker, toAgentWindowFollowStatus } from "./media/AgentWindowTracker";
import { EventBus } from "./events/EventBus";
import type { AgentEvent, AgentEventSourceType } from "./events/EventTypes";
import { NotificationManager } from "./notifications/NotificationManager";

// Electron 37 enables this Chromium feature for transparent HWNDs by default.
// It can expand a small transparent overlay to the monitor-sized native window.
const PACKAGED_USER_DATA_DIRECTORY = "penguin-desktop-pet-public";

// Packaged releases must never reuse the developer machine's bot credentials,
// chat history, event logs, or local Agent state. Keep development data in the
// existing userData directory and give installed/portable releases a fresh one.
if (app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), PACKAGED_USER_DATA_DIRECTORY));
}

const PACKAGED_USER_DATA_RESET_MARKER = "packaged-public-data-v2";

function resetPackagedUserDataOnce(): void {
  if (!app.isPackaged) return;
  const userDataPath = app.getPath("userData");
  const markerPath = join(userDataPath, PACKAGED_USER_DATA_RESET_MARKER);
  if (existsSync(markerPath)) return;
  rmSync(userDataPath, { recursive: true, force: true });
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(markerPath, "This directory belongs to the packaged public build.\n", "utf8");
  console.info(`[Privacy] initialized isolated packaged user data: ${userDataPath}`);
}

resetPackagedUserDataOnce();

app.commandLine.appendSwitch("disable-features", "EnableTransparentHwndEnlargement");

function isBenignFeishuWebSocketClose(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /WebSocket was closed before the connection was established/i.test(detail)
    && /(?:@larksuiteoapi|node_modules[\\/]ws[\\/])/i.test(detail);
}

const handleMainProcessUncaughtException = (error: unknown): void => {
  if (isBenignFeishuWebSocketClose(error)) {
    // @larksuiteoapi/node-sdk can race a reconnect timeout with a CONNECTING
    // socket close. It is recoverable and must not take down Electron.
    console.warn("[Feishu] ignored recoverable WebSocket close race");
    return;
  }
  process.removeListener("uncaughtException", handleMainProcessUncaughtException);
  throw error;
};
process.on("uncaughtException", handleMainProcessUncaughtException);

const PET_WINDOW_WIDTH = 280;
const PET_WINDOW_HEIGHT = 340;
const PET_WINDOW_EXPANDED_HEIGHT = 640;
const PET_STATUS_EDGE_REBOUND_TRIGGER_PX = 36;
const SETTINGS_WINDOW_WIDTH = 420;
const SETTINGS_WINDOW_HEIGHT = 710;
const MAX_WINDOW_SHAPE_RECTS = 4096;
const PET_SETTINGS_FILE = "pet-settings.json";
const AGENT_NOTIFICATION_TARGET_FILE = "agent-notification-target.json";
// 微信自动任务通知必须支持桌宠主动发送：已有具体会话目标时直接发送，
// 暂时失败则落本地待发队列并自动重试，不把用户再次发消息当成发送前提。
const AGENT_TASK_NOTIFY_QUEUE_FILE = "agent-task-notify-queue.json";
const MAX_AGENT_TASK_NOTIFY_QUEUE = 50;
// v7 invalidates notices produced before the unified multi-line event-detail
// formatter. Those entries may be compact or have already lost line breaks;
// they must never be replayed after a release restart.
const AGENT_TASK_NOTIFY_QUEUE_VERSION = 7;
const AGENT_TASK_NOTIFY_QUEUE_TTL_MS = 30 * 60 * 1_000;
const AGENT_TASK_NOTIFY_RETRY_INITIAL_MS = 15_000;
const AGENT_TASK_NOTIFY_RETRY_MAX_MS = 5 * 60_000;
const AGENT_BRIDGE_TOKEN_FILE = "agent-bridge-token";
const PET_SETTINGS_SCHEMA_VERSION = 32;
// 钉钉官方接入页/文档允许列表：仅这些主机的 HTTPS 链接可经 links:open-external 打开。
const DINGTALK_ONBOARDING_HOSTS = new Set([
  "open-dev.dingtalk.com",
  "opensource.dingtalk.com",
  "open.dingtalk.com",
]);
const DEFAULT_PET_STYLE_ID = "default-penguin";
const PET_STYLE_ROOT = "pet-styles";
const PET_STYLE_ACTION_FILES: Record<PetState, string> = {
  idle: "IDLE.webm",
  walk: "WALK.webm",
  happy: "HAPPY.webm",
  shy: "SHY.webm",
  sleep: "SLEEP.webm",
  eat: "EAT.webm",
  angry: "ANGRY.webm",
};
const DEFAULT_PET_STYLE_ALPHA_MOV_FILES: Record<PetState, string> = {
  idle: "IDLE.mov",
  walk: "Walk.mov",
  happy: "Happy.mov",
  shy: "Shy.mov",
  sleep: "Sleep.mov",
  eat: "Eat.mov",
  angry: "Angry.mov",
};
const DEFAULT_PET_STYLE_CUTOUT_MP4_FILES: Record<PetState, string> = {
  idle: "IDLE.mp4",
  walk: "WALK.mp4",
  happy: "HAPPY.mp4",
  shy: "SHY.mp4",
  sleep: "SLEEP.mp4",
  eat: "EAT.mp4",
  angry: "ANGRY.mp4",
};
const PET_STYLE_STATE_LABELS: Record<PetState, string> = {
  idle: "待机",
  walk: "行走",
  happy: "开心",
  shy: "害羞",
  sleep: "睡觉",
  eat: "吃东西",
  angry: "生气",
};
const PET_STYLE_STATE_DESCRIPTIONS: Record<PetState, string> = {
  idle: "安静陪伴",
  walk: "准备出发",
  happy: "开心互动",
  shy: "害羞回应",
  sleep: "安静休息",
  eat: "享受美食",
  angry: "情绪表达",
};
const MAX_PET_STYLE_FILE_BYTES = 250 * 1024 * 1024;
const MAX_PET_STYLE_TOTAL_BYTES = 1024 * 1024 * 1024;
// 宠物动作导入支持 WebM，以及会在导入时转换为 WebM 的 Alpha MOV。
const PET_STYLE_VIDEO_EXTENSIONS = [".webm", ".mov"] as const;
const MANAGED_DATA_FILE_NAMES = [
  PET_SETTINGS_FILE,
  "channel-history.json",
  "wechat-history.json",
  "wechat-credentials.json",
  "qq-credentials.json",
  "feishu-credentials.json",
  "dingtalk-credentials.json",
  "wechat-events.jsonl",
  AGENT_TASK_NOTIFY_QUEUE_FILE,
  AGENT_BRIDGE_TOKEN_FILE,
] as const;

protocol.registerSchemesAsPrivileged([{
  scheme: "penguin-pet",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

interface WindowShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowShapeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settingsWindowReady = false;
let settingsWindowShowRequested = false;
let allowSettingsWindowClose = false;
let appQuitting = false;
let cleanupPromise: Promise<void> | null = null;
let cleanupCompleted = false;
const botChannelManager = new BotChannelManager();
let agentPerceptionService: AgentPerceptionService | null = null;
let agentTaskObserver: AgentTaskObserver | null = null;
let agentEventBus: EventBus | null = null;
let notificationManager: NotificationManager | null = null;
let agentEventBridge: AgentEventBridge | null = null;
let agentEndpointRegistry: AgentEndpointRegistry | null = null;
let agentDelegationService: AgentDelegationService | null = null;
let agentWindowTracker: AgentWindowTracker | null = null;
let codexRolloutWatcher: CodexRolloutWatcher | null = null;
let claudeRolloutWatcher: ClaudeRolloutWatcher | null = null;
let longTaskReplyScheduler: LongTaskReplyScheduler | null = null;
let qqCredentialStore: QQCredentialStore | null = null;
let feishuCredentialStore: FeishuCredentialStore | null = null;
let dingtalkCredentialStore: DingTalkCredentialStore | null = null;
let channelHistory: ChatHistoryStore | null = null;
let memoryStore: MemoryStore | null = null;
let memoryRetriever: MemoryRetriever | null = null;
let memoryObserver: MemoryObserver | null = null;
const qqChannelAdapters = new Map<string, QQChannelAdapter>();
const feishuChannelAdapters = new Map<string, FeishuChannelAdapter>();
const dingtalkChannelAdapters = new Map<string, DingTalkChannelAdapter>();
const channelReplyQueues = new Map<string, Promise<void>>();
let settingsWindowDrag:
  | {
      sender: Electron.WebContents;
      windowX: number;
      windowY: number;
      cursorX: number;
      cursorY: number;
    }
  | null = null;
let weChatBridge: WeChatBridge | null = null;
let activeWindowDrag:
  | {
      sender: Electron.WebContents;
      windowX: number;
      windowY: number;
      cursorX: number;
      cursorY: number;
      lastCursorX: number;
      lastCursorY: number;
      lastWindowX: number;
      lastWindowY: number;
      shapeBounds: WindowShapeBounds | null;
      desktop: Electron.Rectangle;
      windowWidth: number;
      windowHeight: number;
    }
  | null = null;
let enforcingPetBounds = false;
let enforcingSettingsBounds = false;
let userHasInteractedWithPetWindow = false;
let petShapeBounds: WindowShapeBounds | null = null;
let petWindowExpanded = false;
let dataDeletionInProgress = false;
// Keep the desktop pet above normal application windows by default. Users can
// disable TOPMOST from the pet context menu when they need a quieter layer.
let keepWindowOnTop = true;
let appliedWindowOnTop: boolean | null = null;
let lastPetWindowEdgeSignature = "";
let petSettings: PetSettings = {
  theme: "minimal",
  petStyles: [{ id: DEFAULT_PET_STYLE_ID, name: "默认企鹅", source: "builtin", configuredStates: [...PET_STATES], customStates: [] }],
  activePetStyleId: DEFAULT_PET_STYLE_ID,
  petPerception: defaultPetPerceptionSettings(),
  taskNotificationPlatform: DEFAULT_TASK_NOTIFICATION_PLATFORM,
  taskNotificationMode: DEFAULT_TASK_NOTIFICATION_MODE,
  petName: DEFAULT_PET_NAME,
  userName: DEFAULT_USER_NAME,
  alwaysOnTop: true,
  showWeChatBubbles: true,
  showThinkingBubbles: true,
  agentProvider: "claude",
  activeAgentId: "claude",
  agentConfigs: defaultAgentConfigs(),
  agentCapabilityPolicy: defaultAgentCapabilityPolicy(),
  agentApprovalMode: "risk-based",
  agentFallbackIds: [],
  ccSwitchSyncEnabled: true,
  zeroToken: defaultZeroTokenSettings(),
  wechatTokenFile: "",
  wechatEnabled: !app.isPackaged,
  screenCaptureDisplayId: "",
  wechatAccounts: [],
  activeWeChatAccountId: "",
  qqAccounts: [],
  activeQQAccountId: "",
  feishuAccounts: [],
  activeFeishuAccountId: "",
  dingtalkAccounts: [],
  activeDingTalkAccountId: "",
  wechatAllowedUserIds: [],
  agentFullAccess: false,
  agentPermissionPolicy: "allow-tools",
  saveChatHistory: true,
  codexSandboxMode: "read-only",
};

const webModelRuntimeManager = new WebModelRuntimeManager({
  getUserDataPath: () => app.getPath("userData"),
  getResourcesPath: () => process.resourcesPath,
  getAppPath: () => app.getAppPath(),
  // Legacy manager is kept for compatibility only; Phase 1 does not start it.
  onStateChanged: () => undefined,
  onModelSelected: (modelId) => persistZeroTokenModel(modelId),
});
const zeroTokenRuntime = new ZeroTokenRuntime();
configureZeroTokenRuntime(zeroTokenRuntime);
configureZeroTokenWebAIClient(createWebAIClient([
  new ChatGPTWebAdapter(zeroTokenRuntime.browserManager, zeroTokenRuntime.sessionManager),
]));
// This configuration intentionally lives in the main process.  The renderer
// receives neither the auth token nor this object through settings IPC.
const zeroTokenApiSettings: ZeroTokenApiSettings = {
  auth: { enabled: process.env.PENGUIN_ZEROTOKEN_API_AUTH === "1" },
};
const zeroTokenApiToken = process.env.PENGUIN_ZEROTOKEN_API_TOKEN?.trim()
  || randomBytes(32).toString("hex");
const zeroTokenApiServer = new ZeroTokenApiServer({
  host: "127.0.0.1",
  port: 3456,
  provider: () => createZeroTokenProvider(petSettings.zeroToken),
  auth: {
    enabled: zeroTokenApiSettings.auth.enabled,
    token: zeroTokenApiToken,
  },
});
zeroTokenRuntime.subscribe((status) => {
  const selected = status.provider === petSettings.zeroToken.provider
    ? status
    : undefined;
  if (selected) broadcastZeroTokenStatus(statusFromEmbedded(selected));
});

async function cleanupStep(label: string, action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.warn(`[AppLifecycle] cleanup failed: ${label}`, error);
  }
}

function cleanupAppResources(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = (async () => {
    console.info("[AppLifecycle] cleanup started");
    agentPerceptionService?.stop();
    agentTaskObserver?.stop();
    agentWindowTracker?.stop();
    codexRolloutWatcher?.stop();
    claudeRolloutWatcher?.stop();
    longTaskReplyScheduler?.stopAll();
    notificationManager?.dispose();
    agentEventBus?.clear();

    agentEndpointRegistry?.setBridgeState("offline");
    agentEventBridge?.stop();
    agentEndpointRegistry?.dispose();

    qqQrLoginManager.cancel();
    feishuQrLoginManager.cancel();
    await cleanupStep("Zero Token API server", () => zeroTokenApiServer.stop());
    await cleanupStep("Zero Token browser sessions", () => zeroTokenRuntime.dispose());
    await cleanupStep("WeChat bridge", () => weChatBridge?.stop());
    await Promise.all([
      ...[...qqChannelAdapters.values()].map((adapter) => cleanupStep(`QQ channel ${adapter.channelId}`, () => adapter.stop())),
      ...[...feishuChannelAdapters.values()].map((adapter) => cleanupStep(`Feishu channel ${adapter.channelId}`, () => adapter.stop())),
      ...[...dingtalkChannelAdapters.values()].map((adapter) => cleanupStep(`DingTalk channel ${adapter.channelId}`, () => adapter.stop())),
    ]);
    await cleanupStep("Codex app-server", () => shutdownAgents());
    botChannelManager.dispose();

    if (memoryStore) {
      await cleanupStep("memory store", () => memoryStore?.close());
      memoryStore = null;
      memoryRetriever = null;
      memoryObserver = null;
    }
    tray?.destroy();
    tray = null;
    console.info("[AppLifecycle] cleanup completed; owned resources released");
  })();

  return cleanupPromise;
}

const DEFAULT_WECHAT_STATUS: WeChatStatus = {
  state: "disconnected",
  connected: false,
  detail: "微信桥接尚未启动",
  lastError: "",
  retryCount: 0,
  nextRetryAt: null,
};

function weChatAccountId(tokenFile: string): string {
  return credentialId(tokenFile);
}

function weChatAccountDisplayName(tokenFile: string, accountId = ""): string {
  const trimmedAccountId = accountId.trim();
  if (trimmedAccountId) return trimmedAccountId;
  const fileName = basename(tokenFile, ".json").trim();
  return fileName || "微信 Bot";
}

function normalizeWeChatAccounts(value: unknown): WeChatAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: WeChatAccount[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.tokenFile !== "string" || !item.tokenFile.trim()) continue;
    const tokenFile = item.tokenFile.trim();
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : weChatAccountId(tokenFile);
    if (seenIds.has(id) || seenFiles.has(tokenFile)) continue;
    seenIds.add(id);
    seenFiles.add(tokenFile);
    accounts.push({
      id,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : weChatAccountDisplayName(tokenFile),
      tokenFile,
      agentId: typeof item.agentId === "string" ? item.agentId.trim() : "",
      taskNotificationEnabled: item.taskNotificationEnabled === true,
      taskNotificationMode: normalizeTaskNotificationMode(item.taskNotificationMode),
    });
  }
  return accounts;
}

function normalizeWeChatUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normalizeQQAccounts(value: unknown): QQAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: QQAccount[] = [];
  const seenIds = new Set<string>();
  const seenAppIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.appId !== "string" || !item.appId.trim()) continue;
    const appId = item.appId.trim();
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `qq:${appId}`;
    if (seenIds.has(id) || seenAppIds.has(appId)) continue;
    seenIds.add(id);
    seenAppIds.add(appId);
    accounts.push({
      id,
      appId,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : `QQ Bot ${appId}`,
      enabled: item.enabled !== false,
      agentId: typeof item.agentId === "string" ? item.agentId.trim() : "",
      taskNotificationEnabled: item.taskNotificationEnabled === true,
      taskNotificationMode: normalizeTaskNotificationMode(item.taskNotificationMode),
    });
  }
  return accounts;
}

function normalizeFeishuAccounts(value: unknown): FeishuAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: FeishuAccount[] = [];
  const seenIds = new Set<string>();
  const seenAppIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.appId !== "string" || !item.appId.trim()) continue;
    const appId = item.appId.trim();
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `feishu:${appId}`;
    if (seenIds.has(id) || seenAppIds.has(appId)) continue;
    seenIds.add(id);
    seenAppIds.add(appId);
    accounts.push({
      id,
      appId,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : `飞书 Bot ${appId}`,
      enabled: item.enabled !== false,
      agentId: typeof item.agentId === "string" ? item.agentId.trim() : "",
      taskNotificationEnabled: item.taskNotificationEnabled === true,
      taskNotificationMode: normalizeTaskNotificationMode(item.taskNotificationMode),
    });
  }
  return accounts;
}

function normalizeDingTalkAccounts(value: unknown): DingTalkAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: DingTalkAccount[] = [];
  const seenIds = new Set<string>();
  const seenClientIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.clientId !== "string" || !item.clientId.trim()) continue;
    const clientId = item.clientId.trim();
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `dingtalk:${clientId}`;
    if (seenIds.has(id) || seenClientIds.has(clientId)) continue;
    seenIds.add(id);
    seenClientIds.add(clientId);
    accounts.push({
      id,
      clientId,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : `钉钉 Bot ${clientId}`,
      enabled: item.enabled !== false,
      agentId: typeof item.agentId === "string" ? item.agentId.trim() : "",
      taskNotificationEnabled: item.taskNotificationEnabled === true,
      taskNotificationMode: normalizeTaskNotificationMode(item.taskNotificationMode),
    });
  }
  return accounts;
}

function fallbackAgentId(settings: PetSettings = petSettings): string {
  const addedAgents = settings.agentConfigs.filter(isAgentAdded);
  return resolveActiveAgentId(settings.activeAgentId, addedAgents, settings.agentProvider);
}

function botSelectableAgentConfigs(settings: PetSettings = petSettings): AgentConfig[] {
  return settings.agentConfigs.filter(isAgentAdded);
}

function requestedAgentIdOrFallback(value: unknown, existingAgentId = "", settings: PetSettings = petSettings): string {
  const requested = typeof value === "string" ? value.trim() : "";
  const selectable = botSelectableAgentConfigs(settings);
  if (requested && selectable.some((config) => config.id === requested)) return requested;
  if (existingAgentId && selectable.some((config) => config.id === existingAgentId)) return existingAgentId;
  return fallbackAgentId(settings);
}

function normalizeBotAgentBindings(): boolean {
  const fallback = fallbackAgentId();
  const selectable = new Set(botSelectableAgentConfigs().map((config) => config.id));
  let changed = false;
  const normalize = <T extends { agentId: string }>(accounts: T[]): T[] => accounts.map((account) => {
    const agentId = selectable.has(account.agentId)
      ? account.agentId
      : fallback;
    if (account.agentId === agentId) return account;
    changed = true;
    return { ...account, agentId };
  });
  petSettings.wechatAccounts = normalize(petSettings.wechatAccounts);
  petSettings.qqAccounts = normalize(petSettings.qqAccounts);
  petSettings.feishuAccounts = normalize(petSettings.feishuAccounts);
  petSettings.dingtalkAccounts = normalize(petSettings.dingtalkAccounts);
  return changed;
}

function migrateLegacyBotTaskNotificationSettings(saved: Record<string, unknown>): boolean {
  const collections = [saved.wechatAccounts, saved.qqAccounts, saved.feishuAccounts, saved.dingtalkAccounts];
  const hasPerBotSettings = collections.some((value) => Array.isArray(value)
    && value.some((item) => isRecord(item)
      && (Object.prototype.hasOwnProperty.call(item, "taskNotificationEnabled")
        || Object.prototype.hasOwnProperty.call(item, "taskNotificationMode"))));
  if (hasPerBotSettings) return false;

  const mode: TaskNotificationMode = petSettings.taskNotificationMode;
  const enableLegacyTarget = <T extends { id: string; taskNotificationEnabled: boolean; taskNotificationMode: TaskNotificationMode }>(accounts: T[]): boolean => {
    const account = accounts.find((item) => item.id === (
      petSettings.taskNotificationPlatform === "wechat"
        ? petSettings.activeWeChatAccountId
        : petSettings.taskNotificationPlatform === "qq"
          ? petSettings.activeQQAccountId
          : petSettings.taskNotificationPlatform === "feishu"
            ? petSettings.activeFeishuAccountId
            : petSettings.activeDingTalkAccountId
    ));
    if (!account) return false;
    account.taskNotificationEnabled = true;
    account.taskNotificationMode = mode;
    return true;
  };

  if (petSettings.taskNotificationPlatform === "wechat") return enableLegacyTarget(petSettings.wechatAccounts);
  if (petSettings.taskNotificationPlatform === "qq") return enableLegacyTarget(petSettings.qqAccounts);
  if (petSettings.taskNotificationPlatform === "feishu") return enableLegacyTarget(petSettings.feishuAccounts);
  return enableLegacyTarget(petSettings.dingtalkAccounts);
}

function boundAgentIdForBot(platform: BotPlatform, accountId = "", channelId = "", settings = getPetSettings()): string {
  const identity = accountId.trim();
  const channelIdentity = channelId.trim();
  const matches = (account: { id: string; agentId: string }, ...aliases: string[]) => {
    const candidates = [account.id, ...aliases].filter(Boolean);
    return candidates.some((candidate) => candidate === identity || candidate === channelIdentity);
  };
  const account = platform === "wechat"
    ? settings.wechatAccounts.find((item) => matches(item, item.tokenFile))
      ?? settings.wechatAccounts.find((item) => item.id === settings.activeWeChatAccountId)
    : platform === "qq"
      ? settings.qqAccounts.find((item) => matches(item, item.appId))
      : platform === "feishu"
        ? settings.feishuAccounts.find((item) => matches(item, item.appId))
        : settings.dingtalkAccounts.find((item) => matches(item, item.clientId));
  return account?.agentId && botSelectableAgentConfigs(settings).some((config) => config.id === account.agentId)
    ? account.agentId
    : fallbackAgentId(settings);
}

function boundAgentConfigForBot(platform: BotPlatform, accountId = "", channelId = "", settings = getPetSettings()): AgentConfig {
  const id = boundAgentIdForBot(platform, accountId, channelId, settings);
  const selectable = botSelectableAgentConfigs(settings);
  return selectable.find((config) => config.id === id)
    ?? selectable.find((config) => config.id === fallbackAgentId(settings))
    ?? defaultAgentConfigs()[0];
}


function isAgentPermissionPolicy(value: unknown): value is AgentPermissionPolicy {
  return value === "chat-only" || value === "allow-tools";
}

function applyAgentFullAccessPolicy(): boolean {
  if (!petSettings.agentFullAccess) return false;
  const fullPolicy = fullAgentCapabilityPolicy();
  const changed = petSettings.agentPermissionPolicy !== "allow-tools"
    || petSettings.codexSandboxMode !== "danger-full-access"
    || JSON.stringify(petSettings.agentCapabilityPolicy) !== JSON.stringify(fullPolicy);
  petSettings.agentPermissionPolicy = "allow-tools";
  petSettings.codexSandboxMode = "danger-full-access";
  petSettings.agentCapabilityPolicy = fullPolicy;
  return changed;
}

function isPetStyleSource(value: unknown): value is PetStyleSource {
  return value === "builtin" || value === "imported";
}

function isPetState(value: unknown): value is PetState {
  return typeof value === "string" && (PET_STATES as readonly string[]).includes(value);
}

function normalizeConfiguredStates(value: unknown, source: PetStyleSource): PetState[] {
  if (!Array.isArray(value)) return source === "builtin" ? [...PET_STATES] : [...PET_STATES];
  return PET_STATES.filter((state) => value.some((item) => item === state));
}

function normalizePetStyleCustomStates(value: unknown): PetStyleCustomState[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const states: PetStyleCustomState[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.fileName !== "string") continue;
    const id = item.id.trim();
    const name = item.name.trim().slice(0, 24);
    const fileName = item.fileName.trim();
    if (!id || !name || !fileName || seenIds.has(id) || !/^[a-zA-Z0-9._-]+\.webm$/i.test(fileName)) continue;
    seenIds.add(id);
    states.push({
      id,
      name,
      fileName,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    });
  }
  return states;
}

function normalizePetStyles(value: unknown): PetStyle[] {
  const styles: PetStyle[] = [{
    id: DEFAULT_PET_STYLE_ID,
    name: "默认企鹅",
    source: "builtin",
    configuredStates: [...PET_STATES],
    customStates: [],
  }];
  const seenIds = new Set([DEFAULT_PET_STYLE_ID]);
  if (!Array.isArray(value)) return styles;
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || !isPetStyleSource(item.source)) continue;
    const id = item.id.trim();
    const name = item.name.trim();
    if (!id || !name || id.includes("/") || id.includes("\\")) continue;
    if (id === DEFAULT_PET_STYLE_ID && item.source === "builtin") {
      styles[0] = {
        ...styles[0],
        customStates: normalizePetStyleCustomStates(item.customStates),
      };
      continue;
    }
    if (seenIds.has(id) || item.source === "builtin") continue;
    seenIds.add(id);
    styles.push({
      id,
      name: name.slice(0, 40),
      source: "imported",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      configuredStates: normalizeConfiguredStates(item.configuredStates, "imported"),
      customStates: normalizePetStyleCustomStates(item.customStates),
    });
  }
  return styles;
}

function petStyleRootPath(): string {
  return join(app.getPath("userData"), PET_STYLE_ROOT);
}

function petStyleDirectoryPath(styleId: string): string {
  return join(petStyleRootPath(), styleId);
}

function defaultPetStyleAssetPath(state: PetState): string {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, "video", "alpha-webm", PET_STYLE_ACTION_FILES[state]),
    join(appPath, "video", "抠图", DEFAULT_PET_STYLE_CUTOUT_MP4_FILES[state]),
    join(appPath, "video", "alpha", DEFAULT_PET_STYLE_ALPHA_MOV_FILES[state]),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function petStyleAssetPath(styleId: string, state: PetState): string {
  if (styleId === DEFAULT_PET_STYLE_ID) return defaultPetStyleAssetPath(state);
  return join(petStyleDirectoryPath(styleId), PET_STYLE_ACTION_FILES[state]);
}

function petStyleAssetUrls(styleId: string): PetStyleAssetUrls {
  const style = petSettings.petStyles.find((item) => item.id === styleId) ?? petSettings.petStyles[0];
  const configuredStates = style?.id === DEFAULT_PET_STYLE_ID
    ? [...PET_STATES]
    : (style?.configuredStates ?? [...PET_STATES]);
  const customStates = style?.customStates ?? [];
  const availableIds = [
    ...configuredStates,
    ...customStates.map((state) => state.id),
  ];
  const fallbackId = availableIds[0] ?? "idle";
  const assets: Record<string, string> = {};
  const urlForState = (state: PetState): string => `penguin-pet://${encodeURIComponent(styleId)}/${encodeURIComponent(PET_STYLE_ACTION_FILES[state])}`;
  const urlForCustomState = (state: PetStyleCustomState): string => `penguin-pet://${encodeURIComponent(styleId)}/${encodeURIComponent(state.fileName)}`;

  for (const state of PET_STATES) {
    const sourceId = configuredStates.includes(state) ? state : fallbackId;
    const customSource = customStates.find((item) => item.id === sourceId);
    assets[state] = customSource ? urlForCustomState(customSource) : urlForState(sourceId as PetState);
  }
  for (const state of customStates) assets[state.id] = urlForCustomState(state);

  return {
    assets,
    cycleStates: availableIds.map((id) => {
      const customState = customStates.find((item) => item.id === id);
      const fallbackState = customState ? "idle" : id as PetState;
      return {
        id,
        name: customState?.name ?? PET_STYLE_STATE_LABELS[id as PetState],
        description: customState ? "自定义宠物状态" : PET_STYLE_STATE_DESCRIPTIONS[id as PetState],
        fallbackState,
      };
    }),
  };
}

function registerPetStyleProtocol(): void {
  protocol.handle("penguin-pet", async (request) => {
    try {
      const parsed = new URL(request.url);
      const styleId = decodeURIComponent(parsed.hostname);
      const fileName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      const style = petSettings.petStyles.find((item) => item.id === styleId);
      if (!style) return new Response("Not found", { status: 404 });
      const state = PET_STATES.find((item) => PET_STYLE_ACTION_FILES[item].toLowerCase() === fileName.toLowerCase());
      const customState = style.customStates?.find((item) => item.fileName.toLowerCase() === fileName.toLowerCase());
      if (!state && !customState) return new Response("Not found", { status: 404 });
      const filePath = state ? petStyleAssetPath(styleId, state) : join(petStyleDirectoryPath(styleId), customState!.fileName);
      if (!existsSync(filePath)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
}

function petStyleVideoFiles(folderPath: string): string[] {
  try {
    return readdirSync(folderPath, { withFileTypes: true })
      .filter((item) => {
        if (!item.isFile()) return false;
        const fileName = item.name.toLowerCase();
        const extension = fileName.slice(fileName.lastIndexOf("."));
        return PET_STYLE_VIDEO_EXTENSIONS.includes(extension as typeof PET_STYLE_VIDEO_EXTENSIONS[number]);
      })
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { sensitivity: "base" }))
      .slice(0, PET_STATES.length)
      .map((item) => join(folderPath, item.name));
  } catch {
    return [];
  }
}

interface PreparedPetStyleFile {
  importPath: string;
  cleanupPath?: string;
  totalBytes: number;
}

function cleanupPreparedPetStyleFile(file: PreparedPetStyleFile | undefined): void {
  if (!file?.cleanupPath) return;
  try { unlinkSync(file.cleanupPath); } catch { /* best effort cleanup */ }
}

function cleanupPreparedPetStyleFiles(files: Iterable<PreparedPetStyleFile>): void {
  for (const file of files) cleanupPreparedPetStyleFile(file);
}

async function preparePetStyleFile(filePath: string): Promise<{ ok: true; file: PreparedPetStyleFile } | { ok: false; detail: string }> {
  try {
    const sourceBytes = statSync(filePath).size;
    if (sourceBytes <= 0 || sourceBytes > MAX_PET_STYLE_FILE_BYTES) {
      return { ok: false, detail: "这个宠物视频大小不受支持，请检查导出结果。" };
    }
    const extension = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    if (extension === ".webm") {
      const validation = validatePetStyleFile(filePath);
      return validation.ok
        ? { ok: true, file: { importPath: filePath, totalBytes: validation.totalBytes } }
        : validation;
    }
    const prepared = await preparePetStyleVideo(filePath);
    if (!prepared.ok) return prepared;
    return {
      ok: true,
      file: {
        importPath: prepared.kind === "converted" ? prepared.webmPath : filePath,
        cleanupPath: prepared.kind === "converted" ? prepared.webmPath : undefined,
        totalBytes: prepared.totalBytes,
      },
    };
  } catch {
    return { ok: false, detail: "无法读取这个宠物视频，请检查文件是否完整。" };
  }
}

function validatePetStyleFile(filePath: string): { ok: true; totalBytes: number } | { ok: false; detail: string } {
  if (!filePath.toLowerCase().endsWith(".webm")) {
    const detected = basename(filePath).toLowerCase();
    const hint = detected.includes(".") ? `（检测到 ${detected.slice(detected.lastIndexOf("."))}）` : "";
    return { ok: false, detail: `宠物状态需要使用 WebM 或带 Alpha 通道的 MOV 文件${hint}。` };
  }
  const fileSize = statSync(filePath).size;
  if (fileSize <= 0 || fileSize > MAX_PET_STYLE_FILE_BYTES) return { ok: false, detail: "这个宠物视频大小不受支持，请检查导出结果。" };
  return { ok: true, totalBytes: fileSize };
}

async function validatePetStyleFolder(folderPath: string): Promise<{ ok: true; files: Partial<Record<PetState, PreparedPetStyleFile>>; states: PetState[]; totalBytes: number; ignoredCount: number } | { ok: false; detail: string }> {
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) return { ok: false, detail: "请选择包含动作视频的文件夹。" };
  const files: Partial<Record<PetState, PreparedPetStyleFile>> = {};
  const preparedFiles: PreparedPetStyleFile[] = [];
  const states: PetState[] = [];
  let totalBytes = 0;
  const videoFiles = petStyleVideoFiles(folderPath);
  for (const [index, filePath] of videoFiles.entries()) {
    const state = PET_STATES[index];
    const validation = await preparePetStyleFile(filePath);
    if (!validation.ok) {
      cleanupPreparedPetStyleFiles(preparedFiles);
      return { ok: false, detail: `${basename(filePath)} ${validation.detail}` };
    }
    totalBytes += validation.file.totalBytes;
    files[state] = validation.file;
    preparedFiles.push(validation.file);
    states.push(state);
  }
  if (states.length === 0) {
    cleanupPreparedPetStyleFiles(preparedFiles);
    return { ok: false, detail: "未找到受支持的宠物视频。请放入至少一个 WebM 或 MOV 文件，文件名不作要求。" };
  }
  if (totalBytes > MAX_PET_STYLE_TOTAL_BYTES) {
    cleanupPreparedPetStyleFiles(preparedFiles);
    return { ok: false, detail: "这套宠物视频总大小超过 1 GB，请压缩后再导入。" };
  }
  let allVideoCount = videoFiles.length;
  try {
    allVideoCount = readdirSync(folderPath, { withFileTypes: true })
      .filter((item) => item.isFile() && PET_STYLE_VIDEO_EXTENSIONS.some((ext) => item.name.toLowerCase().endsWith(ext)))
      .length;
  } catch { /* use the already read list */ }
  return { ok: true, files, states, totalBytes, ignoredCount: Math.max(0, allVideoCount - videoFiles.length) };
}

async function importPetStyleFolder(event: Electron.IpcMainInvokeEvent): Promise<PetStyleActionResult> {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow ?? undefined;
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, { title: "导入带 Alpha 通道的宠物视频文件夹", properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ title: "导入带 Alpha 通道的宠物视频文件夹", properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, detail: "已取消导入。" };

  const validation = await validatePetStyleFolder(result.filePaths[0]);
  if (!validation.ok) return validation;

  const style: PetStyle = {
    id: `style-${randomUUID()}`,
    name: nextImportedPetStyleName(),
    source: "imported",
    createdAt: new Date().toISOString(),
    configuredStates: validation.states,
    customStates: [],
  };
  const destination = petStyleDirectoryPath(style.id);
  try {
    mkdirSync(destination, { recursive: true });
    for (const state of validation.states) {
      copyFileSync(validation.files[state]!.importPath, join(destination, PET_STYLE_ACTION_FILES[state]));
    }
    petSettings.petStyles = normalizePetStyles([...petSettings.petStyles, style]);
    savePetSettings();
    broadcastPetSettings();
    const ignoredDetail = validation.ignoredCount > 0 ? `已按文件名排序使用前 ${PET_STATES.length} 个视频，忽略多出的 ${validation.ignoredCount} 个。` : "";
    return { ok: true, detail: `宠物风格已导入。${ignoredDetail}文件已自动命名并映射到状态，请确认视频确实带有 Alpha 通道，再保存并启用它。`, style, settings: getPetSettings() };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    console.warn("Unable to import pet style.", error);
    return { ok: false, detail: "宠物风格导入失败，请检查文件夹权限或重新导出视频。" };
  } finally {
    cleanupPreparedPetStyleFiles(Object.values(validation.files).filter((file): file is PreparedPetStyleFile => Boolean(file)));
  }
}

function nextImportedPetStyleName(): string {
  const existingNames = new Set(petSettings.petStyles.map((style) => style.name.toLowerCase()));
  let index = 1;
  while (existingNames.has(`导入风格 ${index}`.toLowerCase())) index += 1;
  return `导入风格 ${index}`;
}

function styleWithImportedState(style: PetStyle, state: PetState): PetStyle {
  const configuredStates = Array.from(new Set([...(style.configuredStates ?? []), state]));
  return {
    ...style,
    source: "imported",
    configuredStates: PET_STATES.filter((item) => configuredStates.includes(item)),
    customStates: style.customStates ?? [],
  };
}

async function importPetStyleState(event: Electron.IpcMainInvokeEvent, rawStyleId: unknown, rawState: unknown): Promise<PetStyleActionResult> {
  const requestedStyleId = typeof rawStyleId === "string" ? rawStyleId.trim() : "";
  const state = isPetState(rawState) ? rawState : undefined;
  const originalStyle = petSettings.petStyles.find((item) => item.id === requestedStyleId);
  if (!originalStyle || !state) return { ok: false, detail: "宠物状态参数无效。" };
  if (originalStyle.source === "builtin") {
    return { ok: false, detail: "默认企鹅的内置状态不支持导入或替换；请使用“添加自定义状态”增加可播放状态。" };
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow ?? undefined;
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, { title: `导入${PET_STYLE_STATE_LABELS[state]}视频`, properties: ["openFile"], filters: [{ name: "Alpha 视频", extensions: ["webm", "mov"] }] })
    : await dialog.showOpenDialog({ title: `导入${PET_STYLE_STATE_LABELS[state]}视频`, properties: ["openFile"], filters: [{ name: "Alpha 视频", extensions: ["webm", "mov"] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, detail: "已取消导入。" };
  const sourcePath = result.filePaths[0];
  const validation = await preparePetStyleFile(sourcePath);
  if (!validation.ok) return validation;

  const style = originalStyle;
  const destination = petStyleDirectoryPath(style.id);
  try {
    mkdirSync(destination, { recursive: true });
    copyFileSync(validation.file.importPath, join(destination, PET_STYLE_ACTION_FILES[state]));
    const updatedStyle = styleWithImportedState(style, state);
    petSettings.petStyles = normalizePetStyles(petSettings.petStyles.map((item) => item.id === style.id ? updatedStyle : item));
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: `${PET_STYLE_STATE_LABELS[state]}状态已导入。`, style: updatedStyle, settings: getPetSettings() };
  } catch (error) {
    try { unlinkSync(join(destination, PET_STYLE_ACTION_FILES[state])); } catch { /* best effort cleanup */ }
    console.warn("Unable to import pet style state.", error);
    return { ok: false, detail: "宠物状态导入失败，请检查文件权限或重新导出视频。" };
  } finally {
    cleanupPreparedPetStyleFile(validation.file);
  }
}

async function addCustomPetState(event: Electron.IpcMainInvokeEvent, rawStyleId: unknown, rawName: unknown): Promise<PetStyleActionResult> {
  const requestedStyleId = typeof rawStyleId === "string" ? rawStyleId.trim() : "";
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 24) : "";
  const originalStyle = petSettings.petStyles.find((item) => item.id === requestedStyleId);
  if (!originalStyle) return { ok: false, detail: "找不到要编辑的宠物风格，请先选择一套风格。" };
  if (!name) return { ok: false, detail: "自定义状态名称无效，请填写一个非空名称。" };
  if ((originalStyle.customStates ?? []).some((state) => state.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, detail: "这个自定义状态名称已经存在。" };
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow ?? undefined;
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, { title: `导入“${name}”状态视频`, properties: ["openFile"], filters: [{ name: "Alpha 视频", extensions: ["webm", "mov"] }] })
    : await dialog.showOpenDialog({ title: `导入“${name}”状态视频`, properties: ["openFile"], filters: [{ name: "Alpha 视频", extensions: ["webm", "mov"] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, detail: "已取消导入。" };
  const sourcePath = result.filePaths[0];
  const validation = await preparePetStyleFile(sourcePath);
  if (!validation.ok) return validation;

  const style = originalStyle;
  const customId = `custom-${randomUUID()}`;
  const customState: PetStyleCustomState = {
    id: customId,
    name,
    fileName: `${customId}.webm`,
    createdAt: new Date().toISOString(),
  };
  const destination = petStyleDirectoryPath(style.id);
  try {
    mkdirSync(destination, { recursive: true });
    copyFileSync(validation.file.importPath, join(destination, customState.fileName));
    const updatedStyle: PetStyle = {
      ...style,
      configuredStates: style.configuredStates ?? (style.source === "builtin" ? [...PET_STATES] : []),
      customStates: [...(style.customStates ?? []), customState],
    };
    petSettings.petStyles = normalizePetStyles(petSettings.petStyles.map((item) => item.id === style.id ? updatedStyle : item));
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: `已添加“${name}”状态。`, style: updatedStyle, settings: getPetSettings() };
  } catch (error) {
    try { unlinkSync(join(destination, customState.fileName)); } catch { /* best effort cleanup */ }
    console.warn("Unable to add custom pet state.", error);
    return { ok: false, detail: "自定义状态添加失败，请检查文件权限或重新导出视频。" };
  } finally {
    cleanupPreparedPetStyleFile(validation.file);
  }
}

function removeCustomPetState(styleId: string, customStateId: string): PetStyleActionResult {
  const style = petSettings.petStyles.find((item) => item.id === styleId);
  const customState = style?.customStates?.find((item) => item.id === customStateId);
  if (!style || !customState) return { ok: false, detail: "找不到这个自定义状态。" };
  try {
    const customFilePath = join(petStyleDirectoryPath(style.id), customState.fileName);
    if (existsSync(customFilePath)) unlinkSync(customFilePath);
    const nextStyle = {
      ...style,
      customStates: style.customStates?.filter((item) => item.id !== customStateId) ?? [],
    };
    petSettings.petStyles = normalizePetStyles(petSettings.petStyles.map((item) => item.id === style.id ? nextStyle : item));
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: `已删除“${customState.name}”状态。`, style: nextStyle, settings: getPetSettings() };
  } catch (error) {
    console.warn("Unable to remove custom pet state.", error);
    return { ok: false, detail: "自定义状态删除失败，请稍后重试。" };
  }
}

function removePetStyle(styleId: string): PetStyleActionResult {
  const style = petSettings.petStyles.find((item) => item.id === styleId);
  if (!style || style.source !== "imported") return { ok: false, detail: "只能删除已导入的宠物风格。" };
  try {
    rmSync(petStyleDirectoryPath(style.id), { recursive: true, force: true });
    petSettings.petStyles = petSettings.petStyles.filter((item) => item.id !== style.id);
    if (petSettings.activePetStyleId === style.id) petSettings.activePetStyleId = DEFAULT_PET_STYLE_ID;
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: "宠物风格已删除。", settings: getPetSettings() };
  } catch (error) {
    console.warn("Unable to remove pet style.", error);
    return { ok: false, detail: "宠物风格删除失败，请稍后重试。" };
  }
}

function isPetTheme(value: unknown): value is PetTheme {
  return value === "minimal" || value === "soft" || value === "night";
}

function upsertWeChatAccount(tokenFile: string, preferredDisplayName = ""): WeChatAccount {
  const normalizedTokenFile = tokenFile.trim();
  const session = loadSession(normalizedTokenFile);
  const id = weChatAccountId(normalizedTokenFile);
  const existing = petSettings.wechatAccounts.find((account) => account.id === id || account.tokenFile === normalizedTokenFile);
  const account = {
    id: existing?.id ?? id,
    displayName: existing?.displayName ?? weChatAccountDisplayName(normalizedTokenFile, preferredDisplayName || session?.accountId),
    tokenFile: normalizedTokenFile,
    agentId: existing?.agentId || fallbackAgentId(),
    taskNotificationEnabled: existing?.taskNotificationEnabled ?? false,
    taskNotificationMode: existing?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
  };
  petSettings.wechatAccounts = [
    ...petSettings.wechatAccounts.filter((item) => item.id !== account.id && item.tokenFile !== normalizedTokenFile),
    account,
  ];
  return account;
}

async function getAgentControllerStatus(): Promise<AgentControllerStatus> {
  const settings = getPetSettings();
  const discovered = await discoverLocalAgents();
  const visibleConfigs = settings.agentConfigs.filter((config) => config.agentCardVisible !== false);
  const configuredAgents = visibleConfigs.map((config) => {
    const commandMatch = discovered.find((item) => item.command?.toLowerCase() === config.command.toLowerCase());
    const providerMatch = discovered.find((item) => item.provider === config.provider);
    const match = commandMatch ?? providerMatch;
    let state: AgentControllerStatus["agents"][number]["state"] = config.enabled ? "configured" : "disabled";
    let detail = config.enabled ? "已配置，尚未完成控制器能力探测" : "已停用";

    if (config.enabled && match?.status === "available") {
      state = "available";
      detail = config.sourceApp === "openclaw"
        ? "命令可用；OpenClaw Gateway 会话适配已启用"
        : config.provider === "codex"
          ? "命令可用；Codex app-server 主通道，CLI 自动兜底"
          : config.provider === "hermes"
            ? "命令可用；Hermes CLI 失败时使用 CCS API 兜底"
            : "命令可用；本机 Agent 适配已启用";
    } else if (config.enabled && match && match.status !== "available") {
      state = "unavailable";
      detail = match.detail;
    }

    return {
      id: config.id,
      displayName: config.displayName,
      provider: config.provider,
      state,
      detail,
    };
  });
  const primary = configuredAgents.find((agent) => agent.id === settings.activeAgentId) ?? configuredAgents[0];
  const primaryConfig = visibleConfigs.find((config) => config.id === primary?.id);
  const primaryExecutionDetail = settings.agentPermissionPolicy === "allow-tools"
    ? (primaryConfig?.ccSwitchCurrentConfig
      ? "工具权限已开启：CC Switch 仅提供当前配置，本次请求将走本机 Agent 适配器"
      : "工具权限已开启：本次请求将走本机 Agent 适配器")
    : "当前为仅聊天：请求走 API 回复，不会调用本机工具或控制电脑";
  const threadSupport: AgentControllerStatus["threadSupport"] = visibleConfigs.map((config) => {
    const commandAvailable = discovered.some((item) => item.command?.toLowerCase() === config.command.toLowerCase() && item.status === "available");
    const supported = commandAvailable && (config.provider === "codex" || config.provider === "claude" || config.provider === "hermes" || config.sourceApp === "openclaw");
    return {
      agentId: config.id,
      state: supported ? "available" : "unavailable",
      detail: config.sourceApp === "openclaw"
        ? "OpenClaw 使用独立 session-key 适配，返回结果不会走普通命令参数"
        : config.provider === "codex"
          ? "Codex 使用 app-server，连接失败自动切换 CLI 单次会话"
          : config.provider === "hermes"
            ? "Hermes 使用 CLI，认证失败自动切换 CCS API 配置"
            : config.provider === "claude"
              ? "Claude 使用本机 CLI 适配"
              : "当前 Agent 暂无专用会话适配",
    };
  });

  // 运行通道事实标签：只描述真实策略（Codex 为 app-server 优先、失败 CLI 兜底），
  // 不把 primaryAgentName（如“Codex CLI”卡片名）当成运行通道事实。
  const primaryAgentProvider = primary?.provider ?? "custom";
  const primaryAgentRuntime = primaryConfig?.sourceApp === "openclaw"
    ? "OpenClaw Gateway 会话适配"
    : primaryAgentProvider === "codex"
      ? "app-server 优先 / CLI 兜底"
      : primaryAgentProvider === "hermes"
        ? "CLI 优先 / CCS API 兜底"
        : primaryAgentProvider === "claude"
          ? "本机 CLI 适配"
          : "自定义命令适配";
  return {
    mode: "read-only",
    primaryAgentId: primary?.id ?? settings.activeAgentId,
    primaryAgentName: primary?.displayName ?? "未配置主 Agent",
    primaryAgentState: primary?.state ?? "unavailable",
    primaryAgentProvider,
    primaryAgentRuntime,
    approvalMode: settings.agentApprovalMode,
    capabilityPolicy: settings.agentCapabilityPolicy,
    agents: configuredAgents,
    threadSupport,
    detail: primaryExecutionDetail,
    updatedAt: Date.now(),
  };
}

function loadPetSettings(): void {
  try {
    const filePath = join(app.getPath("userData"), PET_SETTINGS_FILE);
    if (!existsSync(filePath)) return;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) return;

    const saved = parsed;
    let needsMigration = saved.schemaVersion !== PET_SETTINGS_SCHEMA_VERSION;
    if (isPetTheme(saved.theme)) petSettings.theme = saved.theme;
    else needsMigration = true;
    petSettings.petStyles = normalizePetStyles(saved.petStyles);
    const savedPetStyleId = typeof saved.activePetStyleId === "string" ? saved.activePetStyleId : DEFAULT_PET_STYLE_ID;
    petSettings.activePetStyleId = petSettings.petStyles.some((style) => style.id === savedPetStyleId)
      ? savedPetStyleId
      : DEFAULT_PET_STYLE_ID;
    needsMigration ||= saved.activePetStyleId !== petSettings.activePetStyleId;
    const normalizedPerception = normalizePetPerceptionSettings(saved.petPerception);
    petSettings.petPerception = normalizedPerception;
    needsMigration ||= JSON.stringify(saved.petPerception) !== JSON.stringify(normalizedPerception);
    const taskNotificationPlatform = normalizeTaskNotificationPlatform(saved.taskNotificationPlatform);
    petSettings.taskNotificationPlatform = taskNotificationPlatform;
    needsMigration ||= saved.taskNotificationPlatform !== taskNotificationPlatform;
    const taskNotificationMode = normalizeTaskNotificationMode(saved.taskNotificationMode);
    petSettings.taskNotificationMode = taskNotificationMode;
    needsMigration ||= saved.taskNotificationMode !== taskNotificationMode;
    const normalizedPetName = normalizeCallName(saved.petName, DEFAULT_PET_NAME);
    const normalizedUserName = normalizeCallName(saved.userName, DEFAULT_USER_NAME);
    petSettings.petName = normalizedPetName;
    petSettings.userName = normalizedUserName;
    needsMigration ||= saved.petName !== normalizedPetName || saved.userName !== normalizedUserName;
    if (typeof saved.alwaysOnTop === "boolean") {
      petSettings.alwaysOnTop = saved.alwaysOnTop;
      keepWindowOnTop = saved.alwaysOnTop;
    }
    if (typeof saved.showWeChatBubbles === "boolean") petSettings.showWeChatBubbles = saved.showWeChatBubbles;
    if (typeof saved.showThinkingBubbles === "boolean") petSettings.showThinkingBubbles = saved.showThinkingBubbles;
    if (typeof saved.wechatTokenFile === "string") petSettings.wechatTokenFile = saved.wechatTokenFile;
    if (typeof saved.wechatEnabled === "boolean") petSettings.wechatEnabled = saved.wechatEnabled;
    if (typeof saved.screenCaptureDisplayId === "string") petSettings.screenCaptureDisplayId = saved.screenCaptureDisplayId.trim();
    petSettings.wechatAllowedUserIds = normalizeWeChatUserIds(saved.wechatAllowedUserIds);
    if (typeof saved.agentFullAccess === "boolean") petSettings.agentFullAccess = saved.agentFullAccess;
    if (isAgentPermissionPolicy(saved.agentPermissionPolicy)) petSettings.agentPermissionPolicy = saved.agentPermissionPolicy;
    petSettings.wechatAccounts = normalizeWeChatAccounts(saved.wechatAccounts);
    if (petSettings.wechatAccounts.length === 0 && petSettings.wechatTokenFile) {
      const migratedAccount = upsertWeChatAccount(petSettings.wechatTokenFile);
      petSettings.activeWeChatAccountId = migratedAccount.id;
    } else if (petSettings.wechatAccounts.length > 0) {
      const savedActiveId = typeof saved.activeWeChatAccountId === "string" ? saved.activeWeChatAccountId : "";
      const activeAccount =
        petSettings.wechatAccounts.find((account) => account.id === savedActiveId) ??
        petSettings.wechatAccounts.find((account) => account.tokenFile === petSettings.wechatTokenFile) ??
        petSettings.wechatAccounts[0];
      petSettings.activeWeChatAccountId = activeAccount.id;
      petSettings.wechatTokenFile = activeAccount.tokenFile;
    }
    petSettings.qqAccounts = normalizeQQAccounts(saved.qqAccounts);
    const savedActiveQQId = typeof saved.activeQQAccountId === "string" ? saved.activeQQAccountId : "";
    petSettings.activeQQAccountId = petSettings.qqAccounts.find((account) => account.id === savedActiveQQId)?.id
      ?? petSettings.qqAccounts[0]?.id
      ?? "";
    petSettings.feishuAccounts = normalizeFeishuAccounts(saved.feishuAccounts);
    const savedActiveFeishuId = typeof saved.activeFeishuAccountId === "string" ? saved.activeFeishuAccountId : "";
    petSettings.activeFeishuAccountId = petSettings.feishuAccounts.find((account) => account.id === savedActiveFeishuId)?.id
      ?? petSettings.feishuAccounts[0]?.id
      ?? "";
    petSettings.dingtalkAccounts = normalizeDingTalkAccounts(saved.dingtalkAccounts);
    const savedActiveDingTalkId = typeof saved.activeDingTalkAccountId === "string" ? saved.activeDingTalkAccountId : "";
    petSettings.activeDingTalkAccountId = petSettings.dingtalkAccounts.find((account) => account.id === savedActiveDingTalkId)?.id
      ?? petSettings.dingtalkAccounts[0]?.id
      ?? "";
    const agentProvider = normalizeAgentProvider(saved.agentProvider) ?? "claude";
    needsMigration ||= saved.agentProvider !== agentProvider;
    if (Array.isArray(saved.agentConfigs)) {
      const normalizedAgentConfigs = normalizeAgentConfigs(saved.agentConfigs);
      needsMigration ||= saved.agentConfigs.some((candidate) => isRecord(candidate)
        && (Object.prototype.hasOwnProperty.call(candidate, "ccSwitchApiProfiles")
          || Object.prototype.hasOwnProperty.call(candidate, "selectedCcSwitchApiProfileId")));
      const migratedAgentConfigs = migrateLegacyCcSwitchAgentConfigs(normalizedAgentConfigs);
      const canonicalizedAgentConfigs = canonicalizeAgentConfigs(migratedAgentConfigs.configs);
      petSettings.agentConfigs = canonicalizedAgentConfigs.configs;
      needsMigration ||= migratedAgentConfigs.changed || canonicalizedAgentConfigs.changed;
    } else {
      needsMigration = true;
    }
    const activeAgentId = resolveActiveAgentId(saved.activeAgentId, petSettings.agentConfigs, agentProvider);
    petSettings.activeAgentId = activeAgentId;
    const activeAgent = petSettings.agentConfigs.find((config) => config.id === activeAgentId);
    petSettings.agentProvider = activeAgent?.provider ?? agentProvider;
    needsMigration ||= saved.activeAgentId !== activeAgentId || saved.agentProvider !== petSettings.agentProvider;
    petSettings.agentCapabilityPolicy = normalizeAgentCapabilityPolicy(saved.agentCapabilityPolicy);
    petSettings.agentApprovalMode = normalizeAgentApprovalMode(saved.agentApprovalMode);
    petSettings.agentFallbackIds = normalizeAgentFallbackIds(saved.agentFallbackIds, petSettings.agentConfigs, activeAgentId);
    needsMigration ||= JSON.stringify(saved.agentCapabilityPolicy) !== JSON.stringify(petSettings.agentCapabilityPolicy)
      || saved.agentApprovalMode !== petSettings.agentApprovalMode
      || JSON.stringify(saved.agentFallbackIds) !== JSON.stringify(petSettings.agentFallbackIds);
    if (typeof saved.ccSwitchSyncEnabled === "boolean") petSettings.ccSwitchSyncEnabled = saved.ccSwitchSyncEnabled;
    needsMigration ||= saved.ccSwitchSyncEnabled !== petSettings.ccSwitchSyncEnabled;
    const normalizedZeroToken = normalizeZeroTokenSettings(saved.zeroToken);
    petSettings.zeroToken = normalizedZeroToken;
    needsMigration ||= JSON.stringify(saved.zeroToken) !== JSON.stringify(normalizedZeroToken);
    if (typeof saved.saveChatHistory === "boolean") petSettings.saveChatHistory = saved.saveChatHistory;
    const codexSandboxMode = normalizeCodexSandboxMode(saved.codexSandboxMode);
    if (codexSandboxMode) {
      petSettings.codexSandboxMode = codexSandboxMode;
      needsMigration ||= saved.codexSandboxMode !== codexSandboxMode;
    }
    needsMigration ||= saved.agentFullAccess !== petSettings.agentFullAccess;
    needsMigration ||= applyAgentFullAccessPolicy();
    needsMigration ||= normalizeBotAgentBindings();
    needsMigration ||= migrateLegacyBotTaskNotificationSettings(saved);

    if (needsMigration) savePetSettings();
  } catch (error) {
    console.warn("Unable to load pet settings; using defaults.", error);
  }
}

function localAgentMatchesDiscovery(config: AgentConfig, discovered: LocalAgentInfo): boolean {
  if (config.source !== "builtin" && config.source !== "discovered") return false;
  if (config.sourceApp && discovered.sourceApp && config.sourceApp === discovered.sourceApp) return true;
  if (config.source === "builtin" && config.provider && discovered.provider === config.provider) return true;
  return Boolean(config.command && discovered.command && config.command.toLowerCase() === discovered.command.toLowerCase());
}

async function reconcileLocalAgentRegistry(): Promise<void> {
  const discovered = await discoverLocalAgents();
  let changed = false;
  const nextConfigs = petSettings.agentConfigs.map((config) => {
    const match = discovered.find((candidate) => localAgentMatchesDiscovery(config, candidate));
    if (!match || config.source === "manual") return config;
    const shouldHide = match.status === "not-installed" || match.status === "desktop-only";
    if (shouldHide && config.agentCardVisible !== false) {
      changed = true;
      return { ...config, agentCardVisible: false };
    }
    return config;
  });
  const canonicalized = canonicalizeAgentConfigs(nextConfigs);
  const finalConfigs = canonicalized.configs;
  const activeAgentId = resolveActiveAgentId(petSettings.activeAgentId, finalConfigs, petSettings.agentProvider);
  const activeAgent = finalConfigs.find((config) => config.id === activeAgentId);
  const fallbackIds = normalizeAgentFallbackIds(petSettings.agentFallbackIds, finalConfigs, activeAgentId);
  changed ||= activeAgentId !== petSettings.activeAgentId
    || activeAgent?.provider !== petSettings.agentProvider
    || JSON.stringify(fallbackIds) !== JSON.stringify(petSettings.agentFallbackIds)
    || canonicalized.changed;
  petSettings.agentConfigs = finalConfigs;
  petSettings.activeAgentId = activeAgentId;
  petSettings.agentProvider = activeAgent?.provider ?? petSettings.agentProvider;
  petSettings.agentFallbackIds = fallbackIds;
  if (changed) {
    savePetSettings();
    broadcastPetSettings();
  }
}

function ccSwitchProfileMatchesConfig(profile: CcSwitchAgentProfile, config: AgentConfig): boolean {
  if (config.source === "cc-switch") return false;
  if (config.sourceApp && config.sourceApp === profile.app) return true;
  const normalizedCommand = config.command.trim().toLowerCase();
  if (profile.app === "claude-code" && config.provider === "claude" && (config.id === "claude" || normalizedCommand === "claude")) return true;
  if (profile.app === "codex" && config.provider === "codex" && (config.id === "codex" || normalizedCommand === "codex")) return true;
  if (profile.app === "hermes" && config.provider === "hermes" && (config.id === "hermes" || normalizedCommand === "hermes")) return true;
  return false;
}

function ccSwitchCurrentConfigKey(config: CcSwitchCurrentConfig | undefined): string {
  if (!config) return "";
  return JSON.stringify({ ...config, lastSyncedAt: 0 });
}

function bindCcSwitchProfiles(sourceIds?: string[]): CcSwitchImportResult {
  if (petSettings.zeroToken.enabled) {
    return { ok: false, detail: "Zero Token 模式已启用，CCS 导入暂时不可用；关闭后可恢复", boundCount: 0, skippedCount: 0 };
  }
  if (!petSettings.ccSwitchSyncEnabled) {
    return { ok: false, detail: "CC Switch 当前配置引用已关闭", boundCount: 0, skippedCount: 0 };
  }

  const profiles = readCcSwitchProfilesCached();
  const requestedIds = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
  const selectedProfiles = requestedIds
    ? profiles.filter((profile) => requestedIds.has(profile.sourceId))
    : profiles;
  if (selectedProfiles.length === 0) {
    return { ok: false, detail: "未发现可匹配的 CC Switch Agent 配置", boundCount: 0, skippedCount: requestedIds?.size ?? 0 };
  }

  let boundCount = 0;
  let changed = false;
  const nextConfigs = petSettings.agentConfigs.map((config) => ({ ...config }));
  for (const profile of selectedProfiles) {
    const configIndex = nextConfigs.findIndex((config) => ccSwitchProfileMatchesConfig(profile, config));
    if (configIndex < 0) continue;
    const config = nextConfigs[configIndex];
    const current = profile.currentConfig;
    const stableCurrent = current && ccSwitchCurrentConfigKey(config.ccSwitchCurrentConfig) === ccSwitchCurrentConfigKey(current)
      ? { ...current, lastSyncedAt: config.ccSwitchCurrentConfig?.lastSyncedAt ?? current.lastSyncedAt }
      : current ?? undefined;
    const nextConfig: AgentConfig = {
      ...config,
      sourceApp: config.sourceApp ?? profile.app,
      providerName: stableCurrent?.providerName ?? null,
      model: stableCurrent?.model ?? null,
      baseUrlHost: stableCurrent?.baseUrlHost ?? null,
      iconKey: stableCurrent?.iconKey ?? config.iconKey,
      iconColor: stableCurrent?.iconColor ?? config.iconColor ?? null,
      modelIconKey: stableCurrent?.modelIconKey ?? null,
      syncState: stableCurrent ? "synced" : "unavailable",
      executionSupport: stableCurrent?.executionSupport ?? config.executionSupport ?? "supported",
      ccSwitchCurrentConfig: stableCurrent,
    };
    if (JSON.stringify(config) !== JSON.stringify(nextConfig)) {
      nextConfigs[configIndex] = nextConfig;
      changed = true;
    }
    boundCount += 1;
  }

  if (!requestedIds) {
    const profileApps = new Set(profiles.map((profile) => profile.app));
    for (let index = 0; index < nextConfigs.length; index += 1) {
      const config = nextConfigs[index];
      if (!config.ccSwitchCurrentConfig || !config.sourceApp || profileApps.has(config.sourceApp)) continue;
      nextConfigs[index] = {
        ...config,
        providerName: null,
        model: null,
        baseUrlHost: null,
        syncState: "unavailable",
        ccSwitchCurrentConfig: undefined,
      };
      changed = true;
    }
  }

  if (changed) {
    petSettings.agentConfigs = canonicalizeAgentConfigs(normalizeAgentConfigs(nextConfigs)).configs;
    petSettings.activeAgentId = resolveActiveAgentId(petSettings.activeAgentId, petSettings.agentConfigs, petSettings.agentProvider);
    petSettings.agentProvider = petSettings.agentConfigs.find((config) => config.id === petSettings.activeAgentId)?.provider ?? petSettings.agentProvider;
    petSettings.agentFallbackIds = normalizeAgentFallbackIds(petSettings.agentFallbackIds, petSettings.agentConfigs, petSettings.activeAgentId);
    savePetSettings();
    broadcastPetSettings();
  }

  return {
    ok: boundCount > 0,
    detail: boundCount > 0
      ? `已将 ${boundCount} 个 CC Switch 当前配置绑定到本机 Agent；未匹配的 CCS 项未创建卡片`
      : "没有匹配到本机 Agent；CCS-only 配置不会创建 Penguin 卡片",
    boundCount,
    skippedCount: Math.max(0, selectedProfiles.length - boundCount),
  };
}

function savePetSettings(): void {
  try {
    const filePath = join(app.getPath("userData"), PET_SETTINGS_FILE);
    writeFileSync(
      filePath,
      `${JSON.stringify({ schemaVersion: PET_SETTINGS_SCHEMA_VERSION, ...getPetSettings() }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("Unable to save pet settings.", error);
  }
}

function getPetSettings(): PetSettings {
  return { ...petSettings, alwaysOnTop: keepWindowOnTop };
}

async function getScreenCaptureFollowStatus(rawAgentId?: unknown) {
  const settings = getPetSettings();
  const requestedId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const config = settings.agentConfigs.find((item) => item.id === requestedId)
    ?? settings.agentConfigs.find((item) => item.id === settings.activeAgentId)
    ?? settings.agentConfigs[0];
  if (config && agentWindowTracker) {
    agentWindowTracker.setConfigs(settings.agentConfigs);
    const snapshot = await agentWindowTracker.getSnapshot(config.id);
    if (snapshot) return toAgentWindowFollowStatus(snapshot);
  }
  const display = getSystemDefaultDisplay();
  return {
    agentId: config?.id ?? "",
    agentName: config?.displayName ?? "当前 Agent",
    displayId: String(display.id),
    displayLabel: display.label || String(display.id),
    displayBounds: { ...display.bounds },
    logicalWidth: Math.round(display.bounds.width),
    logicalHeight: Math.round(display.bounds.height),
    pixelWidth: Math.max(1, Math.round(display.bounds.width * (display.scaleFactor || 1))),
    pixelHeight: Math.max(1, Math.round(display.bounds.height * (display.scaleFactor || 1))),
    scaleFactor: display.scaleFactor || 1,
    source: "system-default" as const,
    processId: null,
    processName: null,
    windowHandle: null,
    windowTitle: null,
    windowRect: null,
    nativeDisplayRegion: null,
    updatedAt: Date.now(),
  };
}

function isTrustedAppWindowSender(sender: Electron.WebContents): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  return Boolean(ownerWindow && (ownerWindow === mainWindow || ownerWindow === settingsWindow));
}

function ensureAgentBridgeCredentials(): { token: string; tokenFile?: string } {
  const tokenFile = join(app.getPath("userData"), AGENT_BRIDGE_TOKEN_FILE);
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    // The first launch has no token file yet.
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    token = randomBytes(32).toString("hex");
    try {
      writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn("Unable to persist Agent bridge token; using an in-memory token for this launch.", error);
      return { token };
    }
  }
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    // Windows ACLs are inherited from the user-data directory; chmod is best effort.
  }
  return { token, tokenFile };
}

function managedDataFilePaths(): string[] {
  const userDataPath = app.getPath("userData");
  return [
    ...MANAGED_DATA_FILE_NAMES.flatMap((fileName) => [join(userDataPath, fileName), join(userDataPath, `${fileName}.tmp`)]),
    join(userDataPath, "memory"),
    petStyleRootPath(),
  ];
}

function countManagedDataFiles(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    if (!statSync(filePath).isDirectory()) return 1;
    return readdirSync(filePath, { withFileTypes: true }).reduce(
      (count, entry) => count + countManagedDataFiles(join(filePath, entry.name)),
      0,
    );
  } catch {
    return 0;
  }
}

function copyManagedDataPath(source: string, backup: string): void {
  if (statSync(source).isDirectory()) cpSync(source, backup, { recursive: true });
  else copyFileSync(source, backup);
}

function removeManagedDataPath(source: string): void {
  if (statSync(source).isDirectory()) rmSync(source, { recursive: true, force: true });
  else unlinkSync(source);
}

function emptyChatHistorySummary(): ChatHistorySummary {
  return { conversationCount: 0, messageCount: 0, lastTimestamp: null, providers: [] };
}

function buildLocalDataSummary(): LocalDataSummary {
  const userDataPath = app.getPath("userData");
  const channelHistoryFile = join(userDataPath, "channel-history.json");
  const wechatHistoryFile = join(userDataPath, "wechat-history.json");
  const wechatCredentialsFile = join(userDataPath, "wechat-credentials.json");
  const qqCredentialsFile = join(userDataPath, "qq-credentials.json");
  const feishuCredentialsFile = join(userDataPath, "feishu-credentials.json");
  const dingtalkCredentialsFile = join(userDataPath, "dingtalk-credentials.json");
  const wechatEventsFile = join(userDataPath, "wechat-events.jsonl");
  const managedDataFileCount = managedDataFilePaths().reduce((count, filePath) => count + countManagedDataFiles(filePath), 0);
  return {
    managedDataFileCount,
    settingsFilePresent: existsSync(join(userDataPath, PET_SETTINGS_FILE)),
    history: {
      channel: channelHistory?.summary() ?? emptyChatHistorySummary(),
      wechat: weChatBridge?.getChatHistorySummary() ?? emptyChatHistorySummary(),
      channelFilePresent: existsSync(channelHistoryFile),
      wechatFilePresent: existsSync(wechatHistoryFile),
    },
    credentials: {
      wechatFilePresent: existsSync(wechatCredentialsFile),
      qqFilePresent: existsSync(qqCredentialsFile),
      feishuFilePresent: existsSync(feishuCredentialsFile),
      dingtalkFilePresent: existsSync(dingtalkCredentialsFile),
      systemEncryptionAvailable: Boolean(qqCredentialStore?.available || feishuCredentialStore?.available || dingtalkCredentialStore?.available || weChatBridge?.isCredentialStoreAvailable()),
    },
    eventLogs: {
      wechatFilePresent: existsSync(wechatEventsFile),
    },
    externalFiles: {
      configuredWeChatSessionCount: petSettings.wechatAccounts.filter((account) => Boolean(account.tokenFile.trim())).length,
    },
    memory: memoryStore?.summary(),
  };
}

async function stopChannelsForDataReset(): Promise<void> {
  await weChatBridge?.stop();
  qqQrLoginManager.cancel();
  feishuQrLoginManager.cancel();
  await Promise.all([...qqChannelAdapters.values()].map((adapter) => adapter.stop().catch(() => undefined)));
  await Promise.all([...feishuChannelAdapters.values()].map((adapter) => adapter.stop().catch(() => undefined)));
  await Promise.all([...dingtalkChannelAdapters.values()].map((adapter) => adapter.stop().catch(() => undefined)));
}

async function deleteManagedData(): Promise<LocalDataActionResult> {
  if (dataDeletionInProgress) return { ok: false, detail: "数据清理正在进行，请稍候。" };
  if (channelReplyQueues.size > 0 || weChatBridge?.hasPendingReplies) {
    return { ok: false, detail: "当前仍有消息正在处理，请等待回复完成后再清理数据。" };
  }

  dataDeletionInProgress = true;
  const sources = managedDataFilePaths().filter((filePath) => existsSync(filePath));
  if (sources.length === 0) {
    dataDeletionInProgress = false;
    return { ok: true, detail: "没有发现可删除的应用托管数据。", summary: buildLocalDataSummary() };
  }

  const stagingDir = join(app.getPath("temp"), `penguin-delete-${Date.now()}`);
  const staged = sources.map((source) => ({ source, backup: join(stagingDir, `${sources.indexOf(source)}-${basename(source)}`) }));
  try {
    await stopChannelsForDataReset();
    memoryStore?.close();
    memoryStore = null;
    memoryRetriever = null;
    memoryObserver = null;
    mkdirSync(stagingDir, { recursive: true });
    for (const item of staged) copyManagedDataPath(item.source, item.backup);
    for (const item of staged) {
      if (existsSync(item.source)) removeManagedDataPath(item.source);
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("Managed-data staging cleanup is pending.", cleanupError);
    }
    dataDeletionInProgress = false;
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 250);
    return { ok: true, detail: "应用托管数据已删除，应用即将重启；外部微信会话文件和 Agent 登录状态未删除。" };
  } catch (error) {
    for (const item of staged) {
      try {
        if (existsSync(item.backup) && !existsSync(item.source)) copyManagedDataPath(item.backup, item.source);
      } catch {
        // Keep attempting the remaining files so the caller receives a complete failure state.
      }
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("Unable to remove managed-data rollback staging.", cleanupError);
    }
    dataDeletionInProgress = false;
    console.warn("Unable to delete managed data; attempted rollback.", error);
    if (!memoryStore) {
      try {
        memoryStore = new MemoryStore({ userDataPath: app.getPath("userData") });
        memoryRetriever = new MemoryRetriever(memoryStore);
        memoryObserver = new MemoryObserver(memoryStore);
      } catch { /* keep the rollback result actionable */ }
    }
    return { ok: false, detail: "应用托管数据清理失败，已尝试恢复原文件，请稍后重试。", summary: buildLocalDataSummary() };
  }
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex" || value === "hermes" || value === "custom";
}

function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  if (isAgentProvider(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "claude" || normalized === "claude-code" || normalized === "claude-cli") return "claude";
  if (normalized === "codex" || normalized === "codex-cli") return "codex";
  if (normalized === "hermes" || normalized === "hermes-agent" || normalized === "hermes-cli") return "hermes";
  if (normalized === "custom" || normalized === "custom-agent") return "custom";
  return undefined;
}

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function normalizeCodexSandboxMode(value: unknown): CodexSandboxMode | undefined {
  if (isCodexSandboxMode(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "read-only" || normalized === "readonly") return "read-only";
  if (normalized === "workspace-write" || normalized === "workspacewrite") return "workspace-write";
  if (normalized === "danger-full-access" || normalized === "dangerfullaccess") return "danger-full-access";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function broadcastPetSettings(): void {
  const settings = getPetSettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings:changed", settings);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings:changed", settings);
  }
}

function updatePetSettings(update: PetSettingsUpdate): PetSettings {
  if (isPetTheme(update.theme)) {
    petSettings.theme = update.theme;
  }
  if (Array.isArray(update.petStyles)) {
    petSettings.petStyles = normalizePetStyles(update.petStyles);
    if (!petSettings.petStyles.some((style) => style.id === petSettings.activePetStyleId)) {
      petSettings.activePetStyleId = DEFAULT_PET_STYLE_ID;
    }
  }
  if (typeof update.activePetStyleId === "string" && petSettings.petStyles.some((style) => style.id === update.activePetStyleId)) {
    petSettings.activePetStyleId = update.activePetStyleId;
  }
  if (update.petPerception !== undefined) {
    petSettings.petPerception = normalizePetPerceptionSettings(update.petPerception);
  }
  if (update.petName !== undefined) {
    petSettings.petName = normalizeCallName(update.petName, DEFAULT_PET_NAME);
  }
  if (update.userName !== undefined) {
    petSettings.userName = normalizeCallName(update.userName, DEFAULT_USER_NAME);
  }
  if (typeof update.alwaysOnTop === "boolean") {
    keepWindowOnTop = update.alwaysOnTop;
    petSettings.alwaysOnTop = keepWindowOnTop;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(keepWindowOnTop);
      appliedWindowOnTop = keepWindowOnTop;
      if (keepWindowOnTop) mainWindow.moveTop();
    }
  }
  if (typeof update.showWeChatBubbles === "boolean") {
    petSettings.showWeChatBubbles = update.showWeChatBubbles;
  }
  if (typeof update.showThinkingBubbles === "boolean") {
    petSettings.showThinkingBubbles = update.showThinkingBubbles;
  }
  if (Array.isArray(update.agentConfigs)) {
    petSettings.agentConfigs = canonicalizeAgentConfigs(normalizeAgentConfigs(update.agentConfigs)).configs;
    agentWindowTracker?.setConfigs(petSettings.agentConfigs);
  }
  if (typeof update.wechatTokenFile === "string") {
    petSettings.wechatTokenFile = update.wechatTokenFile.trim();
  }
  if (typeof update.wechatEnabled === "boolean") {
    petSettings.wechatEnabled = update.wechatEnabled;
  }
  if (typeof update.screenCaptureDisplayId === "string") {
    petSettings.screenCaptureDisplayId = update.screenCaptureDisplayId.trim();
  }
  if (Array.isArray(update.wechatAccounts)) {
    petSettings.wechatAccounts = normalizeWeChatAccounts(update.wechatAccounts);
  }
  if (Array.isArray(update.qqAccounts)) {
    petSettings.qqAccounts = normalizeQQAccounts(update.qqAccounts);
  }
  if (Array.isArray(update.feishuAccounts)) {
    petSettings.feishuAccounts = normalizeFeishuAccounts(update.feishuAccounts);
  }
  if (Array.isArray(update.dingtalkAccounts)) {
    petSettings.dingtalkAccounts = normalizeDingTalkAccounts(update.dingtalkAccounts);
  }
  if (update.taskNotificationPlatform !== undefined) {
    petSettings.taskNotificationPlatform = normalizeTaskNotificationPlatform(update.taskNotificationPlatform);
  }
  if (update.taskNotificationMode !== undefined) {
    petSettings.taskNotificationMode = normalizeTaskNotificationMode(update.taskNotificationMode);
  }
  if (Array.isArray(update.wechatAllowedUserIds)) {
    petSettings.wechatAllowedUserIds = normalizeWeChatUserIds(update.wechatAllowedUserIds);
  }
  if (typeof update.agentFullAccess === "boolean") {
    petSettings.agentFullAccess = update.agentFullAccess;
  }
  if (isAgentPermissionPolicy(update.agentPermissionPolicy)) {
    petSettings.agentPermissionPolicy = update.agentPermissionPolicy;
  }
  if (update.agentCapabilityPolicy !== undefined) {
    petSettings.agentCapabilityPolicy = normalizeAgentCapabilityPolicy(update.agentCapabilityPolicy);
  }
  if (update.agentApprovalMode !== undefined) {
    petSettings.agentApprovalMode = normalizeAgentApprovalMode(update.agentApprovalMode);
  }
  if (Array.isArray(update.agentFallbackIds)) {
    petSettings.agentFallbackIds = normalizeAgentFallbackIds(update.agentFallbackIds, petSettings.agentConfigs, petSettings.activeAgentId);
  }
  if (typeof update.ccSwitchSyncEnabled === "boolean") {
    petSettings.ccSwitchSyncEnabled = update.ccSwitchSyncEnabled;
  }
  if (update.zeroToken !== undefined) {
    petSettings.zeroToken = normalizeZeroTokenSettings(update.zeroToken);
  }
  if (typeof update.activeWeChatAccountId === "string") {
    const activeAccount = petSettings.wechatAccounts.find((account) => account.id === update.activeWeChatAccountId);
    if (activeAccount) {
      petSettings.activeWeChatAccountId = activeAccount.id;
      petSettings.wechatTokenFile = activeAccount.tokenFile;
    }
  }
  if (typeof update.activeQQAccountId === "string") {
    const activeAccount = petSettings.qqAccounts.find((account) => account.id === update.activeQQAccountId);
    if (activeAccount) petSettings.activeQQAccountId = activeAccount.id;
  }
  if (typeof update.activeFeishuAccountId === "string") {
    const activeAccount = petSettings.feishuAccounts.find((account) => account.id === update.activeFeishuAccountId);
    if (activeAccount) petSettings.activeFeishuAccountId = activeAccount.id;
  }
  if (typeof update.activeDingTalkAccountId === "string") {
    const activeAccount = petSettings.dingtalkAccounts.find((account) => account.id === update.activeDingTalkAccountId);
    if (activeAccount) petSettings.activeDingTalkAccountId = activeAccount.id;
  }
  const requestedProvider = isAgentProvider(update.agentProvider) ? update.agentProvider : petSettings.agentProvider;
  const requestedActiveId = typeof update.activeAgentId === "string" ? update.activeAgentId : undefined;
  petSettings.activeAgentId = resolveActiveAgentId(requestedActiveId, petSettings.agentConfigs, requestedProvider);
  petSettings.agentProvider =
    petSettings.agentConfigs.find((config) => config.id === petSettings.activeAgentId)?.provider ?? requestedProvider;
  petSettings.agentFallbackIds = normalizeAgentFallbackIds(petSettings.agentFallbackIds, petSettings.agentConfigs, petSettings.activeAgentId);
  normalizeBotAgentBindings();
  if (typeof update.saveChatHistory === "boolean") {
    petSettings.saveChatHistory = update.saveChatHistory;
  }
  if (isCodexSandboxMode(update.codexSandboxMode)) {
    petSettings.codexSandboxMode = update.codexSandboxMode;
  }
  applyAgentFullAccessPolicy();
  savePetSettings();
  broadcastPetSettings();
  agentPerceptionService?.setSettings(getPetSettings());
  agentTaskObserver?.setSettings(getPetSettings());
  longTaskReplyScheduler?.setSettings(getPetSettings());
  return getPetSettings();
}

function ensureSettingsWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }

  const createdSettingsWindow = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_WIDTH,
    maxWidth: SETTINGS_WINDOW_WIDTH,
    minHeight: SETTINGS_WINDOW_HEIGHT,
    maxHeight: SETTINGS_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: true,
    show: false,
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow = createdSettingsWindow;
  settingsWindowReady = false;
  void createdSettingsWindow
    .loadFile(join(__dirname, "../renderer/index.html"), { query: { settings: "1" } })
    .catch((error) => console.warn("Unable to load settings window.", error));
  createdSettingsWindow.on("close", (event) => {
    if (appQuitting || allowSettingsWindowClose) {
      allowSettingsWindowClose = false;
      return;
    }
    event.preventDefault();
    if (!createdSettingsWindow.webContents.isDestroyed()) {
      createdSettingsWindow.webContents.send("settings:close-request");
    }
  });
  createdSettingsWindow.on("resize", enforceSettingsWindowBounds);
  createdSettingsWindow.once("ready-to-show", () => {
    if (settingsWindow !== createdSettingsWindow || createdSettingsWindow.isDestroyed()) return;
    settingsWindowReady = true;
    enforceSettingsWindowBounds();
    if (settingsWindowShowRequested) {
      settingsWindowShowRequested = false;
      createdSettingsWindow.show();
      createdSettingsWindow.focus();
    }
    setTimeout(enforceSettingsWindowBounds, 0);
    setTimeout(enforceSettingsWindowBounds, 120);
  });
  createdSettingsWindow.on("closed", () => {
    if (settingsWindow !== createdSettingsWindow) return;
    settingsWindow = null;
    settingsWindowReady = false;
    settingsWindowShowRequested = false;
  });
  return createdSettingsWindow;
}

function openSettingsWindow(): void {
  const window = ensureSettingsWindow();
  if (!window) return;

  settingsWindowShowRequested = true;
  if (settingsWindowReady) {
    settingsWindowShowRequested = false;
    window.show();
    window.focus();
  }
}

function warmSettingsWindow(): void {
  if (appQuitting) return;
  void ensureSettingsWindow();
}

function enforceSettingsWindowBounds(): void {
  if (!settingsWindow || settingsWindow.isDestroyed() || enforcingSettingsBounds) return;
  const [width, height] = settingsWindow.getContentSize();
  if (width === SETTINGS_WINDOW_WIDTH && height === SETTINGS_WINDOW_HEIGHT) return;

  enforcingSettingsBounds = true;
  settingsWindow.setContentSize(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT, false);
  enforcingSettingsBounds = false;
}

async function renamePetStyle(rawStyleId: unknown, rawName: unknown): Promise<PetStyleActionResult> {
  const styleId = typeof rawStyleId === "string" ? rawStyleId.trim() : "";
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 32) : "";
  const style = petSettings.petStyles.find((item) => item.id === styleId);
  if (!style || style.source === "builtin") return { ok: false, detail: "内置风格不能改名" };
  if (!name) return { ok: false, detail: "风格名称不能为空" };
  const renamed = { ...style, name };
  petSettings.petStyles = normalizePetStyles(petSettings.petStyles.map((item) => item.id === styleId ? renamed : item));
  savePetSettings();
  broadcastPetSettings();
  return { ok: true, detail: "风格名称已更新", style: renamed, settings: getPetSettings() };
}

function currentPetWindowHeight(): number {
  return petWindowExpanded ? PET_WINDOW_EXPANDED_HEIGHT : PET_WINDOW_HEIGHT;
}

function broadcastZeroTokenRuntime(): void {
  void zeroTokenRuntime.getStatus(petSettings.zeroToken.provider).then((embedded) => {
    broadcastZeroTokenStatus(statusFromEmbedded(embedded));
  }).catch((error) => {
    console.warn(`[ZeroToken] status broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function broadcastZeroTokenStatus(status: ZeroTokenProviderStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("zero-token:runtime", status);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send("zero-token:runtime", status);
}

function normalizeZeroTokenProvider(raw: unknown, fallback: ZeroTokenProviderId): ZeroTokenProviderId {
  if (typeof raw === "string" && ZERO_TOKEN_PROVIDERS.some((provider) => provider.id === raw)) {
    return raw as ZeroTokenProviderId;
  }
  return fallback;
}

function persistZeroTokenModel(modelId: string): void {
  const model = modelId.trim();
  if (!model || petSettings.zeroToken.model === model) return;
  petSettings.zeroToken = normalizeZeroTokenSettings({ ...petSettings.zeroToken, model });
  savePetSettings();
  broadcastPetSettings();
}

function currentPetWindowClampShape(): WindowShapeBounds | null {
  // The expanded native window is an interaction surface for the Agent Dock,
  // not part of the visible pet. Keep the drag boundary tied to the alpha
  // silhouette so expanding the Dock does not push the pet away from the
  // physical bottom edge.
  return petShapeBounds;
}

function setPetWindowExpanded(expanded: boolean): void {
  petWindowExpanded = expanded;
  const targetHeight = currentPetWindowHeight();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const bounds = mainWindow.getBounds();
  const desktop = getVirtualDesktopBounds();
  const position = clampPetWindowPosition(
    bounds.x,
    bounds.y,
    desktop,
    PET_WINDOW_WIDTH,
    targetHeight,
    currentPetWindowClampShape(),
  );
  if (bounds.width !== PET_WINDOW_WIDTH || bounds.height !== targetHeight || bounds.x !== position.x || bounds.y !== position.y) {
    mainWindow.setBounds({ x: position.x, y: position.y, width: PET_WINDOW_WIDTH, height: targetHeight }, false);
  }
  publishPetWindowEdge();
}

function enforcePetWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const targetHeight = currentPetWindowHeight();
  if (bounds.width !== PET_WINDOW_WIDTH || bounds.height !== targetHeight) {
    // Electron/Chromium can enlarge a transparent HWND after its first paint.
    // Keep the native hit-test rectangle identical to the renderer viewport.
    if (enforcingPetBounds) return;
    enforcingPetBounds = true;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: PET_WINDOW_WIDTH, height: targetHeight }, false);
    enforcingPetBounds = false;
  }
}

function keepPetWindowOnTop(moveToTop = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  enforcePetWindowBounds();
  if (appliedWindowOnTop !== keepWindowOnTop) {
    mainWindow.setAlwaysOnTop(keepWindowOnTop);
    appliedWindowOnTop = keepWindowOnTop;
  }
  if (keepWindowOnTop && moveToTop) mainWindow.moveTop();
}

function publishPetWindowEdge(desktopOverride?: Electron.Rectangle): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const desktop = desktopOverride ?? getVirtualDesktopBounds();
  const visibleLeft = bounds.x + (petShapeBounds?.left ?? 0);
  const visibleRight = bounds.x + (petShapeBounds?.right ?? PET_WINDOW_WIDTH);
  const visibleTop = bounds.y + (petShapeBounds?.top ?? 0);
  // Start the static status-light rebound before the alpha shape reaches the
  // physical edge. The marker and its glow need room to move inward.
  const edge = {
    left: visibleLeft <= desktop.x + PET_STATUS_EDGE_REBOUND_TRIGGER_PX,
    right: visibleRight >= desktop.x + desktop.width - PET_STATUS_EDGE_REBOUND_TRIGGER_PX,
    top: visibleTop <= desktop.y + PET_STATUS_EDGE_REBOUND_TRIGGER_PX,
  };
  const signature = `${edge.left ? 1 : 0}${edge.right ? 1 : 0}${edge.top ? 1 : 0}`;
  if (signature === lastPetWindowEdgeSignature) return;
  lastPetWindowEdgeSignature = signature;
  mainWindow.webContents.send("pet:window-edge", edge);
}

function getVirtualDesktopBounds(): Electron.Rectangle {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return screen.getPrimaryDisplay().bounds;

  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clampPetWindowPosition(
  x: number,
  y: number,
  desktop: Electron.Rectangle,
  windowWidth: number,
  windowHeight: number,
  shapeOverride?: WindowShapeBounds | null,
): { x: number; y: number } {
  const shape = shapeOverride === undefined ? petShapeBounds : shapeOverride;
  const minX = shape ? desktop.x - shape.left : desktop.x;
  const minY = shape ? desktop.y - shape.top : desktop.y;
  const maxX = shape ? desktop.x + desktop.width - shape.right : desktop.x + desktop.width - windowWidth;
  const maxY = shape ? desktop.y + desktop.height - shape.bottom : desktop.y + desktop.height - windowHeight;

  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  };
}

function createWindow() {
  const workArea = getSystemDefaultDisplay().workArea;
  const width = PET_WINDOW_WIDTH;
  const height = PET_WINDOW_HEIGHT;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: Math.max(workArea.x, workArea.x + workArea.width - width - 32),
    y: workArea.y + 32,
    frame: false,
    transparent: true,
    useContentSize: true,
    resizable: false,
    movable: true,
    minWidth: PET_WINDOW_WIDTH,
    minHeight: PET_WINDOW_HEIGHT,
    maxWidth: PET_WINDOW_WIDTH,
    maxHeight: PET_WINDOW_EXPANDED_HEIGHT,
    alwaysOnTop: keepWindowOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMinimumSize(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT);
  mainWindow.setMaximumSize(PET_WINDOW_WIDTH, PET_WINDOW_EXPANDED_HEIGHT);

  keepPetWindowOnTop(true);
  mainWindow.on("resize", () => {
    userHasInteractedWithPetWindow = true;
    enforcePetWindowBounds();
  });
  mainWindow.on("move", () => {
    userHasInteractedWithPetWindow = true;
    publishPetWindowEdge(activeWindowDrag?.desktop);
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.showInactive();
    keepPetWindowOnTop(true);
    publishPetWindowEdge();
    // The transparent HWND enlargement can happen after ready-to-show. Recheck
    // for a short period while Chromium finishes the first compositor commit.
    [0, 50, 200, 600, 1200].forEach((delay) => {
      setTimeout(() => enforcePetWindowBounds(), delay);
    });
    // Prepare the settings renderer after the pet's first compositor commit so
    // the first context-menu click does not pay the BrowserWindow/bootstrap cost.
    setTimeout(warmSettingsWindow, 900);
  });
  mainWindow.on("show", () => keepPetWindowOnTop(true));
  mainWindow.on("focus", () => keepPetWindowOnTop(true));
  mainWindow.on("blur", () => {
    // Do not toggle mouse passthrough here. A blur can happen while Chromium is
    // transferring pointer capture during a drag; forcing passthrough at this
    // exact moment makes the pointer appear to lose focus and breaks the drag.
    keepPetWindowOnTop();
  });
  mainWindow.on("close", (event) => {
    if (appQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
    console.info("[AppLifecycle] pet window hidden; application remains running");
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    activeWindowDrag = null;
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "penguin-icon.png")
    : join(app.getAppPath(), "build", "penguin-icon.png");
}

function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(trayIconPath()).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) console.warn(`[AppLifecycle] tray icon unavailable: ${trayIconPath()}`);
  tray = new Tray(icon);
  tray.setToolTip("Penguin Desktop Pet");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示桌宠", click: showMainWindow },
    { label: "打开设置", click: openSettingsWindow },
    { type: "separator" },
    { label: "退出应用", click: () => app.quit() },
  ]));
  tray.on("double-click", showMainWindow);
}

const CHANNEL_SEND_MAX_ATTEMPTS = 3;
const CHANNEL_SEND_RETRY_DELAYS_MS = [1000, 2500] as const;
// 与微信路径对齐：消息通过校验/去重后立即回执，随后再异步生成正式回复。
type ChannelInboundMessage = Extract<BotChannelEvent, { type: "message" }>["message"];

interface AgentTaskNotificationTarget {
  channelId: string;
  platform: TaskNotificationPlatform;
  /** Stable configured Bot account id, independent from platform-native accountId. */
  botAccountId?: string;
  conversationId: string;
  conversationType: ChannelInboundMessage["conversationType"];
  messageId: string;
  contextToken?: string;
  /** 捕获目标时的微信账号身份（仅 wechat）；换账号后用于识别过期目标。 */
  accountId?: string;
}

type AgentTaskNotificationTargets = Record<string, AgentTaskNotificationTarget>;

let agentTaskNotificationTargets: AgentTaskNotificationTargets = {};
const taskNotificationSendChains = new Map<string, Promise<void>>();
// Persisted targets are historical addresses only. They become sendable again
// after this process receives a fresh inbound message on the same platform.
let agentTaskNotificationTargetReady: Record<string, true> = {};

function agentNotificationTargetFilePath(): string {
  return join(app.getPath("userData"), AGENT_NOTIFICATION_TARGET_FILE);
}

function isNotificationPlatform(value: unknown): value is TaskNotificationPlatform {
  return value === "wechat" || value === "qq" || value === "feishu" || value === "dingtalk";
}

function botAccountIdForTarget(
  target: Pick<AgentTaskNotificationTarget, "platform" | "accountId" | "botAccountId" | "channelId">,
  settings = getPetSettings(),
  weChatTokenFile = "",
): string {
  if (target.botAccountId?.trim()) return target.botAccountId.trim();
  const identity = target.accountId?.trim() || target.channelId.trim();
  const accounts: Array<{ id: string; tokenFile?: string; appId?: string; clientId?: string }> = target.platform === "wechat"
    ? settings.wechatAccounts
    : target.platform === "qq"
      ? settings.qqAccounts
      : target.platform === "feishu"
        ? settings.feishuAccounts
        : settings.dingtalkAccounts;
  // 微信事件的 accountId 是 iLink 原生账号 id，而配置账号 id 是 token 文件的 hash：
  // 先按事件身份匹配，再按桥接器当前会话的 token 文件匹配，避免多账号时误挂到
  // “当前激活账号”。匹配不到配置账号时优先用 token 文件（与账号 id 同源）作兜底。
  const candidateIdentities = [identity, ...(target.platform === "wechat" && weChatTokenFile.trim() ? [weChatTokenFile.trim()] : [])];
  for (const candidate of candidateIdentities) {
    const matched = accounts.find((account) => [account.id, account.tokenFile, account.appId, account.clientId, `${target.platform}:${account.appId ?? account.clientId ?? ""}`]
      .filter(Boolean)
      .includes(candidate));
    if (matched) return matched.id;
  }
  if (target.platform === "wechat" && target.channelId === "wechat:active") {
    return settings.activeWeChatAccountId || weChatTokenFile.trim() || identity;
  }
  return identity;
}

function taskNotificationTargetKey(target: Pick<AgentTaskNotificationTarget, "platform" | "botAccountId" | "accountId" | "channelId" | "conversationId">): string {
  return [
    target.platform,
    target.botAccountId ?? "",
    target.accountId ?? "",
    target.channelId,
    target.conversationId,
  ].join("\u0000");
}

/** Serialize task notices per Bot conversation so terminal notices cannot be
 * overtaken by a newly scheduled processing notice. */
function sendTaskNotificationInOrder(
  target: Pick<AgentTaskNotificationTarget, "platform" | "botAccountId" | "accountId" | "channelId" | "conversationId">,
  send: () => Promise<boolean>,
): Promise<boolean> {
  const key = taskNotificationTargetKey(target);
  const previous = taskNotificationSendChains.get(key) ?? Promise.resolve();
  const current = previous.then(send, send);
  const settled = current.then(() => undefined, () => undefined);
  taskNotificationSendChains.set(key, settled);
  void settled.then(() => {
    if (taskNotificationSendChains.get(key) === settled) taskNotificationSendChains.delete(key);
  });
  return current;
}

function botContextKey(message: Pick<ChannelInboundMessage, "platform" | "accountId" | "channelId" | "conversationId">): string {
  const botAccountId = botAccountIdForTarget({
    platform: message.platform,
    accountId: message.accountId,
    channelId: message.channelId,
  });
  return `bot:${message.platform}:${botAccountId}:${message.conversationId}`;
}

function readAgentTaskNotificationTarget(value: unknown): AgentTaskNotificationTarget | null {
  if (!isRecord(value) || !isNotificationPlatform(value.platform)) return null;
  if (typeof value.channelId !== "string" || typeof value.conversationId !== "string" || typeof value.messageId !== "string") return null;
  if (!value.channelId.trim() || !value.conversationId.trim() || !value.messageId.trim()) return null;
  return {
    channelId: value.channelId.trim(),
    platform: value.platform,
    botAccountId: typeof value.botAccountId === "string" && value.botAccountId.trim() ? value.botAccountId.trim() : undefined,
    conversationId: value.conversationId.trim(),
    conversationType: value.conversationType === "group" ? "group" : "direct",
    messageId: value.messageId.trim(),
    contextToken: typeof value.contextToken === "string" ? value.contextToken.trim() || undefined : undefined,
    accountId: typeof value.accountId === "string" && value.accountId.trim() ? value.accountId.trim() : undefined,
  };
}

function persistAgentTaskNotificationTargets(): void {
  try {
    writeFileSync(agentNotificationTargetFilePath(), `${JSON.stringify({ version: 3, targets: agentTaskNotificationTargets })}\n`, "utf8");
  } catch (error) {
    console.warn("Unable to persist Agent notification target.", error);
  }
}

function rememberAgentTaskNotificationTarget(target: AgentTaskNotificationTarget): void {
  const normalized = { ...target, botAccountId: target.botAccountId || botAccountIdForTarget(target) };
  const key = `${normalized.platform}:${normalized.botAccountId || normalized.accountId || normalized.channelId}`;
  agentTaskNotificationTargets[key] = normalized;
  agentTaskNotificationTargetReady[key] = true;
  persistAgentTaskNotificationTargets();
}

function loadAgentTaskNotificationTarget(): void {
  try {
    const filePath = agentNotificationTargetFilePath();
    if (!existsSync(filePath)) return;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const restored: AgentTaskNotificationTargets = {};
    let migratedLegacyTarget = false;
    if (isRecord(parsed.targets)) {
      for (const value of Object.values(parsed.targets)) {
        const target = readAgentTaskNotificationTarget(value);
        if (target) {
          const normalized = { ...target, botAccountId: target.botAccountId || botAccountIdForTarget(target) };
          restored[`${normalized.platform}:${normalized.botAccountId || normalized.accountId || normalized.channelId}`] = normalized;
        }
      }
    } else {
      const legacyTarget = readAgentTaskNotificationTarget(parsed);
      if (legacyTarget) {
        const normalized = { ...legacyTarget, botAccountId: legacyTarget.botAccountId || botAccountIdForTarget(legacyTarget) };
        restored[`${normalized.platform}:${normalized.botAccountId || normalized.accountId || normalized.channelId}`] = normalized;
        migratedLegacyTarget = true;
      }
    }
    agentTaskNotificationTargets = restored;
    // Reuse the persisted target after restart so background notices can be
    // attempted immediately. WeChatBridge invalidates only the target whose
    // context token is rejected; a later inbound message can refresh it.
    agentTaskNotificationTargetReady = Object.keys(restored).reduce<Record<string, true>>((ready, key) => {
      ready[key] = true;
      return ready;
    }, {});
    if (migratedLegacyTarget) persistAgentTaskNotificationTargets();
  } catch (error) {
    console.warn("Unable to load Agent notification target; waiting for a new bot message.", error);
  }
}

function allNotificationTargets(): AgentTaskNotificationTarget[] {
  return Object.keys(agentTaskNotificationTargets)
    .filter((key) => Boolean(agentTaskNotificationTargetReady[key]))
    .map((key) => agentTaskNotificationTargets[key])
    .filter((target): target is AgentTaskNotificationTarget => Boolean(target));
}

function defaultWeChatNotificationTarget(settings = getPetSettings()): AgentTaskNotificationTarget | null {
  const bridge = weChatBridge;
  const account = settings.wechatAccounts.find((item) => item.id === settings.activeWeChatAccountId && item.taskNotificationEnabled)
    ?? settings.wechatAccounts.find((item) => item.taskNotificationEnabled);
  const conversationId = bridge?.defaultConversationId.trim() ?? "";
  if (!bridge || !account || !conversationId) return null;

  return {
    channelId: "wechat:active",
    platform: "wechat",
    botAccountId: account.id,
    conversationId,
    conversationType: "direct",
    messageId: "desktop-pet-default-wechat-target",
    accountId: bridge.accountIdentity || undefined,
  };
}

function externalTaskNotificationRoutes(settings = getPetSettings()): LongTaskReplyRoute[] {
  const routes: LongTaskReplyRoute[] = [];
  const seen = new Set<string>();
  const defaultTarget = defaultWeChatNotificationTarget(settings);
  for (const target of allNotificationTargets()) {
    const botAccountId = botAccountIdForTarget(target, settings);
    const accounts: Array<{ id: string; taskNotificationEnabled: boolean; taskNotificationMode: TaskNotificationMode }> = target.platform === "wechat"
      ? settings.wechatAccounts
      : target.platform === "qq"
        ? settings.qqAccounts
        : target.platform === "feishu"
          ? settings.feishuAccounts
          : settings.dingtalkAccounts;
    const account = accounts.find((item) => item.id === botAccountId);
    if (!account?.taskNotificationEnabled) continue;
    const routeId = `${target.platform}:${botAccountId}`;
    if (seen.has(routeId)) continue;
    seen.add(routeId);
    const routeTarget = target.platform === "wechat"
      && defaultTarget
      && defaultTarget.botAccountId === botAccountId
      ? defaultTarget
      : target;
    routes.push({
      routeId,
      target: { ...routeTarget, botAccountId },
      mode: account.taskNotificationMode,
    });
  }

  // A single QR-authorized WeChat account already has a stable default user
  // target. Do not require an inbound message just to discover the target;
  // WeChatBridge will omit context_token when no conversation context exists.
  if (defaultTarget) {
    const account = settings.wechatAccounts.find((item) => item.id === defaultTarget.botAccountId);
    const routeId = `wechat:${defaultTarget.botAccountId}`;
    if (account?.taskNotificationEnabled && !seen.has(routeId)) {
      routes.push({
        routeId,
        target: defaultTarget,
        mode: account.taskNotificationMode,
      });
    }
  }
  return routes;
}

interface QueuedWeChatTaskNotification {
  id: string;
  text: string;
  botAccountId?: string;
  conversationId: string;
  accountId?: string;
  createdAt: number;
}

let weChatTaskNotificationQueue: QueuedWeChatTaskNotification[] = [];
let weChatTaskQueueFlushing = false;
let weChatTaskNotificationRetryTimer: ReturnType<typeof setTimeout> | undefined;
let weChatTaskNotificationRetryDelayMs = AGENT_TASK_NOTIFY_RETRY_INITIAL_MS;

function stableFingerprint(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function weChatTaskNotificationQueueFilePath(): string {
  return join(app.getPath("userData"), AGENT_TASK_NOTIFY_QUEUE_FILE);
}

function normalizeWeChatTaskNotificationText(value: unknown, maxLength = 420): string {
  if (typeof value !== "string") return "";
  const redacted = value
    .replace(/\b(bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>")
    .replaceAll("Codex Desktop（ChatGPT）", "Codex Desktop");
  return redacted
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function parseLegacyNotificationElapsed(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  return (Number(match[1] ?? 0) * 3600) + (Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0);
}

/** Converts queued compact notices from the pre-event formatter to the unified detail shape. */
function migrateLegacyWeChatTaskNotificationText(value: string): { text: string; migrated: boolean } {
  const text = normalizeWeChatTaskNotificationText(value);
  const match = text.match(/^(🟢|🔴|🟡|⏸|💬)\s+(.+?)\s+(完成|失败|处理中|等待|需要回复)\s+(.+?)\s+·\s+(.+)$/);
  if (!match) return { text, migrated: false };

  const status = {
    完成: "completed",
    失败: "failed",
    处理中: "processing",
    等待: "waiting",
    需要回复: "input_required",
  }[match[3]] as "processing" | "completed" | "failed" | "waiting" | "input_required";
  const sourceName = match[2].trim();
  const workspaceLabel = match[4].trim();
  const context = match[5].trim();
  const surface = context === "ChatGPT" ? "desktop" : context === "VS Code" ? "vscode" : undefined;
  const elapsedSeconds = parseLegacyNotificationElapsed(context);
  const message = status === "completed"
    ? "任务完成"
    : status === "failed"
      ? context === "点击查看原因" ? "任务失败，请查看详情" : context
      : status === "waiting"
        ? context
        : status === "input_required" ? context : "正在处理";
  return {
    text: formatAgentEventNotification({
      status,
      sourceName,
      title: `${sourceName} · ${workspaceLabel}`,
      message,
      workspaceLabel,
      surface,
      elapsedSeconds,
    }),
    migrated: true,
  };
}

function resetWeChatTaskNotificationRetry(): void {
  if (weChatTaskNotificationRetryTimer !== undefined) {
    clearTimeout(weChatTaskNotificationRetryTimer);
    weChatTaskNotificationRetryTimer = undefined;
  }
  weChatTaskNotificationRetryDelayMs = AGENT_TASK_NOTIFY_RETRY_INITIAL_MS;
}

function scheduleWeChatTaskNotificationRetry(): void {
  if (weChatTaskNotificationQueue.length === 0 || weChatTaskNotificationRetryTimer !== undefined) return;
  const delay = weChatTaskNotificationRetryDelayMs;
  weChatTaskNotificationRetryDelayMs = Math.min(
    Math.round(weChatTaskNotificationRetryDelayMs * 1.7),
    AGENT_TASK_NOTIFY_RETRY_MAX_MS,
  );
  weChatTaskNotificationRetryTimer = setTimeout(() => {
    weChatTaskNotificationRetryTimer = undefined;
    void flushReadyWeChatTaskNotifications();
  }, delay);
}

function persistWeChatTaskNotificationQueue(): void {
  try {
    writeFileSync(
      weChatTaskNotificationQueueFilePath(),
      `${JSON.stringify({ version: AGENT_TASK_NOTIFY_QUEUE_VERSION, entries: weChatTaskNotificationQueue })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("Unable to persist WeChat Agent task notification queue.", error);
  }
}

function loadWeChatTaskNotificationQueue(): void {
  try {
    const filePath = weChatTaskNotificationQueueFilePath();
    if (!existsSync(filePath)) return;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const restored: QueuedWeChatTaskNotification[] = [];
    const seenIds = new Set<string>();
    const now = Date.now();
    let migratedLegacyEntries = false;
    const isCurrentQueueVersion = parsed.version === AGENT_TASK_NOTIFY_QUEUE_VERSION;
    if (isCurrentQueueVersion && Array.isArray(parsed.entries)) {
      for (const value of parsed.entries) {
        if (!isRecord(value) || typeof value.text !== "string") continue;
        const migrated = migrateLegacyWeChatTaskNotificationText(value.text);
        const text = migrated.text;
        if (!text) continue;
        migratedLegacyEntries ||= migrated.migrated;
        const botAccountId = typeof value.botAccountId === "string" ? value.botAccountId.trim() : "";
        const conversationId = typeof value.conversationId === "string" ? value.conversationId.trim() : "";
        if (!conversationId) continue;
        const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
        const id = typeof value.id === "string" && value.id.trim()
          ? value.id.trim()
          : stableFingerprint(`${botAccountId}\u0000${accountId}\u0000${conversationId}\u0000${text}`);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
          ? value.createdAt
          : 0;
        if (!createdAt || now - createdAt > AGENT_TASK_NOTIFY_QUEUE_TTL_MS || createdAt > now + 5 * 60_000) continue;
        restored.push({
          id,
          text,
          botAccountId: botAccountId || undefined,
          conversationId,
          accountId: accountId || undefined,
          createdAt,
        });
      }
    }
    weChatTaskNotificationQueue = restored.slice(-MAX_AGENT_TASK_NOTIFY_QUEUE);
    if (parsed.version !== AGENT_TASK_NOTIFY_QUEUE_VERSION
      || migratedLegacyEntries
      || restored.length !== (Array.isArray(parsed.entries) ? parsed.entries.length : 0)) {
      persistWeChatTaskNotificationQueue();
    }
    console.info(`[AgentTaskNotify] restored ${weChatTaskNotificationQueue.length} queued WeChat notice(s)`);
    scheduleWeChatTaskNotificationRetry();
  } catch (error) {
    console.warn("Unable to load WeChat Agent task notification queue.", error);
    weChatTaskNotificationQueue = [];
  }
}

function queueWeChatTaskNotification(
  text: string,
  botAccountId = "",
  preferredId = "",
  target?: Pick<AgentTaskNotificationTarget, "conversationId" | "accountId">,
): void {
  const sanitized = normalizeWeChatTaskNotificationText(text);
  if (!sanitized) return;
  const normalizedBotAccountId = botAccountId.trim();
  const conversationId = target?.conversationId.trim() ?? "";
  if (!conversationId) {
    console.warn("[AgentTaskNotify] no concrete WeChat conversation target; notice was not queued");
    return;
  }
  const accountId = target?.accountId?.trim() ?? "";
  const scope = `${normalizedBotAccountId}\u0000${accountId}\u0000${conversationId}`;
  const id = preferredId.trim()
    ? `${preferredId.trim()}:${stableFingerprint(scope)}`
    : stableFingerprint(`${scope}\u0000${sanitized}`);
  if (weChatTaskNotificationQueue.some((entry) => entry.id === id)) {
    console.info(`[AgentTaskNotify] duplicate queued WeChat notice ignored: ${id}`);
    return;
  }
  weChatTaskNotificationQueue.push({
    id,
    text: sanitized,
    botAccountId: normalizedBotAccountId || undefined,
    conversationId,
    accountId: accountId || undefined,
    createdAt: Date.now(),
  });
  while (weChatTaskNotificationQueue.length > MAX_AGENT_TASK_NOTIFY_QUEUE) {
    const removed = weChatTaskNotificationQueue.shift();
    console.warn(`[AgentTaskNotify] dropped oldest queued WeChat notice: ${removed?.id ?? "unknown"}`);
  }
  persistWeChatTaskNotificationQueue();
  console.info(`[AgentTaskNotify] queued WeChat notice ${id}; pending=${weChatTaskNotificationQueue.length}`);
  scheduleWeChatTaskNotificationRetry();
}

async function flushWeChatTaskNotificationQueue(freshTarget: AgentTaskNotificationTarget): Promise<void> {
  if (weChatTaskQueueFlushing || !weChatBridge) return;
  const botAccountId = freshTarget.botAccountId || botAccountIdForTarget(freshTarget);
  const now = Date.now();
  const beforePrune = weChatTaskNotificationQueue.length;
  weChatTaskNotificationQueue = weChatTaskNotificationQueue.filter((entry) => now - entry.createdAt <= AGENT_TASK_NOTIFY_QUEUE_TTL_MS);
  if (weChatTaskNotificationQueue.length !== beforePrune) persistWeChatTaskNotificationQueue();
  const pending = weChatTaskNotificationQueue.filter((entry) =>
    (!entry.botAccountId || entry.botAccountId === botAccountId)
    && entry.conversationId === freshTarget.conversationId
    && (!entry.accountId || entry.accountId === freshTarget.accountId),
  );
  if (pending.length === 0) return;

  weChatTaskQueueFlushing = true;
  let changed = false;
  try {
    for (const entry of pending) {
      let delivered = false;
      try {
        delivered = Boolean(await weChatBridge.sendReplyTo(
          freshTarget.conversationId,
          entry.text,
          freshTarget.contextToken,
          freshTarget.accountId,
          boundAgentConfigForBot("wechat", botAccountId, "", getPetSettings()).provider,
        ));
      } catch (error) {
        console.warn(`[AgentTaskNotify] queued WeChat notice ${entry.id} failed; retained for automatic retry`, error);
      }
      if (!delivered) {
        console.warn(`[AgentTaskNotify] queued WeChat notice ${entry.id} was not delivered; retained`);
        continue;
      }
      weChatTaskNotificationQueue = weChatTaskNotificationQueue.filter((item) => item.id !== entry.id);
      changed = true;
      console.info(`[AgentTaskNotify] flushed queued WeChat notice ${entry.id}`);
    }
  } finally {
    if (changed) persistWeChatTaskNotificationQueue();
    weChatTaskQueueFlushing = false;
    if (weChatTaskNotificationQueue.length > 0) scheduleWeChatTaskNotificationRetry();
    else resetWeChatTaskNotificationRetry();
  }
}

async function flushReadyWeChatTaskNotifications(): Promise<void> {
  if (!weChatBridge?.status.connected) {
    scheduleWeChatTaskNotificationRetry();
    return;
  }
  if (weChatTaskNotificationQueue.length === 0) {
    resetWeChatTaskNotificationRetry();
    return;
  }
  const targets = allNotificationTargets().filter((item) => item.platform === "wechat");
  const defaultTarget = defaultWeChatNotificationTarget();
  if (defaultTarget) {
    let changed = false;
    for (const entry of weChatTaskNotificationQueue) {
      const sameBot = !entry.botAccountId || entry.botAccountId === defaultTarget.botAccountId;
      const sameAccount = !entry.accountId || !defaultTarget.accountId || entry.accountId === defaultTarget.accountId;
      if (!sameBot || !sameAccount) continue;
      if (entry.conversationId !== defaultTarget.conversationId || entry.accountId !== defaultTarget.accountId) {
        entry.conversationId = defaultTarget.conversationId;
        entry.accountId = defaultTarget.accountId;
        changed = true;
      }
    }
    if (changed) persistWeChatTaskNotificationQueue();
    targets.push(defaultTarget);
  }

  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.botAccountId ?? ""}:${target.conversationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    void flushWeChatTaskNotificationQueue(target);
  }
  if (weChatTaskNotificationQueue.length > 0) scheduleWeChatTaskNotificationRetry();
  else resetWeChatTaskNotificationRetry();
}

async function sendWeChatTaskNotification(
  target: Pick<AgentTaskNotificationTarget, "conversationId" | "accountId" | "contextToken">,
  text: string,
  botAccountId: string,
  preferredId = "",
): Promise<boolean> {
  if (!weChatBridge || !weChatBridge.status.connected) {
    queueWeChatTaskNotification(text, botAccountId, preferredId, target);
    return false;
  }
  let delivered = false;
  try {
    delivered = Boolean(await weChatBridge.sendReplyTo(
      target.conversationId,
      text,
      target.contextToken,
      target.accountId,
      boundAgentConfigForBot("wechat", botAccountId, "", getPetSettings()).provider,
    ));
  } catch (error) {
    console.warn("Unable to send WeChat Agent task notification; queued for automatic retry.", error);
  }
  if (!delivered) queueWeChatTaskNotification(text, botAccountId, preferredId, target);
  return delivered;
}

function waitForChannelRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sendChannelReplyWithRetry(
  message: ChannelInboundMessage,
  text: string,
  channelName: string,
): Promise<{ delivered: boolean; attempts: number }> {
  for (let attempt = 1; attempt <= CHANNEL_SEND_MAX_ATTEMPTS; attempt += 1) {
    let delivered = false;
    try {
      delivered = await botChannelManager.send(message.channelId, {
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        replyToMessageId: message.id,
        text,
      });
    } catch (error) {
      console.warn(`Unable to send ${message.platform} channel reply (attempt ${attempt}).`, error);
    }
    if (delivered) return { delivered: true, attempts: attempt };
    if (attempt >= CHANNEL_SEND_MAX_ATTEMPTS) break;

    const delayMs = CHANNEL_SEND_RETRY_DELAYS_MS[attempt - 1] ?? CHANNEL_SEND_RETRY_DELAYS_MS.at(-1)!;
    botChannelManager.publish({
      type: "agent-status",
      channelId: message.channelId,
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.id,
      status: "waiting",
      detail: `${channelName}发送失败，将在 ${Math.round(delayMs / 1000)} 秒后重试（${attempt}/${CHANNEL_SEND_MAX_ATTEMPTS}）`,
    });
    await waitForChannelRetry(delayMs);
  }
  return { delivered: false, attempts: CHANNEL_SEND_MAX_ATTEMPTS };
}

async function sendChannelMediaWithRetry(
  message: ChannelInboundMessage,
  media: OutboundMediaMessage["media"],
  channelName: string,
): Promise<{ delivered: boolean; attempts: number; detail: string }> {
  let detail = "媒体发送失败";
  for (let attempt = 1; attempt <= CHANNEL_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await botChannelManager.sendMedia(message.channelId, {
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        replyToMessageId: message.id,
        contextToken: message.contextToken,
        media,
      });
      detail = result.detail;
      if (result.ok) return { delivered: true, attempts: attempt, detail };
      if (result.retryable === false) return { delivered: false, attempts: attempt, detail };
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (attempt >= CHANNEL_SEND_MAX_ATTEMPTS) break;
    const delayMs = CHANNEL_SEND_RETRY_DELAYS_MS[attempt - 1] ?? CHANNEL_SEND_RETRY_DELAYS_MS.at(-1)!;
    botChannelManager.publish({
      type: "agent-status",
      channelId: message.channelId,
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.id,
      status: "waiting",
      detail: `${channelName}媒体发送失败，将在 ${Math.round(delayMs / 1000)} 秒后重试（${attempt}/${CHANNEL_SEND_MAX_ATTEMPTS}）：${detail}`,
    });
    await waitForChannelRetry(delayMs);
  }
  return { delivered: false, attempts: CHANNEL_SEND_MAX_ATTEMPTS, detail };
}

function mediaDeliveryGuidance(kind: "image" | "file", detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim().slice(0, 420);
  const hint = kind === "file"
    ? "请按该机器人平台允许的最大文件大小重试；如果平台返回超限，请压缩文件、拆分文件，或改用支持文件的通道。"
    : "请确认图片路径或链接可访问，并检查该机器人通道的媒体权限。";
  return `媒体发送失败：${normalized || "平台未返回具体原因"}。${hint}`;
}

async function sendDelegationCompletionToChannel(
  message: ChannelInboundMessage,
  completion: AgentDelegationCompletion,
): Promise<void> {
  const settings = getPetSettings();
  const detail = normalizeSafeText(completion.result ?? completion.detail, 1200);
  const text = completion.ok
    ? `${settings.petName}报告：${completion.task.title} 已由 ${completion.task.agentId} 完成。${detail || "目标 Agent 已返回结果，请查看任务面板。"}`
    : `${settings.petName}报告：${completion.task.title} 未完成。${detail || "目标 Agent 执行失败，请查看任务状态。"}`;
  const channelName = message.platform === "qq" ? "QQ" : message.platform === "feishu" ? "飞书" : "钉钉";
  const delivery = await sendChannelReplyWithRetry(message, text.slice(0, 1800), channelName);
  if (settings.saveChatHistory && delivery.delivered) {
    const historyKey = `${message.platform}:${message.accountId ?? message.channelId}:${message.conversationId}`;
    const provider = boundAgentConfigForBot(message.platform, message.accountId, message.channelId, settings).provider;
    channelHistory?.append(historyKey, { role: "assistant", text: text.slice(0, 1800), provider });
  }
  botChannelManager.publish({
    type: "reply",
    channelId: message.channelId,
    platform: message.platform,
    conversationId: message.conversationId,
    messageId: message.id,
    text: text.slice(0, 1800),
    delivered: delivery.delivered,
  });
}

function eventSourceTypeForCompletion(completion: AgentTaskCompletion): AgentEventSourceType {
  if (completion.source === "codex-notify" || completion.source === "codex-app-server") return "codex";
  if (completion.source === "claude-hook") return "claude";
  if (completion.displayName.toLowerCase().includes("opencode")) return "opencode";
  return "agent";
}

/** Adapts the existing completion contract without exposing host details to the event layer. */
function taskCompletionEvent(completion: AgentTaskCompletion): AgentEvent {
  const detail = completionDetailForDisplay(completion);
  const outcome = completion.terminalState === "interrupted"
    ? "任务中断"
    : completion.success ? "任务完成" : "任务失败";
  const parsedCreatedAt = Date.parse(completion.completedAt);
  const safeCompletion: AgentTaskCompletion = { ...completion, detail };
  return {
    id: `task.completed:${completion.id}`,
    source: {
      type: eventSourceTypeForCompletion(completion),
      id: completion.agentId,
      name: completion.displayName,
    },
    type: completion.success ? "task.completed" : "task.failed",
    status: completion.success ? "completed" : "failed",
    priority: completion.success ? "normal" : "high",
    title: completion.taskTitle
      ? `${completion.displayName} · ${completion.taskTitle}`
      : `${completion.displayName}${outcome}`,
    message: detail || outcome,
    taskId: completion.taskId ?? undefined,
    sessionId: completion.sessionId,
    metadata: {
      completion: safeCompletion,
      terminalState: completion.terminalState ?? (completion.success ? "completed" : "failed"),
    },
    createdAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now(),
  };
}

function broadcastAgentEvent(event: AgentEvent): void {
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send("agent-events:event", event);
  }
}

async function notifyAgentEvent(event: AgentEvent): Promise<void> {
  const rawCompletion = event.metadata?.completion;
  if (!rawCompletion || typeof rawCompletion !== "object") {
    console.warn(`[AgentTaskNotify] event ${event.id} has no completion payload`);
    return;
  }
  const completion = rawCompletion as AgentTaskCompletion;
  const settings = getPetSettings();
  if (!settings.petPerception.enabled || completion.surface === "internal" || completion.source === "delegation") return;

  // 如果用户从未与宠物窗口交互过，不发送任务完成通知
  if (!userHasInteractedWithPetWindow) {
    console.info(`[AgentTaskNotify] skipping notification - user has not interacted with pet window yet`);
    return;
  }

  const noticeText = formatAgentEventNotification({
    status: completion.terminalState === "interrupted"
      ? "interrupted"
      : event.type === "task.failed" ? "failed" : "completed",
    sourceName: event.source.name,
    title: event.title,
    message: event.message,
    workspaceLabel: completion.workspaceLabel,
    surface: completion.surface,
    elapsedSeconds: elapsedSecondsBetween(completion.startedAt, completion.completedAt),
  });
  console.info(`[AgentTaskNotify] event notice prepared type=${event.type} id=${event.id}`);
  const routes = externalTaskNotificationRoutes(settings);
  if (routes.length === 0) {
    const activeWeChatAccount = settings.wechatAccounts.find((item) => item.id === settings.activeWeChatAccountId && item.taskNotificationEnabled)
      ?? settings.wechatAccounts.find((item) => item.taskNotificationEnabled);
    const activeWeChatTarget = activeWeChatAccount
      ? agentTaskNotificationTargets[`wechat:${activeWeChatAccount.id}`]
      : undefined;
    if (activeWeChatAccount && activeWeChatTarget) {
      queueWeChatTaskNotification(
        noticeText,
        activeWeChatAccount.id,
        `completion:${completion.id}:${activeWeChatAccount.id}`,
        activeWeChatTarget,
      );
      console.info(`[AgentTaskNotify] no live WeChat route for ${completion.agentId}:${completion.surface}; queued for its persisted conversation`);
    } else {
      console.info(`[AgentTaskNotify] no enabled bot task-notification route for ${completion.agentId}:${completion.surface}; desktop notice remains local`);
    }
    return;
  }
  for (const route of routes) {
    const { target } = route;
    const routeText = noticeText;
    let delivered = false;
    delivered = await sendTaskNotificationInOrder(target, async () => {
      if (target.platform === "wechat") {
        const botAccountId = target.botAccountId ?? botAccountIdForTarget(target, settings);
        return sendWeChatTaskNotification(target, routeText, botAccountId, `completion:${completion.id}:${botAccountId}`);
      }
      return botChannelManager.send(target.channelId, {
        conversationId: target.conversationId,
        conversationType: target.conversationType,
        replyToMessageId: target.messageId,
        text: routeText,
      });
    });
    botChannelManager.publish({
      type: "reply",
      channelId: target.channelId,
      platform: target.platform,
      conversationId: target.conversationId,
      messageId: target.messageId,
      text: routeText,
      delivered,
    });
    if (settings.saveChatHistory && delivered && target.platform !== "wechat") {
      const historyKey = `${target.platform}:${target.accountId ?? target.channelId}:${target.conversationId}`;
      const botAccountId = target.botAccountId ?? botAccountIdForTarget(target, settings);
      const provider = boundAgentConfigForBot(target.platform, botAccountId, target.channelId, settings).provider;
      channelHistory?.append(historyKey, { role: "assistant", text: routeText, provider });
    }
    if (!delivered) console.warn(`[AgentTaskNotify] bot delivery failed for ${route.routeId}`);
  }
}

async function sendChannelAcknowledgement(
  message: ChannelInboundMessage,
  channelName: string,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<void> {
  const settings = getPetSettings();
  const activeAgent = boundAgentConfigForBot(message.platform, message.accountId, message.channelId, settings);
  const acknowledgement = prefixWorkspaceReply(
    `${petName}收到啦，先给${userName}报个到～我马上继续处理喵！`,
    activeAgent,
    loadConfig("", true).agentWorkspace,
  );
  let delivered = false;
  let failureDetail = "\u901a\u9053\u672a\u63a5\u53d7\u5373\u65f6\u56de\u6267";
  try {
    delivered = await botChannelManager.send(message.channelId, {
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      replyToMessageId: message.id,
      text: acknowledgement,
    });
    if (delivered) failureDetail = "";
  } catch (error) {
    failureDetail = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to send ${message.platform} channel acknowledgement.`, error);
  }

  botChannelManager.publish({
    type: "reply",
    channelId: message.channelId,
    platform: message.platform,
    conversationId: message.conversationId,
    messageId: message.id,
    text: acknowledgement,
    delivered,
  });
  if (!delivered) {
    botChannelManager.publish({
      type: "error",
      channelId: message.channelId,
      platform: message.platform,
      messageId: message.id,
      category: "delivery",
      message: `${channelName}\u5373\u65f6\u56de\u6267\u53d1\u9001\u5931\u8d25\uff1a${failureDetail}`,
    });
  }
}

async function sendCodexDesktopTaskStatusReply(message: ChannelInboundMessage): Promise<void> {
  const settings = getPetSettings();
  const activeAgent = boundAgentConfigForBot(message.platform, message.accountId, message.channelId, settings);
  const replyProvider = activeAgent.provider;
  const snapshot = agentTaskObserver?.getSnapshot() ?? {
    enabled: false,
    observedAt: new Date().toISOString(),
    tasks: [],
    recentCompletions: [],
  };
  const text = prefixWorkspaceReply(formatCodexDesktopTaskStatus(snapshot), activeAgent, loadConfig("", true).agentWorkspace);
  const historyKey = `${message.platform}:${message.accountId ?? message.channelId}:${message.conversationId}`;
  if (settings.saveChatHistory) channelHistory?.append(historyKey, { role: "user", text: message.text });
  try {
    const delivery = await sendChannelReplyWithRetry(message, text, "QQ");
    if (settings.saveChatHistory && delivery.delivered) {
      channelHistory?.append(historyKey, { role: "assistant", text, provider: replyProvider });
    }
    botChannelManager.publish({
      type: "reply",
      channelId: message.channelId,
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.id,
      text,
      delivered: delivery.delivered,
    });
    if (!delivery.delivered) {
      botChannelManager.publish({
        type: "error",
        channelId: message.channelId,
        platform: message.platform,
        messageId: message.id,
        message: "QQ 状态查询发送失败，请检查机器人连接状态。",
      });
    }
  } catch (error) {
    console.warn("Unable to send Codex Desktop task status reply.", error);
    botChannelManager.publish({
      type: "error",
      channelId: message.channelId,
      platform: message.platform,
      messageId: message.id,
      message: "QQ 状态查询失败，请稍后重试。",
    });
  }
}

function channelMemoryOwnerId(platform: string, accountId: string | undefined, senderId: string): string {
  return `bot:${platform}:${accountId || "default-account"}:${senderId}`;
}

function memoryProjectScope(workspace: string | undefined): string | undefined {
  const project = basename(workspace?.trim() || "").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return project ? `project:${project}` : undefined;
}

function observeMemoryAfterChannelReply(input: {
  userMessage: string;
  assistantMessage: string;
  ownerId: string;
  activeAgent: AgentConfig;
  workspace?: string;
  taskId?: string;
  messageId?: string;
  source?: "channel" | "wechat" | "history";
}): void {
  const messageId = input.messageId?.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96) || "unknown";
  console.info(`[Memory] message received messageId=${messageId} source=${input.source ?? "channel"}`);
  const observer = memoryObserver;
  if (!observer) {
    console.warn(`[Memory] observer unavailable messageId=${messageId}`);
    return;
  }
  void Promise.resolve().then(() => observer.process({
    userMessage: input.userMessage,
    assistantMessage: input.assistantMessage,
    messageId,
    ownerId: input.ownerId,
    activeAgent: input.activeAgent,
    currentProject: basename(input.workspace?.trim() || ""),
    workspaceId: input.workspace,
    taskId: input.taskId,
    agentProvider: input.activeAgent.provider,
  })).catch((error) => {
    console.warn("[MemoryObserver] non-critical failure", error);
  });
}

function emptyMemoryOperationStats(): MemoryOperationStats {
  return { scanned: 0, created: 0, updated: 0, removed: 0, skipped: 0, pending: 0, errors: 0 };
}

function isHistoryNoise(text: string): boolean {
  const normalized = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length < 4
    || /^(?:system|tool|function)\s*[:：]/i.test(normalized)
    || /^\[(?:system|tool|function)\]/i.test(normalized);
}

function channelHistoryMeta(conversationKey: string): { platform: BotPlatform; accountId: string; conversationId: string } | null {
  const [platform, accountId, ...conversationParts] = conversationKey.split(":");
  if (platform !== "qq" && platform !== "feishu" && platform !== "dingtalk") return null;
  return {
    platform,
    accountId: accountId ?? "",
    conversationId: conversationParts.join(":") || accountId || "history",
  };
}

function applyMemoryOperationStats(
  stats: MemoryOperationStats,
  result: ReturnType<MemoryObserver["process"]>,
): void {
  if (result.memories.length === 0) {
    stats.skipped += 1;
    return;
  }
  result.memories.forEach((decision, index) => {
    const capture = result.applied[index];
    if (!capture?.ok) {
      stats.errors += 1;
      return;
    }
    if (!capture.entry) {
      stats.skipped += 1;
      return;
    }
    if (capture.entry.status === "pending") stats.pending += 1;
    else if (decision.action === "UPDATE") stats.updated += 1;
    else stats.created += 1;
  });
}

function rebuildMemoryFromRecentMessages(options: { sessionLimit?: number; messageLimit?: number } = {}): MemoryRebuildResult {
  const stats = emptyMemoryOperationStats();
  if (!memoryStore || !memoryObserver) {
    return { ok: false, detail: "记忆整理服务尚未启动", stats, error: "memory-service-unavailable" };
  }

  const sessionLimit = Math.max(1, Math.min(50, Math.floor(options.sessionLimit ?? 10)));
  const messageLimit = Math.max(1, Math.min(500, Math.floor(options.messageLimit ?? 200)));
  const settings = getPetSettings();
  const runtimeConfig = loadConfig("", true);
  const legacyEntries = memoryStore.maintenanceEntries();
  console.info(`[Memory] legacy reorganization started entries=${legacyEntries.length}`);
  for (const entry of legacyEntries) {
    if (!needsMemoryReorganization(entry.content)) continue;
    stats.scanned += 1;
    try {
      const result = memoryObserver.analyze({
        userMessage: entry.content,
        workspaceId: undefined,
        activeAgent: undefined,
      });
      const replacement = memoryStore.reorganizeEntry(entry.id, result.memories.map((decision) => ({
        ...decision,
        scope: decision.kind === "preference" || decision.kind === "fact" ? "user" : entry.scope,
        workspaceId: undefined,
      })));
      if (!replacement.ok) {
        stats.errors += 1;
      } else if (replacement.removed) {
        stats.removed += 1;
      } else if (replacement.replaced) {
        stats.updated += 1;
        stats.created += replacement.created;
      } else {
        stats.skipped += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.warn(`[Memory] legacy reorganization failed memoryId=${entry.id}`, error);
    }
  }
  const messages: Array<{ source: "wechat" | "channel"; item: RecentChatMessage }> = [
    ...(weChatBridge?.listRecentChatMessages(messageLimit) ?? []).map((item) => ({ source: "wechat" as const, item })),
    ...(channelHistory?.recentMessages(messageLimit) ?? []).map((item) => ({ source: "channel" as const, item })),
  ]
    .filter(({ item }) => !isHistoryNoise(item.entry.text))
    .sort((left, right) => right.item.entry.timestamp.localeCompare(left.item.entry.timestamp));
  const deduped = new Map<string, { source: "wechat" | "channel"; item: RecentChatMessage }>();
  for (const message of messages) {
    const key = `${message.source}:${message.item.conversationId}:${message.item.entry.timestamp}:${message.item.entry.text}`;
    if (!deduped.has(key)) deduped.set(key, message);
  }
  const ordered = [...deduped.values()];
  const selectedSessions = new Set<string>();
  for (const message of ordered) {
    const sessionKey = `${message.source}:${message.item.conversationId}`;
    if (selectedSessions.has(sessionKey) || selectedSessions.size < sessionLimit) selectedSessions.add(sessionKey);
  }
  const selected = ordered
    .filter((message) => selectedSessions.has(`${message.source}:${message.item.conversationId}`))
    .slice(0, messageLimit)
    .reverse();
  console.info(`[Memory] history scan started sessions=${selectedSessions.size} messages=${selected.length}`);

  for (const [index, message] of selected.entries()) {
    const historyKey = message.item.conversationId;
    const channelMeta = message.source === "channel" ? channelHistoryMeta(historyKey) : null;
    const ownerId = message.source === "wechat"
      ? channelMemoryOwnerId("wechat", settings.wechatTokenFile || "active-account", historyKey)
      : channelMeta
        ? channelMemoryOwnerId(channelMeta.platform, channelMeta.accountId, channelMeta.conversationId)
        : "primary-user";
    const activeAgent = channelMeta
      ? boundAgentConfigForBot(channelMeta.platform, channelMeta.accountId, channelMeta.conversationId, settings)
      : boundAgentConfigForBot("wechat", settings.activeWeChatAccountId, "", settings);
    stats.scanned += 1;
    try {
      const result = memoryObserver.process({
        userMessage: message.item.entry.text,
        assistantMessage: "",
        messageId: `history:${message.source}:${index}`,
        ownerId,
        activeAgent,
        currentProject: basename(runtimeConfig.agentWorkspace?.trim() || ""),
        workspaceId: runtimeConfig.agentWorkspace,
        agentProvider: activeAgent.provider,
      });
      applyMemoryOperationStats(stats, result);
    } catch (error) {
      stats.errors += 1;
      console.warn(`[Memory] history scan item failed source=${message.source}`, error);
    }
  }
  const detail = selected.length === 0
    ? `记忆重整理完成：更新 ${stats.updated} 条，删除 ${stats.removed} 条；没有找到可整理的最近对话`
    : `记忆重整理完成：扫描 ${stats.scanned} 条，新增 ${stats.created} 条，更新 ${stats.updated} 条，删除 ${stats.removed} 条，忽略 ${stats.skipped} 条，待审核 ${stats.pending} 条`;
  return { ok: stats.errors === 0, detail, stats, ...(stats.errors > 0 ? { error: "history-scan-partial-failure" } : {}) };
}

function queueChannelAgentReply(event: BotChannelEvent): void {
  if (event.type !== "message" || !["qq", "feishu", "dingtalk"].includes(event.message.platform)) return;

  const message = event.message;
  console.info(`[Memory] message received messageId=${message.id.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96) || "unknown"} source=channel`);
  const contextKey = botContextKey(message);
  rememberAgentTaskNotificationTarget({
    channelId: message.channelId,
    platform: message.platform,
    botAccountId: botAccountIdForTarget({ platform: message.platform, accountId: message.accountId, channelId: message.channelId }),
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    messageId: message.id,
    accountId: message.accountId,
    contextToken: message.contextToken,
  });
  if (message.platform === "qq" && isCodexDesktopTaskQuery(message.text)) {
    void sendCodexDesktopTaskStatusReply(message);
    return;
  }
  const channelName = message.platform === "qq" ? "QQ" : message.platform === "feishu" ? "飞书" : "钉钉";
  const acknowledgementSettings = getPetSettings();
  // Start the acknowledgement at ingress, before waiting for an earlier
  // message in this conversation. The formal Agent reply still waits for it.
  const acknowledgementPromise = sendChannelAcknowledgement(message, channelName, acknowledgementSettings.petName, acknowledgementSettings.userName);
  const queueKey = contextKey;
  const previous = channelReplyQueues.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => acknowledgementPromise).then(async () => {
    const settings = getPetSettings();
    const activeAgent = boundAgentConfigForBot(message.platform, message.accountId, message.channelId, settings);
    const replyProvider = activeAgent.provider;
    const runtimeConfig = loadConfig("", true);
    const formatReply = (value: string): string => prefixWorkspaceReply(value, activeAgent, runtimeConfig.agentWorkspace);
    const historyKey = `${message.platform}:${message.accountId ?? message.channelId}:${message.conversationId}`;
    const memoryOwnerId = channelMemoryOwnerId(message.platform, message.accountId ?? message.channelId, message.senderId);
    const contextParts = [
      settings.saveChatHistory && !isLiveStateQuery(message.text)
        ? channelHistory?.contextFor(historyKey, settings.petName, settings.userName) ?? ""
        : "",
      isLiveStateQuery(message.text)
        ? ""
        : memoryRetriever?.contextFor({
          query: message.text,
          ownerId: memoryOwnerId,
          workspaceId: runtimeConfig.agentWorkspace,
          workspacePath: runtimeConfig.agentWorkspace,
          projectScope: memoryProjectScope(runtimeConfig.agentWorkspace),
          agentScope: `agent:${activeAgent.id}`,
          limit: 6,
        }) ?? "",
    ].filter(Boolean);
    const conversationContext = contextParts.join("\n\n");
    if (settings.saveChatHistory) channelHistory?.append(historyKey, { role: "user", text: message.text });
    const memoryCapture = memoryStore?.captureExplicit(message.text, undefined, memoryOwnerId);
    if (memoryCapture) {
      const memoryText = formatReply(memoryCapture.ok
        ? `已记住：${(memoryCapture.entries ?? (memoryCapture.entry ? [memoryCapture.entry] : [])).map((entry) => entry.content).join("\n") || "这条信息"}`
        : `这条记忆没有保存：${memoryCapture.detail}`);
      const delivery = await sendChannelReplyWithRetry(message, memoryText, message.platform === "qq" ? "QQ" : message.platform === "feishu" ? "飞书" : "钉钉");
      if (settings.saveChatHistory && delivery.delivered) channelHistory?.append(historyKey, { role: "assistant", text: memoryText, provider: replyProvider });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: memoryText,
        delivered: delivery.delivered,
      });
      return;
    }
    const forgetCapture = memoryStore?.captureExplicitForget(message.text, runtimeConfig.agentWorkspace, memoryOwnerId);
    if (forgetCapture) {
      const memoryText = formatReply(forgetCapture.ok ? "已删除匹配的长期记忆。" : `没有删除记忆：${forgetCapture.detail}`);
      const delivery = await sendChannelReplyWithRetry(message, memoryText, channelName);
      if (settings.saveChatHistory && delivery.delivered) channelHistory?.append(historyKey, { role: "assistant", text: memoryText, provider: replyProvider });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: memoryText,
        delivered: delivery.delivered,
      });
      return;
    }
    const agentListText = (() => {
      const value = agentDelegationService?.listIfRequested(message.text) ?? null;
      return value ? formatReply(value) : null;
    })();
    if (agentListText) {
      const delivery = await sendChannelReplyWithRetry(message, agentListText, channelName);
      if (settings.saveChatHistory && delivery.delivered) channelHistory?.append(historyKey, { role: "assistant", text: agentListText, provider: replyProvider });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: agentListText,
        delivered: delivery.delivered,
      });
      observeMemoryAfterChannelReply({ userMessage: message.text, assistantMessage: agentListText, ownerId: memoryOwnerId, activeAgent, workspace: runtimeConfig.agentWorkspace, messageId: message.id, source: "channel" });
      return;
    }
    const delegationPreview = agentDelegationService?.preview(message.text);
    if (delegationPreview) {
      const delegation = agentDelegationService?.start(
        delegationPreview,
        contextKey,
        (completion) => sendDelegationCompletionToChannel(message, completion),
      ) ?? { ok: false, detail: "委派服务尚未启动" };
      const delegationText = formatReply(delegation.ok
        ? `已收到委派请求。${delegation.detail}；我会继续盯着目标 Agent 的真实进度。`
        : `这次委派还没有开始：${delegation.detail}`);
      const delivery = await sendChannelReplyWithRetry(message, delegationText, message.platform === "qq" ? "QQ" : message.platform === "feishu" ? "飞书" : "钉钉");
      if (settings.saveChatHistory && delivery.delivered) channelHistory?.append(historyKey, { role: "assistant", text: delegationText, provider: replyProvider });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: delegationText,
        delivered: delivery.delivered,
      });
      observeMemoryAfterChannelReply({ userMessage: message.text, assistantMessage: delegationText, ownerId: memoryOwnerId, activeAgent, workspace: runtimeConfig.agentWorkspace, messageId: message.id, source: "channel" });
      return;
    }
    const followUp = agentDelegationService?.followUp(contextKey, message.text);
    if (followUp?.handled) {
      const followUpText = formatReply(followUp.ok
        ? followUp.detail
        : `这次补充信息没有发送：${followUp.detail}`);
      const delivery = await sendChannelReplyWithRetry(message, followUpText, channelName);
      if (settings.saveChatHistory && delivery.delivered) channelHistory?.append(historyKey, { role: "assistant", text: followUpText, provider: replyProvider });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: followUpText,
        delivered: delivery.delivered,
      });
      observeMemoryAfterChannelReply({ userMessage: message.text, assistantMessage: followUpText, ownerId: memoryOwnerId, activeAgent, workspace: runtimeConfig.agentWorkspace, messageId: message.id, source: "channel" });
      return;
    }
    botChannelManager.publish({
      type: "agent-status",
      channelId: message.channelId,
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.id,
      status: "starting",
       detail: `${activeAgent.displayName} 正在准备${channelName}回复…`,
    });
    try {
      const reply = await generateReply(
        runtimeConfig,
        stripControllerRoutingPrefix(message.text),
        replyProvider,
        conversationContext,
        settings.codexSandboxMode,
        (status, detail) => botChannelManager.publish({
          type: "agent-status",
          channelId: message.channelId,
          platform: message.platform,
          conversationId: message.conversationId,
          messageId: message.id,
          status,
          detail,
        }),
        contextKey,
        activeAgent,
        settings.agentPermissionPolicy,
        channelName,
        settings.petName,
        settings.userName,
        settings.zeroToken,
      );
      const mediaDirective = extractMediaDirective(reply);
      const text = formatReply((mediaDirective?.text ?? reply).trim());
      if (!text && !mediaDirective) throw new Error("Agent 没有返回可发送的文本或媒体");
      botChannelManager.publish({
        type: "agent-status",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        status: "sending",
        detail: `回复已生成，正在发送到${channelName}…`,
      });
      const delivery = text
        ? await sendChannelReplyWithRetry(message, text, channelName)
        : { delivered: true, attempts: 0 };
      if (!delivery.delivered) throw new Error(`${channelName}回复发送失败，已重试${delivery.attempts}次，请检查机器人连接状态`);
      let mediaFailure = "";
      if (mediaDirective) {
        const mediaDelivery = await sendChannelMediaWithRetry(message, {
          kind: mediaDirective.kind,
          source: mediaDirective.source,
          caption: "",
        }, channelName);
        if (!mediaDelivery.delivered) {
          mediaFailure = mediaDelivery.detail;
          const errorText = formatReply(mediaDeliveryGuidance(mediaDirective.kind, mediaDelivery.detail));
          const errorDelivery = await sendChannelReplyWithRetry(message, errorText, channelName);
          botChannelManager.publish({
            type: "error",
            channelId: message.channelId,
            platform: message.platform,
            messageId: message.id,
            message: errorText,
          });
          if (!errorDelivery.delivered) console.warn(`${channelName}媒体错误提示也未送达：${mediaDelivery.detail}`);
        }
      }
      const historyText = text || (mediaDirective?.kind === "file" ? "文件已发送" : "图片已发送");
      if (settings.saveChatHistory) {
        channelHistory?.append(historyKey, { role: "assistant", text: mediaFailure ? `${historyText}\n${mediaFailure}` : historyText, provider: replyProvider });
      }
      botChannelManager.publish({
        type: "agent-status",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        status: "completed",
         detail: `${activeAgent.displayName} 已将${channelName}回复发送`,
      });
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: historyText,
        delivered: true,
      });
      observeMemoryAfterChannelReply({ userMessage: message.text, assistantMessage: historyText, ownerId: memoryOwnerId, activeAgent, workspace: runtimeConfig.agentWorkspace, messageId: message.id, source: "channel" });
    } catch (error) {
      console.warn(`Unable to generate ${message.platform} channel reply.`, error);
      const detail = error instanceof Error ? error.message : String(error);
      botChannelManager.publish({
        type: "agent-status",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        status: "failed",
        detail,
      });
      botChannelManager.publish({
        type: "error",
        channelId: message.channelId,
        platform: message.platform,
        messageId: message.id,
        message: `${channelName}回复失败：${detail}`,
      });
      const fallback = formatReply(channelAgentFallback(detail));
      const fallbackDelivery = await sendChannelReplyWithRetry(message, fallback, channelName);
      if (settings.saveChatHistory) {
        channelHistory?.append(historyKey, { role: "assistant", text: fallback, provider: replyProvider, source: "fallback" });
      }
      if (!fallbackDelivery.delivered) {
        botChannelManager.publish({
          type: "agent-status",
          channelId: message.channelId,
          platform: message.platform,
          conversationId: message.conversationId,
          messageId: message.id,
          status: "failed",
          detail: `${channelName}兜底提示发送失败，已重试 ${fallbackDelivery.attempts} 次`,
        });
      }
      botChannelManager.publish({
        type: "reply",
        channelId: message.channelId,
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.id,
        text: fallback,
        delivered: fallbackDelivery.delivered,
      });
      observeMemoryAfterChannelReply({ userMessage: message.text, assistantMessage: fallback, ownerId: memoryOwnerId, activeAgent, workspace: runtimeConfig.agentWorkspace, messageId: message.id, source: "channel" });
    }
  });
  channelReplyQueues.set(queueKey, next);
  void next.finally(() => {
    if (channelReplyQueues.get(queueKey) === next) channelReplyQueues.delete(queueKey);
  });
}

function channelAgentFallback(detail: string): string {
  if (detail.includes('429') || /quota exhausted|rate limit|配额|额度/i.test(detail)) {
    return 'Agent 未能回答这条消息：当前 Agent 额度或速率限制，请切换 Agent 后重试。';
  }
  const safeDetail = detail
    .split(String.fromCharCode(13)).join(' ')
    .split(String.fromCharCode(10)).join(' ')
    .trim()
    .slice(0, 180);
  return `Agent 未能回答这条消息（这不是模型回答）：${safeDetail || '未返回具体错误'}`;
}

function qqConfigForAccount(account: QQAccount): QQChannelConfig | null {
  const credentials = qqCredentialStore?.load(account.id);
  if (!credentials) return null;
  return {
    channelId: account.id.startsWith("qq:") ? account.id : `qq:${account.id}`,
    appId: account.appId,
    clientSecret: credentials.clientSecret,
    accessToken: credentials.accessToken,
    sandbox: false,
    maxRetry: 5,
  };
}

async function stopQQAccount(accountId: string): Promise<void> {
  const adapter = qqChannelAdapters.get(accountId);
  if (!adapter) return;
  await adapter.stop();
  botChannelManager.unregister(adapter.channelId);
  qqChannelAdapters.delete(accountId);
}

async function startQQAccount(account: QQAccount): Promise<{ ok: boolean; detail: string }> {
  await stopQQAccount(account.id);
  if (!account.enabled) return { ok: false, detail: "QQ 机器人已停用" };

  const config = qqConfigForAccount(account);
  if (!config) return { ok: false, detail: "QQ 凭据不可用，请重新扫码或填写 AppSecret" };

  const adapter = new QQChannelAdapter(config);
  qqChannelAdapters.set(account.id, adapter);
  botChannelManager.register(adapter);
  try {
    await adapter.start();
    return { ok: true, detail: adapter.getStatus().detail };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function finalizeQQQrLogin(
  credentials: QrConnectCredentials[],
  displayName: string,
): Promise<{ ok: boolean; detail: string; appId?: string }> {
  if (!qqCredentialStore?.available) {
    return { ok: false, detail: "系统加密存储不可用，无法安全保存 QQ 凭据" };
  }

  const credential = credentials.find((item) => item.appId.trim() && item.appSecret.trim());
  if (!credential) return { ok: false, detail: "QQ 扫码成功，但没有收到有效的机器人凭据" };

  const appId = credential.appId.trim();
  const appSecret = credential.appSecret.trim();
  const existingAccount = petSettings.qqAccounts.find((account) => account.appId === appId);
  const account: QQAccount = {
    id: existingAccount?.id ?? `qq:${appId}`,
    displayName: displayName.trim() || existingAccount?.displayName || `QQ Bot ${appId}`,
    appId,
    enabled: true,
    agentId: existingAccount?.agentId || fallbackAgentId(),
    taskNotificationEnabled: existingAccount?.taskNotificationEnabled ?? false,
    taskNotificationMode: existingAccount?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
  };

  for (const conflictingAccount of petSettings.qqAccounts.filter((item) => item.appId === appId && item.id !== account.id)) {
    await stopQQAccount(conflictingAccount.id);
    qqCredentialStore.remove(conflictingAccount.id);
  }
  if (!qqCredentialStore.save(account.id, { clientSecret: appSecret })) {
    return { ok: false, detail: "QQ 凭据保存失败，请检查系统加密存储权限", appId };
  }

  petSettings.qqAccounts = [
    ...petSettings.qqAccounts.filter((item) => item.id !== account.id && item.appId !== appId),
    account,
  ];
  petSettings.activeQQAccountId = account.id;
  savePetSettings();

  await stopQQAccount("env");
  const result = await startQQAccount(account);
  broadcastPetSettings();
  return {
    ok: result.ok,
    detail: result.ok ? "QQ Bot 连接成功" : `凭据已保存，连接失败：${result.detail}`,
    appId,
  };
}

const qqQrLoginManager = new QQQrLoginManager(finalizeQQQrLogin);

function feishuConfigForAccount(account: FeishuAccount): FeishuChannelConfig | null {
  const credentials = feishuCredentialStore?.load(account.id);
  if (!credentials) return null;
  return {
    channelId: account.id.startsWith("feishu:") ? account.id : `feishu:${account.id}`,
    appId: account.appId,
    appSecret: credentials.appSecret,
  };
}

async function stopFeishuAccount(accountId: string): Promise<void> {
  const adapter = feishuChannelAdapters.get(accountId);
  if (!adapter) return;
  await adapter.stop();
  botChannelManager.unregister(adapter.channelId);
  feishuChannelAdapters.delete(accountId);
}

async function startFeishuAccount(account: FeishuAccount): Promise<{ ok: boolean; detail: string }> {
  await stopFeishuAccount(account.id);
  if (!account.enabled) return { ok: false, detail: "飞书机器人已停用" };

  const config = feishuConfigForAccount(account);
  if (!config) return { ok: false, detail: "飞书凭据不可用，请重新扫码或填写 AppSecret" };

  const adapter = new FeishuChannelAdapter(config);
  feishuChannelAdapters.set(account.id, adapter);
  botChannelManager.register(adapter);
  try {
    await adapter.start();
    return { ok: true, detail: adapter.getStatus().detail };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function finalizeFeishuQrLogin(
  credentials: FeishuQrCredentials,
  displayName: string,
): Promise<{ ok: boolean; detail: string; appId?: string }> {
  if (!feishuCredentialStore?.available) {
    return { ok: false, detail: "系统加密存储不可用，无法安全保存飞书凭据" };
  }

  const appId = credentials.appId.trim();
  const appSecret = credentials.appSecret.trim();
  if (!appId || !appSecret) return { ok: false, detail: "飞书扫码成功，但没有收到有效的应用凭据" };

  const existingAccount = petSettings.feishuAccounts.find((account) => account.appId === appId);
  const account: FeishuAccount = {
    id: existingAccount?.id ?? `feishu:${appId}`,
    displayName: displayName.trim() || existingAccount?.displayName || `飞书 Bot ${appId}`,
    appId,
    enabled: true,
    agentId: existingAccount?.agentId || fallbackAgentId(),
    taskNotificationEnabled: existingAccount?.taskNotificationEnabled ?? false,
    taskNotificationMode: existingAccount?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
  };

  for (const conflictingAccount of petSettings.feishuAccounts.filter((item) => item.appId === appId && item.id !== account.id)) {
    await stopFeishuAccount(conflictingAccount.id);
    feishuCredentialStore.remove(conflictingAccount.id);
  }
  if (!feishuCredentialStore.save(account.id, { appSecret })) {
    return { ok: false, detail: "飞书凭据保存失败，请检查系统加密存储权限", appId };
  }

  petSettings.feishuAccounts = [
    ...petSettings.feishuAccounts.filter((item) => item.id !== account.id && item.appId !== appId),
    account,
  ];
  petSettings.activeFeishuAccountId = account.id;
  savePetSettings();

  const result = await startFeishuAccount(account);
  broadcastPetSettings();
  return {
    ok: result.ok,
    detail: result.ok ? "飞书 Bot 连接成功" : `凭据已保存，连接失败：${result.detail}`,
    appId,
  };
}

const feishuQrLoginManager = new FeishuQrLoginManager(finalizeFeishuQrLogin);

function dingtalkConfigForAccount(account: DingTalkAccount): DingTalkChannelConfig | null {
  const credentials = dingtalkCredentialStore?.load(account.id);
  if (!credentials) return null;
  return {
    channelId: account.id.startsWith("dingtalk:") ? account.id : `dingtalk:${account.id}`,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}

async function stopDingTalkAccount(accountId: string): Promise<void> {
  const adapter = dingtalkChannelAdapters.get(accountId);
  if (!adapter) return;
  await adapter.stop();
  botChannelManager.unregister(adapter.channelId);
  dingtalkChannelAdapters.delete(accountId);
}

async function startDingTalkAccount(account: DingTalkAccount): Promise<{ ok: boolean; detail: string }> {
  await stopDingTalkAccount(account.id);
  if (!account.enabled) return { ok: false, detail: "钉钉机器人已停用" };

  const config = dingtalkConfigForAccount(account);
  if (!config) return { ok: false, detail: "钉钉凭据不可用，请重新填写 Client Secret" };

  const adapter = new DingTalkChannelAdapter(config);
  dingtalkChannelAdapters.set(account.id, adapter);
  botChannelManager.register(adapter);
  try {
    await adapter.start();
    return { ok: true, detail: adapter.getStatus().detail };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function configureDingTalkAccount(input: { id?: string; displayName: string; clientId: string; clientSecret: string; agentId?: string }): Promise<{ ok: boolean; detail: string; settings?: PetSettings; clientId?: string }> {
  if (!dingtalkCredentialStore?.available) {
    return { ok: false, detail: "系统加密存储不可用，无法安全保存钉钉凭据" };
  }
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) return { ok: false, detail: "钉钉 Client ID 或 Client Secret 无效" };
  const id = input.id?.trim() || `dingtalk:${clientId}`;
  const displayName = input.displayName.trim() || `钉钉 Bot ${clientId}`;
  const existingAccount = petSettings.dingtalkAccounts.find((account) => account.id === id || account.clientId === clientId);
  const account: DingTalkAccount = {
    id,
    displayName,
    clientId,
    enabled: true,
    agentId: requestedAgentIdOrFallback(input.agentId, existingAccount?.agentId),
    taskNotificationEnabled: existingAccount?.taskNotificationEnabled ?? false,
    taskNotificationMode: existingAccount?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
  };
  const conflictingAccounts = petSettings.dingtalkAccounts.filter((item) => item.clientId === clientId && item.id !== id);
  for (const conflictingAccount of conflictingAccounts) {
    await stopDingTalkAccount(conflictingAccount.id);
    dingtalkCredentialStore.remove(conflictingAccount.id);
  }
  if (!dingtalkCredentialStore.save(id, { clientId, clientSecret })) {
    return { ok: false, detail: "钉钉凭据保存失败，请检查系统加密存储权限" };
  }
  petSettings.dingtalkAccounts = [
    ...petSettings.dingtalkAccounts.filter((item) => item.id !== id && item.clientId !== clientId),
    account,
  ];
  petSettings.activeDingTalkAccountId = account.id;
  savePetSettings();
  broadcastPetSettings();

  const result = await startDingTalkAccount(account);
  return {
    ...result,
    settings: getPetSettings(),
    clientId: existingAccount?.clientId ?? clientId,
  };
}

function startEnvironmentQQChannel(config: QQChannelConfig): void {
  if (qqChannelAdapters.has("env")) return;
  const adapter = new QQChannelAdapter(config);
  qqChannelAdapters.set("env", adapter);
  botChannelManager.register(adapter);
  void adapter.start().catch((error) => {
    console.warn("Unable to start QQ channel from environment variables.", error);
  });
}

app.whenReady().then(async () => {
  loadPetSettings();
  agentWindowTracker = new AgentWindowTracker({
    onDisplayChanged: (agentId, displayId) => {
      console.info(`[AgentWindowTracker] ${agentId} moved to display ${displayId}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screen-capture:status-changed", { agentId, displayId });
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send("screen-capture:status-changed", { agentId, displayId });
      }
    },
  });
  agentWindowTracker.setConfigs(petSettings.agentConfigs);
  agentWindowTracker.start();
  loadAgentTaskNotificationTarget();
  loadWeChatTaskNotificationQueue();
  await reconcileLocalAgentRegistry();
  registerPetStyleProtocol();
  qqCredentialStore = new QQCredentialStore(join(app.getPath("userData"), "qq-credentials.json"));
  feishuCredentialStore = new FeishuCredentialStore(join(app.getPath("userData"), "feishu-credentials.json"));
  dingtalkCredentialStore = new DingTalkCredentialStore(join(app.getPath("userData"), "dingtalk-credentials.json"));
  memoryStore = new MemoryStore({ userDataPath: app.getPath("userData") });
  memoryRetriever = new MemoryRetriever(memoryStore);
  memoryObserver = new MemoryObserver(memoryStore);
  channelHistory = new ChatHistoryStore(
    join(app.getPath("userData"), "channel-history.json"),
    true,
  );
  agentPerceptionService = new AgentPerceptionService({
    getSettings: getPetSettings,
    getControllerStatus: getAgentControllerStatus,
    runAgentPerception: (config, signal) => {
      const settings = getPetSettings();
      return generateAgentPerception(
        loadConfig("", true),
        signal,
        config,
        settings.codexSandboxMode,
        settings.agentPermissionPolicy,
        undefined,
        settings.petName,
        settings.userName,
      );
    },
  });
  agentPerceptionService.start();
  agentEventBus = new EventBus();
  notificationManager = new NotificationManager(agentEventBus, {
    dispatch: (event) => {
      broadcastAgentEvent(event);
      return notifyAgentEvent(event);
    },
  });
  agentTaskObserver = new AgentTaskObserver({
    getSettings: getPetSettings,
    getEndpoints: () => agentEndpointRegistry?.getSnapshot().endpoints ?? [],
  });
  agentTaskObserver.subscribeSnapshot((snapshot) => {
    agentPerceptionService?.setAgentTaskSnapshot(snapshot);
    longTaskReplyScheduler?.handleAgentTaskSnapshot(snapshot);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-tasks:snapshot", snapshot);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send("agent-tasks:snapshot", snapshot);
  });
  agentTaskObserver.subscribeCompletion((completion) => {
    const event = taskCompletionEvent(completion);
    console.info(`[AgentEvent] publish type=${event.type} status=${event.status} id=${event.id}`);
    agentEventBus?.publish(event);
  });
  agentTaskObserver.start();
  // 本地事件桥：外部宿主（Codex notify / app-server / Claude hook / 手动测试）
  // 经命名管道推入脱敏生命周期事件，交由任务观察者统一仲裁与通知。
  const agentBridgeCredentials = ensureAgentBridgeCredentials();
  if (agentBridgeCredentials.tokenFile) {
    delete process.env.PENGUIN_AGENT_BRIDGE_TOKEN;
    process.env.PENGUIN_AGENT_BRIDGE_TOKEN_FILE = agentBridgeCredentials.tokenFile;
    console.info(`Agent event bridge authentication enabled; token file: ${agentBridgeCredentials.tokenFile}`);
  } else {
    process.env.PENGUIN_AGENT_BRIDGE_TOKEN = agentBridgeCredentials.token;
  }
  agentEventBridge = new AgentEventBridge({
    authToken: agentBridgeCredentials.token,
    onStateChange: (state) => agentEndpointRegistry?.setBridgeState(state),
  });
  agentEndpointRegistry = new AgentEndpointRegistry(agentEventBridge.endpointPath);
  agentEndpointRegistry.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-endpoints:snapshot", snapshot);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send("agent-endpoints:snapshot", snapshot);
  });
  agentEventBridge.subscribeEndpoint((message) => agentEndpointRegistry?.handle(message));
  agentEventBridge.subscribe((event) => agentTaskObserver?.handleExternalEvent(event));
  agentDelegationService = new AgentDelegationService({
    getSettings: getPetSettings,
    getEndpoints: () => agentEndpointRegistry?.getSnapshot().endpoints ?? [],
    dispatch: (endpointId, request) => agentEventBridge?.dispatch(endpointId, request) ?? { ok: false, detail: "Agent 事件桥尚未启动" },
    send: (endpointId, request) => agentEventBridge?.send(endpointId, request) ?? { ok: false, detail: "Agent 事件桥尚未启动" },
    generateLocal: (config, instruction, onProgress, conversationId) => {
      const settings = getPetSettings();
      return generateReply(
        loadConfig("", true),
        instruction,
        config.provider,
        "",
        settings.codexSandboxMode,
        onProgress,
        conversationId,
        config,
        settings.agentPermissionPolicy,
        "指定 Agent 委派",
        settings.petName,
        settings.userName,
        settings.zeroToken,
      );
    },
    emitEvent: (event) => agentTaskObserver?.handleExternalEvent(event),
    onCompletion: () => undefined,
  });
  agentEventBridge.subscribe((event) => agentDelegationService?.handleExternalEvent(event));
  agentEventBridge.start();
  codexRolloutWatcher = new CodexRolloutWatcher({
    onEvent: (event) => agentTaskObserver?.handleExternalEvent(event),
  });
  codexRolloutWatcher.start();
  claudeRolloutWatcher = new ClaudeRolloutWatcher({
    onEvent: (event) => agentTaskObserver?.handleExternalEvent(event),
  });
  claudeRolloutWatcher.start();
  longTaskReplyScheduler = new LongTaskReplyScheduler({
    getSettings: getPetSettings,
    getExternalNotificationRoutes: () => externalTaskNotificationRoutes(getPetSettings()),
    send: async (target, message) => {
      return sendTaskNotificationInOrder(target, async () => {
        if (target.platform === "wechat") {
          const botAccountId = target.botAccountId ?? target.accountId ?? target.channelId;
          return sendWeChatTaskNotification(target, message.text, botAccountId);
        }
        return botChannelManager.send(target.channelId, message);
      });
    },
    publish: (event) => botChannelManager.publish(event),
  });
  longTaskReplyScheduler.setSettings(getPetSettings());
  longTaskReplyScheduler.handleAgentTaskSnapshot(agentTaskObserver.getSnapshot());
  longTaskReplyScheduler.restoreTargets(allNotificationTargets());
  ipcMain.handle("pet:hide", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });
  ipcMain.handle("pet:close", () => app.quit());
  ipcMain.handle("pet:version", () => app.getVersion());
  ipcMain.handle("ccswitch:status", (): CcSwitchStatus => readCcSwitchStatus(petSettings.ccSwitchSyncEnabled));
  ipcMain.handle("zero-token:check", (_event, rawConfig: unknown): Promise<ZeroTokenProviderStatus> => {
    const config = rawConfig && typeof rawConfig === "object"
      ? normalizeZeroTokenSettings(rawConfig)
      : petSettings.zeroToken;
    return checkZeroTokenConnection(config);
  });
  ipcMain.handle("zero-token:runtime", async (): Promise<ZeroTokenProviderStatus> => {
    const status = await zeroTokenRuntime.getStatus(petSettings.zeroToken.provider);
    return statusFromEmbedded(status);
  });
  ipcMain.handle("zero-token:status", async (_event, rawProviderId: unknown): Promise<ZeroTokenProviderStatus> => {
    const providerId = normalizeZeroTokenProvider(rawProviderId, petSettings.zeroToken.provider);
    return statusFromEmbedded(await zeroTokenRuntime.getStatus(providerId));
  });
  ipcMain.handle("zero-token:start", (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    return zeroTokenRuntime.initialize().then(() => zeroTokenRuntime.getStatus(config.provider)).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:stop", async () => {
    zeroTokenRuntime.dispose();
    return statusFromEmbedded({
      provider: petSettings.zeroToken.provider,
      name: "Zero Token",
      status: "stopped",
      detail: "Zero Token 已停止",
      lastError: null,
      updatedAt: Date.now(),
    });
  });
  ipcMain.handle("zero-token:restart", (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    zeroTokenRuntime.dispose();
    return zeroTokenRuntime.initialize().then(() => zeroTokenRuntime.getStatus(config.provider)).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:health", (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    return zeroTokenRuntime.getStatus(config.provider).then(statusFromEmbedded).then((status) => status.runtimeProvider);
  });
  ipcMain.handle("zero-token:check-login", (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    return zeroTokenRuntime.getStatus(config.provider).then(statusFromEmbedded).then((status) => status.runtimeProvider);
  });
  ipcMain.handle("zero-token:login-runtime", (_event, rawConfig: unknown, rawProviderId: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    const providerId = normalizeZeroTokenProvider(rawProviderId, config.provider);
    return zeroTokenRuntime.login(providerId).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:logout-runtime", (_event, rawConfig: unknown, rawProviderId: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    const providerId = normalizeZeroTokenProvider(rawProviderId, config.provider);
    return zeroTokenRuntime.logout(providerId).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:logs", () => []);
  ipcMain.handle("zero-token:refresh-models", async (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object" ? normalizeZeroTokenSettings(rawConfig) : petSettings.zeroToken;
    return statusFromEmbedded(await zeroTokenRuntime.getStatus(config.provider));
  });
  ipcMain.handle("zero-token:providers", () => {
    return Promise.all(zeroTokenRuntime.getAvailableProviders().map(async (provider) => ({
      id: provider.id,
      name: provider.name,
      website: provider.loginUrl,
      authenticated: (await zeroTokenRuntime.getStatus(provider.id)).status === "ready",
      modelCount: 0,
    })));
  });
  ipcMain.handle("zero-token:models", (_event, rawConfig: unknown) => {
    void rawConfig;
    return [];
  });
  ipcMain.handle("zero-token:login", (_event, rawConfig: unknown, rawProviderId: unknown) => {
    const config = rawConfig && typeof rawConfig === "object"
      ? normalizeZeroTokenSettings(rawConfig)
      : petSettings.zeroToken;
    const providerId = normalizeZeroTokenProvider(rawProviderId, config.provider);
    return zeroTokenRuntime.login(providerId).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:logout", (_event, rawConfig: unknown, rawProviderId: unknown) => {
    const config = rawConfig && typeof rawConfig === "object"
      ? normalizeZeroTokenSettings(rawConfig)
      : petSettings.zeroToken;
    const providerId = normalizeZeroTokenProvider(rawProviderId, config.provider);
    return zeroTokenRuntime.logout(providerId).then(statusFromEmbedded);
  });
  ipcMain.handle("zero-token:open-login-window", (_event, rawConfig: unknown, rawProviderId: unknown) => {
    const config = rawConfig && typeof rawConfig === "object"
      ? normalizeZeroTokenSettings(rawConfig)
      : petSettings.zeroToken;
    const providerId = normalizeZeroTokenProvider(rawProviderId, config.provider);
    return zeroTokenRuntime.initialize().then(() => statusFromEmbedded(zeroTokenRuntime.openLoginWindow(providerId)));
  });
  ipcMain.handle("zero-token:open-dashboard", async (_event, rawConfig: unknown) => {
    const config = rawConfig && typeof rawConfig === "object"
      ? normalizeZeroTokenSettings(rawConfig)
      : petSettings.zeroToken;
    return zeroTokenRuntime.initialize().then(() => {
      zeroTokenRuntime.openLoginWindow(config.provider);
      return { ok: true, detail: `已打开 ${config.provider} 登录窗口` };
    });
  });
  ipcMain.handle("ccswitch:sync", (_event, rawSourceIds: unknown): CcSwitchImportResult => {
    const sourceIds = Array.isArray(rawSourceIds)
      ? rawSourceIds.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : undefined;
    return bindCcSwitchProfiles(sourceIds);
  });
  ipcMain.handle("updates:check", (): Promise<UpdateCheckResult> => checkForUpdate(app.getVersion()));
  ipcMain.handle("updates:open-download", async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return { ok: false, detail: "下载地址无效" };
    try {
      const url = new URL(rawUrl.trim());
      if (url.protocol !== "https:") return { ok: false, detail: "仅允许打开 HTTPS 下载页" };
      await shell.openExternal(url.toString());
      return { ok: true, detail: "已打开下载页" };
    } catch {
      return { ok: false, detail: "下载页打开失败" };
    }
  });
  // 受控外部链接：仅允许钉钉官方开放平台主机的 HTTPS 链接，其余一律拒绝。
  ipcMain.handle("links:open-external", async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return { ok: false, detail: "链接地址无效" };
    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return { ok: false, detail: "链接地址无效" };
    }
    if (url.protocol !== "https:" || !DINGTALK_ONBOARDING_HOSTS.has(url.hostname)) {
      return { ok: false, detail: "仅支持打开钉钉官方开放平台链接" };
    }
    try {
      await shell.openExternal(url.toString());
      return { ok: true, detail: "已在浏览器中打开" };
    } catch {
      return { ok: false, detail: "链接打开失败" };
    }
  });
  ipcMain.on("pet:drag-start", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    userHasInteractedWithPetWindow = true;
    const [windowX, windowY] = mainWindow.getPosition();
    const cursor = screen.getCursorScreenPoint();
    const desktop = getVirtualDesktopBounds();
    const [windowWidth, windowHeight] = mainWindow.getSize();
    activeWindowDrag = {
      sender: event.sender,
      windowX,
      windowY,
      cursorX: cursor.x,
      cursorY: cursor.y,
      lastCursorX: cursor.x,
      lastCursorY: cursor.y,
      lastWindowX: windowX,
      lastWindowY: windowY,
      shapeBounds: currentPetWindowClampShape(),
      desktop,
      windowWidth,
      windowHeight,
    };
  });
  ipcMain.on("pet:move", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || activeWindowDrag?.sender !== event.sender) return;

    // Read the cursor in the main process. PointerEvent.screenX/Y are renderer
    // CSS coordinates and can use a different scale on high-DPI monitors;
    // screen.getCursorScreenPoint() and setPosition() use the same native DIP
    // coordinate space.
    const cursor = screen.getCursorScreenPoint();
    if (cursor.x === activeWindowDrag.lastCursorX && cursor.y === activeWindowDrag.lastCursorY) return;
    activeWindowDrag.lastCursorX = cursor.x;
    activeWindowDrag.lastCursorY = cursor.y;

    const nextX = activeWindowDrag.windowX + cursor.x - activeWindowDrag.cursorX;
    const nextY = activeWindowDrag.windowY + cursor.y - activeWindowDrag.cursorY;
    const position = clampPetWindowPosition(
      nextX,
      nextY,
      activeWindowDrag.desktop,
      activeWindowDrag.windowWidth,
      activeWindowDrag.windowHeight,
      activeWindowDrag.shapeBounds,
    );
    if (position.x === activeWindowDrag.lastWindowX && position.y === activeWindowDrag.lastWindowY) return;

    mainWindow.setPosition(position.x, position.y, false);
    activeWindowDrag.lastWindowX = position.x;
    activeWindowDrag.lastWindowY = position.y;
  });
  ipcMain.on("pet:drag-end", (event) => {
    if (activeWindowDrag?.sender !== event.sender) return;
    activeWindowDrag = null;
  });
  ipcMain.on("pet:mouse-passthrough", (event, ignore: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || typeof ignore !== "boolean") return;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    keepPetWindowOnTop();
  });

  ipcMain.on("pet:task-tray-expanded", (event, expanded: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || typeof expanded !== "boolean") return;
    setPetWindowExpanded(expanded);
    keepPetWindowOnTop();
  });

  ipcMain.on("pet:set-shape", (event, rawRects: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !Array.isArray(rawRects)) return;
    if (rawRects.length > MAX_WINDOW_SHAPE_RECTS) return;

    const rects: WindowShapeRect[] = [];
    for (const rawRect of rawRects) {
      if (!rawRect || typeof rawRect !== "object") return;
      const rect = rawRect as Record<string, unknown>;
      const x = rect.x;
      const y = rect.y;
      const width = rect.width;
      const height = rect.height;
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        x < 0 ||
        y < 0 ||
        x + width > PET_WINDOW_WIDTH ||
        y + height > PET_WINDOW_HEIGHT
      ) {
        return;
      }
      rects.push({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    }

    // Keep the alpha bounds for edge dragging, but do not apply a binary
    // native region. Windows regions quantize the animated feather edge into
    // stair-step pixels; the transparent Canvas already renders the alpha
    // smoothly and handles hit testing through mouse passthrough.
    if (rects.length === 0) {
      petShapeBounds = null;
    } else {
      petShapeBounds = rects.reduce<WindowShapeBounds>(
        (bounds, rect) => ({
          left: Math.min(bounds.left, rect.x),
          top: Math.min(bounds.top, rect.y),
          right: Math.max(bounds.right, rect.x + rect.width),
          bottom: Math.max(bounds.bottom, rect.y + rect.height),
        }),
        { left: PET_WINDOW_WIDTH, top: PET_WINDOW_HEIGHT, right: 0, bottom: 0 },
      );
    }
    publishPetWindowEdge();
  });

  // 微信桥：PENGUIN_WECHAT_ENABLED=1 时启用；事件统一从主进程转发到 renderer
  ipcMain.handle("settings:get", () => getPetSettings());
  ipcMain.handle("pet-perception:status", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) {
      throw new Error("桌宠感知状态只允许桌宠窗口读取");
    }
    return agentPerceptionService?.getSnapshot() ?? null;
  });
  ipcMain.handle("pet-perception:trigger", async (event, rawSignal: unknown) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) {
      throw new Error("桌宠感知触发只允许桌宠窗口读取");
    }
    if (typeof rawSignal !== "string") throw new Error("感知信号无效");
    if (!agentPerceptionService) throw new Error("桌宠感知服务尚未启动");
    return agentPerceptionService.trigger(rawSignal);
  });
  ipcMain.on("pet-perception:subscribe", (event) => {
    if (event.sender.isDestroyed()) return;
    const unsubscribe = agentPerceptionService?.subscribe((perceptionEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("pet-perception:event", perceptionEvent);
    });
    event.sender.once("destroyed", () => unsubscribe?.());
  });
  // 快照订阅：与瞬时事件订阅相互独立，只对桌宠/设置窗口放行（与 pet-perception:status 一致）。
  ipcMain.on("pet-perception:snapshot-subscribe", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) return;
    if (event.sender.isDestroyed()) return;
    const unsubscribe = agentPerceptionService?.subscribeSnapshot((snapshot) => {
      if (!event.sender.isDestroyed()) event.sender.send("pet-perception:snapshot", snapshot);
    });
    event.sender.once("destroyed", () => unsubscribe?.());
  });
  ipcMain.handle("agent-tasks:status", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) {
      throw new Error("Agent 任务状态只允许桌宠窗口读取");
    }
    return agentTaskObserver?.getSnapshot() ?? {
      enabled: false,
      observedAt: new Date().toISOString(),
      tasks: [],
      recentCompletions: [],
    };
  });
  ipcMain.on("agent-tasks:subscribe", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow) || event.sender.isDestroyed()) return;
    const snapshot = agentTaskObserver?.getSnapshot();
    if (snapshot) event.sender.send("agent-tasks:snapshot", snapshot);
    const unsubscribe = agentTaskObserver?.subscribeSnapshot((next) => {
      if (!event.sender.isDestroyed()) event.sender.send("agent-tasks:snapshot", next);
    });
    event.sender.once("destroyed", () => unsubscribe?.());
  });
  ipcMain.handle("agent-endpoints:status", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) {
      throw new Error("Agent 宿主状态只允许桌宠窗口读取");
    }
    return agentEndpointRegistry?.getSnapshot() ?? {
      endpoints: [],
      bridge: { state: "offline", endpointPath: "", updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
  });
  ipcMain.on("agent-endpoints:subscribe", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow) || event.sender.isDestroyed()) return;
    const snapshot = agentEndpointRegistry?.getSnapshot();
    if (snapshot) event.sender.send("agent-endpoints:snapshot", snapshot);
    const unsubscribe = agentEndpointRegistry?.subscribe((next) => {
      if (!event.sender.isDestroyed()) event.sender.send("agent-endpoints:snapshot", next);
    });
    event.sender.once("destroyed", () => unsubscribe?.());
  });
  ipcMain.handle("pet-styles:list", () => petSettings.petStyles);
  ipcMain.handle("pet-styles:assets", (_event, rawStyleId: unknown) => {
    const styleId = typeof rawStyleId === "string" && petSettings.petStyles.some((style) => style.id === rawStyleId)
      ? rawStyleId
      : DEFAULT_PET_STYLE_ID;
    return petStyleAssetUrls(styleId);
  });
  ipcMain.handle("pet-styles:import-folder", (event) => importPetStyleFolder(event));
  ipcMain.handle("pet-styles:import-state", (event, rawStyleId: unknown, rawState: unknown) => importPetStyleState(event, rawStyleId, rawState));
  ipcMain.handle("pet-styles:add-custom-state", (event, rawStyleId: unknown, rawName: unknown) => addCustomPetState(event, rawStyleId, rawName));
  ipcMain.handle("pet-styles:rename", (_event, rawStyleId: unknown, rawName: unknown) => renamePetStyle(rawStyleId, rawName));
  ipcMain.handle("pet-styles:remove-custom-state", (_event, rawStyleId: unknown, rawStateId: unknown) => removeCustomPetState(
    typeof rawStyleId === "string" ? rawStyleId : "",
    typeof rawStateId === "string" ? rawStateId : "",
  ));
  ipcMain.handle("pet-styles:remove", (_event, rawStyleId: unknown) => removePetStyle(typeof rawStyleId === "string" ? rawStyleId : ""));
  ipcMain.handle("settings:data-summary", () => buildLocalDataSummary());
  ipcMain.handle("memory:summary", (event) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口读取");
    const summary = memoryStore?.summary() ?? {
      approved: 0,
      pending: 0,
      rejected: 0,
      archived: 0,
      databaseFilePresent: false,
      markdownFileCount: 0,
    };
    console.info(`[Memory] fetch summary approved=${summary.approved} pending=${summary.pending} rejected=${summary.rejected} archived=${summary.archived}`);
    return summary;
  });
  ipcMain.handle("memory:list", (event, rawStatus: unknown) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口读取");
    const status = rawStatus === "pending" || rawStatus === "approved" || rawStatus === "rejected" || rawStatus === "archived"
      ? rawStatus
      : undefined;
    const entries = memoryStore?.list(status) ?? [];
    const approved = entries.filter((entry) => entry.status === "approved");
    console.info(`[Memory] fetch entries status=${status ?? "all"} count=${entries.length} profile=${approved.filter((entry) => entry.scope === "user").length} other=${approved.filter((entry) => entry.scope !== "user").length} pending=${entries.filter((entry) => entry.status === "pending").length}`);
    return entries;
  });
  ipcMain.handle("memory:rebuild-recent", (event) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("memory service access denied");
    return rebuildMemoryFromRecentMessages();
  });
  ipcMain.handle("memory:search", (event, rawQuery: unknown) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口读取");
    return memoryStore?.search(typeof rawQuery === "string" ? rawQuery : "") ?? [];
  });
  ipcMain.handle("memory:approve", (event, rawId: unknown) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口修改");
    return memoryStore?.approve(typeof rawId === "string" ? rawId : "") ?? { ok: false, detail: "记忆服务尚未启动" };
  });
  ipcMain.handle("memory:reject", (event, rawId: unknown) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口修改");
    return memoryStore?.reject(typeof rawId === "string" ? rawId : "") ?? { ok: false, detail: "记忆服务尚未启动" };
  });
  ipcMain.handle("memory:remove", (event, rawId: unknown) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口修改");
    return memoryStore?.remove(typeof rawId === "string" ? rawId : "") ?? { ok: false, detail: "记忆服务尚未启动" };
  });
  ipcMain.handle("memory:clear", (event) => {
    if (!isTrustedAppWindowSender(event.sender)) throw new Error("记忆服务只允许桌宠窗口修改");
    memoryStore?.clear();
    return { ok: true, detail: "长期记忆已清空" };
  });
  ipcMain.on("memory:subscribe", (event) => {
    if (event.sender.isDestroyed()) return;
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) return;
    const sendSummary = (summary: ReturnType<MemoryStore["summary"]>) => {
      if (!event.sender.isDestroyed()) event.sender.send("memory:summary", summary);
    };
    sendSummary(memoryStore?.summary() ?? {
      approved: 0,
      pending: 0,
      rejected: 0,
      archived: 0,
      databaseFilePresent: false,
      markdownFileCount: 0,
    });
    const unsubscribe = memoryStore?.subscribe(sendSummary);
    event.sender.once("destroyed", () => unsubscribe?.());
  });
  ipcMain.handle("settings:delete-managed-data", () => deleteManagedData());
  ipcMain.handle("settings:clear-chat-history", (): LocalDataActionResult => {
    channelHistory?.clear();
    weChatBridge?.clearChatHistory();
    return { ok: true, detail: "聊天历史已清空；事件日志和凭据未修改。", summary: buildLocalDataSummary() };
  });
  ipcMain.handle("settings:export-data-summary", async (event): Promise<LocalDataActionResult> => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const saveOptions: SaveDialogOptions = {
      title: "导出数据摘要",
      defaultPath: "penguin-data-summary.json",
      filters: [{ name: "JSON 文件", extensions: ["json"] }],
    };
    const result = ownerWindow
      ? await dialog.showSaveDialog(ownerWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, detail: "已取消导出" };
    const payload = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      privacy: "仅包含计数、状态和是否存在，不包含凭据、账号标识、完整路径或聊天正文。",
      data: buildLocalDataSummary(),
    };
    try {
      writeFileSync(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return { ok: true, detail: "数据摘要已导出。", summary: payload.data };
    } catch {
      return { ok: false, detail: "导出失败，请检查目标文件夹权限。" };
    }
  });
  ipcMain.handle("agents:discover", () => discoverLocalAgents());
  ipcMain.handle("agents:models", (_event, rawConfig: unknown): AgentModelOption[] => {
    if (!isRecord(rawConfig)) return [];
    const [config] = normalizeAgentConfigs([rawConfig]);
    if (!config) return [];
    const candidates: unknown[] = [ ...(config.modelOptions ?? []) ];
    if (config.model) {
      candidates.push({
        id: agentModelOptionId(config.id, config.model),
        modelId: config.model,
        displayName: config.model,
        source: "local-config",
        isCurrentCcSwitch: false,
        selected: false,
        lastSeenAt: Date.now(),
      });
    }
    for (const model of config.ccSwitchCurrentConfig?.availableModels ?? []) {
      if (!model.modelId) continue;
      candidates.push({
        id: agentModelOptionId(config.id, model.modelId),
        modelId: model.modelId,
        displayName: model.displayName,
        source: "cc-switch-catalog",
        isCurrentCcSwitch: false,
        selected: false,
        lastSeenAt: config.ccSwitchCurrentConfig?.lastSyncedAt ?? Date.now(),
      });
    }
    return normalizeAgentModelOptions(candidates, config.id);
  });
  ipcMain.handle("controller:status", async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || (ownerWindow !== mainWindow && ownerWindow !== settingsWindow)) {
      throw new Error("控制器状态只允许桌宠窗口读取");
    }
    return getAgentControllerStatus();
  });
  ipcMain.handle("agents:test", (_event, rawConfig: unknown) => {
    if (!rawConfig || typeof rawConfig !== "object") {
      return { ok: false, version: null, detail: "Agent 配置无效" };
    }
    const raw = rawConfig as Record<string, unknown>;
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      return { ok: false, version: null, detail: "请先填写可执行命令" };
    }
    const [config] = normalizeAgentConfigs([raw]);
    return testLocalAgent(config);
  });
  ipcMain.handle("agents:health-check", (_event, rawConfig: unknown) => {
    if (!rawConfig || typeof rawConfig !== "object") {
      return {
        ok: false,
        errorCode: "failed",
        mode: "custom-command",
        durationMs: 0,
        responsePreview: null,
        detail: "Agent 配置无效",
      };
    }
    const raw = rawConfig as Record<string, unknown>;
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      return {
        ok: false,
        errorCode: "not-installed",
        mode: "custom-command",
        durationMs: 0,
        responsePreview: null,
        detail: "请先填写可执行命令",
      };
    }
    const [config] = normalizeAgentConfigs([raw]);
    if (config.ccSwitchCurrentConfig) {
      const runtime = readCcSwitchRuntimeConfig(config.ccSwitchCurrentConfig.app);
      if (!runtime) {
        return {
          ok: false,
          errorCode: "failed",
          mode: "no-tools",
          durationMs: 0,
          responsePreview: null,
          detail: "CC Switch 当前 API 配置不可用，请重新导入 CCS 当前配置",
        };
      }
      return testAgentRequest(config, runtime);
    }
    return testAgentRequest(config);
  });
  ipcMain.handle("settings:update", (_event, rawUpdate: unknown) => {
    if (!rawUpdate || typeof rawUpdate !== "object") return getPetSettings();
    const update = rawUpdate as PetSettingsUpdate;
    const nextSettings = updatePetSettings({
      theme: isPetTheme(update.theme) ? update.theme : undefined,
      petStyles: Array.isArray(update.petStyles) ? normalizePetStyles(update.petStyles) : undefined,
      activePetStyleId: typeof update.activePetStyleId === "string" ? update.activePetStyleId : undefined,
      petPerception: update.petPerception && typeof update.petPerception === "object"
        ? normalizePetPerceptionSettings(update.petPerception)
        : undefined,
      petName: typeof update.petName === "string" ? update.petName : undefined,
      userName: typeof update.userName === "string" ? update.userName : undefined,
      alwaysOnTop: typeof update.alwaysOnTop === "boolean" ? update.alwaysOnTop : undefined,
      showWeChatBubbles: typeof update.showWeChatBubbles === "boolean" ? update.showWeChatBubbles : undefined,
      showThinkingBubbles: typeof update.showThinkingBubbles === "boolean" ? update.showThinkingBubbles : undefined,
      agentProvider: isAgentProvider(update.agentProvider) ? update.agentProvider : undefined,
      activeAgentId: typeof update.activeAgentId === "string" ? update.activeAgentId : undefined,
      agentConfigs: Array.isArray(update.agentConfigs) ? normalizeAgentConfigs(update.agentConfigs) : undefined,
      wechatTokenFile: typeof update.wechatTokenFile === "string" ? update.wechatTokenFile : undefined,
      wechatEnabled: typeof update.wechatEnabled === "boolean" ? update.wechatEnabled : undefined,
      screenCaptureDisplayId: typeof update.screenCaptureDisplayId === "string" ? update.screenCaptureDisplayId : undefined,
      wechatAccounts: Array.isArray(update.wechatAccounts) ? normalizeWeChatAccounts(update.wechatAccounts) : undefined,
      activeWeChatAccountId: typeof update.activeWeChatAccountId === "string" ? update.activeWeChatAccountId : undefined,
      qqAccounts: Array.isArray(update.qqAccounts) ? normalizeQQAccounts(update.qqAccounts) : undefined,
      activeQQAccountId: typeof update.activeQQAccountId === "string" ? update.activeQQAccountId : undefined,
      feishuAccounts: Array.isArray(update.feishuAccounts) ? normalizeFeishuAccounts(update.feishuAccounts) : undefined,
      activeFeishuAccountId: typeof update.activeFeishuAccountId === "string" ? update.activeFeishuAccountId : undefined,
      dingtalkAccounts: Array.isArray(update.dingtalkAccounts) ? normalizeDingTalkAccounts(update.dingtalkAccounts) : undefined,
      activeDingTalkAccountId: typeof update.activeDingTalkAccountId === "string" ? update.activeDingTalkAccountId : undefined,
      taskNotificationPlatform: update.taskNotificationPlatform === undefined
        ? undefined
        : normalizeTaskNotificationPlatform(update.taskNotificationPlatform),
      taskNotificationMode: update.taskNotificationMode === undefined
        ? undefined
        : normalizeTaskNotificationMode(update.taskNotificationMode),
      wechatAllowedUserIds: Array.isArray(update.wechatAllowedUserIds) ? normalizeWeChatUserIds(update.wechatAllowedUserIds) : undefined,
      agentFullAccess: typeof update.agentFullAccess === "boolean" ? update.agentFullAccess : undefined,
      agentPermissionPolicy: isAgentPermissionPolicy(update.agentPermissionPolicy) ? update.agentPermissionPolicy : undefined,
      agentCapabilityPolicy: update.agentCapabilityPolicy && typeof update.agentCapabilityPolicy === "object"
        ? normalizeAgentCapabilityPolicy(update.agentCapabilityPolicy)
        : undefined,
      agentApprovalMode: update.agentApprovalMode === undefined ? undefined : normalizeAgentApprovalMode(update.agentApprovalMode),
      agentFallbackIds: Array.isArray(update.agentFallbackIds) ? update.agentFallbackIds : undefined,
      ccSwitchSyncEnabled: typeof update.ccSwitchSyncEnabled === "boolean" ? update.ccSwitchSyncEnabled : undefined,
      zeroToken: update.zeroToken && typeof update.zeroToken === "object"
        ? normalizeZeroTokenSettings(update.zeroToken)
        : undefined,
      saveChatHistory: typeof update.saveChatHistory === "boolean" ? update.saveChatHistory : undefined,
      codexSandboxMode: isCodexSandboxMode(update.codexSandboxMode) ? update.codexSandboxMode : undefined,
    });
    if (nextSettings.zeroToken.enabled) {
      void zeroTokenRuntime.initialize().then(() => broadcastZeroTokenRuntime()).catch((error) => {
        console.error(`[ZeroToken] ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      zeroTokenRuntime.dispose();
      broadcastZeroTokenRuntime();
    }
    return nextSettings;
  });
  ipcMain.handle("settings:close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== settingsWindow) return;
    allowSettingsWindowClose = true;
    window.close();
  });
  ipcMain.on("settings:subscribe", (event) => {
    if (!event.sender.isDestroyed()) event.sender.send("settings:changed", getPetSettings());
  });
  ipcMain.handle("screen-capture:displays", () => listDesktopCaptureDisplays());
  ipcMain.handle("screen-capture:status", (_event, rawAgentId: unknown) => getScreenCaptureFollowStatus(rawAgentId));
  ipcMain.handle("channels:list", () => botChannelManager.getStatuses());
  ipcMain.handle("channels:reconnect", (_event, rawChannelId: unknown) => {
    if (typeof rawChannelId !== "string" || !rawChannelId.trim()) {
      return { ok: false, detail: "机器人通道无效" };
    }
    return botChannelManager.reconnect(rawChannelId);
  });
  ipcMain.on("channels:subscribe", (event) => {
    if (event.sender.isDestroyed()) return;
    const sendEvent = (channelEvent: BotChannelEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("channels:event", channelEvent);
    };
    botChannelManager.getStatuses().forEach((status) => sendEvent({ type: "status", status }));
    const unsubscribe = botChannelManager.subscribe(sendEvent);
    event.sender.once("destroyed", unsubscribe);
  });
  ipcMain.handle("qq:qr-login:status", () => qqQrLoginManager.getStatus());
  ipcMain.handle("qq:qr-login:start", (_event, rawDisplayName: unknown) => {
    const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
    return qqQrLoginManager.start(displayName);
  });
  ipcMain.handle("qq:qr-login:cancel", () => qqQrLoginManager.cancel());
  ipcMain.on("qq:qr-login:subscribe", (event) => {
    if (event.sender.isDestroyed()) return;
    const sendEvent = (qrEvent: QQQrLoginEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("qq:qr-login:event", qrEvent);
    };
    const current = qqQrLoginManager.getStatus();
    if (current) sendEvent(current);
    const unsubscribe = qqQrLoginManager.subscribe(sendEvent);
    event.sender.once("destroyed", unsubscribe);
  });
  ipcMain.handle("feishu:qr-login:status", () => feishuQrLoginManager.getStatus());
  ipcMain.handle("feishu:qr-login:start", (_event, rawDisplayName: unknown) => {
    const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
    return feishuQrLoginManager.start(displayName);
  });
  ipcMain.handle("feishu:qr-login:cancel", () => feishuQrLoginManager.cancel());
  ipcMain.on("feishu:qr-login:subscribe", (event) => {
    if (event.sender.isDestroyed()) return;
    const sendEvent = (qrEvent: FeishuQrLoginEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("feishu:qr-login:event", qrEvent);
    };
    const current = feishuQrLoginManager.getStatus();
    if (current) sendEvent(current);
    const unsubscribe = feishuQrLoginManager.subscribe(sendEvent);
    event.sender.once("destroyed", unsubscribe);
  });
  ipcMain.on("settings:drag-start", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== settingsWindow) return;
    const bounds = window.getBounds();
    const cursor = screen.getCursorScreenPoint();
    settingsWindowDrag = {
      sender: event.sender,
      windowX: bounds.x,
      windowY: bounds.y,
      cursorX: cursor.x,
      cursorY: cursor.y,
    };
  });
  ipcMain.on("settings:drag", (event) => {
    if (!settingsWindowDrag || settingsWindowDrag.sender !== event.sender) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    window.setPosition(
      settingsWindowDrag.windowX + cursor.x - settingsWindowDrag.cursorX,
      settingsWindowDrag.windowY + cursor.y - settingsWindowDrag.cursorY,
      false,
    );
  });
  ipcMain.on("settings:drag-end", (event) => {
    if (settingsWindowDrag?.sender === event.sender) settingsWindowDrag = null;
  });

  ipcMain.on("pet:context-menu", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;

    const stateLabel = (state: string): string => {
      if (state === "connected") return "已连接";
      if (state === "paused") return "已暂停";
      if (state === "reconnecting") return "重连中";
      if (state === "failed") return "连接失败";
      if (state === "logged-out") return "已退出";
      if (state === "connecting") return "连接中";
      return "未连接";
    };
    const platformName = { wechat: "微信", qq: "QQ", feishu: "飞书", dingtalk: "钉钉" } as const;
    const statuses = botChannelManager.getStatuses();
    const weChatStatus = weChatBridge?.status ?? DEFAULT_WECHAT_STATUS;
    const weChatPaused = weChatBridge?.isPaused ?? false;
    const canToggleWeChat = weChatStatus.connected || weChatPaused;
    const channelItems: Electron.MenuItemConstructorOptions[] = [];

    const weChatChannel = statuses.find((status) => status.platform === "wechat") ?? {
      channelId: "wechat:active",
      platform: "wechat" as const,
      state: weChatStatus.state,
      connected: weChatStatus.connected,
      detail: weChatStatus.detail,
      lastError: weChatStatus.lastError,
      retryCount: weChatStatus.retryCount,
      nextRetryAt: weChatStatus.nextRetryAt,
    };
    channelItems.push({
      label: `${platformName.wechat} - ${stateLabel(weChatChannel.state)}`,
      submenu: [
        { label: weChatChannel.detail || stateLabel(weChatChannel.state), enabled: false },
        { type: "separator" },
        {
          label: weChatPaused ? "恢复消息" : weChatStatus.connected ? "暂停消息" : "打开设置",
          enabled: canToggleWeChat || !weChatStatus.connected,
          click: () => {
            if (!weChatBridge) return;
            if (weChatPaused) void weChatBridge.resume();
            else if (weChatStatus.connected) void weChatBridge.pause();
            else openSettingsWindow();
          },
        },
        {
          label: "重新连接",
          enabled: !weChatStatus.connected && !weChatPaused && weChatStatus.state !== "connecting",
          click: () => void botChannelManager.reconnect("wechat:active"),
        },
      ],
    });

    for (const status of statuses.filter((item) => item.platform !== "wechat")) {
      channelItems.push({
        label: `${platformName[status.platform]} - ${stateLabel(status.state)}`,
        submenu: [
          { label: status.detail || stateLabel(status.state), enabled: false },
          { type: "separator" },
          {
            label: "重新连接",
            enabled: status.state !== "connected" && status.state !== "connecting",
            click: () => void botChannelManager.reconnect(status.channelId),
          },
        ],
      });
    }

    const visibleStatusCount = Math.max(statuses.length, 1);
    const connectedCount = statuses.length > 0
      ? statuses.filter((status) => status.connected).length
      : Number(weChatChannel.connected);
    const menu = Menu.buildFromTemplate([
      {
        label: `连接状态 - ${connectedCount}/${visibleStatusCount}`,
        submenu: [
          ...channelItems,
          { type: "separator" },
          { label: "打开机器人设置", click: () => openSettingsWindow() },
        ],
      },
      { label: "设置", click: () => openSettingsWindow() },
      {
        label: keepWindowOnTop ? "取消置顶" : "置顶窗口",
        click: () => {
          keepWindowOnTop = !keepWindowOnTop;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(keepWindowOnTop);
            appliedWindowOnTop = keepWindowOnTop;
            if (keepWindowOnTop) mainWindow.moveTop();
          }
          petSettings.alwaysOnTop = keepWindowOnTop;
          savePetSettings();
          broadcastPetSettings();
        },
      },
      { type: "separator" },
      { label: "关闭桌宠", click: () => mainWindow?.close() },
      { label: "退出应用", click: () => app.quit() },
    ]);
    menu.popup({ window: mainWindow });
  });

  weChatBridge = await startWeChatBridge(
    () => {
      const settings = getPetSettings();
      return {
        agentProvider: settings.agentProvider,
        activeAgentId: settings.activeAgentId,
        agentConfigs: settings.agentConfigs,
        agentConfigFor: () => boundAgentConfigForBot("wechat", settings.activeWeChatAccountId, "", settings),
        captureDisplayForAgent: (agent) => agentWindowTracker?.getSnapshot(agent.id) ?? Promise.resolve(null),
        wechatTokenFile: settings.wechatTokenFile,
        wechatEnabled: settings.wechatEnabled,
        screenCaptureDisplayId: settings.screenCaptureDisplayId,
        wechatAllowedUserIds: settings.wechatAllowedUserIds,
        agentPermissionPolicy: settings.agentPermissionPolicy,
        petName: settings.petName,
        userName: settings.userName,
        saveChatHistory: settings.saveChatHistory,
        codexSandboxMode: settings.codexSandboxMode,
        zeroToken: settings.zeroToken,
        memoryContextFor: (userId, query = "") => {
          const runtimeConfig = loadConfig("", true);
          const agent = boundAgentConfigForBot("wechat", settings.activeWeChatAccountId, "", settings);
          return memoryRetriever?.contextFor({
            query,
            ownerId: channelMemoryOwnerId("wechat", settings.wechatTokenFile || "active-account", userId),
            workspaceId: runtimeConfig.agentWorkspace,
            workspacePath: runtimeConfig.agentWorkspace,
            projectScope: memoryProjectScope(runtimeConfig.agentWorkspace),
            agentScope: `agent:${agent.id}`,
            limit: 6,
          }) ?? "";
        },
        rememberExplicit: (userId, text) => memoryStore?.captureExplicit(text, undefined, channelMemoryOwnerId("wechat", settings.wechatTokenFile || "active-account", userId)) ?? null,
        forgetExplicit: (userId, text) => memoryStore?.captureExplicitForget(text, loadConfig("", true).agentWorkspace, channelMemoryOwnerId("wechat", settings.wechatTokenFile || "active-account", userId)) ?? null,
        observeMemory: (userId, userMessage, assistantMessage, agentConfig, messageId) => {
          const runtimeConfig = loadConfig("", true);
          observeMemoryAfterChannelReply({
            userMessage,
            assistantMessage,
            ownerId: channelMemoryOwnerId("wechat", settings.wechatTokenFile || "active-account", userId),
            activeAgent: agentConfig,
            workspace: runtimeConfig.agentWorkspace,
            messageId,
            source: "wechat",
          });
        },
      };
    },
    join(app.getPath("userData"), "wechat-history.json"),
    join(app.getPath("userData"), "wechat-credentials.json"),
    join(app.getPath("userData"), "wechat-events.jsonl"),
    {
      preview: (message) => agentDelegationService?.preview(message) ?? null,
      listIfRequested: (message) => agentDelegationService?.listIfRequested(message) ?? null,
      followUp: (parentConversationId, message) => agentDelegationService?.followUp(parentConversationId, message) ?? {
        handled: false,
        ok: false,
        detail: "委派服务尚未启动",
      },
      start: (preview, parentConversationId, onCompletion) => agentDelegationService?.start(preview, parentConversationId, onCompletion) ?? { ok: false, detail: "委派服务尚未启动" },
    },
  );
  botChannelManager.register(new WeChatChannelAdapter(weChatBridge));
  if (petSettings.qqAccounts.length > 0) {
    for (const account of petSettings.qqAccounts.filter((item) => item.enabled)) {
      void startQQAccount(account).catch((error) => {
        console.warn(`Unable to start QQ channel ${account.id}.`, error);
      });
    }
  } else if (!app.isPackaged) {
    const qqConfig = loadQQChannelConfig();
    if (qqConfig) startEnvironmentQQChannel(qqConfig);
  }
  for (const account of petSettings.feishuAccounts.filter((item) => item.enabled)) {
    void startFeishuAccount(account).catch((error) => {
      console.warn(`Unable to start Feishu channel ${account.id}.`, error);
    });
  }
  for (const account of petSettings.dingtalkAccounts.filter((item) => item.enabled)) {
    void startDingTalkAccount(account).catch((error) => {
      console.warn(`Unable to start DingTalk channel ${account.id}.`, error);
    });
  }
  botChannelManager.subscribe(queueChannelAgentReply);
  botChannelManager.subscribe((event) => {
    longTaskReplyScheduler?.handleChannelEvent(event);
    agentPerceptionService?.handleChannelEvent(event);
    agentTaskObserver?.handleChannelEvent(event);
  });

  weChatBridge.subscribe((event) => {
    longTaskReplyScheduler?.handleWeChatEvent(event);
    agentPerceptionService?.handleWeChatEvent(event);
    agentTaskObserver?.handleWeChatEvent(event);
    if (event.type === "connection" && event.connected) {
      void flushReadyWeChatTaskNotifications();
    }
    if (event.type === "message") {
      const freshTarget: AgentTaskNotificationTarget = {
        channelId: "wechat:active",
        platform: "wechat",
        botAccountId: botAccountIdForTarget(
          { platform: "wechat", accountId: event.accountId, channelId: "wechat:active" },
          undefined,
          weChatBridge?.activeTokenFile ?? "",
        ),
        conversationId: event.from,
        conversationType: "direct",
        messageId: event.id,
        contextToken: event.contextToken,
        accountId: event.accountId,
      };
      rememberAgentTaskNotificationTarget(freshTarget);
    }
    // 积压通知在回执发出（reply 事件）后再冲刷：回执与通知走桥接器同一条串行
    // 发送链，先回执、后补发；没有入站消息时由自动重试定时器继续冲刷。
    if (event.type === "reply") {
      const botAccountId = botAccountIdForTarget(
        { platform: "wechat", accountId: weChatBridge?.activeTokenFile ?? "", channelId: "wechat:active" },
        undefined,
        weChatBridge?.activeTokenFile ?? "",
      );
      const pendingTarget = agentTaskNotificationTargets[`wechat:${botAccountId}`];
      if (pendingTarget) void flushWeChatTaskNotificationQueue(pendingTarget);
      else void flushReadyWeChatTaskNotifications();
    }
    if (event.type !== "qr-login" || event.status !== "confirmed") return;
    const qrAccount = weChatBridge?.consumeQrLoginAccount();
    if (!qrAccount) return;
    const account = upsertWeChatAccount(qrAccount.tokenFile, qrAccount.accountId);
    petSettings.wechatTokenFile = account.tokenFile;
    petSettings.activeWeChatAccountId = account.id;
    petSettings.wechatEnabled = true;
    savePetSettings();
    broadcastPetSettings();
  });
  // startWeChatBridge 可能在订阅监听器前就已经完成首轮连接；不能把
  // 持久化的主动通知依赖在下一条入站消息或 reply 事件上。
  void flushReadyWeChatTaskNotifications();

  ipcMain.handle("wechat:status", () => weChatBridge?.status ?? DEFAULT_WECHAT_STATUS);
  ipcMain.handle("wechat:reconnect", () => botChannelManager.reconnect("wechat:active"));
  ipcMain.handle("wechat:qr-login:status", () => weChatBridge?.getQrLoginStatus() ?? null);
  ipcMain.handle("wechat:qr-login:start", () => weChatBridge?.beginQrLogin() ?? { ok: false, detail: "微信桥接尚未启动" });
  ipcMain.handle("wechat:qr-login:cancel", () => weChatBridge?.cancelQrLogin() ?? { ok: false, detail: "微信桥接尚未启动" });
  ipcMain.handle("wechat:import-session", async (event) => {
    if (!weChatBridge) return { ok: false, detail: "微信桥接尚未启动" };
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const dialogOptions: OpenDialogOptions = {
      title: "导入微信 Bot 会话",
      properties: ["openFile"],
      filters: [{ name: "JSON 会话文件", extensions: ["json"] }],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const tokenFile = result.filePaths[0];
    if (result.canceled || !tokenFile) return { ok: false, canceled: true, detail: "已取消导入" };

    const imported = await weChatBridge.importSession(tokenFile);
    if (!imported.ok) return imported;

    const account = upsertWeChatAccount(tokenFile);
    petSettings.wechatTokenFile = tokenFile;
    petSettings.activeWeChatAccountId = account.id;
    petSettings.wechatEnabled = true;
    savePetSettings();
    broadcastPetSettings();
    return imported;
  });
  ipcMain.handle("wechat:switch-account", async (_event, rawAccountId: unknown) => {
    if (!weChatBridge || typeof rawAccountId !== "string") return { ok: false, detail: "微信账号无效" };
    const account = petSettings.wechatAccounts.find((item) => item.id === rawAccountId);
    if (!account) return { ok: false, detail: "未找到该微信 Bot 会话" };

    const result = await weChatBridge.switchSession(account.tokenFile);
    if (!result.ok) return result;
    petSettings.wechatTokenFile = account.tokenFile;
    petSettings.activeWeChatAccountId = account.id;
    petSettings.wechatEnabled = true;
    savePetSettings();
    broadcastPetSettings();
    return result;
  });
  ipcMain.handle("wechat:logout", async () => {
    if (!weChatBridge) return { ok: false, detail: "微信桥接尚未启动" };
    const result = await weChatBridge.logout();
    if (result.ok) {
      petSettings.wechatEnabled = false;
      savePetSettings();
      broadcastPetSettings();
    }
    return result;
  });

  ipcMain.handle("qq:configure", async (_event, rawInput: unknown) => {
    if (!qqCredentialStore?.available) {
      return { ok: false, detail: "系统加密存储不可用，无法安全保存 QQ 凭据" };
    }
    if (!isRecord(rawInput)) return { ok: false, detail: "QQ 机器人配置无效" };

    const appId = typeof rawInput.appId === "string" ? rawInput.appId.trim() : "";
    if (!appId) return { ok: false, detail: "请先填写 QQ AppID" };
    const id = typeof rawInput.id === "string" && rawInput.id.trim() ? rawInput.id.trim() : `qq:${appId}`;
    const displayName =
      typeof rawInput.displayName === "string" && rawInput.displayName.trim()
        ? rawInput.displayName.trim()
        : `QQ Bot ${appId}`;
    const existingAccount = petSettings.qqAccounts.find((account) => account.id === id || account.appId === appId);
    const existingCredential = qqCredentialStore.load(existingAccount?.id ?? id);
    const clientSecret = typeof rawInput.clientSecret === "string" && rawInput.clientSecret.trim()
      ? rawInput.clientSecret.trim()
      : existingCredential?.clientSecret;
    if (!clientSecret) return { ok: false, detail: "请填写 QQ AppSecret，或直接使用 QQ 扫码添加 Bot" };

    const account: QQAccount = {
      id,
      displayName,
      appId,
      enabled: true,
      agentId: requestedAgentIdOrFallback(rawInput.agentId, existingAccount?.agentId),
      taskNotificationEnabled: existingAccount?.taskNotificationEnabled ?? false,
      taskNotificationMode: existingAccount?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
    };
    const conflictingAccount = petSettings.qqAccounts.find((item) => item.appId === appId && item.id !== id);
    if (conflictingAccount) {
      await stopQQAccount(conflictingAccount.id);
      qqCredentialStore.remove(conflictingAccount.id);
    }
    if (!qqCredentialStore.save(id, { clientSecret })) {
      return { ok: false, detail: "QQ 凭据保存失败，请检查系统加密存储权限" };
    }
    petSettings.qqAccounts = [
      ...petSettings.qqAccounts.filter((item) => item.id !== id && item.appId !== appId),
      account,
    ];
    petSettings.activeQQAccountId = account.id;
    savePetSettings();
    broadcastPetSettings();

    const result = await startQQAccount(account);
    return { ...result, settings: getPetSettings() };
  });
  ipcMain.handle("qq:remove", async (_event, rawAccountId: unknown) => {
    if (typeof rawAccountId !== "string" || !rawAccountId.trim()) {
      return { ok: false, detail: "QQ 机器人账号无效" };
    }
    const accountId = rawAccountId.trim();
    const account = petSettings.qqAccounts.find((item) => item.id === accountId);
    if (!account) return { ok: false, detail: "未找到该 QQ 机器人账号" };

    await stopQQAccount(accountId);
    qqCredentialStore?.remove(accountId);
    petSettings.qqAccounts = petSettings.qqAccounts.filter((item) => item.id !== accountId);
    petSettings.activeQQAccountId = petSettings.qqAccounts[0]?.id ?? "";
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: "QQ 机器人配置已移除", settings: getPetSettings() };
  });
  ipcMain.handle("feishu:configure", async (_event, rawInput: unknown) => {
    if (!feishuCredentialStore?.available) {
      return { ok: false, detail: "系统加密存储不可用，无法安全保存飞书凭据" };
    }
    if (!isRecord(rawInput)) return { ok: false, detail: "飞书机器人配置无效" };

    const appId = typeof rawInput.appId === "string" ? rawInput.appId.trim() : "";
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
      return { ok: false, detail: "请填写正确的飞书 AppID（cli_ 开头）" };
    }
    const id = typeof rawInput.id === "string" && rawInput.id.trim() ? rawInput.id.trim() : `feishu:${appId}`;
    const displayName =
      typeof rawInput.displayName === "string" && rawInput.displayName.trim()
        ? rawInput.displayName.trim()
        : `飞书 Bot ${appId}`;
    const existingAccount = petSettings.feishuAccounts.find((account) => account.id === id || account.appId === appId);
    const existingCredential = feishuCredentialStore.load(existingAccount?.id ?? id);
    const appSecret = typeof rawInput.appSecret === "string" && rawInput.appSecret.trim()
      ? rawInput.appSecret.trim()
      : existingCredential?.appSecret;
    if (!appSecret) return { ok: false, detail: "请填写飞书 AppSecret，或直接扫码创建 Bot" };

    const account: FeishuAccount = {
      id,
      displayName,
      appId,
      enabled: true,
      agentId: requestedAgentIdOrFallback(rawInput.agentId, existingAccount?.agentId),
      taskNotificationEnabled: existingAccount?.taskNotificationEnabled ?? false,
      taskNotificationMode: existingAccount?.taskNotificationMode ?? DEFAULT_TASK_NOTIFICATION_MODE,
    };
    const conflictingAccount = petSettings.feishuAccounts.find((item) => item.appId === appId && item.id !== id);
    if (conflictingAccount) {
      await stopFeishuAccount(conflictingAccount.id);
      feishuCredentialStore.remove(conflictingAccount.id);
    }
    if (!feishuCredentialStore.save(id, { appSecret })) {
      return { ok: false, detail: "飞书凭据保存失败，请检查系统加密存储权限" };
    }
    petSettings.feishuAccounts = [
      ...petSettings.feishuAccounts.filter((item) => item.id !== id && item.appId !== appId),
      account,
    ];
    petSettings.activeFeishuAccountId = account.id;
    savePetSettings();
    broadcastPetSettings();

    const result = await startFeishuAccount(account);
    return { ...result, settings: getPetSettings() };
  });
  ipcMain.handle("feishu:remove", async (_event, rawAccountId: unknown) => {
    if (typeof rawAccountId !== "string" || !rawAccountId.trim()) {
      return { ok: false, detail: "飞书机器人账号无效" };
    }
    const accountId = rawAccountId.trim();
    const account = petSettings.feishuAccounts.find((item) => item.id === accountId);
    if (!account) return { ok: false, detail: "未找到该飞书机器人账号" };

    await stopFeishuAccount(accountId);
    feishuCredentialStore?.remove(accountId);
    petSettings.feishuAccounts = petSettings.feishuAccounts.filter((item) => item.id !== accountId);
    petSettings.activeFeishuAccountId = petSettings.feishuAccounts[0]?.id ?? "";
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: "飞书机器人配置已移除", settings: getPetSettings() };
  });
  ipcMain.handle("dingtalk:configure", async (_event, rawInput: unknown) => {
    if (!isRecord(rawInput)) return { ok: false, detail: "钉钉机器人配置无效" };
    const clientId = typeof rawInput.clientId === "string" ? rawInput.clientId.trim() : "";
    const id = typeof rawInput.id === "string" && rawInput.id.trim() ? rawInput.id.trim() : undefined;
    const displayName = typeof rawInput.displayName === "string" ? rawInput.displayName : "";
    const typedSecret = typeof rawInput.clientSecret === "string" ? rawInput.clientSecret.trim() : "";
    const existingAccount = petSettings.dingtalkAccounts.find((account) => account.id === id || account.clientId === clientId);
    const existingCredential = dingtalkCredentialStore?.load(existingAccount?.id ?? id ?? `dingtalk:${clientId}`);
    const clientSecret = typedSecret || existingCredential?.clientSecret || "";
    if (!clientId) return { ok: false, detail: "请先填写钉钉 Client ID（AppKey）" };
    if (!clientSecret) return { ok: false, detail: "请填写钉钉 Client Secret（AppSecret）" };
    return configureDingTalkAccount({
      id,
      displayName,
      clientId,
      clientSecret,
      agentId: typeof rawInput.agentId === "string" ? rawInput.agentId.trim() : undefined,
    });
  });
  ipcMain.handle("dingtalk:remove", async (_event, rawAccountId: unknown) => {
    if (typeof rawAccountId !== "string" || !rawAccountId.trim()) {
      return { ok: false, detail: "钉钉机器人账号无效" };
    }
    const accountId = rawAccountId.trim();
    const account = petSettings.dingtalkAccounts.find((item) => item.id === accountId);
    if (!account) return { ok: false, detail: "未找到该钉钉机器人账号" };

    await stopDingTalkAccount(accountId);
    dingtalkCredentialStore?.remove(accountId);
    petSettings.dingtalkAccounts = petSettings.dingtalkAccounts.filter((item) => item.id !== accountId);
    petSettings.activeDingTalkAccountId = petSettings.dingtalkAccounts[0]?.id ?? "";
    savePetSettings();
    broadcastPetSettings();
    return { ok: true, detail: "钉钉机器人配置已移除", settings: getPetSettings() };
  });
  ipcMain.handle("wechat:send", (_event, text: string) => botChannelManager.send("wechat:active", { text }));
  ipcMain.on("wechat:subscribe", (event) => {
    if (!weChatBridge) return;
    const unsubscribe = weChatBridge.subscribe((wechatEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("wechat:event", wechatEvent);
      }
    });
    event.sender.once("destroyed", unsubscribe);
  });

  createWindow();
  createTray();
  if (petSettings.zeroToken.enabled) {
    void zeroTokenRuntime.initialize().then(() => broadcastZeroTokenRuntime()).catch((error) => {
      console.error(`[ZeroToken] startup: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  void zeroTokenApiServer.start().then((address) => {
    console.info(`[ZeroToken API] listening on ${address.baseURL}`);
  }).catch((error) => {
    console.error(`[ZeroToken API] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
});

app.on("before-quit", (event) => {
  if (cleanupCompleted) return;
  event.preventDefault();
  if (cleanupPromise) return;
  appQuitting = true;
  console.info("[AppLifecycle] quit requested; waiting for resource cleanup");
  void cleanupAppResources().then(() => {
    cleanupCompleted = true;
    console.info("[AppLifecycle] cleanup barrier passed; continuing quit");
    app.quit();
  }).catch((error) => {
    cleanupCompleted = true;
    console.error("[AppLifecycle] cleanup barrier failed; continuing quit", error);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  console.info("[AppLifecycle] Electron will quit");
});
