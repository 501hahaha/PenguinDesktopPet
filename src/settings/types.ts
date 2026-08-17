import type { AgentApprovalMode, AgentCapabilityPolicy, AgentConfig } from "../agents/types";
import type { PetState } from "../pet/PetStateMachine";

export type AgentProvider = "claude" | "codex" | "hermes" | "custom";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AgentPermissionPolicy = "chat-only" | "allow-tools";
export type PetTheme = "minimal" | "soft" | "night";
export type PetStyleSource = "builtin" | "imported";
export type TaskNotificationPlatform = "qq" | "wechat" | "feishu" | "dingtalk";
export type TaskNotificationMode = "detail" | "timed" | "completion" | "plan";
export type PetStatusLightMotion = "static" | "orbit" | "square" | "wingman";
export const DEFAULT_TASK_NOTIFICATION_PLATFORM: TaskNotificationPlatform = "qq";
export const DEFAULT_TASK_NOTIFICATION_MODE: TaskNotificationMode = "completion";
export const DEFAULT_PET_STATUS_LIGHT_MOTION: PetStatusLightMotion = "static";

export interface ZeroTokenSettings {
  enabled: boolean;
  baseUrl: string;
  /** Empty means resolve the first model advertised by WebModel. */
  model: string;
  timeout: number;
  autoStart: boolean;
}

export const DEFAULT_ZERO_TOKEN_SETTINGS: ZeroTokenSettings = {
  enabled: false,
  baseUrl: "http://127.0.0.1:3456/v1",
  model: "",
  timeout: 120_000,
  autoStart: false,
};

export function defaultZeroTokenSettings(): ZeroTokenSettings {
  return { ...DEFAULT_ZERO_TOKEN_SETTINGS };
}

export function normalizeZeroTokenSettings(value: unknown): ZeroTokenSettings {
  const defaults = defaultZeroTokenSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim()
    ? raw.baseUrl.trim().replace(/\/+$/, "")
    : defaults.baseUrl;
  const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 180) : defaults.model;
  const timeoutValue = typeof raw.timeout === "number" ? raw.timeout : Number(raw.timeout);
  const timeout = Number.isFinite(timeoutValue)
    ? Math.max(5_000, Math.min(300_000, Math.round(timeoutValue / 1_000) * 1_000))
    : defaults.timeout;
  return {
    enabled: raw.enabled === true,
    baseUrl,
    model,
    timeout,
    autoStart: raw.autoStart === true,
  };
}

export function normalizeTaskNotificationPlatform(value: unknown): TaskNotificationPlatform {
  return value === "wechat" || value === "feishu" || value === "dingtalk" ? value : DEFAULT_TASK_NOTIFICATION_PLATFORM;
}

export function normalizeTaskNotificationMode(value: unknown): TaskNotificationMode {
  return value === "detail" || value === "timed" || value === "plan" ? value : DEFAULT_TASK_NOTIFICATION_MODE;
}

export function normalizePetStatusLightMotion(value: unknown): PetStatusLightMotion {
  return value === "orbit" || value === "square" || value === "wingman" ? value : DEFAULT_PET_STATUS_LIGHT_MOTION;
}

export const DEFAULT_PET_NAME = "企鹅";
export const DEFAULT_USER_NAME = "主人";
export const MAX_CALL_NAME_LENGTH = 24;

export function normalizeCallName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? Array.from(normalized).slice(0, MAX_CALL_NAME_LENGTH).join("") : fallback;
}

export interface PetPerceptionSettings {
  enabled: boolean;
  agentRuntime: boolean;
  taskActivity: boolean;
  taskCompletionNotice: boolean;
  statusLightMotion: PetStatusLightMotion;
  longTaskReplyEnabled: boolean;
  longTaskReplyIntervalSeconds: number;
  longTaskReplyTemplate: string;
  botActivity: boolean;
  actionFeedback: boolean;
  bubbleFeedback: boolean;
}

export const DEFAULT_LONG_TASK_REPLY_INTERVAL_SECONDS = 30;
export const DEFAULT_LONG_TASK_REPLY_TEMPLATE = "⏳ {agent} 进度简报 · 已用时 {elapsed} · 阶段 {phase}：{status} · 最新状态：{detail}";
const LEGACY_LONG_TASK_REPLY_TEMPLATES = new Set([
  "Agent 还在处理这条消息，我会继续盯着，稍等一下～",
  "⏳ Agent 还在处理 · 已用时 {elapsed} 秒 · 阶段 {phase}（{status}）",
]);

function normalizeLongTaskReplyInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LONG_TASK_REPLY_INTERVAL_SECONDS;
  return Math.max(15, Math.min(300, Math.round(parsed / 5) * 5));
}

function normalizeLongTaskReplyTemplate(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LONG_TASK_REPLY_TEMPLATE;
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || LEGACY_LONG_TASK_REPLY_TEMPLATES.has(normalized)) return DEFAULT_LONG_TASK_REPLY_TEMPLATE;
  return Array.from(normalized).slice(0, 160).join("");
}

export function defaultPetPerceptionSettings(): PetPerceptionSettings {
  return {
    enabled: false,
    agentRuntime: false,
    taskActivity: true,
    taskCompletionNotice: true,
    statusLightMotion: DEFAULT_PET_STATUS_LIGHT_MOTION,
    longTaskReplyEnabled: true,
    longTaskReplyIntervalSeconds: DEFAULT_LONG_TASK_REPLY_INTERVAL_SECONDS,
    longTaskReplyTemplate: DEFAULT_LONG_TASK_REPLY_TEMPLATE,
    botActivity: true,
    actionFeedback: true,
    bubbleFeedback: true,
  };
}

export function normalizePetPerceptionSettings(value: unknown): PetPerceptionSettings {
  const defaults = defaultPetPerceptionSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    agentRuntime: typeof raw.agentRuntime === "boolean" ? raw.agentRuntime : defaults.agentRuntime,
    taskActivity: typeof raw.taskActivity === "boolean" ? raw.taskActivity : defaults.taskActivity,
    taskCompletionNotice: true,
    statusLightMotion: normalizePetStatusLightMotion(raw.statusLightMotion),
    longTaskReplyEnabled: typeof raw.longTaskReplyEnabled === "boolean" ? raw.longTaskReplyEnabled : defaults.longTaskReplyEnabled,
    longTaskReplyIntervalSeconds: normalizeLongTaskReplyInterval(raw.longTaskReplyIntervalSeconds),
    longTaskReplyTemplate: normalizeLongTaskReplyTemplate(raw.longTaskReplyTemplate),
    botActivity: typeof raw.botActivity === "boolean" ? raw.botActivity : defaults.botActivity,
    actionFeedback: typeof raw.actionFeedback === "boolean" ? raw.actionFeedback : defaults.actionFeedback,
    bubbleFeedback: typeof raw.bubbleFeedback === "boolean" ? raw.bubbleFeedback : defaults.bubbleFeedback,
  };
}

export interface PetStyleCustomState {
  id: string;
  name: string;
  fileName: string;
  createdAt?: string;
}

export interface PetStyle {
  id: string;
  name: string;
  source: PetStyleSource;
  createdAt?: string;
  configuredStates?: PetState[];
  customStates?: PetStyleCustomState[];
}

export interface PetStyleRuntimeState {
  id: string;
  name: string;
  description: string;
  fallbackState: PetState;
}

export interface PetStyleAssetUrls {
  assets: Record<string, string>;
  cycleStates: PetStyleRuntimeState[];
}

export interface WeChatAccount {
  id: string;
  displayName: string;
  tokenFile: string;
  /** The only Agent allowed to handle this bot account. */
  agentId: string;
  /** External host-agent task notices only; pet-controller replies are separate. */
  taskNotificationEnabled: boolean;
  taskNotificationMode: TaskNotificationMode;
}

export interface QQAccount {
  id: string;
  displayName: string;
  appId: string;
  enabled: boolean;
  /** The only Agent allowed to handle this bot account. */
  agentId: string;
  /** External host-agent task notices only; pet-controller replies are separate. */
  taskNotificationEnabled: boolean;
  taskNotificationMode: TaskNotificationMode;
}

export interface FeishuAccount {
  id: string;
  displayName: string;
  appId: string;
  enabled: boolean;
  /** The only Agent allowed to handle this bot account. */
  agentId: string;
  /** External host-agent task notices only; pet-controller replies are separate. */
  taskNotificationEnabled: boolean;
  taskNotificationMode: TaskNotificationMode;
}

export interface DingTalkAccount {
  id: string;
  displayName: string;
  clientId: string;
  enabled: boolean;
  /** The only Agent allowed to handle this bot account. */
  agentId: string;
  /** External host-agent task notices only; pet-controller replies are separate. */
  taskNotificationEnabled: boolean;
  taskNotificationMode: TaskNotificationMode;
}

export interface PetSettings {
  theme: PetTheme;
  petStyles: PetStyle[];
  activePetStyleId: string;
  petPerception: PetPerceptionSettings;
  taskNotificationPlatform: TaskNotificationPlatform;
  taskNotificationMode: TaskNotificationMode;
  petName: string;
  userName: string;
  alwaysOnTop: boolean;
  showWeChatBubbles: boolean;
  showThinkingBubbles: boolean;
  agentProvider: AgentProvider;
  activeAgentId: string;
  agentConfigs: AgentConfig[];
  agentCapabilityPolicy: AgentCapabilityPolicy;
  agentApprovalMode: AgentApprovalMode;
  agentFallbackIds: string[];
  ccSwitchSyncEnabled: boolean;
  zeroToken: ZeroTokenSettings;
  wechatTokenFile: string;
  wechatEnabled: boolean;
  /** Empty means use the operating system primary display. */
  screenCaptureDisplayId: string;
  wechatAccounts: WeChatAccount[];
  activeWeChatAccountId: string;
  qqAccounts: QQAccount[];
  activeQQAccountId: string;
  feishuAccounts: FeishuAccount[];
  activeFeishuAccountId: string;
  dingtalkAccounts: DingTalkAccount[];
  activeDingTalkAccountId: string;
  wechatAllowedUserIds: string[];
  agentFullAccess: boolean;
  agentPermissionPolicy: AgentPermissionPolicy;
  saveChatHistory: boolean;
  codexSandboxMode: CodexSandboxMode;
}

export type PetSettingsUpdate = Partial<PetSettings>;

export interface ChatHistorySummary {
  conversationCount: number;
  messageCount: number;
  lastTimestamp: string | null;
  providers: AgentProvider[];
}

export interface LocalDataSummary {
  managedDataFileCount: number;
  settingsFilePresent: boolean;
  history: {
    channel: ChatHistorySummary;
    wechat: ChatHistorySummary;
    channelFilePresent: boolean;
    wechatFilePresent: boolean;
  };
  credentials: {
    wechatFilePresent: boolean;
    qqFilePresent: boolean;
    feishuFilePresent: boolean;
    dingtalkFilePresent: boolean;
    systemEncryptionAvailable: boolean;
  };
  eventLogs: {
    wechatFilePresent: boolean;
  };
  externalFiles: {
    configuredWeChatSessionCount: number;
  };
  memory?: {
    approved: number;
    pending: number;
    rejected: number;
    archived: number;
    databaseFilePresent: boolean;
    markdownFileCount: number;
  };
}

export interface LocalDataActionResult {
  ok: boolean;
  canceled?: boolean;
  detail: string;
  summary?: LocalDataSummary;
}

export interface PetStyleActionResult {
  ok: boolean;
  canceled?: boolean;
  detail: string;
  style?: PetStyle;
  settings?: PetSettings;
}
