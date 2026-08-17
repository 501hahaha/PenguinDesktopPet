import type { EventBus } from "../events/EventBus";
import type { AgentEvent, AgentEventPriority } from "../events/EventTypes";

const MAX_DEDUPLICATED_EVENTS = 512;

export interface NotificationManagerOptions {
  dispatch: (event: AgentEvent) => void | Promise<void>;
}

/**
 * Phase-one notification policy: only terminal task completion events are
 * dispatched. Queueing, merging, persistence, and lower-priority policies are
 * intentionally left for later phases.
 */
export class NotificationManager {
  private readonly seenEventIds = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly eventBus: EventBus, private readonly options: NotificationManagerOptions) {
    this.unsubscribe = eventBus.subscribe((event) => this.handleEvent(event));
  }

  handleEvent(event: AgentEvent): void {
    if (!this.shouldNotify(event)) {
      console.info(`[NotificationManager] not-notified type=${event.type} id=${event.id}`);
      return;
    }
    if (!this.deduplicate(event)) {
      console.info(`[NotificationManager] deduplicated type=${event.type} id=${event.id}`);
      return;
    }
    console.info(`[NotificationManager] dispatching type=${event.type} status=${event.status} priority=${event.priority} id=${event.id}`);
    this.dispatch(this.merge(event));
  }

  shouldNotify(event: AgentEvent): boolean {
    return event.type === "task.completed"
      || event.type === "task.failed"
      || event.type === "task.waiting"
      || event.type === "task.input_required";
  }

  deduplicate(event: AgentEvent): boolean {
    if (this.seenEventIds.has(event.id)) return false;
    this.seenEventIds.set(event.id, event.createdAt);
    while (this.seenEventIds.size > MAX_DEDUPLICATED_EVENTS) {
      const oldestId = this.seenEventIds.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.seenEventIds.delete(oldestId);
    }
    return true;
  }

  merge(event: AgentEvent): AgentEvent {
    return event;
  }

  getPriority(event: AgentEvent): AgentEventPriority {
    return event.priority;
  }

  dispatch(event: AgentEvent): void {
    try {
      const result = this.options.dispatch(event);
      if (result && typeof result.then === "function") {
        void result.catch((error) => {
          console.warn("[NotificationManager] dispatch failed.", error);
        });
      }
    } catch (error) {
      console.warn("[NotificationManager] dispatch failed.", error);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.seenEventIds.clear();
  }
}
