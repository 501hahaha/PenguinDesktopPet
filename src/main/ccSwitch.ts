import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CcSwitchApiProfile } from "../agents/types";
import type { CcSwitchAgentProfile, CcSwitchAppType, CcSwitchExecutionSupport, CcSwitchStatus, CcSwitchTargetStatus } from "./systemTypes";

type UnknownRecord = Record<string, unknown>;

export type CcSwitchApiStyle = "anthropic" | "openai-compatible";

export interface CcSwitchRuntimeConfig {
  app: CcSwitchAppType;
  configDisplayName: string;
  providerName: string | null;
  model: string | null;
  baseUrl: string;
  apiKey: string;
  apiStyle: CcSwitchApiStyle;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): UnknownRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fileChangedAt(filePath: string): number | null {
  try {
    const modifiedAt = statSync(filePath).mtimeMs;
    return Number.isFinite(modifiedAt) ? modifiedAt : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function safeUrlHost(value: unknown): string | null {
  const raw = safeUrl(value);
  if (!raw) return null;
  try {
    return new URL(raw).host.slice(0, 120);
  } catch {
    return null;
  }
}

function safeUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").slice(0, 512);
  } catch {
    return null;
  }
}

function safeColor(value: unknown): string | null {
  const color = stringValue(value);
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

function normalizeAppType(value: unknown): CcSwitchAppType {
  const raw = stringValue(value)?.toLowerCase().replace(/[_\s]+/g, "-") ?? "";
  if (raw === "claude-desktop" || raw.includes("claude-desktop")) return "claude-desktop";
  if (raw === "claude" || raw === "claude-code" || raw.includes("claude")) return "claude-code";
  if (raw === "codex") return "codex";
  if (raw === "gemini") return "gemini";
  if (raw === "opencode" || raw === "open-code") return "opencode";
  if (raw === "openclaw" || raw === "open-claw") return "openclaw";
  if (raw === "hermes") return "hermes";
  return "unknown";
}

function appLabel(app: CcSwitchAppType): string {
  if (app === "claude-code") return "Claude Code";
  if (app === "claude-desktop") return "Claude Desktop";
  if (app === "codex") return "Codex";
  if (app === "gemini") return "Gemini";
  if (app === "opencode") return "OpenCode";
  if (app === "openclaw") return "OpenClaw";
  if (app === "hermes") return "Hermes";
  return "未知 Agent";
}

function iconKey(value: unknown, app: CcSwitchAppType, label: string): string {
  const raw = stringValue(value)?.toLowerCase() ?? "";
  if (raw.includes("claude") || raw.includes("anthropic")) return "claude";
  if (raw.includes("codex") || raw.includes("openai")) return "codex";
  if (raw.includes("gemini") || raw.includes("google")) return "gemini";
  if (raw.includes("hermes")) return "hermes";
  if (raw.includes("opencode")) return "opencode";
  if (raw.includes("openclaw")) return "openclaw";
  if (app !== "unknown") return app;
  return label.trim().slice(0, 1).toLowerCase() || "custom";
}

function modelIconKey(model: string | null): string | null {
  const raw = model?.toLowerCase() ?? "";
  if (!raw) return null;
  if (raw.includes("claude") || raw.includes("sonnet") || raw.includes("opus") || raw.includes("haiku")) return "claude";
  if (raw.includes("gpt") || raw.includes("o1") || raw.includes("o3") || raw.includes("codex")) return "codex";
  if (raw.includes("gemini")) return "gemini";
  if (raw.includes("hermes")) return "hermes";
  return "model";
}

function extractSafeModel(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const visit = (candidate: unknown, depth: number): string | null => {
      if (depth > 3 || !isRecord(candidate)) return null;
      for (const key of ["model", "model_name", "modelName", "default_model", "defaultModel"]) {
        const found = stringValue(candidate[key]);
        if (found) return found;
      }
      for (const child of Object.values(candidate)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return visit(parsed, 0);
  } catch {
    return null;
  }
}

function extractSafeEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const visit = (candidate: unknown, depth: number): string | null => {
      if (depth > 3 || !isRecord(candidate)) return null;
      for (const key of ["base_url", "baseUrl", "endpoint", "api_base", "apiBase"]) {
        const found = safeUrlHost(candidate[key]);
        if (found) return found;
      }
      for (const child of Object.values(candidate)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return visit(parsed, 0);
  } catch {
    return null;
  }
}

type SafeModel = {
  sourceId: string;
  displayName: string;
  modelId: string | null;
  role: "default" | "sonnet" | "opus" | "haiku" | "subagent" | "catalog" | "custom";
  isDefault: boolean;
  isFallback: boolean;
  iconKey: string | null;
};

function modelRoleFromKey(value: string): SafeModel["role"] {
  const key = value.toLowerCase();
  if (key.includes("sonnet")) return "sonnet";
  if (key.includes("opus")) return "opus";
  if (key.includes("haiku")) return "haiku";
  if (key.includes("subagent") || key.includes("sub_agent")) return "subagent";
  if (key.includes("default")) return "default";
  return "custom";
}

function modelSourceId(value: string, index: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return `${normalized || "model"}-${index + 1}`;
}

function modelDisplayName(modelId: string | null, role: SafeModel["role"]): string {
  if (modelId) return modelId;
  if (role === "sonnet") return "Sonnet";
  if (role === "opus") return "Opus";
  if (role === "haiku") return "Haiku";
  if (role === "subagent") return "Subagent 模型";
  if (role === "default") return "默认模型";
  return "模型待同步";
}

function safeModelIcon(modelId: string | null): string | null {
  return modelIconKey(modelId);
}

function addSafeModel(result: SafeModel[], seen: Set<string>, rawValue: unknown, sourceKey: string, roleHint?: SafeModel["role"], isFallback = false): void {
  const modelId = stringValue(rawValue);
  if (!modelId || modelId.length > 180) return;
  const role = roleHint ?? modelRoleFromKey(sourceKey);
  const key = `${role}:${modelId.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  result.push({
    sourceId: modelSourceId(`${sourceKey}-${modelId}`, result.length),
    displayName: modelDisplayName(modelId, role),
    modelId,
    role,
    isDefault: role === "default" || result.length === 0,
    isFallback,
    iconKey: safeModelIcon(modelId),
  });
}

function collectSafeModels(value: unknown): SafeModel[] {
  const result: SafeModel[] = [];
  const seen = new Set<string>();
  const scalarKeys = new Set(["model", "model_name", "modelname", "default_model", "defaultmodel"]);
  const catalogKeys = new Set(["models", "modelcatalog", "model_catalog"]);
  const visit = (candidate: unknown, path: string[], depth: number): void => {
    if (depth > 5 || result.length >= 64) return;
    if (Array.isArray(candidate)) {
      for (const [index, item] of candidate.entries()) {
        if (typeof item === "string") {
          addSafeModel(result, seen, item, `${path.join(".")}-${index}`, "catalog");
        } else if (isRecord(item)) {
          const modelValue = item.model ?? item.modelId ?? item.model_id ?? item.id;
          const displayValue = item.name ?? modelValue;
          if (typeof modelValue === "string") {
            const modelId = stringValue(modelValue);
            const role = modelRoleFromKey(path.join("."));
            const key = `${role}:${modelId?.toLowerCase() ?? ""}`;
            if (modelId && !seen.has(key)) {
              seen.add(key);
              result.push({
                sourceId: modelSourceId(`${path.join(".")}-${modelId}`, result.length),
                displayName: stringValue(displayValue) ?? modelDisplayName(modelId, role),
                modelId,
                role,
                isDefault: role === "default" || result.length === 0,
                isFallback: false,
                iconKey: safeModelIcon(modelId),
              });
            }
          }
        }
      }
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      const nextPath = [...path, key];
      if (scalarKeys.has(normalizedKey) || normalizedKey.endsWith("_model")) {
        addSafeModel(result, seen, child, nextPath.join("."), modelRoleFromKey(key));
        continue;
      }
      if (normalizedKey === "env" && isRecord(child)) {
        for (const [envKey, envValue] of Object.entries(child)) {
          if (envKey.toLowerCase().includes("model")) {
            addSafeModel(result, seen, envValue, [...nextPath, envKey].join("."), modelRoleFromKey(envKey));
          }
        }
        continue;
      }
      if (catalogKeys.has(normalizedKey) || normalizedKey === "config" || normalizedKey === "options") {
        visit(child, nextPath, depth + 1);
      }
    }
  };
  visit(value, [], 0);
  return result;
}

function collectSafeEndpointHosts(value: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown): void => {
    const host = safeUrlHost(candidate);
    if (host && !seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  };
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 5 || !isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      if (["base_url", "baseurl", "endpoint", "api_base", "apibase", "baseurl"].includes(normalizedKey)) {
        add(child);
      } else if (normalizedKey === "env" && isRecord(child)) {
        for (const [envKey, envValue] of Object.entries(child)) {
          if (envKey.toLowerCase().includes("base_url") || envKey.toLowerCase().includes("endpoint")) add(envValue);
        }
      } else if (normalizedKey === "endpoints" || normalizedKey === "providers" || normalizedKey === "config" || normalizedKey === "options") {
        if (isRecord(child)) visit(child, depth + 1);
        if (Array.isArray(child)) child.forEach((item) => visit(item, depth + 1));
      }
    }
  };
  visit(value, 0);
  return result.slice(0, 16);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function readTableColumns(database: DatabaseSync, table: string): Set<string> {
  try {
    const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((row) => typeof row.name === "string" ? row.name : ""));
  } catch {
    return new Set();
  }
}

function readAllowlistedRows(database: DatabaseSync, table: string, fields: readonly string[]): UnknownRecord[] {
  const columns = readTableColumns(database, table);
  const selected = fields.filter((field) => columns.has(field));
  if (selected.length === 0) return [];
  try {
    return database.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`).all() as UnknownRecord[];
  } catch {
    return [];
  }
}

interface RuntimeConfigCandidates {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  apiStyle: CcSwitchApiStyle | null;
}

function parseSettingsConfig(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 512 * 1024) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const record: UnknownRecord = {};
    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      const match = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/.exec(line);
      if (!match) continue;
      record[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return Object.keys(record).length > 0 ? record : null;
  }
}

function isUsableSecret(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length >= 8
    && !/^\$\{[^}]+\}$/.test(value.trim())
    && !/^<[^>]+>$/.test(value.trim());
}

function collectRuntimeConfig(value: unknown, result: RuntimeConfigCandidates, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  const parsed = typeof value === "string" ? parseSettingsConfig(value) : null;
  if (parsed !== null) {
    collectRuntimeConfig(parsed, result, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRuntimeConfig(item, result, depth + 1));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!result.baseUrl && ["baseurl", "apibase", "apibaseurl", "endpoint", "endpointurl"].includes(normalizedKey)) {
      result.baseUrl = safeUrl(child);
    }
    if (!result.model && ["model", "modelname", "defaultmodel"].includes(normalizedKey)) {
      result.model = stringValue(child);
    }
    if (isUsableSecret(child)
      && (normalizedKey === "apikey"
        || normalizedKey.endsWith("apikey")
        || normalizedKey === "token"
        || normalizedKey.endsWith("authtoken")
        || normalizedKey.endsWith("accesstoken"))) {
      result.apiKey ??= child.trim().slice(0, 1024);
    }
    if (normalizedKey.includes("openai") || (typeof child === "string" && /openai|responses|completions/i.test(child))) {
      result.apiStyle = "openai-compatible";
    }
    if (normalizedKey.includes("anthropic") || (typeof child === "string" && /anthropic/i.test(child))) {
      result.apiStyle = "anthropic";
    }
    if (!result.model && normalizedKey === "models" && Array.isArray(child)) {
      const firstModel = child.find((item) => isRecord(item) || typeof item === "string");
      if (typeof firstModel === "string") result.model = stringValue(firstModel);
      else if (isRecord(firstModel)) {
        result.model = stringValue(firstModel.id) ?? stringValue(firstModel.model) ?? stringValue(firstModel.name);
      }
    }
    collectRuntimeConfig(child, result, depth + 1);
  }
}

function apiStyleFromProvider(value: string | null, app: CcSwitchAppType): CcSwitchApiStyle {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("openai") || normalized.includes("openrouter") || normalized.includes("gemini")) {
    return "openai-compatible";
  }
  return app === "claude-code" || app === "claude-desktop" ? "anthropic" : "openai-compatible";
}

/**
 * Reads the live current CC Switch provider for main-process API routing.
 * Credentials never leave this process and are never persisted in PetSettings.
 */
export function readCcSwitchRuntimeConfig(
  app: CcSwitchAppType,
  homePath = homedir(),
  allowNonCurrentFallback = false,
): CcSwitchRuntimeConfig | null {
  const databasePath = join(homePath, ".cc-switch", "cc-switch.db");
  if (!existsSync(databasePath)) return null;

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const providerRows = readAllowlistedRows(database, "providers", [
      "id", "app_type", "name", "provider_type", "is_current", "sort_index", "settings_config",
    ]);
    const endpointRows = readAllowlistedRows(database, "provider_endpoints", ["provider_id", "app_type", "url"]);
    const matchingRows = providerRows
      .filter((candidate) => normalizeAppType(candidate.app_type) === app)
      .sort((left, right) => Number(booleanValue(right.is_current)) - Number(booleanValue(left.is_current))
        || (typeof left.sort_index === "number" ? left.sort_index : Number.MAX_SAFE_INTEGER)
          - (typeof right.sort_index === "number" ? right.sort_index : Number.MAX_SAFE_INTEGER)
        || String(left.name ?? "").localeCompare(String(right.name ?? "")));
    const row = matchingRows.find((candidate) => booleanValue(candidate.is_current))
      ?? (allowNonCurrentFallback ? matchingRows[0] : undefined);
    if (!row) return null;

    const providerId = stringValue(row.id) ?? (typeof row.id === "number" ? String(row.id) : null);
    const candidates: RuntimeConfigCandidates = { baseUrl: null, apiKey: null, model: null, apiStyle: null };
    collectRuntimeConfig(parseSettingsConfig(row.settings_config), candidates);
    const endpoint = endpointRows.find((candidate) => {
      const candidateId = stringValue(candidate.provider_id) ?? (typeof candidate.provider_id === "number" ? String(candidate.provider_id) : null);
      const endpointApp = stringValue(candidate.app_type);
      return Boolean(providerId && candidateId === providerId && (!endpointApp || normalizeAppType(endpointApp) === app));
    });
    candidates.baseUrl ??= safeUrl(endpoint?.url);

    if (!candidates.baseUrl || !candidates.apiKey) return null;
    return {
      app,
      configDisplayName: stringValue(row.name) ?? `${appLabel(app)} API 配置`,
      providerName: stringValue(row.provider_type),
      model: candidates.model,
      baseUrl: candidates.baseUrl,
      apiKey: candidates.apiKey,
      apiStyle: candidates.apiStyle ?? apiStyleFromProvider(stringValue(row.provider_type), app),
    };
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore a read-only database close failure.
    }
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function supportedExecution(app: CcSwitchAppType, isCurrent: boolean): CcSwitchExecutionSupport {
  if (!isCurrent) return "metadata-only";
  return app === "claude-code" || app === "codex" || app === "hermes" ? "supported" : "metadata-only";
}

export function readCcSwitchProfiles(homePath = homedir()): CcSwitchAgentProfile[] {
  const databasePath = join(homePath, ".cc-switch", "cc-switch.db");
  if (!existsSync(databasePath)) return [];

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const providerRows = readAllowlistedRows(database, "providers", [
      "id", "app_type", "name", "website_url", "category", "icon", "icon_color", "meta", "is_current", "in_failover_queue", "sort_index", "provider_type", "settings_config",
    ]);
    const endpointRows = readAllowlistedRows(database, "provider_endpoints", ["provider_id", "app_type", "url"]);
    const endpointHosts = new Map<string, string[]>();
    for (const row of endpointRows) {
      const providerId = stringValue(row.provider_id) ?? (typeof row.provider_id === "number" ? String(row.provider_id) : null);
      const appValue = stringValue(row.app_type) ?? "";
      const host = safeUrlHost(row.url);
      if (providerId && host) {
        for (const key of [`${appValue}:${providerId}`, `${normalizeAppType(appValue)}:${providerId}`]) {
          const hosts = endpointHosts.get(key) ?? [];
          if (!hosts.includes(host)) hosts.push(host);
          endpointHosts.set(key, hosts);
        }
      }
    }

    type GroupedCcSwitchProfile = CcSwitchAgentProfile & {
      apiProfiles: CcSwitchApiProfile[];
      currentApiProfileId: string | null;
    };
    const grouped = new Map<CcSwitchAppType, GroupedCcSwitchProfile>();
    for (const row of providerRows) {
      const providerId = stringValue(row.id) ?? (typeof row.id === "number" ? String(row.id) : null);
      if (!providerId) continue;
      const rawApp = stringValue(row.app_type) ?? "unknown";
      const app = normalizeAppType(rawApp);
      const apiDisplayName = stringValue(row.name) ?? `${appLabel(app)} API 配置`;
      if (!grouped.has(app)) {
        grouped.set(app, {
          sourceId: `cc-switch:agent:${app}`,
          app,
          displayName: appLabel(app),
          iconKey: iconKey(app, app, appLabel(app)),
          iconColor: null,
          currentConfig: null,
          apiProfiles: [],
          currentApiProfileId: null,
          executionSupport: "metadata-only",
          syncState: "synced",
          detail: "已发现 Agent；未发现当前 CC Switch 配置",
        });
      }
      if (!booleanValue(row.is_current)) continue;
      const providerName = stringValue(row.provider_type) ?? stringValue(row.category);
      let parsedSettings: unknown = null;
      parsedSettings = parseSettingsConfig(row.settings_config);
      const models = collectSafeModels(parsedSettings);
      const configHosts = collectSafeEndpointHosts(parsedSettings);
      const endpointHostList = [
        ...(endpointHosts.get(`${rawApp}:${providerId}`) ?? []),
        ...(endpointHosts.get(`${app}:${providerId}`) ?? []),
        ...configHosts,
      ].filter((host, index, hosts) => hosts.indexOf(host) === index).slice(0, 16);
      const model = models.find((item) => item.isDefault)?.modelId ?? models[0]?.modelId ?? null;
      const isCurrent = booleanValue(row.is_current);
      const executionSupport = supportedExecution(app, isCurrent);
      const apiSourceId = `cc-switch:api:${app}:${providerId.slice(0, 80)}`;
      const apiProfile: CcSwitchApiProfile = {
        sourceId: apiSourceId,
        displayName: apiDisplayName,
        providerName,
        model,
        baseUrlHost: endpointHostList[0] ?? null,
        iconKey: iconKey(row.icon, app, apiDisplayName),
        iconColor: safeColor(row.icon_color),
        modelIconKey: modelIconKey(model),
        models,
        endpoints: endpointHostList.map((host, index) => ({
          sourceId: `${apiSourceId}:endpoint:${host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").slice(0, 100)}`,
          host,
          isDefault: index === 0,
          failoverPriority: index === 0 ? null : index,
          health: "unknown",
        })),
        isCurrent,
        failoverPriority: typeof row.sort_index === "number" && Number.isFinite(row.sort_index) ? Math.max(0, Math.round(row.sort_index)) : null,
        syncState: "synced",
        executionSupport,
        detail: executionSupport === "supported"
          ? "当前 API 配置可由现有 CLI 适配器读取"
          : app === "unknown" || app === "claude-desktop" || app === "gemini" || app === "opencode" || app === "openclaw"
            ? "已导入 API 元数据；当前未支持执行适配器"
            : "已导入 API 配置；非当前卡片需完成隔离执行绑定",
      };
      const existing = grouped.get(app);
      if (existing) {
        existing.apiProfiles.push(apiProfile);
        if (apiProfile.isCurrent) existing.currentApiProfileId = apiProfile.sourceId;
        if (apiProfile.executionSupport === "supported") existing.executionSupport = "supported";
      } else {
        grouped.set(app, {
          sourceId: `cc-switch:agent:${app}`,
          app,
          displayName: appLabel(app),
          iconKey: iconKey(app, app, appLabel(app)),
          iconColor: null,
          currentConfig: null,
          apiProfiles: [apiProfile],
          currentApiProfileId: apiProfile.isCurrent ? apiProfile.sourceId : null,
          executionSupport,
          syncState: "synced",
          detail: "已读取 Agent 容器及其 API 配置卡片；凭据未读取",
        });
      }
    }
    return Array.from(grouped.values()).map((profile) => {
      const current = profile.apiProfiles.find((item) => item.sourceId === profile.currentApiProfileId)
        ?? profile.apiProfiles.find((item) => item.isCurrent)
        ?? null;
      return {
        sourceId: profile.sourceId,
        app: profile.app,
        displayName: profile.displayName,
        iconKey: profile.iconKey,
        iconColor: profile.iconColor,
        currentConfig: current ? {
          agentSourceId: profile.sourceId,
          apiSourceId: current.sourceId,
          app: profile.app,
          agentDisplayName: profile.displayName,
          configDisplayName: current.displayName,
          providerName: current.providerName,
          model: current.model,
          baseUrlHost: current.baseUrlHost,
          iconKey: current.iconKey,
          iconColor: current.iconColor,
          modelIconKey: current.modelIconKey,
          availableModels: current.models,
          state: current.executionSupport === "needs-login" ? "needs-login" as const : "current" as const,
          executionSupport: current.executionSupport,
          lastSyncedAt: Date.now(),
          detail: current.detail,
        } : null,
        executionSupport: current?.executionSupport ?? "metadata-only",
        syncState: profile.syncState,
        detail: current ? "已读取每个 Agent 在 CC Switch 中的当前配置；仅保留安全引用" : "未发现该 Agent 的当前 CC Switch 配置",
      };
    });
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore a database close failure; no data is written.
    }
  }
}

// Single-entry, mtime-keyed cache for the CC Switch profiles read. The import
// flow issues `ccswitch:status` immediately followed by `ccswitch:sync`, and
// both previously re-opened and re-parsed the same SQLite database plus the
// settings_config JSON of every current provider. Reuse the parsed result until
// the database file changes so the second call in the same flow does not repeat
// the read. Credentials are read via the same allowlisted columns as before and
// never leave this process.
interface CcSwitchProfilesCacheEntry {
  databaseMtimeMs: number | null;
  profiles: CcSwitchAgentProfile[];
}

let ccSwitchProfilesCache: CcSwitchProfilesCacheEntry | null = null;

export function readCcSwitchProfilesCached(homePath = homedir()): CcSwitchAgentProfile[] {
  const databasePath = join(homePath, ".cc-switch", "cc-switch.db");
  const modifiedAt = fileChangedAt(databasePath);
  if (modifiedAt !== null && ccSwitchProfilesCache && ccSwitchProfilesCache.databaseMtimeMs === modifiedAt) {
    return ccSwitchProfilesCache.profiles;
  }
  const profiles = readCcSwitchProfiles(homePath);
  ccSwitchProfilesCache = { databaseMtimeMs: modifiedAt, profiles };
  return profiles;
}

function modelFromEnvironment(env: UnknownRecord): string | null {
  const candidates = [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.OPENAI_MODEL,
  ];
  return candidates.map(stringValue).find((value): value is string => Boolean(value)) ?? null;
}

function readClaudeStatus(homePath: string, enabled: boolean): CcSwitchTargetStatus {
  const filePath = join(homePath, ".claude", "settings.json");
  const changedAt = fileChangedAt(filePath);
  if (!enabled) {
    return {
      id: "claude-code",
      label: "Claude Code",
      state: "detected",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: changedAt,
      detail: "实时引用已关闭",
    };
  }
  if (!existsSync(filePath)) {
    return {
      id: "claude-code",
      label: "Claude Code",
      state: "not-found",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: null,
      detail: "未发现 Claude Code live 配置",
    };
  }

  const settings = readJsonFile(filePath);
  if (!settings) {
    return {
      id: "claude-code",
      label: "Claude Code",
      state: "error",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: changedAt,
      detail: "配置文件无法解析",
    };
  }
  const env = isRecord(settings.env) ? settings.env : {};
  const baseUrlHost = safeUrlHost(env.ANTHROPIC_BASE_URL);
  const model = modelFromEnvironment(env) ?? modelFromEnvironment(settings);
  return {
    id: "claude-code",
    label: "Claude Code",
    state: "available",
    provider: baseUrlHost ? "Anthropic 兼容服务" : "Claude Code 配置",
    model,
    baseUrlHost,
    lastChangedAt: changedAt,
    detail: "已读取当前 live 配置；未读取凭据字段",
  };
}

interface CodexProviderConfig {
  name: string | null;
  baseUrlHost: string | null;
}

function parseCodexConfig(contents: string): { model: string | null; providerId: string | null; provider: CodexProviderConfig | null } {
  let section = "";
  let model: string | null = null;
  let providerId: string | null = null;
  const providers = new Map<string, CodexProviderConfig>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const sectionMatch = /^\[model_providers\.([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!providers.has(section)) providers.set(section, { name: null, baseUrlHost: null });
      continue;
    }
    const valueMatch = /^(model|model_provider|name|base_url)\s*=\s*["']([^"']*)["']\s*$/.exec(line);
    if (!valueMatch) continue;
    const [, key, value] = valueMatch;
    if (!section) {
      if (key === "model") model = value.slice(0, 160);
      if (key === "model_provider") providerId = value.slice(0, 80);
      continue;
    }
    const provider = providers.get(section);
    if (!provider) continue;
    if (key === "name") provider.name = value.slice(0, 120);
    if (key === "base_url") provider.baseUrlHost = safeUrlHost(value);
  }

  return {
    model,
    providerId,
    provider: providerId ? providers.get(providerId) ?? null : null,
  };
}

function readCodexStatus(homePath: string, enabled: boolean): CcSwitchTargetStatus {
  const filePath = join(homePath, ".codex", "config.toml");
  const changedAt = fileChangedAt(filePath);
  if (!enabled) {
    return {
      id: "codex",
      label: "Codex",
      state: "detected",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: changedAt,
      detail: "实时引用已关闭",
    };
  }
  if (!existsSync(filePath)) {
    return {
      id: "codex",
      label: "Codex",
      state: "not-found",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: null,
      detail: "未发现 Codex live 配置",
    };
  }

  try {
    const parsed = parseCodexConfig(readFileSync(filePath, "utf8"));
    return {
      id: "codex",
      label: "Codex",
      state: "available",
      provider: parsed.provider?.name ?? parsed.providerId ?? "Codex 配置",
      model: parsed.model,
      baseUrlHost: parsed.provider?.baseUrlHost ?? null,
      lastChangedAt: changedAt,
      detail: "已读取当前 live 配置；未读取凭据字段",
    };
  } catch {
    return {
      id: "codex",
      label: "Codex",
      state: "error",
      provider: null,
      model: null,
      baseUrlHost: null,
      lastChangedAt: changedAt,
      detail: "配置文件无法解析",
    };
  }
}

export function readCcSwitchStatus(enabled: boolean): CcSwitchStatus {
  const homePath = homedir();
  const ccSwitchRoot = join(homePath, ".cc-switch");
  const dataDirectoryDetected = existsSync(join(ccSwitchRoot, "settings.json"))
    || existsSync(join(ccSwitchRoot, "cc-switch.db"));
  if (!enabled) {
    return {
      enabled: false,
      state: "disabled",
      dataDirectoryDetected,
      targets: [readClaudeStatus(homePath, false), readCodexStatus(homePath, false)],
      profiles: [],
      detail: "CC Switch 实时引用已关闭",
      updatedAt: Date.now(),
    };
  }

  const targets = [readClaudeStatus(homePath, true), readCodexStatus(homePath, true)];
  const profiles = readCcSwitchProfiles(homePath);
  const currentConfigCount = profiles.filter((profile) => profile.currentConfig).length;
  const availableCount = targets.filter((target) => target.state === "available").length;
  const errorCount = targets.filter((target) => target.state === "error").length;
  const state = availableCount > 0
    ? "available"
    : errorCount > 0
      ? "error"
      : dataDirectoryDetected
        ? "detected"
        : "not-found";
  return {
    enabled: true,
    state,
    dataDirectoryDetected,
    targets,
    profiles,
    detail: dataDirectoryDetected
      ? `已发现 CC Switch；已读取 ${profiles.length} 个 Agent、${currentConfigCount} 个当前配置，当前仅只读引用`
      : "未发现 CC Switch 数据目录，仍会检查标准 CLI 配置",
    updatedAt: Date.now(),
  };
}
