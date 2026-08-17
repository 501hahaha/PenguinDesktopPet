import type {
  BotChannelAdapter,
  BotChannelEvent,
  ChannelActionResult,
  ChannelEventListener,
  ChannelSendResult,
  ChannelStatus,
  OutboundMediaMessage,
  OutboundMessage,
} from "./types";
import { MessageDeduplicator } from "./messageDeduplicator";

const SEND_RETRY_DELAYS_MS = [0, 350, 900] as const;

const CHANNEL_NOT_FOUND = "机器人通道不存在";

export class BotChannelManager {
  private readonly adapters = new Map<string, BotChannelAdapter>();
  private readonly adapterUnsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<ChannelEventListener>();
  private readonly inboundDeduplicator = new MessageDeduplicator();
  private readonly startPromises = new Map<string, Promise<void>>();
  private readonly sendQueues = new Map<string, Promise<void>>();

  register(adapter: BotChannelAdapter): void {
    if (this.adapters.has(adapter.channelId)) {
      throw new Error(`机器人通道已注册：${adapter.channelId}`);
    }

    this.adapters.set(adapter.channelId, adapter);
    this.adapterUnsubscribers.set(adapter.channelId, adapter.subscribe((event) => {
      if (event.type === "message") {
        const messageKey = `${event.message.platform}:${event.message.channelId}:${event.message.id}`;
        if (!this.inboundDeduplicator.shouldProcess(messageKey)) return;
      }
      this.emit(event);
    }));
  }

  unregister(channelId: string): void {
    this.adapterUnsubscribers.get(channelId)?.();
    this.adapterUnsubscribers.delete(channelId);
    this.adapters.delete(channelId);
  }

  getStatus(channelId: string): ChannelStatus | null {
    return this.adapters.get(channelId)?.getStatus() ?? null;
  }

  getStatuses(): ChannelStatus[] {
    return [...this.adapters.values()].map((adapter) => adapter.getStatus());
  }

  async start(channelId: string): Promise<ChannelActionResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return { ok: false, detail: CHANNEL_NOT_FOUND };
    try {
      await this.startOnce(adapter);
      return { ok: true, detail: adapter.getStatus().detail };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(channelId: string): Promise<ChannelActionResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return { ok: false, detail: CHANNEL_NOT_FOUND };
    try {
      await adapter.stop();
      return { ok: true, detail: adapter.getStatus().detail };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async reconnect(channelId: string): Promise<ChannelActionResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return { ok: false, detail: CHANNEL_NOT_FOUND };
    try {
      return await adapter.reconnect();
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(channelId: string, message: OutboundMessage): Promise<boolean> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return false;
    const previous = this.sendQueues.get(channelId) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const queued = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const chain = previous.then(() => queued);
    this.sendQueues.set(channelId, chain);
    try {
      await previous;
      return await this.sendWhenReady(adapter, message);
    } finally {
      resolveQueue();
      if (this.sendQueues.get(channelId) === chain) this.sendQueues.delete(channelId);
    }
  }

  async sendMedia(channelId: string, message: OutboundMediaMessage): Promise<ChannelSendResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return { ok: false, detail: `机器人通道不存在：${channelId}`, retryable: false };
    const previous = this.sendQueues.get(channelId) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const queued = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const chain = previous.then(() => queued);
    this.sendQueues.set(channelId, chain);
    try {
      await previous;
      return await this.sendMediaWhenReady(adapter, message);
    } finally {
      resolveQueue();
      if (this.sendQueues.get(channelId) === chain) this.sendQueues.delete(channelId);
    }
  }

  subscribe(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: BotChannelEvent): void {
    this.emit(event);
  }

  dispose(): void {
    for (const channelId of this.adapters.keys()) this.unregister(channelId);
    this.startPromises.clear();
    this.sendQueues.clear();
    this.inboundDeduplicator.clear();
    this.listeners.clear();
  }

  private async sendWhenReady(adapter: BotChannelAdapter, message: OutboundMessage): Promise<boolean> {
    for (let attempt = 0; attempt < SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = SEND_RETRY_DELAYS_MS[attempt];
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const ready = await this.ensureReady(adapter, attempt > 0);
      if (!ready) continue;
      try {
        if (await adapter.send(message)) return true;
      } catch (error) {
        console.warn(`[BotChannelManager] send failed for ${adapter.channelId}:`, error);
      }
      if (attempt === 0) await this.reconnect(adapter.channelId);
    }
    return false;
  }

  private async sendMediaWhenReady(adapter: BotChannelAdapter, message: OutboundMediaMessage): Promise<ChannelSendResult> {
    let lastResult: ChannelSendResult = { ok: false, detail: "媒体发送失败", retryable: true };
    for (let attempt = 0; attempt < SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = SEND_RETRY_DELAYS_MS[attempt];
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const ready = await this.ensureReady(adapter, attempt > 0);
      if (!ready) {
        lastResult = { ok: false, detail: `${adapter.channelId} 尚未连接`, retryable: true };
        continue;
      }
      try {
        lastResult = await adapter.sendMedia(message);
        if (lastResult.ok || lastResult.retryable === false) return lastResult;
      } catch (error) {
        lastResult = { ok: false, detail: error instanceof Error ? error.message : String(error), retryable: true };
        console.warn(`[BotChannelManager] media send failed for ${adapter.channelId}:`, error);
      }
      if (attempt === 0) await this.reconnect(adapter.channelId);
    }
    return lastResult;
  }

  private async ensureReady(adapter: BotChannelAdapter, reconnect: boolean): Promise<boolean> {
    const status = adapter.getStatus();
    if (status.connected) return true;
    if (status.state === "logged-out") return false;
    try {
      if (reconnect || status.state === "failed" || status.state === "reconnecting") {
        await this.reconnect(adapter.channelId);
      } else {
        await this.startOnce(adapter);
      }
      for (let index = 0; index < 12; index += 1) {
        if (adapter.getStatus().connected) return true;
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
    } catch (error) {
      console.warn(`[BotChannelManager] unable to ready ${adapter.channelId}:`, error);
    }
    return adapter.getStatus().connected;
  }

  private async startOnce(adapter: BotChannelAdapter): Promise<void> {
    const existing = this.startPromises.get(adapter.channelId);
    if (existing) return existing;
    const startPromise = adapter.start().finally(() => this.startPromises.delete(adapter.channelId));
    this.startPromises.set(adapter.channelId, startPromise);
    return startPromise;
  }

  private emit(event: BotChannelEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
