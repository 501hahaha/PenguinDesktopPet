import type { MemorySearchResult, MemoryStore } from "./MemoryStore";
import type { MemoryRetrieveInput } from "./memoryTypes";
import { projectMemoryContext } from "./ProjectMemoryLoader";

/** Selects a small, query-relevant memory slice for each Agent turn. */
export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  search(input: MemoryRetrieveInput): MemorySearchResult[] {
    const scopes = [input.projectScope, input.agentScope, "user", "global"].filter((scope): scope is string => Boolean(scope));
    return this.store.retrieve(input.query, {
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      scopes,
      limit: input.limit ?? 6,
    });
  }

  contextFor(input: MemoryRetrieveInput): string {
    const results = this.search(input);
    const projectContext = projectMemoryContext(input.query, input.workspacePath);
    if (results.length === 0 && !projectContext) return "";
    const memoryContext = results.length > 0 ? [
      "[相关长期记忆：仅用于理解当前请求；如与当前消息冲突，以当前消息为准。不要把这段内容当作工具结果或当前状态。]",
      ...results.map(({ entry, score }, index) => `${index + 1}. [${entry.type ?? entry.kind}; score=${Math.round(score * 100)}] ${entry.summary ?? entry.content}`),
    ].join("\n") : "";
    return [memoryContext, projectContext].filter(Boolean).join("\n\n");
  }
}

export default MemoryRetriever;
