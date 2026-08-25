import type { LocalDataActionResult, LocalDataSummary, PetSettings, PetSettingsUpdate, PetStyle, PetStyleActionResult, PetStyleAssetUrls, ZeroTokenSettings } from "../settings/types";
import type { AgentConfig, AgentControllerStatus, AgentHealthCheckResult, AgentModelOption, AgentTestResult, LocalAgentInfo } from "../agents/types";
import type { AgentEndpointSnapshot } from "../main/agents/AgentEndpointRegistry";
import type { BotChannelEvent, ChannelStatus } from "../main/channels/types";
import type { QQQrLoginEvent } from "../main/channels/qqQrLogin";
import type { FeishuQrLoginEvent } from "../main/channels/feishuQrLogin";
import type { AgentStatus, WeChatEvent, WeChatQrLoginStatus, WeChatStatus } from "../main/wechat/events";
import type { CcSwitchImportResult, CcSwitchStatus, UpdateCheckResult } from "../main/systemTypes";
import type { AgentTaskActivity, AgentTaskCompletion, AgentTaskSnapshot, PetPerceptionEvent, PetPerceptionRun, PetPerceptionSnapshot } from "../main/pet/perceptionTypes";
import type { MemoryEntry, MemoryEntryStatus } from "../main/agents/orchestrationTypes";
import type { MemorySummary } from "../main/memory/MemoryStore";
import type { MemoryRebuildResult } from "../main/memory/memoryTypes";
import type { DesktopCaptureDisplay } from "../main/media/DesktopCaptureService";
import type { AgentWindowFollowStatus } from "../main/media/AgentWindowTracker";
import type { AgentEvent } from "../main/events/EventTypes";
import type { ZeroTokenProviderStatus } from "../main/agents/ZeroTokenProvider";
import type { WebModelProvider, WebModelModel } from "../main/agents/WebModelRuntimeTypes";
import type { RuntimeLogEntry, RuntimeProvider } from "../main/runtime/types";

export type { AgentWindowFollowStatus } from "../main/media/AgentWindowTracker";

export type { AgentStatus, WeChatEvent, WeChatStatus } from "../main/wechat/events";
export type { BotChannelEvent, BotPlatform, ChannelStatus } from "../main/channels/types";
export type { AgentTaskActivity, AgentTaskCompletion, AgentTaskSnapshot, PetPerceptionEvent, PetPerceptionRun, PetPerceptionSnapshot } from "../main/pet/perceptionTypes";

export interface PenguinPetApi {
  hide: () => Promise<void>;
  close: () => Promise<void>;
  beginWindowDrag: () => void;
  endWindowDrag: () => void;
  moveWindow: () => void;
  onWindowEdge: (listener: (edge: { left: boolean; right: boolean; top: boolean }) => void) => () => void;
  setWindowShape: (rects: WindowShapeRect[]) => void;
  setTaskTrayExpanded: (expanded: boolean) => void;
  showContextMenu: () => void;
  setMousePassthrough: (ignore: boolean) => void;
  version: () => Promise<string>;
  agents: {
    discover: () => Promise<LocalAgentInfo[]>;
    models: (config: AgentConfig) => Promise<AgentModelOption[]>;
    test: (config: AgentConfig) => Promise<AgentTestResult>;
    healthCheck: (config: AgentConfig) => Promise<AgentHealthCheckResult>;
  };
  controller: {
    status: () => Promise<AgentControllerStatus>;
  };
  petPerception: {
    getStatus: () => Promise<PetPerceptionSnapshot | null>;
    trigger: (signal: string) => Promise<PetPerceptionRun>;
    subscribe: (listener: (event: PetPerceptionEvent) => void) => () => void;
    subscribeSnapshot: (listener: (snapshot: PetPerceptionSnapshot) => void) => () => void;
  };
  agentTasks: {
    getStatus: () => Promise<AgentTaskSnapshot>;
    subscribe: (listener: (snapshot: AgentTaskSnapshot) => void) => () => void;
  };
  agentEvents: {
    subscribe: (listener: (event: AgentEvent) => void) => () => void;
  };
  agentEndpoints: {
    getStatus: () => Promise<AgentEndpointSnapshot>;
    subscribe: (listener: (snapshot: AgentEndpointSnapshot) => void) => () => void;
  };
  ccSwitch: {
    status: () => Promise<CcSwitchStatus>;
    syncProfiles: (sourceIds?: string[]) => Promise<CcSwitchImportResult>;
  };
  zeroToken: {
    check: (config: ZeroTokenSettings) => Promise<ZeroTokenProviderStatus>;
    runtime: () => Promise<ZeroTokenProviderStatus>;
    status: (providerId?: string) => Promise<ZeroTokenProviderStatus>;
    start: (config: ZeroTokenSettings) => Promise<ZeroTokenProviderStatus>;
    stop: () => Promise<ZeroTokenProviderStatus>;
    restart: (config: ZeroTokenSettings) => Promise<ZeroTokenProviderStatus>;
    healthCheck: (config: ZeroTokenSettings) => Promise<RuntimeProvider>;
    checkLogin: (config: ZeroTokenSettings) => Promise<RuntimeProvider>;
    login: (config: ZeroTokenSettings, providerId?: string) => Promise<ZeroTokenProviderStatus>;
    logout: (config: ZeroTokenSettings, providerId?: string) => Promise<ZeroTokenProviderStatus>;
    logs: () => Promise<RuntimeLogEntry[]>;
    refreshModels: (config: ZeroTokenSettings) => Promise<ZeroTokenProviderStatus>;
    providers: (config: ZeroTokenSettings) => Promise<WebModelProvider[]>;
    models: (config: ZeroTokenSettings) => Promise<WebModelModel[]>;
    loginProvider: (config: ZeroTokenSettings, providerId: string) => Promise<ZeroTokenProviderStatus>;
    logoutProvider: (config: ZeroTokenSettings, providerId: string) => Promise<ZeroTokenProviderStatus>;
    openDashboard: (config: ZeroTokenSettings) => Promise<{ ok: boolean; detail: string }>;
    openLoginWindow: (config: ZeroTokenSettings, providerId?: string) => Promise<ZeroTokenProviderStatus>;
    subscribe: (listener: (status: ZeroTokenProviderStatus) => void) => () => void;
  };
  updates: {
    check: () => Promise<UpdateCheckResult>;
    openDownload: (url: string) => Promise<{ ok: boolean; detail: string }>;
  };
  links: {
    /** 在系统浏览器中打开钉钉官方接入文档/后台链接（仅限 allowlist 主机） */
    openExternal: (url: string) => Promise<{ ok: boolean; detail: string }>;
  };
  memory: {
    summary: () => Promise<MemorySummary>;
    list: (status?: MemoryEntryStatus) => Promise<MemoryEntry[]>;
    search: (query: string) => Promise<Array<{ entry: MemoryEntry; score: number }>>;
    approve: (id: string) => Promise<{ ok: boolean; detail: string }>;
    reject: (id: string) => Promise<{ ok: boolean; detail: string }>;
    remove: (id: string) => Promise<{ ok: boolean; detail: string }>;
    clear: () => Promise<{ ok: boolean; detail: string }>;
    rebuildRecent: () => Promise<MemoryRebuildResult>;
    subscribe: (listener: (summary: MemorySummary) => void) => () => void;
  };
  settings: {
    get: () => Promise<PetSettings>;
    update: (update: PetSettingsUpdate) => Promise<PetSettings>;
    dataSummary: () => Promise<LocalDataSummary>;
    deleteManagedData: () => Promise<LocalDataActionResult>;
    clearChatHistory: () => Promise<LocalDataActionResult>;
    exportDataSummary: () => Promise<LocalDataActionResult>;
    close: () => Promise<void>;
    onCloseRequest: (listener: () => void) => () => void;
    beginDrag: () => void;
    move: () => void;
    endDrag: () => void;
    subscribe: (listener: (settings: PetSettings) => void) => () => void;
  };
  screenCapture: {
    listDisplays: () => Promise<DesktopCaptureDisplay[]>;
    getStatus: (agentId?: string) => Promise<AgentWindowFollowStatus>;
    onStatusChanged: (listener: () => void) => () => void;
  };
  petStyles: {
    list: () => Promise<PetStyle[]>;
    assets: (styleId: string) => Promise<PetStyleAssetUrls>;
    importFolder: () => Promise<PetStyleActionResult>;
    importState: (styleId: string, state: string) => Promise<PetStyleActionResult>;
    addCustomState: (styleId: string, name: string) => Promise<PetStyleActionResult>;
    rename: (styleId: string, name: string) => Promise<PetStyleActionResult>;
    removeCustomState: (styleId: string, stateId: string) => Promise<PetStyleActionResult>;
    remove: (styleId: string) => Promise<PetStyleActionResult>;
  };
  channels: {
    list: () => Promise<ChannelStatus[]>;
    reconnect: (channelId: string) => Promise<{ ok: boolean; detail: string }>;
    subscribe: (listener: (event: BotChannelEvent) => void) => () => void;
  };
  qq: {
    configure: (input: {
      id?: string;
      displayName: string;
      appId: string;
      clientSecret?: string;
      agentId?: string;
    }) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
    remove: (accountId: string) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
    getQrLoginStatus: () => Promise<QQQrLoginEvent | null>;
    startQrLogin: (displayName?: string) => Promise<{ ok: boolean; detail: string }>;
    cancelQrLogin: () => Promise<{ ok: boolean; detail: string }>;
    subscribeQrLogin: (listener: (event: QQQrLoginEvent) => void) => () => void;
  };
  feishu: {
    configure: (input: {
      id?: string;
      displayName: string;
      appId: string;
      appSecret?: string;
      agentId?: string;
    }) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
    remove: (accountId: string) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
    getQrLoginStatus: () => Promise<FeishuQrLoginEvent | null>;
    startQrLogin: (displayName?: string) => Promise<{ ok: boolean; detail: string }>;
    cancelQrLogin: () => Promise<{ ok: boolean; detail: string }>;
    subscribeQrLogin: (listener: (event: FeishuQrLoginEvent) => void) => () => void;
  };
  dingtalk: {
    configure: (input: {
      id?: string;
      displayName: string;
      clientId: string;
      clientSecret?: string;
      agentId?: string;
    }) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
    remove: (accountId: string) => Promise<{ ok: boolean; detail: string; settings?: PetSettings }>;
  };
  wechat: {
    subscribe: (listener: (event: WeChatEvent) => void) => () => void;
    sendReply: (text: string) => Promise<boolean>;
    getStatus: () => Promise<WeChatStatus>;
    reconnect: () => Promise<{ ok: boolean; detail: string }>;
    getQrLoginStatus: () => Promise<Extract<WeChatEvent, { type: "qr-login" }> | null>;
    startQrLogin: () => Promise<{ ok: boolean; detail: string }>;
    cancelQrLogin: () => Promise<{ ok: boolean; detail: string }>;
    importSession: () => Promise<{ ok: boolean; canceled?: boolean; detail: string }>;
    switchAccount: (accountId: string) => Promise<{ ok: boolean; detail: string }>;
    logout: () => Promise<{ ok: boolean; detail: string }>;
  };
}

export interface WindowShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PetState =
  | "idle"
  | "walk"
  | "happy"
  | "shy"
  | "sleep"
  | "eat"
  | "angry";

declare global {
  interface Window {
    penguinPet: PenguinPetApi;
  }
}
