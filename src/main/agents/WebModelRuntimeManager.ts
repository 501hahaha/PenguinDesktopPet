import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { ZeroTokenSettings } from "../../settings/types";
import { terminateOwnedChildProcess } from "../processCleanup";
import {
  type WebModelModel,
  type WebModelProvider,
  type WebModelRuntimeState,
  type WebModelRuntimeStatus,
} from "./WebModelRuntimeTypes";
import type { RuntimeLogEntry, RuntimeProvider } from "../runtime/types";

export const WEBMODEL_DEFAULT_PORT = 3456;

export type ZeroTokenErrorCode =
  | "ZERO_TOKEN_SERVICE_UNAVAILABLE"
  | "ZERO_TOKEN_RUNTIME_NOT_FOUND"
  | "ZERO_TOKEN_START_FAILED"
  | "ZERO_TOKEN_PORT_CONFLICT"
  | "ZERO_TOKEN_BROWSER_NOT_FOUND"
  | "ZERO_TOKEN_LOGIN_REQUIRED"
  | "ZERO_TOKEN_SESSION_EXPIRED"
  | "ZERO_TOKEN_MODEL_UNAVAILABLE"
  | "ZERO_TOKEN_TIMEOUT"
  | "ZERO_TOKEN_STREAM_INTERRUPTED"
  | "ZERO_TOKEN_UNKNOWN_ERROR";

export class ZeroTokenRuntimeError extends Error {
  readonly code: ZeroTokenErrorCode;

  constructor(code: ZeroTokenErrorCode, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "ZeroTokenRuntimeError";
    this.code = code;
  }
}

export interface WebModelRuntimeManagerOptions {
  getUserDataPath: () => string;
  getResourcesPath?: () => string;
  getAppPath?: () => string;
  onStateChanged?: (state: WebModelRuntimeState) => void;
  onModelSelected?: (modelId: string) => void;
}

interface JsonResult {
  response: Response;
  value: unknown;
}

type RuntimeKind = "exe" | "node" | "python";

interface RuntimeLaunchSpec {
  runtimePath: string;
  kind: RuntimeKind;
  command: string;
  args: string[];
  cwd: string;
  stateDir: string;
}

interface ModelsProbe {
  reachable: boolean;
  accepted: boolean;
  requiresLogin: boolean;
  statusCode: number | null;
  models: WebModelModel[];
  detail: string;
}

const MAX_LOG_LENGTH = 2_000;
const HEALTH_POLL_LIMIT = 60;
const HEALTH_CHECK_INTERVAL_MS = 1_000;
const STARTUP_HEALTH_TIMEOUT_MS = 1_500;
const NORMAL_HEALTH_INTERVAL_MS = 10_000;
const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function redactLog(value: string): string {
  return value
    .replace(/(authorization|x-api-key|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s]+/gi, (url) => url.replace(/([?&](?:token|key|secret|password)=)[^&]+/gi, "$1<redacted>"))
    .slice(-MAX_LOG_LENGTH);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function runtimeKind(path: string): RuntimeKind | null {
  switch (extname(path).toLowerCase()) {
    case ".exe": return "exe";
    case ".js": return "node";
    case ".py": return "python";
    default: return null;
  }
}

function runtimePathCandidates(path: string): string[] {
  if (!isDirectory(path)) return [path];
  const known = [
    join(path, "ZeroTokenRuntime.exe"),
    join(path, "zerotoken.exe"),
    join(path, "WebModel.exe"),
    join(path, "webmodel.exe"),
    join(path, "main.exe"),
    join(path, "dist", "cli.js"),
    join(path, "cli.js"),
    join(path, "runtime.js"),
    join(path, "server.js"),
    join(path, "index.js"),
    join(path, "main.py"),
    join(path, "webmodel.py"),
    join(path, "zerotoken.py"),
    join(path, "runtime.py"),
    join(path, "server.py"),
    join(path, "index.py"),
  ];
  try {
    const directFiles = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && Boolean(runtimeKind(entry.name)))
      .map((entry) => join(path, entry.name))
      .sort((left, right) => left.localeCompare(right));
    return [...known, ...directFiles];
  } catch {
    return known;
  }
}

function safeEnvironmentSummary(env: NodeJS.ProcessEnv): string {
  const summary: Record<string, string> = {
    NODE_ENV: env.NODE_ENV || "<unset>",
    PENGUIN_NODE_PATH: env.PENGUIN_NODE_PATH || "<unset>",
    PENGUIN_PYTHON_PATH: env.PENGUIN_PYTHON_PATH || "<unset>",
    PENGUIN_WEBMODEL_SOURCE: env.PENGUIN_WEBMODEL_SOURCE || "<unset>",
    PATH: env.PATH ? "<set>" : "<unset>",
  };
  const keys = Object.keys(env).sort();
  return JSON.stringify({ keyCount: keys.length, keys: keys.slice(0, 32), values: summary });
}

function formatRuntimeDebug(spec: RuntimeLaunchSpec, env: NodeJS.ProcessEnv): string {
  return [
    "[ZeroToken Debug]",
    `platform: ${process.platform}`,
    `runtime executable path: ${spec.runtimePath}`,
    `command: ${spec.command}`,
    `args: ${JSON.stringify(spec.args)}`,
    `cwd: ${spec.cwd}`,
    `env: ${safeEnvironmentSummary(env)}`,
    "shell: false",
  ].join("\n");
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackUrl(value: URL): boolean {
  return value.hostname === "127.0.0.1" || value.hostname === "localhost" || value.hostname === "[::1]";
}

function parseConfiguredUrl(config: ZeroTokenSettings): { origin: string; baseUrl: string; port: number } {
  const raw = config.baseUrl.trim() || `http://127.0.0.1:${WEBMODEL_DEFAULT_PORT}/v1`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel base URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackUrl(url)) {
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel must stay on localhost");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel port is invalid");
  }
  const origin = url.origin;
  const baseUrl = `${origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
  return { origin, baseUrl, port };
}

function providersUrl(origin: string): string {
  return `${origin}/webmodel/providers`;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`;
}

function providerFromModelId(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : undefined;
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<JsonResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) as unknown : null;
    } catch {
      value = text;
    }
    return { response, value };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_TIMEOUT", `Timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

function responseDetail(result: JsonResult, fallback: string): string {
  const value = isRecord(result.value) ? result.value : null;
  const error = value && isRecord(value.error) ? textValue(value.error.message) : "";
  const message = error || (typeof result.value === "string" ? result.value : "");
  return (message || fallback).replace(/\s+/g, " ").trim().slice(0, 240);
}

function initialState(): WebModelRuntimeState {
  return {
    status: "stopped",
    port: WEBMODEL_DEFAULT_PORT,
    baseUrl: `http://127.0.0.1:${WEBMODEL_DEFAULT_PORT}/v1`,
    pid: null,
    spawnedByApp: false,
    lastError: null,
    detail: "WebModel 未启动",
    providers: [],
    models: [],
    selectedModelId: null,
    startedAt: null,
    logs: [],
    updatedAt: Date.now(),
  };
}

export class WebModelRuntimeManager {
  private readonly options: WebModelRuntimeManagerOptions;
  private state = initialState();
  private child: ChildProcess | null = null;
  private startPromise: Promise<WebModelRuntimeState> | null = null;
  private lastHealthCheckAt = 0;
  private recoveryAttempted = false;
  private stopping = false;

  constructor(options: WebModelRuntimeManagerOptions) {
    this.options = options;
  }

  getState(): WebModelRuntimeState {
    return { ...this.state, providers: [...this.state.providers], models: [...this.state.models], logs: [...this.state.logs] };
  }

  getLogs(): RuntimeLogEntry[] {
    return this.state.logs.map((entry) => ({ ...entry }));
  }

  getRuntimeProvider(): RuntimeProvider {
    const state = this.state;
    return {
      id: "zerotoken",
      type: "zerotoken",
      name: "ZeroToken Runtime",
      status: state.status,
      baseURL: state.baseUrl,
      port: state.port ?? 0,
      models: state.models.map((model) => model.id),
      ...(state.pid ? { pid: state.pid } : {}),
      ...(state.lastError ? { error: state.lastError } : {}),
      updatedAt: state.updatedAt,
    };
  }

  private setState(patch: Partial<WebModelRuntimeState>): WebModelRuntimeState {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.options.onStateChanged?.(this.getState());
    return this.getState();
  }

  private appendLog(level: RuntimeLogEntry["level"], message: string): void {
    const normalized = redactLog(message).trim();
    if (!normalized) return;
    const entry: RuntimeLogEntry = { timestamp: Date.now(), level, message: normalized.slice(0, MAX_LOG_LENGTH) };
    this.state = { ...this.state, logs: [...this.state.logs, entry].slice(-80), updatedAt: Date.now() };
    this.options.onStateChanged?.(this.getState());
  }

  private setFailure(error: unknown, fallbackCode: ZeroTokenErrorCode): ZeroTokenRuntimeError {
    const runtimeError = error instanceof ZeroTokenRuntimeError
      ? error
      : new ZeroTokenRuntimeError(fallbackCode, errorMessage(error));
    this.setState({
      status: "error",
      lastError: runtimeError.message,
      detail: runtimeError.message,
    });
    this.appendLog("error", runtimeError.message);
    return runtimeError;
  }

  private async requestHealth(origin: string, timeoutMs = 2_000): Promise<boolean> {
    const baseUrl = `${origin}/v1`;
    const probe = await this.probeModels(baseUrl, timeoutMs);
    this.lastHealthCheckAt = Date.now();
    // Any HTTP response means a service already owns the configured port; the
    // caller can classify 401/403/5xx as login-required or error instead of
    // spawning a second runtime beside it.
    return probe.reachable;
  }

  private async probeModels(baseUrl: string, timeoutMs = 2_000): Promise<ModelsProbe> {
    try {
      const result = await fetchJson(modelsUrl(baseUrl), timeoutMs);
      const statusCode = result.response.status;
      if (statusCode === 401 || statusCode === 403) {
        return {
          reachable: true,
          accepted: true,
          requiresLogin: true,
          statusCode,
          models: [],
          detail: responseDetail(result, "ZeroToken Runtime 需要浏览器登录"),
        };
      }
      if (!result.response.ok) {
        return {
          reachable: true,
          accepted: false,
          requiresLogin: false,
          statusCode,
          models: [],
          detail: responseDetail(result, `ZeroToken Runtime 返回 HTTP ${statusCode}`),
        };
      }
      return {
        reachable: true,
        accepted: true,
        requiresLogin: false,
        statusCode,
        models: this.parseModels(result.value),
        detail: "ZeroToken Runtime /v1/models 可用",
      };
    } catch (error) {
      return {
        reachable: false,
        accepted: false,
        requiresLogin: false,
        statusCode: null,
        models: [],
        detail: errorMessage(error),
      };
    }
  }

  async healthCheck(config?: ZeroTokenSettings): Promise<boolean> {
    const parsed = config ? parseConfiguredUrl(config) : this.state.baseUrl
      ? parseConfiguredUrl({ enabled: true, provider: "chatgpt-web", baseUrl: this.state.baseUrl, runtimePath: "", model: "", timeout: 120_000, autoStart: true })
      : null;
    if (!parsed) return false;
    return this.requestHealth(parsed.origin, Math.min(config?.timeout ?? 5_000, 5_000));
  }

  async detect(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    const parsed = parseConfiguredUrl(config);
    const probe = await this.probeModels(parsed.baseUrl, Math.min(config.timeout || 5_000, 5_000));
    if (!probe.accepted) {
      if (!this.child) {
        if (!probe.reachable) {
          try {
            await this.resolveRuntimePaths(config, parsed.port);
          } catch (error) {
            if (error instanceof ZeroTokenRuntimeError && error.code === "ZERO_TOKEN_RUNTIME_NOT_FOUND") {
              this.setFailure(error, "ZERO_TOKEN_RUNTIME_NOT_FOUND");
              return this.getState();
            }
          }
        }
        return this.setState({
          status: probe.reachable ? "error" : "stopped",
          port: probe.reachable ? parsed.port : null,
          baseUrl: parsed.baseUrl,
          pid: null,
          spawnedByApp: false,
          providers: [],
          models: [],
          selectedModelId: null,
          lastError: probe.reachable ? `ZERO_TOKEN_SERVICE_UNAVAILABLE: ${probe.detail}` : null,
          detail: probe.reachable ? probe.detail : "ZeroToken Runtime 未检测到",
        });
      }
      return this.setState({
        status: "error",
        lastError: `ZERO_TOKEN_SERVICE_UNAVAILABLE: ${probe.detail}`,
        detail: probe.detail,
      });
    }

    const catalog = await this.refreshCatalog(parsed.origin, parsed.baseUrl, config.model);
    return this.setState({
      status: probe.requiresLogin ? "login_required" : catalog.status,
      port: parsed.port,
      baseUrl: parsed.baseUrl,
      pid: this.child?.pid ?? null,
      spawnedByApp: Boolean(this.child),
      lastError: null,
      detail: probe.requiresLogin ? "ZeroToken Runtime 需要浏览器登录" : catalog.detail,
      providers: catalog.providers,
      models: probe.models.length > 0 ? probe.models : catalog.models,
      selectedModelId: catalog.selectedModelId,
    });
  }

  private async refreshCatalog(origin: string, baseUrl: string, requestedModel: string): Promise<{
    status: WebModelRuntimeStatus;
    detail: string;
    providers: WebModelProvider[];
    models: WebModelModel[];
    selectedModelId: string | null;
  }> {
    let providers: WebModelProvider[] = [];
    let models: WebModelModel[] = [];
    try {
      const providersResult = await fetchJson(providersUrl(origin), 5_000);
      if (providersResult.response.ok) providers = this.parseProviders(providersResult.value);
      const modelsResult = await fetchJson(modelsUrl(baseUrl), 5_000);
      if (modelsResult.response.ok) models = this.parseModels(modelsResult.value);
      else if (modelsResult.response.status === 401 || modelsResult.response.status === 403) {
        return { status: "login_required", detail: "ZERO_TOKEN_LOGIN_REQUIRED", providers, models, selectedModelId: null };
      }
    } catch (error) {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", errorMessage(error));
    }

    const selectedModelId = requestedModel.trim() && models.some((model) => model.id === requestedModel.trim())
      ? requestedModel.trim()
      : models[0]?.id ?? null;
    if (selectedModelId && selectedModelId !== requestedModel.trim()) this.options.onModelSelected?.(selectedModelId);

    if (!models.length) {
      return {
        status: "login_required",
        detail: providers.some((provider) => !provider.authenticated) ? "ZERO_TOKEN_LOGIN_REQUIRED" : "ZERO_TOKEN_MODEL_UNAVAILABLE",
        providers,
        models,
        selectedModelId,
      };
    }
    return {
      status: "ready",
      detail: `WebModel 已就绪 · ${selectedModelId ?? "未选择模型"}`,
      providers,
      models,
      selectedModelId,
    };
  }

  private parseProviders(value: unknown): WebModelProvider[] {
    const raw = isRecord(value) && Array.isArray(value.providers) ? value.providers : [];
    return raw.map((item): WebModelProvider | null => {
      if (!isRecord(item)) return null;
      const id = textValue(item.id);
      if (!id) return null;
      return {
        id,
        name: textValue(item.name) || id,
        website: textValue(item.website) || undefined,
        authenticated: item.authenticated === true,
        modelCount: numberValue(item.modelCount) ?? 0,
      };
    }).filter((item): item is WebModelProvider => Boolean(item));
  }

  private parseModels(value: unknown): WebModelModel[] {
    const raw = isRecord(value) && Array.isArray(value.data) ? value.data : [];
    return raw.map((item): WebModelModel | null => {
      if (!isRecord(item)) return null;
      const id = textValue(item.id);
      if (!id) return null;
      return {
        id,
        name: textValue(item.name) || undefined,
        providerId: providerFromModelId(id),
        contextWindow: numberValue(item.context_window) ?? numberValue(item.contextWindow),
        maxOutput: numberValue(item.max_output) ?? numberValue(item.maxOutput),
      };
    }).filter((item): item is WebModelModel => Boolean(item));
  }

  async start(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.startInternal(config).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    const parsed = parseConfiguredUrl(config);
    if (await this.requestHealth(parsed.origin)) {
      if (this.stopping) return this.getState();
      return this.detect(config);
    }
    if (this.stopping) return this.getState();

    let port: number;
    try {
      port = await this.findFreePort(parsed.port);
    } catch (error) {
      throw this.setFailure(error, "ZERO_TOKEN_PORT_CONFLICT");
    }
    const baseUrl = `${parsed.origin.replace(/:\d+$/, `:${port}`)}/v1`;
    this.setState({
      status: "starting",
      port,
      baseUrl,
      pid: null,
      spawnedByApp: false,
      lastError: null,
      detail: `正在启动 WebModel · ${port}`,
      providers: [],
      models: [],
      selectedModelId: null,
      startedAt: Date.now(),
    });
    this.appendLog("info", `启动 ZeroToken Runtime · 端口 ${port}`);
    this.appendLog("info", [
      "[ZeroToken Debug]",
      `platform: ${process.platform}`,
      `runtime executable path: ${config.runtimePath.trim() || process.env.PENGUIN_WEBMODEL_SOURCE?.trim() || "<unconfigured>"}`,
      "command: <not resolved>",
      "args: []",
      "cwd: <not resolved>",
      `env: ${safeEnvironmentSummary(sanitizedEnvironment())}`,
      "shell: false",
    ].join("\n"));

    let launchSpec: RuntimeLaunchSpec;
    try {
      launchSpec = await this.resolveRuntimePaths(config, port);
    } catch (error) {
      throw this.setFailure(error, "ZERO_TOKEN_START_FAILED");
    }
    if (this.stopping) return this.getState();

    let child: ChildProcess;
    try {
      child = this.spawnWebModel(launchSpec);
    } catch (error) {
      throw this.setFailure(error, error instanceof ZeroTokenRuntimeError ? error.code : "ZERO_TOKEN_START_FAILED");
    }
    this.child = child;
    this.setState({ pid: child.pid ?? null, spawnedByApp: true });
    let childOutput = "";
    let spawnError: ZeroTokenRuntimeError | null = null;
    const onChildOutput = (chunk: Buffer | string) => {
      childOutput = `${childOutput}${String(chunk)}`.slice(-MAX_LOG_LENGTH);
      const line = redactLog(String(chunk)).trim();
      if (line) {
        console.info(`[ZeroToken] ${line}`);
        this.appendLog("info", line);
      }
    };
    child.stdout?.on("data", onChildOutput);
    child.stderr?.on("data", (chunk) => {
      childOutput = `${childOutput}${String(chunk)}`.slice(-MAX_LOG_LENGTH);
      const line = redactLog(String(chunk)).trim();
      if (line) {
        console.warn(`[ZeroToken] ${line}`);
        this.appendLog("warn", line);
      }
    });
    child.once("error", (error) => {
      const detail = `Runtime 进程启动失败：${errorMessage(error)}。请检查 command、args、cwd 和运行时依赖。`;
      spawnError = new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", detail);
      const debug = formatRuntimeDebug(launchSpec, sanitizedEnvironment());
      console.error(`${debug}\nspawn error: ${redactLog(errorMessage(error))}`);
      this.appendLog("error", `${debug}\nspawn error: ${redactLog(errorMessage(error))}\n${detail}`);
      this.setState({
        status: "error",
        pid: null,
        spawnedByApp: false,
        lastError: spawnError.message,
        detail: spawnError.message,
      });
    });
    child.once("exit", (code, signal) => {
      if (spawnError || this.child !== child || this.stopping) return;
      this.child = null;
      this.recoveryAttempted = true;
      const browserUnavailable = /(?:chrome|chromium|browser).*(?:not found|unavailable|missing)|executable.*does not exist/i.test(childOutput);
      const failureCode = browserUnavailable ? "ZERO_TOKEN_BROWSER_NOT_FOUND" : "ZERO_TOKEN_START_FAILED";
      this.setState({
        status: "error",
        pid: null,
        spawnedByApp: false,
        lastError: `${failureCode}: WebModel exited (${code ?? "signal " + signal})`,
        detail: `${failureCode}: WebModel 子进程已退出`,
      });
      this.appendLog("error", `${failureCode}: WebModel 子进程已退出`);
    });

    for (let attempt = 0; attempt < HEALTH_POLL_LIMIT; attempt += 1) {
      if (this.child !== child) break;
      if (spawnError) {
        this.stopSpawnedChild(child);
        throw spawnError;
      }
      if (await this.requestHealth(new URL(baseUrl).origin, STARTUP_HEALTH_TIMEOUT_MS)) {
        try {
          const catalog = await this.refreshCatalog(new URL(baseUrl).origin, baseUrl, config.model);
          this.recoveryAttempted = false;
          return this.setState({
            status: catalog.status,
            port,
            baseUrl,
            pid: child.pid ?? null,
            spawnedByApp: true,
            lastError: null,
            detail: catalog.detail,
            providers: catalog.providers,
            models: catalog.models,
            selectedModelId: catalog.selectedModelId,
          });
        } catch (error) {
          const failure = this.setFailure(error, "ZERO_TOKEN_START_FAILED");
          this.stopSpawnedChild(child);
          throw failure;
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt < 2 ? 500 : HEALTH_CHECK_INTERVAL_MS));
    }
    if (spawnError) {
      this.stopSpawnedChild(child);
      throw spawnError;
    }
    const detail = this.state.lastError || "WebModel 启动后未通过 /webmodel/health 检查";
    const code: ZeroTokenErrorCode = /(?:chrome|chromium|browser).*(?:not found|unavailable|missing)|executable.*does not exist/i.test(childOutput)
      ? "ZERO_TOKEN_BROWSER_NOT_FOUND"
      : "ZERO_TOKEN_START_FAILED";
    const failure = this.setFailure(new ZeroTokenRuntimeError(code, detail), code);
    this.stopSpawnedChild(child);
    throw failure;
  }

  private stopSpawnedChild(child: ChildProcess): void {
    if (this.child !== child) return;
    this.stopping = true;
    this.child = null;
    void terminateOwnedChildProcess(child, "WebModel Runtime");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    const startPromise = this.startPromise;
    await Promise.all([
      ...(child ? [terminateOwnedChildProcess(child, "WebModel Runtime")] : []),
    ]);
    await startPromise?.catch(() => undefined);
    this.setState({
      status: "stopped",
      pid: null,
      spawnedByApp: false,
      providers: [],
      models: [],
      selectedModelId: null,
      lastError: null,
      detail: "WebModel 已停止",
      startedAt: null,
    });
    this.appendLog("info", "ZeroToken Runtime 已停止");
  }

  async restart(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    await this.stop();
    this.recoveryAttempted = false;
    return this.start(config);
  }

  async ensureRunning(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    if (this.startPromise) return this.startPromise;
    if (this.state.status === "error" && this.recoveryAttempted) {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", this.state.lastError ?? "WebModel recovery already attempted");
    }
    if (this.state.status === "ready" || this.state.status === "login_required") {
      if (Date.now() - this.lastHealthCheckAt < NORMAL_HEALTH_INTERVAL_MS) return this.getState();
      const detected = await this.detect(config);
      if (detected.status === "ready" || detected.status === "login_required") return detected;
    }
    return this.start(config);
  }

  async getModels(config: ZeroTokenSettings): Promise<WebModelModel[]> {
    const state = await this.ensureRunning(config);
    if (state.status === "login_required" && !state.models.length) {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_LOGIN_REQUIRED", state.detail);
    }
    return [...state.models];
  }

  async getProviders(config: ZeroTokenSettings): Promise<WebModelProvider[]> {
    await this.ensureRunning(config);
    return [...this.state.providers];
  }

  async loginProvider(config: ZeroTokenSettings, providerId: string): Promise<WebModelRuntimeState> {
    const state = await this.ensureRunning(config);
    if (!state.port) throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel port is unknown");
    const origin = new URL(state.baseUrl).origin;
    const result = await fetchJson(`${origin}/webmodel/auth/login`, 10_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: providerId.trim() }),
    });
    if (result.response.status === 404) throw new ZeroTokenRuntimeError("ZERO_TOKEN_LOGIN_REQUIRED", responseDetail(result, "Unknown provider"));
    if (result.response.status === 503) throw new ZeroTokenRuntimeError("ZERO_TOKEN_BROWSER_NOT_FOUND", responseDetail(result, "Browser unavailable"));
    if (!result.response.ok) throw new ZeroTokenRuntimeError("ZERO_TOKEN_UNKNOWN_ERROR", responseDetail(result, `HTTP ${result.response.status}`));

    this.setState({ status: "starting", detail: `正在等待 ${providerId.trim()} 登录完成` });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
      const providers = await this.getProvidersAfterLogin(origin);
      const provider = providers.find((item) => item.id === providerId.trim());
      if (provider?.authenticated) {
        const catalog = await this.refreshCatalog(origin, state.baseUrl, config.model);
        return this.setState({
          status: catalog.status,
          providers,
          models: catalog.models,
          selectedModelId: catalog.selectedModelId,
          lastError: null,
          detail: catalog.detail,
        });
      }
      this.setState({ providers, detail: `正在等待 ${providerId.trim()} 登录完成` });
    }
    this.setState({ status: "login_required", detail: "ZERO_TOKEN_LOGIN_REQUIRED" });
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_LOGIN_REQUIRED", "Provider login did not complete");
  }

  private async getProvidersAfterLogin(origin: string): Promise<WebModelProvider[]> {
    const result = await fetchJson(providersUrl(origin), 5_000);
    if (result.response.status === 401 || result.response.status === 403) {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_SESSION_EXPIRED", responseDetail(result, "WebModel session expired"));
    }
    if (!result.response.ok) throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", responseDetail(result, "Provider status unavailable"));
    return this.parseProviders(result.value);
  }

  async logoutProvider(config: ZeroTokenSettings, providerId: string): Promise<WebModelRuntimeState> {
    const state = await this.ensureRunning(config);
    if (!state.port) throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel port is unknown");
    const origin = new URL(state.baseUrl).origin;
    const result = await fetchJson(`${origin}/webmodel/auth/logout`, 10_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: providerId.trim() }),
    });
    if (!result.response.ok) throw new ZeroTokenRuntimeError("ZERO_TOKEN_UNKNOWN_ERROR", responseDetail(result, `HTTP ${result.response.status}`));
    return this.detect({ ...config, baseUrl: state.baseUrl });
  }

  async openDashboard(config: ZeroTokenSettings): Promise<string> {
    const state = await this.ensureRunning(config);
    if (!state.port) throw new ZeroTokenRuntimeError("ZERO_TOKEN_SERVICE_UNAVAILABLE", "WebModel port is unknown");
    return `http://127.0.0.1:${state.port}/`;
  }

  private async findFreePort(preferredPort: number): Promise<number> {
    for (let offset = 0; offset < 100; offset += 1) {
      const port = preferredPort + offset;
      if (port > 65535) break;
      const free = await new Promise<boolean>((resolveFree) => {
        const server = createServer();
        server.once("error", () => resolveFree(false));
        server.listen({ host: "127.0.0.1", port }, () => {
          server.close(() => resolveFree(true));
        });
      });
      if (free) return port;
    }
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_PORT_CONFLICT", "No free localhost port was found");
  }

  private spawnWebModel(spec: RuntimeLaunchSpec): ChildProcess {
    mkdirSync(spec.stateDir, { recursive: true });
    const env = sanitizedEnvironment();
    const debug = formatRuntimeDebug(spec, env);
    console.info(debug);
    this.appendLog("info", debug);

    const invalid = [
      !isFile(spec.runtimePath) ? `Runtime 文件不存在：${spec.runtimePath}` : "",
      !isDirectory(spec.cwd) ? `cwd 不存在或不是目录：${spec.cwd}` : "",
      spec.args.some((arg) => typeof arg !== "string" || arg.trim() === "") ? "args 包含空值或非字符串" : "",
      !spec.command.trim() ? "command 为空" : "",
    ].filter(Boolean);
    if (invalid.length) {
      const code: ZeroTokenErrorCode = invalid.some((item) => item.startsWith("Runtime 文件不存在"))
        ? "ZERO_TOKEN_RUNTIME_NOT_FOUND"
        : "ZERO_TOKEN_START_FAILED";
      throw new ZeroTokenRuntimeError(code, invalid.join("；"));
    }

    try {
      return spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = `Runtime 启动失败：${errorMessage(error)}。Windows spawn 参数已记录，请检查 executable、args、cwd 和 shell。`;
      this.appendLog("error", `${debug}\nspawn exception: ${redactLog(errorMessage(error))}\n${detail}`);
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", detail);
    }
  }

  private async resolveRuntimeCommand(command: string, kind: RuntimeKind): Promise<string> {
    const candidate = command.trim();
    if (!candidate) throw new ZeroTokenRuntimeError("ZERO_TOKEN_RUNTIME_NOT_FOUND", `${kind} 运行时命令为空`);
    if (isAbsolute(candidate) || candidate.includes("\\") || candidate.includes("/")) {
      if (isFile(candidate)) return resolve(candidate);
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_RUNTIME_NOT_FOUND", `${kind} 运行时不存在：${candidate}`);
    }
    const locator = process.platform === "win32" ? "where.exe" : "which";
    try {
      const result = await execFileAsync(locator, [candidate], { windowsHide: true, timeout: 5_000 });
      const located = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (located) return located;
    } catch {
      // The friendly ZERO_TOKEN_RUNTIME_NOT_FOUND below includes the exact dependency name.
    }
    throw new ZeroTokenRuntimeError("ZERO_TOKEN_RUNTIME_NOT_FOUND", `未找到 ${kind} 运行时依赖：${candidate}`);
  }

  private findRuntimeFile(source: string): string | null {
    const normalized = source.trim();
    if (!normalized) return null;
    for (const candidate of runtimePathCandidates(normalized)) {
      if (isFile(candidate) && runtimeKind(candidate)) return resolve(candidate);
    }
    return null;
  }

  private async resolveRuntimePaths(config: ZeroTokenSettings, port: number): Promise<RuntimeLaunchSpec> {
    const configured = config.runtimePath.trim();
    const envConfigured = process.env.PENGUIN_WEBMODEL_SOURCE?.trim() || "";
    const explicitSource = configured || envConfigured;
    const candidates = explicitSource
      ? [explicitSource]
      : [
          this.options.getResourcesPath ? join(this.options.getResourcesPath(), "webmodel") : "",
          this.options.getAppPath ? join(this.options.getAppPath(), "resources", "webmodel") : "",
          join(this.options.getUserDataPath(), "webmodel-sidecar", "source"),
        ];
    let runtimePath = "";
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (explicitSource && !existsSync(candidate)) {
        throw new ZeroTokenRuntimeError("ZERO_TOKEN_RUNTIME_NOT_FOUND", `Runtime路径：${resolve(candidate)} 不存在`);
      }
      const discovered = this.findRuntimeFile(candidate);
      if (discovered) {
        runtimePath = discovered;
        break;
      }
    }
    if (!runtimePath) {
      const displayPath = explicitSource ? resolve(explicitSource) : "<未配置>";
      throw new ZeroTokenRuntimeError(
        "ZERO_TOKEN_RUNTIME_NOT_FOUND",
        `Runtime路径：${displayPath} 未找到可启动的 .exe、.js 或 .py 文件。请在 ZeroToken 设置中选择 Runtime 文件或目录。`,
      );
    }

    const kind = runtimeKind(runtimePath);
    if (!kind) {
      throw new ZeroTokenRuntimeError("ZERO_TOKEN_RUNTIME_NOT_FOUND", `Runtime路径：${runtimePath} 类型不支持，仅支持 .exe、.js、.py`);
    }
    const stateDir = join(this.options.getUserDataPath(), "webmodel-state");
    const args = ["--port", String(port), "--host", "127.0.0.1", "--no-open", "--browser-mode", "launch", "--state-dir", stateDir];
    const command = kind === "exe"
      ? runtimePath
      : await this.resolveRuntimeCommand(
          kind === "node"
            ? (process.env.PENGUIN_NODE_PATH?.trim() || (process.platform === "win32" ? "node.exe" : "node"))
            : (process.env.PENGUIN_PYTHON_PATH?.trim() || (process.platform === "win32" ? "python.exe" : "python")),
          kind,
        );
    const launchArgs = kind === "exe" ? args : [runtimePath, ...args];
    const cwd = dirname(runtimePath);
    if (!isDirectory(cwd)) throw new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", `cwd 不存在或不是目录：${cwd}`);
    return { runtimePath, kind, command, args: launchArgs, cwd, stateDir };
  }

}
