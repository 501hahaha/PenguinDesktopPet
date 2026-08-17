import type { MemoryCaptureResult, MemoryStore } from "./MemoryStore";
import { extractMemoryDecisions } from "./MemoryExtractor";
import type { MemoryObserverInput, MemoryObserverResult } from "./memoryTypes";

/**
 * Runs the local extractor after a reply. The observer never sends a second
 * model request and never uses the assistant reply as a memory source.
 */
export class MemoryObserver {
  constructor(private readonly store: MemoryStore) {}

  private logMessageId(input: MemoryObserverInput): string {
    const normalized = typeof input.messageId === "string"
      ? input.messageId.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96)
      : "";
    return normalized || "unknown";
  }

  analyze(input: MemoryObserverInput): MemoryObserverResult {
    return { memories: extractMemoryDecisions(input) };
  }

  process(input: MemoryObserverInput): MemoryObserverResult & { applied: MemoryCaptureResult[] } {
    const messageId = this.logMessageId(input);
    console.info(`[Memory] extraction started messageId=${messageId}`);
    const result = this.analyze(input);
    console.info(`[Memory] extraction result messageId=${messageId} candidates=${result.memories.length}`);
    const applied: MemoryCaptureResult[] = [];
    for (const decision of result.memories) {
      console.info(`[Memory] candidate decision messageId=${messageId} action=${decision.action} kind=${decision.kind ?? "unknown"} scope=${decision.scope ?? "user"} confidence=${decision.confidence ?? "unknown"}`);
      const capture = this.store.applyDecision(decision, input.ownerId);
      applied.push(capture);
      console.info(`[Memory] save result messageId=${messageId} ok=${capture.ok} status=${capture.entry?.status ?? "none"}`);
    }
    return { ...result, applied };
  }
}

export default MemoryObserver;
