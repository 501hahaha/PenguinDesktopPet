import { BrowserManager } from "./BrowserManager";
import { SessionManager } from "./SessionManager";
import {
  getZeroTokenProvider,
  ZERO_TOKEN_PROVIDERS,
  type ZeroTokenProviderId,
  type ZeroTokenProviderStatus,
  type ZeroTokenStatus,
} from "./types";
import { logElectronSessionSource } from "./SessionDiagnostics";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const LOGIN_POLL_MS = 1_000;

/** Internal browser runtime for Phase 1. It intentionally has no child process or HTTP server. */
export class ZeroTokenRuntime {
  private initialized = false;
  private readonly statuses = new Map<ZeroTokenProviderId, ZeroTokenProviderStatus>();
  private readonly loginPromises = new Map<ZeroTokenProviderId, Promise<ZeroTokenProviderStatus>>();
  private readonly listeners = new Set<(status: ZeroTokenProviderStatus) => void>();

  constructor(
    readonly browserManager = new BrowserManager(),
    readonly sessionManager = new SessionManager(browserManager),
  ) {
    for (const provider of ZERO_TOKEN_PROVIDERS) {
      this.statuses.set(provider.id, this.createStatus(provider.id, "stopped", "Zero Token 尚未初始化"));
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await Promise.all(ZERO_TOKEN_PROVIDERS.map(async (provider) => {
      const loggedIn = await this.sessionManager.checkLogin(provider.id);
      void logElectronSessionSource(
        "ZeroToken Runtime Session",
        this.browserManager.getSession(provider.id),
        provider.partition,
      ).catch((error) => {
        console.warn("[ZeroToken Runtime Session] diagnostic failed", error);
      });
      this.setStatus(provider.id, loggedIn ? "ready" : "login_required", loggedIn ? "已恢复登录 Session" : "需要网页登录");
    }));
  }

  async login(provider: ZeroTokenProviderId): Promise<ZeroTokenProviderStatus> {
    await this.initialize();
    const existing = this.loginPromises.get(provider);
    if (existing) return existing;

    const promise = this.loginInternal(provider).finally(() => {
      this.loginPromises.delete(provider);
    });
    this.loginPromises.set(provider, promise);
    return promise;
  }

  async logout(provider: ZeroTokenProviderId): Promise<ZeroTokenProviderStatus> {
    await this.initialize();
    try {
      await this.sessionManager.logout(provider);
      this.browserManager.close(provider);
      return this.setStatus(provider, "login_required", "已退出登录，需要重新网页登录");
    } catch (error) {
      return this.setError(provider, error);
    }
  }

  async stop(provider: ZeroTokenProviderId): Promise<ZeroTokenProviderStatus> {
    await this.initialize();
    try {
      this.browserManager.close(provider);
      return this.setStatus(provider, "stopped", "Zero Token 已停止");
    } catch (error) {
      return this.setError(provider, error);
    }
  }

  async getStatus(provider: ZeroTokenProviderId): Promise<ZeroTokenProviderStatus> {
    await this.initialize();
    const status = this.statuses.get(provider);
    if (status?.status === "logging_in") return { ...status };
    try {
      const loggedIn = await this.sessionManager.checkLogin(provider);
      return this.setStatus(provider, loggedIn ? "ready" : "login_required", loggedIn ? "已连接" : "未登录");
    } catch (error) {
      return this.setError(provider, error);
    }
  }

  getAvailableProviders() {
    return ZERO_TOKEN_PROVIDERS.map((provider) => ({ ...provider }));
  }

  subscribe(listener: (status: ZeroTokenProviderStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  openLoginWindow(provider: ZeroTokenProviderId): ZeroTokenProviderStatus {
    if (!this.initialized) throw new Error("Zero Token Runtime 尚未初始化");
    this.browserManager.show(provider);
    return this.setStatus(provider, "logging_in", `正在等待 ${getZeroTokenProvider(provider).name} 登录`);
  }

  dispose(): void {
    this.browserManager.dispose();
    this.initialized = false;
    for (const provider of ZERO_TOKEN_PROVIDERS) {
      this.setStatus(provider.id, "stopped", "Zero Token 已停止");
    }
  }

  private async loginInternal(provider: ZeroTokenProviderId): Promise<ZeroTokenProviderStatus> {
    this.openLoginWindow(provider);
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
      const loginWindow = this.browserManager.getWindow(provider);
      if (!loginWindow) return this.setStatus(provider, "login_required", "登录窗口已关闭");
      if (await this.sessionManager.checkLogin(provider)) {
        return this.setStatus(provider, "ready", "已连接，Session 已由 Electron 持久化");
      }
      await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    }
    return this.setStatus(provider, "login_required", "登录等待超时，请重新点击网页登录");
  }

  private createStatus(provider: ZeroTokenProviderId, status: ZeroTokenStatus, detail: string): ZeroTokenProviderStatus {
    const definition = getZeroTokenProvider(provider);
    return { provider, name: definition.name, status, detail, lastError: null, updatedAt: Date.now() };
  }

  private setStatus(provider: ZeroTokenProviderId, status: ZeroTokenStatus, detail: string): ZeroTokenProviderStatus {
    const next = { ...this.createStatus(provider, status, detail), lastError: null };
    this.statuses.set(provider, next);
    for (const listener of this.listeners) listener({ ...next });
    return { ...next };
  }

  private setError(provider: ZeroTokenProviderId, error: unknown): ZeroTokenProviderStatus {
    const message = error instanceof Error ? error.message : String(error);
    const next = { ...this.createStatus(provider, "error", message), lastError: message };
    this.statuses.set(provider, next);
    for (const listener of this.listeners) listener({ ...next });
    return { ...next };
  }
}
