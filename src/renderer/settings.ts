import "./settings.css";
import { AGENT_CAPABILITY_IDS, AGENT_CAPABILITY_LABELS, agentSupportsZeroToken, defaultAgentCapabilityPolicy, defaultAgentConfigs, fullAgentCapabilityPolicy, isAgentAdded } from "../agents/types";
import { agentModelOptionId } from "../agents/types";
import type { AgentCapability, AgentCapabilityPermission, AgentConfig, AgentHealthCheckResult, AgentModelOption, AgentModelProvider, AgentTestResult, LocalAgentInfo } from "../agents/types";
import type { CcSwitchStatus, UpdateCheckResult } from "../main/systemTypes";
import type { PenguinPetApi } from "./types";
import type { AgentProvider, LocalDataSummary, PetPerceptionSettings, PetSettings, PetStatusLightMotion, PetStyle, PetTheme, TaskNotificationMode, ZeroTokenSettings } from "../settings/types";
import type { AgentTaskActivity, AgentTaskSnapshot, AgentTaskSurface, PetPerceptionEvent, PetPerceptionSnapshot } from "../main/pet/perceptionTypes";
import type { MemoryEntry } from "../main/agents/orchestrationTypes";
import type { PetState } from "../pet/PetStateMachine";
import type { ChannelStatus } from "../main/channels/types";
import type { QQQrLoginEvent } from "../main/channels/qqQrLogin";
import type { FeishuQrLoginEvent } from "../main/channels/feishuQrLogin";
import type { WeChatConnectionState, WeChatQrLoginStatus, WeChatStatus } from "../main/wechat/events";
import { renderAgentBrandIcon } from "./agentBrandIcons";
import { zeroTokenModelLabel } from "../main/agents/ZeroTokenModel";
import type { ZeroTokenProviderStatus } from "../main/agents/ZeroTokenProvider";

type SettingsPage = "home" | "appearance" | "personalization" | "bots" | "agents" | "agent-add" | "agent-detail" | "pet-styles" | "perception" | "perception-detail" | "perception-advanced" | "memory" | "memory-all" | "diagnostics" | "data" | "about" | "wechat" | "qq" | "feishu" | "dingtalk";
type PerceptionDetail = "companion" | "interaction" | "task-feedback" | "position" | "movement" | "status-light";

const api = (window as Window & { penguinPet: PenguinPetApi }).penguinPet;
const app = document.querySelector<HTMLDivElement>("#app");
const mascotVideoUrl = "penguin-pet://default-penguin/IDLE.webm";

if (!app) {
  throw new Error("Settings root #app is missing.");
}
const appRoot = app;

app.innerHTML = `
  <main class="settings-shell">
    <section class="settings-card" aria-label="小企鹅设置">
      <div class="settings-deco settings-deco--one">✦</div>
      <div class="settings-deco settings-deco--two">♡</div>
      <header class="settings-header" title="拖动这里移动设置窗口">
        <button id="settings-back" class="settings-back" type="button" aria-label="返回设置主页" title="返回设置主页"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5M11 6l-6 6 6 6"/></svg></button>
        <div class="settings-mascot" aria-hidden="true">
          <video id="settings-mascot-source" class="settings-mascot__source" src="${mascotVideoUrl}" autoplay loop muted playsinline></video>
          <canvas class="settings-mascot__video" width="240" height="240"></canvas>
        </div>
        <button id="settings-close" class="settings-close" type="button" aria-label="关闭设置"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
      </header>
      <div id="settings-content" class="settings-content"></div>
      <p class="settings-version" id="settings-version"></p>
    </section>
    <div id="settings-leave-prompt" class="settings-prompt settings-prompt--leave" hidden>
      <div class="settings-prompt__card" role="dialog" aria-modal="true" aria-labelledby="settings-leave-title">
        <strong id="settings-leave-title">有未保存的修改</strong>
        <p>要在离开设置中心前处理这些修改吗？</p>
        <div class="settings-prompt__actions settings-prompt__actions--leave">
          <button id="leave-continue" class="settings-secondary" type="button">继续编辑</button>
          <button id="leave-discard" class="settings-secondary" type="button">放弃修改</button>
          <button id="leave-save" class="settings-done" type="button">保存并关闭</button>
        </div>
      </div>
    </div>
    <div id="settings-dialog" class="settings-prompt settings-prompt--dialog" hidden>
      <div class="settings-prompt__card" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <strong id="settings-dialog-title"></strong>
        <p id="settings-dialog-body"></p>
        <div id="settings-dialog-actions" class="settings-prompt__actions"></div>
      </div>
    </div>
  </main>
`;

const settingsSurface = app.querySelector<HTMLElement>(".settings-card");
const content = app.querySelector<HTMLElement>("#settings-content");
const backButton = app.querySelector<HTMLButtonElement>("#settings-back");
const closeButton = app.querySelector<HTMLButtonElement>("#settings-close");
const leavePrompt = app.querySelector<HTMLElement>("#settings-leave-prompt");
const leaveContinueButton = app.querySelector<HTMLButtonElement>("#leave-continue");
const leaveDiscardButton = app.querySelector<HTMLButtonElement>("#leave-discard");
const leaveSaveButton = app.querySelector<HTMLButtonElement>("#leave-save");
const dialogPrompt = app.querySelector<HTMLElement>("#settings-dialog");
const dialogTitle = app.querySelector<HTMLElement>("#settings-dialog-title");
const dialogBody = app.querySelector<HTMLElement>("#settings-dialog-body");
const dialogActions = app.querySelector<HTMLElement>("#settings-dialog-actions");
const mascotVideoSource = app.querySelector<HTMLVideoElement>("#settings-mascot-source");
const mascotCanvas = app.querySelector<HTMLCanvasElement>(".settings-mascot__video");
const mascotContext = mascotCanvas?.getContext("2d", { willReadFrequently: true });

if (!settingsSurface || !content || !backButton || !closeButton || !leavePrompt || !leaveContinueButton || !leaveDiscardButton || !leaveSaveButton || !dialogPrompt || !dialogTitle || !dialogBody || !dialogActions || !mascotVideoSource || !mascotCanvas || !mascotContext) {
  throw new Error("Settings shell is incomplete.");
}
const mascotVideo = mascotVideoSource;
const mascotPreviewCanvas = mascotCanvas;
const mascotPreviewContext = mascotContext;

function clearConnectedBlackBackground(context: CanvasRenderingContext2D): void {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const { data, width, height } = image;
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  const isBlack = (pixel: number): boolean => {
    const offset = pixel * 4;
    return data[offset + 3] > 0
      && data[offset] < 56
      && data[offset + 1] < 56
      && data[offset + 2] < 56;
  };
  const enqueue = (x: number, y: number): void => {
    const pixel = y * width + x;
    if (!background[pixel] && isBlack(pixel)) queue.push(pixel);
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  while (queue.length > 0) {
    const pixel = queue.pop()!;
    if (background[pixel] || !isBlack(pixel)) continue;
    background[pixel] = 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(x - 1, y);
    if (x < width - 1) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y < height - 1) enqueue(x, y + 1);
  }
  for (let pixel = 0; pixel < background.length; pixel += 1) {
    if (background[pixel]) data[pixel * 4 + 3] = 0;
  }
  context.putImageData(image, 0, 0);
}

let perceptionMascotCanvas: HTMLCanvasElement | null = null;
let perceptionMascotContext: CanvasRenderingContext2D | null = null;
let mascotAssetRequestId = 0;

function drawMascotPreview(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  if (mascotVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || mascotVideo.videoWidth <= 0) return;
  const canvasSize = canvas.width;
  const sourceWidth = mascotVideo.videoWidth;
  const sourceHeight = mascotVideo.videoHeight;
  const scale = Math.max(canvasSize / sourceWidth, canvasSize / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const drawX = Math.round((canvasSize - drawWidth) / 2);
  const drawY = Math.round((canvasSize - drawHeight) / 2);
  context.clearRect(0, 0, canvasSize, canvasSize);
  context.drawImage(mascotVideo, drawX, drawY, drawWidth, drawHeight);
  clearConnectedBlackBackground(context);
}

function renderMascotPreview(): void {
  drawMascotPreview(mascotPreviewCanvas, mascotPreviewContext);
  if (!perceptionMascotCanvas?.isConnected) {
    perceptionMascotCanvas = document.querySelector<HTMLCanvasElement>("#perception-mascot-canvas");
    perceptionMascotContext = perceptionMascotCanvas?.getContext("2d", { willReadFrequently: true }) ?? null;
  }
  if (perceptionMascotCanvas && perceptionMascotContext) drawMascotPreview(perceptionMascotCanvas, perceptionMascotContext);
  window.requestAnimationFrame(renderMascotPreview);
}

async function syncMascotAsset(settings: PetSettings): Promise<void> {
  const requestId = ++mascotAssetRequestId;
  try {
    const assets = await api.petStyles.assets(settings.activePetStyleId);
    if (requestId !== mascotAssetRequestId) return;
    const idleAsset = assets.assets.idle;
    if (!idleAsset || mascotVideo.getAttribute("src") === idleAsset) return;
    mascotVideo.pause();
    mascotVideo.src = idleAsset;
    mascotVideo.load();
    void mascotVideo.play().catch(() => undefined);
  } catch (error) {
    console.warn("Unable to load the active pet preview asset.", error);
  }
}

void mascotVideo.play().catch(() => undefined);
window.requestAnimationFrame(renderMascotPreview);

  const contentControl = content;
const backButtonControl = backButton;
const closeButtonControl = closeButton;
const leavePromptControl = leavePrompt;
const leaveContinueButtonControl = leaveContinueButton;
const leaveDiscardButtonControl = leaveDiscardButton;
const leaveSaveButtonControl = leaveSaveButton;
const dialogPromptControl = dialogPrompt;
const dialogTitleControl = dialogTitle;
const dialogBodyControl = dialogBody;
const dialogActionsControl = dialogActions;

interface SettingsPromptButton {
  label: string;
  value: string;
  kind: "secondary" | "primary" | "danger";
}

interface SettingsPromptOptions {
  title: string;
  body: string;
  buttons: SettingsPromptButton[];
}

let promptOpen = false;
let promptResolver: ((value: string | null) => void) | null = null;
let promptFocusReturn: HTMLElement | null = null;

function openPrompt(options: SettingsPromptOptions): Promise<string | null> {
  if (promptOpen) closePrompt(null);
  promptOpen = true;
  promptFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogTitleControl.textContent = options.title;
  dialogBodyControl.textContent = options.body;
  dialogActionsControl.classList.toggle("settings-prompt__actions--single", options.buttons.length <= 1);
  dialogActionsControl.replaceChildren(...options.buttons.map((button) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = button.kind === "secondary" ? "settings-secondary" : button.kind === "danger" ? "settings-danger" : "settings-done";
    element.dataset.promptValue = button.value;
    element.textContent = button.label;
    return element;
  }));
  dialogPromptControl.hidden = false;
  // 打开时焦点进入按钮：优先安全（非主要）按钮，避免误触确认。
  (dialogActionsControl.querySelector<HTMLButtonElement>(".settings-secondary") ?? dialogActionsControl.querySelector<HTMLButtonElement>("button"))?.focus();
  return new Promise<string | null>((resolve) => {
    promptResolver = resolve;
  });
}

function closePrompt(result: string | null): void {
  if (!promptOpen) return;
  promptOpen = false;
  dialogPromptControl.hidden = true;
  const resolve = promptResolver;
  promptResolver = null;
  const returnTarget = promptFocusReturn;
  promptFocusReturn = null;
  resolve?.(result);
  // 关闭后恢复原焦点；若未保存离开层正打开，只允许焦点回到其内部按钮。
  if (returnTarget?.isConnected && (leavePromptControl.hidden === true || leavePromptControl.contains(returnTarget))) {
    returnTarget.focus();
  }
}

function showNotice(title: string, body: string): Promise<void> {
  return openPrompt({
    title,
    body,
    buttons: [{ label: "关闭", value: "ok", kind: "secondary" }],
  }).then(() => undefined);
}

function showConfirm(title: string, body: string, options?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return openPrompt({
    title,
    body,
    buttons: [
      { label: "取消", value: "cancel", kind: "secondary" },
      { label: options?.confirmLabel ?? "继续", value: "confirm", kind: options?.danger ? "danger" : "primary" },
    ],
  }).then((value) => value === "confirm");
}

let currentPage: SettingsPage = "home";
let perceptionDetail: PerceptionDetail = "companion";
let renderedPage: SettingsPage | null = null;
let themeTransitionSequence = 0;
let customSelectSequence = 0;
let persistedSettings: PetSettings | null = null;
let draftSettings: PetSettings | null = null;
let dirty = false;
let saving = false;
let perceptionAutoSaveTimer: number | null = null;
let perceptionAutoSaveError = false;
let closing = false;
let agentDiscovery: LocalAgentInfo[] = [];
let discoveringAgents = false;
let agentDiscoveryTimer: number | null = null;
let discoveryError = "";
let agentDetailDraft: AgentConfig | null = null;
let agentTestRunning = false;
let agentTestMessage = "";
let agentTestOk = false;
let agentHealthRunning = false;
let agentHealthMessage = "";
let agentHealthOk = false;
let agentHealthPreview = "";
let ccSwitchStatus: CcSwitchStatus | null = null;
let ccSwitchStatusLoading = false;
let ccSwitchStatusMessage = "";
let ccSwitchBindingLoading = false;
let zeroTokenStatus: ZeroTokenProviderStatus | null = null;
let zeroTokenStatusLoading = false;
let zeroTokenMessage = "";
let updateResult: UpdateCheckResult | null = null;
let updateChecking = false;
let updateMessage = "";
interface AgentDiagnosticRecord {
  command: AgentTestResult | null;
  health: AgentHealthCheckResult | null;
  checkedAt: number | null;
}

const agentDiagnosticRecords = new Map<string, AgentDiagnosticRecord>();
let diagnosticAppVersion = "";
let diagnosticChannelStatuses: ChannelStatus[] = [];
let diagnosticsLoading = false;
let diagnosticsMessage = "";
let diagnosticsCopied = false;
let localDataSummary: LocalDataSummary | null = null;
let dataSummaryLoading = false;
let dataSummaryMessage = "";
let clearingChatHistory = false;
let exportingDataSummary = false;
let deletingManagedData = false;
let memoryEntries: MemoryEntry[] = [];
let memoryLoading = false;
let memoryOrganizing = false;
let memoryMessage = "";
let importingPetStyle = false;
let petStyleMessage = "";
let petPerceptionSnapshot: PetPerceptionSnapshot | null = null;
let agentTaskSnapshot: AgentTaskSnapshot | null = null;
let perceptionTriggerRunning = false;
let perceptionTriggerMessage = "";
type PetStyleMessageTone = "info" | "success" | "error";
let petStyleMessageTone: PetStyleMessageTone = "info";
let customStateFormOpen = false;
let petStyleEditorId = "default-penguin";
let petStyleRenameId: string | null = null;
let wechatStatus: WeChatStatus = {
  state: "disconnected",
  connected: false,
  detail: "正在检查微信连接…",
  lastError: "",
  retryCount: 0,
  nextRetryAt: null,
};
let qqStatus: ChannelStatus | null = null;
let feishuStatus: ChannelStatus | null = null;
let dingtalkStatus: ChannelStatus | null = null;
let qqForm = {
  id: "",
  displayName: "",
  appId: "",
  clientSecret: "",
};
let qqSaving = false;
let qqMessage = "";
let feishuForm = {
  id: "",
  displayName: "",
  appId: "",
  appSecret: "",
};
let feishuSaving = false;
let feishuMessage = "";
let dingtalkForm = {
  id: "",
  displayName: "",
  clientId: "",
  clientSecret: "",
};
let dingtalkSaving = false;
let dingtalkMessage = "";
let importingWeChat = false;
let loggingOutWeChat = false;
let qrLoginState: { status: WeChatQrLoginStatus; detail: string; qrDataUrl?: string; accountId?: string } | null = null;
let qqQrLoginState: QQQrLoginEvent | null = null;
let feishuQrLoginState: FeishuQrLoginEvent | null = null;
let advancedWeChatOpen = false;
const revealedWeChatIds = new Set<string>();
const FIRST_USE_GUIDE_KEY = "penguin.wechat.first-use-guide.v1";
const PERSONALIZATION_REPLY_STYLE_KEY = "penguin.personalization.reply-style.v1";
const PERSONALIZATION_AUTO_MEMORY_KEY = "penguin.personalization.auto-memory.v1";
type ReplyStyle = "balanced" | "concise" | "warm" | "detailed";
const REPLY_STYLE_LABELS: Record<ReplyStyle, string> = {
  balanced: "温柔",
  concise: "简洁",
  warm: "温柔",
  detailed: "详细",
};

function readReplyStyle(): ReplyStyle {
  const value = localStorage.getItem(PERSONALIZATION_REPLY_STYLE_KEY);
  return value === "balanced" || value === "concise" || value === "warm" || value === "detailed" ? value : "balanced";
}

function readAutoMemoryEnabled(): boolean {
  return localStorage.getItem(PERSONALIZATION_AUTO_MEMORY_KEY) !== "off";
}

let replyStyle: ReplyStyle = readReplyStyle();
let autoMemoryEnabled = readAutoMemoryEnabled();

function applyTheme(theme: PetTheme, animate = false): void {
  const root = document.documentElement;
  const currentTheme = root.dataset.theme;
  if (currentTheme === theme) return;

  const previousLayer = appRoot.querySelector<HTMLElement>(".theme-transition-layer");
  previousLayer?.remove();
  root.classList.remove("is-theme-switching");

  const transitionId = ++themeTransitionSequence;
  const previousTheme = currentTheme === "soft" || currentTheme === "night" || currentTheme === "minimal"
    ? currentTheme
    : "minimal";

  // The minimal/soft and minimal/night transitions already render cleanly with
  // the surface CSS transitions. Keep the compositor overlay limited to the
  // problematic soft/night pair so those existing interactions are untouched.
  const needsSurfaceCrossfade = (currentTheme === "soft" && theme === "night")
    || (currentTheme === "night" && theme === "soft");
  if (!animate || !currentTheme || !needsSurfaceCrossfade) {
    root.dataset.theme = theme;
    return;
  }

  // Keep the old surface in front while the new theme is applied underneath.
  // This avoids Chromium trying to interpolate two gradients on a transparent
  // Electron window, which can expose a bright frame during soft/night swaps.
  const layer = document.createElement("div");
  layer.className = "theme-transition-layer";
  layer.dataset.theme = previousTheme;
  appRoot.appendChild(layer);
  root.classList.add("is-theme-switching");
  root.dataset.theme = theme;
  window.requestAnimationFrame(() => {
    if (transitionId !== themeTransitionSequence) return;
    layer.classList.add("is-fading");
  });
  window.setTimeout(() => {
    if (transitionId !== themeTransitionSequence) return;
    layer.remove();
    root.classList.remove("is-theme-switching");
  }, 280);
}

function softRefresh(element: HTMLElement | null): void {
  if (!element) return;
  element.classList.remove("is-soft-refreshing");
  void element.offsetWidth;
  element.classList.add("is-soft-refreshing");
  window.setTimeout(() => element.classList.remove("is-soft-refreshing"), 360);
}

let firstUseGuideVisible = localStorage.getItem(FIRST_USE_GUIDE_KEY) !== "seen";

function cloneSettings(settings: PetSettings): PetSettings {
  return {
    ...settings,
    petPerception: { ...settings.petPerception },
    zeroToken: { ...settings.zeroToken },
    petStyles: (settings.petStyles ?? []).map((style) => ({
      ...style,
      configuredStates: style.configuredStates ? [...style.configuredStates] : undefined,
      customStates: style.customStates?.map((state) => ({ ...state })),
    })),
    agentConfigs: (settings.agentConfigs ?? defaultAgentConfigs()).map((config) => ({ ...config })),
    wechatAccounts: (settings.wechatAccounts ?? []).map((account) => ({ ...account })),
    qqAccounts: (settings.qqAccounts ?? []).map((account) => ({ ...account })),
    feishuAccounts: (settings.feishuAccounts ?? []).map((account) => ({ ...account })),
    wechatAllowedUserIds: [...(settings.wechatAllowedUserIds ?? [])],
    agentCapabilityPolicy: { ...settings.agentCapabilityPolicy },
    agentFallbackIds: [...(settings.agentFallbackIds ?? [])],
  };
}

function settingsWithoutAgentConfigs(settings: PetSettings): string {
  const { agentConfigs: _agentConfigs, ...rest } = settings;
  return JSON.stringify(rest);
}

function cloneAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    capabilities: config.capabilities ? { ...config.capabilities } : undefined,
    ccSwitchCurrentConfig: config.ccSwitchCurrentConfig ? { ...config.ccSwitchCurrentConfig } : undefined,
    modelOptions: config.modelOptions?.map((option) => ({ ...option })),
  };
}

function activeAgentName(settings: PetSettings): string {
  const active = (settings.agentConfigs ?? []).find((config) => config.id === settings.activeAgentId);
  if (active) return active.displayName;
  if (settings.agentProvider === "codex") return "Codex CLI";
  if (settings.agentProvider === "hermes") return "Hermes Agent";
  if (settings.agentProvider === "custom") return "自定义 Agent";
  return "Claude Code";
}

function agentConfigs(settings: PetSettings): AgentConfig[] {
  return settings.agentConfigs?.length ? settings.agentConfigs : defaultAgentConfigs();
}

function cardAgentConfigs(settings: PetSettings): AgentConfig[] {
  const seen = new Set<string>();
  return agentConfigs(settings).filter((config) => {
    if (!isAgentAdded(config)) return false;
    const identity = agentCardIdentity(config);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function agentCardIdentity(config: AgentConfig): string {
  return config.sourceApp && config.sourceApp !== "unknown"
    ? `app:${config.sourceApp}`
    : `id:${config.id}`;
}

function selectedAgentModel(config: AgentConfig): AgentModelOption | null {
  const options = config.modelOptions ?? [];
  const selected = (config.selectedModelId && options.find((option) => option.modelId === config.selectedModelId))
    ?? options.find((option) => option.selected)
    ?? (config.ccSwitchCurrentConfig?.model && options.find((option) => option.modelId === config.ccSwitchCurrentConfig?.model))
    ?? (config.model && options.find((option) => option.modelId === config.model));
  if (selected) return selected;
  const fallbackModel = config.ccSwitchCurrentConfig?.model || config.model;
  return fallbackModel
    ? {
      id: agentModelOptionId(config.id, fallbackModel),
      modelId: fallbackModel,
      displayName: fallbackModel,
      source: config.ccSwitchCurrentConfig?.model ? "cc-switch-current" : "local-config",
      isCurrentCcSwitch: Boolean(config.ccSwitchCurrentConfig?.model),
      selected: true,
      lastSeenAt: config.ccSwitchCurrentConfig?.lastSyncedAt ?? 0,
    }
    : null;
}

function brandKeyFromIdentity(value: string | null | undefined): string | null {
  const identity = (value || "").toLowerCase();
  if (identity.includes("claude") || identity.includes("anthropic")) return "claude";
  if (identity.includes("codex") || identity.includes("openai")) return "codex";
  if (identity.includes("gemini") || identity.includes("google")) return "gemini";
  if (identity.includes("hermes")) return "hermes";
  if (identity.includes("opencode")) return "opencode";
  if (identity.includes("openclaw")) return "openclaw";
  return null;
}

function agentBrandKey(config: AgentConfig): string {
  // sourceApp/provider identify the local Agent itself. CCS iconKey belongs to
  // the imported API profile and must not replace the card's Agent identity.
  return brandKeyFromIdentity(`${config.sourceApp || ""} ${config.provider || ""}`)
    || brandKeyFromIdentity(config.iconKey)
    || "custom";
}

function agentIconClass(config: AgentConfig): string {
  return `agent-card__icon--${agentBrandKey(config)}`;
}

function agentIconMarkup(config: AgentConfig): string {
  return renderAgentBrandIcon(agentBrandKey(config), config.displayName);
}

function safeCardAccent(value: string | null | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "";
}

function agentExecutionLabel(config: AgentConfig): string {
  if (config.executionSupport === "supported") return "可执行";
  if (config.executionSupport === "needs-login") return "需登录";
  return "待检查";
}

function agentCardMeta(config: AgentConfig, settings: PetSettings | null = draftSettings): string {
  if (config.modelProvider === "zerotoken" || (settings?.zeroToken.enabled && !config.modelProvider && agentSupportsZeroToken(config))) {
    return `🟦 Zero Token · ${zeroTokenModelLabel(zeroTokenStatus?.model || settings?.zeroToken.model || "")}`;
  }
  const current = config.ccSwitchCurrentConfig;
  if (current) {
    return [current.providerName, current.model].filter(Boolean).join(" · ")
      || ccSwitchCurrentStateLabel(config);
  }
  if (config.provider === "codex") return "Codex";
  if (config.provider === "claude") return "Claude";
  if (config.provider === "hermes") return "Hermes";
  return "自定义 Agent";
}

function ccSwitchCurrentStateLabel(config: AgentConfig): string {
  const state = config.ccSwitchCurrentConfig?.state;
  if (state === "needs-login") return "需登录";
  if (state === "stale") return "已过期";
  if (state === "missing") return "待引用";
  return "当前";
}

function agentSourceLabel(config: AgentConfig): string {
  if (config.source === "cc-switch") return config.sourceApp ? `CC Switch · ${config.sourceApp}` : "CC Switch";
  return "本机配置";
}

function agentProtocolLabel(config: AgentConfig): string {
  if (config.protocol !== "custom") return config.protocol.replace("-cli", " CLI");
  return "自定义命令";
}

function configFromDiscovery(agent: LocalAgentInfo): AgentConfig | null {
  if (!agent.command) return null;
  const id = agent.sourceApp === "claude-code"
    ? "claude"
    : agent.sourceApp === "codex"
      ? "codex"
      : agent.sourceApp === "hermes"
        ? "hermes"
        : `local:${agent.id}`;
  return {
    id,
    displayName: agent.name,
    provider: agent.provider ?? "custom",
    protocol: agent.provider === "claude" ? "claude-cli" : agent.provider === "codex" ? "codex-cli" : agent.provider === "hermes" ? "hermes-cli" : "custom",
    command: agent.command,
    args: "",
    workingDirectory: "",
    enabled: true,
    agentCardVisible: true,
    source: "discovered",
    sourceApp: agent.sourceApp,
    executionSupport: agent.supported ? "supported" : "metadata-only",
  };
}

function agentDescription(config: AgentConfig): string {
  if (config.sourceApp === "openclaw") return "OpenClaw 会话适配 · Gateway";
  if (config.provider === "codex") return "Codex app-server · CLI 兜底";
  if (config.provider === "hermes") return "Hermes CLI · CCS 兜底";
  if (config.provider === "claude") return "Claude Code · 本机 CLI";
  return "本机 Agent · 自定义适配";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function wechatStateLabel(state: WeChatConnectionState): string {
  switch (state) {
    case "connected": return "已连接";
    case "connecting": return "连接中";
    case "paused": return "已暂停";
    case "reconnecting": return "重连中";
    case "failed": return "连接失败";
    case "logged-out": return "已退出";
    default: return "未连接";
  }
}

function formatWeChatStatusText(status: WeChatStatus): string {
  const stateLabel = wechatStateLabel(status.state);
  if (status.state === "disconnected" || status.state === "logged-out") return stateLabel;
  const detail = status.detail.trim();
  if (!detail) return stateLabel;
  if (status.connected && detail.includes("会话上下文已失效")) {
    const refreshDetail = detail.replace(/^已连接/, "").replace(/^[，,]/, "").trim();
    return [stateLabel, refreshDetail || "请先向 Bot 发一条消息"].join(String.fromCharCode(10));
  }
  return detail.startsWith(stateLabel) ? detail : `${stateLabel} · ${detail}`;
}

function compactStatusError(value: string, maxLength = 76): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function sanitizeDiagnosticText(value: string, maxLength = 140): string {
  return compactStatusError(
    value
      .replace(/\bsession[_ -]?id\s*[:=]\s*[^\s,;]+/gi, "session_id: <redacted>")
      .replace(/\b(?:bearer|token|api[- ]?key|secret)\s*[:=]?\s*[^\s,;]+/gi, "credential: <redacted>")
      .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{8,}\b/gi, "<redacted>")
      .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
      .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>"),
    maxLength,
  );
}

function diagnosticAgentName(config: AgentConfig): string {
  if (config.provider === "claude") return "Claude Code";
  if (config.provider === "codex") return "Codex CLI";
  if (config.provider === "hermes") return "Hermes Agent";
  return config.displayName || "自定义 Agent";
}

function diagnosticAgentCommandLabel(config: AgentConfig): string {
  if (config.provider === "claude") return "claude";
  if (config.provider === "codex") return "codex";
  if (config.provider === "hermes") return "hermes";
  return "自定义命令（已隐藏路径）";
}

function diagnosticAgentRecord(config: AgentConfig): AgentDiagnosticRecord {
  return agentDiagnosticRecords.get(config.id) ?? { command: null, health: null, checkedAt: null };
}

function agentHealthSessionNote(config: AgentConfig | null): string {
  const health = config ? diagnosticAgentRecord(config).health : null;
  if (!health) return "结果仅保存在当前设置会话，不写入磁盘";
  const checkedAt = config ? diagnosticAgentRecord(config).checkedAt : null;
  return `上次结果：${health.ok ? "成功" : healthErrorLabel(health.errorCode)}${checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString()}` : ""} · 仅当前设置会话保存`;
}

function diagnosticDiscovery(config: AgentConfig): LocalAgentInfo | null {
  return agentDiscovery.find((agent) =>
    (config.provider && agent.provider === config.provider) ||
    (agent.command && agent.command === config.command),
  ) ?? null;
}

function healthErrorLabel(code: AgentHealthCheckResult["errorCode"]): string {
  const labels: Record<AgentHealthCheckResult["errorCode"], string> = {
    ok: "通过",
    "not-installed": "命令不存在",
    authentication: "认证失败",
    "rate-limited": "额度/限流",
    timeout: "超时",
    "empty-response": "空响应",
    failed: "执行失败",
  };
  return labels[code];
}

function diagnosticAgentState(config: AgentConfig): { className: string; label: string; detail: string; version: string } {
  const record = diagnosticAgentRecord(config);
  const discovery = diagnosticDiscovery(config);
  if (record.health) {
    return {
      className: record.health.ok ? "is-ok" : "is-error",
      label: record.health.ok ? "真实请求通过" : `真实请求失败 · ${healthErrorLabel(record.health.errorCode)}`,
      detail: record.health.ok
        ? `${record.health.durationMs} ms`
        : sanitizeDiagnosticText(record.health.detail),
      version: record.command?.version ?? discovery?.version ?? "",
    };
  }
  if (record.command) {
    return {
      className: record.command.ok ? "is-ok" : "is-error",
      label: record.command.ok ? "命令可执行" : "命令检查失败",
      detail: sanitizeDiagnosticText(record.command.detail),
      version: record.command.version ?? discovery?.version ?? "",
    };
  }
  if (discovery) {
    return {
      className: discovery.status === "available" ? "is-ok" : discovery.status === "error" ? "is-error" : "is-muted",
      label: discoveryStatusLabel(discovery),
      detail: sanitizeDiagnosticText(discovery.detail),
      version: discovery.version ?? "",
    };
  }
  return { className: "is-muted", label: "尚未检查", detail: "", version: "" };
}

function diagnosticChannelName(platform: ChannelStatus["platform"]): string {
  if (platform === "wechat") return "微信机器人";
  if (platform === "qq") return "QQ 机器人";
  if (platform === "dingtalk") return "钉钉机器人";
  return "飞书机器人";
}

function renderDiagnosticsAgents(settings: PetSettings): string {
  return cardAgentConfigs(settings).map((config) => {
    const state = diagnosticAgentState(config);
    const record = diagnosticAgentRecord(config);
    const checkedAt = record.checkedAt ? new Date(record.checkedAt).toLocaleTimeString() : "";
    return `
      <article class="diagnostics-row diagnostics-row--${state.className}">
        <div class="diagnostics-row__main">
          <strong>${escapeHtml(diagnosticAgentName(config))}</strong>
          <small>${escapeHtml(diagnosticAgentCommandLabel(config))}${state.version ? ` · ${escapeHtml(sanitizeDiagnosticText(state.version, 80))}` : ""}</small>
        </div>
        <div class="diagnostics-row__state">
          <b>${escapeHtml(state.label)}</b>
          <small>${escapeHtml(state.detail)}${checkedAt ? ` · ${checkedAt}` : ""}</small>
        </div>
      </article>
    `;
  }).join("");
}

function renderDiagnosticsChannels(settings: PetSettings): string {
  if (diagnosticChannelStatuses.length === 0) {
    return `<div class="diagnostics-empty">暂无通道状态</div>`;
  }
  return diagnosticChannelStatuses.map((status) => {
    const failure = status.lastError
      ? `最近错误：${sanitizeDiagnosticText(status.lastError, 100)}`
      : status.state === "failed" ? "最近错误：连接失败" : "无最近错误";
    return `
      <article class="diagnostics-row diagnostics-row--${status.state === "connected" ? "is-ok" : status.state === "failed" ? "is-error" : "is-muted"}">
        <div class="diagnostics-row__main">
          <strong>${escapeHtml(diagnosticChannelName(status.platform))}</strong>
          <small>${escapeHtml(status.state)} · 重试 ${status.retryCount} 次</small>
        </div>
        <div class="diagnostics-row__state">
          <b>${escapeHtml(channelStateLabel(status))}</b>
          <small>${escapeHtml(failure)}</small>
        </div>
      </article>
    `;
  }).join("");
}

function buildDiagnosticsReport(settings: PetSettings): string {
  const lines = [
    "Penguin Desktop Pet 诊断摘要",
    `应用版本：${diagnosticAppVersion || "未知"}`,
    `生成时间：${new Date().toISOString()}`,
    "隐私说明：本摘要不包含 token、App Secret、完整本地路径、账号 ID 或聊天正文。",
    "",
    "Agent：",
  ];
  for (const config of cardAgentConfigs(settings)) {
    const state = diagnosticAgentState(config);
    const record = diagnosticAgentRecord(config);
    lines.push(`- ${diagnosticAgentName(config)} | ${state.label} | 命令：${diagnosticAgentCommandLabel(config)}`);
    if (state.version) lines.push(`  版本：${sanitizeDiagnosticText(state.version, 80)}`);
    if (state.detail) lines.push(`  详情：${sanitizeDiagnosticText(state.detail, 140)}`);
    if (record.health && !record.health.ok) lines.push(`  错误分类：${record.health.errorCode}`);
  }
  lines.push("", "Bot 通道：");
  if (diagnosticChannelStatuses.length === 0) {
    lines.push("- 暂无运行中的通道状态");
  } else {
    for (const status of diagnosticChannelStatuses) {
      lines.push(`- ${diagnosticChannelName(status.platform)} | ${channelStateLabel(status)} | 重试：${status.retryCount}`);
      if (status.lastError) lines.push(`  最近错误：${sanitizeDiagnosticText(status.lastError, 140)}`);
    }
  }
  lines.push("", `已加入 Agent 卡片数：${cardAgentConfigs(settings).length}`, `已配置 Bot 账号数：${settings.wechatAccounts.length + settings.qqAccounts.length + settings.feishuAccounts.length + settings.dingtalkAccounts.length}`);
  return lines.join("\n");
}

function renderWeChatDiagnostics(): string {
  const details: string[] = [];
  if (wechatStatus.lastError) details.push(`最近错误：${escapeHtml(compactStatusError(wechatStatus.lastError))}`);
  if (wechatStatus.retryCount > 0) details.push(`重试 ${wechatStatus.retryCount} 次`);
  if (wechatStatus.nextRetryAt) details.push(`下次：${new Date(wechatStatus.nextRetryAt).toLocaleTimeString()}`);
  return `<small id="wechat-connection-diagnostics" class="wechat-connection-card__diagnostics" ${details.length > 0 ? "" : "hidden"}>${details.join(" · ")}</small>`;
}

function discoveryStatusLabel(agent: LocalAgentInfo): string {
  if (agent.status === "available") return agent.supported ? "可用" : "已发现 · 待适配";
  if (agent.status === "not-installed") return "未安装";
  if (agent.status === "desktop-only") return "桌面工具 · 待适配";
  return "检测异常";
}

function compactAgentVersionLabel(name: string, command: string | null, version: string | null): string {
  if (!version?.trim()) return "";
  const raw = version.replace(/\s+/g, " ").trim();
  const prefixes = [name, command ?? "", command ? `${command}-cli` : ""]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let compact = raw;
  for (const prefix of prefixes) {
    compact = compact.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[-:·]|版本)?\\s*`, "i"), "");
  }
  const versionMatch = compact.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/i);
  if (versionMatch) return versionMatch[0];
  return compact.length > 24 ? `${compact.slice(0, 23)}…` : compact;
}

function discoveryCommandSummary(agent: LocalAgentInfo): string {
  const command = agent.command ?? "桌面应用";
  const version = compactAgentVersionLabel(agent.name, agent.command, agent.version);
  return version ? `${command} · ${version}` : command;
}

function discoveryBrandKey(agent: LocalAgentInfo): string {
  return brandKeyFromIdentity(`${agent.sourceApp || ""} ${agent.provider || ""}`) || "custom";
}

function discoveryIconClass(agent: LocalAgentInfo): string {
  return `agent-card__icon--${discoveryBrandKey(agent)}`;
}

function discoveryIconMarkup(agent: LocalAgentInfo): string {
  return renderAgentBrandIcon(discoveryBrandKey(agent), agent.name);
}

function renderDiscoveryResults(): string {
  if (discoveringAgents) {
    return `<div class="agent-discovery-empty">正在扫描本机命令，请稍候…</div>`;
  }
  if (discoveryError) {
    return `<div class="agent-discovery-empty agent-discovery-empty--error">${escapeHtml(discoveryError)}</div>`;
  }
  if (agentDiscovery.length === 0) {
    return `<div class="agent-discovery-empty">暂无扫描结果</div>`;
  }
  return agentDiscovery.map((agent) => {
    const existing = draftSettings
      ? agentConfigs(draftSettings).find((config) =>
        config.source !== "cc-switch"
        && ((agent.sourceApp && config.sourceApp === agent.sourceApp)
          || (config.source === "discovered" && config.id === `local:${agent.id}`)),
      )
      : undefined;
    const available = agent.status === "available" && Boolean(agent.command);
    const isAdded = Boolean(existing && existing.agentCardVisible !== false);
    const statusLabel = isAdded ? "已添加" : discoveryStatusLabel(agent);
    const commandSummary = discoveryCommandSummary(agent);
    const action = agent.command
      ? `<button class="agent-discovery-card__action ${isAdded ? "is-added" : ""}" type="button" data-toggle-discovered="${escapeHtml(agent.id)}" aria-label="${escapeHtml(isAdded ? `${agent.name} 已添加到 Agent 卡片` : `添加 ${agent.name} 到 Agent 卡片`)}" ${available ? "" : "disabled"}>${isAdded ? "已添加" : available ? "添加" : "安装后添加"}</button>`
      : "";
    const statusMarkup = isAdded
      ? ""
      : `<span class="agent-discovery-card__meta">${escapeHtml(statusLabel)}</span>`;
    return `
      <article class="agent-discovery-card agent-discovery-card--${agent.status} ${isAdded ? "is-added" : ""}" data-discovered-card="${escapeHtml(agent.id)}" tabindex="${available ? "0" : "-1"}" aria-label="${escapeHtml(`${agent.name}，${statusLabel}`)}">
        <span class="agent-discovery-card__icon ${discoveryIconClass(agent)}" aria-hidden="true">${discoveryIconMarkup(agent)}</span>
        <span class="agent-discovery-card__copy">
          <span class="agent-discovery-card__headline">
            <strong>${escapeHtml(agent.name)}</strong>
            ${statusMarkup}
          </span>
          <small title="${escapeHtml(agent.version ?? commandSummary)}">${escapeHtml(commandSummary)}</small>
        </span>
        ${action}
      </article>
    `;
  }).join("");
}

function updateAgentDiscoveryView(): void {
  const results = contentControl.querySelector<HTMLElement>(".agent-discovery-results");
  if (results) {
    results.innerHTML = renderDiscoveryResults();
    softRefresh(results);
  }

  const button = contentControl.querySelector<HTMLButtonElement>("#discover-agents");
  if (button) {
    button.disabled = discoveringAgents;
    button.textContent = discoveringAgents
      ? "扫描中…"
      : agentDiscovery.length > 0
        ? "重新扫描"
        : "开始扫描";
  }

  const importButton = contentControl.querySelector<HTMLButtonElement>("#import-ccswitch-agents");
  if (importButton) {
    const buttonState = ccSwitchImportButtonState();
    importButton.disabled = buttonState.disabled;
    importButton.textContent = buttonState.label;
  }
}

function ccSwitchImportButtonState(settings: PetSettings | null = draftSettings): { label: string; disabled: boolean } {
  if (settings?.zeroToken.enabled) return { label: "从 CCS 导入（Zero Token 已启用）", disabled: true };
  if (!settings?.ccSwitchSyncEnabled) return { label: "未启用 CCS", disabled: true };
  if (ccSwitchBindingLoading) return { label: "从 CCS 导入中…", disabled: true };
  if (ccSwitchStatusLoading) return { label: "检测 CCS 中…", disabled: true };
  if (ccSwitchStatus?.state === "not-found") return { label: "未检测到CCS", disabled: true };
  if (ccSwitchStatus?.state === "error") return { label: "重试 CCS 检测", disabled: false };
  return { label: "从 CCS 导入", disabled: false };
}

function updateAgentCardListView(): void {
  if ((currentPage !== "agents" && currentPage !== "agent-add") || !draftSettings) return;
  const list = contentControl.querySelector<HTMLElement>("#agent-card-list");
  if (list) {
    const scrollTop = list.scrollTop;
    window.setTimeout(() => {
      list.scrollTop = scrollTop;
    }, 0);
    const cards = cardAgentConfigs(draftSettings);
    list.innerHTML = cards.length > 0
      ? cards.map((config) => renderAgentCard(config, draftSettings)).join("")
      : `<div class="agent-list-empty">暂无已加入卡片，请从下方扫描本机 Agent。</div>`;
    list.querySelectorAll<HTMLButtonElement>(".agent-card-shell--preserved .agent-card__remove").forEach((button) => {
      button.disabled = true;
    });
  }
}

type SettingCardIconColor = "purple" | "blue" | "green" | "orange" | "yellow" | "gray";
type IconBadgeName =
  | "sparkle"
  | "chat"
  | "task"
  | "app-status"
  | "personalization"
  | "bots"
  | "agent"
  | "memory"
  | "pet-perception"
  | "bell"
  | "target"
  | "interaction"
  | "feedback"
  | "location"
  | "move"
  | "status-light"
  | "advanced"
  | "eye"
  | "filter"
  | "sensitive"
  | "frequency"
  | "event"
  | "quiet"
  | "rule"
  | "content"
  | "display"
  | "tip"
  | "diagnostics"
  | "privacy"
  | "info"
  | "pet-style"
  | "memory-all"
  | "wechat"
  | "qq"
  | "feishu"
  | "dingtalk";

interface SettingCardProps {
  id: string;
  icon: IconBadgeName;
  iconColor: SettingCardIconColor;
  title: string;
  description: string;
  badge?: string;
  /** Delegated action key; the renderer keeps handlers out of inline markup. */
  onClick?: string;
  className?: string;
  ariaLabel?: string;
}

function renderIconBadge(icon: IconBadgeName, color: SettingCardIconColor): string {
  const paths: Record<IconBadgeName, string> = {
    sparkle: '<path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 8l2-5.5Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
    chat: '<path d="M5 6.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
    task: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/><path d="m8.2 6.2.8.8 1.6-1.7"/>',
    "app-status": '<rect x="3.5" y="5" width="17" height="13" rx="2"/><path d="M8 21h8M12 18v3M7 9h10M7 12.5h.01M10 12.5h.01"/>',
    personalization: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c.8-3.3 3-5 6.5-5s5.7 1.7 6.5 5"/>',
    bots: '<path d="M7 17.5h7.5l3.5 2v-2h1a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2Z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>',
    agent: '<path d="M8.5 9.5a3.5 3.5 0 1 0 0 7h1.2V20h4.6v-3.5h1.2a3.5 3.5 0 1 0 0-7h-1.2V6.2a2.3 2.3 0 0 0-4.6 0v3.3H8.5Z"/><path d="M9 12h6M12 9v6"/>',
    memory: '<path d="M8.5 8.5A3.5 3.5 0 0 0 7 15.2 3.5 3.5 0 0 0 10.5 19h1.5V7.5a3 3 0 0 0-3.5 1Z"/><path d="M15.5 8.5A3.5 3.5 0 0 1 17 15.2a3.5 3.5 0 0 1-3.5 3.8H12V7.5a3 3 0 0 1 3.5 1Z"/><path d="M9 12h1.5M14.5 12H13M9.5 15h1M14.5 15H14"/>',
    "pet-perception": '<path d="M3 12h3l2-6 4 12 2-6h7"/>',
    bell: '<path d="M6 17h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4L6 17Z"/><path d="M10 20h4"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    interaction: '<path d="M5 6.5h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6l-4 3v-3H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"/><path d="M8 11.5h8"/>',
    feedback: '<path d="M5 4.5h14v15H5z"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/><path d="m16 4.5 1.5-2 1.5 2"/>',
    location: '<path d="M12 21s6-5.5 6-11a6 6 0 1 0-12 0c0 5.5 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/>',
    move: '<path d="M12 3v18M3 12h18"/><path d="m8 7 4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    "status-light": '<path d="M9 17h6M10 20h4"/><path d="M8 14.5a6 6 0 1 1 8 0c-.8.7-1 1.3-1 2.5H9c0-1.2-.2-1.8-1-2.5Z"/><path d="M12 2v2M4.9 4.9l1.4 1.4M19.1 4.9l-1.4 1.4"/>',
    advanced: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.6V20a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.6-1H6v-2.6h.4A1.7 1.7 0 0 0 8 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2H15V5a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2V14h-.2a1.7 1.7 0 0 0-1.6 1Z"/>',
    eye: '<path d="M2.5 12s3.3-5 9.5-5 9.5 5 9.5 5-3.3 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/>',
    filter: '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z"/>',
    sensitive: '<path d="M12 3 20 7v5c0 4.5-3.1 7.8-8 9-4.9-1.2-8-4.5-8-9V7l8-4Z"/><path d="M9.5 12h5M12 9.5v5"/>',
    frequency: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    event: '<path d="M6 4.5h12v15H6z"/><path d="M9 8.5h6M9 12h6M9 15.5h3"/><path d="m16 4.5 1-2 1 2"/>',
    quiet: '<path d="M5 10h3l4-3v10l-4-3H5z"/><path d="m17 9 4 6M21 9l-4 6"/>',
    rule: '<path d="M6 4.5h12v15H6z"/><path d="M9 8h6M9 12h6M9 16h4"/><path d="m9 4.5 1-2h4l1 2"/>',
    content: '<path d="M5 4.5h14v15H5z"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
    display: '<rect x="3.5" y="5" width="17" height="13" rx="2"/><path d="M8 21h8M12 18v3"/><path d="M8 9.5h8M8 13h5"/>',
    tip: '<path d="M8 15.5a6 6 0 1 1 8 0c-.8.7-1 1.3-1 2.5H9c0-1.2-.2-1.8-1-2.5Z"/><path d="M10 21h4M12 2v1"/>',
    diagnostics: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h3M9 16h6"/><circle cx="16" cy="16" r="1.5"/>',
    privacy: '<path d="m12 3 7 3v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    "pet-style": '<path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2 2-5.5Z"/>',
    "memory-all": '<path d="M6 5.5h10a2 2 0 0 1 2 2V19H8a2 2 0 0 1-2-2V5.5Z"/><path d="M6 7.5h-1a2 2 0 0 0-2 2V19h12M9 10h6M9 13h6"/>',
    wechat: '<path d="M6.5 17.5c-2 0-3.5-1.3-3.5-3s1.5-3 3.5-3c.3 0 .6 0 .9.1C7.8 9.2 10.1 7.5 13 7.5c3.3 0 6 2.1 6 4.8 0 1.2-.5 2.3-1.4 3.2l.6 2-2.2-1a7 7 0 0 1-3 .6c-1 0-2-.2-2.8-.6-.9.6-2.1 1-3.7 1Z"/><path d="M9 12h.01M13 12h.01M16 14h.01"/>',
    qq: '<path d="M6 15.5c-1.3 1.7-1.2 3.1-.5 3.1.5 0 1.1-.4 1.6-1 1.3 1.1 2.9 1.7 4.9 1.7s3.6-.6 4.9-1.7c.5.6 1.1 1 1.6 1 .7 0 .8-1.4-.5-3.1.2-.6.3-1.3.3-2C18.3 9.9 15.5 7 12 7s-6.3 2.9-6.3 6.5c0 .7.1 1.4.3 2Z"/><path d="M9 12h.01M15 12h.01"/>',
    feishu: '<path d="m12 3 2.1 6.1L20 11l-5.9 1.9L12 19l-2.1-6.1L4 11l5.9-1.9L12 3Z"/><path d="m18.5 15 .6 1.5 1.4.5-1.4.5-.6 1.5-.6-1.5-1.4-.5 1.4-.5.6-1.5Z"/>',
    dingtalk: '<path d="M5 6.5c2.4 1.3 4.7 2 7 2 1.7 0 3.3-.3 4.7-.9-1.1 2.4-2.7 4.2-4.7 5.4v3.5"/><path d="M8 18.5h5M10 15.5h4"/>'
  };
  return `<span class="icon-badge icon-badge--${color}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[icon]}</svg></span>`;
}

/**
 * The navigation primitive for the settings surface. Keeping the markup in
 * one place makes the home page, bot channels, and secondary settings pages
 * feel like one product instead of a collection of legacy lists.
 */
function renderSettingCardCompact(props: SettingCardProps): string {
  const className = ["setting-card-compact", "setting-card", props.className].filter(Boolean).join(" ");
  const actionKey = props.onClick ?? props.id;
  return `
    <button id="${escapeHtml(props.id)}" data-setting-action="${escapeHtml(actionKey)}" class="${className}" type="button"${props.ariaLabel ? ` aria-label="${escapeHtml(props.ariaLabel)}"` : ""}>
      ${renderIconBadge(props.icon, props.iconColor)}
      <span class="setting-card__copy"><strong>${escapeHtml(props.title)}</strong><small>${escapeHtml(props.description)}</small></span>
      ${props.badge ? `<span class="setting-card__badge">${escapeHtml(props.badge)}</span>` : ""}
      <span class="setting-card__arrow" aria-hidden="true">&rsaquo;</span>
    </button>
  `;
}

interface PerceptionItemProps {
  icon: IconBadgeName;
  iconColor: SettingCardIconColor;
  title: string;
  description: string;
  value: string;
  /** Delegated perception action key; the parent owns route/state changes. */
  onClick?: string;
  control?: string;
}

function renderPerceptionItem(props: PerceptionItemProps): string {
  const valueMarkup = props.control
    ? props.control
    : `<span class="perception-item__value-text">${escapeHtml(props.value)}</span><span class="perception-item__arrow" aria-hidden="true">&rsaquo;</span>`;
  const tag = props.onClick ? "button" : "div";
  const attributes = props.onClick
    ? ` type="button" data-perception-action="${escapeHtml(props.onClick)}" aria-label="${escapeHtml(props.title)}"`
    : "";
  return `
    <${tag} class="perception-item${props.onClick ? " perception-item--interactive" : ""}"${attributes}>
      ${renderIconBadge(props.icon, props.iconColor)}
      <span class="perception-item__copy"><strong>${escapeHtml(props.title)}</strong><small>${escapeHtml(props.description)}</small></span>
      <span class="perception-item__value">${valueMarkup}</span>
    </${tag}>
  `;
}

function renderPerceptionCard(items: PerceptionItemProps[], className = ""): string {
  return `<section class="perception-card ${className}">${items.map((item) => renderPerceptionItem(item)).join("")}</section>`;
}

function renderPerceptionCheckStatus(enabled: boolean): string {
  return `<span class="perception-check-status ${enabled ? "is-enabled" : ""}"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m4.5 10.5 3.2 3.2 7.8-8"/></svg><span>${enabled ? "已开启" : "未开启"}</span></span>`;
}

function renderPerceptionPageHeading(title: string, description: string): string {
  return `
    <div class="settings-title-row perception-settings-title">
      <div><div class="settings-page-kicker">PET PERCEPTION</div><h1>${escapeHtml(title)}</h1></div>
      <span id="perception-auto-save-state" class="settings-save-state perception-auto-save-state">${saving ? "正在保存…" : "✓ 已自动保存"}</span>
    </div>
    <p class="settings-page-intro perception-page-intro">${escapeHtml(description)}</p>
  `;
}

function renderThemePicker(theme: PetTheme): string {
  const themes: Array<{ id: PetTheme; name: string }> = [
    { id: "minimal", name: "简约" },
    { id: "soft", name: "柔和" },
    { id: "night", name: "夜间" },
  ];
  return `
    <div class="theme-picker" role="radiogroup" aria-label="界面主题">
      ${themes.map((item) => `
        <label class="theme-option ${theme === item.id ? "is-active" : ""}" data-theme-option="${item.id}">
          <input data-setting="theme" type="radio" name="theme" value="${item.id}" ${theme === item.id ? "checked" : ""} />
          <span class="theme-option__swatch theme-option__swatch--${item.id}" aria-hidden="true"></span>
          <span><strong>${item.name}</strong></span>
        </label>
      `).join("")}
    </div>
  `;
}

const PET_STYLE_STATE_META: Array<{ id: PetState; name: string }> = [
  { id: "idle", name: "待机" },
  { id: "walk", name: "行走" },
  { id: "happy", name: "开心" },
  { id: "shy", name: "害羞" },
  { id: "sleep", name: "睡觉" },
  { id: "eat", name: "吃东西" },
  { id: "angry", name: "生气" },
];

function petStyleStateCount(style: PetStyle): number {
  const configured = style.id === "default-penguin" ? PET_STYLE_STATE_META.length : (style.configuredStates?.length ?? 0);
  return configured + (style.customStates?.length ?? 0);
}

function isPetStyleStateConfigured(style: PetStyle, state: PetState): boolean {
  return style.id === "default-penguin" || Boolean(style.configuredStates?.includes(state));
}

function renderPetStylePicker(settings: PetSettings): string {
  const style = settings.petStyles.find((item) => item.id === settings.activePetStyleId) ?? settings.petStyles[0];
  const name = style?.name ?? "默认企鹅";
  return [
    '<section id="pet-style-settings" class="pet-style-settings pet-style-settings--summary">',
    renderSettingCardCompact({
      id: "open-pet-style-settings",
      icon: "pet-style",
      iconColor: "purple",
      title: "宠物风格",
      description: name,
      className: "setting-card--nested",
    }),
    '</section>',
  ].join("");
}

function perceptionAgentSummary(settings: PetSettings | null = draftSettings): string {
  const perception = settings?.petPerception;
  if (perception && !perception.agentRuntime && !perception.taskActivity && !perception.botActivity) {
    return "自动观察来源已关闭";
  }
  const aggregate = petPerceptionSnapshot?.aggregate;
  if (aggregate && perception) {
    const summary = [
      perception.taskActivity ? `${aggregate.activeTaskCount} 个活动任务` : "",
      perception.agentRuntime
        ? aggregate.configuredAgentCount > 0
          ? `${aggregate.availableAgentCount}/${aggregate.configuredAgentCount} 个 Agent 可用`
          : "未配置 Agent"
        : "",
      perception.botActivity
        ? aggregate.configuredChannelCount > 0
          ? `${aggregate.connectedChannelCount}/${aggregate.configuredChannelCount} 个 Bot 在线`
          : "未配置 Bot 通道"
        : "",
    ].filter(Boolean);
    if (summary.length > 0) return summary.join(" · ");
    return "自动观察来源已关闭";
  }
  if (aggregate?.detail) return aggregate.detail;
  const agents = petPerceptionSnapshot?.agents ?? [];
  if (agents.length === 0) return "等待已配置的 Agent";
  const availableCount = agents.filter((agent) => agent.runtime === "online" || agent.controller === "available").length;
  const primary = agents.find((agent) => agent.id === petPerceptionSnapshot?.primaryAgentId);
  const primaryState = primary ? ` · 主 Agent ${perceptionPhaseLabel(petPerceptionSnapshot?.primaryAgentPhase ?? "waiting")}` : "";
  return `${availableCount}/${agents.length} 个 Agent 可用${primaryState}`;
}

type PerceptionFeedbackMode = "full" | "action" | "bubble" | "silent";

function perceptionFeedbackMode(settings: PetSettings): PerceptionFeedbackMode {
  const { actionFeedback, bubbleFeedback } = settings.petPerception;
  if (actionFeedback && bubbleFeedback) return "full";
  if (actionFeedback) return "action";
  if (bubbleFeedback) return "bubble";
  return "silent";
}

const PERCEPTION_FEEDBACK_MODE_LABELS: Record<PerceptionFeedbackMode, string> = {
  full: "动作 + 气泡",
  action: "仅动作",
  bubble: "仅气泡",
  silent: "静默",
};

const PERCEPTION_FEEDBACK_MODE_HINTS: Record<PerceptionFeedbackMode, string> = {
  full: "桌宠会切换动作，并在重要状态变化时显示短气泡。",
  action: "桌宠只用动作回应，不弹出感知气泡。",
  bubble: "桌宠保持当前动作，只显示重要状态气泡。",
  silent: "不做额外动作或气泡，状态仍会在设置页和状态灯中更新。",
};

function perceptionFeedbackModeLabel(mode: PerceptionFeedbackMode): string {
  return PERCEPTION_FEEDBACK_MODE_LABELS[mode];
}

function perceptionFeedbackModeHint(mode: PerceptionFeedbackMode): string {
  return PERCEPTION_FEEDBACK_MODE_HINTS[mode];
}

function perceptionSourceSummary(settings: PetSettings): string {
  const perception = settings.petPerception;
  const sources = [
    perception.taskActivity ? "任务状态" : "",
    perception.agentRuntime ? "Agent 可用性" : "",
    perception.botActivity ? "Bot 在线状态" : "",
  ].filter(Boolean);
  return sources.length > 0 ? sources.join("、") : "未选择观察来源";
}

type PerceptionSourceScope = "none" | "task" | "task-agent" | "task-bot" | "all" | "custom";

const PERCEPTION_SOURCE_SCOPE_LABELS: Record<PerceptionSourceScope, string> = {
  none: "不自动观察",
  task: "只看任务状态",
  "task-agent": "任务 + Agent 状态",
  "task-bot": "任务 + Bot 在线",
  all: "全部来源",
  custom: "自定义（高级）",
};

const PERCEPTION_SOURCE_SCOPE_HINTS: Record<PerceptionSourceScope, string> = {
  none: "仅保留手动协同感知，不主动读取本机状态。",
  task: "监听运行、等待、完成和异常，适合大多数情况。",
  "task-agent": "在任务状态之外，补充 Agent 命令和控制器可用性。",
  "task-bot": "在任务状态之外，补充 QQ、微信、飞书和钉钉在线状态。",
  all: "同时观察任务、Agent 可用性和 Bot 在线状态。",
  custom: "当前是特殊组合；可在下方高级设置中逐项调整。",
};

function perceptionSourceScope(settings: PetSettings): PerceptionSourceScope {
  const { agentRuntime, taskActivity, botActivity } = settings.petPerception;
  if (!agentRuntime && !taskActivity && !botActivity) return "none";
  if (taskActivity && !agentRuntime && !botActivity) return "task";
  if (taskActivity && agentRuntime && !botActivity) return "task-agent";
  if (taskActivity && !agentRuntime && botActivity) return "task-bot";
  if (taskActivity && agentRuntime && botActivity) return "all";
  return "custom";
}

function perceptionSourceScopeHint(scope: PerceptionSourceScope): string {
  return PERCEPTION_SOURCE_SCOPE_HINTS[scope];
}

function perceptionSourceScopePatch(scope: PerceptionSourceScope): Partial<PetPerceptionSettings> | null {
  if (scope === "custom") return null;
  if (scope === "none") return { agentRuntime: false, taskActivity: false, botActivity: false };
  if (scope === "task") return { agentRuntime: false, taskActivity: true, botActivity: false };
  if (scope === "task-agent") return { agentRuntime: true, taskActivity: true, botActivity: false };
  if (scope === "task-bot") return { agentRuntime: false, taskActivity: true, botActivity: true };
  return { agentRuntime: true, taskActivity: true, botActivity: true };
}

type PerceptionDigestMode = "off" | "on";

function perceptionDigestMode(settings: PetSettings): PerceptionDigestMode {
  return settings.petPerception.longTaskReplyEnabled ? "on" : "off";
}

const PERCEPTION_DIGEST_MODE_HINTS: Record<PerceptionDigestMode, string> = {
  off: "只通知任务开始和完成，最安静。",
  on: "允许“详情”或“定时”方式发送中间简报，并自动退避重复阶段。",
};

function perceptionDigestModeHint(mode: PerceptionDigestMode): string {
  return PERCEPTION_DIGEST_MODE_HINTS[mode];
}

function perceptionPhaseLabel(phase: PetPerceptionSnapshot["primaryAgentPhase"]): string {
  const labels: Record<PetPerceptionSnapshot["primaryAgentPhase"], string> = {
    offline: "不可用",
    online: "可用",
    starting: "准备中",
    working: "处理中",
    waiting: "等待中",
    received: "收到消息",
    success: "已完成",
    error: "异常",
  };
  return labels[phase];
}

function perceptionRuntimeLabel(runtime: PetPerceptionSnapshot["agents"][number]["runtime"]): string {
  return runtime === "online" ? "命令可用" : runtime === "offline" ? "命令不可用" : "待确认";
}

function perceptionCcSwitchLabel(config: AgentConfig | undefined): string {
  const state = config?.ccSwitchCurrentConfig?.state;
  if (state === "current") return "CCS 当前配置已绑定";
  if (state === "stale") return "CCS 配置已过期";
  if (state === "needs-login") return "CCS 配置需登录";
  if (state === "missing") return "CCS 配置待引用";
  return config?.source === "cc-switch" ? "CCS 配置待绑定" : "未接入 CCS";
}

function perceptionControllerLabel(controller: PetPerceptionSnapshot["agents"][number]["controller"]): string {
  return controller === "available" ? "控制器可用" : controller === "unavailable" ? "控制器不可用" : "控制器待确认";
}

function perceptionObservedLabel(value: string | null): string {
  if (!value) return "尚未观察";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚观察";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前观察`;
  return new Date(timestamp).toLocaleTimeString();
}

function perceptionEventSourceLabel(event: PetPerceptionEvent): string {
  if (event.source === "agent-runtime") return "Agent 可用性";
  if (event.source === "agent-task") return "任务状态";
  if (event.source === "controller") return "控制器状态";
  if (event.source === "agent-perception") return "Agent 协同感知";
  return event.platform ? `${event.platform === "wechat" ? "微信" : event.platform === "qq" ? "QQ" : event.platform === "feishu" ? "飞书" : "钉钉"} Bot` : "Bot 状态";
}

function perceptionPlatformLabel(platform: PetPerceptionSnapshot["channels"][number]["platform"]): string {
  return platform === "wechat" ? "微信" : platform === "qq" ? "QQ" : platform === "feishu" ? "飞书" : "钉钉";
}

function perceptionChannelStateLabel(state: PetPerceptionSnapshot["channels"][number]["state"]): string {
  return state === "online" ? "在线" : state === "offline" ? "离线" : "待确认";
}

type PerceptionStatusTone = "online" | "offline" | "unknown" | "active" | "success" | "error";

function perceptionAgentTone(agent: PetPerceptionSnapshot["agents"][number]): PerceptionStatusTone {
  if (agent.runtime === "online" || agent.controller === "available") return "online";
  if (agent.runtime === "offline" && agent.controller === "unavailable") return "offline";
  return "unknown";
}

function perceptionPhaseTone(phase: PetPerceptionSnapshot["primaryAgentPhase"]): PerceptionStatusTone {
  if (phase === "online") return "online";
  if (phase === "success") return "success";
  if (phase === "offline") return "offline";
  if (phase === "error") return "error";
  if (phase === "starting" || phase === "working" || phase === "received") return "active";
  return "unknown";
}

function perceptionStatusBadge(tone: PerceptionStatusTone, label: string): string {
  return `<span class="perception-status-badge perception-status-badge--${tone}"><span class="perception-status-badge__dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function agentTaskStateLabel(state: AgentTaskSnapshot["tasks"][number]["state"]): string {
  if (state === "running") return "运行中";
  if (state === "needs-input") return "需要输入";
  if (state === "ready") return "已完成";
  if (state === "blocked") return "阻塞/异常";
  if (state === "idle") return "空闲";
  return "未知";
}

function agentTaskStateTone(state: AgentTaskSnapshot["tasks"][number]["state"]): PerceptionStatusTone {
  if (state === "running" || state === "needs-input") return "active";
  if (state === "ready") return "success";
  if (state === "blocked") return "error";
  if (state === "idle") return "online";
  return "unknown";
}

function agentTaskSurfaceLabel(surface: AgentTaskSnapshot["tasks"][number]["surface"]): string {
  if (surface === "desktop") return "桌面端";
  if (surface === "vscode") return "VS Code";
  if (surface === "cli") return "命令行";
  return "桌宠接入";
}

function agentTaskSurfaceLabelForTask(task: Pick<AgentTaskSnapshot["tasks"][number], "agentId" | "surface">): string {
  const isCodex = task.agentId === "codex"
    || task.agentId === "external:codex-desktop"
    || task.agentId === "external:codex-cli";
  if (isCodex && task.surface === "desktop") return "Codex Desktop";
  if (isCodex && task.surface === "cli") return "Codex CLI";
  return agentTaskSurfaceLabel(task.surface);
}

function agentTaskSourceLabel(source: AgentTaskSnapshot["tasks"][number]["source"]): string {
  if (source === "process") return "进程探针 · 仅证明客户端存在";
  if (source === "codex-app-server") return "Codex app-server 事件";
  if (source === "codex-notify") return "Codex notify 事件";
  if (source === "claude-hook") return "Claude Hook 事件";
  if (source === "manual-test") return "事件桥手动测试";
  if (source === "app-event") return "桌宠事件";
  return "Agent 注册表";
}

function agentTaskActivityLabel(activity?: AgentTaskActivity): string {
  if (activity === "starting") return "正在启动";
  if (activity === "thinking") return "正在思考/规划";
  if (activity === "command") return "正在执行命令";
  if (activity === "network") return "正在访问网络";
  if (activity === "editing") return "正在编辑文件";
  if (activity === "tool") return "正在调用工具";
  if (activity === "waiting") return "等待中";
  if (activity === "response-ready") return "正在整理答复";
  return "";
}

type PerceptionAgentGroup = {
  groupKey: string;
  id: string;
  surface: AgentTaskSurface | null;
  isRuntimeGroup: boolean;
  displayName: string;
  summary: PetPerceptionSnapshot["agents"][number] | null;
  config: AgentConfig | undefined;
  tasks: AgentTaskSnapshot["tasks"];
};

function configuredAgentSurface(config: AgentConfig | undefined): AgentTaskSurface | null {
  if (!config) return null;
  if (config.sourceApp === "claude-desktop") return "desktop";
  if (config.sourceApp === "claude-code" || config.sourceApp === "hermes" || config.provider) return "cli";
  return "internal";
}

function perceptionTaskPriority(state: AgentTaskSnapshot["tasks"][number]["state"]): number {
  if (state === "needs-input") return 0;
  if (state === "running") return 1;
  if (state === "blocked") return 2;
  if (state === "ready") return 3;
  if (state === "unknown") return 4;
  return 5;
}

function perceptionTaskSummary(tasks: AgentTaskSnapshot["tasks"]): { tone: PerceptionStatusTone; label: string; detail: string } {
  if (tasks.length === 0) return { tone: "unknown", label: "待观察", detail: "暂未收到任务状态" };
  const ordered = [...tasks].sort((left, right) => perceptionTaskPriority(left.state) - perceptionTaskPriority(right.state));
  const primary = ordered[0];
  const activeCount = tasks.filter((task) => task.state === "running" || task.state === "needs-input").length;
  const taskCount = tasks.length > 1 ? ` · ${tasks.length} 个任务` : "";
  const activity = agentTaskActivityLabel(primary.activity);
  const detail = primary.state === "idle"
    ? "暂无活动任务"
    : `${activity ? `${activity} · ` : ""}${primary.taskTitle ? `${primary.taskTitle} · ` : ""}${agentTaskSurfaceLabelForTask(primary)} · ${agentTaskSourceLabel(primary.source)}${taskCount} · ${primary.detail}`;
  return {
    tone: agentTaskStateTone(primary.state),
    label: activeCount > 1 ? `${activeCount} 个活动任务` : agentTaskStateLabel(primary.state),
    detail,
  };
}

function perceptionAgentGroups(
  settings: PetSettings,
  snapshot: PetPerceptionSnapshot | null,
  taskSnapshot: AgentTaskSnapshot | null,
  showAgentRuntime: boolean,
  showTaskActivity: boolean,
): PerceptionAgentGroup[] {
  const groups = new Map<string, PerceptionAgentGroup>();
  if (showAgentRuntime) {
    for (const summary of snapshot?.agents ?? []) {
      const config = settings.agentConfigs.find((item) => item.id === summary.id);
      groups.set(`runtime:${summary.id}`, {
        groupKey: `runtime:${summary.id}`,
        id: summary.id,
        surface: configuredAgentSurface(config),
        isRuntimeGroup: true,
        displayName: summary.displayName,
        summary,
        config,
        tasks: [],
      });
    }
  }
  if (showTaskActivity) {
    for (const task of taskSnapshot?.tasks ?? []) {
      const config = settings.agentConfigs.find((item) => item.id === task.agentId);
      const configuredSurface = configuredAgentSurface(config);
      const runtimeKey = `runtime:${task.agentId}`;
      const runtimeGroup = groups.get(runtimeKey);
      const belongsToConfiguredAgent = task.surface === "internal"
        || (configuredSurface !== null && task.surface === configuredSurface);
      const groupKey = runtimeGroup && belongsToConfiguredAgent
        ? runtimeKey
        : `task:${task.agentId}:${task.surface}`;
      const group = groups.get(groupKey);
      if (group) {
        group.tasks.push(task);
        continue;
      }
      groups.set(groupKey, {
        groupKey,
        id: task.agentId,
        surface: task.surface,
        isRuntimeGroup: false,
        displayName: task.displayName,
        summary: null,
        config: undefined,
        tasks: [task],
      });
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftPriority = left.tasks.length > 0 ? perceptionTaskPriority([...left.tasks].sort((a, b) => perceptionTaskPriority(a.state) - perceptionTaskPriority(b.state))[0].state) : 5;
    const rightPriority = right.tasks.length > 0 ? perceptionTaskPriority([...right.tasks].sort((a, b) => perceptionTaskPriority(a.state) - perceptionTaskPriority(b.state))[0].state) : 5;
    return leftPriority - rightPriority || left.displayName.localeCompare(right.displayName);
  });
}

function renderPerceptionAgentList(
  settings: PetSettings,
  snapshot: PetPerceptionSnapshot | null,
  taskSnapshot: AgentTaskSnapshot | null,
  showAgentRuntime: boolean,
  showTaskActivity: boolean,
): string {
  if (!showAgentRuntime && !showTaskActivity) return '<div class="perception-empty">Agent 状态观察已关闭。</div>';
  const groups = perceptionAgentGroups(settings, snapshot, taskSnapshot, showAgentRuntime, showTaskActivity);
  if (groups.length === 0) return '<div class="perception-empty">尚未发现已配置或正在运行的 Agent。</div>';
  return groups.map((group) => {
    const availabilityTone = group.summary ? perceptionAgentTone(group.summary) : "unknown";
    const availabilityLabel = availabilityTone === "online" ? "在线" : availabilityTone === "offline" ? "离线" : "待确认";
    const taskSummary = showTaskActivity ? perceptionTaskSummary(group.tasks) : null;
    const hasMeaningfulTask = group.tasks.some((task) => task.state !== "idle");
    const displayTone = taskSummary && hasMeaningfulTask ? taskSummary.tone : availabilityTone;
    const displayLabel = taskSummary && hasMeaningfulTask ? taskSummary.label : availabilityLabel;
    const taskDetail = taskSummary && group.tasks.length > 0 ? taskSummary.detail : "暂无活动任务";
    const runtimeDetail = group.summary
      ? `${perceptionRuntimeLabel(group.summary.runtime)} · ${perceptionControllerLabel(group.summary.controller)} · ${perceptionCcSwitchLabel(group.config)}`
      : "仅发现任务事件，尚未建立 Agent 配置";
    const isPrimary = group.isRuntimeGroup && group.id === snapshot?.primaryAgentId;
    return `
      <div class="perception-agent-row ${isPrimary ? "is-primary" : ""}" data-status="${displayTone}">
        <div class="perception-agent-row__identity"><strong>${escapeHtml(group.displayName)}${isPrimary ? " · 主 Agent" : ""}</strong><small>${escapeHtml(taskDetail)}</small><small class="perception-agent-row__source">${escapeHtml(runtimeDetail)}</small></div>
        <div class="perception-agent-row__status">${perceptionStatusBadge(displayTone, displayLabel)}<small>${escapeHtml(group.summary ? perceptionObservedLabel(group.summary.observedAt) : "实时任务事件")}</small></div>
      </div>
    `;
  }).join("");
}

function perceptionRunStateLabel(state: NonNullable<PetPerceptionSnapshot["lastRun"]>["state"]): string {
  if (state === "running") return "感知中";
  if (state === "completed") return "全部完成";
  if (state === "partial") return "部分完成";
  if (state === "failed") return "未完成";
  return "等待中";
}

function perceptionRunTone(state: NonNullable<PetPerceptionSnapshot["lastRun"]>["state"]): PerceptionStatusTone {
  if (state === "completed") return "success";
  if (state === "failed") return "error";
  if (state === "running" || state === "partial") return "active";
  return "unknown";
}

function perceptionParticipantTone(state: NonNullable<PetPerceptionSnapshot["lastRun"]>["participants"][number]["state"]): PerceptionStatusTone {
  if (state === "success") return "success";
  if (state === "error") return "error";
  if (state === "running") return "active";
  return "unknown";
}

function perceptionParticipantStateLabel(state: NonNullable<PetPerceptionSnapshot["lastRun"]>["participants"][number]["state"]): string {
  if (state === "running") return "处理中";
  if (state === "success") return "已完成";
  if (state === "error") return "失败";
  if (state === "skipped") return "已跳过";
  return "排队中";
}

function renderPerceptionRun(run: NonNullable<PetPerceptionSnapshot["lastRun"]>): string {
  const participants = run.participants.length > 0
    ? `<div class="perception-run__participants">${run.participants.map((participant) => `
        <div class="perception-run__participant">
          <div><strong>${escapeHtml(participant.displayName)}</strong><small>${escapeHtml(participant.detail)}</small>${participant.resultPreview ? `<small class="perception-run__preview">${escapeHtml(participant.resultPreview)}</small>` : ""}</div>
          ${perceptionStatusBadge(perceptionParticipantTone(participant.state), perceptionParticipantStateLabel(participant.state))}
        </div>
      `).join("")}</div>`
    : "";
  return `<div class="perception-run perception-run--${perceptionRunTone(run.state)}">
    <div class="perception-run__header"><div><strong>最近一次协同感知</strong><small>信号：${escapeHtml(run.signalPreview || "未提供")}</small></div>${perceptionStatusBadge(perceptionRunTone(run.state), perceptionRunStateLabel(run.state))}</div>
    <small class="perception-run__detail">${escapeHtml(run.detail)}</small>
    ${participants}
  </div>`;
}

function renderPerceptionObservation(settings: PetSettings, snapshot: PetPerceptionSnapshot | null): string {
  const enabled = settings.petPerception.enabled;
  const aggregate = snapshot?.aggregate;
  const channels = snapshot?.channels ?? [];
  const showAgentRuntime = enabled && settings.petPerception.agentRuntime;
  const showTaskActivity = enabled && settings.petPerception.taskActivity;
  const showBotActivity = enabled && settings.petPerception.botActivity;
  const observing = showAgentRuntime || showTaskActivity || showBotActivity;
  const aggregateSummary = aggregate
    ? [
      showTaskActivity ? `${aggregate.activeTaskCount} 个活动任务` : "",
      showAgentRuntime
        ? aggregate.configuredAgentCount > 0
          ? `${aggregate.availableAgentCount}/${aggregate.configuredAgentCount} 个 Agent 可用`
          : "未配置 Agent"
        : "",
      showBotActivity
        ? aggregate.configuredChannelCount > 0
          ? `${aggregate.connectedChannelCount}/${aggregate.configuredChannelCount} 个 Bot 在线`
          : "未配置 Bot 通道"
        : "",
    ].filter(Boolean).join(" · ") || "自动观察来源均已关闭"
    : "";
  const aggregateDetail = aggregateSummary === "自动观察来源均已关闭"
    ? "打开任一自动观察来源后，状态会按选择更新。"
    : aggregate?.detail ?? "";
  const aggregateMarkup = enabled && aggregate
    ? `<div class="perception-aggregate perception-aggregate--${perceptionPhaseTone(aggregate.phase)}"><div class="perception-aggregate__header"><strong>${escapeHtml(aggregateSummary)}</strong>${perceptionStatusBadge(perceptionPhaseTone(aggregate.phase), perceptionPhaseLabel(aggregate.phase))}</div><small>${escapeHtml(aggregateDetail)}</small></div>`
    : "";
  const runMarkup = enabled && snapshot?.lastRun ? renderPerceptionRun(snapshot.lastRun) : "";
  const channelMarkup = showBotActivity && channels.length > 0
    ? `<div class="perception-channel-list">${channels.map((channel) => `<div class="perception-channel-row" data-status="${channel.state}"><span><strong>${escapeHtml(perceptionPlatformLabel(channel.platform))}</strong><small>${escapeHtml(perceptionObservedLabel(channel.observedAt))}</small></span>${perceptionStatusBadge(channel.state === "online" ? "online" : channel.state === "offline" ? "offline" : "unknown", perceptionChannelStateLabel(channel.state))}</div>`).join("")}</div>`
    : showBotActivity ? '<div class="perception-empty">暂未配置 Bot 通道。</div>' : '<div class="perception-empty">Bot 通道观察已关闭。</div>';
  const event = snapshot?.lastEvent;
  const eventMarkup = !enabled
    ? '<small class="perception-event__empty">感知关闭时不接收新的状态事件。</small>'
    : event
      ? `<strong>${escapeHtml(perceptionEventSourceLabel(event))}</strong>${perceptionStatusBadge(perceptionPhaseTone(event.phase), perceptionPhaseLabel(event.phase))}<small>${escapeHtml(event.detail)} · ${escapeHtml(perceptionObservedLabel(event.occurredAt))}</small>`
      : '<small class="perception-event__empty">等待第一条状态变化。</small>';
  return `
    <section id="perception-observation" class="perception-observation" aria-live="polite">
      <div class="perception-observation__header"><div><strong>当前状态观察</strong></div><span>${observing ? "实时更新" : "已暂停"}</span></div>
      ${aggregateMarkup}
      ${runMarkup}
       <div class="perception-agent-section"><div class="perception-agent-section__header"><strong>本机 Agent</strong></div><div class="perception-agent-list">${enabled ? renderPerceptionAgentList(settings, snapshot, snapshot?.agentTasks ?? agentTaskSnapshot, showAgentRuntime, showTaskActivity) : '<div class="perception-empty">感知未开启</div>'}</div></div>
      ${channelMarkup}
      <div class="perception-event"><span>最近事件</span><div>${eventMarkup}</div></div>
    </section>
  `;
}

function renderPerceptionTrigger(settings: PetSettings): string {
  const enabled = settings.petPerception.enabled && !dirty;
  const run = petPerceptionSnapshot?.lastRun;
  const runRunning = run?.state === "running";
  const disabled = !enabled || perceptionTriggerRunning || runRunning ? "disabled" : "";
  const status = perceptionTriggerMessage
    || (dirty ? "请先保存感知开关，再发起协同感知" : run?.detail ?? "输入一个信号，让所有已加入且启用的 Agent 共同处理");
  return `
    <section id="perception-trigger" class="perception-trigger">
      <div class="perception-trigger__header"><div><strong>发起一次协同感知</strong></div><span class="perception-trigger__scope">${settings.agentConfigs.filter((config) => config.enabled).length} 个 Agent</span></div>
      <textarea id="perception-signal" maxlength="320" rows="2"></textarea>
      <div class="perception-trigger__footer"><small id="perception-trigger-status" aria-live="polite">${escapeHtml(status)}</small><button id="trigger-perception" class="settings-secondary settings-secondary--compact" type="button" ${disabled}>${perceptionTriggerRunning || runRunning ? "感知处理中…" : "让 Agent 参与感知"}</button></div>
    </section>
  `;
}

function renderPetPerceptionPage(settings: PetSettings): string {
  const perception = settings.petPerception;
  return `
    <div class="settings-page settings-page--perception">
      ${renderPerceptionPageHeading("桌宠感知", "让小卡拉米感知环境，主动陪伴你")}
      ${renderPerceptionStatusCard(settings)}
      <div class="perception-section-title">互动方式</div>
      ${renderPerceptionCard([
        { icon: "bell", iconColor: "purple", title: "主动陪伴", description: "什么时候小卡拉米主动找你", value: "智能推荐", onClick: "companion" },
        { icon: "target", iconColor: "green", title: "感知内容", description: "小卡拉米可以关注什么内容", value: "聊天 / 任务 / 应用状态", onClick: "advanced" },
        { icon: "interaction", iconColor: "blue", title: "互动表现", description: "小卡拉米如何回应你", value: "动作 + 气泡", onClick: "interaction" },
        { icon: "feedback", iconColor: "orange", title: "任务反馈", description: "任务完成后的反馈方式", value: "简要反馈", onClick: "task-feedback" },
      ], "perception-card--stacked")}
      <div class="perception-section-title">桌宠表现</div>
      ${renderPerceptionCard([
        { icon: "location", iconColor: "orange", title: "位置与停靠", description: "小卡拉米停在哪里", value: "桌面右下角", onClick: "position" },
        { icon: "move", iconColor: "blue", title: "移动与跟随", description: "是否允许移动和跟随", value: "允许移动", onClick: "movement" },
        { icon: "status-light", iconColor: "yellow", title: "状态灯", description: "桌宠状态提示方式", value: petStatusLightMotionLabel(perception.statusLightMotion ?? "static"), onClick: "status-light" },
      ], "perception-card--stacked")}
      <button id="open-perception-advanced" class="perception-advanced-entry" type="button">
        ${renderIconBadge("advanced", "purple")}
        <span class="perception-item__copy"><strong>高级设置</strong><small>自定义更详细的感知规则与提醒方式</small></span>
        <span class="perception-item__arrow" aria-hidden="true">&rsaquo;</span>
      </button>
    </div>
  `;
}

function renderPerceptionStatusCard(settings: PetSettings): string {
  const perception = settings.petPerception;
  return `
    <section id="perception-status-card" class="perception-status-card" aria-live="polite">
      <div class="perception-status-card__main">
        <div class="perception-status-card__mascot"><canvas id="perception-mascot-canvas" class="perception-mascot" width="240" height="240" aria-label="小卡拉米当前形象"></canvas></div>
        <div class="perception-status-card__copy">
          <div class="perception-status-card__title"><span id="perception-state-dot" class="perception-state-dot ${perception.enabled ? "is-on" : ""}"></span><strong id="perception-state-title">${perception.enabled ? "感知已开启" : "感知未开启"}</strong></div>
          <p id="perception-state-description">${perception.enabled ? "小卡拉米正在了解你的工作状态，\n会在合适的时候主动陪伴你。" : "开启后，小卡拉米会在合适的时候主动陪伴你。"}</p>
        </div>
        <label class="perception-status-switch" aria-label="开启桌宠感知">
          <input data-setting="petPerception" data-perception-setting="enabled" type="checkbox" ${perception.enabled ? "checked" : ""} />
          <span class="perception-status-switch__track"><span></span></span>
        </label>
      </div>
      <div id="perception-capabilities" class="perception-capabilities">
        ${renderPerceptionCapabilities(settings)}
      </div>
    </section>
  `;
}

function renderPerceptionCapabilities(settings: PetSettings): string {
  const perception = settings.petPerception;
  return [
    { icon: "chat" as IconBadgeName, color: "blue" as SettingCardIconColor, label: "聊天", enabled: perception.botActivity },
    { icon: "task" as IconBadgeName, color: "blue" as SettingCardIconColor, label: "任务", enabled: perception.taskActivity },
    { icon: "app-status" as IconBadgeName, color: "blue" as SettingCardIconColor, label: "应用状态", enabled: perception.agentRuntime },
    { icon: "memory" as IconBadgeName, color: "purple" as SettingCardIconColor, label: "自动记忆", enabled: autoMemoryEnabled },
  ].map((item) => `
    <div class="perception-capability">
      ${renderIconBadge(item.icon, item.color)}
      <strong>${item.label}</strong>
      ${renderPerceptionCheckStatus(item.enabled)}
    </div>
  `).join("");
}

function perceptionAdvancedSourceOptions(settings: PetSettings): string {
  const sourceScope = perceptionSourceScope(settings);
  const labels: Record<PerceptionSourceScope, string> = {
    none: "暂不感知",
    task: "任务",
    "task-agent": "任务 + 应用状态",
    "task-bot": "聊天 + 任务",
    all: "聊天 / 任务 / 应用状态",
    custom: "自定义来源",
  };
  return Object.entries(labels).map(([value, label]) => `<option value="${value}" ${sourceScope === value ? "selected" : ""}>${label}</option>`).join("");
}

function renderPerceptionAdvancedItem(settings: PetSettings, props: PerceptionItemProps, sourceControl = false): string {
  if (!sourceControl) return renderPerceptionItem(props);
  return renderPerceptionItem({
    ...props,
    control: `<span class="perception-item__select-wrap"><select class="perception-advanced-select" data-setting="petPerception" data-perception-setting="sourceScope" aria-label="观察来源">${perceptionAdvancedSourceOptions(settings)}</select><span class="perception-item__arrow" aria-hidden="true">&rsaquo;</span></span>`,
  });
}

function renderPerceptionRuleSection(title: string, icon: IconBadgeName, color: SettingCardIconColor, items: string): string {
  return `<section class="perception-rule-section"><div class="perception-rule-title">${renderIconBadge(icon, color)}<strong>${title}</strong></div><div class="perception-card perception-card--stacked">${items}</div></section>`;
}

function renderPetPerceptionAdvancedPage(settings: PetSettings): string {
  const perception = settings.petPerception;
  const feedbackMode = perceptionFeedbackMode(settings);
  return `
    <div class="settings-page settings-page--perception-advanced">
      ${renderPerceptionPageHeading("高级设置", "自定义更详细的感知规则与提醒方式")}
      <div class="perception-advanced-divider"></div>
      ${renderPerceptionRuleSection("感知规则", "eye", "purple", [
        renderPerceptionAdvancedItem(settings, { icon: "eye", iconColor: "purple", title: "观察来源", description: "选择小卡拉米可以观察的内容来源", value: "" }, true),
        renderPerceptionItem({ icon: "filter", iconColor: "purple", title: "关键词过滤", description: "忽略包含指定关键词的内容", value: "未设置" }),
        renderPerceptionItem({ icon: "sensitive", iconColor: "orange", title: "敏感内容处理", description: "遇到敏感内容时的处理方式", value: "智能处理" }),
      ].join(""))}
      ${renderPerceptionRuleSection("提醒规则", "frequency", "blue", [
        renderPerceptionItem({ icon: "frequency", iconColor: "blue", title: "主动提醒频率", description: "小卡拉米主动找你的频率", value: perception.longTaskReplyEnabled ? "智能调节" : "暂不开启" }),
        renderPerceptionItem({ icon: "event", iconColor: "green", title: "重要事件提醒", description: "哪些事件需要立即提醒你", value: perception.taskCompletionNotice ? "已开启" : "未开启" }),
        renderPerceptionItem({ icon: "quiet", iconColor: "yellow", title: "安静时段", description: "在指定时间段内减少打扰", value: "未设置" }),
      ].join(""))}
      ${renderPerceptionRuleSection("反馈规则", "rule", "purple", [
        renderPerceptionItem({ icon: "rule", iconColor: "purple", title: "提醒规则", description: "满足什么条件时发送陪伴提醒", value: "默认规则" }),
        renderPerceptionItem({ icon: "content", iconColor: "blue", title: "反馈内容", description: "反馈中包含哪些信息", value: feedbackMode === "full" ? "进度 + 结果" : perceptionFeedbackModeLabel(feedbackMode) }),
        renderPerceptionItem({ icon: "display", iconColor: "purple", title: "展示方式", description: "如何向你展示陪伴反馈", value: perception.bubbleFeedback ? "气泡通知" : "仅动作" }),
      ].join(""))}
      <aside class="perception-tip-card">
        ${renderIconBadge("tip", "purple")}
        <div><strong>小贴士</strong><p>高级设置适合有特殊需求的用户，建议优先使用默认设置，以获得最佳体验。</p></div>
      </aside>
    </div>
  `;
}

function renderPerceptionSelect(setting: string, options: Array<[string, string]>, selected: string, disabled = false): string {
  return `<select class="agent-select perception-detail-select" data-setting="petPerception" data-perception-setting="${escapeHtml(setting)}" aria-label="${escapeHtml(setting)}" ${disabled ? "disabled" : ""}>${options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
}

function renderPerceptionDetailPage(settings: PetSettings): string {
  const perception = settings.petPerception;
  const disabled = !perception.enabled;
  const detailMeta: Record<PerceptionDetail, { title: string; description: string; section: string }> = {
    companion: { title: "主动陪伴", description: "设置小卡拉米什么时候主动找你", section: "提醒方式" },
    interaction: { title: "互动表现", description: "设置小卡拉米如何回应你", section: "回应方式" },
    "task-feedback": { title: "任务反馈", description: "设置任务完成后的反馈方式", section: "反馈方式" },
    position: { title: "位置与停靠", description: "看看小卡拉米停在哪里", section: "停靠说明" },
    movement: { title: "移动与跟随", description: "了解小卡拉米如何陪着你移动", section: "移动说明" },
    "status-light": { title: "状态灯", description: "设置桌宠状态提示方式", section: "提示方式" },
  };
  const meta = detailMeta[perceptionDetail];
  let body = "";
  if (perceptionDetail === "companion") {
    body = renderPerceptionCard([
      { icon: "frequency", iconColor: "purple", title: "主动提醒频率", description: "小卡拉米主动找你的频率", value: perception.longTaskReplyEnabled ? "智能调节" : "暂不开启", control: renderPerceptionSelect("digestMode", [["on", "智能调节"], ["off", "暂不开启"]], perceptionDigestMode(settings), disabled) },
      { icon: "event", iconColor: "green", title: "重要事件提醒", description: "重要任务完成时及时告诉你", value: perception.taskCompletionNotice ? "已开启" : "未开启", control: `<label class="perception-inline-switch"><input data-setting="petPerception" data-perception-setting="taskCompletionNotice" type="checkbox" ${perception.taskCompletionNotice ? "checked" : ""} ${disabled ? "disabled" : ""} /><span class="cute-switch__track"></span></label>` },
    ], "perception-card--stacked");
  } else if (perceptionDetail === "interaction" || perceptionDetail === "task-feedback") {
    body = renderPerceptionCard([
      { icon: "interaction", iconColor: "blue", title: perceptionDetail === "interaction" ? "互动表现" : "任务反馈", description: perceptionDetail === "interaction" ? "小卡拉米如何回应你" : "任务处理完成后如何回应", value: perceptionFeedbackModeLabel(perceptionFeedbackMode(settings)), control: renderPerceptionSelect("feedbackMode", [["full", "动作 + 气泡"], ["action", "仅动作"], ["bubble", "仅气泡"], ["silent", "静默"]], perceptionFeedbackMode(settings), disabled) },
      { icon: "display", iconColor: "purple", title: "展示方式", description: "如何向你展示陪伴反馈", value: perception.bubbleFeedback ? "气泡通知" : "仅动作" },
    ], "perception-card--stacked");
  } else if (perceptionDetail === "status-light") {
    const statusLight = perception.statusLightMotion ?? "static";
    body = renderPerceptionCard([
      { icon: "status-light", iconColor: "yellow", title: "状态灯模式", description: "选择状态灯停留和移动方式", value: petStatusLightMotionLabel(statusLight), control: renderPerceptionSelect("statusLightMotion", [["static", "固定左上角"], ["orbit", "环绕桌宠"], ["square", "方形巡航"], ["wingman", "僚机跟随"]], statusLight, disabled) },
    ], "perception-card--stacked");
  } else if (perceptionDetail === "position") {
    body = renderPerceptionCard([
      { icon: "location", iconColor: "orange", title: "当前停靠", description: "拖动桌宠窗口即可调整停靠位置", value: "跟随当前桌面位置" },
      { icon: "personalization", iconColor: "purple", title: "陪伴时置顶", description: "让小卡拉米保持在其他窗口上方", value: settings.alwaysOnTop ? "已开启" : "未开启" },
    ], "perception-card--stacked");
  } else {
    body = renderPerceptionCard([
      { icon: "move", iconColor: "blue", title: "移动与跟随", description: "桌宠窗口支持拖动和自由停靠", value: "允许移动" },
      { icon: "tip", iconColor: "purple", title: "小提示", description: "按住小卡拉米即可把它移动到喜欢的位置", value: "随时可调整" },
    ], "perception-card--stacked");
  }
  return `
    <div class="settings-page settings-page--perception-detail">
      ${renderPerceptionPageHeading(meta.title, meta.description)}
      <div class="perception-section-title">${meta.section}</div>
      ${body}
    </div>
  `;
}


function renderPetStyleCard(style: PetStyle, settings: PetSettings): string {
  const isActive = settings.activePetStyleId === style.id;
  const isEditing = petStyleEditorId === style.id;
  const isRenaming = petStyleRenameId === style.id;
  const sourceLabel = style.source === "builtin" ? "内置风格" : "本机导入";
  const nameMarkup = isRenaming
    ? '<input class="pet-style-card__name-input" data-pet-style-name-input="' + escapeHtml(style.id) + '" value="' + escapeHtml(style.name) + '" maxlength="32" aria-label="风格名称" />'
    : '<strong>' + escapeHtml(style.name) + '</strong>';
  return [
    '<article class="pet-style-card ' + (isActive ? 'is-active ' : '') + (isEditing ? 'is-editing' : '') + '" data-pet-style-card="' + escapeHtml(style.id) + '">',
    isRenaming
      ? '  <div class="pet-style-card__select pet-style-card__select--renaming">'
      : '  <button class="pet-style-card__select" type="button" data-edit-pet-style="' + escapeHtml(style.id) + '">',
    '    <span class="pet-style-card__icon" aria-hidden="true">' + (style.source === "builtin" ? 'P' : '✦') + '</span>',
    '    <span class="pet-style-card__copy">' + nameMarkup + '<small>' + sourceLabel + ' · ' + petStyleStateCount(style) + ' 个状态</small></span>',
    isRenaming ? '  </div>' : '  </button>',
    '  <div class="pet-style-card__actions">',
    isActive ? '<span class="pet-style-card__active">使用中</span>' : '<button class="settings-secondary settings-secondary--compact pet-style-card__apply" type="button" data-apply-pet-style="' + escapeHtml(style.id) + '">应用</button>',
    style.source === "imported"
      ? isRenaming
        ? '<button class="settings-secondary settings-secondary--compact" type="button" data-confirm-rename-pet-style="' + escapeHtml(style.id) + '">保存</button><button class="pet-style-card__remove" type="button" data-cancel-rename-pet-style="' + escapeHtml(style.id) + '" aria-label="取消改名">×</button>'
        : '<button class="settings-secondary settings-secondary--compact" type="button" data-rename-pet-style="' + escapeHtml(style.id) + '">改名</button>'
      : '',
    style.source === "imported" ? '<button class="pet-style-card__remove" type="button" data-remove-pet-style="' + escapeHtml(style.id) + '" aria-label="删除 ' + escapeHtml(style.name) + '" title="删除风格">×</button>' : '',
    '  </div>',
    '</article>',
  ].join("");
}

function renderPetStyleStateCard(style: PetStyle, meta: { id: PetState; name: string }): string {
  const configured = isPetStyleStateConfigured(style, meta.id);
  const actionLabel = !configured ? "导入" : "替换";
  return [
    '<article class="pet-style-state-card ' + (configured ? 'is-configured' : '') + '">',
    '  <span class="pet-style-state-card__mark" aria-hidden="true">' + meta.name.slice(0, 1) + '</span>',
    '  <span class="pet-style-state-card__copy"><strong>' + meta.name + '</strong></span>',
    '  <span class="pet-style-state-card__status">' + (style.source === "builtin" ? '内置状态' : configured ? '已配置' : '待配置') + '</span>',
    style.source === "builtin"
      ? '<span class="pet-style-state-card__hint">默认视频</span>'
      : '<button class="settings-secondary settings-secondary--compact" type="button" data-import-pet-style-state="' + escapeHtml(style.id) + '" data-pet-style-state="' + meta.id + '" ' + (importingPetStyle ? 'disabled' : '') + '>' + (importingPetStyle ? '处理中…' : actionLabel) + '</button>',
    '</article>',
  ].join("");
}

function renderCustomPetStyleStateCard(style: PetStyle, state: { id: string; name: string; fileName: string }): string {
  return [
    '<article class="pet-style-state-card pet-style-state-card--custom is-configured">',
    '  <span class="pet-style-state-card__mark" aria-hidden="true">✦</span>',
    '  <span class="pet-style-state-card__copy"><strong>' + escapeHtml(state.name) + '</strong><small>自定义状态 · ' + escapeHtml(state.fileName) + '</small></span>',
    '  <span class="pet-style-state-card__status">已添加</span>',
    '  <button class="pet-style-card__remove" type="button" data-remove-custom-pet-state="' + escapeHtml(style.id) + '" data-pet-style-custom-state="' + escapeHtml(state.id) + '" aria-label="删除 ' + escapeHtml(state.name) + '">×</button>',
    '</article>',
  ].join("");
}

function renderCustomPetStateForm(): string {
  if (!customStateFormOpen) return "";
  return [
    '<div class="pet-style-custom-state-form" role="group" aria-label="添加自定义宠物状态">',
    '  <label class="pet-style-custom-state-form__field">',
    '    <span>状态名称</span>',
    '    <input id="custom-pet-state-name" type="text" maxlength="24" autocomplete="off" />',
    '  </label>',
    '  <div class="pet-style-custom-state-form__actions">',
    '    <button id="cancel-custom-pet-state" class="settings-secondary settings-secondary--compact" type="button">取消</button>',
    '    <button id="confirm-custom-pet-state" class="settings-secondary settings-secondary--compact" type="button">选择视频</button>',
    '  </div>',
    '</div>',
  ].join("");
}

function renderPetStyleFeedback(): string {
  if (!petStyleMessage) return '<p id="pet-style-feedback" class="pet-style-settings__message" hidden aria-live="polite"></p>';
  return `<p id="pet-style-feedback" class="pet-style-settings__message is-${petStyleMessageTone}" role="status" aria-live="polite">${escapeHtml(petStyleMessage)}</p>`;
}

function renderPetStylePageBody(settings: PetSettings): string {
  const styles = settings.petStyles?.length ? settings.petStyles : [{ id: "default-penguin", name: "默认企鹅", source: "builtin" as const }];
  const editor = styles.find((style) => style.id === petStyleEditorId) ?? styles.find((style) => style.id === settings.activePetStyleId) ?? styles[0];
  if (!editor) return '<div class="settings-empty">暂无宠物风格</div>';
  return [
    '<section class="pet-style-library">',
    '  <div class="pet-style-library__header"><div><strong>我的风格</strong></div><span>' + styles.length + ' 套</span></div>',
    '  <div class="pet-style-library__list">' + styles.map((style) => renderPetStyleCard(style, settings)).join("") + '</div>',
    '</section>',
    '<section class="pet-style-editor" aria-label="编辑宠物状态">',
    '  <div class="pet-style-editor__header"><div><strong>' + escapeHtml(editor.name) + '</strong><small>' + (editor.source === "builtin" ? '内置状态不可替换，可在下方添加新状态' : '导入视频后会自动命名并加入播放循环') + '</small></div><span>' + petStyleStateCount(editor) + ' 个状态</span></div>',
    '  <div class="pet-style-state-list">' + PET_STYLE_STATE_META.map((meta) => renderPetStyleStateCard(editor, meta)).join("") + (editor.customStates ?? []).map((state) => renderCustomPetStyleStateCard(editor, state)).join("") + '<button id="add-custom-pet-state" class="pet-style-add-state" type="button" ' + (importingPetStyle || customStateFormOpen ? 'disabled' : '') + '><span aria-hidden="true">＋</span><span><strong>添加自定义状态</strong></span></button>' + renderCustomPetStateForm() + '</div>',
    '</section>',
  ].join("");
}

function renderPetStylePage(settings: PetSettings): string {
  return [
    '<div class="settings-page settings-page--pet-styles">',
    '  <div class="settings-title-row"><div><div class="settings-page-kicker">PET STYLE</div><h1>宠物风格</h1></div><button id="import-pet-style" class="settings-secondary settings-secondary--compact" type="button" ' + (importingPetStyle ? 'disabled' : '') + '>' + (importingPetStyle ? '导入中…' : '导入风格') + '</button></div>',
    renderPetStyleFeedback(),
    '  <div id="pet-style-page-body">' + renderPetStylePageBody(settings) + '</div>',
    '</div>',
  ].join("");
}

function renderAppearancePage(settings: PetSettings): string {
  return `
    <div class="settings-page settings-page--appearance">
      <div class="settings-title-row">
        <div><div class="settings-page-kicker">APPEARANCE</div><h1>外观</h1></div>
        <span class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待保存" : "已保存"}</span>
      </div>
      <p class="settings-page-intro">选择桌宠设置中心的主题和宠物风格。</p>
      <div class="settings-section-title">外观主题</div>
      <section class="settings-surface-card settings-surface-card--padded">${renderThemePicker(settings.theme)}</section>
      <div class="settings-section-title">宠物风格</div>
      ${renderPetStylePicker(settings)}
      <button id="settings-save" class="settings-done" type="button" ${saving || !dirty ? "disabled" : ""}>${saving ? "保存中…" : "保存"}</button>
    </div>
  `;
}

function renderPersonalizationPage(settings: PetSettings): string {
  const selectedReplyStyle = replyStyle === "balanced" ? "warm" : replyStyle;
  const replyOptions = ([
    ["warm", "温柔"],
    ["concise", "简洁"],
    ["detailed", "详细"],
  ] as Array<[ReplyStyle, string]>)
    .map(([value, label]) => `<option value="${value}" ${selectedReplyStyle === value ? "selected" : ""}>${label}</option>`)
    .join("");
  return `
    <div class="settings-page settings-page--personalization">
      <div class="settings-title-row">
        <div><div class="settings-page-kicker">PERSONALIZATION</div><h1>个性化</h1></div>
        <span class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待保存" : "已保存"}</span>
      </div>
      <p class="settings-page-intro">调整桌宠的称呼、表达方式和陪伴习惯。</p>

      <div class="settings-section-title">称呼</div>
      <section class="settings-surface-card personalization-callname-card" aria-label="桌宠称呼设置">
        <div class="settings-surface-card__heading"><span class="setting-card__icon setting-card__icon--purple" aria-hidden="true">◉</span><div><strong>称呼</strong><small>这些称呼会用于日常对话。</small></div></div>
        <div class="pet-callname-card__fields">
          <label class="pet-callname-field"><span>桌宠</span><input data-setting="petName" type="text" maxlength="24" value="${escapeHtml(settings.petName)}" autocomplete="off" /></label>
          <label class="pet-callname-field"><span>主人</span><input data-setting="userName" type="text" maxlength="24" value="${escapeHtml(settings.userName)}" autocomplete="off" /></label>
        </div>
      </section>

      <div class="settings-section-title">回复风格</div>
      <section class="settings-surface-card personalization-style-card">
        <div class="settings-surface-card__heading"><span class="setting-card__icon setting-card__icon--blue" aria-hidden="true">文</span><div><strong>回复风格</strong><small>选择桌宠说话时更接近你的方式。</small></div></div>
        <select id="personalization-reply-style" class="agent-select personalization-select" data-personalization-setting="replyStyle" aria-label="回复风格">${replyOptions}</select>
      </section>

      <div class="settings-section-title">互动偏好</div>
      <section class="settings-surface-card settings-surface-card--preferences personalization-preferences-card">
        <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>陪伴时始终置顶</strong><small>让桌宠始终出现在其他窗口上方</small></span><span class="cute-switch"><input data-setting="alwaysOnTop" type="checkbox" ${settings.alwaysOnTop ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
        <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>消息气泡</strong><small>显示桌宠的聊天和提醒气泡</small></span><span class="cute-switch"><input data-setting="showWeChatBubbles" type="checkbox" ${settings.showWeChatBubbles ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
        <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>处理中提示</strong><small>桌宠思考或处理任务时显示提示</small></span><span class="cute-switch"><input data-setting="showThinkingBubbles" type="checkbox" ${settings.showThinkingBubbles ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
      </section>

      <button id="settings-save" class="settings-done" type="button" ${saving || !dirty ? "disabled" : ""}>${saving ? "保存中…" : "保存"}</button>
    </div>
  `;
}

function renderHome(settings: PetSettings): string {
  const saveLabel = saving ? "保存中…" : "保存";
  const saveDisabled = saving || !dirty ? "disabled" : "";
  const accountCount = settings.wechatAccounts.length + settings.qqAccounts.length + settings.feishuAccounts.length + settings.dingtalkAccounts.length;
  return `
    <div class="settings-page settings-page--home">
      <div class="settings-title-row"><div><div class="settings-page-kicker">SETTINGS</div><h1>设置</h1></div></div>
      <div class="home-main-column">
          <div class="settings-section-title">外观</div>
          ${renderSettingCardCompact({ id: "open-appearance-settings", icon: "sparkle", iconColor: "purple", title: "外观主题", description: "主题、模式和桌宠风格" })}

          <div class="settings-section-title">个性化</div>
          ${renderSettingCardCompact({ id: "open-personalization", icon: "personalization", iconColor: "purple", title: "个性化", description: "称呼、回复风格和互动偏好" })}

          <div class="settings-section-title">机器人中心</div>
          ${renderSettingCardCompact({ id: "open-bot-center", icon: "bots", iconColor: "blue", title: "机器人中心", description: "管理已连接的机器人账号", badge: accountCount > 0 ? `${accountCount} 个账号` : "未配置", ariaLabel: "打开机器人中心" })}

          <div class="settings-section-title">AI 能力</div>
          ${renderSettingCardCompact({ id: "open-agent-config", icon: "agent", iconColor: "purple", title: "AI Agent", description: "Agent 模型与能力配置" })}
          ${renderSettingCardCompact({ id: "open-auto-memory", icon: "memory", iconColor: "green", title: "自动记忆", description: "桌宠会自动学习重要信息", badge: autoMemoryEnabled ? "已开启" : "已关闭" })}

          <div class="settings-section-title">系统</div>
          ${renderSettingCardCompact({ id: "open-pet-perception", icon: "pet-perception", iconColor: "orange", title: "桌宠感知", description: "感知设置与陪伴规则" })}
          ${renderSettingCardCompact({ id: "open-diagnostics", icon: "diagnostics", iconColor: "yellow", title: "诊断中心", description: "运行状态与问题诊断" })}
          ${renderSettingCardCompact({ id: "open-data-settings", icon: "privacy", iconColor: "blue", title: "数据与隐私", description: "数据管理与隐私设置" })}
          ${renderSettingCardCompact({ id: "open-about-settings", icon: "info", iconColor: "gray", title: "关于", description: "版本信息与帮助" })}

          ${renderFirstUseGuide()}

          <div class="settings-section-title">更多偏好</div>
          <section class="settings-surface-card settings-surface-card--preferences">
            <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>始终置顶</strong></span><span class="cute-switch"><input data-setting="alwaysOnTop" type="checkbox" ${settings.alwaysOnTop ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
            <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>聊天记录</strong></span><span class="cute-switch"><input data-setting="saveChatHistory" type="checkbox" ${settings.saveChatHistory ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
            <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>消息气泡总开关</strong></span><span class="cute-switch"><input data-setting="showWeChatBubbles" type="checkbox" ${settings.showWeChatBubbles ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
            <label class="setting-card-compact setting-card-compact--static"><span class="setting-card__copy"><strong>处理中提示</strong></span><span class="cute-switch"><input data-setting="showThinkingBubbles" type="checkbox" ${settings.showThinkingBubbles ? "checked" : ""} /><span class="cute-switch__track"></span></span></label>
          </section>
          <button id="settings-save" class="settings-done" type="button" ${saveDisabled}>${saveLabel}</button>
      </div>
    </div>
  `;
}

function aboutVersionLabel(): string {
  return diagnosticAppVersion || "当前版本读取中";
}

function renderAboutUpdateCard(): string {
  const result = updateResult;
  const detail = updateChecking
    ? "正在读取更新清单…"
    : updateMessage || result?.detail || "尚未检查";
  const versionSummary = result?.latestVersion
    ? `当前 v${escapeHtml(result.currentVersion)} · 最新 v${escapeHtml(result.latestVersion)}`
    : `当前 v${escapeHtml(aboutVersionLabel())}`;
  const assetSummary = result?.assets.length
    ? result.assets.map((asset) => `${asset.kind === "nsis" ? "安装包" : "便携包"} · SHA-256 ${asset.sha256}`).join("\n")
    : "";
  return `
    <section id="about-update-card" class="about-card about-card--update">
      <div class="about-card__header">
        <div><strong>程序升级</strong><small id="about-update-version">${versionSummary}</small></div>
        <button id="check-updates" class="settings-secondary settings-secondary--compact" type="button" ${updateChecking ? "disabled" : ""}>${updateChecking ? "检查中…" : "检查更新"}</button>
      </div>
      <div id="about-update-status" class="about-card__status ${result?.state === "available" ? "is-highlight" : ""}">
        <span id="about-update-detail">${escapeHtml(detail)}</span>
        ${result?.releasePageUrl ? `<button id="open-update-download" class="settings-secondary settings-secondary--compact" type="button">打开下载页</button>` : ""}
      </div>
      <ul id="about-update-notes" class="about-card__notes" ${result?.releaseNotes.length ? "" : "hidden"}>${result?.releaseNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("") ?? ""}</ul>
      <code id="about-update-checksum" class="about-card__checksum" ${assetSummary ? "" : "hidden"}>${escapeHtml(assetSummary)}</code>
    </section>
  `;
}

function renderAbout(settings: PetSettings): string {
  const accountCount = settings.wechatAccounts.length + settings.qqAccounts.length + settings.feishuAccounts.length + settings.dingtalkAccounts.length;
  const visibleAgentCount = agentConfigs(settings).length;
  return `
    <div class="settings-page settings-page--about">
      <div class="settings-title-row">
        <div><div class="settings-page-kicker">ABOUT</div><h1>关于</h1></div>
        <span class="settings-save-state">${escapeHtml(aboutVersionLabel())}</span>
      </div>
      <section class="about-hero" aria-label="应用信息">
        <span class="about-hero__mark" aria-hidden="true">✦</span>
        <div class="about-hero__copy">
          <strong>Penguin Desktop Pet</strong>
        </div>
        <span class="about-hero__version">v${escapeHtml(aboutVersionLabel())}</span>
      </section>

      ${renderAboutUpdateCard()}

      <section class="about-card about-card--summary" aria-label="当前环境">
        <div class="about-card__eyebrow">当前环境</div>
        <div class="about-summary-grid">
          <div class="about-summary-item"><span>Agent 配置</span><strong>${visibleAgentCount} 个</strong></div>
          <div class="about-summary-item"><span>机器人账号</span><strong>${accountCount} 个</strong></div>
        </div>
      </section>

    </div>
  `;
}

function renderDiagnostics(settings: PetSettings): string {
  const updatedLabel = diagnosticsLoading
    ? "正在刷新…"
    : diagnosticAppVersion
      ? `应用 v${escapeHtml(diagnosticAppVersion)}${diagnosticChannelStatuses.length > 0 ? ` · ${diagnosticChannelStatuses.length} 个通道` : ""}`
      : "尚未刷新";
  return `
    <div class="settings-page settings-page--diagnostics">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">DIAGNOSTICS</div>
          <h1>诊断中心</h1>
        </div>
        <span id="diagnostics-summary" class="settings-save-state">${updatedLabel}</span>
      </div>
      <div class="settings-page-actions diagnostics-actions">
        <button id="refresh-diagnostics" class="settings-secondary" type="button" ${diagnosticsLoading ? "disabled" : ""}>${diagnosticsLoading ? "刷新中…" : "刷新诊断"}</button>
        <button id="copy-diagnostics" class="settings-secondary" type="button" ${diagnosticsCopied ? "disabled" : ""}>${diagnosticsCopied ? "已复制" : "复制诊断摘要"}</button>
      </div>
      <small id="diagnostics-message" class="diagnostics-message" ${diagnosticsMessage ? "" : "hidden"}>${escapeHtml(diagnosticsMessage)}</small>

      <div class="settings-section-title">Agent</div>
      <section class="diagnostics-list diagnostics-agent-list">
        ${renderDiagnosticsAgents(settings)}
      </section>

      <div class="settings-section-title">Bot 通道</div>
      <section class="diagnostics-list diagnostics-channel-list">
        ${renderDiagnosticsChannels(settings)}
      </section>

    </div>
  `;
}

function dataPresenceLabel(present: boolean): string {
  return present ? "已发现" : "未发现";
}

function renderLocalDataSummary(): string {
  if (dataSummaryLoading) return `<div class="data-summary-empty">正在读取本机数据范围…</div>`;
  if (!localDataSummary) return `<div class="data-summary-empty">暂无数据</div>`;
  const summary = localDataSummary;
  return `
    <div class="data-summary-row"><span>应用托管文件</span><strong>${summary.managedDataFileCount} 个</strong></div>
    <div class="data-summary-row"><span>应用设置</span><strong>${dataPresenceLabel(summary.settingsFilePresent)}</strong></div>
    <div class="data-summary-row"><span>通道聊天历史</span><strong>${summary.history.channel.messageCount} 条消息 / ${summary.history.channel.conversationCount} 个会话 · ${dataPresenceLabel(summary.history.channelFilePresent)}</strong></div>
    <div class="data-summary-row"><span>微信聊天历史</span><strong>${summary.history.wechat.messageCount} 条消息 / ${summary.history.wechat.conversationCount} 个会话 · ${dataPresenceLabel(summary.history.wechatFilePresent)}</strong></div>
    <div class="data-summary-row"><span>加密凭据存储</span><strong>${[summary.credentials.wechatFilePresent, summary.credentials.qqFilePresent, summary.credentials.feishuFilePresent].filter(Boolean).length} 个文件 · ${summary.credentials.systemEncryptionAvailable ? "系统加密可用" : "系统加密不可用"}</strong></div>
    <div class="data-summary-row"><span>微信事件日志</span><strong>${dataPresenceLabel(summary.eventLogs.wechatFilePresent)}</strong></div>
    <div class="data-summary-row"><span>微信会话配置</span><strong>${summary.externalFiles.configuredWeChatSessionCount} 个；路径和内容不展示</strong></div>
  `;
}

function renderDataPage(): string {
  const historyCount = (localDataSummary?.history.channel.messageCount ?? 0) + (localDataSummary?.history.wechat.messageCount ?? 0);
  const managedDataFileCount = localDataSummary?.managedDataFileCount ?? 0;
  return `
    <div class="settings-page settings-page--data">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">DATA & PRIVACY</div>
          <h1>数据与隐私</h1>
        </div>
        <span class="settings-save-state">只读盘点</span>
      </div>
      <div class="settings-page-actions data-actions">
        <button id="refresh-data-summary" class="settings-secondary" type="button" ${dataSummaryLoading ? "disabled" : ""}>${dataSummaryLoading ? "盘点中…" : "刷新盘点"}</button>
        <button id="export-data-summary" class="settings-secondary" type="button" ${exportingDataSummary ? "disabled" : ""}>${exportingDataSummary ? "导出中…" : "导出数据摘要"}</button>
      </div>
      <small id="data-summary-message" class="data-summary-message" ${dataSummaryMessage ? "" : "hidden"}>${escapeHtml(dataSummaryMessage)}</small>

      <div class="settings-section-title">本机数据范围</div>
      <section class="data-summary-list" aria-live="polite">
        ${renderLocalDataSummary()}
      </section>

      <div class="settings-section-title">清理操作</div>
      <section class="data-actions-list">
        <button id="clear-chat-history" class="settings-secondary settings-secondary--wide" type="button" ${clearingChatHistory || historyCount === 0 ? "disabled" : ""}>
          ${clearingChatHistory ? "正在清空…" : historyCount > 0 ? "清空聊天历史" : "暂无聊天历史"}
        </button>
        <button id="delete-managed-data" class="settings-secondary settings-secondary--wide" type="button" ${deletingManagedData || !localDataSummary || managedDataFileCount === 0 ? "disabled" : ""}>
          ${deletingManagedData ? "正在清理并准备重启…" : managedDataFileCount > 0 ? "删除应用托管数据（重启）" : "暂无应用托管数据"}
        </button>
      </section>
    </div>
  `;
}

interface MemoryCategoryGroup {
  title: string;
  description: string;
  icon: string;
  className: string;
  entries: MemoryEntry[];
}

function memoryCategoryGroups(entries: MemoryEntry[]): MemoryCategoryGroup[] {
  return [
    { title: "项目记忆", description: "关于你正在进行的项目和目标", icon: "▰", className: "project", entries: entries.filter((entry) => entry.type === "project" || entry.type === "knowledge") },
    { title: "偏好记忆", description: "关于你的偏好和习惯", icon: "♥", className: "preference", entries: entries.filter((entry) => entry.type === "preference") },
    { title: "工作方式", description: "关于你的工作流程和风格", icon: "✦", className: "habit", entries: entries.filter((entry) => entry.type === "behavior" || entry.type === "skill" || entry.type === "user_profile" || entry.type === "temporary") },
    { title: "重要决定", description: "关于你的重要决策和选择", icon: "▮", className: "decision", entries: entries.filter((entry) => entry.type === "decision") },
  ];
}

function memoryDateLabel(entry: MemoryEntry): string {
  const timestamp = Date.parse(entry.updatedAt || entry.createdAt || "");
  if (!Number.isFinite(timestamp)) return "最近";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function renderMemoryEntry(entry: MemoryEntry): string {
  return `
    <article class="memory-entry memory-entry--friendly">
      <div class="memory-entry__copy">
        <strong>自动整理</strong>
        <p>${escapeHtml(entry.summary ?? "")}</p>
        <small>来源：自动整理 · ${memoryDateLabel(entry)}</small>
      </div>
      <button class="memory-entry__remove" data-memory-remove="${escapeHtml(entry.id)}" type="button" aria-label="删除这条记忆" title="删除">删除</button>
    </article>`;
}

function renderMemoryCategoryDetails(group: MemoryCategoryGroup): string {
  return `
    <section class="memory-category-card memory-category-card--${group.className}">
      <div class="memory-category-card__header"><span class="memory-category-card__icon" aria-hidden="true">${group.icon}</span><div><strong>${group.title}</strong><small>${group.description}</small></div><span class="memory-category-card__count">${group.entries.length}</span></div>
      <div class="memory-category-card__list">${group.entries.length ? group.entries.map(renderMemoryEntry).join("") : `<p class="memory-category-card__empty">还没有相关内容</p>`}</div>
    </section>`;
}

function renderMemoryPage(): string {
  const visibleEntries = memoryEntries.filter((entry) => entry.status === "approved" && (entry.summary?.trim() ?? "").length > 0);
  const groups = memoryCategoryGroups(visibleEntries);
  const emptyText = memoryLoading ? "正在读取…" : memoryMessage.includes("失败") ? "暂时无法读取，请稍后重试。" : "桌宠会在聊天中慢慢了解你。";
  return `
    <div class="settings-page settings-page--memory">
      <div class="settings-title-row"><div><div class="settings-page-kicker">AUTO MEMORY</div><h1>自动记忆</h1></div></div>
      <section class="memory-auto-card">
        <span class="setting-card__icon setting-card__icon--green" aria-hidden="true">✦</span>
        <div class="setting-card__copy"><strong data-auto-memory-title>${autoMemoryEnabled ? "自动记忆已开启" : "自动记忆已关闭"}</strong><small>桌宠会自动保存对未来有帮助的信息。</small></div>
        <span class="cute-switch"><input id="memory-auto-toggle" type="checkbox" data-personalization-setting="autoMemory" ${autoMemoryEnabled ? "checked" : ""} /><span class="cute-switch__track"></span></span>
      </section>
      <p class="settings-page-intro">桌宠会从对话中整理对未来有帮助的信息，不保存原始聊天。</p>
      <small id="memory-message" class="data-summary-message" ${memoryMessage ? "" : "hidden"}>${escapeHtml(memoryMessage)}</small>
      <div class="memory-known-title">桌宠已经了解</div>
      <div class="memory-stat-grid">${groups.map((group) => `<article class="memory-stat-card memory-stat-card--${group.className}"><span class="memory-category-card__icon" aria-hidden="true">${group.icon}</span><div><strong>${group.title}</strong><small>${group.description}</small></div><span class="memory-category-card__count">${group.entries.length}</span></article>`).join("")}</div>
      ${visibleEntries.length === 0 ? `<div class="memory-empty-state">${emptyText}</div>` : ""}
      ${renderSettingCardCompact({ id: "open-all-memory", icon: "memory-all", iconColor: "purple", title: "管理全部记忆", description: "查看或删除桌宠已经整理的内容" })}
    </div>`;
}

function renderMemoryAllPage(): string {
  const visibleEntries = memoryEntries.filter((entry) => entry.status === "approved" && (entry.summary?.trim() ?? "").length > 0);
  const groups = memoryCategoryGroups(visibleEntries);
  const emptyText = memoryLoading ? "正在读取…" : memoryMessage.includes("失败") ? "暂时无法读取，请稍后重试。" : "桌宠会在聊天中慢慢了解你。";
  return `
    <div class="settings-page settings-page--memory-all">
      <div class="settings-title-row"><div><div class="settings-page-kicker">ALL MEMORY</div><h1>全部记忆</h1></div></div>
      <p class="settings-page-intro">查看或删除桌宠已经整理的内容，聊天原文不会显示在这里。</p>
      <small id="memory-message" class="data-summary-message" ${memoryMessage ? "" : "hidden"}>${escapeHtml(memoryMessage)}</small>
      <div class="memory-category-grid">${visibleEntries.length ? groups.map(renderMemoryCategoryDetails).join("") : `<div class="memory-empty-state">${emptyText}</div>`}</div>
      <button id="clear-memory" class="memory-clear-link" type="button" ${(visibleEntries.length === 0 || memoryLoading) ? "disabled" : ""}>清除全部记忆</button>
    </div>`;
}

function channelStateLabel(status: ChannelStatus | null): string {
  if (!status) return "未配置";
  if (status.state === "connected") return "已连接";
  if (status.state === "connecting") return "连接中";
  if (status.state === "reconnecting") return "重连中";
  if (status.state === "failed") return "连接失败";
  return "未连接";
}

function selectQQStatus(statuses: ChannelStatus[]): ChannelStatus | null {
  const qqStatuses = statuses.filter((status) => status.platform === "qq");
  const settings = draftSettings ?? persistedSettings;
  const activeAccount = settings?.qqAccounts.find((account) => account.id === settings.activeQQAccountId)
    ?? settings?.qqAccounts[0];
  if (!activeAccount) return qqStatuses[0] ?? null;
  return qqStatuses.find((status) => status.accountId === activeAccount.appId)
    ?? qqStatuses[0]
    ?? null;
}

function selectFeishuStatus(statuses: ChannelStatus[]): ChannelStatus | null {
  const feishuStatuses = statuses.filter((status) => status.platform === "feishu");
  const settings = draftSettings ?? persistedSettings;
  const activeAccount = settings?.feishuAccounts.find((account) => account.id === settings.activeFeishuAccountId)
    ?? settings?.feishuAccounts[0];
  if (!activeAccount) return feishuStatuses[0] ?? null;
  return feishuStatuses.find((status) => status.accountId === activeAccount.appId)
    ?? feishuStatuses[0]
    ?? null;
}

function selectDingTalkStatus(statuses: ChannelStatus[]): ChannelStatus | null {
  const dingtalkStatuses = statuses.filter((status) => status.platform === "dingtalk");
  const settings = draftSettings ?? persistedSettings;
  const activeAccount = settings?.dingtalkAccounts.find((account) => account.id === settings.activeDingTalkAccountId)
    ?? settings?.dingtalkAccounts[0];
  if (!activeAccount) return dingtalkStatuses[0] ?? null;
  return dingtalkStatuses.find((status) => status.accountId === activeAccount.clientId)
    ?? dingtalkStatuses[0]
    ?? null;
}

const TASK_NOTIFICATION_MODE_LABELS: Record<TaskNotificationMode, string> = {
  detail: "详情",
  timed: "定时",
  completion: "任务完成通知",
  plan: "规划通知",
};

const PET_STATUS_LIGHT_MOTION_LABELS: Record<PetStatusLightMotion, string> = {
  static: "固定左上角",
  orbit: "环绕桌宠",
  square: "方形巡航",
  wingman: "僚机跟随",
};

const PET_STATUS_LIGHT_MOTION_HINTS: Record<PetStatusLightMotion, string> = {
  static: "状态灯固定在桌宠视觉舞台的左上角，作为默认低干扰提示。",
  orbit: "沿桌宠外圈做圆润环绕，适合持续强调正在感知。",
  square: "沿桌宠外圈做方形巡航，四个转角会短暂停留。",
  wingman: "停在桌宠侧边轻轻跟随，像一架不会遮挡桌宠的僚机。",
};

function petStatusLightMotionLabel(motion: PetStatusLightMotion): string {
  return PET_STATUS_LIGHT_MOTION_LABELS[motion] ?? PET_STATUS_LIGHT_MOTION_LABELS.static;
}

function petStatusLightMotionHint(motion: PetStatusLightMotion): string {
  return PET_STATUS_LIGHT_MOTION_HINTS[motion] ?? PET_STATUS_LIGHT_MOTION_HINTS.static;
}

function renderBotAgentBinding(
  settings: PetSettings,
  platform: "wechat" | "qq" | "feishu" | "dingtalk",
  account?: { id: string; agentId: string },
): string {
  const configs = cardAgentConfigs(settings);
  const selectedId = configs.some((config) => config.id === account?.agentId)
    ? account?.agentId
    : configs[0]?.id ?? "";
  const options = configs.map((config) => `<option value="${escapeHtml(config.id)}" ${config.id === selectedId ? "selected" : ""}>${escapeHtml(config.displayName)}${config.enabled ? "" : " · 已停用"}</option>`).join("");
  const emptyOption = configs.length > 0 ? "" : "<option>暂无已添加 Agent</option>";
  return `<section class="bot-agent-binding" aria-label="机器人 Agent 绑定"><div class="bot-agent-binding__header"><div><span class="bot-agent-binding__kicker">ONE BOT · ONE AGENT</span><strong>此机器人使用的 Agent</strong></div><span class="bot-agent-binding__badge">唯一绑定</span></div><label><span>${account ? "收到消息后固定交给" : "先添加机器人账号"}</span><select data-setting="botAgentBinding" data-bot-agent-platform="${platform}" data-bot-agent-account-id="${escapeHtml(account?.id ?? "")}" class="agent-select" ${account && configs.length > 0 ? "" : "disabled"}>${account ? `${emptyOption}${options}` : "<option>暂无可绑定账号</option>"}</select></label><small>这里只显示 Agent 配置页中已添加的 Agent。</small></section>`;
}

function renderBotTaskNotificationSettings(
  settings: PetSettings,
  platform: "wechat" | "qq" | "feishu" | "dingtalk",
  account?: { id: string; taskNotificationEnabled: boolean; taskNotificationMode: TaskNotificationMode },
): string {
  const modes: TaskNotificationMode[] = ["detail", "timed", "completion", "plan"];
  const enabled = account?.taskNotificationEnabled === true;
  const mode = account?.taskNotificationMode ?? settings.taskNotificationMode;
  const modeOptions = modes.map((item) => `<option value="${item}" ${mode === item ? "selected" : ""}>${TASK_NOTIFICATION_MODE_LABELS[item]}</option>`).join("");
  return `
    <section class="bot-notification-card bot-notification-card--compact" aria-label="机器人任务通知">
      <div class="bot-notification-card__header">
        <div><span class="bot-notification-card__kicker">TASK NOTIFICATION</span><strong>任务通知</strong></div>
        <span id="bot-task-notification-save-state" class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待保存" : "已保存"}</span>
      </div>
      <label class="bot-notification-card__switch">
        <span>接收本机 Agent 任务</span>
        <input type="checkbox" data-setting="botTaskNotificationEnabled" data-bot-task-platform="${platform}" data-bot-task-account-id="${escapeHtml(account?.id ?? "")}" ${enabled ? "checked" : ""} ${account ? "" : "disabled"} />
      </label>
      <label class="bot-notification-card__field"><span>通知方式</span><select data-setting="botTaskNotificationMode" data-bot-task-platform="${platform}" data-bot-task-account-id="${escapeHtml(account?.id ?? "")}" class="agent-select" ${enabled && account ? "" : "disabled"}>${modeOptions}</select></label>
      <button id="settings-save" class="settings-done settings-done--compact" type="button" ${saving || !dirty ? "disabled" : ""}>保存</button>
    </section>
  `;
}

function renderBotCenter(settings: PetSettings): string {
  const dingtalkSummary = dingtalkStatus
    ? dingtalkStatus.detail
    : settings.dingtalkAccounts.length > 0
      ? "已保存，等待连接"
      : "未配置";
  const wechatSummary = wechatStatus.connected ? "已连接" : wechatStateLabel(wechatStatus.state);
  const qqSummary = qqStatus
    ? qqStatus.detail
    : settings.qqAccounts.length > 0
      ? "已保存，等待启动"
      : "未配置";
  const feishuSummary = feishuStatus
    ? feishuStatus.detail
    : settings.feishuAccounts.length > 0
      ? "已保存，等待启动"
      : "未配置";
  return `
    <div class="settings-page settings-page--bots">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">BOT CHANNELS</div>
          <h1>机器人中心</h1>
        </div>
      </div>
      <p class="settings-page-intro">连接你常用的聊天平台，让桌宠在需要的地方陪伴你。</p>
      <div class="settings-section-title">聊天机器人</div>
      ${renderSettingCardCompact({ id: "open-wechat-config", icon: "wechat", iconColor: "green", title: "微信", description: wechatSummary, badge: wechatStatus.connected ? "已连接" : undefined })}
      ${renderSettingCardCompact({ id: "open-qq-config", icon: "qq", iconColor: "blue", title: "QQ", description: qqSummary, badge: qqStatus?.state === "connected" ? "已连接" : undefined })}
      ${renderSettingCardCompact({ id: "open-feishu-config", icon: "feishu", iconColor: "purple", title: "飞书", description: feishuSummary, badge: feishuStatus?.state === "connected" ? "已连接" : undefined })}
      ${renderSettingCardCompact({ id: "open-dingtalk-config", icon: "dingtalk", iconColor: "orange", title: "钉钉", description: dingtalkSummary, badge: dingtalkStatus?.state === "connected" ? "已连接" : undefined })}

    </div>
  `;
}

function renderWeChatAdvancedPanel(): string {
  return `
    <div id="wechat-advanced-panel" class="wechat-advanced-panel" ${advancedWeChatOpen ? "" : "hidden"} aria-hidden="${advancedWeChatOpen ? "false" : "true"}">
      <button id="wechat-import" class="settings-secondary settings-secondary--wide" type="button" ${importingWeChat ? "disabled" : ""}>
        ${importingWeChat ? "正在导入…" : "导入会话"}
      </button>
    </div>
  `;
}

function renderWeChatSettings(settings: PetSettings): string {
  const hasWeChatSession = settings.wechatEnabled || wechatStatus.connected;
  const account = settings.wechatAccounts.find((item) => item.id === settings.activeWeChatAccountId) ?? settings.wechatAccounts[0];
  return `
    <div class="settings-page settings-page--wechat">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">WECHAT</div>
          <h1>微信机器人</h1>
        </div>
        <span class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待统一保存" : "已保存"}</span>
      </div>

      <div class="settings-section-title">连接状态</div>
      <section class="wechat-connection-card">
        <div class="wechat-connection-card__head">
          <span id="settings-wechat-status" class="wechat-connection-card__status" data-status="${wechatStatus.state}">${escapeHtml(formatWeChatStatusText(wechatStatus))}</span>
          <span class="wechat-connection-card__actions">
            <button id="wechat-refresh" class="settings-secondary" type="button">刷新</button>
            <button id="wechat-reconnect" class="settings-secondary" type="button" ${wechatStatus.state === "connecting" ? "disabled" : ""}>重连</button>
          </span>
        </div>
        ${renderWeChatDiagnostics()}
        <small>${settings.wechatAccounts.length > 0 ? `${settings.wechatAccounts.length} 个 Bot 会话` : settings.wechatTokenFile ? "已配置 Bot 会话" : "暂无 Bot 会话"}</small>
        <div id="wechat-qr-login-area">
          ${renderWeChatQrLoginArea()}
        </div>
        <button id="wechat-logout" class="settings-secondary settings-secondary--wide" type="button" ${loggingOutWeChat || !hasWeChatSession ? "disabled" : ""}>
          ${loggingOutWeChat ? "正在退出…" : hasWeChatSession ? "退出 Bot 会话" : "已退出"}
        </button>
      </section>

      <div class="settings-section-title">Bot 账号</div>
      <section class="settings-list wechat-settings-list">
        ${renderWeChatAccounts(settings)}
      </section>
      ${renderBotAgentBinding(settings, "wechat", account)}
      ${renderBotTaskNotificationSettings(settings, "wechat", account)}

      <div class="settings-section-title">消息权限</div>
      <section class="settings-list wechat-settings-list">
        <label class="wechat-allowlist-field"><span>用户白名单</span><textarea data-setting="wechatAllowedUserIds" rows="4">${escapeHtml(settings.wechatAllowedUserIds.join("\n"))}</textarea></label>
        <div class="setting-row agent-access-summary">
          <span class="setting-icon setting-icon--yellow">盾</span>
          <span class="setting-copy">
            <strong>Agent 权限级别</strong>
            <small>统一由 Agent 配置管理：${agentAccessModeLabel(agentAccessMode(settings))}</small>
          </span>
        </div>
      </section>

      <section class="wechat-advanced-section">
        <button id="wechat-advanced-toggle" class="wechat-advanced-toggle" type="button" aria-expanded="${advancedWeChatOpen ? "true" : "false"}">
          <span>高级操作</span><span class="wechat-advanced-toggle__arrow" data-open="${advancedWeChatOpen ? "true" : "false"}" aria-hidden="true"></span>
        </button>
        ${renderWeChatAdvancedPanel()}
      </section>

    </div>
  `;
}


function renderQQSettings(settings: PetSettings): string {
  const account = settings.qqAccounts.find((item) => item.id === settings.activeQQAccountId) ?? settings.qqAccounts[0];
  const status = qqStatus ? channelStateLabel(qqStatus) : account ? "已保存" : "未配置";
  const connectionDetail = qqStatus?.detail ?? (account ? "账号已保存，等待连接" : "扫码添加 QQ Bot");
  const reconnectDisabled = !qqStatus || qqStatus.state === "connecting" || qqStatus.state === "reconnecting";
  return `
    <div class="settings-page settings-page--qq">
      <div class="settings-title-row">
        <div><div class="settings-page-kicker">QQ BOT</div><h1>QQ 机器人</h1></div>
        <span id="settings-qq-status" class="settings-save-state" data-status="${qqStatus?.state ?? "disconnected"}">${escapeHtml(status)}</span>
      </div>
      <div class="settings-section-title">快速连接</div>
      <section class="wechat-connection-card qq-connection-card">
        <div class="wechat-connection-card__head">
          <span id="qq-connection-detail" class="wechat-connection-card__status" data-status="${qqStatus?.state ?? "disconnected"}">${escapeHtml(connectionDetail)}</span>
          <button id="qq-reconnect" class="settings-secondary" type="button" ${reconnectDisabled ? "disabled" : ""}>重连</button>
        </div>
        <div id="qq-qr-login-area">${renderQQQrLoginArea()}</div>
      </section>
      <div class="settings-section-title">账号配置</div>
      <section class="agent-detail-form">
        <label class="agent-detail-field"><span>显示名称</span><input data-qq-config="displayName" value="${escapeHtml(qqForm.displayName || account?.displayName || "")}" /></label>
        <label class="agent-detail-field"><span>AppID</span><input data-qq-config="appId" value="${escapeHtml(qqForm.appId || account?.appId || "")}" autocomplete="off" /></label>
        <label class="agent-detail-field"><span>AppSecret</span><input data-qq-config="clientSecret" type="password" value="${escapeHtml(qqForm.clientSecret)}" autocomplete="new-password" /></label>
      </section>
      ${renderBotAgentBinding(settings, "qq", account)}
      ${renderBotTaskNotificationSettings(settings, "qq", account)}
      <small id="qq-config-message" class="qq-config-message ${qqMessage && !qqMessage.includes("成功") ? "is-error" : ""}">${escapeHtml(qqMessage || "保存后会立即尝试连接 QQ 网关")}</small>
      <div class="settings-page-actions settings-page-actions--split">
        <button id="qq-remove-config" class="settings-secondary" type="button" ${qqSaving || !account ? "disabled" : ""}>移除当前账号</button>
        <button id="qq-save-config" class="settings-done settings-done--compact" type="button" ${qqSaving ? "disabled" : ""}>${qqSaving ? "正在保存…" : "保存并连接"}</button>
      </div>
    </div>`;
}

function renderFeishuSettings(settings: PetSettings): string {
  const account = settings.feishuAccounts.find((item) => item.id === settings.activeFeishuAccountId) ?? settings.feishuAccounts[0];
  const status = feishuStatus ? channelStateLabel(feishuStatus) : account ? "已保存" : "未配置";
  const connectionDetail = feishuStatus?.detail ?? (account ? "账号已保存，等待连接" : "扫码创建飞书 Bot");
  const reconnectDisabled = !feishuStatus || feishuStatus.state === "connecting" || feishuStatus.state === "reconnecting";
  return `
    <div class="settings-page settings-page--feishu">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">FEISHU BOT</div>
          <h1>飞书机器人</h1>
        </div>
        <span id="settings-feishu-status" class="settings-save-state" data-status="${feishuStatus?.state ?? "disconnected"}">${escapeHtml(status)}</span>
      </div>
      <div class="settings-section-title">快速连接</div>
      <section class="wechat-connection-card feishu-connection-card">
        <div class="wechat-connection-card__head">
          <span id="feishu-connection-detail" class="wechat-connection-card__status" data-status="${feishuStatus?.state ?? "disconnected"}">${escapeHtml(connectionDetail)}</span>
          <button id="feishu-reconnect" class="settings-secondary" type="button" ${reconnectDisabled ? "disabled" : ""}>重连</button>
        </div>
        <div id="feishu-qr-login-area">
          ${renderFeishuQrLoginArea()}
        </div>
      </section>

      <div class="settings-section-title">已有应用</div>
      <section class="agent-detail-form">
        <label class="agent-detail-field"><span>显示名称</span><input data-feishu-config="displayName" value="${escapeHtml(feishuForm.displayName || account?.displayName || "")}" /></label>
        <label class="agent-detail-field"><span>AppID</span><input data-feishu-config="appId" value="${escapeHtml(feishuForm.appId || account?.appId || "")}" autocomplete="off" /></label>
        <label class="agent-detail-field"><span>AppSecret</span><input data-feishu-config="appSecret" type="password" value="${escapeHtml(feishuForm.appSecret)}" autocomplete="new-password" /></label>
      </section>
      ${renderBotAgentBinding(settings, "feishu", account)}
      ${renderBotTaskNotificationSettings(settings, "feishu", account)}
      <small id="feishu-config-message" class="qq-config-message ${feishuMessage && !feishuMessage.includes("成功") ? "is-error" : ""}">${escapeHtml(feishuMessage || "未连接")}</small>

      <div class="settings-page-actions settings-page-actions--split">
        <button id="feishu-remove-config" class="settings-secondary" type="button" ${feishuSaving || !account ? "disabled" : ""}>移除当前账号</button>
        <button id="feishu-save-config" class="settings-done settings-done--compact" type="button" ${feishuSaving ? "disabled" : ""}>${feishuSaving ? "正在保存…" : "保存并连接"}</button>
      </div>

    </div>
  `;
}

function renderDingTalkSettings(settings: PetSettings): string {
  const account = settings.dingtalkAccounts.find((item) => item.id === settings.activeDingTalkAccountId) ?? settings.dingtalkAccounts[0];
  const status = dingtalkStatus ? channelStateLabel(dingtalkStatus) : account ? "已保存" : "未配置";
  const connectionDetail = dingtalkStatus?.detail ?? (account ? "账号已保存，等待连接" : "填写凭据后连接钉钉 Stream");
  const reconnectDisabled = !dingtalkStatus || dingtalkStatus.state === "connecting" || dingtalkStatus.state === "reconnecting";
  return `
    <div class="settings-page settings-page--dingtalk">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">DINGTALK STREAM</div>
          <h1>钉钉机器人</h1>
        </div>
        <span id="settings-dingtalk-status" class="settings-save-state" data-status="${dingtalkStatus?.state ?? "disconnected"}">${escapeHtml(status)}</span>
      </div>
      <div class="settings-section-title">连接状态</div>
      <section class="wechat-connection-card dingtalk-connection-card">
        <div class="wechat-connection-card__head">
          <span id="dingtalk-connection-detail" class="wechat-connection-card__status" data-status="${dingtalkStatus?.state ?? "disconnected"}">${escapeHtml(connectionDetail)}</span>
          <button id="dingtalk-reconnect" class="settings-secondary" type="button" ${reconnectDisabled ? "disabled" : ""}>重连</button>
        </div>
      </section>

      <div class="settings-section-title">先完成钉钉应用配置</div>
      <section class="dingtalk-setup-card">
        <div class="dingtalk-setup-card__header">
          <div class="dingtalk-setup-card__icon" aria-hidden="true">钉</div>
          <strong>应用配置</strong>
        </div>
        <ol class="dingtalk-setup-steps">
          <li><strong>创建应用</strong></li>
          <li><strong>获取 ID</strong></li>
          <li><strong>启用机器人</strong></li>
        </ol>
        <div class="dingtalk-setup-card__actions">
          <button id="dingtalk-open-console" class="settings-secondary" type="button">打开开发者后台</button>
          <button id="dingtalk-open-docs" class="settings-secondary" type="button">查看官方教程</button>
        </div>
      </section>

      <div class="settings-section-title">应用凭据</div>
      <section class="agent-detail-form">
        <label class="agent-detail-field"><span>本地显示名称</span><input data-dingtalk-config="displayName" value="${escapeHtml(dingtalkForm.displayName || account?.displayName || "")}" /></label>
        <label class="agent-detail-field"><span>Client ID / AppKey</span><input data-dingtalk-config="clientId" value="${escapeHtml(dingtalkForm.clientId || account?.clientId || "")}" autocomplete="off" /></label>
        <label class="agent-detail-field"><span>Client Secret / AppSecret</span><input data-dingtalk-config="clientSecret" type="password" value="${escapeHtml(dingtalkForm.clientSecret)}" autocomplete="new-password" /></label>
      </section>
      ${renderBotAgentBinding(settings, "dingtalk", account)}
      ${renderBotTaskNotificationSettings(settings, "dingtalk", account)}
      <small id="dingtalk-config-message" class="qq-config-message ${dingtalkMessage && !dingtalkMessage.includes("成功") ? "is-error" : ""}">${escapeHtml(dingtalkMessage || "未连接")}</small>

      <div class="settings-page-actions settings-page-actions--split">
        <button id="dingtalk-remove-config" class="settings-secondary" type="button" ${dingtalkSaving || !account ? "disabled" : ""}>移除当前账号</button>
        <button id="dingtalk-save-config" class="settings-done settings-done--compact" type="button" ${dingtalkSaving ? "disabled" : ""}>${dingtalkSaving ? "正在连接…" : "保存并连接"}</button>
      </div>

    </div>
  `;
}

function renderFirstUseGuide(): string {
  if (!firstUseGuideVisible) return "";
  return `
    <section class="wechat-first-use-guide">
      <div class="wechat-first-use-guide__copy">
        <strong>第一次连接？</strong>
      </div>
      <div class="wechat-first-use-guide__actions">
        <button class="settings-secondary" id="guide-qr-login" type="button">扫码添加 Bot</button>
        <button class="settings-secondary" id="guide-help" type="button">查看帮助</button>
      </div>
      <button class="wechat-first-use-guide__dismiss" id="guide-dismiss" type="button">知道了</button>
    </section>
  `;
}

function renderWeChatAccounts(settings: PetSettings): string {
  if (settings.wechatAccounts.length === 0) {
    return `<div class="wechat-account-empty">暂无账号</div>`;
  }
  return `
    <div class="wechat-account-list">
      ${settings.wechatAccounts.map((account) => {
        const active = account.id === settings.activeWeChatAccountId;
        const connected = active && wechatStatus.connected;
        const loggedOut = active && !wechatStatus.connected && (wechatStatus.state === "logged-out" || (!settings.wechatEnabled && wechatStatus.state === "disconnected"));
        const accountState = active ? connected ? "\u5f53\u524d\u4f7f\u7528" : loggedOut ? "\u5df2\u9000\u51fa" : wechatStateLabel(wechatStatus.state) : "\u5df2\u4fdd\u5b58-\u672a\u8fd0\u884c";

        const revealed = revealedWeChatIds.has(account.id);
        return `<div class="wechat-account-row ${connected ? "is-connected" : ""}">
          <button class="wechat-account-row__select" type="button" data-wechat-account-id="${escapeHtml(account.id)}" ${connected || importingWeChat || loggingOutWeChat ? "disabled" : ""}>
            <span class="wechat-account-row__dot"></span>
            <span class="wechat-account-row__name" data-wechat-secret-value="${escapeHtml(account.displayName)}">${revealed ? escapeHtml(account.displayName) : "••••••••"}</span>
            <span class="wechat-account-row__state">${accountState}</span>
          </button>
          <button class="wechat-account-row__visibility" type="button" data-reveal-wechat-id="${escapeHtml(account.id)}" aria-label="${revealed ? "隐藏" : "显示"} Bot 标识" title="${revealed ? "隐藏" : "显示"} Bot 标识" aria-pressed="${revealed ? "true" : "false"}">${renderWeChatVisibilityIcon(revealed)}</button>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderWeChatVisibilityIcon(revealed: boolean): string {
  if (revealed) {
    return `<svg class="wechat-account-row__visibility-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.7A11.3 11.3 0 0 1 12 6.5c6.3 0 9.8 5.5 9.8 5.5a18.5 18.5 0 0 1-3.5 3.9"/><path d="M6.2 8.1C3.6 9.8 2.2 12 2.2 12s3.5 5.5 9.8 5.5c1 0 1.9-.1 2.7-.4"/></svg>`;
  }
  return `<svg class="wechat-account-row__visibility-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12s3.5-5.5 9.8-5.5 9.8 5.5 9.8 5.5-3.5 5.5-9.8 5.5S2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>`;
}

function isQrLoginActive(): boolean {
  return qrLoginState !== null && ["requesting", "waiting", "scanned", "connecting"].includes(qrLoginState.status);
}

function renderWeChatQrLogin(): string {
  if (!qrLoginState) return "";

  const showCancel = isQrLoginActive();
  const showQr = Boolean(qrLoginState.qrDataUrl);
  const qrAccountKey = qrLoginState.accountId ? `qr:${qrLoginState.accountId}` : "";
  const qrAccountRevealed = Boolean(qrAccountKey && revealedWeChatIds.has(qrAccountKey));
  return `
    <div class="wechat-qr-login" data-status="${qrLoginState.status}">
      ${showQr ? `<img class="wechat-qr-login__image" src="${escapeHtml(qrLoginState.qrDataUrl ?? "")}" alt="微信 Bot 二维码" />` : ""}
      <div class="wechat-qr-login__detail">${escapeHtml(qrLoginState.detail)}</div>
      ${qrLoginState.accountId ? `<div class="wechat-qr-login__account"><span data-wechat-secret-value="${escapeHtml(qrLoginState.accountId)}">Bot：${qrAccountRevealed ? escapeHtml(qrLoginState.accountId) : "••••••••"}</span><button class="wechat-account-row__visibility" type="button" data-reveal-wechat-id="${escapeHtml(qrAccountKey)}" aria-label="${qrAccountRevealed ? "隐藏" : "显示"} Bot 标识" title="${qrAccountRevealed ? "隐藏" : "显示"} Bot 标识" aria-pressed="${qrAccountRevealed ? "true" : "false"}">${renderWeChatVisibilityIcon(qrAccountRevealed)}</button></div>` : ""}
      ${showCancel
        ? `<button id="wechat-qr-cancel" class="settings-secondary" type="button">取消扫码</button>`
        : `<button id="wechat-qr-dismiss" class="settings-secondary" type="button">关闭提示</button>`}
    </div>
  `;
}

function renderWeChatQrLoginArea(): string {
  return `
    <button id="wechat-qr-login" class="settings-done settings-secondary--wide" type="button" ${isQrLoginActive() ? "disabled" : ""}>
      ${isQrLoginActive() ? "扫码中…" : "扫码添加 Bot"}
    </button>
    ${renderWeChatQrLogin()}
  `;
}

function isQQQrLoginActive(): boolean {
  return qqQrLoginState !== null && ["requesting", "waiting", "scanned", "connecting"].includes(qqQrLoginState.status);
}

function isQQQrLoginCancellable(): boolean {
  return qqQrLoginState !== null && ["requesting", "waiting", "scanned"].includes(qqQrLoginState.status);
}

function renderQQQrLogin(): string {
  if (!qqQrLoginState) return "";

  const showCancel = isQQQrLoginCancellable();
  const showDismiss = !isQQQrLoginActive();
  return `
    <div class="wechat-qr-login qq-qr-login" data-status="${qqQrLoginState.status}">
      ${qqQrLoginState.qrDataUrl ? `<img class="wechat-qr-login__image" src="${escapeHtml(qqQrLoginState.qrDataUrl)}" alt="QQ Bot 二维码" />` : ""}
      <div class="wechat-qr-login__detail">${escapeHtml(qqQrLoginState.detail)}</div>
      ${qqQrLoginState.appId ? `<div class="wechat-qr-login__account">AppID：${escapeHtml(qqQrLoginState.appId)}</div>` : ""}
      ${showCancel
        ? `<button id="qq-qr-cancel" class="settings-secondary" type="button">取消扫码</button>`
        : showDismiss
          ? `<button id="qq-qr-dismiss" class="settings-secondary" type="button">${qqQrLoginState.status === "confirmed" ? "完成" : "关闭"}</button>`
          : ""}
    </div>
  `;
}

function renderQQQrLoginArea(): string {
  if (qqQrLoginState?.status === "confirmed") return renderQQQrLogin();
  const buttonLabel = isQQQrLoginActive()
    ? qqQrLoginState?.status === "connecting" ? "正在连接…" : "等待扫码…"
    : qqQrLoginState?.status === "error" || qqQrLoginState?.status === "expired" ? "重新扫码" : "QQ 扫码添加 Bot";
  return `
    <button id="qq-qr-login" class="settings-done settings-secondary--wide" type="button" ${isQQQrLoginActive() ? "disabled" : ""}>
      ${buttonLabel}
    </button>
    ${renderQQQrLogin()}
  `;
}

function isFeishuQrLoginActive(): boolean {
  return feishuQrLoginState !== null && ["requesting", "waiting", "scanned", "connecting"].includes(feishuQrLoginState.status);
}

function isFeishuQrLoginCancellable(): boolean {
  return feishuQrLoginState !== null && ["requesting", "waiting", "scanned"].includes(feishuQrLoginState.status);
}

function renderFeishuQrLogin(): string {
  if (!feishuQrLoginState) return "";

  const showCancel = isFeishuQrLoginCancellable();
  const showDismiss = !isFeishuQrLoginActive();
  return `
    <div class="wechat-qr-login feishu-qr-login" data-status="${feishuQrLoginState.status}">
      ${feishuQrLoginState.qrDataUrl ? `<img class="wechat-qr-login__image" src="${escapeHtml(feishuQrLoginState.qrDataUrl)}" alt="飞书 Bot 二维码" />` : ""}
      <div class="wechat-qr-login__detail">${escapeHtml(feishuQrLoginState.detail)}</div>
      ${feishuQrLoginState.appId ? `<div class="wechat-qr-login__account">AppID：${escapeHtml(feishuQrLoginState.appId)}</div>` : ""}
      ${showCancel
        ? `<button id="feishu-qr-cancel" class="settings-secondary" type="button">取消扫码</button>`
        : showDismiss
          ? `<button id="feishu-qr-dismiss" class="settings-secondary" type="button">${feishuQrLoginState.status === "confirmed" ? "完成" : "关闭"}</button>`
          : ""}
    </div>
  `;
}

function renderFeishuQrLoginArea(): string {
  if (feishuQrLoginState?.status === "confirmed") return renderFeishuQrLogin();
  const buttonLabel = isFeishuQrLoginActive()
    ? feishuQrLoginState?.status === "connecting" ? "正在连接…" : "等待扫码…"
    : feishuQrLoginState?.status === "error" || feishuQrLoginState?.status === "expired" ? "重新扫码" : "扫码创建飞书 Bot";
  return `
    <button id="feishu-qr-login" class="settings-done settings-secondary--wide" type="button" ${isFeishuQrLoginActive() ? "disabled" : ""}>
      ${buttonLabel}
    </button>
    ${renderFeishuQrLogin()}
  `;
}

function renderAgentCard(config: AgentConfig, settings: PetSettings | null = draftSettings): string {
  const currentConfig = config.ccSwitchCurrentConfig;
  const cardAccent = safeCardAccent(currentConfig?.iconColor || config.iconColor);
  const zeroTokenActive = Boolean(settings?.zeroToken.enabled && agentSupportsZeroToken(config));
  const preserveCcSwitchConfig = zeroTokenActive && Boolean(currentConfig);
  return `
    <div class="agent-card-shell ${preserveCcSwitchConfig ? "agent-card-shell--preserved" : ""}">
      <button class="agent-card__remove" data-remove-agent-card="${escapeHtml(config.id)}" type="button" aria-label="${escapeHtml(preserveCcSwitchConfig ? `${config.displayName} 的 CCS 配置在 Zero Token 开启时保留` : `从桌宠中移除 ${config.displayName}`)}" title="${escapeHtml(preserveCcSwitchConfig ? "Zero Token 开启时保留 CCS 配置" : "从桌宠中移除 Agent 卡片")}" ${preserveCcSwitchConfig ? "disabled" : ""}>${preserveCcSwitchConfig ? "保留" : "移除"}</button>
      <div class="agent-card-column">
        <article class="agent-card" aria-label="${escapeHtml(config.displayName)}" style="${cardAccent ? `--agent-card-accent:${cardAccent};` : ""}">
          <span class="agent-card__icon ${agentIconClass(config)}" aria-hidden="true">${agentIconMarkup(config)}</span>
          <span class="agent-card__copy">
            <strong>${escapeHtml(config.displayName)}</strong>
            <small class="agent-card__meta">${escapeHtml(agentCardMeta(config, settings))}</small>
          </span>
          <span class="agent-card__badges">
            <span class="agent-card__badge agent-card__badge--support">${agentExecutionLabel(config)}</span>
          </span>
        </article>
      </div>
      <button class="agent-card__detail" data-open-agent-detail="${escapeHtml(config.id)}" type="button" aria-label="查看 ${escapeHtml(config.displayName)} 详情">详情</button>
    </div>
  `;
}// CC Switch status is kept for the explicit Agent-page import flow.
// CC Switch is synchronized to discovered local Agents; it is not an Agent-card import UI.
const AGENT_PERMISSION_LABELS: Record<AgentCapabilityPermission, string> = {
  allow: "允许",
  ask: "需确认",
  deny: "禁止",
};

function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITY_IDS as readonly string[]).includes(value);
}

type AgentAccessMode = PetSettings["codexSandboxMode"];

function agentAccessMode(settings: PetSettings): AgentAccessMode {
  if (settings.agentFullAccess) return "danger-full-access";
  if (settings.codexSandboxMode === "workspace-write") return "workspace-write";
  return "read-only";
}

function agentAccessModeLabel(mode: AgentAccessMode): string {
  if (mode === "workspace-write") return "工作区写入";
  if (mode === "danger-full-access") return "完全权限";
  return "只读";
}

function agentCapabilityPolicyForAccessMode(mode: AgentAccessMode) {
  if (mode === "danger-full-access") return fullAgentCapabilityPolicy();
  const policy = defaultAgentCapabilityPolicy();
  if (mode === "workspace-write") {
    policy["file.read"] = "allow";
    policy["file.write"] = "allow";
    policy["network.request"] = "allow";
    policy["shell.exec"] = "ask";
    policy["process.control"] = "ask";
    policy["screen.capture"] = "allow";
    policy["external.send"] = "ask";
    policy["agent.dispatch"] = "ask";
  }
  return policy;
}

function agentAccessModeUpdate(mode: AgentAccessMode): Partial<PetSettings> {
  return {
    agentFullAccess: mode === "danger-full-access",
    agentPermissionPolicy: mode === "read-only" ? "chat-only" : "allow-tools",
    agentCapabilityPolicy: agentCapabilityPolicyForAccessMode(mode),
    codexSandboxMode: mode,
  };
}

function zeroTokenStatusText(settings: PetSettings): string {
  if (!settings.zeroToken.enabled) return "关闭时继续使用当前已有模型/API 配置";
  if (!zeroTokenStatus) return "尚未检测网页登录状态";
  return zeroTokenStatus.detail || zeroTokenStatus.providerName;
}

function zeroTokenRuntimeStatusLabel(status: ZeroTokenProviderStatus["status"]): string {
  if (status === "ready") return "🟢 已连接";
  if (status === "starting" || status === "logging_in") return "🟡 登录中";
  if (status === "login_required") return "🟡 未登录";
  if (status === "error") return "🔴 错误";
  return "⚪ 未启动";
}

function agentModelProvider(config: AgentConfig): AgentModelProvider {
  if (config.modelProvider) return config.modelProvider;
  if (config.ccSwitchCurrentConfig) return "ccs";
  return "api";
}

function agentModelProviderLabel(provider: AgentModelProvider): string {
  if (provider === "zerotoken") return "Zero Token Web";
  if (provider === "ccs") return "CCS";
  if (provider === "deepseek") return "DeepSeek API";
  return "API Key";
}

function renderZeroTokenCard(settings: PetSettings): string {
  const zeroToken = settings.zeroToken;
  const status = zeroTokenStatus?.status ?? "stopped";
  const selectedProvider = zeroToken.provider || "chatgpt-web";
  const providers = [
    ["chatgpt-web", "ChatGPT Web"],
    ["claude-web", "Claude Web"],
    ["gemini-web", "Gemini Web"],
  ] as const;
  const providerName = providers.find(([id]) => id === selectedProvider)?.[1] || selectedProvider;
  return `
    <section id="zero-token-card" class="zero-token-card" aria-label="Zero Token 模式">
      <div class="zero-token-card__header">
        <div class="zero-token-card__copy">
          <strong>Zero Token</strong>
          <small>通过独立网页登录使用网页模型，无需 API Key</small>
        </div>
        <label class="cute-switch zero-token-card__switch" title="切换 Zero Token 模式">
          <input id="zero-token-enabled" data-setting="zeroTokenEnabled" type="checkbox" ${zeroToken.enabled ? "checked" : ""} />
          <span class="cute-switch__track"></span>
        </label>
        <span id="zero-token-mode-label" class="zero-token-card__mode">${zeroToken.enabled ? "ON" : "OFF"}</span>
      </div>
      <p id="zero-token-status" class="zero-token-card__status">${escapeHtml(zeroTokenRuntimeStatusLabel(status))} · ${escapeHtml(zeroTokenStatusText(settings))}</p>
      <div class="zero-token-card__settings">
        <label><span>Provider</span><select data-zero-token-field="provider" aria-label="选择 Zero Token Provider">${providers.map(([id, name]) => `<option value="${id}" ${selectedProvider === id ? "selected" : ""}>${name}</option>`).join("")}</select></label>
        <div class="zero-token-card__runtime-meta"><span>Provider：${escapeHtml(zeroTokenStatus?.providerName || providerName)}</span><span>状态：${escapeHtml(zeroTokenRuntimeStatusLabel(status))}</span></div>
        <div class="zero-token-card__actions">
          <button id="zero-token-check" class="settings-secondary settings-secondary--compact" type="button" ${zeroTokenStatusLoading ? "disabled" : ""}>${zeroTokenStatusLoading ? "检测中…" : "检测登录状态"}</button>
          <button id="zero-token-login" class="settings-secondary settings-secondary--compact" type="button" ${zeroTokenStatusLoading ? "disabled" : ""}>${status === "ready" ? "重新登录" : "网页登录"}</button>
          <button id="zero-token-logout" class="settings-secondary settings-secondary--compact" type="button" ${status === "ready" ? "" : "disabled"}>退出登录</button>
        </div>
      </div>
      <small id="zero-token-hint" class="zero-token-card__hint" ${zeroToken.enabled ? "" : "hidden"}>启用后 Agent 使用所选网页 Provider；关闭后原 API/CCS 配置仍会恢复。</small>
    </section>
  `;
}
function renderAgents(settings: PetSettings): string {
  const configs = cardAgentConfigs(settings);
  return `
    <div class="settings-page settings-page--agents">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">AGENT CONFIGURATION</div>
          <h1>Agent 配置</h1>
        </div>
        <span class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待统一保存" : "已保存"}</span>
      </div>

      <section class="agent-permission-control" aria-label="Agent 权限级别">
        <div class="agent-permission-control__copy">
          <strong>Agent 权限级别</strong>
          <small>统一应用到各机器人绑定的 Agent</small>
        </div>
        <select data-setting="agentAccessMode" class="agent-select" aria-label="选择 Agent 权限级别">
          <option value="read-only" ${agentAccessMode(settings) === "read-only" ? "selected" : ""}>只读</option>
          <option value="workspace-write" ${agentAccessMode(settings) === "workspace-write" ? "selected" : ""}>工作区写入</option>
          <option value="danger-full-access" ${agentAccessMode(settings) === "danger-full-access" ? "selected" : ""}>完全权限</option>
        </select>
      </section>

      ${renderZeroTokenCard(settings)}

      <section class="agent-directory">
        <div class="agent-page-toolbar">
          <div>
            <div class="settings-section-title">已加入的 Agent</div>
            <small class="agent-directory__hint">${configs.length} 个已加入</small>
          </div>
          <div class="agent-page-toolbar__actions">
            <button id="open-agent-add" class="settings-secondary settings-secondary--compact" type="button">＋ 添加</button>
            <button id="import-ccswitch-agents" class="settings-secondary settings-secondary--compact" type="button" ${ccSwitchImportButtonState(settings).disabled ? "disabled" : ""}>${escapeHtml(ccSwitchImportButtonState(settings).label)}</button>
          </div>
        </div>
        <section id="agent-card-list" class="agent-list">
          ${configs.map((config) => renderAgentCard(config, settings)).join("") || `<div class="agent-list-empty">暂无 Agent</div>`}
        </section>
      </section>

      <div class="settings-page-actions">
        <button id="stage-agent" class="settings-secondary" type="button">暂存并返回</button>
      </div>
    </div>
  `;
}

function renderAgentAdd(): string {
  const availableCount = agentDiscovery.filter((agent) => agent.status === "available").length;
  const discoveryHint = agentDiscovery.length > 0 ? `${availableCount} 个可用` : "等待扫描";
  return `
    <div class="settings-page settings-page--agent-add">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">ADD AGENT</div>
          <h1>添加 Agent</h1>
        </div>
        <span class="settings-save-state">本机扫描</span>
      </div>

      <section class="agent-discovery-panel agent-add-panel" aria-label="扫描本机 Agent">
        <div class="agent-discovery-panel__header">
          <div>
            <strong>本机 Agent</strong>
            <small>${escapeHtml(discoveryHint)}</small>
          </div>
          <button id="discover-agents" class="settings-secondary settings-secondary--compact" type="button" ${discoveringAgents ? "disabled" : ""}>
            ${discoveringAgents ? "扫描中…" : agentDiscovery.length > 0 ? "重新扫描" : "开始扫描"}
          </button>
        </div>
        <section class="agent-discovery-results" aria-live="polite">
          ${renderDiscoveryResults()}
        </section>
      </section>

      <div class="settings-page-actions">
        <button id="cancel-agent-add" class="settings-secondary" type="button">返回 Agent 配置</button>
      </div>
    </div>
  `;
}

function renderAgentDetail(): string {
 if (!agentDetailDraft) return `<div class="agent-detail-empty">未选择 Agent</div>`;
 const config = agentDetailDraft;
 const discovery = diagnosticDiscovery(config);
 const source = agentSourceLabel(config);
 const version = discovery?.version || diagnosticAgentRecord(config).command?.version || "待检查";
  const selectedModelProvider = agentModelProvider(config);
  const zeroRuntime = zeroTokenStatus?.runtimeProvider;
  return `
    <div class="settings-page settings-page--agent-detail">
      <div class="settings-title-row">
        <div>
          <div class="settings-page-kicker">AGENT DETAIL</div>
          <h1>${escapeHtml(config.displayName || "Agent 详情")}</h1>
        </div>
        <span class="settings-save-state ${dirty ? "is-dirty" : ""}">${dirty ? "待统一保存" : "已保存"}</span>
      </div>
      <section class="agent-detail-summary" aria-label="Agent 基本信息">
        <div class="agent-detail-summary__icon ${agentIconClass(config)}">${agentIconMarkup(config)}</div>
        <div class="agent-detail-summary__copy">
          <strong>${escapeHtml(config.displayName)}</strong>
          <small>${escapeHtml(config.command || "未发现可执行命令")} · ${escapeHtml(source)}</small>
          <small>运行方式：${escapeHtml(agentDescription(config))}</small>
          <small>版本：${escapeHtml(version)}</small>
        </div>
      </section>

      <section class="agent-detail-form agent-model-provider" aria-label="模型来源">
        <label class="agent-detail-field"><span>模型来源</span><select data-agent-model-provider="true" aria-label="选择模型来源">
          <option value="api" ${selectedModelProvider === "api" ? "selected" : ""}>API Key</option>
          <option value="ccs" ${selectedModelProvider === "ccs" ? "selected" : ""} ${config.ccSwitchCurrentConfig ? "" : "disabled"}>CCS${config.ccSwitchCurrentConfig ? "" : "（未绑定）"}</option>
          <option value="deepseek" ${selectedModelProvider === "deepseek" ? "selected" : ""}>DeepSeek</option>
          <option value="zerotoken" ${selectedModelProvider === "zerotoken" ? "selected" : ""}>Zero Token Web</option>
        </select></label>
        <small class="agent-model-provider__hint">当前：${escapeHtml(agentModelProviderLabel(selectedModelProvider))}</small>
        ${selectedModelProvider === "zerotoken" ? `<div class="agent-model-provider__runtime"><strong>Zero Token Web</strong><span>${escapeHtml(zeroTokenRuntimeStatusLabel(zeroRuntime?.status ?? zeroTokenStatus?.status ?? "stopped"))}</span><span>Provider：${escapeHtml(zeroTokenStatus?.providerName || draftSettings?.zeroToken.provider || "未选择")}</span></div>` : ""}
      </section>

      <section class="agent-test-panel ${agentTestOk ? "is-ok" : agentTestMessage ? "is-error" : ""}">
        <div><strong>命令检查</strong><small>${escapeHtml(agentTestMessage || "未检查")}</small></div>
        <button id="test-agent" class="settings-secondary" type="button" ${agentTestRunning ? "disabled" : ""}>${agentTestRunning ? "检查中…" : "检查命令"}</button>
      </section>

      <section class="agent-test-panel agent-health-panel ${agentHealthOk ? "is-ok" : agentHealthMessage ? "is-error" : ""}">
        <div>
          <strong>真实请求</strong>
          <small id="agent-health-message">${escapeHtml(agentHealthMessage || "未检查")}</small>
          <code id="agent-health-preview" class="agent-health-preview" ${agentHealthPreview ? "" : "hidden"}>${escapeHtml(agentHealthPreview)}</code>
        </div>
        <button id="health-check-agent" class="settings-secondary" type="button" ${agentHealthRunning ? "disabled" : ""}>${agentHealthRunning ? "请求中…" : "真实请求"}</button>
      </section>

      <div class="settings-page-actions">
        <button id="cancel-agent-detail" class="settings-secondary" type="button">取消</button>
      </div>
    </div>
  `;
}

type CustomSelectParts = {
  wrapper: HTMLElement;
  select: HTMLSelectElement;
  trigger: HTMLButtonElement;
  menu: HTMLElement;
};

function getCustomSelectParts(wrapper: HTMLElement): CustomSelectParts | null {
  const select = wrapper.querySelector<HTMLSelectElement>("select");
  const trigger = wrapper.querySelector<HTMLButtonElement>("[data-custom-select-trigger]");
  const menuId = wrapper.dataset.customSelectId;
  const menu = menuId
    ? document.querySelector<HTMLElement>(`[data-custom-select-menu][data-custom-select-owner="${menuId}"]`)
    : null;
  if (!select || !trigger || !menu) return null;
  return { wrapper, select, trigger, menu };
}

function customSelectWrappers(): HTMLElement[] {
  return Array.from(contentControl.querySelectorAll<HTMLElement>("[data-custom-select]"));
}

function syncCustomSelect(wrapper: HTMLElement): void {
  const parts = getCustomSelectParts(wrapper);
  if (!parts) return;
  const { select, trigger, menu } = parts;
  const selectedOption = select.options[select.selectedIndex];
  trigger.textContent = selectedOption?.textContent?.trim() || "请选择";
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") || trigger.textContent);
  trigger.disabled = select.disabled;
  wrapper.dataset.disabled = String(select.disabled);
  trigger.setAttribute("aria-expanded", String(!menu.hidden));
  if (select.disabled && !menu.hidden) closeCustomSelect(wrapper);
  menu.querySelectorAll<HTMLButtonElement>("[data-custom-select-option]").forEach((optionButton) => {
    const selected = optionButton.dataset.value === select.value;
    optionButton.classList.toggle("is-selected", selected);
    optionButton.setAttribute("aria-selected", String(selected));
    optionButton.disabled = optionButton.dataset.disabled === "true";
  });
}

function closeCustomSelect(wrapper: HTMLElement): void {
  const parts = getCustomSelectParts(wrapper);
  if (!parts) return;
  parts.menu.hidden = true;
  parts.menu.dataset.open = "false";
  parts.wrapper.dataset.open = "false";
  parts.trigger.setAttribute("aria-expanded", "false");
}

function closeAllCustomSelects(except?: HTMLElement): void {
  customSelectWrappers().forEach((wrapper) => {
    if (wrapper !== except) closeCustomSelect(wrapper);
  });
}

function openCustomSelect(wrapper: HTMLElement): void {
  const parts = getCustomSelectParts(wrapper);
  if (!parts || parts.select.disabled) return;
  const { trigger, menu } = parts;
  closeAllCustomSelects(wrapper);
  syncCustomSelect(wrapper);
  menu.hidden = false;
  menu.dataset.open = "true";
  wrapper.dataset.open = "true";

  const triggerRect = trigger.getBoundingClientRect();
  const maxWidth = Math.max(120, window.innerWidth - 24);
  const width = Math.min(Math.max(triggerRect.width, 150), maxWidth);
  const menuHeight = Math.min(270, Math.max(48, menu.scrollHeight));
  const opensAbove = triggerRect.bottom + menuHeight + 8 > window.innerHeight && triggerRect.top - menuHeight - 8 >= 12;
  const top = opensAbove
    ? triggerRect.top - menuHeight - 8
    : triggerRect.bottom + 8;
  const left = Math.min(Math.max(12, triggerRect.left), Math.max(12, window.innerWidth - width - 12));
  menu.style.width = `${Math.round(width)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(12, top))}px`;
  menu.dataset.placement = opensAbove ? "above" : "below";
  trigger.setAttribute("aria-expanded", "true");
}

function toggleCustomSelect(wrapper: HTMLElement): void {
  const parts = getCustomSelectParts(wrapper);
  if (!parts || parts.select.disabled) return;
  if (parts.menu.hidden) openCustomSelect(wrapper);
  else closeCustomSelect(wrapper);
}

function selectCustomOption(optionButton: HTMLButtonElement): void {
  if (optionButton.disabled) return;
  const menu = optionButton.closest<HTMLElement>("[data-custom-select-menu]");
  const ownerId = menu?.dataset.customSelectOwner;
  if (!ownerId) return;
  const wrapper = customSelectWrappers().find((candidate) => candidate.dataset.customSelectId === ownerId);
  const parts = wrapper ? getCustomSelectParts(wrapper) : null;
  if (!wrapper || !parts) return;
  parts.select.value = optionButton.dataset.value ?? "";
  parts.select.dispatchEvent(new Event("change", { bubbles: true }));
  if (wrapper.isConnected) syncCustomSelect(wrapper);
  closeCustomSelect(wrapper);
}

function destroyCustomSelectMenus(): void {
  document.querySelectorAll<HTMLElement>("[data-custom-select-menu]").forEach((menu) => menu.remove());
}

function enhanceCustomSelects(root: ParentNode = contentControl): void {
  root.querySelectorAll<HTMLSelectElement>("select:not([multiple])").forEach((select) => {
    if (select.closest("[data-custom-select]")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "custom-select";
    wrapper.dataset.customSelect = "true";
    wrapper.dataset.customSelectId = `custom-select-${++customSelectSequence}`;
    select.parentElement?.insertBefore(wrapper, select);
    wrapper.append(select);
    select.tabIndex = -1;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select__trigger";
    trigger.dataset.customSelectTrigger = "true";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "选择选项");
    wrapper.append(trigger);

    const menu = document.createElement("div");
    menu.className = "custom-select__menu";
    menu.dataset.customSelectMenu = "true";
    menu.dataset.customSelectOwner = wrapper.dataset.customSelectId;
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    menu.id = `${wrapper.dataset.customSelectId}-menu`;
    trigger.setAttribute("aria-controls", menu.id);
    select.querySelectorAll<HTMLOptionElement>("option").forEach((option) => {
      const optionButton = document.createElement("button");
      optionButton.type = "button";
      optionButton.className = "custom-select__option";
      optionButton.dataset.customSelectOption = "true";
      optionButton.dataset.value = option.value;
      optionButton.dataset.disabled = String(option.disabled);
      optionButton.disabled = option.disabled;
      optionButton.setAttribute("role", "option");
      optionButton.textContent = option.textContent?.trim() || option.value;
      menu.append(optionButton);
    });
    document.body.append(menu);
    syncCustomSelect(wrapper);
  });
}

function render(animate = true): void {
  if (!draftSettings) return;
  const pageChanged = renderedPage !== currentPage;
  const shouldAnimatePage = animate && renderedPage !== null;
  applyTheme(draftSettings.theme);
  // Keep full renders for page/data transitions; local interactions must use an update...View helper.
  destroyCustomSelectMenus();
  contentControl.innerHTML =
    currentPage === "home"
      ? renderHome(draftSettings)
      : currentPage === "appearance"
        ? renderAppearancePage(draftSettings)
      : currentPage === "personalization"
        ? renderPersonalizationPage(draftSettings)
      : currentPage === "bots"
        ? renderBotCenter(draftSettings)
      : currentPage === "agents"
        ? renderAgents(draftSettings)
      : currentPage === "agent-add"
         ? renderAgentAdd()
      : currentPage === "pet-styles"
         ? renderPetStylePage(draftSettings)
          : currentPage === "perception"
          ? renderPetPerceptionPage(draftSettings)
          : currentPage === "perception-detail"
          ? renderPerceptionDetailPage(draftSettings)
          : currentPage === "perception-advanced"
          ? renderPetPerceptionAdvancedPage(draftSettings)
         : currentPage === "memory"
         ? renderMemoryPage()
         : currentPage === "memory-all"
         ? renderMemoryAllPage()
         : currentPage === "diagnostics"
        ? renderDiagnostics(draftSettings)
        : currentPage === "data"
        ? renderDataPage()
        : currentPage === "about"
        ? renderAbout(draftSettings)
        : currentPage === "wechat"
          ? renderWeChatSettings(draftSettings)
          : currentPage === "qq"
            ? renderQQSettings(draftSettings)
          : currentPage === "feishu"
           ? renderFeishuSettings(draftSettings)
        : currentPage === "dingtalk"
           ? renderDingTalkSettings(draftSettings)
           : renderAgentDetail();
  enhanceCustomSelects(contentControl);
  settingsSurface!.dataset.settingsPage = currentPage;
  if (pageChanged) {
    // The settings card is the scroll container. A new page must always start
    // from its own top instead of inheriting the previous page's scroll offset.
    settingsSurface!.scrollTop = 0;
  }
  renderedPage = currentPage;
  const page = contentControl.firstElementChild as HTMLElement | null;
  if (page && shouldAnimatePage) {
    page.classList.add("is-page-transitioning");
    window.setTimeout(() => page.classList.remove("is-page-transitioning"), 380);
  }
  backButtonControl.hidden = currentPage === "home";
  const backLabel = currentPage === 'agent-detail' || currentPage === 'agent-add' || currentPage === 'pet-styles'
    ? '返回 Agent 配置'
    : currentPage === 'appearance'
      ? '返回设置主页'
    : currentPage === 'personalization'
      ? '返回设置主页'
    : currentPage === 'perception-detail'
      ? '返回桌宠感知'
    : currentPage === 'perception-advanced'
      ? '返回桌宠感知'
    : currentPage === 'perception'
      ? '返回设置主页'
    : currentPage === 'memory'
      ? '返回设置主页'
    : currentPage === 'memory-all'
      ? '返回自动记忆'
    : currentPage === 'diagnostics'
      ? '返回设置主页'
    : currentPage === 'data'
      ? '返回设置主页'
    : currentPage === 'about'
      ? '返回设置主页'
    : currentPage === 'wechat'
      ? '返回机器人中心'
    : currentPage === 'qq'
      ? '返回机器人中心'
    : currentPage === 'feishu'
      ? '返回机器人中心'
    : currentPage === 'dingtalk'
      ? '返回机器人中心'
      : '返回设置主页';
  backButtonControl.setAttribute("aria-label", backLabel);
  backButtonControl.title = backLabel;
  renderWeChatStatus();
  updateQQStatusView();
  updateFeishuStatusView();
}

function updateSaveStateView(): void {
  const saveState = currentPage === "wechat" || currentPage === "qq" || currentPage === "feishu" || currentPage === "dingtalk"
    ? contentControl.querySelector<HTMLElement>("#bot-task-notification-save-state")
    : contentControl.querySelector<HTMLElement>("#perception-auto-save-state, .settings-save-state");
  if (saveState) {
    const perceptionPage = currentPage === "perception" || currentPage === "perception-detail" || currentPage === "perception-advanced";
    saveState.classList.toggle("is-dirty", perceptionPage ? dirty || perceptionAutoSaveError : dirty);
    saveState.textContent = perceptionPage
      ? saving
        ? "正在保存…"
        : perceptionAutoSaveError
          ? "自动保存失败"
          : dirty
            ? "正在保存…"
            : "✓ 已自动保存"
      : dirty ? "待保存" : "已保存";
  }

  const saveButton = contentControl.querySelector<HTMLButtonElement>("#settings-save");
  if (saveButton) {
    saveButton.disabled = saving || !dirty;
    saveButton.textContent = saving ? "正在保存…" : "保存全部";
  }
}

function updateZeroTokenView(): void {
  if (!draftSettings || currentPage !== "agents") return;
  const card = contentControl.querySelector<HTMLElement>("#zero-token-card");
  if (!card) return;
  const enabled = draftSettings.zeroToken.enabled;
  const runtimeStatus = zeroTokenStatus?.status ?? "stopped";
  card.classList.toggle("is-enabled", enabled);
  const input = card.querySelector<HTMLInputElement>("#zero-token-enabled");
  if (input) input.checked = enabled;
  const mode = card.querySelector<HTMLElement>("#zero-token-mode-label");
  if (mode) mode.textContent = enabled ? "ON" : "OFF";
  const hint = card.querySelector<HTMLElement>("#zero-token-hint");
  if (hint) hint.hidden = !enabled;
  const status = card.querySelector<HTMLElement>("#zero-token-status");
  if (status) status.textContent = `${zeroTokenRuntimeStatusLabel(runtimeStatus)} · ${zeroTokenMessage || zeroTokenStatusText(draftSettings)}`;
  const provider = card.querySelector<HTMLSelectElement>("[data-zero-token-field=provider]");
  if (provider && provider.value !== draftSettings.zeroToken.provider) provider.value = draftSettings.zeroToken.provider;
  const providerName = card.querySelector<HTMLElement>(".zero-token-card__runtime-meta span:first-child");
  if (providerName) providerName.textContent = `Provider：${zeroTokenStatus?.providerName || draftSettings.zeroToken.provider}`;
  const runtimeMetaStatus = card.querySelector<HTMLElement>(".zero-token-card__runtime-meta span:last-child");
  if (runtimeMetaStatus) runtimeMetaStatus.textContent = `状态：${zeroTokenRuntimeStatusLabel(runtimeStatus)}`;
  const checkButton = card.querySelector<HTMLButtonElement>("#zero-token-check");
  if (checkButton) {
    checkButton.disabled = zeroTokenStatusLoading;
    checkButton.textContent = zeroTokenStatusLoading ? "检测中…" : "检测登录状态";
  }
  const loginButton = card.querySelector<HTMLButtonElement>("#zero-token-login");
  if (loginButton) {
    loginButton.disabled = zeroTokenStatusLoading;
    loginButton.textContent = runtimeStatus === "ready" ? "重新登录" : "网页登录";
  }
  const logoutButton = card.querySelector<HTMLButtonElement>("#zero-token-logout");
  if (logoutButton) logoutButton.disabled = zeroTokenStatusLoading || runtimeStatus !== "ready";
  updateAgentCardListView();
  updateAgentDiscoveryView();
  updateSaveStateView();
}
async function checkZeroTokenConnectionFromSettings(): Promise<void> {
  if (!draftSettings || zeroTokenStatusLoading) return;
  zeroTokenStatusLoading = true;
  zeroTokenMessage = "正在检测 WebModel…";
  updateZeroTokenView();
  try {
    zeroTokenStatus = await api.zeroToken.check({ ...draftSettings.zeroToken });
    zeroTokenMessage = zeroTokenStatus.detail;
  } catch (error) {
    console.error("Unable to check WebModel connection.", error);
    zeroTokenStatus = null;
    zeroTokenMessage = "ZERO_TOKEN_SERVICE_UNAVAILABLE";
  } finally {
    zeroTokenStatusLoading = false;
    updateZeroTokenView();
  }
}

async function controlZeroTokenRuntime(action: "login" | "logout"): Promise<void> {
  if (!draftSettings || zeroTokenStatusLoading) return;
  zeroTokenStatusLoading = true;
  zeroTokenMessage = action === "login" ? "正在打开网页登录窗口…" : "正在退出网页登录…";
  updateZeroTokenView();
  try {
    const config = { ...draftSettings.zeroToken };
    zeroTokenStatus = action === "login"
      ? await api.zeroToken.login(config, config.provider)
      : await api.zeroToken.logout(config, config.provider);
    zeroTokenMessage = zeroTokenStatus.detail;
  } catch (error) {
    console.error("Unable to control embedded Zero Token.", error);
    zeroTokenMessage = error instanceof Error ? error.message : "Zero Token 操作失败";
    try { zeroTokenStatus = await api.zeroToken.runtime(); } catch { /* retain last status */ }
  } finally {
    zeroTokenStatusLoading = false;
    updateZeroTokenView();
  }
}

function updateZeroTokenSetting(field: string, target: HTMLInputElement | HTMLSelectElement): void {
  if (!draftSettings || field !== "provider") return;
  const provider = target.value;
  if (provider !== "chatgpt-web" && provider !== "claude-web" && provider !== "gemini-web") return;
  draftSettings = {
    ...draftSettings,
    zeroToken: {
      ...draftSettings.zeroToken,
      provider,
    },
  };
  zeroTokenStatus = null;
  zeroTokenMessage = "";
  dirty = true;
  updateZeroTokenView();
}
function updateBotTaskNotificationView(): void {
  if (!draftSettings || !(currentPage === "wechat" || currentPage === "qq" || currentPage === "feishu" || currentPage === "dingtalk")) return;
  const platform = currentPage;
  const accountId = contentControl.querySelector<HTMLInputElement>("[data-setting=botTaskNotificationEnabled]")?.dataset.botTaskAccountId;
  if (!accountId) return;
  const accounts = platform === "wechat"
    ? draftSettings.wechatAccounts
    : platform === "qq"
      ? draftSettings.qqAccounts
      : platform === "feishu"
        ? draftSettings.feishuAccounts
        : draftSettings.dingtalkAccounts;
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return;
  const enabledInput = contentControl.querySelector<HTMLInputElement>("[data-setting=botTaskNotificationEnabled]");
  const modeSelect = contentControl.querySelector<HTMLSelectElement>("[data-setting=botTaskNotificationMode]");
  if (enabledInput) enabledInput.checked = account.taskNotificationEnabled;
  if (modeSelect) {
    modeSelect.disabled = !account.taskNotificationEnabled;
    modeSelect.value = account.taskNotificationMode;
  }
  const saveState = contentControl.querySelector<HTMLElement>("#bot-task-notification-save-state");
  if (saveState) {
    saveState.classList.toggle("is-dirty", dirty);
    saveState.textContent = dirty ? "待保存" : "已保存";
  }
  customSelectWrappers().forEach(syncCustomSelect);
  updateSaveStateView();
}

function updatePetPerceptionView(): void {
  if ((currentPage !== "perception" && currentPage !== "perception-detail" && currentPage !== "perception-advanced") || !draftSettings) return;
  const enabled = draftSettings.petPerception.enabled;
  if (currentPage === "perception") {
    const title = contentControl.querySelector<HTMLElement>("#perception-state-title");
    const dot = contentControl.querySelector<HTMLElement>("#perception-state-dot");
    const description = contentControl.querySelector<HTMLElement>("#perception-state-description");
    const toggle = contentControl.querySelector<HTMLInputElement>('input[data-perception-setting="enabled"]');
    if (title) title.textContent = enabled ? "感知已开启" : "感知未开启";
    if (dot) dot.classList.toggle("is-on", enabled);
    if (description) description.textContent = enabled
      ? "小卡拉米正在了解你的工作状态，\n会在合适的时候主动陪伴你。"
      : "开启后，小卡拉米会在合适的时候主动陪伴你。";
    if (toggle) toggle.checked = enabled;
    const capabilities = contentControl.querySelector<HTMLElement>("#perception-capabilities");
    if (capabilities) capabilities.innerHTML = renderPerceptionCapabilities(draftSettings);
  }
  const sourceSelect = contentControl.querySelector<HTMLSelectElement>('select[data-perception-setting="sourceScope"]');
  if (sourceSelect) {
    sourceSelect.value = perceptionSourceScope(draftSettings);
  }
  contentControl.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-perception-setting], select[data-perception-setting]").forEach((input) => {
    const setting = input.dataset.perceptionSetting;
    if (setting !== "enabled") input.disabled = !enabled;
  });
  customSelectWrappers().forEach(syncCustomSelect);
  updateSaveStateView();
}

async function triggerPerception(): Promise<void> {
  const input = contentControl.querySelector<HTMLTextAreaElement>("#perception-signal");
  const signal = input?.value.trim() ?? "";
  if (!signal || !draftSettings?.petPerception.enabled || dirty || perceptionTriggerRunning) return;
  perceptionTriggerRunning = true;
  perceptionTriggerMessage = "正在把信号分发给所有已加入且启用的 Agent…";
  updatePetPerceptionView();
  try {
    const run = await api.petPerception.trigger(signal);
    perceptionTriggerMessage = run.detail;
    if (run.state === "completed" || run.state === "partial") {
      if (input) input.value = "";
    }
  } catch (error) {
    console.error("Unable to trigger pet perception.", error);
    perceptionTriggerMessage = error instanceof Error ? error.message : "协同感知触发失败，请稍后重试";
  } finally {
    perceptionTriggerRunning = false;
    updatePetPerceptionView();
  }
}

async function refreshPetPerception(): Promise<void> {
  try {
    petPerceptionSnapshot = await api.petPerception.getStatus();
  } catch (error) {
    console.warn("Unable to read pet perception status.", error);
  }
  updatePetPerceptionView();
}

function updatePetStyleView(): void {
  if (!draftSettings) return;
  if (currentPage === "home" || currentPage === "appearance") {
    const region = contentControl.querySelector<HTMLElement>("#pet-style-settings");
    if (region) region.outerHTML = renderPetStylePicker(draftSettings);
    return;
  }
  if (currentPage === "pet-styles") {
    const body = contentControl.querySelector<HTMLElement>("#pet-style-page-body");
    if (body) body.innerHTML = renderPetStylePageBody(draftSettings);
    const feedback = contentControl.querySelector<HTMLElement>("#pet-style-feedback");
    if (feedback) {
      feedback.hidden = !petStyleMessage;
      feedback.textContent = petStyleMessage;
      feedback.className = `pet-style-settings__message is-${petStyleMessageTone}`;
    }
    const importButton = contentControl.querySelector<HTMLButtonElement>("#import-pet-style");
    if (importButton) {
      importButton.disabled = importingPetStyle;
      importButton.textContent = importingPetStyle ? "导入中…" : "导入风格";
    }
    if (customStateFormOpen && !importingPetStyle) {
      window.setTimeout(() => contentControl.querySelector<HTMLInputElement>("#custom-pet-state-name")?.focus(), 0);
    }
  }
}

function updateWeChatAdvancedView(): void {
  const toggle = contentControl.querySelector<HTMLButtonElement>("#wechat-advanced-toggle");
  const panel = contentControl.querySelector<HTMLElement>("#wechat-advanced-panel");
  if (!toggle || !panel) return;

  toggle.setAttribute("aria-expanded", String(advancedWeChatOpen));
  const arrow = toggle.querySelector<HTMLElement>(".wechat-advanced-toggle__arrow");
  if (arrow) arrow.dataset.open = String(advancedWeChatOpen);
  panel.hidden = !advancedWeChatOpen;
  panel.setAttribute("aria-hidden", String(!advancedWeChatOpen));
}

function updateFirstUseGuideView(): void {
  if (firstUseGuideVisible) return;
  contentControl.querySelector<HTMLElement>(".wechat-first-use-guide")?.remove();
}

function updateWeChatImportView(): void {
  const button = contentControl.querySelector<HTMLButtonElement>("#wechat-import");
  if (!button) return;
  button.disabled = importingWeChat;
  button.textContent = importingWeChat ? "正在导入…" : "导入会话";
}

function updateWeChatAccountView(): void {
  if (!draftSettings) return;
  const accountList = contentControl.querySelector<HTMLElement>(".wechat-account-list");
  const accountHost = accountList?.parentElement;
  if (accountHost) accountHost.innerHTML = renderWeChatAccounts(draftSettings);
}

function updateWeChatLogoutView(): void {
  const button = contentControl.querySelector<HTMLButtonElement>("#wechat-logout");
  if (!button || !draftSettings) return;
  const hasWeChatSession = draftSettings.wechatEnabled || wechatStatus.connected;
  button.disabled = loggingOutWeChat || !hasWeChatSession;
  button.textContent = loggingOutWeChat
    ? "正在退出…"
    : hasWeChatSession
      ? "退出 Bot 会话"
      : "已退出";
}

function updateAgentTestView(): void {
  const panel = contentControl.querySelector<HTMLElement>(".agent-test-panel");
  if (!panel) return;
  panel.classList.toggle("is-ok", agentTestOk);
  panel.classList.toggle("is-error", !agentTestOk && Boolean(agentTestMessage));
  const message = panel.querySelector<HTMLElement>("small");
  if (message) message.textContent = agentTestMessage || "运行 --version 检查命令是否可执行";
  const button = panel.querySelector<HTMLButtonElement>("#test-agent");
  if (button) {
    button.disabled = agentTestRunning;
    button.textContent = agentTestRunning ? "检查中…" : "检查命令";
  }
}

function updateAgentHealthView(): void {
  const panel = contentControl.querySelector<HTMLElement>(".agent-health-panel");
  if (!panel) return;
  panel.classList.toggle("is-ok", agentHealthOk);
  panel.classList.toggle("is-error", !agentHealthOk && Boolean(agentHealthMessage));
  const message = panel.querySelector<HTMLElement>("#agent-health-message");
  if (message) message.textContent = agentHealthMessage || "未检查";
  const sessionNote = panel.querySelector<HTMLElement>("#agent-health-session-note");
  if (sessionNote) sessionNote.textContent = agentHealthSessionNote(agentDetailDraft);
  const preview = panel.querySelector<HTMLElement>("#agent-health-preview");
  if (preview) {
    preview.hidden = !agentHealthPreview;
    preview.textContent = agentHealthPreview;
  }
  const button = panel.querySelector<HTMLButtonElement>("#health-check-agent");
  if (button) {
    button.disabled = agentHealthRunning;
    button.textContent = agentHealthRunning ? "请求中…" : "真实请求";
  }
}

function updateDiagnosticsView(): void {
  if (currentPage !== "diagnostics" || !draftSettings) return;
  const summary = contentControl.querySelector<HTMLElement>("#diagnostics-summary");
  if (summary) {
    summary.textContent = diagnosticsLoading
      ? "正在刷新…"
      : diagnosticAppVersion
        ? `应用 v${diagnosticAppVersion}${diagnosticChannelStatuses.length > 0 ? ` · ${diagnosticChannelStatuses.length} 个通道` : ""}`
        : "尚未刷新";
  }
  const refreshButton = contentControl.querySelector<HTMLButtonElement>("#refresh-diagnostics");
  if (refreshButton) {
    refreshButton.disabled = diagnosticsLoading;
    refreshButton.textContent = diagnosticsLoading ? "刷新中…" : "刷新诊断";
  }
  const copyButton = contentControl.querySelector<HTMLButtonElement>("#copy-diagnostics");
  if (copyButton) {
    copyButton.disabled = diagnosticsCopied;
    copyButton.textContent = diagnosticsCopied ? "已复制" : "复制诊断摘要";
  }
  const message = contentControl.querySelector<HTMLElement>("#diagnostics-message");
  if (message) {
    message.hidden = !diagnosticsMessage;
    message.textContent = diagnosticsMessage;
  }
  const agentList = contentControl.querySelector<HTMLElement>(".diagnostics-agent-list");
  if (agentList) agentList.innerHTML = renderDiagnosticsAgents(draftSettings);
  const channelList = contentControl.querySelector<HTMLElement>(".diagnostics-channel-list");
  if (channelList) channelList.innerHTML = renderDiagnosticsChannels(draftSettings);
}

function updateDataView(): void {
  if (currentPage !== "data") return;
  const summaryList = contentControl.querySelector<HTMLElement>(".data-summary-list");
  if (summaryList) summaryList.innerHTML = renderLocalDataSummary();
  const refreshButton = contentControl.querySelector<HTMLButtonElement>("#refresh-data-summary");
  if (refreshButton) {
    refreshButton.disabled = dataSummaryLoading;
    refreshButton.textContent = dataSummaryLoading ? "盘点中…" : "刷新盘点";
  }
  const exportButton = contentControl.querySelector<HTMLButtonElement>("#export-data-summary");
  if (exportButton) {
    exportButton.disabled = exportingDataSummary;
    exportButton.textContent = exportingDataSummary ? "导出中…" : "导出数据摘要";
  }
  const message = contentControl.querySelector<HTMLElement>("#data-summary-message");
  if (message) {
    message.hidden = !dataSummaryMessage;
    message.textContent = dataSummaryMessage;
  }
  const historyCount = (localDataSummary?.history.channel.messageCount ?? 0) + (localDataSummary?.history.wechat.messageCount ?? 0);
  const clearButton = contentControl.querySelector<HTMLButtonElement>("#clear-chat-history");
  if (clearButton) {
    clearButton.disabled = clearingChatHistory || historyCount === 0;
    clearButton.textContent = clearingChatHistory ? "正在清空…" : historyCount > 0 ? "清空聊天历史" : "暂无聊天历史";
  }
  const deleteButton = contentControl.querySelector<HTMLButtonElement>("#delete-managed-data");
  const managedDataFileCount = localDataSummary?.managedDataFileCount ?? 0;
  if (deleteButton) {
    deleteButton.disabled = deletingManagedData || !localDataSummary || managedDataFileCount === 0;
    deleteButton.textContent = deletingManagedData
      ? "正在清理并准备重启…"
      : managedDataFileCount > 0
        ? "删除应用托管数据（重启）"
        : "暂无应用托管数据";
  }
}

function updateAboutView(): void {
  if (currentPage !== "about" || !draftSettings) return;

  const updateResultVersion = contentControl.querySelector<HTMLElement>("#about-update-version");
  if (updateResultVersion) {
    updateResultVersion.textContent = updateResult?.latestVersion
      ? `当前 v${updateResult.currentVersion} · 最新 v${updateResult.latestVersion}`
      : `当前 v${aboutVersionLabel()}`;
  }
  const updateDetail = contentControl.querySelector<HTMLElement>("#about-update-detail");
  if (updateDetail) {
    updateDetail.textContent = updateChecking
      ? "正在读取更新清单…"
      : updateMessage || updateResult?.detail || "尚未检查";
  }
  const updateStatus = contentControl.querySelector<HTMLElement>("#about-update-status");
  if (updateStatus) {
    updateStatus.classList.toggle("is-highlight", updateResult?.state === "available");
    const existingDownloadButton = updateStatus.querySelector<HTMLButtonElement>("#open-update-download");
    if (updateResult?.releasePageUrl && !existingDownloadButton) {
      updateStatus.insertAdjacentHTML("beforeend", `<button id="open-update-download" class="settings-secondary settings-secondary--compact" type="button">打开下载页</button>`);
    } else if (!updateResult?.releasePageUrl && existingDownloadButton) {
      existingDownloadButton.remove();
    }
  }
  const updateButton = contentControl.querySelector<HTMLButtonElement>("#check-updates");
  if (updateButton) {
    updateButton.disabled = updateChecking;
    updateButton.textContent = updateChecking ? "检查中…" : "检查更新";
  }
  const notes = contentControl.querySelector<HTMLUListElement>("#about-update-notes");
  if (notes) {
    notes.hidden = !updateResult?.releaseNotes.length;
    notes.innerHTML = updateResult?.releaseNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("") ?? "";
  }
  const checksum = contentControl.querySelector<HTMLElement>("#about-update-checksum");
  if (checksum) {
    const text = updateResult?.assets.map((asset) => `${asset.kind === "nsis" ? "安装包" : "便携包"} · SHA-256 ${asset.sha256}`).join("\n") ?? "";
    checksum.hidden = !text;
    checksum.textContent = text;
  }
}

async function refreshCcSwitchStatus(showLoading = true): Promise<void> {
  if (ccSwitchStatusLoading || !draftSettings?.ccSwitchSyncEnabled) return;
  ccSwitchStatusLoading = true;
  if (showLoading) ccSwitchStatusMessage = "正在读取当前 live 配置…";
  updateAboutView();
  updateAgentDiscoveryView();
  try {
    ccSwitchStatus = await api.ccSwitch.status();
    ccSwitchStatusMessage = ccSwitchStatus.detail;
    await syncCcSwitchProfiles();
  } catch (error) {
    console.error("Unable to read CC Switch status.", error);
    ccSwitchStatus = null;
    ccSwitchStatusMessage = "CC Switch 状态读取失败，请检查主进程日志。";
  } finally {
    ccSwitchStatusLoading = false;
    updateAboutView();
    updateAgentCardListView();
    updateAgentDiscoveryView();
  }
}

function mergeSyncedAgentSettings(nextSettings: PetSettings): void {
  if (!draftSettings) return;
  const nextById = new Map(nextSettings.agentConfigs.map((config) => [config.id, config]));
  const syncedConfigs = draftSettings.agentConfigs.map((config) => {
    const synced = nextById.get(config.id);
    if (!synced) return config;
    return {
      ...config,
      providerName: synced.providerName,
      model: synced.model,
      baseUrlHost: synced.baseUrlHost,
      iconKey: synced.iconKey,
      iconColor: synced.iconColor,
      modelIconKey: synced.modelIconKey,
      modelOptions: synced.modelOptions?.map((option) => ({ ...option })),
      selectedModelId: synced.selectedModelId,
      syncState: synced.syncState,
      executionSupport: synced.executionSupport,
      ccSwitchCurrentConfig: synced.ccSwitchCurrentConfig,
    };
  });
  draftSettings = { ...draftSettings, agentConfigs: syncedConfigs };
  persistedSettings = persistedSettings
    ? { ...persistedSettings, agentConfigs: nextSettings.agentConfigs }
    : nextSettings;
}

async function syncCcSwitchProfiles(): Promise<void> {
  if (!draftSettings?.ccSwitchSyncEnabled || ccSwitchBindingLoading) return;
  ccSwitchBindingLoading = true;
  ccSwitchStatusMessage = "正在绑定本机 Agent 的当前 CCS 配置…";
  updateAgentDiscoveryView();
  try {
    const result = await api.ccSwitch.syncProfiles();
    if (result.ok || result.skippedCount > 0) {
      mergeSyncedAgentSettings(await api.settings.get());
    }
    ccSwitchStatusMessage = result.detail;
  } catch (error) {
    console.error("Unable to sync CC Switch profiles.", error);
    ccSwitchStatusMessage = "CC Switch 当前配置绑定失败，请检查主进程日志。";
  } finally {
    ccSwitchBindingLoading = false;
    updateAgentCardListView();
    updateAboutView();
    updateAgentDiscoveryView();
  }
}

async function checkForUpdates(): Promise<void> {
  if (updateChecking) return;
  updateChecking = true;
  updateMessage = "正在检查更新清单…";
  updateAboutView();
  try {
    updateResult = await api.updates.check();
    updateMessage = updateResult.detail;
  } catch (error) {
    console.error("Unable to check for updates.", error);
    updateResult = null;
    updateMessage = "更新检查失败，请稍后重试。";
  } finally {
    updateChecking = false;
    updateAboutView();
  }
}

async function openUpdateDownload(): Promise<void> {
  const releasePageUrl = updateResult?.releasePageUrl;
  if (!releasePageUrl) return;
  const result = await api.updates.openDownload(releasePageUrl);
  if (!result.ok) {
    updateMessage = result.detail;
    updateAboutView();
  }
}

function renderWeChatStatus(): void {
  const statusText = formatWeChatStatusText(wechatStatus);
  contentControl.querySelectorAll<HTMLElement>("#settings-wechat-status").forEach((statusElement) => {
    statusElement.dataset.status = wechatStatus.state;
    statusElement.textContent = statusText;
  });
  const diagnostics = contentControl.querySelector<HTMLElement>(".wechat-connection-card__diagnostics");
  if (diagnostics) diagnostics.outerHTML = renderWeChatDiagnostics();
  const reconnectButton = contentControl.querySelector<HTMLButtonElement>("#wechat-reconnect");
  if (reconnectButton) reconnectButton.disabled = wechatStatus.state === "connecting";
  updateWeChatAccountView();
}

function updateQQStatusView(): void {
  const statusElement = contentControl.querySelector<HTMLElement>("#settings-qq-status");
  if (statusElement) {
    statusElement.dataset.status = qqStatus?.state ?? "disconnected";
    statusElement.textContent = qqStatus ? channelStateLabel(qqStatus) : "未配置";
  }
  const detailElement = contentControl.querySelector<HTMLElement>("#qq-connection-detail");
  if (detailElement) {
    detailElement.dataset.status = qqStatus?.state ?? "disconnected";
    detailElement.textContent = qqStatus?.detail ?? "扫码添加 QQ Bot";
  }
  const reconnectButton = contentControl.querySelector<HTMLButtonElement>("#qq-reconnect");
  if (reconnectButton) {
    reconnectButton.disabled = !qqStatus || qqStatus.state === "connecting" || qqStatus.state === "reconnecting";
  }
}

function updateQQConfigView(): void {
  const saveButton = contentControl.querySelector<HTMLButtonElement>("#qq-save-config");
  if (saveButton) {
    saveButton.disabled = qqSaving;
    saveButton.textContent = qqSaving ? "正在保存…" : "保存并连接";
  }
  const removeButton = contentControl.querySelector<HTMLButtonElement>("#qq-remove-config");
  if (removeButton) {
    removeButton.disabled = qqSaving || !draftSettings?.qqAccounts.length;
  }
  const message = contentControl.querySelector<HTMLElement>("#qq-config-message");
  if (message) {
    message.textContent = qqMessage || "未连接";
    message.classList.toggle("is-error", Boolean(qqMessage && !qqMessage.includes("成功")));
  }
  updateQQStatusView();
}

function updateFeishuStatusView(): void {
  const statusElement = contentControl.querySelector<HTMLElement>("#settings-feishu-status");
  if (statusElement) {
    statusElement.dataset.status = feishuStatus?.state ?? "disconnected";
    statusElement.textContent = feishuStatus ? channelStateLabel(feishuStatus) : "未配置";
  }
  const detailElement = contentControl.querySelector<HTMLElement>("#feishu-connection-detail");
  if (detailElement) {
    detailElement.dataset.status = feishuStatus?.state ?? "disconnected";
    detailElement.textContent = feishuStatus?.detail ?? "扫码创建飞书 Bot";
  }
  const reconnectButton = contentControl.querySelector<HTMLButtonElement>("#feishu-reconnect");
  if (reconnectButton) {
    reconnectButton.disabled = !feishuStatus || feishuStatus.state === "connecting" || feishuStatus.state === "reconnecting";
  }
}

function updateFeishuConfigView(): void {
  const saveButton = contentControl.querySelector<HTMLButtonElement>("#feishu-save-config");
  if (saveButton) {
    saveButton.disabled = feishuSaving;
    saveButton.textContent = feishuSaving ? "正在保存…" : "保存并连接";
  }
  const removeButton = contentControl.querySelector<HTMLButtonElement>("#feishu-remove-config");
  if (removeButton) {
    removeButton.disabled = feishuSaving || !draftSettings?.feishuAccounts.length;
  }
  const message = contentControl.querySelector<HTMLElement>("#feishu-config-message");
  if (message) {
    message.textContent = feishuMessage || "未连接";
    message.classList.toggle("is-error", Boolean(feishuMessage && !feishuMessage.includes("成功")));
  }
  updateFeishuStatusView();
}

function updateWeChatQrLoginView(): void {
  if (currentPage !== "wechat") return;
  const qrArea = contentControl.querySelector<HTMLElement>("#wechat-qr-login-area");
  if (qrArea) qrArea.innerHTML = renderWeChatQrLoginArea();
}

function updateQQQrLoginView(): void {
  if (currentPage !== "qq") return;
  const qrArea = contentControl.querySelector<HTMLElement>("#qq-qr-login-area");
  if (qrArea) qrArea.innerHTML = renderQQQrLoginArea();
}

function updateFeishuQrLoginView(): void {
  if (currentPage !== "feishu") return;
  const qrArea = contentControl.querySelector<HTMLElement>("#feishu-qr-login-area");
  if (qrArea) qrArea.innerHTML = renderFeishuQrLoginArea();
}

function toWeChatStatus(status: ChannelStatus): WeChatStatus {
  return {
    state: status.state,
    connected: status.connected,
    detail: status.detail,
    lastError: status.lastError,
    retryCount: status.retryCount,
    nextRetryAt: status.nextRetryAt,
    accountId: status.accountId,
  };
}

async function refreshWeChatStatus(): Promise<void> {
  try {
    const channelStatuses = await api.channels.list();
    const wechatChannel = channelStatuses.find((status) => status.channelId === "wechat:active");
    wechatStatus = wechatChannel ? toWeChatStatus(wechatChannel) : await api.wechat.getStatus();
    qqStatus = selectQQStatus(channelStatuses);
    feishuStatus = selectFeishuStatus(channelStatuses);
    dingtalkStatus = selectDingTalkStatus(channelStatuses);
  } catch (error) {
    console.error("Unable to read WeChat status.", error);
    wechatStatus = {
      state: "failed",
      connected: false,
      detail: "微信状态读取失败",
      lastError: "微信状态读取失败",
      retryCount: 0,
      nextRetryAt: null,
    };
  }
  renderWeChatStatus();
  updateQQStatusView();
  updateFeishuStatusView();
  updateDingTalkStatusView();
}

async function reconnectWeChat(): Promise<void> {
  try {
    const result = await api.wechat.reconnect();
    if (!result.ok) await showNotice("重新连接失败", result.detail);
    await refreshWeChatStatus();
  } catch (error) {
    console.error("Unable to reconnect WeChat.", error);
    await showNotice("重新连接失败", "重新连接微信 Bot 失败，请稍后重试。");
  }
}

async function reconnectQQ(): Promise<void> {
  const channelId = qqStatus?.channelId;
  if (!channelId || qqStatus?.state === "connecting" || qqStatus?.state === "reconnecting") return;

  qqMessage = "正在重新连接 QQ 网关…";
  updateQQConfigView();
  try {
    const result = await api.channels.reconnect(channelId);
    qqMessage = result.ok ? "QQ Bot 重新连接成功" : result.detail;
    await refreshWeChatStatus();
  } catch (error) {
    console.error("Unable to reconnect QQ bot.", error);
    qqMessage = "QQ Bot 重连失败，请检查网络后重试";
  } finally {
    updateQQConfigView();
  }
}

async function reconnectFeishu(): Promise<void> {
  const channelId = feishuStatus?.channelId;
  if (!channelId || feishuStatus?.state === "connecting" || feishuStatus?.state === "reconnecting") return;

  feishuMessage = "正在重新连接飞书…";
  updateFeishuConfigView();
  try {
    const result = await api.channels.reconnect(channelId);
    feishuMessage = result.ok ? "飞书 Bot 重新连接成功" : result.detail;
    await refreshWeChatStatus();
  } catch (error) {
    console.error("Unable to reconnect Feishu bot.", error);
    feishuMessage = "飞书 Bot 重连失败，请检查网络后重试";
  } finally {
    updateFeishuConfigView();
  }
}

function markFirstUseGuideSeen(): void {
  firstUseGuideVisible = false;
  localStorage.setItem(FIRST_USE_GUIDE_KEY, "seen");
  updateFirstUseGuideView();
}

function showFirstUseHelp(): void {
  void showNotice("微信 Bot 连接", "这里连接的是微信 Bot，不是个人微信。已有会话可导入，没有会话请扫码添加 Bot。");
}

async function startWeChatQrLogin(): Promise<void> {
  if (isQrLoginActive()) return;
  if (wechatStatus.connected && !(await showConfirm("切换微信 Bot", "扫码登录会切换当前微信 Bot，会先停止当前连接。继续吗？"))) return;

  qrLoginState = { status: "requesting", detail: "正在生成二维码…" };
  updateWeChatQrLoginView();
  try {
    const result = await api.wechat.startQrLogin();
    if (!result.ok) {
      qrLoginState = { status: "error", detail: result.detail };
      updateWeChatQrLoginView();
    }
  } catch (error) {
    console.error("Unable to start WeChat QR login.", error);
    qrLoginState = { status: "error", detail: "二维码登录启动失败" };
    updateWeChatQrLoginView();
  }
}

async function cancelWeChatQrLogin(): Promise<void> {
  if (!isQrLoginActive()) return;
  try {
    await api.wechat.cancelQrLogin();
    qrLoginState = null;
    updateWeChatQrLoginView();
  } catch (error) {
    console.error("Unable to cancel WeChat QR login.", error);
  }
}

async function startQQQrLogin(): Promise<void> {
  if (isQQQrLoginActive()) return;
  if (qqStatus?.connected && !(await showConfirm("切换 QQ Bot", "扫码成功后会切换当前 QQ Bot。继续吗？"))) return;

  const displayNameInput = contentControl.querySelector<HTMLInputElement>('input[data-qq-config="displayName"]');
  const displayName = displayNameInput?.value.trim() ?? qqForm.displayName.trim();
  qqQrLoginState = { type: "qr-login", status: "requesting", detail: "正在申请 QQ 登录二维码" };
  updateQQQrLoginView();
  try {
    const result = await api.qq.startQrLogin(displayName);
    if (!result.ok) {
      qqQrLoginState = { type: "qr-login", status: "error", detail: result.detail };
      updateQQQrLoginView();
    }
  } catch (error) {
    console.error("Unable to start QQ QR login.", error);
    qqQrLoginState = { type: "qr-login", status: "error", detail: "QQ 二维码登录启动失败" };
    updateQQQrLoginView();
  }
}

async function cancelQQQrLogin(): Promise<void> {
  if (!isQQQrLoginCancellable()) return;
  try {
    const result = await api.qq.cancelQrLogin();
    if (!result.ok) {
      qqQrLoginState = { type: "qr-login", status: "error", detail: result.detail };
      updateQQQrLoginView();
      return;
    }
    qqQrLoginState = null;
    updateQQQrLoginView();
  } catch (error) {
    console.error("Unable to cancel QQ QR login.", error);
  }
}

function dismissQQQrLogin(): void {
  qqQrLoginState = null;
  updateQQQrLoginView();
}

async function startFeishuQrLogin(): Promise<void> {
  if (isFeishuQrLoginActive()) return;
  if (feishuStatus?.connected && !(await showConfirm("切换飞书 Bot", "扫码成功后会切换当前飞书 Bot。继续吗？"))) return;

  const displayNameInput = contentControl.querySelector<HTMLInputElement>('input[data-feishu-config="displayName"]');
  const displayName = displayNameInput?.value.trim() ?? feishuForm.displayName.trim();
  feishuQrLoginState = { type: "qr-login", status: "requesting", detail: "正在生成飞书二维码…" };
  updateFeishuQrLoginView();
  try {
    const result = await api.feishu.startQrLogin(displayName);
    if (!result.ok && feishuQrLoginState !== null && feishuQrLoginState.status !== "cancelled") {
      feishuQrLoginState = { type: "qr-login", status: "error", detail: result.detail };
      updateFeishuQrLoginView();
    }
  } catch (error) {
    console.error("Unable to start Feishu QR login.", error);
    feishuQrLoginState = { type: "qr-login", status: "error", detail: "飞书二维码启动失败" };
    updateFeishuQrLoginView();
  }
}

async function cancelFeishuQrLogin(): Promise<void> {
  if (!isFeishuQrLoginCancellable()) return;
  try {
    const result = await api.feishu.cancelQrLogin();
    if (!result.ok) {
      feishuQrLoginState = { type: "qr-login", status: "error", detail: result.detail };
      updateFeishuQrLoginView();
      return;
    }
    feishuQrLoginState = null;
    updateFeishuQrLoginView();
  } catch (error) {
    console.error("Unable to cancel Feishu QR login.", error);
  }
}

function dismissFeishuQrLogin(): void {
  feishuQrLoginState = null;
  updateFeishuQrLoginView();
}

function dismissWeChatQrLogin(): void {
  qrLoginState = null;
  updateWeChatQrLoginView();
}

function toggleWeChatSecret(revealButton: HTMLElement): void {
  const id = revealButton.dataset.revealWechatId;
  const container = revealButton.closest<HTMLElement>(".wechat-account-row, .wechat-qr-login__account");
  const valueElement = container?.querySelector<HTMLElement>("[data-wechat-secret-value]");
  if (!id || !valueElement) return;

  const revealed = !revealedWeChatIds.has(id);
  if (revealed) revealedWeChatIds.add(id);
  else revealedWeChatIds.delete(id);

  const secretValue = valueElement.dataset.wechatSecretValue ?? "";
  valueElement.textContent = valueElement.parentElement?.classList.contains("wechat-qr-login__account")
    ? `Bot：${revealed ? secretValue : "••••••••"}`
    : revealed ? secretValue : "••••••••";
  revealButton.setAttribute("aria-label", `${revealed ? "隐藏" : "显示"} Bot 标识`);
  revealButton.setAttribute("title", `${revealed ? "隐藏" : "显示"} Bot 标识`);
  revealButton.setAttribute("aria-pressed", String(revealed));
  revealButton.innerHTML = renderWeChatVisibilityIcon(revealed);
}

async function refreshWeChatQrLoginStatus(): Promise<void> {
  try {
    const event = await api.wechat.getQrLoginStatus();
    if (event) {
      qrLoginState = {
        status: event.status,
        detail: event.detail,
        qrDataUrl: event.qrDataUrl,
        accountId: event.accountId,
      };
      updateWeChatQrLoginView();
    }
  } catch (error) {
    console.error("Unable to read WeChat QR login status.", error);
  }
}

async function refreshQQQrLoginStatus(): Promise<void> {
  try {
    qqQrLoginState = await api.qq.getQrLoginStatus();
    updateQQQrLoginView();
  } catch (error) {
    console.error("Unable to read QQ QR login status.", error);
  }
}

async function refreshFeishuQrLoginStatus(): Promise<void> {
  try {
    feishuQrLoginState = await api.feishu.getQrLoginStatus();
    updateFeishuQrLoginView();
  } catch (error) {
    console.error("Unable to read Feishu QR login status.", error);
  }
}

async function syncQQSettingsAfterQrLogin(): Promise<void> {
  try {
    const settings = await api.settings.get();
    persistedSettings = cloneSettings(settings);
    if (!draftSettings || !dirty) {
      draftSettings = cloneSettings(settings);
    } else {
      draftSettings = {
        ...draftSettings,
        qqAccounts: settings.qqAccounts.map((account) => ({ ...account })),
        activeQQAccountId: settings.activeQQAccountId,
      };
    }
    const active = settings.qqAccounts.find((account) => account.id === settings.activeQQAccountId) ?? settings.qqAccounts[0];
    initializeQQForm(active);
    if (currentPage === "qq" || currentPage === "bots") render(false);
    await refreshWeChatStatus();
  } catch (error) {
    console.error("Unable to refresh QQ settings after QR login.", error);
  }
}

async function syncFeishuSettingsAfterQrLogin(): Promise<void> {
  try {
    const settings = await api.settings.get();
    persistedSettings = cloneSettings(settings);
    if (!draftSettings || !dirty) {
      draftSettings = cloneSettings(settings);
    } else {
      draftSettings = {
        ...draftSettings,
        feishuAccounts: settings.feishuAccounts.map((account) => ({ ...account })),
        activeFeishuAccountId: settings.activeFeishuAccountId,
      };
    }
    const active = settings.feishuAccounts.find((account) => account.id === settings.activeFeishuAccountId) ?? settings.feishuAccounts[0];
    initializeFeishuForm(active);
    if (currentPage === "feishu" || currentPage === "bots") render(false);
    await refreshWeChatStatus();
  } catch (error) {
    console.error("Unable to refresh Feishu settings after QR login.", error);
  }
}

async function importWeChatSession(): Promise<void> {
  if (importingWeChat) return;
  importingWeChat = true;
  updateWeChatImportView();
  try {
    const result = await api.wechat.importSession();
    if (!result.canceled) {
      wechatStatus = {
        ...wechatStatus,
        state: result.ok ? "connecting" : "failed",
        connected: false,
        detail: result.detail,
        lastError: result.ok ? "" : result.detail,
        nextRetryAt: null,
      };
      await refreshWeChatStatus();
      if (!result.ok) await showNotice("会话导入失败", result.detail);
    }
  } catch (error) {
    console.error("Unable to import WeChat session.", error);
    wechatStatus = {
      ...wechatStatus,
      state: "failed",
      connected: false,
      detail: "微信会话导入失败",
      lastError: "微信会话导入失败",
      nextRetryAt: null,
    };
    await showNotice("会话导入失败", wechatStatus.detail);
  } finally {
    importingWeChat = false;
    updateWeChatImportView();
  }
}

async function switchWeChatAccount(accountId: string): Promise<void> {
  if (importingWeChat || loggingOutWeChat || !draftSettings) return;
  importingWeChat = true;
  updateWeChatAccountView();
  try {
    const result = await api.wechat.switchAccount(accountId);
    if (!result.ok) {
      await showNotice("切换会话失败", result.detail);
      return;
    }
    await refreshWeChatStatus();
    const account = draftSettings.wechatAccounts.find((item) => item.id === accountId);
    if (account) {
      draftSettings = {
        ...draftSettings,
        activeWeChatAccountId: account.id,
        wechatTokenFile: account.tokenFile,
        wechatEnabled: true,
      };
    }
  } catch (error) {
    console.error("Unable to switch WeChat account.", error);
    await showNotice("切换会话失败", "切换微信 Bot 会话失败");
  } finally {
    importingWeChat = false;
    updateWeChatAccountView();
    updateWeChatImportView();
  }
}

async function logoutWeChatSession(): Promise<void> {
  if (loggingOutWeChat || !draftSettings || (!draftSettings.wechatEnabled && !wechatStatus.connected)) return;
  if (!(await showConfirm("退出微信 Bot 会话", "退出当前微信 Bot 会话？本地 token 文件会保留，之后仍可重新导入。", { confirmLabel: "退出" }))) return;
  loggingOutWeChat = true;
  updateWeChatLogoutView();
  try {
    const result = await api.wechat.logout();
    if (!result.ok) {
      await showNotice("退出失败", result.detail);
      return;
    }
    wechatStatus = {
      ...wechatStatus,
      state: "logged-out",
      connected: false,
      detail: result.detail,
      nextRetryAt: null,
    };
    draftSettings = { ...draftSettings, wechatEnabled: false };
    updateWeChatAccountView();
    updateWeChatLogoutView();
  } catch (error) {
    console.error("Unable to log out from WeChat session.", error);
    await showNotice("退出失败", "退出微信 Bot 会话失败");
  } finally {
    loggingOutWeChat = false;
    updateWeChatLogoutView();
  }
}

function updateDraft(update: Partial<PetSettings>): void {
  if (!draftSettings) return;
  draftSettings = { ...draftSettings, ...update };
  dirty = true;
  perceptionAutoSaveError = false;
  updateSaveStateView();
}

async function saveAll(): Promise<boolean> {
  if (!draftSettings || saving) return false;
  saving = true;
  updateSaveStateView();
  try {
    const saved = await api.settings.update(draftSettings);
    persistedSettings = cloneSettings(saved);
    draftSettings = cloneSettings(saved);
    dirty = false;
    perceptionAutoSaveError = false;
    return true;
  } catch (error) {
    console.error("Unable to save pet settings.", error);
    perceptionAutoSaveError = true;
    await showNotice("保存失败", "设置保存失败，请稍后重试。");
    return false;
  } finally {
    saving = false;
    updateSaveStateView();
  }
}

function schedulePerceptionAutoSave(): void {
  if (perceptionAutoSaveTimer !== null) window.clearTimeout(perceptionAutoSaveTimer);
  perceptionAutoSaveTimer = window.setTimeout(() => {
    perceptionAutoSaveTimer = null;
    if (draftSettings?.petPerception) void saveAll();
  }, 260);
}

function applyPetStyleActionResult(result: { settings?: PetSettings; style?: PetStyle }): void {
  if (!draftSettings || !result.settings) return;
  const next = cloneSettings(result.settings);
  const activeId = draftSettings.activePetStyleId;
  persistedSettings = next;
  draftSettings = {
    ...draftSettings,
    petStyles: next.petStyles,
    activePetStyleId: next.petStyles.some((style) => style.id === activeId) ? activeId : next.activePetStyleId,
  };
  if (result.style) petStyleEditorId = result.style.id;
}

async function importPetStyle(): Promise<void> {
  if (importingPetStyle || !draftSettings) return;
  importingPetStyle = true;
  petStyleMessage = "正在导入宠物风格…";
  petStyleMessageTone = "info";
  updatePetStyleView();
  try {
    const result = await api.petStyles.importFolder();
    applyPetStyleActionResult(result);
    if (result.style) petStyleEditorId = result.style.id;
    petStyleMessage = result.detail;
    petStyleMessageTone = result.ok ? "success" : result.canceled ? "info" : "error";
  } catch (error) {
    console.error("Unable to import pet style.", error);
    petStyleMessage = "宠物风格导入失败，请稍后重试。";
    petStyleMessageTone = "error";
  } finally {
    importingPetStyle = false;
    updatePetStyleView();
    updateSaveStateView();
  }
}

async function importPetStyleState(styleId: string, state: PetState): Promise<void> {
  if (importingPetStyle || !draftSettings) return;
  importingPetStyle = true;
  petStyleMessage = "正在导入这个宠物状态…";
  petStyleMessageTone = "info";
  updatePetStyleView();
  try {
    const result = await api.petStyles.importState(styleId, state);
    applyPetStyleActionResult(result);
    // The built-in library has no canonical-state import action. Keep the
    // selected editor stable for imported styles and custom-state additions.
    if (result.style && draftSettings?.petStyles.find((style) => style.id === styleId)?.source === "builtin") {
      petStyleEditorId = styleId;
    } else if (result.style) {
      petStyleEditorId = result.style.id;
    }
    petStyleMessage = result.detail;
    petStyleMessageTone = result.ok ? "success" : result.canceled ? "info" : "error";
  } catch (error) {
    console.error("Unable to import pet style state.", error);
    petStyleMessage = "宠物状态导入失败，请稍后重试。";
    petStyleMessageTone = "error";
  } finally {
    importingPetStyle = false;
    updatePetStyleView();
  }
}

function beginPetStyleRename(styleId: string): void {
  if (importingPetStyle) return;
  petStyleRenameId = styleId;
  updatePetStyleView();
  window.setTimeout(() => contentControl.querySelector<HTMLInputElement>(`[data-pet-style-name-input="${CSS.escape(styleId)}"]`)?.select(), 0);
}

function cancelPetStyleRename(): void {
  petStyleRenameId = null;
  updatePetStyleView();
}

async function renamePetStyle(styleId: string, nameValue: string): Promise<void> {
  if (importingPetStyle || !draftSettings) return;
  const name = nameValue.trim();
  if (!name) {
    petStyleMessage = "风格名称不能为空";
    petStyleMessageTone = "error";
    updatePetStyleView();
    return;
  }
  importingPetStyle = true;
  petStyleRenameId = null;
  try {
    const result = await api.petStyles.rename(styleId, name);
    applyPetStyleActionResult(result);
    petStyleMessage = result.detail;
    petStyleMessageTone = result.ok ? "success" : "error";
  } catch (error) {
    console.error("Unable to rename pet style.", error);
    petStyleMessage = "风格改名失败，请稍后重试。";
    petStyleMessageTone = "error";
  } finally {
    importingPetStyle = false;
    updatePetStyleView();
  }
}

function openCustomPetStateForm(): void {
  if (importingPetStyle || !draftSettings) return;
  customStateFormOpen = true;
  petStyleMessage = "";
  petStyleMessageTone = "info";
  updatePetStyleView();
}

function closeCustomPetStateForm(): void {
  customStateFormOpen = false;
  updatePetStyleView();
}

async function addCustomPetState(nameValue: string): Promise<void> {
  if (importingPetStyle || !draftSettings) return;
  const styleId = petStyleEditorId;
  const name = nameValue.trim();
  if (!name) {
    petStyleMessage = "请先填写自定义状态名称。";
    petStyleMessageTone = "error";
    updatePetStyleView();
    return;
  }
  customStateFormOpen = false;
  importingPetStyle = true;
  petStyleMessage = "正在添加自定义状态…";
  petStyleMessageTone = "info";
  updatePetStyleView();
  try {
    const result = await api.petStyles.addCustomState(styleId, name);
    applyPetStyleActionResult(result);
    if (result.style && draftSettings?.petStyles.find((style) => style.id === styleId)?.source === "builtin") {
      petStyleEditorId = styleId;
    } else if (result.style) {
      petStyleEditorId = result.style.id;
    }
    petStyleMessage = result.detail;
    petStyleMessageTone = result.ok ? "success" : result.canceled ? "info" : "error";
  } catch (error) {
    console.error("Unable to add custom pet state.", error);
    petStyleMessage = "自定义状态添加失败，请稍后重试。";
    petStyleMessageTone = "error";
  } finally {
    importingPetStyle = false;
    updatePetStyleView();
  }
}

async function removeCustomPetState(styleId: string, stateId: string): Promise<void> {
  if (importingPetStyle || !draftSettings) return;
  const style = draftSettings.petStyles.find((item) => item.id === styleId);
  const customState = style?.customStates?.find((item) => item.id === stateId);
  if (!style || !customState || !(await showConfirm("删除自定义状态", "确定删除这个自定义宠物状态吗？", { confirmLabel: "删除", danger: true }))) return;
  importingPetStyle = true;
  petStyleMessage = "正在删除自定义状态…";
  updatePetStyleView();
  try {
    const result = await api.petStyles.removeCustomState(styleId, stateId);
    applyPetStyleActionResult(result);
    petStyleMessage = result.detail;
  } catch (error) {
    console.error("Unable to remove custom pet state.", error);
    petStyleMessage = "自定义状态删除失败，请稍后重试。";
  } finally {
    importingPetStyle = false;
    updatePetStyleView();
  }
}
async function removePetStyle(styleId: string): Promise<void> {
  if (!draftSettings || styleId === "default-penguin") return;
  const style = draftSettings.petStyles.find((item) => item.id === styleId);
  if (!style || !(await showConfirm("删除宠物风格", `确认删除宠物风格“${style.name}”？\n\n对应的本机视频文件也会被删除，默认企鹅不受影响。`, { confirmLabel: "删除", danger: true }))) return;
  try {
    const result = await api.petStyles.remove(styleId);
    if (result.settings) {
      const next = cloneSettings(result.settings);
      persistedSettings = next;
      draftSettings = {
        ...draftSettings,
        petStyles: next.petStyles,
        activePetStyleId: draftSettings.activePetStyleId === styleId ? "default-penguin" : draftSettings.activePetStyleId,
      };
      dirty = true;
    }
    petStyleMessage = result.detail;
  } catch (error) {
    console.error("Unable to remove pet style.", error);
    petStyleMessage = "宠物风格删除失败，请稍后重试。";
  }
  updatePetStyleView();
  updateSaveStateView();
}

async function close(): Promise<void> {
  if (saving || closing) return;
  if (dirty) {
    leavePromptControl.hidden = false;
    leaveContinueButtonControl.focus();
    return;
  }
  closing = true;
  await cancelQrLoginBeforeClose();
  await api.settings.close();
}

function initializeQQForm(account?: { id: string; displayName: string; appId: string }): void {
  qqForm = {
    id: account?.id ?? "",
    displayName: account?.displayName ?? "",
    appId: account?.appId ?? "",
    clientSecret: "",
  };
  qqMessage = "";
}

function updateQQForm(target: HTMLInputElement): void {
  const key = target.dataset.qqConfig;
  if (key !== "displayName" && key !== "appId" && key !== "clientSecret") return;
  qqForm = { ...qqForm, [key]: target.value };
}

async function saveQQConfig(): Promise<void> {
  if (qqSaving) return;
  if (!qqForm.displayName.trim() || !qqForm.appId.trim()) {
    qqMessage = "请先填写显示名称和 AppID";
    updateQQConfigView();
    return;
  }
  qqSaving = true;
  qqMessage = "正在保存凭据并连接 QQ 网关…";
  updateQQConfigView();
  try {
    const result = await api.qq.configure({
      id: qqForm.id || undefined,
      displayName: qqForm.displayName.trim(),
      appId: qqForm.appId.trim(),
      clientSecret: qqForm.clientSecret.trim() || undefined,
      agentId: draftSettings?.qqAccounts.find((account) => account.id === qqForm.id)?.agentId,
    });
    if (!result.ok) {
      qqMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.qqAccounts.find((account) => account.id === result.settings?.activeQQAccountId) ?? result.settings.qqAccounts[0];
      initializeQQForm(active);
    }
    qqMessage = `QQ 机器人配置保存成功：${result.detail}`;
    render();
  } catch (error) {
    console.error("Unable to configure QQ bot.", error);
    qqMessage = "QQ 机器人配置失败，请检查凭据和网络";
  } finally {
    qqSaving = false;
    updateQQConfigView();
  }
}

async function removeQQConfig(): Promise<void> {
  if (qqSaving || !draftSettings) return;
  const account = draftSettings.qqAccounts.find((item) => item.id === draftSettings?.activeQQAccountId) ?? draftSettings.qqAccounts[0];
  if (!account || !(await showConfirm("移除 QQ 配置", `确定移除「${account.displayName}」的 QQ 配置吗？`, { confirmLabel: "移除", danger: true }))) return;
  qqSaving = true;
  qqMessage = "正在移除 QQ 机器人…";
  updateQQConfigView();
  try {
    const result = await api.qq.remove(account.id);
    if (!result.ok) {
      qqMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.qqAccounts.find((item) => item.id === result.settings?.activeQQAccountId) ?? result.settings.qqAccounts[0];
      initializeQQForm(active);
    }
    qqStatus = null;
    qqMessage = result.detail;
    render();
  } catch (error) {
    console.error("Unable to remove QQ bot.", error);
    qqMessage = "QQ 机器人移除失败，请稍后重试";
  } finally {
    qqSaving = false;
    updateQQConfigView();
  }
}

function initializeFeishuForm(account?: { id: string; displayName: string; appId: string }): void {
  feishuForm = {
    id: account?.id ?? "",
    displayName: account?.displayName ?? "",
    appId: account?.appId ?? "",
    appSecret: "",
  };
  feishuMessage = "";
}

function updateFeishuForm(target: HTMLInputElement): void {
  const key = target.dataset.feishuConfig;
  if (key !== "displayName" && key !== "appId" && key !== "appSecret") return;
  feishuForm = { ...feishuForm, [key]: target.value };
}

async function saveFeishuConfig(): Promise<void> {
  if (feishuSaving) return;
  if (!feishuForm.displayName.trim() || !feishuForm.appId.trim()) {
    feishuMessage = "请先填写显示名称和 AppID";
    updateFeishuConfigView();
    return;
  }
  feishuSaving = true;
  feishuMessage = "正在保存凭据并连接飞书…";
  updateFeishuConfigView();
  try {
    const result = await api.feishu.configure({
      id: feishuForm.id || undefined,
      displayName: feishuForm.displayName.trim(),
      appId: feishuForm.appId.trim(),
      appSecret: feishuForm.appSecret.trim() || undefined,
      agentId: draftSettings?.feishuAccounts.find((account) => account.id === feishuForm.id)?.agentId,
    });
    if (!result.ok) {
      feishuMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.feishuAccounts.find((account) => account.id === result.settings?.activeFeishuAccountId) ?? result.settings.feishuAccounts[0];
      initializeFeishuForm(active);
    }
    feishuMessage = `飞书机器人配置保存成功：${result.detail}`;
    render();
  } catch (error) {
    console.error("Unable to configure Feishu bot.", error);
    feishuMessage = "飞书机器人配置失败，请检查凭据和网络";
  } finally {
    feishuSaving = false;
    updateFeishuConfigView();
  }
}

async function removeFeishuConfig(): Promise<void> {
  if (feishuSaving || !draftSettings) return;
  const account = draftSettings.feishuAccounts.find((item) => item.id === draftSettings?.activeFeishuAccountId) ?? draftSettings.feishuAccounts[0];
  if (!account || !(await showConfirm("移除飞书配置", `确定移除「${account.displayName}」的飞书配置吗？`, { confirmLabel: "移除", danger: true }))) return;
  feishuSaving = true;
  feishuMessage = "正在移除飞书机器人…";
  updateFeishuConfigView();
  try {
    const result = await api.feishu.remove(account.id);
    if (!result.ok) {
      feishuMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.feishuAccounts.find((item) => item.id === result.settings?.activeFeishuAccountId) ?? result.settings.feishuAccounts[0];
      initializeFeishuForm(active);
    }
    feishuStatus = null;
    feishuMessage = result.detail;
    render();
  } catch (error) {
    console.error("Unable to remove Feishu bot.", error);
    feishuMessage = "飞书机器人移除失败，请稍后重试";
  } finally {
    feishuSaving = false;
    updateFeishuConfigView();
  }
}

function initializeDingTalkForm(account?: { id: string; displayName: string; clientId: string }): void {
  dingtalkForm = {
    id: account?.id ?? "",
    displayName: account?.displayName ?? "",
    clientId: account?.clientId ?? "",
    clientSecret: "",
  };
  dingtalkMessage = "";
}

function updateDingTalkForm(target: HTMLInputElement): void {
  const key = target.dataset.dingtalkConfig;
  if (key !== "displayName" && key !== "clientId" && key !== "clientSecret") return;
  dingtalkForm = { ...dingtalkForm, [key]: target.value };
}

async function openDingTalkGuide(url: string, label: string): Promise<void> {
  dingtalkMessage = `正在打开钉钉${label}…`;
  updateDingTalkConfigView();
  try {
    const result = await api.links.openExternal(url);
    dingtalkMessage = result.ok ? `已成功打开钉钉${label}` : result.detail;
  } catch (error) {
    console.error(`Unable to open DingTalk ${label}.`, error);
    dingtalkMessage = `钉钉${label}打开失败，请稍后重试`;
  }
  updateDingTalkConfigView();
}

async function reconnectDingTalk(): Promise<void> {
  if (dingtalkStatus?.state === "connecting" || dingtalkStatus?.state === "reconnecting") return;
  dingtalkMessage = "正在重新连接钉钉 Stream…";
  updateDingTalkConfigView();
  try {
    const account = draftSettings?.dingtalkAccounts.find((item) => item.id === draftSettings?.activeDingTalkAccountId) ?? draftSettings?.dingtalkAccounts[0];
    const result = account ? await api.channels.reconnect(`dingtalk:${account.id.replace(/^dingtalk:/, "")}`) : { ok: false, detail: "尚未配置钉钉机器人" };
    dingtalkMessage = result.ok ? "钉钉机器人重连成功" : result.detail;
  } catch (error) {
    console.error("Unable to reconnect DingTalk bot.", error);
    dingtalkMessage = "钉钉机器人重连失败，请检查网络后重试";
  } finally {
    updateDingTalkConfigView();
  }
}

async function saveDingTalkConfig(): Promise<void> {
  if (dingtalkSaving) return;
  if (!dingtalkForm.displayName.trim() || !dingtalkForm.clientId.trim()) {
    dingtalkMessage = "请先填写显示名称和 Client ID";
    updateDingTalkConfigView();
    return;
  }
  dingtalkSaving = true;
  dingtalkMessage = "正在保存凭据并连接钉钉 Stream…";
  updateDingTalkConfigView();
  try {
    const result = await api.dingtalk.configure({
      id: dingtalkForm.id || undefined,
      displayName: dingtalkForm.displayName.trim(),
      clientId: dingtalkForm.clientId.trim(),
      clientSecret: dingtalkForm.clientSecret.trim() || undefined,
      agentId: draftSettings?.dingtalkAccounts.find((account) => account.id === dingtalkForm.id)?.agentId,
    });
    if (!result.ok) {
      dingtalkMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.dingtalkAccounts.find((account) => account.id === result.settings?.activeDingTalkAccountId) ?? result.settings.dingtalkAccounts[0];
      initializeDingTalkForm(active);
    }
    dingtalkMessage = `钉钉机器人配置保存成功：${result.detail}`;
    render();
  } catch (error) {
    console.error("Unable to configure DingTalk bot.", error);
    dingtalkMessage = "钉钉机器人配置失败，请检查凭据和网络";
  } finally {
    dingtalkSaving = false;
    updateDingTalkConfigView();
  }
}

async function removeDingTalkConfig(): Promise<void> {
  if (dingtalkSaving || !draftSettings) return;
  const account = draftSettings.dingtalkAccounts.find((item) => item.id === draftSettings?.activeDingTalkAccountId) ?? draftSettings.dingtalkAccounts[0];
  if (!account || !(await showConfirm("移除钉钉配置", `确定移除「${account.displayName}」的钉钉配置吗？`, { confirmLabel: "移除", danger: true }))) return;
  dingtalkSaving = true;
  dingtalkMessage = "正在移除钉钉机器人…";
  updateDingTalkConfigView();
  try {
    const result = await api.dingtalk.remove(account.id);
    if (!result.ok) {
      dingtalkMessage = result.detail;
      return;
    }
    if (result.settings) {
      persistedSettings = cloneSettings(result.settings);
      draftSettings = cloneSettings(result.settings);
      dirty = false;
      const active = result.settings.dingtalkAccounts.find((item) => item.id === result.settings?.activeDingTalkAccountId) ?? result.settings.dingtalkAccounts[0];
      initializeDingTalkForm(active);
    }
    dingtalkStatus = null;
    dingtalkMessage = result.detail;
    render();
  } catch (error) {
    console.error("Unable to remove DingTalk bot.", error);
    dingtalkMessage = "钉钉机器人移除失败，请稍后重试";
  } finally {
    dingtalkSaving = false;
    updateDingTalkConfigView();
  }
}

function updateDingTalkStatusView(): void {
  const statusElement = contentControl.querySelector<HTMLElement>("#settings-dingtalk-status");
  if (statusElement) {
    statusElement.dataset.status = dingtalkStatus?.state ?? "disconnected";
    statusElement.textContent = dingtalkStatus ? channelStateLabel(dingtalkStatus) : "未配置";
  }
  const detailElement = contentControl.querySelector<HTMLElement>("#dingtalk-connection-detail");
  if (detailElement) {
    detailElement.dataset.status = dingtalkStatus?.state ?? "disconnected";
    detailElement.textContent = dingtalkStatus?.detail ?? "填写凭据后连接钉钉 Stream";
  }
  const reconnectButton = contentControl.querySelector<HTMLButtonElement>("#dingtalk-reconnect");
  if (reconnectButton) reconnectButton.disabled = !dingtalkStatus || dingtalkStatus.state === "connecting" || dingtalkStatus.state === "reconnecting";
}

function updateDingTalkConfigView(): void {
  const saveButton = contentControl.querySelector<HTMLButtonElement>("#dingtalk-save-config");
  if (saveButton) {
    saveButton.disabled = dingtalkSaving;
    saveButton.textContent = dingtalkSaving ? "正在保存…" : "保存并连接";
  }
  const removeButton = contentControl.querySelector<HTMLButtonElement>("#dingtalk-remove-config");
  if (removeButton) removeButton.disabled = dingtalkSaving || !draftSettings?.dingtalkAccounts.length;
  const message = contentControl.querySelector<HTMLElement>("#dingtalk-config-message");
  if (message) {
    message.textContent = dingtalkMessage || "未连接";
    message.classList.toggle("is-error", Boolean(dingtalkMessage && !dingtalkMessage.includes("成功")));
  }
  updateDingTalkStatusView();
}

async function cancelQrLoginBeforeClose(): Promise<void> {
  if (isQrLoginActive()) {
    try {
      await api.wechat.cancelQrLogin();
    } catch (error) {
      console.error("Unable to cancel WeChat QR login before closing settings.", error);
    } finally {
      qrLoginState = null;
    }
  }
  if (isQQQrLoginActive()) {
    try {
      await api.qq.cancelQrLogin();
    } catch (error) {
      console.error("Unable to cancel QQ QR login before closing settings.", error);
    } finally {
      qqQrLoginState = null;
    }
  }
  if (isFeishuQrLoginActive()) {
    try {
      await api.feishu.cancelQrLogin();
    } catch (error) {
      console.error("Unable to cancel Feishu QR login before closing settings.", error);
    } finally {
      feishuQrLoginState = null;
    }
  }
}

async function handleLeaveChoice(choice: "continue" | "discard" | "save"): Promise<void> {
  if (choice === "continue") {
    leavePromptControl.hidden = true;
    return;
  }

  if (choice === "discard") {
    draftSettings = persistedSettings ? cloneSettings(persistedSettings) : draftSettings;
    dirty = false;
    leavePromptControl.hidden = true;
    closing = true;
    await cancelQrLoginBeforeClose();
    await api.settings.close();
    return;
  }

  closing = true;
  const saved = await saveAll();
  if (!saved) {
    closing = false;
    return;
  }
  await cancelQrLoginBeforeClose();
  leavePromptControl.hidden = true;
  await api.settings.close();
}

async function handleSettingChange(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): Promise<void> {
  const key = target.dataset.setting;
  if (!key || !draftSettings) return;

  if (key === "botAgentBinding" && target instanceof HTMLSelectElement) {
    const platform = target.dataset.botAgentPlatform;
    const accountId = target.dataset.botAgentAccountId;
    if (!accountId || !target.value) return;
    if (platform === "wechat") {
      updateDraft({ wechatAccounts: draftSettings.wechatAccounts.map((account) => account.id === accountId ? { ...account, agentId: target.value } : account) });
    } else if (platform === "qq") {
      updateDraft({ qqAccounts: draftSettings.qqAccounts.map((account) => account.id === accountId ? { ...account, agentId: target.value } : account) });
    } else if (platform === "feishu") {
      updateDraft({ feishuAccounts: draftSettings.feishuAccounts.map((account) => account.id === accountId ? { ...account, agentId: target.value } : account) });
    } else if (platform === "dingtalk") {
      updateDraft({ dingtalkAccounts: draftSettings.dingtalkAccounts.map((account) => account.id === accountId ? { ...account, agentId: target.value } : account) });
    }
    return;
  }

  if ((key === "botTaskNotificationEnabled" || key === "botTaskNotificationMode")
    && (target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    const platform = target.dataset.botTaskPlatform;
    const accountId = target.dataset.botTaskAccountId;
    if (!accountId || (platform !== "wechat" && platform !== "qq" && platform !== "feishu" && platform !== "dingtalk")) return;
    const enabled = key === "botTaskNotificationEnabled" && target instanceof HTMLInputElement
      ? target.checked
      : undefined;
    const mode = key === "botTaskNotificationMode" && target instanceof HTMLSelectElement
      && (target.value === "detail" || target.value === "timed" || target.value === "completion" || target.value === "plan")
      ? target.value as TaskNotificationMode
      : undefined;
    const patchAccount = <T extends { id: string; taskNotificationEnabled: boolean; taskNotificationMode: TaskNotificationMode }>(account: T): T => ({
      ...account,
      ...(enabled === undefined ? {} : { taskNotificationEnabled: enabled }),
      ...(mode === undefined ? {} : { taskNotificationMode: mode }),
    });
    if (platform === "wechat") updateDraft({ wechatAccounts: draftSettings.wechatAccounts.map((account) => account.id === accountId ? patchAccount(account) : account) });
    if (platform === "qq") updateDraft({ qqAccounts: draftSettings.qqAccounts.map((account) => account.id === accountId ? patchAccount(account) : account) });
    if (platform === "feishu") updateDraft({ feishuAccounts: draftSettings.feishuAccounts.map((account) => account.id === accountId ? patchAccount(account) : account) });
    if (platform === "dingtalk") updateDraft({ dingtalkAccounts: draftSettings.dingtalkAccounts.map((account) => account.id === accountId ? patchAccount(account) : account) });
    updateBotTaskNotificationView();
    return;
  }

  if (key === "petPerception") {
    const rawPerceptionKey = target.dataset.perceptionSetting;
    if (!rawPerceptionKey) return;
    if (rawPerceptionKey === "sourceScope" && target instanceof HTMLSelectElement) {
      const scope = target.value as PerceptionSourceScope;
      const sourcePatch = perceptionSourceScopePatch(scope);
      if (!sourcePatch) return;
      updateDraft({
        petPerception: {
          ...draftSettings.petPerception,
          ...sourcePatch,
        },
      });
      updatePetPerceptionView();
      schedulePerceptionAutoSave();
      return;
    }
    if (rawPerceptionKey === "feedbackMode" && target instanceof HTMLSelectElement) {
      const feedback = target.value === "full"
        ? { actionFeedback: true, bubbleFeedback: true }
        : target.value === "action"
          ? { actionFeedback: true, bubbleFeedback: false }
          : target.value === "bubble"
            ? { actionFeedback: false, bubbleFeedback: true }
            : { actionFeedback: false, bubbleFeedback: false };
      updateDraft({
        petPerception: {
          ...draftSettings.petPerception,
          ...feedback,
        },
      });
      updatePetPerceptionView();
      schedulePerceptionAutoSave();
      return;
    }
    if (rawPerceptionKey === "digestMode" && target instanceof HTMLSelectElement) {
      updateDraft({
        petPerception: {
          ...draftSettings.petPerception,
          longTaskReplyEnabled: target.value === "on",
        },
      });
      updatePetPerceptionView();
      schedulePerceptionAutoSave();
      return;
    }
    const perceptionKey = rawPerceptionKey as keyof PetPerceptionSettings;
    const value = target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target instanceof HTMLInputElement && target.type === "number"
        ? Number(target.value)
        : target.value;
    updateDraft({
      petPerception: {
        ...draftSettings.petPerception,
        [perceptionKey]: value,
      },
    });
    updatePetPerceptionView();
    schedulePerceptionAutoSave();
    return;
  }

  if (key === "agentAccessMode" && target instanceof HTMLSelectElement
    && (target.value === "read-only" || target.value === "workspace-write" || target.value === "danger-full-access")) {
    const mode = target.value as AgentAccessMode;
    if (mode !== "read-only" && !(await showConfirm("切换 Agent 访问模式", `Agent 切换到“${agentAccessModeLabel(mode)}”后可能修改本地文件或执行命令。确定继续吗？`))) {
      target.value = agentAccessMode(draftSettings);
      return;
    }
    updateDraft(agentAccessModeUpdate(mode));
    return;
  }

  if (key === "agentFullAccess" && target instanceof HTMLInputElement && target.type === "checkbox") {
    if (target.checked && !(await showConfirm("开启完整访问权限", "开启完整访问权限后，机器人绑定的 Agent 将默认允许工具、文件、网络和命令执行。确定继续吗？"))) {
      target.checked = false;
      return;
    }
    updateDraft(target.checked
      ? {
        agentFullAccess: true,
        agentPermissionPolicy: "allow-tools",
        agentCapabilityPolicy: fullAgentCapabilityPolicy(),
        codexSandboxMode: "danger-full-access",
      }
      : { agentFullAccess: false });
    return;
  }

  if (key === "agentPermissionPolicy" && target instanceof HTMLInputElement && target.type === "checkbox") {
    if (target.checked && !(await showConfirm("开启工具权限", "开启工具权限后，Agent 可能读写工作区或调用桌面工具。确定继续吗？"))) {
      target.checked = false;
      return;
    }
    updateDraft({ agentPermissionPolicy: target.checked ? "allow-tools" : "chat-only" });
    return;
  }

  if (key === "agentFallbackIds" && target instanceof HTMLSelectElement && target.multiple) {
    updateDraft({ agentFallbackIds: Array.from(target.selectedOptions).map((option) => option.value) });
    return;
  }

  if (key === "agentApprovalMode" && (target.value === "read-only" || target.value === "risk-based" || target.value === "always")) {
    updateDraft({ agentApprovalMode: target.value });
    return;
  }

  if (key === "agentCapabilityPolicy") {
    const capability = target.dataset.capability;
    const permission = target.value;
    if (!capability || !isAgentCapability(capability) || !(permission in AGENT_PERMISSION_LABELS)) return;
    const currentPolicy = draftSettings.agentCapabilityPolicy ?? defaultAgentCapabilityPolicy();
    const highRiskCapabilities: AgentCapability[] = [
      "file.write",
      "shell.exec",
      "process.control",
      "screen.capture",
      "network.request",
      "external.send",
      "agent.dispatch",
    ];
    if (permission === "allow" && currentPolicy[capability] === "deny" && highRiskCapabilities.includes(capability)) {
      const label = AGENT_CAPABILITY_LABELS[capability];
      if (!(await showConfirm("开启高风险能力", `允许“${label}”后，机器人绑定的 Agent 可能执行高风险操作。确定继续吗？`))) {
        target.value = currentPolicy[capability];
        return;
      }
    }
    updateDraft({
      agentCapabilityPolicy: {
        ...currentPolicy,
        [capability]: permission as AgentCapabilityPermission,
      },
    });
    return;
  }

  if (key === "zeroTokenEnabled" && target instanceof HTMLInputElement && target.type === "checkbox") {
    updateDraft({ zeroToken: { ...draftSettings.zeroToken, enabled: target.checked } });
    zeroTokenStatus = null;
    zeroTokenMessage = "";
    updateZeroTokenView();
    if (target.checked) void checkZeroTokenConnectionFromSettings();
    return;
  }

  if (key === "ccSwitchSyncEnabled" && target instanceof HTMLInputElement && target.type === "checkbox") {
    updateDraft({ ccSwitchSyncEnabled: target.checked });
    if (!target.checked) {
      ccSwitchStatus = null;
      ccSwitchStatusMessage = "CC Switch 实时引用已关闭";
      ccSwitchStatusLoading = false;
    } else {
      void refreshCcSwitchStatus();
    }
    updateAboutView();
    return;
  }

  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    updateDraft({ [key]: target.checked } as Partial<PetSettings>);
    return;
  }

  if (key === "theme" && (target.value === "minimal" || target.value === "soft" || target.value === "night")) {
    updateDraft({ theme: target.value });
    applyTheme(target.value, true);
    contentControl.querySelectorAll<HTMLElement>("[data-theme-option]").forEach((option) => {
      option.classList.toggle("is-active", option.dataset.themeOption === target.value);
    });
    return;
  }

  if (key === "activePetStyleId" && draftSettings.petStyles.some((style) => style.id === target.value)) {
    updateDraft({ activePetStyleId: target.value });
    contentControl.querySelectorAll<HTMLElement>(".pet-style-option").forEach((option) => {
      const input = option.querySelector<HTMLInputElement>('input[data-setting="activePetStyleId"]');
      option.classList.toggle("is-active", input?.value === target.value);
    });
    return;
  }

  if (target instanceof HTMLTextAreaElement && key === "wechatAllowedUserIds") {
    updateDraft({ wechatAllowedUserIds: target.value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean) });
    return;
  }

  if (key === "codexSandboxMode" && (target.value === "read-only" || target.value === "workspace-write" || target.value === "danger-full-access")) {
    if (target.value !== "read-only") {
      const label = target.value === "danger-full-access" ? "完全权限" : "工作区写入";
      if (!(await showConfirm("切换 Codex 权限", `Codex 切换到“${label}”后可能修改本地文件。确定继续吗？`))) {
        target.value = draftSettings.codexSandboxMode;
        return;
      }
    }
    updateDraft({ codexSandboxMode: target.value });
    return;
  }

  if (key === "agentPermissionPolicy" && (target.value === "chat-only" || target.value === "allow-tools")) {
    updateDraft({ agentPermissionPolicy: target.value });
    return;
  }

  if (key === "petName" || key === "userName") {
    updateDraft({ [key]: target.value } as Partial<PetSettings>);
  }
}

function resetAgentTestState(): void {
  agentTestRunning = false;
  agentTestMessage = "";
  agentTestOk = false;
  agentHealthRunning = false;
  agentHealthMessage = "";
  agentHealthOk = false;
  agentHealthPreview = "";
}

function openAgentDetail(config: AgentConfig): void {
  agentDetailDraft = cloneAgentConfig(config);
  const record = diagnosticAgentRecord(agentDetailDraft);
  agentTestRunning = false;
  agentTestMessage = record.command?.detail ?? "";
  agentTestOk = record.command?.ok ?? false;
  agentHealthRunning = false;
  agentHealthMessage = record.health?.detail ?? "";
  agentHealthOk = record.health?.ok ?? false;
  agentHealthPreview = record.health?.responsePreview ?? "";
  currentPage = "agent-detail";
  render();
}

function toggleDiscoveredAgentCard(discoveryId: string): void {
  if (!draftSettings) return;
  const discovered = agentDiscovery.find((agent) => agent.id === discoveryId);
  if (!discovered || discovered.status !== "available" || !discovered.command) return;
  const existingIndex = draftSettings.agentConfigs.findIndex((config) =>
    config.source !== "cc-switch"
    && ((discovered.sourceApp && config.sourceApp === discovered.sourceApp)
      || (config.source === "discovered" && config.id === `local:${discovered.id}`)),
  );
  if (existingIndex >= 0) {
    const existing = draftSettings.agentConfigs[existingIndex];
    if (existing.agentCardVisible !== false) {
      void showNotice("重复添加", `${existing.displayName} 已经添加到 Agent 卡片，无需重复添加。`);
      return;
    } else {
      const nextConfigs = draftSettings.agentConfigs.map((config, index) => index === existingIndex
        ? { ...config, agentCardVisible: true }
        : config);
      draftSettings = { ...draftSettings, agentConfigs: nextConfigs };
    }
  } else {
    const config = configFromDiscovery(discovered);
    if (!config) return;
    draftSettings = { ...draftSettings, agentConfigs: [...draftSettings.agentConfigs, config] };
  }
  dirty = true;
  updateAgentCardListView();
  updateAgentDiscoveryView();
}

async function testAgentDetail(): Promise<void> {
  if (!agentDetailDraft || agentTestRunning || !agentDetailDraft.command.trim()) return;
  agentTestRunning = true;
  agentTestMessage = "正在检查命令…";
  agentTestOk = false;
  updateAgentTestView();
  try {
    const result = await api.agents.test(cloneAgentConfig(agentDetailDraft));
    agentTestMessage = result.detail;
    agentTestOk = result.ok;
    const previous = diagnosticAgentRecord(agentDetailDraft);
    agentDiagnosticRecords.set(agentDetailDraft.id, { command: result, health: previous.health, checkedAt: Date.now() });
    updateDiagnosticsView();
  } catch (error) {
    console.error("Unable to test agent command.", error);
    agentTestMessage = "命令检查失败，请检查命令和工作目录。";
    agentTestOk = false;
  } finally {
    agentTestRunning = false;
    updateAgentTestView();
  }
}

async function healthCheckAgentDetail(): Promise<void> {
  if (!agentDetailDraft || agentHealthRunning || !agentDetailDraft.command.trim()) return;
  agentHealthRunning = true;
  agentHealthMessage = "正在发送最小请求…";
  agentHealthOk = false;
  agentHealthPreview = "";
  updateAgentHealthView();
  try {
    const result = await api.agents.healthCheck(cloneAgentConfig(agentDetailDraft));
    agentHealthMessage = result.detail;
    agentHealthOk = result.ok;
    agentHealthPreview = result.responsePreview || "";
    const previous = diagnosticAgentRecord(agentDetailDraft);
    agentDiagnosticRecords.set(agentDetailDraft.id, { command: previous.command, health: result, checkedAt: Date.now() });
    updateDiagnosticsView();
  } catch (error) {
    console.error("Unable to run agent health check.", error);
    agentHealthMessage = "真实请求失败，请检查命令、认证和网络。";
    agentHealthOk = false;
    agentHealthPreview = "";
  } finally {
    agentHealthRunning = false;
    updateAgentHealthView();
  }
}

async function refreshDiagnostics(): Promise<void> {
  if (diagnosticsLoading) return;
  diagnosticsLoading = true;
  diagnosticsCopied = false;
  diagnosticsMessage = "";
  updateDiagnosticsView();
  try {
    const [versionResult, discoveryResult, channelResult] = await Promise.allSettled([
      api.version(),
      api.agents.discover(),
      api.channels.list(),
    ]);
    const failures: string[] = [];
    if (versionResult.status === "fulfilled") diagnosticAppVersion = versionResult.value;
    else failures.push("应用版本");
    if (discoveryResult.status === "fulfilled") agentDiscovery = discoveryResult.value;
    else failures.push("Agent 命令");
    if (channelResult.status === "fulfilled") diagnosticChannelStatuses = channelResult.value;
    else failures.push("Bot 通道");
    diagnosticsMessage = failures.length > 0
      ? `诊断已部分更新，${failures.join("、")}读取失败。`
      : "诊断已更新";
  } catch (error) {
    console.error("Unable to refresh diagnostics.", error);
    diagnosticsMessage = "诊断刷新失败，请稍后重试。";
  } finally {
    diagnosticsLoading = false;
    updateDiagnosticsView();
  }
}

async function copyDiagnostics(): Promise<void> {
  if (!draftSettings) return;
  diagnosticsMessage = "正在准备摘要信息…";
  updateDiagnosticsView();
  const report = buildDiagnosticsReport(draftSettings);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(report);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = report;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Clipboard unavailable");
    }
    diagnosticsCopied = true;
    diagnosticsMessage = "已复制诊断摘要，可粘贴到 issue 或反馈中。";
    window.setTimeout(() => {
      diagnosticsCopied = false;
      updateDiagnosticsView();
    }, 2200);
  } catch (error) {
    console.error("Unable to copy diagnostics.", error);
    diagnosticsMessage = "复制失败，请检查桌宠剪贴板权限。";
  }
  updateDiagnosticsView();
}

async function refreshDataSummary(): Promise<void> {
  if (dataSummaryLoading) return;
  dataSummaryLoading = true;
  dataSummaryMessage = "";
  updateDataView();
  try {
    localDataSummary = await api.settings.dataSummary();
    dataSummaryMessage = "盘点已更新";
  } catch (error) {
    console.error("Unable to load local data summary.", error);
    dataSummaryMessage = "数据盘点失败，请稍后重试。";
  } finally {
    dataSummaryLoading = false;
    updateDataView();
  }
}

async function refreshMemory(successMessage = "记忆列表已更新"): Promise<void> {
  if (memoryLoading) return;
  memoryLoading = true;
  memoryMessage = "";
  if (currentPage === "memory" || currentPage === "memory-all") render(false);
  try {
    memoryEntries = await api.memory.list();
    memoryMessage = successMessage;
  } catch (error) {
    console.error("Unable to load memory.", error);
    memoryMessage = "记忆读取失败，请稍后重试。";
  } finally {
    memoryLoading = false;
    if (currentPage === "memory" || currentPage === "memory-all") render(false);
  }
}

async function organizeRecentMemory(): Promise<void> {
  if (memoryLoading || memoryOrganizing) return;
  memoryOrganizing = true;
  memoryMessage = "正在重整理现有记忆和最近对话…";
  if (currentPage === "memory" || currentPage === "memory-all") render(false);
  try {
    const result = await api.memory.rebuildRecent();
    await refreshMemory(result.detail);
  } catch (error) {
    console.error("Unable to reorganize memory.", error);
    memoryMessage = "记忆重整理失败，请稍后重试。";
  } finally {
    memoryOrganizing = false;
    if (currentPage === "memory" || currentPage === "memory-all") render(false);
  }
}

async function updateMemoryEntry(action: "approve" | "reject" | "remove", id: string): Promise<void> {
  const result = await api.memory[action](id);
  await refreshMemory(result.detail);
}

async function clearMemory(): Promise<void> {
  if (memoryEntries.length === 0) return;
  if (!(await showConfirm("清除全部记忆", "确认删除桌宠已经了解的所有内容吗？聊天原文不会受影响。", { confirmLabel: "删除", danger: true }))) return;
  const result = await api.memory.clear();
  await refreshMemory(result.detail);
}

async function clearChatHistory(): Promise<void> {
  if (clearingChatHistory) return;
  const historyCount = (localDataSummary?.history.channel.messageCount ?? 0) + (localDataSummary?.history.wechat.messageCount ?? 0);
  if (historyCount === 0) return;
  if (!(await showConfirm("清空聊天历史", `确认清空本机聊天历史？\n\n将清除约 ${historyCount} 条历史消息，但不会删除凭据、事件日志或微信会话文件。`, { confirmLabel: "清空", danger: true }))) return;
  clearingChatHistory = true;
  dataSummaryMessage = "正在清空聊天历史…";
  updateDataView();
  try {
    const result = await api.settings.clearChatHistory();
    if (result.summary) localDataSummary = result.summary;
    dataSummaryMessage = result.detail;
  } catch (error) {
    console.error("Unable to clear chat history.", error);
    dataSummaryMessage = "清空聊天历史失败，请稍后重试。";
  } finally {
    clearingChatHistory = false;
    updateDataView();
  }
}

async function deleteManagedData(): Promise<void> {
  if (deletingManagedData) return;
  const managedDataFileCount = localDataSummary?.managedDataFileCount ?? 0;
  if (!localDataSummary || managedDataFileCount === 0) return;
  if (!(await showConfirm("删除托管数据", `确认删除 ${managedDataFileCount} 个应用托管数据文件并重启桌宠？\n\n将删除应用设置、聊天历史、事件日志和加密凭据索引；不会删除外部微信会话文件，也不会退出 Agent CLI 登录。`, { confirmLabel: "删除", danger: true }))) return;

  deletingManagedData = true;
  dataSummaryMessage = "正在停止通道并清理应用托管数据…";
  updateDataView();
  try {
    const result = await api.settings.deleteManagedData();
    if (result.summary) localDataSummary = result.summary;
    dataSummaryMessage = result.detail;
  } catch (error) {
    console.error("Unable to delete managed data.", error);
    dataSummaryMessage = "应用托管数据清理失败，请稍后重试。";
  } finally {
    deletingManagedData = false;
    updateDataView();
  }
}

async function exportDataSummary(): Promise<void> {
  if (exportingDataSummary) return;
  exportingDataSummary = true;
  dataSummaryMessage = "正在准备摘要信息…";
  updateDataView();
  try {
    const result = await api.settings.exportDataSummary();
    if (!result.canceled) dataSummaryMessage = result.detail;
  } catch (error) {
    console.error("Unable to export local data summary.", error);
    dataSummaryMessage = "导出失败，请稍后重试。";
  } finally {
    exportingDataSummary = false;
    updateDataView();
  }
}

async function removeAgentCard(id: string): Promise<void> {
  if (!draftSettings) return;
  const currentSettings = draftSettings;
  const config = cardAgentConfigs(currentSettings).find((item) => item.id === id);
  if (!config) return;
  if (currentSettings.zeroToken.enabled && agentSupportsZeroToken(config) && config.ccSwitchCurrentConfig) {
    await showNotice("保留 CCS 配置", "Zero Token 模式开启时，已有 CCS 配置仅作为可恢复的原始配置保留，不能删除。");
    return;
  }
  const currentCards = cardAgentConfigs(currentSettings);
  if (currentCards.length <= 1) {
    await showNotice("无法移除 Agent", "至少保留一个已加入的 Agent；如需更换，请先添加其他 Agent。");
    return;
  }
  if (!(await showConfirm("移除 Agent", `确定将“${config.displayName}”从桌宠已加入列表中移除吗？\n\n这不会卸载本机 Agent，只会隐藏桌宠中的 Agent 卡片。`, { confirmLabel: "移除" }))) return;

  const identity = agentCardIdentity(config);
  const nextConfigs = currentSettings.agentConfigs.map((item) =>
    agentCardIdentity(item) === identity ? { ...item, agentCardVisible: false } : item,
  );
  const nextDraft = { ...currentSettings, agentConfigs: nextConfigs };
  const remainingCards = cardAgentConfigs(nextDraft);

  draftSettings = {
    ...nextDraft,
    agentFallbackIds: currentSettings.agentFallbackIds.filter((fallbackId) =>
      remainingCards.some((item) => item.id === fallbackId),
    ),
  };
  dirty = true;
  updateAgentCardListView();
  updateAgentDiscoveryView();
}

contentControl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const customTrigger = target.closest<HTMLButtonElement>("[data-custom-select-trigger]");
  if (customTrigger) {
    event.preventDefault();
    const wrapper = customTrigger.closest<HTMLElement>("[data-custom-select]");
    if (wrapper) toggleCustomSelect(wrapper);
    return;
  }

  if (target.closest("#open-bot-center")) {
    currentPage = "bots";
    render();
    return;
  }

  if (target.closest("#open-appearance-settings")) {
    currentPage = "appearance";
    render();
    return;
  }

  const removeAgentButton = target.closest<HTMLElement>("[data-remove-agent-card]");
  if (removeAgentButton) {
    const id = removeAgentButton.dataset.removeAgentCard;
    if (id) void removeAgentCard(id);
    return;
  }

  if (target.closest("#open-wechat-config")) {
    currentPage = "wechat";
    render();
    return;
  }

  if (target.closest("#open-qq-config")) {
    const account = draftSettings?.qqAccounts.find((item) => item.id === draftSettings?.activeQQAccountId) ?? draftSettings?.qqAccounts[0];
    initializeQQForm(account);
    currentPage = "qq";
    render();
    return;
  }

  if (target.closest("#open-feishu-config")) {
    const account = draftSettings?.feishuAccounts.find((item) => item.id === draftSettings?.activeFeishuAccountId) ?? draftSettings?.feishuAccounts[0];
    initializeFeishuForm(account);
    currentPage = "feishu";
    render();
    return;
  }

  if (target.closest("#open-dingtalk-config")) {
    const account = draftSettings?.dingtalkAccounts.find((item) => item.id === draftSettings?.activeDingTalkAccountId) ?? draftSettings?.dingtalkAccounts[0];
    initializeDingTalkForm(account);
    currentPage = "dingtalk";
    render();
    return;
  }

  if (target.closest("#qq-save-config")) {
    void saveQQConfig();
    return;
  }

  if (target.closest("#qq-remove-config")) {
    void removeQQConfig();
    return;
  }

  if (target.closest("#qq-reconnect")) {
    void reconnectQQ();
    return;
  }

  if (target.closest("#qq-qr-login")) {
    void startQQQrLogin();
    return;
  }

  if (target.closest("#qq-qr-cancel")) {
    void cancelQQQrLogin();
    return;
  }

  if (target.closest("#qq-qr-dismiss")) {
    dismissQQQrLogin();
    return;
  }

  if (target.closest("#feishu-save-config")) {
    void saveFeishuConfig();
    return;
  }

  if (target.closest("#feishu-remove-config")) {
    void removeFeishuConfig();
    return;
  }

  if (target.closest("#feishu-reconnect")) {
    void reconnectFeishu();
    return;
  }

  if (target.closest("#feishu-qr-login")) {
    void startFeishuQrLogin();
    return;
  }

  if (target.closest("#feishu-qr-cancel")) {
    void cancelFeishuQrLogin();
    return;
  }

  if (target.closest("#feishu-qr-dismiss")) {
    dismissFeishuQrLogin();
    return;
  }

  if (target.closest("#dingtalk-save-config")) {
    void saveDingTalkConfig();
    return;
  }

  if (target.closest("#dingtalk-remove-config")) {
    void removeDingTalkConfig();
    return;
  }

  if (target.closest("#dingtalk-reconnect")) {
    void reconnectDingTalk();
    return;
  }

  if (target.closest("#dingtalk-open-console")) {
    void openDingTalkGuide("https://open-dev.dingtalk.com/", "开发者后台");
    return;
  }

  if (target.closest("#dingtalk-open-docs")) {
    void openDingTalkGuide("https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/", "官方教程");
    return;
  }

  const revealButton = target.closest<HTMLElement>("[data-reveal-wechat-id]");
  if (revealButton) {
    toggleWeChatSecret(revealButton);
    return;
  }

  if (target.closest("#wechat-qr-login")) {
    void startWeChatQrLogin();
    return;
  }

  if (target.closest("#wechat-qr-cancel")) {
    void cancelWeChatQrLogin();
    return;
  }

  if (target.closest("#wechat-qr-dismiss")) {
    dismissWeChatQrLogin();
    return;
  }

  if (target.closest("#wechat-import")) {
    void importWeChatSession();
    return;
  }

  if (target.closest("#wechat-refresh")) {
    void refreshWeChatStatus();
    return;
  }

  if (target.closest("#wechat-reconnect")) {
    void reconnectWeChat();
    return;
  }

  if (target.closest("#wechat-advanced-toggle")) {
    advancedWeChatOpen = !advancedWeChatOpen;
    updateWeChatAdvancedView();
    return;
  }

  if (target.closest("#guide-qr-login")) {
    markFirstUseGuideSeen();
    currentPage = "wechat";
    render();
    void startWeChatQrLogin();
    return;
  }

  if (target.closest("#guide-help")) {
    showFirstUseHelp();
    return;
  }

  if (target.closest("#guide-dismiss")) {
    markFirstUseGuideSeen();
    return;
  }

  const accountButton = target.closest<HTMLElement>("[data-wechat-account-id]");
  if (accountButton) {
    const accountId = accountButton.dataset.wechatAccountId;
    if (accountId) void switchWeChatAccount(accountId);
    return;
  }

  if (target.closest("#wechat-logout")) {
    void logoutWeChatSession();
    return;
  }

  const detailButton = target.closest<HTMLElement>("[data-open-agent-detail]");
  if (detailButton) {
    const id = detailButton.dataset.openAgentDetail;
    const config = id && draftSettings ? agentConfigs(draftSettings).find((item) => item.id === id) : undefined;
    if (config) openAgentDetail(config);
    return;
  }

  if (target.closest("#import-ccswitch-agents")) {
    // Refresh detection and bind in one flow so the button always converges to
    // the actual CCS state, including the not-found state.
    void refreshCcSwitchStatus(false);
    return;
  }

  if (target.closest("#zero-token-check")) {
    void checkZeroTokenConnectionFromSettings();
    return;
  }
  if (target.closest("#zero-token-login")) {
    void controlZeroTokenRuntime("login");
    return;
  }
  if (target.closest("#zero-token-logout")) {
    void controlZeroTokenRuntime("logout");
    return;
  }
  if (target.closest("#open-agent-add")) {
    currentPage = "agent-add";
    render();
    scheduleAgentDiscovery();
    return;
  }

  if (target.closest("#open-agent-import")) {
    currentPage = "agent-add";
    render();
    scheduleAgentDiscovery();
    return;
  }

  const discoveredButton = target.closest<HTMLElement>("[data-toggle-discovered]");
  if (discoveredButton) {
    const id = discoveredButton.dataset.toggleDiscovered;
    if (id) toggleDiscoveredAgentCard(id);
    return;
  }

  const discoveredCard = target.closest<HTMLElement>("[data-discovered-card]");
  if (discoveredCard) {
    const id = discoveredCard.dataset.discoveredCard;
    if (id) toggleDiscoveredAgentCard(id);
    return;
  }


  if (target.closest("#test-agent")) {
    void testAgentDetail();
    return;
  }

  if (target.closest("#health-check-agent")) {
    void healthCheckAgentDetail();
    return;
  }

  if (target.closest("#cancel-agent-detail")) {
    agentDetailDraft = null;
    resetAgentTestState();
    currentPage = "agents";
    render();
    return;
  }

  if (target.closest("#cancel-agent-add")) {
    currentPage = "agents";
    render();
    void refreshCcSwitchStatus(false);
    return;
  }

  if (target.closest("#open-agent-config")) {
    currentPage = "agents";
    render();
    void refreshCcSwitchStatus(false);
    return;
  }

  if (target.closest("#stage-agent")) {
    currentPage = "home";
    render();
    return;
  }

  if (target.closest("#discover-agents")) {
    void discoverAgents();
    return;
  }

});

contentControl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.dataset.petStyleNameInput) {
    event.preventDefault();
    void renamePetStyle(event.target.dataset.petStyleNameInput, event.target.value);
    return;
  }
  if (event.key === "Escape" && event.target instanceof HTMLInputElement && event.target.dataset.petStyleNameInput) {
    event.preventDefault();
    cancelPetStyleRename();
    return;
  }
  if (event.key === "Enter" && (event.target as HTMLElement).closest("#custom-pet-state-name")) {
    event.preventDefault();
    const nameInput = event.target as HTMLInputElement;
    void addCustomPetState(nameInput.value);
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target as HTMLElement;
  if (target.closest("[data-toggle-discovered]")) return;
  const discoveredCard = target.closest<HTMLElement>("[data-discovered-card]");
  if (!discoveredCard) return;
  event.preventDefault();
  const id = discoveredCard.dataset.discoveredCard;
  if (id) toggleDiscoveredAgentCard(id);
});

contentControl.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  const personalizationSetting = target.dataset.personalizationSetting;
  if (personalizationSetting === "replyStyle" && target instanceof HTMLSelectElement) {
    const value = target.value as ReplyStyle;
    if (value in REPLY_STYLE_LABELS) {
      replyStyle = value;
      localStorage.setItem(PERSONALIZATION_REPLY_STYLE_KEY, value);
    }
    return;
  }
  if (personalizationSetting === "autoMemory" && target instanceof HTMLInputElement && target.type === "checkbox") {
    autoMemoryEnabled = target.checked;
    localStorage.setItem(PERSONALIZATION_AUTO_MEMORY_KEY, autoMemoryEnabled ? "on" : "off");
    const title = contentControl.querySelector<HTMLElement>("[data-auto-memory-title]");
    if (title) title.textContent = autoMemoryEnabled ? "自动记忆已开启" : "自动记忆已关闭";
    return;
  }
  if (target instanceof HTMLSelectElement && target.dataset.agentModelProvider && agentDetailDraft && draftSettings) {
    const value = target.value as AgentModelProvider;
    if (value === "api" || value === "ccs" || value === "deepseek" || value === "zerotoken") {
      agentDetailDraft = { ...agentDetailDraft, modelProvider: value };
      draftSettings = {
        ...draftSettings,
        agentConfigs: draftSettings.agentConfigs.map((config) => config.id === agentDetailDraft?.id
          ? { ...config, modelProvider: value }
          : config),
        zeroToken: value === "zerotoken" && !draftSettings.zeroToken.enabled
          ? { ...draftSettings.zeroToken, enabled: true }
          : draftSettings.zeroToken,
      };
      dirty = true;
      updateSaveStateView();
      if (value === "zerotoken" && draftSettings.zeroToken.enabled) void checkZeroTokenConnectionFromSettings();
    }
    return;
  }
  const zeroTokenField = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.dataset.zeroTokenField : undefined;
  if (zeroTokenField) {
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
    updateZeroTokenSetting(zeroTokenField, target);
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.qqConfig) {
    updateQQForm(target);
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.feishuConfig) {
    updateFeishuForm(target);
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.dingtalkConfig) {
    updateDingTalkForm(target);
    return;
  }
  void handleSettingChange(target);
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const optionButton = target.closest<HTMLButtonElement>("[data-custom-select-option]");
  if (optionButton) {
    event.preventDefault();
    selectCustomOption(optionButton);
    return;
  }
  if (!target.closest("[data-custom-select-trigger], [data-custom-select-menu]")) {
    closeAllCustomSelects();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && promptOpen) {
    closePrompt(null);
    return;
  }
  if (event.key === "Escape") {
    const openElement = event.target as HTMLElement;
    const openMenu = openElement.closest<HTMLElement>("[data-custom-select-menu]");
    const ownerId = openMenu?.dataset.customSelectOwner;
    const owner = ownerId
      ? customSelectWrappers().find((candidate) => candidate.dataset.customSelectId === ownerId)
      : openElement.closest<HTMLElement>("[data-custom-select][data-open=\"true\"]");
    closeAllCustomSelects();
    owner?.querySelector<HTMLButtonElement>("[data-custom-select-trigger]")?.focus();
    return;
  }
  const target = event.target as HTMLElement;
  const option = target.closest<HTMLButtonElement>("[data-custom-select-option]");
  if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    const options = Array.from(option.closest<HTMLElement>("[data-custom-select-menu]")?.querySelectorAll<HTMLButtonElement>("[data-custom-select-option]") ?? [])
      .filter((candidate) => !candidate.disabled);
    const currentIndex = options.indexOf(option);
    const nextIndex = event.key === "ArrowDown"
      ? Math.min(options.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    event.preventDefault();
    options[nextIndex]?.focus();
    return;
  }
  const trigger = target.closest<HTMLButtonElement>("[data-custom-select-trigger]");
  if (!trigger || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const wrapper = trigger.closest<HTMLElement>("[data-custom-select]");
  if (wrapper) {
    openCustomSelect(wrapper);
    const parts = getCustomSelectParts(wrapper);
    const selected = parts && Array.from(parts.menu.querySelectorAll<HTMLButtonElement>("[data-custom-select-option]")).find(
      (candidate) => candidate.dataset.value === parts.select.value && !candidate.disabled,
    );
    selected?.focus();
  }
});

settingsSurface.addEventListener("scroll", () => closeAllCustomSelects());
window.addEventListener("resize", () => closeAllCustomSelects());

backButtonControl.addEventListener("click", () => {
  if (currentPage === "agent-detail" || currentPage === "agent-add") {
    agentDetailDraft = null;
    resetAgentTestState();
    currentPage = "agents";
  } else if (currentPage === "pet-styles") {
    currentPage = "home";
  } else if (currentPage === "appearance") {
    currentPage = "home";
  } else if (currentPage === "personalization") {
    currentPage = "home";
  } else if (currentPage === "perception-detail") {
    currentPage = "perception";
  } else if (currentPage === "perception-advanced") {
    currentPage = "perception";
  } else if (currentPage === "perception") {
    currentPage = "home";
  } else if (currentPage === "memory") {
    currentPage = "home";
  } else if (currentPage === "memory-all") {
    currentPage = "memory";
  } else if (currentPage === "diagnostics") {
    currentPage = "home";
  } else if (currentPage === "about") {
    currentPage = "home";
  } else if (currentPage === "wechat") {
    // 微信页面的输入会先写入 draftSettings；返回时保留草稿并回到机器人中心。
    currentPage = "bots";
  } else if (currentPage === "qq") {
    currentPage = "bots";
  } else if (currentPage === "feishu") {
    currentPage = "bots";
  } else if (currentPage === "dingtalk") {
    currentPage = "bots";
  } else {
    currentPage = "home";
  }
  render();
});

async function discoverAgents(): Promise<void> {
  if (discoveringAgents) return;
  discoveringAgents = true;
  discoveryError = "";
  updateAgentDiscoveryView();
  try {
    agentDiscovery = await api.agents.discover();
  } catch (error) {
    console.error("Unable to discover local agents.", error);
    discoveryError = "扫描失败，请检查桌宠权限后重试。";
  } finally {
    discoveringAgents = false;
    updateAgentDiscoveryView();
  }
}

function scheduleAgentDiscovery(): void {
  if (agentDiscovery.length > 0 || discoveringAgents || agentDiscoveryTimer !== null) return;
  agentDiscoveryTimer = window.setTimeout(() => {
    agentDiscoveryTimer = null;
    if (currentPage === "agents" || currentPage === "agent-add") void discoverAgents();
  }, 160);
}

closeButtonControl.addEventListener("click", () => void close());
leaveContinueButtonControl.addEventListener("click", () => void handleLeaveChoice("continue"));
leaveDiscardButtonControl.addEventListener("click", () => void handleLeaveChoice("discard"));
leaveSaveButtonControl.addEventListener("click", () => void handleLeaveChoice("save"));

dialogPromptControl.addEventListener("click", (event) => {
  if (!promptOpen) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-prompt-value]");
  if (button) {
    event.preventDefault();
    closePrompt(button.dataset.promptValue ?? null);
    return;
  }
  if (event.target === dialogPromptControl) closePrompt(null);
});

dialogPromptControl.addEventListener("keydown", (event) => {
  if (!promptOpen || event.key !== "Tab") return;
  const buttons = Array.from(dialogActionsControl.querySelectorAll<HTMLButtonElement>("button"));
  if (buttons.length === 0) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

contentControl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("#import-pet-style")) {
    void importPetStyle();
    return;
  }
  if (target.closest("#open-pet-style-settings")) {
    petStyleEditorId = draftSettings?.activePetStyleId ?? "default-penguin";
    currentPage = "pet-styles";
    petStyleMessage = "";
    render();
    return;
  }
  const editPetStyleButton = target.closest<HTMLElement>("[data-edit-pet-style]");
  if (editPetStyleButton) {
    const styleId = editPetStyleButton.dataset.editPetStyle;
    if (styleId) {
      petStyleEditorId = styleId;
      updatePetStyleView();
    }
    return;
  }
  const renamePetStyleButton = target.closest<HTMLElement>("[data-rename-pet-style]");
  if (renamePetStyleButton) {
    const styleId = renamePetStyleButton.dataset.renamePetStyle;
    if (styleId) beginPetStyleRename(styleId);
    return;
  }
  const cancelRenamePetStyleButton = target.closest<HTMLElement>("[data-cancel-rename-pet-style]");
  if (cancelRenamePetStyleButton) {
    cancelPetStyleRename();
    return;
  }
  const confirmRenamePetStyleButton = target.closest<HTMLElement>("[data-confirm-rename-pet-style]");
  if (confirmRenamePetStyleButton) {
    const styleId = confirmRenamePetStyleButton.dataset.confirmRenamePetStyle;
    const input = styleId ? contentControl.querySelector<HTMLInputElement>(`[data-pet-style-name-input="${CSS.escape(styleId)}"]`) : null;
    if (styleId && input) void renamePetStyle(styleId, input.value);
    return;
  }
  const applyPetStyleButton = target.closest<HTMLElement>("[data-apply-pet-style]");
  if (applyPetStyleButton) {
    const styleId = applyPetStyleButton.dataset.applyPetStyle;
    if (styleId && draftSettings?.petStyles.some((style) => style.id === styleId)) {
      petStyleEditorId = styleId;
      updateDraft({ activePetStyleId: styleId });
      updatePetStyleView();
      void saveAll();
    }
    return;
  }
  const importPetStyleStateButton = target.closest<HTMLElement>("[data-import-pet-style-state]");
  if (importPetStyleStateButton) {
    const styleId = importPetStyleStateButton.dataset.importPetStyleState;
    const state = importPetStyleStateButton.dataset.petStyleState;
    if (styleId && state && (PET_STYLE_STATE_META as Array<{ id: string }>).some((item) => item.id === state)) {
      void importPetStyleState(styleId, state as PetState);
    }
    return;
  }
  if (target.closest("#add-custom-pet-state")) {
    openCustomPetStateForm();
    return;
  }
  if (target.closest("#cancel-custom-pet-state")) {
    closeCustomPetStateForm();
    return;
  }
  if (target.closest("#confirm-custom-pet-state")) {
    const nameInput = contentControl.querySelector<HTMLInputElement>("#custom-pet-state-name");
    void addCustomPetState(nameInput?.value ?? "");
    return;
  }
  const removeCustomPetStateButton = target.closest<HTMLElement>("[data-remove-custom-pet-state]");
  if (removeCustomPetStateButton) {
    const styleId = removeCustomPetStateButton.dataset.removeCustomPetState;
    const stateId = removeCustomPetStateButton.dataset.petStyleCustomState;
    if (styleId && stateId) void removeCustomPetState(styleId, stateId);
    return;
  }
  const removePetStyleButton = target.closest<HTMLElement>("[data-remove-pet-style]");
  if (removePetStyleButton) {
    const styleId = removePetStyleButton.dataset.removePetStyle;
    if (styleId) void removePetStyle(styleId);
    return;
  }
  if (target.closest("#open-pet-perception")) {
    currentPage = "perception";
    render();
    void refreshPetPerception();
    return;
  }
  const perceptionAction = target.closest<HTMLElement>("[data-perception-action]")?.dataset.perceptionAction;
  if (perceptionAction) {
    if (perceptionAction === "advanced") {
      currentPage = "perception-advanced";
    } else if (perceptionAction === "companion" || perceptionAction === "interaction" || perceptionAction === "task-feedback" || perceptionAction === "position" || perceptionAction === "movement" || perceptionAction === "status-light") {
      perceptionDetail = perceptionAction;
      currentPage = "perception-detail";
    } else {
      return;
    }
    render();
    void refreshPetPerception();
    return;
  }
  if (target.closest("#open-perception-advanced")) {
    currentPage = "perception-advanced";
    render();
    void refreshPetPerception();
    return;
  }
  if (target.closest("#open-personalization")) {
    currentPage = "personalization";
    render();
    return;
  }
  if (target.closest("#open-auto-memory")) {
    currentPage = "memory";
    memoryMessage = "";
    render();
    void refreshMemory();
    return;
  }
  if (target.closest("#trigger-perception")) {
    void triggerPerception();
    return;
  }
  if (target.closest("#open-memory")) {
    currentPage = "memory";
    memoryMessage = "";
    render();
    void refreshMemory();
    return;
  }
  if (target.closest("#open-all-memory")) {
    currentPage = "memory-all";
    memoryMessage = "";
    render();
    void refreshMemory();
    return;
  }
  const memoryApproveButton = target.closest<HTMLElement>("[data-memory-approve]");
  if (memoryApproveButton?.dataset.memoryApprove) {
    void updateMemoryEntry("approve", memoryApproveButton.dataset.memoryApprove);
    return;
  }
  const memoryRejectButton = target.closest<HTMLElement>("[data-memory-reject]");
  if (memoryRejectButton?.dataset.memoryReject) {
    void updateMemoryEntry("reject", memoryRejectButton.dataset.memoryReject);
    return;
  }
  const memoryRemoveButton = target.closest<HTMLElement>("[data-memory-remove]");
  if (memoryRemoveButton?.dataset.memoryRemove) {
    void updateMemoryEntry("remove", memoryRemoveButton.dataset.memoryRemove);
    return;
  }
  if (target.closest("#refresh-memory")) {
    void refreshMemory();
    return;
  }
  if (target.closest("#organize-memory")) {
    void organizeRecentMemory();
    return;
  }
  if (target.closest("#clear-memory")) {
    void clearMemory();
    return;
  }
  if (target.closest("#open-data-settings")) {
    currentPage = "data";
    dataSummaryMessage = "";
    render();
    void refreshDataSummary();
    return;
  }
  if (target.closest("#open-about-settings")) {
    currentPage = "about";
    updateMessage = "";
    render();
    return;
  }
  if (target.closest("#check-updates")) {
    void checkForUpdates();
    return;
  }
  if (target.closest("#open-update-download")) {
    void openUpdateDownload();
    return;
  }
  if (target.closest("#refresh-data-summary")) {
    void refreshDataSummary();
    return;
  }
  if (target.closest("#clear-chat-history")) {
    void clearChatHistory();
    return;
  }
  if (target.closest("#delete-managed-data")) {
    void deleteManagedData();
    return;
  }
  if (target.closest("#export-data-summary")) {
    void exportDataSummary();
    return;
  }
  if (target.closest("#refresh-diagnostics")) {
    void refreshDiagnostics();
    return;
  }
  if (target.closest("#copy-diagnostics")) {
    void copyDiagnostics();
    return;
  }
  if (target.closest("#open-diagnostics")) {
    currentPage = "diagnostics";
    diagnosticsMessage = "";
    diagnosticsCopied = false;
    render();
    void refreshDiagnostics();
    return;
  }
  if (target.closest("#settings-save")) {
    void saveAll();
  }
});

const unsubscribeMemory = api.memory.subscribe(() => {
  if (currentPage === "memory" || currentPage === "memory-all") {
    void refreshMemory();
  }
});

const unsubscribeSettings = api.settings.subscribe((settings) => {
  const next = cloneSettings(settings);
  void syncMascotAsset(next);
  // A broadcast caused by our own save echoes identical settings. Rebuilding
  // the whole page for that echo resets scroll/focus and replays the page and
  // mascot animations, which looks like a global refresh. Only re-render when
  // the incoming settings actually differ from what the page currently shows.
  const displayed = dirty ? draftSettings : persistedSettings;
  if (displayed && JSON.stringify(next) === JSON.stringify(displayed)) {
    persistedSettings = next;
    return;
  }

  if (displayed
    && currentPage === "agents"
    && settingsWithoutAgentConfigs(next) === settingsWithoutAgentConfigs(displayed)) {
    persistedSettings = next;
    if (!dirty) {
      draftSettings = next;
    } else {
      mergeSyncedAgentSettings(next);
    }
    updateAgentCardListView();
    return;
  }

  persistedSettings = next;
  if (!dirty) draftSettings = next;
  render(false);
});

const unsubscribeZeroTokenRuntime = api.zeroToken.subscribe((status) => {
  zeroTokenStatus = status;
  zeroTokenMessage = status.detail;
  updateZeroTokenView();
});

const unsubscribeSettingsCloseRequest = api.settings.onCloseRequest(() => {
  void close();
});

const unsubscribePetPerceptionSnapshot = api.petPerception.subscribeSnapshot((snapshot) => {
  petPerceptionSnapshot = snapshot;
  updatePetPerceptionView();
});

const unsubscribeAgentTasks = api.agentTasks.subscribe((snapshot) => {
  agentTaskSnapshot = snapshot;
  if (petPerceptionSnapshot) {
    petPerceptionSnapshot = { ...petPerceptionSnapshot, agentTasks: snapshot };
  }
  updatePetPerceptionView();
});

const unsubscribePetPerceptionEvents = api.petPerception.subscribe((event) => {
  if (!petPerceptionSnapshot) return;
  petPerceptionSnapshot = {
    ...petPerceptionSnapshot,
    primaryAgentPhase: event.agentId && event.agentId !== petPerceptionSnapshot.primaryAgentId
      ? petPerceptionSnapshot.primaryAgentPhase
      : event.phase,
    lastEvent: event,
  };
  updatePetPerceptionView();
});

const unsubscribeChannels = api.channels.subscribe((event) => {
  if (event.type !== "status") return;
  diagnosticChannelStatuses = [
    ...diagnosticChannelStatuses.filter((status) => status.channelId !== event.status.channelId),
    event.status,
  ];
  updateDiagnosticsView();
  if (event.status.channelId === "wechat:active") {
    wechatStatus = toWeChatStatus(event.status);
    renderWeChatStatus();
    return;
  }
  if (event.status.platform === "qq") {
    const settings = draftSettings ?? persistedSettings;
    const activeAccount = settings?.qqAccounts.find((account) => account.id === settings.activeQQAccountId)
      ?? settings?.qqAccounts[0];
    if (activeAccount && event.status.accountId !== activeAccount.appId) return;
    qqStatus = event.status;
    updateQQStatusView();
    return;
  }
  if (event.status.platform === "feishu") {
    const settings = draftSettings ?? persistedSettings;
    const activeAccount = settings?.feishuAccounts.find((account) => account.id === settings.activeFeishuAccountId)
      ?? settings?.feishuAccounts[0];
    if (activeAccount && event.status.accountId !== activeAccount.appId) return;
    feishuStatus = event.status;
    updateFeishuStatusView();
    return;
  }
  if (event.status.platform === "dingtalk") {
    const settings = draftSettings ?? persistedSettings;
    const activeAccount = settings?.dingtalkAccounts.find((account) => account.id === settings.activeDingTalkAccountId)
      ?? settings?.dingtalkAccounts[0];
    if (activeAccount && event.status.accountId !== activeAccount.clientId) return;
    dingtalkStatus = event.status;
    updateDingTalkStatusView();
  }
});

const unsubscribeWeChat = api.wechat.subscribe((event) => {
  if (event.type === "qr-login") {
    if (event.status === "cancelled" || event.status === "confirmed") {
      qrLoginState = null;
      updateWeChatQrLoginView();
      return;
    }
    qrLoginState = {
      status: event.status,
      detail: event.detail,
      qrDataUrl: event.qrDataUrl,
      accountId: event.accountId,
    };
    updateWeChatQrLoginView();
    return;
  }
  if (event.type === "connection") {
    wechatStatus = event;
    if (event.state === "connected") {
      firstUseGuideVisible = false;
      localStorage.setItem(FIRST_USE_GUIDE_KEY, "seen");
      if (currentPage === "home") {
        render();
        return;
      }
    }
    renderWeChatStatus();
  }
});

const unsubscribeQQQrLogin = api.qq.subscribeQrLogin((event) => {
  qqQrLoginState = event;
  updateQQQrLoginView();
  if (event.status === "cancelled") {
    qqQrLoginState = null;
    updateQQQrLoginView();
    return;
  }
  if (event.status === "confirmed") void syncQQSettingsAfterQrLogin();
  else if (event.status === "error") void refreshWeChatStatus();
});

const unsubscribeFeishuQrLogin = api.feishu.subscribeQrLogin((event) => {
  feishuQrLoginState = event;
  updateFeishuQrLoginView();
  if (event.status === "cancelled") {
    feishuQrLoginState = null;
    updateFeishuQrLoginView();
    return;
  }
  if (event.status === "confirmed") void syncFeishuSettingsAfterQrLogin();
  else if (event.status === "error") void refreshWeChatStatus();
});

window.addEventListener("beforeunload", () => {
  if (agentDiscoveryTimer !== null) window.clearTimeout(agentDiscoveryTimer);
  unsubscribeSettings();
  unsubscribeSettingsCloseRequest();
  unsubscribePetPerceptionSnapshot();
  unsubscribeAgentTasks();
  unsubscribePetPerceptionEvents();
  unsubscribeChannels();
  unsubscribeWeChat();
  unsubscribeQQQrLogin();
  unsubscribeFeishuQrLogin();
});

void refreshWeChatStatus();
void refreshWeChatQrLoginStatus();
void refreshQQQrLoginStatus();
void refreshFeishuQrLoginStatus();
void api.version().then((version) => {
  diagnosticAppVersion = version;
  updateDiagnosticsView();
  const versionElement = app.querySelector<HTMLElement>("#settings-version");
  if (versionElement) versionElement.textContent = `小企鹅桌宠 · v${version}`;
});
