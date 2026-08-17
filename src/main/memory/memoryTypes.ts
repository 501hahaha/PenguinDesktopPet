import type { AgentProvider } from "../../settings/types";
import type { AgentConfig } from "../../agents/types";
import type { MemoryEntryKind, MemoryScope } from "../agents/orchestrationTypes";

export type MemoryDecisionAction = "IGNORE" | "ADD" | "UPDATE" | "DELETE";

export interface MemoryDecision {
  action: MemoryDecisionAction;
  kind?: MemoryEntryKind;
  scope?: MemoryScope;
  content?: string;
  target?: string;
  targetId?: string;
  importance?: number;
  confidence?: number;
  workspaceId?: string;
  taskId?: string;
  reason?: string;
}

export interface MemoryObserverResult {
  memories: MemoryDecision[];
}

export interface MemoryObserverInput {
  userMessage: string;
  assistantMessage?: string;
  messageId?: string;
  taskContext?: string;
  activeAgent?: Pick<AgentConfig, "id" | "displayName" | "provider">;
  currentProject?: string;
  workspaceId?: string;
  ownerId?: string;
  taskId?: string;
  agentProvider?: AgentProvider;
}

export interface MemoryOperationStats {
  scanned: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  pending: number;
  errors: number;
}

export interface MemoryRebuildResult {
  ok: boolean;
  detail: string;
  stats: MemoryOperationStats;
  error?: string;
}

export interface MemoryRetrieveInput {
  query: string;
  ownerId?: string;
  workspaceId?: string;
  projectScope?: string;
  agentScope?: string;
  limit?: number;
}
