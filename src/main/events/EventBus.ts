import type { AgentEvent } from "./EventTypes";

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/** Small in-process event fan-out. A listener failure must not stop other listeners. */
export class EventBus {
  private readonly listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result && typeof result.then === "function") {
          void result.catch((error) => {
            console.warn("[EventBus] listener failed.", error);
          });
        }
      } catch (error) {
        console.warn("[EventBus] listener failed.", error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
