import type { AgentProvider } from "../settings/types";

export type AgentDiscoveryStatus = "available" | "not-installed" | "error" | "desktop-only";

export type AgentProtocol = "claude-cli" | "codex-cli" | "hermes-cli" | "custom";
export type AgentConfigSource = "builtin" | "manual" | "discovered" | "cc-switch";
export type AgentSourceApp = "claude-code" | "claude-desktop" | "codex" | "gemini" | "opencode" | "openclaw" | "hermes" | "unknown";
export type AgentSyncState = "synced" | "stale" | "conflict" | "unavailable";
export type AgentExecutionSupport = "supported" | "metadata-only" | "needs-login";
export type AgentModelOptionSource = "cc-switch-current" | "cc-switch-catalog" | "local-config" | "manual";
/** Model transport selected for an Agent; this is independent from Agent identity/provider. */
export type AgentModelProvider = "api" | "ccs" | "deepseek" | "zerotoken";

export interface AgentCapabilities {
  externalRuntime: boolean;
  configurableModelProvider: boolean;
  openAICompatible: boolean;
  supportsZeroToken: boolean;
}

export interface AgentModelOption {
  id: string;
  modelId: string;
  displayName: string;
  source: AgentModelOptionSource;
  isCurrentCcSwitch: boolean;
  selected: boolean;
  lastSeenAt: number;
}

export interface CcSwitchModelProfile {
  sourceId: string;
  displayName: string;
  modelId: string | null;
  role: "default" | "sonnet" | "opus" | "haiku" | "subagent" | "catalog" | "custom";
  isDefault: boolean;
  isFallback: boolean;
  iconKey: string | null;
}

export interface CcSwitchEndpointProfile {
  sourceId: string;
  host: string | null;
  isDefault: boolean;
  failoverPriority: number | null;
  health: "unknown" | "available" | "failed";
}

export interface CcSwitchApiProfile {
  sourceId: string;
  displayName: string;
  providerName: string | null;
  model: string | null;
  baseUrlHost: string | null;
  iconKey: string;
  iconColor: string | null;
  modelIconKey: string | null;
  models: CcSwitchModelProfile[];
  endpoints: CcSwitchEndpointProfile[];
  isCurrent: boolean;
  failoverPriority: number | null;
  syncState: AgentSyncState;
  executionSupport: AgentExecutionSupport;
  detail: string;
}

export type CcSwitchCurrentConfigState = "current" | "missing" | "stale" | "needs-login";

export interface CcSwitchCurrentConfig {
  agentSourceId: string;
  apiSourceId: string;
  app: AgentSourceApp;
  agentDisplayName: string;
  configDisplayName: string;
  providerName: string | null;
  model: string | null;
  baseUrlHost: string | null;
  iconKey: string;
  iconColor: string | null;
  modelIconKey: string | null;
  availableModels?: CcSwitchModelProfile[];
  state: CcSwitchCurrentConfigState;
  executionSupport: AgentExecutionSupport;
  lastSyncedAt: number;
  detail: string;
}

export interface AgentConfig {
  id: string;
  displayName: string;
  provider: AgentProvider;
  protocol: AgentProtocol;
  command: string;
  args: string;
  workingDirectory: string;
  enabled: boolean;
  /** Whether the user selected this local Agent for the top-level Agent cards. */
  agentCardVisible?: boolean;
  source?: AgentConfigSource;
  sourceId?: string;
  sourceApp?: AgentSourceApp;
  providerName?: string | null;
  model?: string | null;
  baseUrlHost?: string | null;
  iconKey?: string;
  iconColor?: string | null;
  modelIconKey?: string | null;
  modelOptions?: AgentModelOption[];
  selectedModelId?: string | null;
  modelProvider?: AgentModelProvider;
  syncState?: AgentSyncState;
  executionSupport?: AgentExecutionSupport;
  capabilities?: AgentCapabilities;
  ccSwitchCurrentConfig?: CcSwitchCurrentConfig;
  ccSwitchApiProfiles?: CcSwitchApiProfile[];
  selectedCcSwitchApiProfileId?: string | null;
}

export function normalizeAgentModelProvider(value: unknown): AgentModelProvider | undefined {
  return value === "api" || value === "ccs" || value === "deepseek" || value === "zerotoken" ? value : undefined;
}

/** Only Agents explicitly kept in the local Agent directory are selectable by bots. */
export function isAgentAdded(config: AgentConfig): boolean {
  return config.source !== "cc-switch" && config.agentCardVisible !== false;
}

export function defaultAgentCapabilities(provider: AgentProvider): AgentCapabilities {
  if (provider === "claude") {
    return {
      externalRuntime: false,
      configurableModelProvider: true,
      openAICompatible: true,
      supportsZeroToken: true,
    };
  }
  if (provider === "codex" || provider === "hermes") {
    return {
      externalRuntime: true,
      configurableModelProvider: false,
      openAICompatible: false,
      supportsZeroToken: false,
    };
  }
  return {
    externalRuntime: true,
    configurableModelProvider: false,
    openAICompatible: false,
    supportsZeroToken: false,
  };
}

export function normalizeAgentCapabilities(value: unknown, provider: AgentProvider): AgentCapabilities {
  const defaults = defaultAgentCapabilities(provider);
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  return {
    externalRuntime: typeof raw.externalRuntime === "boolean" ? raw.externalRuntime : defaults.externalRuntime,
    configurableModelProvider: typeof raw.configurableModelProvider === "boolean"
      ? raw.configurableModelProvider
      : defaults.configurableModelProvider,
    openAICompatible: typeof raw.openAICompatible === "boolean" ? raw.openAICompatible : defaults.openAICompatible,
    supportsZeroToken: typeof raw.supportsZeroToken === "boolean" ? raw.supportsZeroToken : defaults.supportsZeroToken,
  };
}

export function agentSupportsZeroToken(config: AgentConfig): boolean {
  return Boolean(config.capabilities?.supportsZeroToken
    && config.capabilities.configurableModelProvider
    && config.capabilities.openAICompatible
    && !config.capabilities.externalRuntime);
}

export interface AgentTestResult {
  ok: boolean;
  version: string | null;
  detail: string;
}

export type AgentHealthCheckErrorCode =
  | "ok"
  | "not-installed"
  | "authentication"
  | "rate-limited"
  | "timeout"
  | "empty-response"
  | "failed";

export type AgentHealthCheckMode = "no-tools" | "read-only" | "custom-command";

export const AGENT_CAPABILITY_IDS = [
  "agent.status",
  "thread.read",
  "file.read",
  "file.write",
  "shell.exec",
  "process.control",
  "screen.capture",
  "network.request",
  "external.send",
  "agent.dispatch",
] as const;

export type AgentCapability = typeof AGENT_CAPABILITY_IDS[number];
export type AgentCapabilityPermission = "allow" | "ask" | "deny";
export type AgentCapabilityPolicy = Record<AgentCapability, AgentCapabilityPermission>;
export type AgentApprovalMode = "read-only" | "risk-based" | "always";

export interface AgentControllerAgentStatus {
  id: string;
  displayName: string;
  provider: AgentProvider;
  state: "disabled" | "configured" | "available" | "unavailable";
  detail: string;
}

export interface AgentControllerStatus {
  mode: "read-only";
  primaryAgentId: string;
  primaryAgentName: string;
  primaryAgentState: AgentControllerAgentStatus["state"];
  /** 主 Agent 的逻辑身份提供方（claude/codex/hermes/custom），与真实运行通道分开。 */
  primaryAgentProvider: AgentProvider;
  /** 主 Agent 运行通道的事实标签（如 Codex：app-server 优先 / CLI 兜底），只读预构文案，不含路径/凭据。 */
  primaryAgentRuntime: string;
  approvalMode: AgentApprovalMode;
  capabilityPolicy: AgentCapabilityPolicy;
  agents: AgentControllerAgentStatus[];
  threadSupport: Array<{
    agentId: string;
    state: "not-probed" | "available" | "unavailable";
    detail: string;
  }>;
  detail: string;
  updatedAt: number;
}

export const AGENT_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  "agent.status": "查看 Agent 状态",
  "thread.read": "读取线程摘要",
  "file.read": "读取文件与目录",
  "file.write": "修改工作区文件",
  "shell.exec": "执行命令",
  "process.control": "查看或控制进程",
  "screen.capture": "截取桌面",
  "network.request": "访问网络",
  "external.send": "对外发送消息",
  "agent.dispatch": "调度其他 Agent",
};

export function defaultAgentCapabilityPolicy(): AgentCapabilityPolicy {
  return {
    "agent.status": "allow",
    "thread.read": "allow",
    "file.read": "ask",
    "file.write": "deny",
    "shell.exec": "deny",
    "process.control": "deny",
    "screen.capture": "deny",
    "network.request": "deny",
    "external.send": "deny",
    "agent.dispatch": "deny",
  };
}

export function fullAgentCapabilityPolicy(): AgentCapabilityPolicy {
  const policy = {} as AgentCapabilityPolicy;
  for (const capability of AGENT_CAPABILITY_IDS) {
    policy[capability] = "allow";
  }
  return policy;
}

export function normalizeAgentCapabilityPolicy(value: unknown): AgentCapabilityPolicy {
  const normalized = defaultAgentCapabilityPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;

  const raw = value as Record<string, unknown>;
  for (const capability of AGENT_CAPABILITY_IDS) {
    const permission = raw[capability];
    if (permission === "allow" || permission === "ask" || permission === "deny") {
      normalized[capability] = permission;
    }
  }
  return normalized;
}

export function normalizeAgentApprovalMode(value: unknown): AgentApprovalMode {
  if (value === "read-only" || value === "risk-based" || value === "always") return value;
  return "risk-based";
}

export function normalizeAgentFallbackIds(value: unknown, configs: AgentConfig[], primaryId: string): string[] {
  if (!Array.isArray(value)) return [];
  const validIds = new Set(configs.filter((config) => config.enabled && config.agentCardVisible !== false && config.id !== primaryId).map((config) => config.id));
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !validIds.has(item) || result.includes(item)) continue;
    result.push(item);
    if (result.length >= 3) break;
  }
  return result;
}

export interface AgentHealthCheckResult {
  ok: boolean;
  errorCode: AgentHealthCheckErrorCode;
  mode: AgentHealthCheckMode;
  durationMs: number;
  responsePreview: string | null;
  detail: string;
}

export const BUILTIN_AGENT_CONFIGS: readonly AgentConfig[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    provider: "claude",
    protocol: "claude-cli",
    command: "claude",
    args: "",
    workingDirectory: "",
    enabled: true,
    agentCardVisible: true,
    source: "builtin",
    sourceApp: "claude-code",
    providerName: "Claude Code",
    model: null,
    baseUrlHost: null,
    iconKey: "claude",
    iconColor: null,
    modelIconKey: null,
    capabilities: defaultAgentCapabilities("claude"),
    syncState: "synced",
    executionSupport: "supported",
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    provider: "codex",
    protocol: "codex-cli",
    command: "codex",
    args: "",
    workingDirectory: "",
    enabled: true,
    agentCardVisible: true,
    source: "builtin",
    sourceApp: "codex",
    providerName: "Codex",
    model: null,
    baseUrlHost: null,
    iconKey: "codex",
    iconColor: null,
    modelIconKey: null,
    capabilities: defaultAgentCapabilities("codex"),
    syncState: "synced",
    executionSupport: "supported",
  },
  {
    id: "hermes",
    displayName: "Hermes Agent",
    provider: "hermes",
    protocol: "hermes-cli",
    command: "hermes",
    args: "",
    workingDirectory: "",
    enabled: true,
    agentCardVisible: true,
    source: "builtin",
    sourceApp: "hermes",
    providerName: "Hermes",
    model: null,
    baseUrlHost: null,
    iconKey: "hermes",
    iconColor: null,
    modelIconKey: null,
    capabilities: defaultAgentCapabilities("hermes"),
    syncState: "synced",
    executionSupport: "supported",
  },
];

export function defaultAgentConfigs(): AgentConfig[] {
  return BUILTIN_AGENT_CONFIGS.map((config) => ({ ...config }));
}

function normalizeCcSwitchModelProfiles(value: unknown): CcSwitchModelProfile[] {
  if (!Array.isArray(value)) return [];
  const result: CcSwitchModelProfile[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const sourceId = typeof raw.sourceId === "string" && raw.sourceId.trim()
      ? raw.sourceId.trim().slice(0, 180)
      : `model-${index + 1}`;
    if (seen.has(sourceId)) continue;
    const role = raw.role === "default" || raw.role === "sonnet" || raw.role === "opus"
      || raw.role === "haiku" || raw.role === "subagent" || raw.role === "catalog" || raw.role === "custom"
      ? raw.role
      : "custom";
    const modelId = typeof raw.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim().slice(0, 180) : null;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim().slice(0, 120)
      : modelId ?? "模型待同步";
    seen.add(sourceId);
    result.push({
      sourceId,
      displayName,
      modelId,
      role,
      isDefault: raw.isDefault === true,
      isFallback: raw.isFallback === true,
      iconKey: typeof raw.iconKey === "string" && raw.iconKey.trim() ? raw.iconKey.trim().slice(0, 40) : null,
    });
  }
  return result.slice(0, 64);
}

function normalizeCcSwitchEndpointProfiles(value: unknown): CcSwitchEndpointProfile[] {
  if (!Array.isArray(value)) return [];
  const result: CcSwitchEndpointProfile[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const sourceId = typeof raw.sourceId === "string" && raw.sourceId.trim()
      ? raw.sourceId.trim().slice(0, 180)
      : `endpoint-${index + 1}`;
    if (seen.has(sourceId)) continue;
    const health = raw.health === "available" || raw.health === "failed" ? raw.health : "unknown";
    seen.add(sourceId);
    result.push({
      sourceId,
      host: typeof raw.host === "string" && raw.host.trim() ? raw.host.trim().slice(0, 120) : null,
      isDefault: raw.isDefault === true,
      failoverPriority: typeof raw.failoverPriority === "number" && Number.isFinite(raw.failoverPriority)
        ? Math.max(0, Math.min(99, Math.round(raw.failoverPriority)))
        : null,
      health,
    });
  }
  return result.slice(0, 32);
}

function normalizeCcSwitchApiProfiles(value: unknown): CcSwitchApiProfile[] {
  if (!Array.isArray(value)) return [];
  const result: CcSwitchApiProfile[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const sourceId = typeof raw.sourceId === "string" && raw.sourceId.trim()
      ? raw.sourceId.trim().slice(0, 180)
      : `api-${index + 1}`;
    if (seen.has(sourceId)) continue;
    const syncState = raw.syncState === "synced" || raw.syncState === "stale" || raw.syncState === "conflict" || raw.syncState === "unavailable"
      ? raw.syncState
      : "synced";
    const executionSupport = raw.executionSupport === "supported" || raw.executionSupport === "needs-login"
      ? raw.executionSupport
      : "metadata-only";
    seen.add(sourceId);
    result.push({
      sourceId,
      displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim().slice(0, 120) : "API 配置",
      providerName: typeof raw.providerName === "string" && raw.providerName.trim() ? raw.providerName.trim().slice(0, 120) : null,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim().slice(0, 160) : null,
      baseUrlHost: typeof raw.baseUrlHost === "string" && raw.baseUrlHost.trim() ? raw.baseUrlHost.trim().slice(0, 120) : null,
      iconKey: typeof raw.iconKey === "string" && raw.iconKey.trim() ? raw.iconKey.trim().slice(0, 40) : "custom",
      iconColor: typeof raw.iconColor === "string" && raw.iconColor.trim() ? raw.iconColor.trim().slice(0, 20) : null,
      modelIconKey: typeof raw.modelIconKey === "string" && raw.modelIconKey.trim() ? raw.modelIconKey.trim().slice(0, 40) : null,
      models: normalizeCcSwitchModelProfiles(raw.models),
      endpoints: normalizeCcSwitchEndpointProfiles(raw.endpoints),
      isCurrent: raw.isCurrent === true,
      failoverPriority: typeof raw.failoverPriority === "number" && Number.isFinite(raw.failoverPriority)
        ? Math.max(0, Math.min(99, Math.round(raw.failoverPriority)))
        : null,
      syncState,
      executionSupport,
      detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail.trim().slice(0, 240) : "已导入 API 配置摘要",
    });
  }
  return result.slice(0, 64);
}

function normalizeCcSwitchCurrentConfig(value: unknown): CcSwitchCurrentConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const app = normalizeSourceApp(raw.app) ?? "unknown";
  const executionSupport = raw.executionSupport === "supported" || raw.executionSupport === "needs-login"
    ? raw.executionSupport
    : "metadata-only";
  const state = raw.state === "current" || raw.state === "missing" || raw.state === "stale" || raw.state === "needs-login"
    ? raw.state
    : executionSupport === "needs-login" ? "needs-login" : "current";
  const agentSourceId = typeof raw.agentSourceId === "string" && raw.agentSourceId.trim()
    ? raw.agentSourceId.trim().slice(0, 180)
    : "cc-switch:agent:unknown";
  const apiSourceId = typeof raw.apiSourceId === "string" && raw.apiSourceId.trim()
    ? raw.apiSourceId.trim().slice(0, 180)
    : `${agentSourceId}:current`;
  const syncedAt = typeof raw.lastSyncedAt === "number" && Number.isFinite(raw.lastSyncedAt)
    ? Math.max(0, raw.lastSyncedAt)
    : 0;
  return {
    agentSourceId,
    apiSourceId,
    app,
    agentDisplayName: typeof raw.agentDisplayName === "string" && raw.agentDisplayName.trim() ? raw.agentDisplayName.trim().slice(0, 120) : "CC Switch Agent",
    configDisplayName: typeof raw.configDisplayName === "string" && raw.configDisplayName.trim() ? raw.configDisplayName.trim().slice(0, 120) : "当前配置",
    providerName: typeof raw.providerName === "string" && raw.providerName.trim() ? raw.providerName.trim().slice(0, 120) : null,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim().slice(0, 160) : null,
    baseUrlHost: typeof raw.baseUrlHost === "string" && raw.baseUrlHost.trim() ? raw.baseUrlHost.trim().slice(0, 120) : null,
    iconKey: typeof raw.iconKey === "string" && raw.iconKey.trim() ? raw.iconKey.trim().slice(0, 40) : "custom",
    iconColor: typeof raw.iconColor === "string" && raw.iconColor.trim() ? raw.iconColor.trim().slice(0, 20) : null,
    modelIconKey: typeof raw.modelIconKey === "string" && raw.modelIconKey.trim() ? raw.modelIconKey.trim().slice(0, 40) : null,
    availableModels: normalizeCcSwitchModelProfiles(raw.availableModels),
    state,
    executionSupport,
    lastSyncedAt: syncedAt,
    detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail.trim().slice(0, 240) : "只读引用 CC Switch 当前配置",
  };
}

function normalizeAgentModelOptionSource(value: unknown): AgentModelOptionSource {
  if (value === "cc-switch-current" || value === "cc-switch-catalog" || value === "local-config" || value === "manual") return value;
  return "local-config";
}

export function agentModelOptionId(agentId: string, modelId: string): string {
  return `${agentId}:model:${encodeURIComponent(modelId.trim().slice(0, 160))}`.slice(0, 240);
}

export function normalizeAgentModelOptions(value: unknown, agentId = "agent"): AgentModelOption[] {
  if (!Array.isArray(value)) return [];
  const result: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const modelId = typeof raw.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim().slice(0, 160) : "";
    if (!modelId || seen.has(modelId.toLowerCase())) continue;
    const id = typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 240)
      : agentModelOptionId(agentId, modelId) || `model-${index + 1}`;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim().slice(0, 120)
      : modelId;
    const lastSeenAt = typeof raw.lastSeenAt === "number" && Number.isFinite(raw.lastSeenAt)
      ? Math.max(0, Math.min(Date.now() + 60_000, Math.round(raw.lastSeenAt)))
      : 0;
    seen.add(modelId.toLowerCase());
    result.push({
      id,
      modelId,
      displayName,
      source: normalizeAgentModelOptionSource(raw.source),
      isCurrentCcSwitch: raw.isCurrentCcSwitch === true,
      selected: raw.selected === true,
      lastSeenAt,
    });
  }
  return result.slice(0, 64);
}

export function normalizeAgentConfigs(value: unknown): AgentConfig[] {
  if (!Array.isArray(value)) return defaultAgentConfigs();

  const configs: AgentConfig[] = [];
  const seenIds = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 80) : `custom-${index + 1}`;
    if (seenIds.has(id)) continue;

    const provider = normalizeProvider(raw.provider) ?? "custom";
    const protocol = provider === "custom" ? "custom" : normalizeProtocol(raw.protocol, provider);
    const source = raw.source === "cc-switch"
      ? "cc-switch"
      : raw.source === "builtin"
        ? "builtin"
        : raw.source === "discovered"
          ? "discovered"
          : "manual";
    const command = typeof raw.command === "string" ? raw.command.trim().slice(0, 240) : "";
    if (!command && source !== "cc-switch") continue;
    const sourceApp = normalizeSourceApp(raw.sourceApp);
    const executionSupport = sourceApp === "openclaw"
      ? "supported" as const
      : normalizeExecutionSupport(raw.executionSupport, source);

    seenIds.add(id);
    const normalizedApiProfiles = normalizeCcSwitchApiProfiles(raw.ccSwitchApiProfiles);
    const normalizedSelectedApiProfileId =
      typeof raw.selectedCcSwitchApiProfileId === "string" && raw.selectedCcSwitchApiProfileId.trim()
        ? raw.selectedCcSwitchApiProfileId.trim().slice(0, 180)
        : null;
    const normalizedModelOptions = normalizeAgentModelOptions(raw.modelOptions, id);
    const normalizedSelectedModelId =
      typeof raw.selectedModelId === "string" && raw.selectedModelId.trim()
        ? raw.selectedModelId.trim().slice(0, 160)
        : null;
    configs.push({
      id,
      displayName:
        typeof raw.displayName === "string" && raw.displayName.trim()
          ? raw.displayName.trim().slice(0, 80)
          : command,
      provider,
      protocol,
      command,
      args: typeof raw.args === "string" ? raw.args.trim().slice(0, 500) : "",
      workingDirectory:
        typeof raw.workingDirectory === "string" ? raw.workingDirectory.trim().slice(0, 500) : "",
      enabled: raw.enabled !== false,
      agentCardVisible: raw.agentCardVisible !== false,
      source,
      sourceId: typeof raw.sourceId === "string" ? raw.sourceId.trim().slice(0, 160) : undefined,
      sourceApp,
      providerName: typeof raw.providerName === "string" ? raw.providerName.trim().slice(0, 120) : null,
      model: typeof raw.model === "string" ? raw.model.trim().slice(0, 160) : null,
      baseUrlHost: typeof raw.baseUrlHost === "string" ? raw.baseUrlHost.trim().slice(0, 120) : null,
      iconKey: typeof raw.iconKey === "string" && raw.iconKey.trim() ? raw.iconKey.trim().slice(0, 40) : provider,
      iconColor: typeof raw.iconColor === "string" ? raw.iconColor.trim().slice(0, 20) : null,
      modelIconKey: typeof raw.modelIconKey === "string" ? raw.modelIconKey.trim().slice(0, 40) : null,
      modelOptions: normalizedModelOptions,
      selectedModelId: normalizedSelectedModelId,
      modelProvider: normalizeAgentModelProvider(raw.modelProvider),
      syncState: normalizeSyncState(raw.syncState),
      executionSupport,
      capabilities: normalizeAgentCapabilities(raw.capabilities, provider),
      ccSwitchCurrentConfig: normalizeCcSwitchCurrentConfig(raw.ccSwitchCurrentConfig),
      ...(source === "cc-switch" && raw.ccSwitchApiProfiles !== undefined ? { ccSwitchApiProfiles: normalizedApiProfiles } : {}),
      ...(source === "cc-switch" && raw.selectedCcSwitchApiProfileId !== undefined ? { selectedCcSwitchApiProfileId: normalizedSelectedApiProfileId } : {}),
    });
  }

  return configs.length > 0 ? configs : defaultAgentConfigs();
}

function ccSwitchAppLabel(app: AgentSourceApp | undefined): string {
  if (app === "claude-code") return "Claude Code";
  if (app === "claude-desktop") return "Claude Desktop";
  if (app === "codex") return "Codex";
  if (app === "gemini") return "Gemini";
  if (app === "opencode") return "OpenCode";
  if (app === "openclaw") return "OpenClaw";
  if (app === "hermes") return "Hermes";
  return "未知 Agent";
}

function legacyCcSwitchAgentId(config: AgentConfig): string | null {
  if (config.source !== "cc-switch" || !config.sourceId) return null;
  if (config.sourceId.startsWith("cc-switch:agent:")) return config.sourceId;
  const sourceApp = config.sourceApp;
  if (!sourceApp) return null;
  return `cc-switch:agent:${sourceApp}`;
}

function legacyCcSwitchApiProfile(config: AgentConfig): CcSwitchApiProfile {
  const sourceApp = config.sourceApp ?? "unknown";
  const providerSourceId = config.sourceId?.split(":").slice(2).join(":") || config.id;
  const sourceId = `cc-switch:api:${sourceApp}:${providerSourceId.slice(0, 100)}`;
  const models = config.model
    ? [{
      sourceId: `${sourceId}:model`,
      displayName: config.model,
      modelId: config.model,
      role: "default" as const,
      isDefault: true,
      isFallback: false,
      iconKey: config.modelIconKey ?? null,
    }]
    : [];
  const endpoints = config.baseUrlHost
    ? [{
      sourceId: `${sourceId}:endpoint`,
      host: config.baseUrlHost,
      isDefault: true,
      failoverPriority: null,
      health: "unknown" as const,
    }]
    : [];
  return {
    sourceId,
    displayName: config.displayName,
    providerName: config.providerName ?? null,
    model: config.model ?? null,
    baseUrlHost: config.baseUrlHost ?? null,
    iconKey: config.iconKey ?? config.provider,
    iconColor: config.iconColor ?? null,
    modelIconKey: config.modelIconKey ?? null,
    models,
    endpoints,
    isCurrent: config.executionSupport === "supported",
    failoverPriority: null,
    syncState: config.syncState ?? "synced",
    executionSupport: config.executionSupport ?? "metadata-only",
    detail: "由旧版扁平 CC Switch 导入记录迁移而来",
  };
}

function currentConfigFromLegacyApi(parentId: string, app: AgentSourceApp, api: CcSwitchApiProfile): CcSwitchCurrentConfig {
  const executionSupport = api.executionSupport;
  return {
    agentSourceId: parentId,
    apiSourceId: api.sourceId,
    app,
    agentDisplayName: ccSwitchAppLabel(app),
    configDisplayName: api.displayName,
    providerName: api.providerName,
    model: api.model,
    baseUrlHost: api.baseUrlHost,
    iconKey: api.iconKey,
    iconColor: api.iconColor,
    modelIconKey: api.modelIconKey,
    availableModels: api.models,
    state: executionSupport === "needs-login" ? "needs-login" : "current",
    executionSupport,
    lastSyncedAt: 0,
    detail: "由旧版 CC Switch 导入记录迁移为当前配置只读引用",
  };
}

function currentConfigFromLegacyAgent(parentId: string, config: AgentConfig): CcSwitchCurrentConfig {
  const api = legacyCcSwitchApiProfile(config);
  return currentConfigFromLegacyApi(parentId, config.sourceApp ?? "unknown", api);
}

export function migrateLegacyCcSwitchAgentConfigs(configs: AgentConfig[]): { configs: AgentConfig[]; changed: boolean } {
  const groups = new Map<string, AgentConfig[]>();
  for (const config of configs) {
    const parentId = legacyCcSwitchAgentId(config);
    if (!parentId) continue;
    const group = groups.get(parentId) ?? [];
    group.push(config);
    groups.set(parentId, group);
  }
  if (groups.size === 0) return { configs, changed: false };

  const migrated = configs.filter((config) => config.source !== "cc-switch").map((config) => ({ ...config }));
  let changed = migrated.length !== configs.length;

  for (const [parentId, group] of groups) {
    const existingParent = group.find((config) => config.sourceId === parentId);
    const legacyEntries = group.filter((config) => config !== existingParent);
    const first = existingParent ?? legacyEntries[0];
    if (!first) continue;

    const legacyApis = (existingParent?.ccSwitchApiProfiles ?? []).concat(
      legacyEntries.map(legacyCcSwitchApiProfile),
    );
    const selectedApi = legacyApis.find((api) => api.sourceId === existingParent?.selectedCcSwitchApiProfileId)
      ?? legacyApis.find((api) => api.isCurrent);
    const fallbackLegacyCurrent = legacyEntries.find((config) => config.executionSupport === "supported");
    const currentConfig = existingParent?.ccSwitchCurrentConfig
      ?? (selectedApi ? currentConfigFromLegacyApi(parentId, first.sourceApp ?? "unknown", selectedApi) : undefined)
      ?? (fallbackLegacyCurrent ? currentConfigFromLegacyAgent(parentId, fallbackLegacyCurrent) : undefined);
    const targetIndex = migrated.findIndex((config) =>
      Boolean(first.sourceApp) && config.sourceApp === first.sourceApp,
    );

    if (targetIndex < 0) {
      // CCS-only records are intentionally discarded. A real local Agent must
      // be detected and joined before it can become a Penguin card.
      continue;
    }

    const target = migrated[targetIndex];
    migrated[targetIndex] = {
      ...target,
      providerName: currentConfig?.providerName ?? target.providerName ?? null,
      model: currentConfig?.model ?? target.model ?? null,
      baseUrlHost: currentConfig?.baseUrlHost ?? target.baseUrlHost ?? null,
      iconKey: currentConfig?.iconKey ?? target.iconKey,
      iconColor: currentConfig?.iconColor ?? target.iconColor ?? null,
      modelIconKey: currentConfig?.modelIconKey ?? target.modelIconKey ?? null,
      syncState: currentConfig?.state === "current" ? "synced" : target.syncState,
      executionSupport: currentConfig?.executionSupport ?? target.executionSupport,
      ccSwitchCurrentConfig: currentConfig,
      ccSwitchApiProfiles: undefined,
      selectedCcSwitchApiProfileId: undefined,
    };
    changed = true;
  }

  return { configs: migrated.length > 0 ? migrated : defaultAgentConfigs(), changed };
}

function canonicalAgentKey(config: AgentConfig): string {
  if (config.source !== "manual" && config.sourceApp && config.sourceApp !== "unknown") {
    return `app:${config.sourceApp}`;
  }
  const id = config.id.toLowerCase().replace(/^local:/, "");
  if (["claude", "claude-code"].includes(id) || config.command.toLowerCase() === "claude") return "app:claude-code";
  if (["codex", "codex-cli"].includes(id) || config.command.toLowerCase() === "codex") return "app:codex";
  if (["hermes", "hermes-agent"].includes(id) || config.command.toLowerCase() === "hermes") return "app:hermes";
  if (config.source !== "manual" && config.command.trim()) return `command:${config.command.trim().toLowerCase()}`;
  return `id:${config.id}`;
}

function agentConfigPriority(config: AgentConfig): number {
  if (config.source === "builtin") return 40;
  if (config.source === "discovered") return 30;
  if (config.source === "manual") return 20;
  return 10;
}

function mergeAgentModelOptions(configId: string, configs: AgentConfig[], winner: AgentConfig): {
  modelOptions: AgentModelOption[];
  selectedModelId: string | null;
} {
  const merged = new Map<string, AgentModelOption>();
  const add = (modelId: string | null | undefined, displayName: string | null | undefined, source: AgentModelOptionSource, isCurrentCcSwitch: boolean, lastSeenAt: number): void => {
    const normalizedId = modelId?.trim().slice(0, 160) ?? "";
    if (!normalizedId) return;
    const key = normalizedId.toLowerCase();
    const candidate: AgentModelOption = {
      id: agentModelOptionId(configId, normalizedId),
      modelId: normalizedId,
      displayName: (displayName?.trim() || normalizedId).slice(0, 120),
      source,
      isCurrentCcSwitch,
      selected: false,
      lastSeenAt: Math.max(0, lastSeenAt || 0),
    };
    const existing = merged.get(key);
    const existingRank = existing ? (existing.isCurrentCcSwitch ? 5 : existing.source === "manual" ? 4 : existing.source === "local-config" ? 3 : 2) : -1;
    const candidateRank = isCurrentCcSwitch ? 5 : source === "manual" ? 4 : source === "local-config" ? 3 : 2;
    if (!existing || candidateRank >= existingRank) merged.set(key, candidate);
  };

  for (const config of configs) {
    for (const option of config.modelOptions ?? []) {
      add(option.modelId, option.displayName, option.source, option.isCurrentCcSwitch, option.lastSeenAt);
    }
    add(config.model, config.model, "local-config", false, 0);
    const current = config.ccSwitchCurrentConfig;
    if (current) {
      for (const model of current.availableModels ?? []) {
        add(model.modelId, model.displayName, "cc-switch-catalog", false, current.lastSyncedAt);
      }
      add(current.model, current.model, "cc-switch-current", true, current.lastSyncedAt);
    }
  }

  const selectedCandidate = configs.map((config) => config.selectedModelId).find((value) => {
    const modelId = value?.trim().toLowerCase();
    return Boolean(modelId && merged.has(modelId));
  })?.trim()
    ?? winner.ccSwitchCurrentConfig?.model?.trim()
    ?? winner.model?.trim()
    ?? merged.values().next().value?.modelId
    ?? null;
  const modelOptions = Array.from(merged.values()).map((option) => ({
    ...option,
    selected: Boolean(selectedCandidate && option.modelId.toLowerCase() === selectedCandidate.toLowerCase()),
  }));
  return { modelOptions, selectedModelId: selectedCandidate };
}

/**
 * Keeps the persisted Agent list at one card per local executable Agent.
 * CC Switch contributes current/model metadata only; CCS-only records are not cards.
 */
export function canonicalizeAgentConfigs(configs: AgentConfig[]): { configs: AgentConfig[]; changed: boolean } {
  const groups = new Map<string, AgentConfig[]>();
  for (const config of configs) {
    const key = canonicalAgentKey(config);
    const group = groups.get(key) ?? [];
    group.push(config);
    groups.set(key, group);
  }

  const canonical: AgentConfig[] = [];
  let changed = false;
  for (const group of groups.values()) {
    const localConfigs = group.filter((config) => config.source !== "cc-switch");
    if (localConfigs.length === 0) {
      changed = true;
      continue;
    }
    const winner = [...localConfigs].sort((left, right) => agentConfigPriority(right) - agentConfigPriority(left))[0];
    const currentConfig = group.find((config) => config.ccSwitchCurrentConfig)?.ccSwitchCurrentConfig
      ?? localConfigs.find((config) => config.ccSwitchCurrentConfig)?.ccSwitchCurrentConfig;
    const modelData = mergeAgentModelOptions(winner.id, group, winner);
    const mergedConfig: AgentConfig = {
      ...winner,
      providerName: currentConfig?.providerName ?? winner.providerName ?? null,
      model: currentConfig?.model ?? winner.model ?? null,
      baseUrlHost: currentConfig?.baseUrlHost ?? winner.baseUrlHost ?? null,
      iconKey: currentConfig?.iconKey ?? winner.iconKey,
      iconColor: currentConfig?.iconColor ?? winner.iconColor ?? null,
      modelIconKey: currentConfig?.modelIconKey ?? winner.modelIconKey ?? null,
      syncState: currentConfig?.state === "current" ? "synced" : winner.syncState,
      executionSupport: currentConfig?.executionSupport ?? winner.executionSupport,
      ccSwitchCurrentConfig: currentConfig,
      modelOptions: modelData.modelOptions,
      selectedModelId: modelData.selectedModelId,
      ccSwitchApiProfiles: undefined,
      selectedCcSwitchApiProfileId: undefined,
    };
    canonical.push(mergedConfig);
    if (group.length !== 1 || JSON.stringify(group[0]) !== JSON.stringify(mergedConfig)) changed = true;
  }

  const result = canonical.length > 0 ? canonical : defaultAgentConfigs();
  changed ||= result.length !== configs.length;
  return { configs: result, changed };
}

function normalizeSourceApp(value: unknown): AgentSourceApp | undefined {
  if (value === "claude-code" || value === "claude-desktop" || value === "codex" || value === "gemini" || value === "opencode" || value === "openclaw" || value === "hermes" || value === "unknown") return value;
  return undefined;
}

function normalizeSyncState(value: unknown): AgentSyncState | undefined {
  if (value === "synced" || value === "stale" || value === "conflict" || value === "unavailable") return value;
  return undefined;
}

function normalizeExecutionSupport(value: unknown, source: AgentConfigSource): AgentExecutionSupport | undefined {
  if (value === "supported" || value === "metadata-only" || value === "needs-login") return value;
  return source === "cc-switch" ? "metadata-only" : "supported";
}

function normalizeProvider(value: unknown): AgentProvider | null {
  if (value === "claude" || value === "codex" || value === "hermes" || value === "custom") return value;
  return null;
}

function normalizeProtocol(value: unknown, provider: AgentProvider): AgentProtocol {
  if (value === "claude-cli" || value === "codex-cli" || value === "hermes-cli" || value === "custom") return value;
  if (provider === "claude") return "claude-cli";
  if (provider === "codex") return "codex-cli";
  if (provider === "hermes") return "hermes-cli";
  return "custom";
}

export function resolveActiveAgentId(value: unknown, configs: AgentConfig[], provider: AgentProvider): string {
  const requestedId = typeof value === "string" ? value.trim() : "";
  if (requestedId) {
    const requested = configs.find((config) => config.id === requestedId && config.enabled && config.agentCardVisible !== false);
    if (requested) return requested.id;
  }

  const matchingProvider = configs.find((config) => config.enabled && config.agentCardVisible !== false && config.provider === provider);
  if (matchingProvider) return matchingProvider.id;

  return configs.find((config) => config.enabled && config.agentCardVisible !== false)?.id
    ?? configs.find((config) => config.enabled)?.id
    ?? configs[0]?.id
    ?? "claude";
}

export interface LocalAgentInfo {
  id: string;
  name: string;
  command: string | null;
  sourceApp?: AgentSourceApp;
  version: string | null;
  status: AgentDiscoveryStatus;
  detail: string;
  provider: AgentProvider | null;
  supported: boolean;
  installSupport?: "official-guide" | "package-manager" | "unsupported";
}
