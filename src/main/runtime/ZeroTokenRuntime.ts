import type { ZeroTokenSettings } from "../../settings/types";
import { WebModelRuntimeManager } from "../agents/WebModelRuntimeManager";
import type { WebModelRuntimeState } from "../agents/WebModelRuntimeTypes";
import type { RuntimeLogEntry, RuntimeProvider } from "./types";

/**
 * Runtime-facing facade for the ZeroToken service. Agent code talks to this
 * contract instead of knowing how WebModel is installed or launched.
 */
export class ZeroTokenRuntime {
  constructor(private readonly manager: WebModelRuntimeManager) {}

  getState(): WebModelRuntimeState {
    return this.manager.getState();
  }

  getProvider(): RuntimeProvider {
    return this.manager.getRuntimeProvider();
  }

  getLogs(): RuntimeLogEntry[] {
    return this.manager.getLogs();
  }

  detect(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    return this.manager.detect(config);
  }

  start(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    return this.manager.start(config);
  }

  stop(): Promise<void> {
    return this.manager.stop();
  }

  restart(config: ZeroTokenSettings): Promise<WebModelRuntimeState> {
    return this.manager.restart(config);
  }

  async healthCheck(config: ZeroTokenSettings): Promise<RuntimeProvider> {
    await this.manager.detect(config);
    return this.manager.getRuntimeProvider();
  }

  async checkLogin(config: ZeroTokenSettings): Promise<RuntimeProvider> {
    await this.manager.detect(config);
    return this.manager.getRuntimeProvider();
  }

  async login(config: ZeroTokenSettings, providerId?: string): Promise<WebModelRuntimeState> {
    const state = await this.manager.ensureRunning(config);
    const provider = providerId?.trim()
      || state.providers.find((item) => !item.authenticated)?.id
      || state.providers[0]?.id;
    if (!provider) return state;
    return this.manager.loginProvider(config, provider);
  }

  async logout(config: ZeroTokenSettings, providerId?: string): Promise<WebModelRuntimeState> {
    const state = await this.manager.ensureRunning(config);
    const provider = providerId?.trim()
      || state.providers.find((item) => item.authenticated)?.id
      || state.providers[0]?.id;
    if (!provider) return state;
    return this.manager.logoutProvider(config, provider);
  }

  getModels(config: ZeroTokenSettings) {
    return this.manager.getModels(config);
  }

  getProviders(config: ZeroTokenSettings) {
    return this.manager.getProviders(config);
  }

  openDashboard(config: ZeroTokenSettings): Promise<string> {
    return this.manager.openDashboard(config);
  }
}
