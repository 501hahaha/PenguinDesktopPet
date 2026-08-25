import { contextBridge, ipcRenderer } from "electron";
import type { WeChatEvent, WeChatStatus } from "./wechat/events";
import type { CcSwitchImportResult, CcSwitchStatus, UpdateCheckResult } from "./systemTypes";
import type { BotChannelEvent, ChannelStatus } from "./channels/types";
import type { QQQrLoginEvent } from "./channels/qqQrLogin";
import type { FeishuQrLoginEvent } from "./channels/feishuQrLogin";
import type { AgentConfig, AgentControllerStatus, AgentHealthCheckResult, AgentModelOption, AgentTestResult, LocalAgentInfo } from "../agents/types";
import type { AgentEndpointSnapshot } from "./agents/AgentEndpointRegistry";
import type { LocalDataActionResult, LocalDataSummary, PetSettings, PetSettingsUpdate, PetStyle, PetStyleActionResult, PetStyleAssetUrls } from "../settings/types";
import type { AgentTaskSnapshot, PetPerceptionEvent, PetPerceptionRun, PetPerceptionSnapshot } from "./pet/perceptionTypes";
import type { MemoryEntry, MemoryEntryStatus } from "./agents/orchestrationTypes";
import type { MemorySummary } from "./memory/MemoryStore";
import type { MemoryRebuildResult } from "./memory/memoryTypes";
import type { DesktopCaptureDisplay } from "./media/DesktopCaptureService";
import type { AgentWindowFollowStatus } from "./media/AgentWindowTracker";
import type { AgentEvent } from "./events/EventTypes";
import type { WebModelProvider, WebModelModel } from "./agents/WebModelRuntimeTypes";
import type { ZeroTokenProviderStatus } from "./agents/ZeroTokenProvider";
import type { RuntimeLogEntry, RuntimeProvider } from "./runtime/types";

interface WindowShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * preload 白名单边界。
 *
 * renderer 只能看到这里暴露的方法；微信事件只读订阅（单向推送），
 * 发送必须显式调用 sendReply，绝不向 renderer 暴露 Node / 网络 / token。
 */
contextBridge.exposeInMainWorld("penguinPet", {
  hide: () => ipcRenderer.invoke("pet:hide"),
  close: () => ipcRenderer.invoke("pet:close"),
  beginWindowDrag: () => ipcRenderer.send("pet:drag-start"),
  endWindowDrag: () => ipcRenderer.send("pet:drag-end"),
  moveWindow: () => ipcRenderer.send("pet:move"),
  onWindowEdge: (listener: (edge: { left: boolean; right: boolean; top: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const edge = payload && typeof payload === "object" ? payload as { left?: unknown; right?: unknown; top?: unknown } : {};
      listener({ left: edge.left === true, right: edge.right === true, top: edge.top === true });
    };
    ipcRenderer.on("pet:window-edge", handler);
    return () => ipcRenderer.removeListener("pet:window-edge", handler);
  },
  setWindowShape: (rects: WindowShapeRect[]) => ipcRenderer.send("pet:set-shape", rects),
  setTaskTrayExpanded: (expanded: boolean) => ipcRenderer.send("pet:task-tray-expanded", expanded),
  showContextMenu: () => ipcRenderer.send("pet:context-menu"),
  setMousePassthrough: (ignore: boolean) => ipcRenderer.send("pet:mouse-passthrough", ignore),
  version: () => ipcRenderer.invoke("pet:version") as Promise<string>,
  agents: {
    discover: () => ipcRenderer.invoke("agents:discover") as Promise<LocalAgentInfo[]>,
    models: (config: AgentConfig) => ipcRenderer.invoke("agents:models", config) as Promise<AgentModelOption[]>,
    test: (config: AgentConfig) => ipcRenderer.invoke("agents:test", config) as Promise<AgentTestResult>,
    healthCheck: (config: AgentConfig) => ipcRenderer.invoke("agents:health-check", config) as Promise<AgentHealthCheckResult>,
  },
  controller: {
    status: () => ipcRenderer.invoke("controller:status") as Promise<AgentControllerStatus>,
  },
  petPerception: {
    getStatus: () => ipcRenderer.invoke("pet-perception:status") as Promise<PetPerceptionSnapshot | null>,
    trigger: (signal: string) => ipcRenderer.invoke("pet-perception:trigger", signal) as Promise<PetPerceptionRun>,
    subscribe: (listener: (event: PetPerceptionEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PetPerceptionEvent) => listener(payload);
      ipcRenderer.on("pet-perception:event", handler);
      ipcRenderer.send("pet-perception:subscribe");
      return () => ipcRenderer.removeListener("pet-perception:event", handler);
    },
    subscribeSnapshot: (listener: (snapshot: PetPerceptionSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PetPerceptionSnapshot) => listener(payload);
      ipcRenderer.on("pet-perception:snapshot", handler);
      ipcRenderer.send("pet-perception:snapshot-subscribe");
      return () => ipcRenderer.removeListener("pet-perception:snapshot", handler);
    },
  },
  agentTasks: {
    getStatus: () => ipcRenderer.invoke("agent-tasks:status") as Promise<AgentTaskSnapshot>,
    subscribe: (listener: (snapshot: AgentTaskSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentTaskSnapshot) => listener(payload);
      ipcRenderer.on("agent-tasks:snapshot", handler);
      ipcRenderer.send("agent-tasks:subscribe");
      return () => ipcRenderer.removeListener("agent-tasks:snapshot", handler);
    },
  },
  agentEvents: {
    subscribe: (listener: (event: AgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
      ipcRenderer.on("agent-events:event", handler);
      return () => ipcRenderer.removeListener("agent-events:event", handler);
    },
  },
  agentEndpoints: {
    getStatus: () => ipcRenderer.invoke("agent-endpoints:status") as Promise<AgentEndpointSnapshot>,
    subscribe: (listener: (snapshot: AgentEndpointSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEndpointSnapshot) => listener(payload);
      ipcRenderer.on("agent-endpoints:snapshot", handler);
      ipcRenderer.send("agent-endpoints:subscribe");
      return () => ipcRenderer.removeListener("agent-endpoints:snapshot", handler);
    },
  },
  ccSwitch: {
    status: () => ipcRenderer.invoke("ccswitch:status") as Promise<CcSwitchStatus>,
    syncProfiles: (sourceIds?: string[]) => ipcRenderer.invoke("ccswitch:sync", sourceIds) as Promise<CcSwitchImportResult>,
  },
  zeroToken: {
    check: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:check", config) as Promise<ZeroTokenProviderStatus>,
    runtime: () => ipcRenderer.invoke("zero-token:runtime") as Promise<ZeroTokenProviderStatus>,
    status: (providerId?: string) => ipcRenderer.invoke("zero-token:status", providerId ?? "") as Promise<ZeroTokenProviderStatus>,
    start: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:start", config) as Promise<ZeroTokenProviderStatus>,
    stop: () => ipcRenderer.invoke("zero-token:stop") as Promise<ZeroTokenProviderStatus>,
    restart: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:restart", config) as Promise<ZeroTokenProviderStatus>,
    healthCheck: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:health", config) as Promise<RuntimeProvider>,
    checkLogin: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:check-login", config) as Promise<RuntimeProvider>,
    login: (config: PetSettings["zeroToken"], providerId?: string) => ipcRenderer.invoke("zero-token:login-runtime", config, providerId ?? "") as Promise<ZeroTokenProviderStatus>,
    logout: (config: PetSettings["zeroToken"], providerId?: string) => ipcRenderer.invoke("zero-token:logout-runtime", config, providerId ?? "") as Promise<ZeroTokenProviderStatus>,
    logs: () => ipcRenderer.invoke("zero-token:logs") as Promise<RuntimeLogEntry[]>,
    refreshModels: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:refresh-models", config) as Promise<ZeroTokenProviderStatus>,
    providers: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:providers", config) as Promise<WebModelProvider[]>,
    models: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:models", config) as Promise<WebModelModel[]>,
    loginProvider: (config: PetSettings["zeroToken"], providerId: string) => ipcRenderer.invoke("zero-token:login", config, providerId) as Promise<ZeroTokenProviderStatus>,
    logoutProvider: (config: PetSettings["zeroToken"], providerId: string) => ipcRenderer.invoke("zero-token:logout", config, providerId) as Promise<ZeroTokenProviderStatus>,
    openDashboard: (config: PetSettings["zeroToken"]) => ipcRenderer.invoke("zero-token:open-dashboard", config),
    openLoginWindow: (config: PetSettings["zeroToken"], providerId?: string) => ipcRenderer.invoke("zero-token:open-login-window", config, providerId ?? "") as Promise<ZeroTokenProviderStatus>,
    subscribe: (listener: (status: ZeroTokenProviderStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: ZeroTokenProviderStatus) => listener(status);
      ipcRenderer.on("zero-token:runtime", handler);
      return () => ipcRenderer.removeListener("zero-token:runtime", handler);
    },
  },
  updates: {
    check: () => ipcRenderer.invoke("updates:check") as Promise<UpdateCheckResult>,
    openDownload: (url: string) => ipcRenderer.invoke("updates:open-download", url) as Promise<{ ok: boolean; detail: string }>,
  },
  links: {
    /** 在系统浏览器中打开钉钉官方接入文档/后台链接（仅限 allowlist 主机） */
    openExternal: (url: string) => ipcRenderer.invoke("links:open-external", url) as Promise<{ ok: boolean; detail: string }>,
  },
  memory: {
    summary: () => ipcRenderer.invoke("memory:summary") as Promise<MemorySummary>,
    list: (status?: MemoryEntryStatus) => ipcRenderer.invoke("memory:list", status) as Promise<MemoryEntry[]>,
    search: (query: string) => ipcRenderer.invoke("memory:search", query) as Promise<Array<{ entry: MemoryEntry; score: number }>>,
    approve: (id: string) => ipcRenderer.invoke("memory:approve", id) as Promise<{ ok: boolean; detail: string }>,
    reject: (id: string) => ipcRenderer.invoke("memory:reject", id) as Promise<{ ok: boolean; detail: string }>,
    remove: (id: string) => ipcRenderer.invoke("memory:remove", id) as Promise<{ ok: boolean; detail: string }>,
    clear: () => ipcRenderer.invoke("memory:clear") as Promise<{ ok: boolean; detail: string }>,
    rebuildRecent: () => ipcRenderer.invoke("memory:rebuild-recent") as Promise<MemoryRebuildResult>,
    subscribe: (listener: (summary: MemorySummary) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, summary: MemorySummary) => listener(summary);
      ipcRenderer.on("memory:summary", handler);
      ipcRenderer.send("memory:subscribe");
      return () => ipcRenderer.removeListener("memory:summary", handler);
    },
  },
  // ─── 微信接入（PENGUIN_WECHAT_ENABLED=1 时可用） ───
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<PetSettings>,
    update: (update: PetSettingsUpdate) => ipcRenderer.invoke("settings:update", update) as Promise<PetSettings>,
    dataSummary: () => ipcRenderer.invoke("settings:data-summary") as Promise<LocalDataSummary>,
    deleteManagedData: () => ipcRenderer.invoke("settings:delete-managed-data") as Promise<LocalDataActionResult>,
    clearChatHistory: () => ipcRenderer.invoke("settings:clear-chat-history") as Promise<LocalDataActionResult>,
    exportDataSummary: () => ipcRenderer.invoke("settings:export-data-summary") as Promise<LocalDataActionResult>,
    close: () => ipcRenderer.invoke("settings:close") as Promise<void>,
    onCloseRequest: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("settings:close-request", handler);
      return () => ipcRenderer.removeListener("settings:close-request", handler);
    },
    beginDrag: () => ipcRenderer.send("settings:drag-start"),
    move: () => ipcRenderer.send("settings:drag"),
    endDrag: () => ipcRenderer.send("settings:drag-end"),
    subscribe: (listener: (settings: PetSettings) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: PetSettings) => listener(settings);
      ipcRenderer.on("settings:changed", handler);
      ipcRenderer.send("settings:subscribe");
      return () => {
        ipcRenderer.removeListener("settings:changed", handler);
      };
    },
  },
  screenCapture: {
    listDisplays: () => ipcRenderer.invoke("screen-capture:displays") as Promise<DesktopCaptureDisplay[]>,
    getStatus: (agentId?: string) => ipcRenderer.invoke("screen-capture:status", agentId ?? "") as Promise<AgentWindowFollowStatus>,
    onStatusChanged: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("screen-capture:status-changed", handler);
      return () => ipcRenderer.removeListener("screen-capture:status-changed", handler);
    },
  },
  petStyles: {
    list: () => ipcRenderer.invoke("pet-styles:list") as Promise<PetStyle[]>,
    assets: (styleId: string) => ipcRenderer.invoke("pet-styles:assets", styleId) as Promise<PetStyleAssetUrls>,
    importFolder: () => ipcRenderer.invoke("pet-styles:import-folder") as Promise<PetStyleActionResult>,
    importState: (styleId: string, state: string) => ipcRenderer.invoke("pet-styles:import-state", styleId, state) as Promise<PetStyleActionResult>,
    addCustomState: (styleId: string, name: string) => ipcRenderer.invoke("pet-styles:add-custom-state", styleId, name) as Promise<PetStyleActionResult>,
    rename: (styleId: string, name: string) => ipcRenderer.invoke("pet-styles:rename", styleId, name) as Promise<PetStyleActionResult>,
    removeCustomState: (styleId: string, stateId: string) => ipcRenderer.invoke("pet-styles:remove-custom-state", styleId, stateId) as Promise<PetStyleActionResult>,
    remove: (styleId: string) => ipcRenderer.invoke("pet-styles:remove", styleId) as Promise<PetStyleActionResult>,
  },
  channels: {
    list: () => ipcRenderer.invoke("channels:list") as Promise<ChannelStatus[]>,
    reconnect: (channelId: string) =>
      ipcRenderer.invoke("channels:reconnect", channelId) as Promise<{ ok: boolean; detail: string }>,
    subscribe: (listener: (event: BotChannelEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BotChannelEvent) => listener(payload);
      ipcRenderer.on("channels:event", handler);
      ipcRenderer.send("channels:subscribe");
      return () => {
        ipcRenderer.removeListener("channels:event", handler);
      };
    },
  },
  qq: {
    configure: (input: {
      id?: string;
      displayName: string;
      appId: string;
      clientSecret?: string;
    }) => ipcRenderer.invoke("qq:configure", input) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
    remove: (accountId: string) => ipcRenderer.invoke("qq:remove", accountId) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
    getQrLoginStatus: () => ipcRenderer.invoke("qq:qr-login:status") as Promise<QQQrLoginEvent | null>,
    startQrLogin: (displayName?: string) =>
      ipcRenderer.invoke("qq:qr-login:start", displayName ?? "") as Promise<{ ok: boolean; detail: string }>,
    cancelQrLogin: () =>
      ipcRenderer.invoke("qq:qr-login:cancel") as Promise<{ ok: boolean; detail: string }>,
    subscribeQrLogin: (listener: (event: QQQrLoginEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: QQQrLoginEvent) => listener(payload);
      ipcRenderer.on("qq:qr-login:event", handler);
      ipcRenderer.send("qq:qr-login:subscribe");
      return () => {
        ipcRenderer.removeListener("qq:qr-login:event", handler);
      };
    },
  },
  feishu: {
    configure: (input: {
      id?: string;
      displayName: string;
      appId: string;
      appSecret?: string;
    }) => ipcRenderer.invoke("feishu:configure", input) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
    remove: (accountId: string) => ipcRenderer.invoke("feishu:remove", accountId) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
    getQrLoginStatus: () => ipcRenderer.invoke("feishu:qr-login:status") as Promise<FeishuQrLoginEvent | null>,
    startQrLogin: (displayName?: string) =>
      ipcRenderer.invoke("feishu:qr-login:start", displayName ?? "") as Promise<{ ok: boolean; detail: string }>,
    cancelQrLogin: () =>
      ipcRenderer.invoke("feishu:qr-login:cancel") as Promise<{ ok: boolean; detail: string }>,
    subscribeQrLogin: (listener: (event: FeishuQrLoginEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: FeishuQrLoginEvent) => listener(payload);
      ipcRenderer.on("feishu:qr-login:event", handler);
      ipcRenderer.send("feishu:qr-login:subscribe");
      return () => {
        ipcRenderer.removeListener("feishu:qr-login:event", handler);
      };
    },
  },
  dingtalk: {
    configure: (input: {
      id?: string;
      displayName: string;
      clientId: string;
      clientSecret?: string;
    }) => ipcRenderer.invoke("dingtalk:configure", input) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
    remove: (accountId: string) => ipcRenderer.invoke("dingtalk:remove", accountId) as Promise<{
      ok: boolean;
      detail: string;
      settings?: PetSettings;
    }>,
  },
  wechat: {
    /** 订阅微信事件流（connection / message / reply / error），返回取消函数 */
    subscribe: (listener: (event: WeChatEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: WeChatEvent) => listener(payload);
      ipcRenderer.on("wechat:event", handler);
      ipcRenderer.send("wechat:subscribe");
      return () => {
        ipcRenderer.removeListener("wechat:event", handler);
      };
    },
    /** 手动向最近发消息的会话发送文本 */
    sendReply: (text: string) => ipcRenderer.invoke("wechat:send", text) as Promise<boolean>,
    /** 查询桥接状态 */
    getStatus: () =>
      ipcRenderer.invoke("wechat:status") as Promise<WeChatStatus>,
    reconnect: () =>
      ipcRenderer.invoke("wechat:reconnect") as Promise<{ ok: boolean; detail: string }>,
    getQrLoginStatus: () =>
      ipcRenderer.invoke("wechat:qr-login:status") as Promise<Extract<WeChatEvent, { type: "qr-login" }> | null>,
    startQrLogin: () =>
      ipcRenderer.invoke("wechat:qr-login:start") as Promise<{ ok: boolean; detail: string }>,
    cancelQrLogin: () =>
      ipcRenderer.invoke("wechat:qr-login:cancel") as Promise<{ ok: boolean; detail: string }>,
    importSession: () =>
      ipcRenderer.invoke("wechat:import-session") as Promise<{ ok: boolean; canceled?: boolean; detail: string }>,
    switchAccount: (accountId: string) =>
      ipcRenderer.invoke("wechat:switch-account", accountId) as Promise<{ ok: boolean; detail: string }>,
    logout: () =>
      ipcRenderer.invoke("wechat:logout") as Promise<{ ok: boolean; detail: string }>,
  },
});
