import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ZeroTokenSettings } from "../../settings/types";
import { terminateOwnedChildProcess } from "../processCleanup";
import {
  type WebModelModel,
  type WebModelProvider,
  type WebModelRuntimeState,
  type WebModelRuntimeStatus,
} from "./WebModelRuntimeTypes";

export const WEBMODEL_DEFAULT_PORT = 3456;
export const WEBMODEL_GITHUB_URL = "https://github.com/linuxhsj/WebModel.git";

export type ZeroTokenErrorCode =
  | "ZERO_TOKEN_SERVICE_UNAVAILABLE"
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

interface RuntimePaths {
  cliPath: string;
  stateDir: string;
}

const MAX_LOG_LENGTH = 2_000;
const HEALTH_POLL_LIMIT = 60;
const HEALTH_CHECK_INTERVAL_MS = 1_000;
const STARTUP_HEALTH_TIMEOUT_MS = 1_500;
const NORMAL_HEALTH_INTERVAL_MS = 10_000;

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

function healthUrl(origin: string): string {
  return `${origin}/webmodel/health`;
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
    port: null,
    baseUrl: "",
    pid: null,
    spawnedByApp: false,
    lastError: null,
    detail: "WebModel 未启动",
    providers: [],
    models: [],
    selectedModelId: null,
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
  private readonly transientChildren = new Set<ChildProcess>();

  constructor(options: WebModelRuntimeManagerOptions) {
    this.options = options;
  }

  getState(): WebModelRuntimeState {
    return { ...this.state, providers: [...this.state.providers], models: [...this.state.models] };
  }

  private setState(patch: Partial<WebModelRuntimeState>): WebModelRuntimeState {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.options.onStateChanged?.(this.getState());
    return this.getState();
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
    return runtimeError;
  }

  private async requestHealth(origin: string, timeoutMs = 2_000): Promise<boolean> {
    try {
      const result = await fetchJson(healthUrl(origin), timeoutMs);
      this.lastHealthCheckAt = Date.now();
      return result.response.ok && isRecord(result.value) && result.value.status === "healthy";
    } catch {
      this.lastHealthCheckAt = Date.now();
      return false;
    }
  }

  async healthCheck(config?: ZeroTokenSettings): Promise<boolean> {
    const parsed = config ? parseConfiguredUrl(config) : this.state.baseUrl
      ? parseConfiguredUrl({ enabled: true, baseUrl: this.state.baseUrl, model: "", timeout: 120_000, autoStart: true })
      : null;
    if (!parsed) return false;
    return this.requestHealth(parsed.origin, Math.min(config?.timeout ?? 5_000, 5_000));
  }

  async detect(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    const parsed = parseConfiguredUrl(config);
    const healthy = await this.requestHealth(parsed.origin);
    if (!healthy) {
      if (!this.child) {
        return this.setState({
          status: "stopped",
          port: null,
          baseUrl: parsed.baseUrl,
          pid: null,
          spawnedByApp: false,
          providers: [],
          models: [],
          selectedModelId: null,
          lastError: null,
          detail: "WebModel 未检测到",
        });
      }
      return this.getState();
    }

    const catalog = await this.refreshCatalog(parsed.origin, parsed.baseUrl, config.model);
    return this.setState({
      status: catalog.status,
      port: parsed.port,
      baseUrl: parsed.baseUrl,
      pid: this.child?.pid ?? null,
      spawnedByApp: Boolean(this.child),
      lastError: null,
      detail: catalog.detail,
      providers: catalog.providers,
      models: catalog.models,
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
    });

    let paths: RuntimePaths;
    try {
      paths = await this.resolveRuntimePaths();
    } catch (error) {
      throw this.setFailure(error, "ZERO_TOKEN_START_FAILED");
    }
    if (this.stopping) return this.getState();

    const child = this.spawnWebModel(paths.cliPath, paths.stateDir, port);
    this.child = child;
    this.setState({ pid: child.pid ?? null, spawnedByApp: true });
    let childOutput = "";
    const onChildOutput = (chunk: Buffer | string) => {
      childOutput = `${childOutput}${String(chunk)}`.slice(-MAX_LOG_LENGTH);
      const line = redactLog(String(chunk)).trim();
      if (line) console.info(`[ZeroToken] ${line}`);
    };
    child.stdout?.on("data", onChildOutput);
    child.stderr?.on("data", (chunk) => {
      childOutput = `${childOutput}${String(chunk)}`.slice(-MAX_LOG_LENGTH);
      const line = redactLog(String(chunk)).trim();
      if (line) console.warn(`[ZeroToken] ${line}`);
    });
    child.once("error", (error) => {
      console.error(`[ZeroToken] spawn error: ${redactLog(errorMessage(error))}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child || this.stopping) return;
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
    });

    for (let attempt = 0; attempt < HEALTH_POLL_LIMIT; attempt += 1) {
      if (this.child !== child) break;
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
    const transientChildren = [...this.transientChildren];
    await Promise.all([
      ...(child ? [terminateOwnedChildProcess(child, "WebModel Runtime")] : []),
      ...transientChildren.map((item) => terminateOwnedChildProcess(item, "WebModel bootstrap")),
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
    });
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

  private spawnWebModel(cliPath: string, stateDir: string, port: number): ChildProcess {
    mkdirSync(stateDir, { recursive: true });
    const nodePath = process.env.PENGUIN_NODE_PATH?.trim() || (process.platform === "win32" ? "node.exe" : "node");
    const args = [cliPath, "--port", String(port), "--host", "127.0.0.1", "--no-open", "--browser-mode", "launch", "--state-dir", stateDir];
    const child = spawn(nodePath, args, {
      cwd: dirname(cliPath),
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return child;
  }

  private async resolveRuntimePaths(): Promise<RuntimePaths> {
    const configured = process.env.PENGUIN_WEBMODEL_SOURCE?.trim();
    const candidates = [
      configured,
      this.options.getResourcesPath ? join(this.options.getResourcesPath(), "webmodel", "dist", "cli.js") : undefined,
      this.options.getAppPath ? join(this.options.getAppPath(), "resources", "webmodel", "dist", "cli.js") : undefined,
      join(this.options.getUserDataPath(), "webmodel-sidecar", "source", "dist", "cli.js"),
    ].filter((value): value is string => Boolean(value));
    const existing = candidates.map((candidate) => {
      if (candidate.endsWith(".js")) return candidate;
      return join(candidate, "dist", "cli.js");
    }).find((candidate) => existsSync(candidate));
    if (existing) return { cliPath: resolve(existing), stateDir: join(this.options.getUserDataPath(), "webmodel-state") };

    const sidecarRoot = join(this.options.getUserDataPath(), "webmodel-sidecar");
    const sourceDir = join(sidecarRoot, "source");
    mkdirSync(sidecarRoot, { recursive: true });
    if (!existsSync(join(sourceDir, ".git"))) {
      await this.runCommand(process.platform === "win32" ? "git.exe" : "git", ["clone", "--depth", "1", WEBMODEL_GITHUB_URL, sourceDir], dirname(sourceDir), 180_000);
    }
    await this.runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], sourceDir, 300_000);
    await this.runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], sourceDir, 180_000);
    const cliPath = join(sourceDir, "dist", "cli.js");
    if (!existsSync(cliPath)) throw new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", "WebModel build did not produce dist/cli.js");
    return { cliPath, stateDir: join(this.options.getUserDataPath(), "webmodel-state") };
  }

  private runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolveCommand, rejectCommand) => {
      let settled = false;
      let output = "";
      const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.transientChildren.add(child);
      const cleanup = () => this.transientChildren.delete(child);
      const append = (chunk: Buffer | string) => { output = `${output}${String(chunk)}`.slice(-MAX_LOG_LENGTH); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void terminateOwnedChildProcess(child, `WebModel bootstrap (${command})`).finally(() => {
          cleanup();
          rejectCommand(new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", `${command} timed out`));
        });
      }, timeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        rejectCommand(new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", `${command}: ${errorMessage(error)}`));
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (code === 0) resolveCommand();
        else rejectCommand(new ZeroTokenRuntimeError("ZERO_TOKEN_START_FAILED", `${command} exited ${code}: ${redactLog(output)}`));
      });
    });
  }
}
