import type {
  AgentEndpoint,
  AgentEndpointBridgeMessage,
  AgentEndpointCapability,
} from "./orchestrationTypes";

const MAX_ENDPOINTS = 128;
const DEGRADED_AFTER_MS = 45_000;
const OFFLINE_AFTER_MS = 180_000;
const CONNECTION_REFRESH_INTERVAL_MS = 15_000;

export type AgentEndpointBridgeState = "offline" | "listening" | "degraded";

export interface AgentEndpointSnapshot {
  endpoints: AgentEndpoint[];
  bridge: {
    state: AgentEndpointBridgeState;
    endpointPath: string;
    updatedAt: string;
  };
  updatedAt: string;
}

type SnapshotListener = (snapshot: AgentEndpointSnapshot) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function connectionFor(endpoint: AgentEndpoint, now: number): AgentEndpoint["connection"] {
  const lastSeenAt = Date.parse(endpoint.lastSeenAt);
  if (Number.isNaN(lastSeenAt)) return "unknown";
  if (now - lastSeenAt > OFFLINE_AFTER_MS) return "offline";
  if (now - lastSeenAt > DEGRADED_AFTER_MS) return "degraded";
  return endpoint.connection === "discovered" ? "discovered" : "connected";
}

/**
 * L1 Companion Bridge 宿主注册表。
 *
 * 它只保存端点身份、能力和最近心跳，绝不保存插件私有会话、命令参数或凭据。
 * 注册表是内存态，应用重启后需要桥接器重新注册；任务事实仍由事件观察器管理。
 */
export class AgentEndpointRegistry {
  private readonly endpoints = new Map<string, AgentEndpoint>();
  private readonly listeners = new Set<SnapshotListener>();
  private readonly freshnessTimer: ReturnType<typeof setInterval>;
  private bridgeState: AgentEndpointBridgeState = "offline";
  private updatedAt = nowIso();

  constructor(private readonly endpointPath: string) {
    this.freshnessTimer = setInterval(() => this.refreshConnections(), CONNECTION_REFRESH_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.freshnessTimer);
    this.listeners.clear();
  }

  getSnapshot(): AgentEndpointSnapshot {
    const now = Date.now();
    const endpoints = [...this.endpoints.values()]
      .map((endpoint) => ({ ...endpoint, connection: connectionFor(endpoint, now), capabilities: [...endpoint.capabilities] as AgentEndpointCapability[] }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.endpointId.localeCompare(right.endpointId));
    return {
      endpoints: structuredClone(endpoints),
      bridge: {
        state: this.bridgeState,
        endpointPath: this.endpointPath,
        updatedAt: this.updatedAt,
      },
      updatedAt: this.updatedAt,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setBridgeState(state: AgentEndpointBridgeState): void {
    if (this.bridgeState === state) return;
    this.bridgeState = state;
    this.publish();
  }

  private refreshConnections(): void {
    const now = Date.now();
    let changed = false;
    for (const endpoint of this.endpoints.values()) {
      const next = connectionFor(endpoint, now);
      if (endpoint.connection === next) continue;
      endpoint.connection = next;
      changed = true;
    }
    if (changed) this.publish();
  }

  handle(message: AgentEndpointBridgeMessage): void {
    if (message.type === "register") {
      const endpoint: AgentEndpoint = {
        ...message.endpoint,
        connection: "connected",
        source: "event-bridge",
        lastSeenAt: nowIso(),
      };
      if (!this.endpoints.has(endpoint.endpointId) && this.endpoints.size >= MAX_ENDPOINTS) {
        const oldest = [...this.endpoints.values()].sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt))[0];
        if (oldest) this.endpoints.delete(oldest.endpointId);
      }
      this.endpoints.set(endpoint.endpointId, endpoint);
      this.publish();
      return;
    }

    const endpoint = this.endpoints.get(message.endpointId);
    if (!endpoint) return;
    if (message.hostId && message.hostId !== endpoint.hostId) return;
    if (message.type === "unregister") {
      this.endpoints.delete(message.endpointId);
      this.publish();
      return;
    }
    endpoint.lastSeenAt = message.occurredAt;
    endpoint.connection = "connected";
    this.publish();
  }

  private publish(): void {
    this.updatedAt = nowIso();
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn("Agent endpoint snapshot listener failed.", error);
      }
    }
  }
}
