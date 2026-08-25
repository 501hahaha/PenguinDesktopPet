import type { MemoryCaptureResult, MemoryStore } from "./MemoryStore";
import { extractMemoryDecisions } from "./MemoryExtractor";
import { rankMemoryDecision } from "./MemoryRanker";
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
    const existing = this.store.list(undefined, input.ownerId ?? "primary-user");
    for (const decision of result.memories) {
      const rank = decision.action === "ADD" && decision.content
        ? rankMemoryDecision(decision, existing)
        : null;
      const rankedDecision = rank
        ? { ...decision, type: rank.type, summary: rank.summary, rankScore: rank.score, reviewState: rank.reviewState, importance: rank.importance, confidence: rank.confidence }
        : decision;
      console.info(`[Memory] candidate decision messageId=${messageId} action=${rankedDecision.action} type=${rankedDecision.type ?? "unknown"} score=${rank?.score ?? "n/a"} review=${rank?.reviewState ?? "none"}`);
      const capture = rank && rank.score < 60
        ? { ok: true, detail: "候选记忆评分低于 60，已丢弃" }
        : this.store.applyDecision(rankedDecision, input.ownerId);
      applied.push(capture);
      console.info(`[Memory] save result messageId=${messageId} ok=${capture.ok} status=${capture.entry?.status ?? "none"}`);
    }
    return { ...result, applied };
  }
}

export default MemoryObserver;
