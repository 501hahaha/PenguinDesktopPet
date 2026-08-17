import "./styles.css";
import { PetAI } from "../ai/PetAI";
import { AnimationManager, type AnimationDefinition } from "../animation/AnimationManager";
import { PetStateMachine, type PetState } from "../pet/PetStateMachine";
import { ThreePetScene } from "./three/ThreePetScene";
import { PetReactionCoordinator } from "./pet/PetReactionCoordinator";
import type { AgentStatus, AgentTaskActivity, AgentTaskCompletion, AgentTaskSnapshot, BotChannelEvent, BotPlatform, PenguinPetApi, PetPerceptionEvent, PetPerceptionSnapshot, WeChatEvent, WeChatStatus } from "./types";
import { completionDetailForDisplay, resolveAgentTaskRole, type AgentTaskSurface } from "../main/pet/perceptionTypes";
import { DEFAULT_PET_NAME } from "../settings/types";
import type { PetPerceptionSettings, PetStyleAssetUrls } from "../settings/types";
import type { AgentEndpointSnapshot } from "../main/agents/AgentEndpointRegistry";
import type { AgentEndpoint } from "../main/agents/orchestrationTypes";
import type { AgentEvent } from "../main/events/EventTypes";

const api = (window as Window & { penguinPet: PenguinPetApi }).penguinPet;
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Renderer root #app is missing.");
}

if (new URLSearchParams(window.location.search).has("settings")) {
  void import("./settings");
} else {
  const spriteSheetUrl = new URL("../../assets/penguin/_sheet_top.png", import.meta.url).href;

const labels: Record<PetState, string> = {
  idle: "待机",
  walk: "行走",
  happy: "开心",
  shy: "害羞",
  sleep: "睡觉",
  eat: "吃东西",
  angry: "生气",
};

const descriptions: Record<PetState, string> = {
  idle: "正在看着你",
  walk: "准备出发啦",
  happy: "今天也很开心",
  shy: "被发现了……",
  sleep: "嘘，小声一点",
  eat: "吧唧吧唧",
  angry: "哼！",
};

const defaultPetStyleAssets: PetStyleAssetUrls = {
  assets: {
    idle: "penguin-pet://default-penguin/IDLE.webm",
    walk: "penguin-pet://default-penguin/WALK.webm",
    happy: "penguin-pet://default-penguin/HAPPY.webm",
    shy: "penguin-pet://default-penguin/SHY.webm",
    sleep: "penguin-pet://default-penguin/SLEEP.webm",
    eat: "penguin-pet://default-penguin/EAT.webm",
    angry: "penguin-pet://default-penguin/ANGRY.webm",
  },
  cycleStates: [
    { id: "idle", name: labels.idle, description: descriptions.idle, fallbackState: "idle" },
    { id: "walk", name: labels.walk, description: descriptions.walk, fallbackState: "walk" },
    { id: "happy", name: labels.happy, description: descriptions.happy, fallbackState: "happy" },
    { id: "shy", name: labels.shy, description: descriptions.shy, fallbackState: "shy" },
    { id: "sleep", name: labels.sleep, description: descriptions.sleep, fallbackState: "sleep" },
    { id: "eat", name: labels.eat, description: descriptions.eat, fallbackState: "eat" },
    { id: "angry", name: labels.angry, description: descriptions.angry, fallbackState: "angry" },
  ],
};

const animations: Record<PetState, AnimationDefinition> = {
  idle: { row: 0, frameCount: 12, frameDuration: 110 },
  walk: { row: 1, frameCount: 12, frameDuration: 90 },
  happy: { row: 2, frameCount: 12, frameDuration: 100 },
  shy: { row: 3, frameCount: 12, frameDuration: 125 },
  sleep: { row: 4, frameCount: 12, frameDuration: 140 },
  eat: { row: 5, frameCount: 12, frameDuration: 100 },
  angry: { row: 6, frameCount: 12, frameDuration: 95 },
};

const stateMachine = new PetStateMachine();
const animationManager = new AnimationManager(animations);
const petAI = new PetAI((state) => stateMachine.setState(state));

app.innerHTML = `
  <main class="pet-shell" aria-label="企鹅桌面宠物">
    <button class="close-button" type="button" aria-label="关闭">×</button>
    <button class="task-tray-toggle" type="button" aria-label="查看在线 Agent" aria-expanded="false" aria-controls="task-tray" hidden>
      <span class="task-tray-toggle__count" aria-hidden="true">0</span>
    </button>
    <section id="task-tray" class="task-tray" aria-label="在线 Agent" hidden>
      <header class="task-tray__header">
        <strong>在线 Agent</strong>
        <span class="task-tray__summary"></span>
        <button class="task-tray__close" type="button" aria-label="收起任务面板">×</button>
      </header>
      <div class="task-tray__list" aria-live="polite"></div>
    </section>
    <section class="pet-card">
      <div class="speech-bubble" aria-live="polite">正在看着你</div>
      <div class="pet-visual">
        <div class="status-light" data-motion="static" role="status" tabindex="0" aria-label="桌宠感知状态" aria-describedby="perception-status-label" title="桌宠感知开关位于设置中心 · 桌宠感知" ></div>
        <div id="perception-status-label" class="perception-status-label" role="tooltip" aria-live="polite" hidden></div>
        <button class="pet-stage" type="button" aria-label="和企鹅互动，点击切换动作">
          <canvas class="pet-canvas" aria-hidden="true"></canvas>
          <span class="sprite-frame sprite-frame--active" aria-hidden="true"></span>
          <span class="sprite-frame sprite-frame--transition" aria-hidden="true"></span>
          <span class="sparkle sparkle--one" aria-hidden="true">✦</span>
          <span class="sparkle sparkle--two" aria-hidden="true">·</span>
        </button>
      </div>
      <div class="pet-caption">
        <span class="pet-name">小企鹅</span>
        <span class="pet-state">· 待机</span>
      </div>
      <div class="wechat-status" data-status="offline">微信桥接检查中</div>
      <section class="wechat-feed" aria-live="polite">
        <div class="wechat-feed__meta">微信消息</div>
        <div class="wechat-feed__body">在微信里给机器人发消息，企鹅会回应。</div>
      </section>
      <div class="action-bar" role="toolbar" aria-label="动作选择">
        <button type="button" data-state="happy" aria-label="开心">❤</button>
        <button type="button" data-state="eat" aria-label="吃东西">●</button>
        <button type="button" data-state="sleep" aria-label="睡觉">Zz</button>
        <button type="button" data-state="walk" aria-label="行走">→</button>
      </div>
    </section>
  </main>
`;

const canvas = app.querySelector<HTMLCanvasElement>(".pet-canvas");
const sprite = app.querySelector<HTMLElement>(".sprite-frame--active");
const spriteTransition = app.querySelector<HTMLElement>(".sprite-frame--transition");
const speechBubble = app.querySelector<HTMLElement>(".speech-bubble");
const petVisual = app.querySelector<HTMLElement>(".pet-visual");
const perceptionStatusLight = app.querySelector<HTMLElement>(".status-light");
const perceptionStatusLabel = app.querySelector<HTMLElement>(".perception-status-label");
const stateLabel = app.querySelector<HTMLElement>(".pet-state");
const petStage = app.querySelector<HTMLButtonElement>(".pet-stage");
const wechatStatus = app.querySelector<HTMLElement>(".wechat-status");
const wechatFeedMeta = app.querySelector<HTMLElement>(".wechat-feed__meta");
const wechatFeedBody = app.querySelector<HTMLElement>(".wechat-feed__body");
const taskTrayToggle = app.querySelector<HTMLButtonElement>(".task-tray-toggle");
const taskTrayToggleCount = app.querySelector<HTMLElement>(".task-tray-toggle__count");
const taskTray = app.querySelector<HTMLElement>("#task-tray");
const taskTrayClose = app.querySelector<HTMLButtonElement>(".task-tray__close");
const taskTraySummary = app.querySelector<HTMLElement>(".task-tray__summary");
const taskTrayList = app.querySelector<HTMLElement>(".task-tray__list");

if (
  !canvas ||
  !sprite ||
  !spriteTransition ||
  !speechBubble ||
  !petVisual ||
  !perceptionStatusLight ||
  !perceptionStatusLabel ||
  !stateLabel ||
  !petStage ||
  !wechatStatus ||
  !wechatFeedMeta ||
  !wechatFeedBody ||
  !taskTrayToggle ||
  !taskTrayToggleCount ||
  !taskTray ||
  !taskTrayClose ||
  !taskTraySummary ||
  !taskTrayList
) {
  throw new Error("Pet renderer elements are missing.");
}

const canvasElement = canvas;
const spriteElement = sprite;
const spriteTransitionElement = spriteTransition;
const speechBubbleElement = speechBubble;
const petVisualElement = petVisual;
const perceptionStatusLightElement = perceptionStatusLight;
const perceptionStatusLabelElement = perceptionStatusLabel;
const stateLabelElement = stateLabel;
const petStageElement = petStage;
const wechatStatusElement = wechatStatus;
const wechatFeedMetaElement = wechatFeedMeta;
const wechatFeedBodyElement = wechatFeedBody;
const taskTrayToggleElement = taskTrayToggle;
const taskTrayToggleCountElement = taskTrayToggleCount;
const taskTrayElement = taskTray;
const taskTrayCloseElement = taskTrayClose;
const taskTraySummaryElement = taskTraySummary;
const taskTrayListElement = taskTrayList;

const PET_WINDOW_HEIGHT = 340;
const TASK_TRAY_WINDOW_HEIGHT = 640;
const TASK_TRAY_TRANSITION_MS = 180;
let taskTrayWindowExpanded = false;
let taskTrayHideTimer: number | undefined;

function setTaskTrayWindowExpanded(expanded: boolean): void {
  if (taskTrayWindowExpanded === expanded) return;
  taskTrayWindowExpanded = expanded;
  const windowHeight = `${expanded ? TASK_TRAY_WINDOW_HEIGHT : PET_WINDOW_HEIGHT}px`;
  // The root variable drives html/body/#app together. Updating only #app would
  // leave the 340px body clipping the expanded panel before Electron paints it.
  document.documentElement.style.setProperty("--pet-window-height", windowHeight);
  api.setTaskTrayExpanded(expanded);
}

function clearTaskTrayHideTimer(): void {
  if (taskTrayHideTimer === undefined) return;
  window.clearTimeout(taskTrayHideTimer);
  taskTrayHideTimer = undefined;
}

function setTaskTrayOpen(opened: boolean, focusAfterClose = false): void {
  clearTaskTrayHideTimer();

  if (opened) {
    setTaskTrayWindowExpanded(true);
    taskTrayElement.hidden = false;
    taskTrayElement.classList.remove("task-tray--closing");
    taskTrayElement.classList.remove("task-tray--open");
    taskTrayToggleElement.setAttribute("aria-expanded", "true");
    // Let the collapsed state paint once so the panel's opacity/transform
    // transition is visible after the native window grows.
    window.requestAnimationFrame(() => {
      if (!taskTrayElement.hidden && taskTrayWindowExpanded) {
        taskTrayElement.classList.add("task-tray--open");
      }
    });
    return;
  }

  setTaskTrayWindowExpanded(false);
  taskTrayElement.classList.remove("task-tray--open");
  taskTrayElement.classList.add("task-tray--closing");
  taskTrayToggleElement.setAttribute("aria-expanded", "false");
  taskTrayHideTimer = window.setTimeout(() => {
    taskTrayHideTimer = undefined;
    if (taskTrayWindowExpanded) return;
    taskTrayElement.classList.remove("task-tray--closing");
    taskTrayElement.hidden = true;
    if (focusAfterClose) taskTrayToggleElement.focus();
  }, TASK_TRAY_TRANSITION_MS);
}

let petName = DEFAULT_PET_NAME;

function visiblePetName(): string {
  return petName === DEFAULT_PET_NAME ? "小企鹅" : petName;
}

function updatePetIdentity(): void {
  const displayName = visiblePetName();
  const petShell = app!.querySelector<HTMLElement>(".pet-shell");
  const petNameElement = app!.querySelector<HTMLElement>(".pet-name");
  if (petShell) petShell.setAttribute("aria-label", `${displayName}桌面宠物`);
  if (petNameElement) petNameElement.textContent = displayName;
  petStageElement.setAttribute("aria-label", `和${displayName}互动，点击切换动作`);
  if (!wechatFeedBodyElement.dataset.hasRuntimeMessage) {
    wechatFeedBodyElement.textContent = `在微信里给机器人发消息，${petName}会回应。`;
  }
}

let speechTimer: number | undefined;
let thinkingTimer: number | undefined;
let thinkingIndex = 0;
let showBotBubbles = true;
let showThinkingBubbles = true;
let petPerceptionSettings: PetPerceptionSettings = {
  enabled: false,
  agentRuntime: false,
  taskActivity: true,
  taskCompletionNotice: true,
  statusLightMotion: "static",
  longTaskReplyEnabled: true,
  longTaskReplyIntervalSeconds: 30,
  longTaskReplyTemplate: "⏳ {agent} 进度简报 · 已用时 {elapsed} · 阶段 {phase}：{status} · 最新状态：{detail}",
  botActivity: true,
  actionFeedback: true,
  bubbleFeedback: true,
};
let petReactionCoordinator: PetReactionCoordinator | null = null;
let currentPetPerceptionSnapshot: PetPerceptionSnapshot | null = null;
let currentAgentTaskSnapshot: AgentTaskSnapshot | null = null;
let currentAgentEndpointSnapshot: AgentEndpointSnapshot | null = null;
interface AgentCompletionNotice {
  event: AgentEvent;
  completion: AgentTaskCompletion;
}

let agentCompletionQueue: AgentCompletionNotice[] = [];
let agentCompletionQueueTimer: number | undefined;
let spriteTransitionFrameId: number | undefined;

const thinkingMessages = (): readonly (readonly [string, string])[] => [
  ["收到啦，正在认真想～", "小脑袋转呀转"],
  ["我还在努力组织语言中…", "马上就好，再等我一下呀"],
  [`${petName}正在查找答案～`, "不会把你晾在这里的"],
  ["快好啦快好啦！", "再给我一点点时间"],
];

function compactMessage(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function agentTaskCounts(snapshot: AgentTaskSnapshot | null): { active: number; waiting: number; ready: number; blocked: number } {
  const tasks = snapshot?.tasks ?? [];
  return {
    active: tasks.filter((task) => task.state === "running").length,
    waiting: tasks.filter((task) => task.state === "needs-input").length,
    ready: tasks.filter((task) => task.state === "ready").length,
    blocked: tasks.filter((task) => task.state === "blocked").length,
  };
}

function agentTaskActivityLabel(activity?: AgentTaskActivity): string {
  if (activity === "starting") return "启动中";
  if (activity === "thinking") return "思考/规划中";
  if (activity === "command") return "执行命令中";
  if (activity === "network") return "访问网络中";
  if (activity === "editing") return "编辑文件中";
  if (activity === "tool") return "调用工具中";
  if (activity === "waiting") return "等待中";
  if (activity === "response-ready") return "整理答复中";
  return "";
}

function elapsedTaskLabel(startedAt: string | null, observedAt: string): string {
  const start = Date.parse(startedAt ?? observedAt);
  const elapsed = Number.isNaN(start) ? 0 : Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

let taskTrayClockTimer: number | undefined;

function dockAgentFamily(agentId: string): string {
  const normalized = agentId.replace(/^external:/, "").toLowerCase();
  if (normalized === "codex"
    || normalized === "codex-desktop"
    || normalized === "codex-cli"
    || normalized === "codex-vscode"
    || normalized === "vscode-codex") return "codex";
  return normalized;
}

function vscodeAgentLabel(agentId: string, displayName = ""): string {
  const normalized = agentId.replace(/^external:/, "").toLowerCase();
  if (normalized.includes("claude")) return "Claude Code";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("copilot")) return "GitHub Copilot";
  if (normalized.includes("continue")) return "Continue";

  const sanitized = displayName
    .replace(/\s*[·|｜-]\s*VS Code\s*$/i, "")
    .replace(/\s*[（(]\s*VS Code\s*[）)]\s*$/i, "")
    .trim();
  return sanitized && !/^agent$/i.test(sanitized) ? sanitized : "Agent";
}

function endpointSurfaceLabel(endpoint: AgentEndpoint): string {
  if (dockAgentFamily(endpoint.agentId) === "codex" && endpoint.surface === "desktop") return "Codex Desktop";
  if (dockAgentFamily(endpoint.agentId) === "codex" && endpoint.surface === "cli") return "Codex CLI";
  if (endpoint.surface === "vscode") return `VS Code（${vscodeAgentLabel(endpoint.agentId, endpoint.displayName)}）`;
  if (endpoint.surface === "desktop") return "桌面 Agent";
  if (endpoint.surface === "gateway") return "Gateway";
  if (endpoint.surface === "service") return "服务";
  if (endpoint.surface === "cli") return "CLI";
  return "外部 Agent";
}

function taskSurfaceLabel(task: AgentTaskSnapshot["tasks"][number]): string {
  if (dockAgentFamily(task.agentId) === "codex" && task.surface === "desktop") return "Codex Desktop";
  if (dockAgentFamily(task.agentId) === "codex" && task.surface === "cli") return "Codex CLI";
  if (task.surface === "vscode") return `VS Code（${vscodeAgentLabel(task.agentId, task.displayName)}）`;
  if (task.surface === "desktop") return "桌面 Agent";
  if (task.surface === "gateway") return "Gateway";
  if (task.surface === "service") return "服务";
  if (task.surface === "cli") return "CLI";
  return "本机事件";
}

function isHiddenDockCodexCli(agentId: string, surface: AgentTaskSurface): boolean {
  return dockAgentFamily(agentId) === "codex" && surface === "cli";
}

function endpointConnectionLabel(connection: AgentEndpoint["connection"]): string {
  if (connection === "degraded") return "连接不稳";
  if (connection === "discovered") return "已发现";
  return "在线";
}

function isOnlineExternalEndpoint(endpoint: AgentEndpoint): boolean {
  return endpoint.surface !== "internal"
    && (endpoint.connection === "connected" || endpoint.connection === "discovered" || endpoint.connection === "degraded");
}

function taskMatchesEndpointIdentity(task: AgentTaskSnapshot["tasks"][number], endpoint: AgentEndpoint): boolean {
  // A stable endpoint id is authoritative. Older/local Codex Desktop and CLI
  // rollout events may not carry one, so use their explicit Agent family and
  // surface as a fallback instead of incorrectly showing them as unregistered.
  if (task.endpointId) return task.endpointId === endpoint.endpointId;
  return task.surface === endpoint.surface
    && dockAgentFamily(task.agentId) === dockAgentFamily(endpoint.agentId);
}

function resolveTaskEndpoint(
  task: AgentTaskSnapshot["tasks"][number],
  endpoints: AgentEndpoint[],
): AgentEndpoint | undefined {
  const matches = endpoints.filter((endpoint) => taskMatchesEndpointIdentity(task, endpoint));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Dock 中的活动任务：只筛外部 worker 角色、事件置信度、运行/等待输入，
 * 排除 manual-test（diagnostic）与桌宠主 Agent 内部活动（controller）。
 */
function activeDockTasks(snapshot: AgentTaskSnapshot | null): AgentTaskSnapshot["tasks"] {
  return (snapshot?.tasks ?? []).filter((task) =>
    resolveAgentTaskRole(task) === "worker"
      && task.confidence === "event"
      && (task.state === "running" || task.state === "needs-input")
      && task.source !== "manual-test",
  );
}

function safeDockIdentity(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/(?:[A-Za-z]:[\\/]|^\\\\|^\/)/.test(value)) return fallback;
  return compactMessage(value, 42);
}

/**
 * 区分同一宿主界面的并发任务，只使用观察器已经脱敏、限长的身份元数据。
 * 任务标题是观察器生成的短引用；缺失时退回到任务/会话/事件 ID 的短后缀。
 */
function taskRowIdentitySuffix(task: AgentTaskSnapshot["tasks"][number]): string {
  if (task.taskTitle) return task.taskTitle;
  const reference = task.taskId ?? task.sessionId ?? task.eventId;
  if (!reference) return "";
  return safeDockIdentity(reference, "").slice(0, 8);
}

function renderTaskTray(snapshot: AgentTaskSnapshot | null, endpointSnapshot = currentAgentEndpointSnapshot): void {
  const onlineEndpoints = (endpointSnapshot?.endpoints ?? [])
    .filter(isOnlineExternalEndpoint)
    .filter((endpoint) => !isHiddenDockCodexCli(endpoint.agentId, endpoint.surface));
  const activeTasks = activeDockTasks(snapshot)
    .filter((task) => !isHiddenDockCodexCli(task.agentId, task.surface))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  // 每个活动外部任务/会话单独一行；同一任务的生命周期更新已经在观察器中
  // 归并到稳定 task.id，因此多个并发会话不会再被压成一个聚合行。
  const taskRows = new Map<string, AgentTaskSnapshot["tasks"][number]>();
  for (const task of activeTasks) {
    const key = task.id && task.id.trim()
      ? task.id
      : `${task.surface}:${task.observedAt}:${task.eventId ?? ""}`;
    if (!taskRows.has(key)) taskRows.set(key, task);
  }
  const surfaceTaskCounts = new Map<string, number>();
  for (const task of taskRows.values()) {
    const surfaceKey = `${dockAgentFamily(task.agentId)}:${task.surface}`;
    surfaceTaskCounts.set(surfaceKey, (surfaceTaskCounts.get(surfaceKey) ?? 0) + 1);
  }
  // 在线 endpoint 仍按 Agent 家族 + 宿主界面去重；有活动任务时由任务行承载该界面状态。
  const endpointBySurface = new Map<string, AgentEndpoint>();
  for (const endpoint of onlineEndpoints) {
    const surfaceKey = `${dockAgentFamily(endpoint.agentId)}:${endpoint.surface}`;
    if (!endpointBySurface.has(surfaceKey)) endpointBySurface.set(surfaceKey, endpoint);
  }
  const onlineCount = onlineEndpoints.length;
  const onlineGroupCount = new Set(onlineEndpoints.map((endpoint) => `${dockAgentFamily(endpoint.agentId)}:${endpoint.surface}`)).size;
  const taskCount = activeTasks.length;
  taskTrayToggleCountElement.textContent = String(taskCount);
  taskTrayToggleElement.classList.toggle("task-tray-toggle--has-tasks", taskCount > 0);
  // 没有 endpoint 注册但已经收到事件时，显示活动任务数量，不把合法事件误报为异常状态。
  taskTraySummaryElement.textContent = onlineCount > 0
    ? taskCount > 0
      ? `${onlineGroupCount} 个 Agent · ${taskCount} 任务`
      : `${onlineGroupCount} 个 Agent`
    : taskCount > 0
      ? `${taskCount} 活动任务`
      : "无任务";
  taskTrayToggleElement.hidden = onlineCount === 0 && taskCount === 0;
  taskTrayToggleElement.setAttribute("aria-label", !taskTrayWindowExpanded
    ? onlineCount > 0
      ? `查看 ${onlineGroupCount} 个在线 Agent`
      : taskCount > 0
        ? `查看 ${taskCount} 个活动任务`
        : "查看在线 Agent"
    : "收起在线 Agent");
  if (onlineCount === 0 && taskCount === 0) {
    if (taskTrayClockTimer !== undefined) {
      window.clearInterval(taskTrayClockTimer);
      taskTrayClockTimer = undefined;
    }
    setTaskTrayOpen(false);
    taskTrayListElement.replaceChildren();
    return;
  }
  if (taskTrayClockTimer === undefined) {
    taskTrayClockTimer = window.setInterval(() => renderTaskTray(currentAgentTaskSnapshot), 1000);
  }

  const fragment = document.createDocumentFragment();
  for (const task of taskRows.values()) {
    const surfaceKey = `${dockAgentFamily(task.agentId)}:${task.surface}`;
    const waiting = task.state === "needs-input";
    const connection = endpointBySurface.get(surfaceKey)?.connection;
    const row = document.createElement("article");
    row.className = `task-tray__row ${waiting ? "task-tray__row--waiting" : ""} task-tray__agent-row task-tray__agent-row--${connection ?? (waiting ? "waiting" : "running")}`;
    const top = document.createElement("div");
    top.className = "task-tray__row-top";
    const identity = document.createElement("strong");
    const label = taskSurfaceLabel(task);
    const suffix = taskRowIdentitySuffix(task);
    identity.textContent = (surfaceTaskCounts.get(surfaceKey) ?? 0) > 1 && suffix
      ? `${label} · ${suffix}`
      : label;
    const count = document.createElement("span");
    count.textContent = `耗时 ${elapsedTaskLabel(task.startedAt, task.observedAt)}`;
    top.append(identity, count);

    const status = document.createElement("div");
    status.className = "task-tray__row-status";
    const state = document.createElement("b");
    state.textContent = waiting ? "待输入" : "运行中";
    const behavior = document.createElement("span");
    behavior.textContent = task.activity ? agentTaskActivityLabel(task.activity) : "实际行为";
    status.append(state, behavior);
    row.append(top, status);
    fragment.append(row);
  }
  for (const [surfaceKey, endpoint] of endpointBySurface) {
    if (surfaceTaskCounts.has(surfaceKey)) continue;
    const connection = endpoint.connection;
    const row = document.createElement("article");
    row.className = `task-tray__row task-tray__agent-row task-tray__agent-row--${connection}`;
    const top = document.createElement("div");
    top.className = "task-tray__row-top";
    const identity = document.createElement("strong");
    identity.textContent = endpointSurfaceLabel(endpoint);
    const count = document.createElement("span");
    count.textContent = endpointConnectionLabel(connection ?? "discovered");
    top.append(identity, count);

    const status = document.createElement("div");
    status.className = "task-tray__row-status";
    const state = document.createElement("b");
    state.textContent = "在线";
    const behavior = document.createElement("span");
    behavior.textContent = "实际行为";
    status.append(state, behavior);
    row.append(top, status);
    fragment.append(row);
  }
  taskTrayListElement.replaceChildren(fragment);
}

const STATUS_LIGHT_ORBIT_NORMAL_DURATION_MS = 5800;
const STATUS_LIGHT_SQUARE_NORMAL_DURATION_MS = 5200;
const STATUS_LIGHT_ORBIT_THINKING_DURATION_MS = 2400;
const STATUS_LIGHT_SQUARE_THINKING_DURATION_MS = 2200;
let statusLightAnimationSpeedKey = "";
let statusLightAnimationSyncFrame: number | null = null;

function syncStatusLightAnimationSpeed(motion: string, activity?: AgentTaskActivity): void {
  const thinking = activity === "thinking";
  const speedKey = `${motion}:${thinking ? "thinking" : "normal"}`;
  if (speedKey === statusLightAnimationSpeedKey) return;
  statusLightAnimationSpeedKey = speedKey;
  if (statusLightAnimationSyncFrame !== null) window.cancelAnimationFrame(statusLightAnimationSyncFrame);
  statusLightAnimationSyncFrame = window.requestAnimationFrame(() => {
    statusLightAnimationSyncFrame = null;
    const currentMotion = perceptionStatusLightElement.dataset.motion ?? "static";
    if (currentMotion !== "orbit" && currentMotion !== "square") return;
    const currentThinking = perceptionStatusLightElement.dataset.activity === "thinking";
    const normalDuration = currentMotion === "orbit"
      ? STATUS_LIGHT_ORBIT_NORMAL_DURATION_MS
      : STATUS_LIGHT_SQUARE_NORMAL_DURATION_MS;
    const thinkingDuration = currentMotion === "orbit"
      ? STATUS_LIGHT_ORBIT_THINKING_DURATION_MS
      : STATUS_LIGHT_SQUARE_THINKING_DURATION_MS;
    const playbackRate = normalDuration / (currentThinking ? thinkingDuration : normalDuration);
    perceptionStatusLightElement.getAnimations().forEach((animation) => {
      animation.playbackRate = playbackRate;
    });
  });
}

function renderPetPerceptionStatus(snapshot: PetPerceptionSnapshot | null): void {
  perceptionStatusLightElement.dataset.motion = petPerceptionSettings.statusLightMotion || "static";
  const aggregate = petPerceptionSettings.enabled ? snapshot?.aggregate : undefined;
  if (!aggregate) {
    statusLightAnimationSpeedKey = "";
    if (statusLightAnimationSyncFrame !== null) {
      window.cancelAnimationFrame(statusLightAnimationSyncFrame);
      statusLightAnimationSyncFrame = null;
    }
    perceptionStatusLightElement.hidden = true;
    perceptionStatusLabelElement.hidden = true;
    perceptionStatusLightElement.removeAttribute("data-phase");
    perceptionStatusLightElement.removeAttribute("data-activity");
    perceptionStatusLightElement.removeAttribute("title");
    perceptionStatusLightElement.setAttribute("aria-label", "桌宠感知未开启");
    perceptionStatusLabelElement.textContent = "";
    return;
  }

  const phaseLabel = aggregate.phase === "working"
    ? "处理中"
    : aggregate.phase === "starting"
      ? "启动中"
      : aggregate.phase === "waiting"
        ? "等待中"
        : aggregate.phase === "offline"
          ? "已暂停"
          : aggregate.phase === "error"
            ? "需要注意"
            : aggregate.phase === "success"
              ? "已完成"
              : "感知中";
  const taskCounts = agentTaskCounts(currentAgentTaskSnapshot);
  const currentTask = currentAgentTaskSnapshot?.tasks
    .filter((task) => task.state === "running" || task.state === "needs-input")
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  const activityLabel = agentTaskActivityLabel(currentTask?.activity);
  const activeTaskCount = currentAgentTaskSnapshot
    ? taskCounts.active + taskCounts.waiting
    : aggregate.activeTaskCount;
  const taskStatus = currentAgentTaskSnapshot
    ? `任务 ${activeTaskCount}处理中${activityLabel ? ` · ${activityLabel}` : ""} · ${taskCounts.waiting}待输入 · ${taskCounts.ready}完成 · ${taskCounts.blocked}异常`
    : `任务 ${activeTaskCount}`;
  const compactCounts = `Agent ${aggregate.availableAgentCount}/${aggregate.configuredAgentCount} · ${taskStatus} · Bot ${aggregate.connectedChannelCount}/${aggregate.configuredChannelCount}`;
  perceptionStatusLightElement.hidden = false;
  perceptionStatusLabelElement.hidden = false;
  perceptionStatusLightElement.dataset.phase = aggregate.phase;
  perceptionStatusLightElement.dataset.activity = currentTask?.activity ?? "none";
  syncStatusLightAnimationSpeed(perceptionStatusLightElement.dataset.motion, currentTask?.activity);
  perceptionStatusLightElement.title = `桌宠感知 · ${aggregate.detail}${currentTask?.detail ? ` · ${currentTask.detail}` : ""}。开关位于设置中心 · 桌宠感知`;
  perceptionStatusLightElement.setAttribute("aria-label", `桌宠感知${phaseLabel}，${compactCounts}。开关位于设置中心 · 桌宠感知`);
  perceptionStatusLabelElement.textContent = `${phaseLabel}  ·  ${compactCounts}`;
}

function clearSpeechTimers(): void {
  if (speechTimer !== undefined) {
    window.clearTimeout(speechTimer);
    speechTimer = undefined;
  }
  if (thinkingTimer !== undefined) {
    window.clearInterval(thinkingTimer);
    thinkingTimer = undefined;
  }
}

function renderSpeechBubble(kind: string, title: string, detail = ""): void {
  speechBubbleElement.dataset.kind = kind;
  speechBubbleElement.textContent = detail ? `${title}\n${compactMessage(detail, 42)}` : title;
  speechBubbleElement.classList.remove("speech-bubble--visible");
  // Restart the pop animation when two messages arrive close together.
  void speechBubbleElement.offsetWidth;
  speechBubbleElement.classList.add("speech-bubble--visible");
}

function showBotBubble(
  kind: "online" | "received" | "thinking" | "sent" | "error",
  title: string,
  detail = "",
  duration = 5200,
): void {
  if (!showBotBubbles || (kind === "thinking" && !showThinkingBubbles)) {
    clearSpeechTimers();
    speechBubbleElement.classList.remove("speech-bubble--visible");
    return;
  }
  if (kind === "thinking") {
    startThinkingBubble();
    return;
  }
  clearSpeechTimers();
  renderSpeechBubble(kind, title, detail);
  speechTimer = window.setTimeout(() => {
    speechBubbleElement.classList.remove("speech-bubble--visible");
    speechTimer = undefined;
  }, duration);
}

function startThinkingBubble(): void {
  clearSpeechTimers();
  thinkingIndex = 0;
  const update = (): void => {
    const messages = thinkingMessages();
    const [title, detail] = messages[thinkingIndex];
    renderSpeechBubble("thinking", title, detail);
    thinkingIndex = (thinkingIndex + 1) % messages.length;
  };
  update();
  thinkingTimer = window.setInterval(update, 3000);
}

function showNextAgentCompletion(): void {
  agentCompletionQueueTimer = undefined;
  const notice = agentCompletionQueue.shift();
  if (!notice || !petPerceptionSettings.enabled || !petPerceptionSettings.taskCompletionNotice) return;
  const { event, completion } = notice;

  const interrupted = completion.terminalState === "interrupted";
  const failed = event.type === "task.failed" || event.status === "failed";
  stateMachine.setState(completion.success ? "happy" : "angry");
  petAI.reset();
  const title = event.title || `${completion.displayName}${interrupted ? "任务中断" : failed ? "任务失败" : "任务完成"}`;
  const detail = [
    event.message || completionDetailForDisplay(completion),
    completion.workspaceLabel ? `工作区：${completion.workspaceLabel}` : "",
    completion.startedAt && completion.completedAt ? `耗时：${elapsedCompletionLabel(completion.startedAt, completion.completedAt)}` : "",
  ].filter(Boolean).join(" · ");
  showBotBubble(
    failed ? "error" : "sent",
    title,
    detail,
    6200,
  );
  if (agentCompletionQueue.length > 0) {
    agentCompletionQueueTimer = window.setTimeout(showNextAgentCompletion, 6200);
  }
}

function elapsedCompletionLabel(startedAt: string, completedAt: string): string {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return "未知";
  const elapsed = Math.floor((completed - started) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function enqueueAgentEvent(event: AgentEvent, completion: AgentTaskCompletion): void {
  if (!agentCompletionQueue.some((item) => item.event.id === event.id)) {
    agentCompletionQueue.push({ event, completion });
  }
  if (agentCompletionQueueTimer === undefined) showNextAgentCompletion();
}

const agentStatusTitles: Record<AgentStatus, string> = {
  starting: "后台 Agent 启动中",
  thinking: "小脑袋转呀转",
  tool: "正在调用工具",
  command: "正在执行命令",
  network: "正在检索资料",
  waiting: "暂时等待一下",
  "response-ready": "回复已经准备好",
  sending: "正在发送回复",
  completed: "处理完成啦",
  failed: "Agent 这次没完成",
};

function showAgentStatus(status: AgentStatus, detail: string): void {
  if (!showBotBubbles || !showThinkingBubbles) {
    clearSpeechTimers();
    speechBubbleElement.classList.remove("speech-bubble--visible");
    return;
  }

  clearSpeechTimers();
  renderSpeechBubble("thinking", agentStatusTitles[status], detail);
  if (status === "completed" || status === "failed") {
    speechTimer = window.setTimeout(() => {
      speechBubbleElement.classList.remove("speech-bubble--visible");
      speechTimer = undefined;
    }, 3000);
  }
}

function applyAgentVisualState(status: AgentStatus): void {
  if (status === "starting" || status === "thinking") {
    stateMachine.setState("shy");
  } else if (status === "tool" || status === "command") {
    stateMachine.setState("walk");
  } else if (status === "network" || status === "waiting") {
    stateMachine.setState("sleep");
  } else if (status === "failed") {
    stateMachine.setState("angry");
  } else {
    stateMachine.setState("happy");
  }
  petAI.reset();
}

let petStyleRequestId = 0;
let mainThemeTransitionSequence = 0;
let petStatusCenterCalibrated = false;
let petStatusCenterStyleId = "";
let runtimeStateInfo = new Map<string, { name: string; description: string; fallbackState: PetState }>(
  defaultPetStyleAssets.cycleStates.map((state) => [state.id, state]),
);

function applyMainTheme(theme: string): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const sequence = ++mainThemeTransitionSequence;
  root.classList.add("is-theme-transitioning");
  root.dataset.theme = theme;
  window.setTimeout(() => {
    if (mainThemeTransitionSequence === sequence) root.classList.remove("is-theme-transitioning");
  }, 560);
}

const unsubscribeSettings = api.settings.subscribe((settings) => {
  applyMainTheme(settings.theme);
  petName = settings.petName || DEFAULT_PET_NAME;
  updatePetIdentity();
  showBotBubbles = settings.showWeChatBubbles;
  showThinkingBubbles = settings.showThinkingBubbles;
  petPerceptionSettings = settings.petPerception;
  if (!petPerceptionSettings.enabled || !petPerceptionSettings.taskCompletionNotice) {
    agentCompletionQueue = [];
    if (agentCompletionQueueTimer !== undefined) {
      window.clearTimeout(agentCompletionQueueTimer);
      agentCompletionQueueTimer = undefined;
    }
  }
  petReactionCoordinator?.setSettings(settings.petPerception);
  renderPetPerceptionStatus(currentPetPerceptionSnapshot);
  const requestId = ++petStyleRequestId;
  void api.petStyles.assets(settings.activePetStyleId).then((assets) => {
    if (requestId !== petStyleRequestId) return;
    if (petStatusCenterStyleId !== settings.activePetStyleId) {
      petStatusCenterStyleId = settings.activePetStyleId;
      petStatusCenterCalibrated = false;
    }
    runtimeStateInfo = new Map(assets.cycleStates.map((state) => [state.id, state]));
    stateMachine.setCycleStates(assets.cycleStates.map((state) => state.id));
    petAI.setActionPool(assets.cycleStates.map((state) => state.id));
    threePetScene.setPetStyleAssets(assets, settings.activePetStyleId !== "default-penguin");
    renderState(stateMachine.getState());
  }).catch((error) => console.warn("Unable to load selected pet style.", error));
  if (!showBotBubbles || (settings.showThinkingBubbles === false && speechBubbleElement.dataset.kind === "thinking")) {
    clearSpeechTimers();
    speechBubbleElement.classList.remove("speech-bubble--visible");
  }
});

spriteElement.style.backgroundImage = `url("${spriteSheetUrl}")`;

const TASK_TRAY_IDLE_DELAY_MS = 1800;
const TASK_TRAY_HOVER_GRACE_MS = 96;
let petHovered = false;
let taskTrayHovered = false;
let taskTrayFocused = false;
let taskTrayPointerInteraction = false;
let taskTrayIdleTimer: number | undefined;
let taskTrayHoverReleaseTimer: number | undefined;

function clearTaskTrayIdleTimer(): void {
  if (taskTrayIdleTimer === undefined) return;
  window.clearTimeout(taskTrayIdleTimer);
  taskTrayIdleTimer = undefined;
}

function clearTaskTrayHoverReleaseTimer(): void {
  if (taskTrayHoverReleaseTimer === undefined) return;
  window.clearTimeout(taskTrayHoverReleaseTimer);
  taskTrayHoverReleaseTimer = undefined;
}

function hasTaskTrayHoverTarget(): boolean {
  return petHovered || taskTrayHovered || taskTrayFocused;
}

function scheduleTaskTrayHoverRelease(): void {
  clearTaskTrayHoverReleaseTimer();
  if (hasTaskTrayHoverTarget()) {
    api.setMousePassthrough(false);
    return;
  }
  taskTrayHoverReleaseTimer = window.setTimeout(() => {
    taskTrayHoverReleaseTimer = undefined;
    if (hasTaskTrayHoverTarget()) return;
    api.setMousePassthrough(true);
    collapseTaskTrayToggle();
  }, TASK_TRAY_HOVER_GRACE_MS);
}

function revealTaskTrayToggle(): void {
  clearTaskTrayHoverReleaseTimer();
  clearTaskTrayIdleTimer();
  taskTrayToggleElement.classList.remove("task-tray-toggle--idle");
}

function collapseTaskTrayToggle(): void {
  clearTaskTrayIdleTimer();
  taskTrayToggleElement.classList.add("task-tray-toggle--idle");
}

function scheduleTaskTrayIdle(): void {
  clearTaskTrayIdleTimer();
  if (petHovered || taskTrayHovered || taskTrayFocused) {
    revealTaskTrayToggle();
    return;
  }
  taskTrayToggleElement.classList.remove("task-tray-toggle--idle");
  taskTrayIdleTimer = window.setTimeout(() => {
    taskTrayIdleTimer = undefined;
    if (!petHovered && !taskTrayHovered && !taskTrayFocused && taskTrayElement.hidden) {
      taskTrayToggleElement.classList.add("task-tray-toggle--idle");
    }
  }, TASK_TRAY_IDLE_DELAY_MS);
}

function setPetHoverState(hovered: boolean): void {
  petHovered = hovered;
  if (hovered) {
    revealTaskTrayToggle();
    api.setMousePassthrough(false);
  } else {
    scheduleTaskTrayHoverRelease();
  }
}

function setTaskTrayHoverState(hovered: boolean): void {
  taskTrayHovered = hovered;
  if (hovered) {
    revealTaskTrayToggle();
    api.setMousePassthrough(false);
  } else {
    scheduleTaskTrayHoverRelease();
  }
}

let pendingWindowDragMoveFrame: number | null = null;
const requestWindowDragMove = (): void => {
  if (pendingWindowDragMoveFrame !== null) return;
  pendingWindowDragMoveFrame = window.requestAnimationFrame(() => {
    pendingWindowDragMoveFrame = null;
    api.moveWindow();
  });
};
const finishWindowDrag = (): void => {
  if (pendingWindowDragMoveFrame !== null) {
    window.cancelAnimationFrame(pendingWindowDragMoveFrame);
    pendingWindowDragMoveFrame = null;
  }
  // Flush the latest cursor position before ending the native drag session.
  api.moveWindow();
  api.endWindowDrag();
};

const threePetScene = new ThreePetScene(canvasElement, {
  petStyleAssets: defaultPetStyleAssets,
  petStyleIsCustom: false,
  onTap: () => {
    petReactionCoordinator?.markManualOverride();
    stateMachine.cycle();
    petAI.reset();
  },
  onMoveWindowStart: () => api.beginWindowDrag(),
  onMoveWindow: requestWindowDragMove,
  onMoveWindowEnd: finishWindowDrag,
  onWindowShapeChange: (rects) => api.setWindowShape(rects),
  onPetVisualBoundsChange: (bounds) => {
    if (!petStatusCenterCalibrated) {
      // Keep the Dock attached to the visible Alpha silhouette instead of
      // leaving it at the bottom of the transparent 340px window.
      app.style.setProperty("--pet-dock-top", `${Math.ceil(bounds.top + bounds.height + 8)}px`);
    }
    if (petStatusCenterCalibrated) return;
    petVisualElement.style.setProperty("--pet-status-center-x", `${bounds.left + bounds.width / 2}px`);
    petVisualElement.style.setProperty("--pet-status-center-y", `${bounds.top + bounds.height / 2}px`);
    petStatusCenterCalibrated = true;
  },
  onContextMenu: () => api.showContextMenu(),
  onHoverChange: (hovered) => {
    setPetHoverState(hovered);
  },
  onVideoWarning: (message) => showBotBubble("error", "宠物视频未启用", message, 7000),
});

if (threePetScene.available) {
  spriteElement.hidden = true;
  spriteTransitionElement.hidden = true;
  petStageElement.classList.add("pet-stage--3d");
}

function startSpriteTransition(): void {
  if (!spriteElement.style.backgroundPosition) return;
  if (spriteTransitionFrameId !== undefined) {
    window.cancelAnimationFrame(spriteTransitionFrameId);
  }

  spriteTransitionElement.hidden = false;
  spriteTransitionElement.style.backgroundImage = spriteElement.style.backgroundImage;
  spriteTransitionElement.style.backgroundPosition = spriteElement.style.backgroundPosition;
  spriteTransitionElement.style.opacity = "1";
  spriteTransitionElement.style.transform = "translateX(-50%) scale(2.19)";
  spriteElement.style.opacity = "0";
  spriteElement.style.transform = "translateX(-50%) scale(2.07)";
  spriteTransitionFrameId = window.requestAnimationFrame(() => {
    spriteTransitionElement.style.opacity = "0";
    spriteTransitionElement.style.transform = "translateX(-50%) scale(2.15)";
    spriteElement.style.opacity = "1";
    spriteElement.style.transform = "translateX(-50%) scale(2.15)";
    spriteTransitionFrameId = undefined;
  });
}

let renderedState: string | undefined;

function renderState(state: string): void {
  const runtimeState = runtimeStateInfo.get(state);
  const fallbackState = runtimeState?.fallbackState ?? (state in animations ? state as PetState : "idle");
  const definition = animations[fallbackState];
  const stateChanged = renderedState !== undefined && renderedState !== state;
  if (!speechBubbleElement.classList.contains("speech-bubble--visible")) {
    speechBubbleElement.textContent = runtimeState?.description ?? descriptions[fallbackState];
  }
  stateLabelElement.textContent = `· ${runtimeState?.name ?? labels[fallbackState] ?? "自定义状态"}`;
  petStageElement.dataset.state = state;
  threePetScene.setState(state);

  if (!threePetScene.available) {
    if (stateChanged) startSpriteTransition();
    animationManager.play(fallbackState, (frame) => {
      const x = 143 + frame * 80;
      const y = definition.row === 0 ? 0 : [80, 158, 236, 315, 395, 478][definition.row - 1];
      spriteElement.style.backgroundPosition = `-${x}px -${y}px`;
    });
  }
  renderedState = state;
}


stateMachine.subscribe(({ to }) => renderState(to));

petStageElement.addEventListener("click", (event) => {
  if (threePetScene.available && event.target !== petStageElement) return;
  petReactionCoordinator?.markManualOverride();
  stateMachine.cycle();
  petAI.reset();
});

taskTrayToggleElement.addEventListener("click", (event) => {
  event.stopPropagation();
  const nextOpen = !taskTrayWindowExpanded;
  setTaskTrayOpen(nextOpen);
  if (!nextOpen) scheduleTaskTrayIdle();
  else revealTaskTrayToggle();
});

taskTrayCloseElement.addEventListener("click", (event) => {
  event.stopPropagation();
  setTaskTrayOpen(false);
  scheduleTaskTrayIdle();
});

function isDockInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".task-tray-toggle, .task-tray"));
}

document.addEventListener("pointermove", (event) => {
  // The transparent pet window normally ignores mouse events outside the pet
  // silhouette. Keep the bottom dock clickable while the pointer is over it.
  if (isDockInteractiveTarget(event.target)) api.setMousePassthrough(false);
});

taskTrayToggleElement.addEventListener("pointerenter", () => {
  setTaskTrayHoverState(true);
  api.setMousePassthrough(false);
});
taskTrayToggleElement.addEventListener("pointerleave", () => setTaskTrayHoverState(false));
taskTrayToggleElement.addEventListener("pointerdown", () => {
  // Pointer activation must not leave a stale DOM focus flag that prevents
  // the Dock from shrinking when the mouse leaves the control.
  taskTrayPointerInteraction = true;
  taskTrayFocused = false;
});
taskTrayToggleElement.addEventListener("pointerup", () => {
  taskTrayPointerInteraction = false;
});
taskTrayToggleElement.addEventListener("pointercancel", () => {
  taskTrayPointerInteraction = false;
});
taskTrayElement.addEventListener("pointerenter", () => {
  setTaskTrayHoverState(true);
  api.setMousePassthrough(false);
});
taskTrayElement.addEventListener("pointerleave", () => setTaskTrayHoverState(false));
taskTrayToggleElement.addEventListener("focus", () => {
  taskTrayFocused = !taskTrayPointerInteraction;
  revealTaskTrayToggle();
});
taskTrayToggleElement.addEventListener("blur", () => {
  taskTrayFocused = false;
  scheduleTaskTrayIdle();
});

document.addEventListener("pointerdown", (event) => {
  if (!taskTrayWindowExpanded) return;
  const target = event.target;
  if (target instanceof Node && !taskTrayElement.contains(target) && !taskTrayToggleElement.contains(target)) {
    setTaskTrayOpen(false);
    scheduleTaskTrayIdle();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !taskTrayWindowExpanded) return;
  setTaskTrayOpen(false, true);
});

app.querySelectorAll<HTMLButtonElement>("[data-state]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextState = button.dataset.state as PetState | undefined;
    if (nextState) {
      petReactionCoordinator?.markManualOverride();
      stateMachine.setState(nextState);
      petAI.reset();
    }
  });
});

petReactionCoordinator = new PetReactionCoordinator({
  setState: (state) => {
    if (!stateMachine.setState(state)) renderState(state);
  },
  resetPet: () => petAI.reset(),
  showBubble: (kind, title, detail, duration) => showBotBubble(kind, title, detail, duration),
  resolveState: (phase) => {
    const preferredState = phase === "error"
      ? "angry"
      : phase === "success" || phase === "received"
        ? "happy"
        : phase === "working"
          ? "walk"
          : phase === "starting"
            ? "shy"
            : phase === "waiting" || phase === "offline"
              ? "sleep"
              : "idle";
    const customState = runtimeStateInfo.get(preferredState);
    return customState?.fallbackState ?? preferredState;
  },
});
petReactionCoordinator.setSettings(petPerceptionSettings);

let currentWeChatStatus: WeChatStatus = {
  state: "disconnected",
  connected: false,
  detail: "正在检查微信连接…",
  lastError: "",
  retryCount: 0,
  nextRetryAt: null,
};

function renderWeChatStatus(status: WeChatStatus): void {
  currentWeChatStatus = status;
  wechatStatusElement.dataset.status = status.state;
  const detail = status.detail.trim();
  if (status.connected && detail.includes("会话上下文已失效")) {
    const refreshDetail = detail.replace(/^已连接/, "").replace(/^[，,]/, "").trim();
    wechatStatusElement.textContent = ["微信已连接", refreshDetail || "主动通知会自动重试"].join(String.fromCharCode(10));
    return;
  }
  wechatStatusElement.textContent = status.connected && detail.startsWith("已连接")
    ? `微信${detail}`
    : `${status.connected ? "微信已连接" : "微信"} · ${detail}`;
}

const platformNames: Record<BotPlatform, string> = {
  wechat: "微信",
  qq: "QQ",
  feishu: "飞书",
  dingtalk: "钉钉",
};

const unsubscribePetPerception = api.petPerception.subscribe((event: PetPerceptionEvent) => {
  petReactionCoordinator?.handleEvent(event);
});

const unsubscribePetPerceptionSnapshot = api.petPerception.subscribeSnapshot((snapshot) => {
  currentPetPerceptionSnapshot = snapshot;
  renderPetPerceptionStatus(snapshot);
});

const unsubscribePetWindowEdge = api.onWindowEdge(({ left, right, top }) => {
  perceptionStatusLightElement.dataset.edge = left ? "left" : right ? "right" : "none";
  perceptionStatusLightElement.dataset.topEdge = top ? "top" : "none";
});

const unsubscribeAgentTasks = api.agentTasks.subscribe((snapshot) => {
  currentAgentTaskSnapshot = snapshot;
  renderPetPerceptionStatus(currentPetPerceptionSnapshot);
  renderTaskTray(snapshot);
});

const unsubscribeAgentEvents = api.agentEvents.subscribe((event) => {
  if (event.type !== "task.completed" && event.type !== "task.failed") return;
  const rawCompletion = event.metadata?.completion;
  if (!rawCompletion || typeof rawCompletion !== "object") return;
  enqueueAgentEvent(event, rawCompletion as AgentTaskCompletion);
});

const unsubscribeAgentEndpoints = api.agentEndpoints.subscribe((snapshot) => {
  currentAgentEndpointSnapshot = snapshot;
  renderTaskTray(currentAgentTaskSnapshot, snapshot);
});

const unsubscribeChannels = api.channels.subscribe((event: BotChannelEvent) => {
  const platform = event.type === "status" ? event.status.platform : event.type === "message"
    ? event.message.platform
    : event.platform;
  // WeChat's normal inbound/reply stream is rendered by api.wechat below.
  // Keep failed task-notification replies from the generic channel stream so
  // a queued/undelivered notice is still visible in the robot information bar.
  if (event.type === "status") return;
  if (platform === "wechat" && (event.type !== "reply" || event.delivered)) return;
  const platformName = platformNames[platform];

  if (event.type === "message") {
    const sender = event.message.senderName || event.message.senderId;
    wechatFeedMetaElement.textContent = `收到${platformName}消息 · ${sender}`;
    wechatFeedBodyElement.textContent = event.message.text;
    if (petPerceptionSettings.enabled) return;
    const action = event.message.action ?? "happy";
    if (!stateMachine.setState(action)) renderState(action);
    petAI.reset();
    showBotBubble("received", `叮咚！收到${platformName}消息啦～`, event.message.text);
    return;
  }

  if (event.type === "agent-status") {
    wechatFeedMetaElement.textContent = `${platformName} Agent · ${agentStatusTitles[event.status]}`;
    wechatFeedBodyElement.textContent = event.detail;
    if (petPerceptionSettings.enabled) return;
    applyAgentVisualState(event.status);
    showAgentStatus(event.status, event.detail);
    return;
  }

  if (event.type === "reply") {
    wechatFeedMetaElement.textContent = event.delivered ? `${platformName}回复已发送` : `${platformName}回复未送达`;
    wechatFeedBodyElement.textContent = event.text;
    if (petPerceptionSettings.enabled) return;
    stateMachine.setState(event.delivered ? "happy" : "angry");
    petAI.reset();
    showBotBubble(
      event.delivered ? "sent" : "error",
      event.delivered ? `${platformName}回复送达啦～` : `${platformName}回复没有送达`,
      event.text,
    );
    return;
  }

  wechatFeedMetaElement.textContent = `${platformName}机器人异常`;
  wechatFeedBodyElement.textContent = event.message;
  if (petPerceptionSettings.enabled) return;
  stateMachine.setState("angry");
  petAI.reset();
  showBotBubble("error", `${platformName}连接出了点问题`, event.message, 6500);
});

const unsubscribeWeChat = api.wechat.subscribe((event: WeChatEvent) => {
  if (event.type === "connection") {
    renderWeChatStatus(event);
    if (petPerceptionSettings.enabled) return;
    if (event.state === "connected") {
      stateMachine.setState("happy");
      petAI.reset();
      showBotBubble("online", "微信机器人上线啦～", "可以陪你聊天了");
    }
    return;
  }

  if (event.type === "thinking") {
    wechatFeedMetaElement.textContent = "微信机器人正在回复";
    wechatFeedBodyElement.dataset.hasRuntimeMessage = "true";
    wechatFeedBodyElement.textContent = `${petName}陪你等一下，后台 Agent 正在思考……`;
    if (petPerceptionSettings.enabled) return;
    stateMachine.setState("shy");
    petAI.reset();
    showBotBubble("thinking", "让我想一想呀～", `${petName}正在帮你回复`);
    return;
  }

  if (event.type === "agent-status") {
    wechatFeedMetaElement.textContent = `后台 Agent · ${agentStatusTitles[event.status]}`;
    wechatFeedBodyElement.textContent = event.detail;
    if (petPerceptionSettings.enabled) return;
    applyAgentVisualState(event.status);
    showAgentStatus(event.status, event.detail);
    return;
  }

  if (event.type === "message") {
    wechatFeedMetaElement.textContent = `收到微信消息 · ${event.from}`;
    wechatFeedBodyElement.textContent = event.text;
    if (petPerceptionSettings.enabled) return;
    if (!stateMachine.setState(event.action)) renderState(event.action);
    petAI.reset();
    showBotBubble("received", "叮咚！收到消息啦～", event.text);
    return;
  }

  if (event.type === "blocked") {
    wechatFeedMetaElement.textContent = "微信白名单已拦截";
    wechatFeedBodyElement.textContent = `用户 ${event.from} 不在允许列表中`;
    showBotBubble("error", "这位用户暂未开放", "可在设置中心调整微信白名单");
    return;
  }

  if (event.type === "qr-login") return;

  if (event.type === "reply") {
    wechatFeedMetaElement.textContent = `机器人回复 · ${event.to}`;
    wechatFeedBodyElement.textContent = event.text;
    if (petPerceptionSettings.enabled) return;
    stateMachine.setState("happy");
    petAI.reset();
    showBotBubble("sent", "回复送达啦～", event.text);
    return;
  }

  const errorCategory = event.category ?? (
    /^回复失败（/.test(event.message)
      ? "agent"
      : /^(?:发送失败|即时回执发送失败)/.test(event.message)
        ? "delivery"
        : "connection"
  );
  const errorTitle = errorCategory === "agent"
    ? "Agent 执行失败"
    : errorCategory === "target"
      ? "等待机器人对话"
    : errorCategory === "delivery"
      ? "微信消息发送失败"
      : "微信连接异常";
  const errorBubbleTitle = errorCategory === "agent"
    ? "Agent 这次没有完成回复"
    : errorCategory === "target"
      ? "请先和机器人说句话哦"
    : errorCategory === "delivery"
      ? "微信消息没有送达"
      : "呜呜，微信连接打了个喷嚏…";
  wechatFeedMetaElement.textContent = errorTitle;
  wechatFeedBodyElement.textContent = event.message;
  if (petPerceptionSettings.enabled) return;
  stateMachine.setState("angry");
  petAI.reset();
  showBotBubble("error", errorBubbleTitle, event.message, 6500);
});

void api.wechat.getStatus().then(renderWeChatStatus);
app.querySelector<HTMLButtonElement>(".close-button")?.addEventListener("click", () => {
  void api.hide();
});

void api.version().then((version) => {
  const caption = app.querySelector<HTMLElement>(".pet-caption");
  if (caption) caption.title = `Electron ${version}`;
});

renderState(stateMachine.getState());
petAI.start();
}
