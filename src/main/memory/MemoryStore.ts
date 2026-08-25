import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEntryType,
  MemoryEntryOperation,
  MemoryEntrySource,
  MemoryEntryStatus,
  MemoryReviewState,
  MemoryScope,
} from "../agents/orchestrationTypes";
import { normalizeSafeText } from "../agents/orchestrationTypes";
import type { MemoryDecision } from "./memoryTypes";
import { extractMemoryDecisions, isCanonicalMemoryContent, isExplicitRememberRequest } from "./MemoryExtractor";
import {
  embeddingSimilarity,
  localMemoryEmbedding,
  memorySummaryForContent,
  memoryTextSimilarity,
  memoryTypeForKind,
  rankMemoryDecision,
} from "./MemoryRanker";

const MAX_MEMORY_CONTENT_LENGTH = 600;
const MAX_MEMORY_ROWS = 500;
const MAX_CONTEXT_ENTRIES = 12;
const MAX_CANDIDATES = 100;
const MEMORY_OWNER = "primary-user";

export const PRIMARY_MEMORY_OWNER = MEMORY_OWNER;

/** Hash external identities so the database does not store platform user IDs. */
export function memoryOwnerKeyFor(ownerId: string): string {
  const normalized = normalizeSafeText(ownerId, 512);
  if (!normalized || normalized === MEMORY_OWNER) return MEMORY_OWNER;
  return `external-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

export interface MemorySummary {
  approved: number;
  pending: number;
  rejected: number;
  archived: number;
  databaseFilePresent: boolean;
  markdownFileCount: number;
}

export interface MemoryCaptureResult {
  ok: boolean;
  detail: string;
  entry?: MemoryEntry;
  entries?: MemoryEntry[];
}

export interface MemoryReorganizationResult {
  ok: boolean;
  detail: string;
  replaced: boolean;
  created: number;
  removed: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryStoreOptions {
  userDataPath: string;
  ownerKey?: string;
}

type MemoryRow = MemoryEntry & { ownerKey: string };

const MEMORY_KINDS = new Set<MemoryEntryKind>(["preference", "fact", "rule", "experience", "project_fact", "decision", "agent_rule", "workflow"]);
const MEMORY_STATUSES = new Set<MemoryEntryStatus>(["pending", "approved", "rejected", "archived"]);
const MEMORY_TYPES = new Set<MemoryEntryType>(["user_profile", "preference", "project", "decision", "skill", "behavior", "knowledge", "temporary"]);
const MEMORY_REVIEW_STATES = new Set<MemoryReviewState>(["none", "review"]);
const DEFAULT_MEMORY_IMPORTANCE = 0.7;
const DEFAULT_MEMORY_CONFIDENCE = 0.75;

function safeMemoryContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeSafeText(value, MAX_MEMORY_CONTENT_LENGTH);
  if (!normalized || normalized.length < 2) return null;
  if (!isCanonicalMemoryContent(normalized)) return null;
  // Long-term memory must never become a credential or filesystem-path store.
  if (/(?:api[_ -]?key|access[_ -]?key|secret|password|passwd|token|bearer|authorization|private[_ -]?key|sk-[a-z0-9_-]{8,})/i.test(normalized)) return null;
  if (/(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/(?:users|home|root|var|tmp)\/)/i.test(normalized)) return null;
  return normalized;
}

function safeMemoryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
  return normalized || null;
}

function boundedScore(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function boundedRankScore(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : fallback;
}

function memoryTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const tokens = new Set<string>();
  for (const segment of normalized.split(/\s+/).filter(Boolean)) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      const chars = Array.from(segment);
      chars.forEach((char) => tokens.add(char));
      for (let index = 0; index < chars.length - 1; index += 1) tokens.add(chars.slice(index, index + 2).join(""));
    } else {
      tokens.add(segment);
    }
  }
  return tokens;
}

function safeWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value.trim(), "utf8").digest("hex").slice(0, 24);
}

function memoryKindFor(content: string): MemoryEntryKind {
  if (/(?:必须|不要|请勿|以后|规则|总是|只能|禁止)/.test(content)) return "rule";
  if (/(?:喜欢|偏好|习惯|希望|更愿意|风格)/.test(content)) return "preference";
  return "fact";
}

function now(): string {
  return new Date().toISOString();
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const kind = String(row.kind ?? "fact") as MemoryEntryKind;
  const scope = String(row.scope ?? "user") as MemoryScope;
  const content = String(row.content ?? "");
  return {
    id: String(row.id ?? ""),
    scope,
    kind,
    type: MEMORY_TYPES.has(String(row.type) as MemoryEntryType) ? String(row.type) as MemoryEntryType : memoryTypeForKind(kind, scope),
    operation: String(row.operation ?? "add") as MemoryEntryOperation,
    targetId: typeof row.target_id === "string" ? row.target_id : undefined,
    content,
    summary: typeof row.summary === "string" && row.summary.trim() ? row.summary : memorySummaryForContent(content),
    embedding: typeof row.embedding === "string" ? row.embedding : localMemoryEmbedding(content),
    source: String(row.source ?? "system") as MemoryEntrySource,
    status: String(row.status ?? "pending") as MemoryEntryStatus,
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
    taskId: typeof row.task_id === "string" ? row.task_id : undefined,
    importance: boundedScore(row.importance, DEFAULT_MEMORY_IMPORTANCE),
    confidence: boundedScore(row.confidence, DEFAULT_MEMORY_CONFIDENCE),
    rankScore: boundedRankScore(row.rank_score, Math.round(boundedScore(row.importance, DEFAULT_MEMORY_IMPORTANCE) * 100)),
    reviewState: MEMORY_REVIEW_STATES.has(String(row.review_state) as MemoryReviewState) ? String(row.review_state) as MemoryReviewState : "none",
    lastAccessedAt: typeof row.last_accessed_at === "string" ? row.last_accessed_at : undefined,
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : (typeof row.last_accessed_at === "string" ? row.last_accessed_at : undefined),
    accessCount: Number.isFinite(Number(row.access_count)) ? Math.max(0, Number(row.access_count)) : 0,
    createdAt: String(row.created_at ?? now()),
    updatedAt: String(row.updated_at ?? now()),
  };
}

/**
 * Hermes-style durable memory: human-readable Markdown plus a small local FTS5 index.
 * Only bounded, sanitized summaries enter this store; chat transcripts stay elsewhere.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly rootPath: string;
  private readonly workspaceRoot: string;
  private readonly ownerKey: string;
  private readonly listeners = new Set<(summary: MemorySummary) => void>();

  constructor(options: MemoryStoreOptions) {
    this.rootPath = join(options.userDataPath, "memory");
    this.workspaceRoot = join(this.rootPath, "workspace");
    this.ownerKey = options.ownerKey?.trim() || MEMORY_OWNER;
    mkdirSync(this.rootPath, { recursive: true });
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.db = new DatabaseSync(join(this.rootPath, "memory.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'knowledge',
        operation TEXT NOT NULL,
        target_id TEXT,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        embedding TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        review_state TEXT NOT NULL DEFAULT 'none',
        workspace_id TEXT,
        task_id TEXT,
        importance REAL NOT NULL DEFAULT 0.7,
        confidence REAL NOT NULL DEFAULT 0.75,
        rank_score REAL NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        last_used_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_status_owner ON memories(status, owner_key, workspace_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        owner_key UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
    this.ensureColumn("importance", "REAL NOT NULL DEFAULT 0.7");
    this.ensureColumn("confidence", "REAL NOT NULL DEFAULT 0.75");
    this.ensureColumn("type", "TEXT NOT NULL DEFAULT 'knowledge'");
    this.ensureColumn("summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("embedding", "TEXT");
    this.ensureColumn("review_state", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("rank_score", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("last_accessed_at", "TEXT");
    this.ensureColumn("last_used_at", "TEXT");
    this.ensureColumn("access_count", "INTEGER NOT NULL DEFAULT 0");
    this.backfillMetadata();
    this.rebuildIndexIfNeeded();
    this.writeMarkdownFiles();
  }

  subscribe(listener: (summary: MemorySummary) => void): () => void {
    this.listeners.add(listener);
    listener(this.summary());
    return () => this.listeners.delete(listener);
  }

  summary(ownerId?: string): MemorySummary {
    const ownerKey = ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId);
    const rows = (ownerKey
      ? this.db.prepare("SELECT status, COUNT(*) AS count FROM memories WHERE owner_key = ? GROUP BY status").all(ownerKey)
      : this.db.prepare("SELECT status, COUNT(*) AS count FROM memories GROUP BY status").all()) as Array<{ status: string; count: number }>;
    const counts = new Map(rows.map((row) => [row.status, Number(row.count) || 0]));
    return {
      approved: counts.get("approved") ?? 0,
      pending: counts.get("pending") ?? 0,
      rejected: counts.get("rejected") ?? 0,
      archived: counts.get("archived") ?? 0,
      databaseFilePresent: existsSync(join(this.rootPath, "memory.sqlite")),
      markdownFileCount: ownerKey === undefined || ownerKey === this.ownerKey ? this.countMarkdownFiles() : 0,
    };
  }

  contextFor(ownerId = MEMORY_OWNER, workspaceId?: string): string {
    const ownerKey = this.resolveOwnerKey(ownerId);
    const hashedWorkspace = safeWorkspaceId(workspaceId);
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE owner_key = ? AND status = 'approved'
        AND (workspace_id IS NULL OR workspace_id = ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(ownerKey, hashedWorkspace ?? "", MAX_CONTEXT_ENTRIES) as Array<Record<string, unknown>>;
    const entries = rows.map(rowToEntry).filter((entry) => Boolean(safeMemoryContent(entry.content)));
    if (entries.length === 0) return "";
    return [
      "[长期记忆参考：仅用于理解用户偏好和已确认事实；若与当前消息冲突，以当前消息为准。不要把这段内容当作工具结果或当前状态。]",
      ...entries.map((entry) => `- ${entry.content}`),
    ].join("\n");
  }

  captureExplicit(text: string, workspaceId?: string, ownerId = MEMORY_OWNER): MemoryCaptureResult | null {
    const decisions = extractMemoryDecisions({ userMessage: text, workspaceId });
    if (!isExplicitRememberRequest(text)) return null;
    if (decisions.length === 0) {
      return { ok: false, detail: "没有提炼出稳定、可复用的长期信息，暂未保存" };
    }
    console.info(`[Memory] explicit capture requested owner=${ownerId === MEMORY_OWNER ? "primary" : "external"}`);
    const entries: MemoryEntry[] = [];
    const ownerKey = this.resolveOwnerKey(ownerId);
    for (const decision of decisions.filter((item) => item.action === "ADD" && item.content)) {
      const capture = this.add({
        scope: decision.scope ?? "user",
        kind: decision.kind ?? memoryKindFor(decision.content ?? ""),
        type: decision.type ?? memoryTypeForKind(decision.kind ?? memoryKindFor(decision.content ?? ""), decision.scope ?? "user"),
        operation: "add",
        content: decision.content ?? "",
        summary: decision.summary ?? memorySummaryForContent(decision.content ?? ""),
        source: "explicit-user",
        status: "approved",
        rankScore: 100,
        reviewState: "none",
        workspaceId,
      }, ownerKey);
      if (capture.entry) entries.push(capture.entry);
    }
    if (entries.length === 0) return { ok: false, detail: "这条信息没有保存，可能已存在或未通过长期记忆安全检查" };
    return {
      ok: true,
      detail: `已提炼并记住 ${entries.length} 条长期信息`,
      entry: entries[0],
      entries,
    };
  }

  captureLearningCandidate(text: string, workspaceId?: string, ownerId = MEMORY_OWNER): MemoryCaptureResult | null {
    const decision = extractMemoryDecisions({ userMessage: text, workspaceId })
      .find((item) => item.action === "ADD" && item.content);
    if (!decision?.content) return null;
    return this.propose(decision.content, { kind: decision.kind, scope: decision.scope, workspaceId }, ownerId);
  }

  /** Returns all non-rejected entries for the one-time legacy cleanup. */
  maintenanceEntries(): MemoryEntry[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE status IN ('pending', 'approved') ORDER BY updated_at DESC LIMIT ?").all(MAX_MEMORY_ROWS);
    return (rows as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** Replace one legacy entry with distilled candidates, or remove it when none survive extraction. */
  reorganizeEntry(id: string, decisions: MemoryDecision[]): MemoryReorganizationResult {
    const normalizedId = safeMemoryId(id);
    if (!normalizedId) return { ok: false, detail: "记忆编号无效", replaced: false, created: 0, removed: false };
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ? LIMIT 1").get(normalizedId) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, detail: "没有找到这条记忆", replaced: false, created: 0, removed: false };
    const current = rowToEntry(row);
    const ownerKey = String(row.owner_key ?? this.ownerKey);
    const candidates = decisions
      .filter((decision) => decision.action === "ADD" && decision.content)
      .map((decision) => ({
        ...decision,
        scope: decision.scope ?? current.scope,
        kind: decision.kind ?? current.kind,
        workspaceId: decision.workspaceId ?? current.workspaceId,
      }));
    if (candidates.length === 0) {
      const removed = this.removeByOwnerKey(current.id, ownerKey);
      return { ok: removed.ok, detail: removed.detail, replaced: false, created: 0, removed: removed.ok };
    }

    const first = candidates[0];
    const replacement = this.updateEntryByOwnerKey(current.id, ownerKey, {
      content: first.content,
      scope: first.scope,
      kind: first.kind,
      operation: "replace",
      source: current.source === "explicit-user" ? "explicit-user" : current.status === "approved" ? "approved-learning" : "learning-candidate",
      status: current.status,
      workspaceId: first.workspaceId,
      taskId: first.taskId ?? current.taskId,
      importance: first.importance,
      confidence: first.confidence,
    });
    if (!replacement.ok) return { ok: false, detail: replacement.detail, replaced: false, created: 0, removed: false };

    let created = 0;
    for (const decision of candidates.slice(1)) {
      const added = this.add({
        scope: decision.scope ?? current.scope,
        kind: decision.kind ?? current.kind,
        operation: "add",
        content: decision.content ?? "",
        source: current.status === "approved" ? "approved-learning" : "learning-candidate",
        status: current.status,
        workspaceId: decision.workspaceId,
        taskId: decision.taskId ?? current.taskId,
        importance: decision.importance,
        confidence: decision.confidence,
      }, ownerKey);
      if (added.entry) created += 1;
    }
    return { ok: true, detail: `已将一条旧记忆整理为 ${created + 1} 条`, replaced: true, created, removed: false };
  }

  propose(content: string, options: { kind?: MemoryEntryKind; scope?: MemoryScope; workspaceId?: string; taskId?: string } = {}, ownerId = MEMORY_OWNER): MemoryCaptureResult {
    const safeContent = safeMemoryContent(content);
    if (!safeContent) return { ok: false, detail: "这条内容包含敏感信息、路径或无效文本，未写入记忆" };
    return this.applyDecision({
      action: "ADD",
      scope: options.scope ?? "user",
      kind: options.kind ?? memoryKindFor(safeContent),
      content: safeContent,
      workspaceId: options.workspaceId,
      taskId: options.taskId,
      reason: "auto-extractor",
    }, ownerId);
  }

  list(status?: MemoryEntryStatus, ownerId?: string): MemoryEntry[] {
    const ownerKey = ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId);
    const normalizedStatus = status && MEMORY_STATUSES.has(status) ? status : undefined;
    const rows = ownerKey
      ? normalizedStatus
        ? this.db.prepare("SELECT * FROM memories WHERE owner_key = ? AND status = ? ORDER BY updated_at DESC LIMIT ?").all(ownerKey, normalizedStatus, MAX_CANDIDATES)
        : this.db.prepare("SELECT * FROM memories WHERE owner_key = ? ORDER BY updated_at DESC LIMIT ?").all(ownerKey, MAX_CANDIDATES)
      : normalizedStatus
        ? this.db.prepare("SELECT * FROM memories WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(normalizedStatus, MAX_CANDIDATES)
        : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(MAX_CANDIDATES);
    return (rows as Array<Record<string, unknown>>).map(rowToEntry);
  }

  search(query: string, ownerId?: string): MemorySearchResult[] {
    const ownerKey = ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId);
    const terms = query.replace(/[^\p{L}\p{N}_-]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const match = terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" AND ");
    try {
      const rows = ownerKey
        ? this.db.prepare(`
        SELECT m.*, bm25(memory_fts) AS score
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.id
        WHERE memory_fts MATCH ? AND m.owner_key = ?
        ORDER BY score LIMIT ?
      `).all(match, ownerKey, MAX_CANDIDATES) as Array<Record<string, unknown>>
        : this.db.prepare(`
        SELECT m.*, bm25(memory_fts) AS score
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.id
        WHERE memory_fts MATCH ?
        ORDER BY score LIMIT ?
      `).all(match, MAX_CANDIDATES) as Array<Record<string, unknown>>;
      return rows.map((row) => ({ entry: rowToEntry(row), score: Number(row.score) || 0 }));
    } catch {
      return this.list(undefined, ownerId).filter((entry) => terms.every((term) => entry.content.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
        .map((entry) => ({ entry, score: 0 }));
    }
  }

  /** Retrieve only approved memories that are relevant to the current request. */
  retrieve(query: string, options: { ownerId?: string; workspaceId?: string; scopes?: string[]; limit?: number } = {}): MemorySearchResult[] {
    const normalizedQuery = normalizeSafeText(query, 600);
    if (!normalizedQuery) return [];
    const ownerKey = options.ownerId === undefined ? this.ownerKey : this.resolveOwnerKey(options.ownerId);
    const hashedWorkspace = safeWorkspaceId(options.workspaceId);
    const scopes = (options.scopes ?? []).filter(Boolean);
    const limit = Math.max(1, Math.min(12, Math.floor(options.limit ?? 6)));
    const candidates = this.list("approved", options.ownerId ?? MEMORY_OWNER).filter((entry) => {
      if (entry.workspaceId && hashedWorkspace && entry.workspaceId !== hashedWorkspace) return false;
      if (entry.workspaceId && !hashedWorkspace) return false;
      return true;
    });
    const ranked = candidates.map((entry) => {
      const overlap = embeddingSimilarity(localMemoryEmbedding(normalizedQuery), entry.embedding) || memoryTextSimilarity(normalizedQuery, entry.content);
      const scopeMatch = scopes.includes(entry.scope)
        ? 1
        : scopes.some((scope) => entry.scope.startsWith(`${scope}:`))
          ? 0.55
          : 0;
      const ageMs = Math.max(0, Date.now() - Date.parse(entry.updatedAt));
      const recency = Number.isFinite(ageMs) ? Math.max(0, Math.min(1, 1 - ageMs / (1000 * 60 * 60 * 24 * 90))) : 0;
      const rank = (entry.rankScore ?? Math.round((entry.importance ?? DEFAULT_MEMORY_IMPORTANCE) * 100)) / 100;
      const score = overlap * 0.5 + rank * 0.25 + scopeMatch * 0.15 + recency * 0.1;
      return { entry, score, overlap, scopeMatch };
    })
      .filter((item) => item.overlap > 0 || item.scopeMatch > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    const timestamp = now();
    for (const item of ranked) {
      const accessCount = (item.entry.accessCount ?? 0) + 1;
      this.db.prepare("UPDATE memories SET last_accessed_at = ?, last_used_at = ?, access_count = ? WHERE id = ? AND owner_key = ?")
        .run(timestamp, timestamp, accessCount, item.entry.id, ownerKey);
      item.entry.lastAccessedAt = timestamp;
      item.entry.lastUsedAt = timestamp;
      item.entry.accessCount = accessCount;
    }
    return ranked.map(({ entry, score }) => ({ entry, score }));
  }

  /** Apply a structured observer decision without exposing database details to the observer. */
  applyDecision(decision: MemoryDecision, ownerId = MEMORY_OWNER): MemoryCaptureResult {
    const ownerKey = this.resolveOwnerKey(ownerId);
    const action = decision.action;
    if (action === "IGNORE") return { ok: true, detail: "已忽略这条记忆候选" };

    const content = action === "DELETE"
      ? normalizeSafeText(decision.content ?? decision.target ?? "", MAX_MEMORY_CONTENT_LENGTH) || null
      : safeMemoryContent(decision.content ?? decision.target ?? "");
    const candidates = this.list(undefined, ownerId).filter((entry) => {
      if (entry.status !== "pending" && entry.status !== "approved") return false;
      if (decision.scope && entry.scope !== decision.scope) return false;
      if (decision.kind && entry.kind !== decision.kind) return false;
      const workspaceId = safeWorkspaceId(decision.workspaceId);
      return !workspaceId || !entry.workspaceId || entry.workspaceId === workspaceId;
    });
    const targetId = safeMemoryId(decision.targetId);
    const best = content
      ? candidates
        .map((entry) => ({ entry, similarity: embeddingSimilarity(localMemoryEmbedding(content), entry.embedding) || memoryTextSimilarity(content, entry.content) }))
        .sort((left, right) => right.similarity - left.similarity)[0]
      : undefined;
    const exactTarget = targetId ? candidates.find((entry) => entry.id === targetId) : undefined;

    if (action === "DELETE") {
      const target = exactTarget ?? (best && best.similarity >= 0.35 ? best.entry : undefined);
      if (!target) return { ok: false, detail: "没有找到匹配的长期记忆" };
      return this.removeByOwnerKey(target.id, ownerKey);
    }
    if (!content) return { ok: false, detail: "这条记忆内容无效或包含敏感信息，未写入记忆" };

    const scope = decision.scope ?? "user";
    const kind = decision.kind ?? memoryKindFor(content);
    const rank = action === "ADD"
      ? rankMemoryDecision({ ...decision, kind, scope, content }, candidates)
      : null;
    if (rank && rank.score < 60) return { ok: true, detail: "候选记忆评分低于 60，已丢弃" };
    const importance = boundedScore(decision.importance ?? rank?.importance, DEFAULT_MEMORY_IMPORTANCE);
    const confidence = boundedScore(decision.confidence ?? rank?.confidence, DEFAULT_MEMORY_CONFIDENCE);
    const type = decision.type ?? rank?.type ?? memoryTypeForKind(kind, scope);
    const summary = decision.summary ?? rank?.summary ?? memorySummaryForContent(content);
    const embedding = rank?.embedding ?? localMemoryEmbedding(content);
    const rankScore = boundedRankScore(decision.rankScore ?? rank?.score, Math.round(importance * 100));
    const reviewState = decision.reviewState ?? rank?.reviewState ?? (rankScore >= 90 ? "none" : "review");
    if (action === "UPDATE") {
      const target = exactTarget ?? (best && best.similarity >= 0.35 ? best.entry : undefined);
      if (target) {
        return this.updateEntryByOwnerKey(target.id, ownerKey, {
          content,
          scope,
          kind,
          type,
          summary,
          embedding,
          operation: "replace",
          source: "approved-learning",
          status: "approved",
          targetId: decision.targetId ?? target.targetId,
          workspaceId: decision.workspaceId,
          taskId: decision.taskId ?? target.taskId,
          importance,
          confidence,
          rankScore,
          reviewState: "none",
        });
      }
      return this.add({
        scope,
        kind,
        type,
        summary,
        embedding,
        operation: "add",
        content,
        source: "approved-learning",
        status: "approved",
        importance,
        confidence,
        rankScore,
        reviewState: "none",
        workspaceId: decision.workspaceId,
        taskId: decision.taskId,
      }, ownerKey);
    }

    if (best && best.similarity >= 0.9) {
      if (best.entry.status === "pending" && rankScore >= 60) {
        return this.updateEntryByOwnerKey(best.entry.id, ownerKey, { status: "approved", importance, confidence, rankScore, reviewState });
      }
      return { ok: true, detail: best.entry.status === "approved" ? "这条记忆已经存在" : "相同的记忆候选已经在审核队列中", entry: best.entry };
    }
    if (best && best.similarity >= 0.62 && (confidence > (best.entry.confidence ?? 0) || importance > (best.entry.importance ?? 0))) {
      return this.updateEntryByOwnerKey(best.entry.id, ownerKey, {
        content,
        scope,
        kind,
        type,
        summary,
        embedding,
        operation: "replace",
        source: "auto-extractor",
        status: rankScore >= 60 ? "approved" : best.entry.status,
        workspaceId: decision.workspaceId,
        taskId: decision.taskId ?? best.entry.taskId,
        importance,
        confidence,
        rankScore,
        reviewState,
      });
    }
    return this.add({
      scope,
      kind,
      type,
      summary,
      embedding,
      operation: "add",
      content,
      source: rank ? "auto-extractor" : (confidence >= 0.8 && importance >= 0.6 ? "approved-learning" : "learning-candidate"),
      status: rankScore >= 60 ? "approved" : "pending",
      importance,
      confidence,
      rankScore,
      reviewState,
      workspaceId: decision.workspaceId,
      taskId: decision.taskId,
    }, ownerKey);
  }

  captureExplicitForget(text: string, workspaceId?: string, ownerId = MEMORY_OWNER): MemoryCaptureResult | null {
    const normalized = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!/(?:忘记|忘掉|不要记(?:住)?|以后不要记(?:住)?)/.test(normalized)
      && !/(?:删除|移除).*(?:记忆|这条|刚才|上一条|这个)/.test(normalized)) return null;
    const ownerEntries = this.list(undefined, ownerId).filter((entry) => {
      if (entry.status !== "pending" && entry.status !== "approved") return false;
      const hashedWorkspace = safeWorkspaceId(workspaceId);
      return !hashedWorkspace || !entry.workspaceId || entry.workspaceId === hashedWorkspace;
    });
    const latestOnly = /(?:这条|刚才那条|上一条|这个记忆)/.test(normalized);
    const targetText = normalized
      .replace(/^(?:请|麻烦|帮我)?\s*(?:忘记|忘掉|删除)(?:这条|刚才那条|上一条|这个记忆)?\s*/i, "")
      .replace(/^(?:请|麻烦|帮我)?\s*(?:不要记(?:住)?|以后不要记(?:住)?)\s*/i, "")
      .replace(/[：:，,。.!！?？]+$/g, "")
      .trim();
    const target = latestOnly || !targetText
      ? ownerEntries[0]
      : ownerEntries
        .map((entry) => ({ entry, similarity: memoryTextSimilarity(targetText, entry.content) }))
        .sort((left, right) => right.similarity - left.similarity)[0]?.entry;
    if (!target) return { ok: false, detail: "没有找到匹配的长期记忆" };
    return this.removeByOwnerKey(target.id, this.resolveOwnerKey(ownerId));
  }

  approve(id: string, ownerId?: string): MemoryCaptureResult {
    return this.updateStatus(id, "approved", ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId));
  }

  reject(id: string, ownerId?: string): MemoryCaptureResult {
    return this.updateStatus(id, "rejected", ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId));
  }

  remove(id: string, ownerId?: string): MemoryCaptureResult {
    const ownerKey = ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId);
    return this.removeByOwnerKey(id, ownerKey);
  }

  private removeByOwnerKey(id: string, ownerKey?: string): MemoryCaptureResult {
    const normalizedId = safeMemoryId(id);
    if (!normalizedId) return { ok: false, detail: "记忆编号无效" };
    const result = ownerKey
      ? this.db.prepare("DELETE FROM memories WHERE id = ? AND owner_key = ?").run(normalizedId, ownerKey)
      : this.db.prepare("DELETE FROM memories WHERE id = ?").run(normalizedId);
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(normalizedId);
    if (!result.changes) return { ok: false, detail: "未找到这条记忆" };
    if (ownerKey === undefined || ownerKey === this.ownerKey) {
      this.writeMarkdownFiles();
    }
    this.notify();
    return { ok: true, detail: "记忆已删除" };
  }

  clear(ownerId?: string): void {
    const ownerKey = ownerId === undefined ? undefined : this.resolveOwnerKey(ownerId);
    if (ownerKey) {
      this.db.prepare("DELETE FROM memory_fts WHERE id IN (SELECT id FROM memories WHERE owner_key = ?)").run(ownerKey);
      this.db.prepare("DELETE FROM memories WHERE owner_key = ?").run(ownerKey);
    } else {
      this.db.exec("DELETE FROM memory_fts; DELETE FROM memories;");
    }
    if (ownerKey === undefined || ownerKey === this.ownerKey) {
      this.writeMarkdownFiles();
    }
    this.notify();
  }

  close(): void {
    this.db.close();
  }

  /** Add columns introduced by newer memory versions without replacing the user's database. */
  private ensureColumn(column: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE memories ADD COLUMN ${column} ${definition}`);
  }

  private backfillMetadata(): void {
    const rows = this.db.prepare("SELECT id, scope, kind, content, type, summary, embedding, importance, rank_score FROM memories").all() as Array<Record<string, unknown>>;
    const update = this.db.prepare("UPDATE memories SET type = ?, summary = ?, embedding = ?, rank_score = ?, review_state = ? WHERE id = ?");
    for (const row of rows) {
      const content = String(row.content ?? "");
      const kind = String(row.kind ?? "fact") as MemoryEntryKind;
      const scope = String(row.scope ?? "user");
      const existingType = String(row.type ?? "");
      const type = existingType && existingType !== "knowledge"
        ? (MEMORY_TYPES.has(existingType as MemoryEntryType) ? existingType as MemoryEntryType : memoryTypeForKind(kind, scope))
        : memoryTypeForKind(kind, scope);
      const summary = typeof row.summary === "string" && row.summary.trim() ? row.summary : memorySummaryForContent(content);
      const embedding = typeof row.embedding === "string" && row.embedding.trim() ? row.embedding : localMemoryEmbedding(content);
      const importanceScore = Math.round(boundedScore(row.importance, DEFAULT_MEMORY_IMPORTANCE) * 100);
      const storedRankScore = Number(row.rank_score);
      const rankScore = Number.isFinite(storedRankScore) && storedRankScore > 0 ? boundedRankScore(storedRankScore, importanceScore) : importanceScore;
      const reviewState = rankScore >= 90 ? "none" : rankScore >= 60 ? "review" : "none";
      update.run(type, summary, embedding, rankScore, reviewState, String(row.id ?? ""));
    }
  }

  private add(input: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">, ownerKey = this.ownerKey): MemoryCaptureResult {
    const content = safeMemoryContent(input.content);
    if (!content) return { ok: false, detail: "这条内容包含敏感信息、路径或无效文本，未写入记忆" };
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE owner_key = ? AND status != 'rejected'").get(ownerKey) as { count?: number };
    if ((Number(count?.count) || 0) >= MAX_MEMORY_ROWS) return { ok: false, detail: "长期记忆已达到上限，请先清理旧记忆" };
    const duplicate = this.db.prepare("SELECT id, status FROM memories WHERE owner_key = ? AND content = ? AND status IN ('pending', 'approved') LIMIT 1").get(ownerKey, content) as { id?: string; status?: string } | undefined;
    if (duplicate?.id) {
      console.info(`[Memory] save skipped reason=duplicate status=${duplicate.status ?? "unknown"}`);
      return { ok: true, detail: duplicate.status === "approved" ? "这条记忆已经存在" : "相同的记忆候选已经在审核队列中" };
    }
    console.info(`[Memory] saving memory kind=${input.kind} scope=${input.scope} status=${input.status}`);
    const timestamp = now();
    const id = `mem_${createHash("sha256").update(`${ownerKey}:${timestamp}:${content}`).digest("hex").slice(0, 20)}`;
    const entry: MemoryEntry = {
      ...input,
      id,
      content,
      workspaceId: safeWorkspaceId(input.workspaceId),
      targetId: safeMemoryId(input.targetId) ?? undefined,
      taskId: safeMemoryId(input.taskId) ?? undefined,
      type: input.type ?? memoryTypeForKind(input.kind, input.scope),
      summary: input.summary?.trim().slice(0, 180) || memorySummaryForContent(content),
      embedding: input.embedding || localMemoryEmbedding(content),
      importance: boundedScore(input.importance, DEFAULT_MEMORY_IMPORTANCE),
      confidence: boundedScore(input.confidence, DEFAULT_MEMORY_CONFIDENCE),
      rankScore: boundedRankScore(input.rankScore, Math.round(boundedScore(input.importance, DEFAULT_MEMORY_IMPORTANCE) * 100)),
      reviewState: input.reviewState ?? "none",
      accessCount: Math.max(0, Math.floor(Number(input.accessCount) || 0)),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`
      INSERT INTO memories (id, owner_key, scope, kind, type, operation, target_id, content, summary, embedding, source, status, review_state, workspace_id, task_id, importance, confidence, rank_score, last_accessed_at, last_used_at, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, ownerKey, entry.scope, entry.kind, entry.type ?? memoryTypeForKind(entry.kind, entry.scope), entry.operation, entry.targetId ?? null, entry.content, entry.summary ?? memorySummaryForContent(entry.content), entry.embedding ?? localMemoryEmbedding(entry.content), entry.source, entry.status, entry.reviewState ?? "none", entry.workspaceId ?? null, entry.taskId ?? null, entry.importance ?? DEFAULT_MEMORY_IMPORTANCE, entry.confidence ?? DEFAULT_MEMORY_CONFIDENCE, entry.rankScore ?? 0, entry.lastAccessedAt ?? null, entry.lastUsedAt ?? null, entry.accessCount ?? 0, entry.createdAt, entry.updatedAt);
    this.db.prepare("INSERT INTO memory_fts (id, owner_key, content) VALUES (?, ?, ?)").run(entry.id, ownerKey, entry.content);
    if (ownerKey === this.ownerKey) this.writeMarkdownFiles();
    this.notify();
    console.info(`[Memory] memory saved memoryId=${entry.id} status=${entry.status}`);
    return { ok: true, detail: entry.status === "pending" ? "已生成一条待审核记忆" : "我记住了这条信息", entry };
  }

  private updateStatus(id: string, status: MemoryEntryStatus, ownerKey?: string): MemoryCaptureResult {
    const normalizedId = safeMemoryId(id);
    if (!normalizedId) return { ok: false, detail: "记忆编号无效" };
    const timestamp = now();
    const result = ownerKey
      ? this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND owner_key = ?").run(status, timestamp, normalizedId, ownerKey)
      : this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, normalizedId);
    if (!result.changes) return { ok: false, detail: "未找到这条记忆" };
    if (ownerKey === undefined || ownerKey === this.ownerKey) {
      this.writeMarkdownFiles();
    }
    this.notify();
    return { ok: true, detail: status === "approved" ? "记忆已批准并会参与后续对话" : "记忆候选已拒绝" };
  }

  private updateEntryByOwnerKey(
    id: string,
    ownerKey: string,
    patch: Partial<Pick<MemoryEntry, "scope" | "kind" | "type" | "operation" | "targetId" | "content" | "summary" | "embedding" | "source" | "status" | "reviewState" | "workspaceId" | "taskId" | "importance" | "confidence" | "rankScore">>,
  ): MemoryCaptureResult {
    const normalizedId = safeMemoryId(id);
    if (!normalizedId) return { ok: false, detail: "记忆编号无效" };
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND owner_key = ? LIMIT 1").get(normalizedId, ownerKey) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, detail: "没有找到这条记忆" };
    const current = rowToEntry(row);
    const content = safeMemoryContent(patch.content ?? current.content);
    if (!content) return { ok: false, detail: "这条记忆内容无效或包含敏感信息，未写入记忆" };
    const timestamp = now();
    const next: MemoryEntry = {
      ...current,
      ...patch,
      id: current.id,
      content,
      type: patch.type ?? current.type ?? memoryTypeForKind(patch.kind ?? current.kind, patch.scope ?? current.scope),
      summary: patch.summary?.trim().slice(0, 180) || current.summary || memorySummaryForContent(content),
      embedding: patch.embedding || current.embedding || localMemoryEmbedding(content),
      targetId: safeMemoryId(patch.targetId ?? current.targetId) ?? undefined,
      workspaceId: patch.workspaceId === undefined ? current.workspaceId : safeWorkspaceId(patch.workspaceId),
      taskId: safeMemoryId(patch.taskId ?? current.taskId) ?? undefined,
      importance: boundedScore(patch.importance ?? current.importance, DEFAULT_MEMORY_IMPORTANCE),
      confidence: boundedScore(patch.confidence ?? current.confidence, DEFAULT_MEMORY_CONFIDENCE),
      rankScore: boundedRankScore(patch.rankScore ?? current.rankScore, Math.round(boundedScore(patch.importance ?? current.importance, DEFAULT_MEMORY_IMPORTANCE) * 100)),
      reviewState: patch.reviewState ?? current.reviewState ?? "none",
      updatedAt: timestamp,
    };
    this.db.prepare(`
      UPDATE memories
      SET scope = ?, kind = ?, type = ?, operation = ?, target_id = ?, content = ?, summary = ?, embedding = ?, source = ?, status = ?, review_state = ?, workspace_id = ?, task_id = ?, importance = ?, confidence = ?, rank_score = ?, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(next.scope, next.kind, next.type ?? memoryTypeForKind(next.kind, next.scope), next.operation, next.targetId ?? null, next.content, next.summary ?? memorySummaryForContent(next.content), next.embedding ?? localMemoryEmbedding(next.content), next.source, next.status, next.reviewState ?? "none", next.workspaceId ?? null, next.taskId ?? null, next.importance ?? DEFAULT_MEMORY_IMPORTANCE, next.confidence ?? DEFAULT_MEMORY_CONFIDENCE, next.rankScore ?? 0, next.updatedAt, normalizedId, ownerKey);
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(normalizedId);
    this.db.prepare("INSERT INTO memory_fts (id, owner_key, content) VALUES (?, ?, ?)").run(normalizedId, ownerKey, next.content);
    if (ownerKey === this.ownerKey) this.writeMarkdownFiles();
    this.notify();
    console.info(`[Memory] memory updated memoryId=${next.id} status=${next.status}`);
    return { ok: true, detail: next.status === "approved" ? "长期记忆已更新" : "已更新记忆候选", entry: next };
  }

  private resolveOwnerKey(ownerId?: string): string {
    const normalized = typeof ownerId === "string" ? normalizeSafeText(ownerId, 512) : "";
    if (!normalized || normalized === MEMORY_OWNER) return this.ownerKey;
    return memoryOwnerKeyFor(normalized);
  }

  private rebuildIndexIfNeeded(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get() as { count?: number };
    const memoryCount = this.db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count?: number };
    if ((Number(count?.count) || 0) === (Number(memoryCount?.count) || 0)) return;
    this.db.exec("DELETE FROM memory_fts");
    const rows = this.db.prepare("SELECT id, owner_key, content FROM memories").all() as Array<{ id: string; owner_key: string; content: string }>;
    const insert = this.db.prepare("INSERT INTO memory_fts (id, owner_key, content) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.id, row.owner_key, row.content);
  }

  private writeMarkdownFiles(): void {
    const approved = this.list("approved", MEMORY_OWNER);
    const pending = this.list("pending", MEMORY_OWNER);
    const render = (title: string, entries: MemoryEntry[]) => [
      `# ${title}`,
      "",
      "<!-- This file is generated from the local memory index. Edit through the desktop pet memory panel. -->",
      "",
      ...(entries.length > 0 ? entries.map((entry) => `- [${entry.type ?? entry.kind}; score=${entry.rankScore ?? Math.round((entry.importance ?? DEFAULT_MEMORY_IMPORTANCE) * 100)}; ${entry.reviewState ?? "none"}] ${entry.summary ?? entry.content}`) : ["- 暂无已确认内容"]),
      "",
    ].join("\n");
    writeFileSync(join(this.rootPath, "USER.md"), render("USER", approved.filter((entry) => entry.scope === "user")), "utf8");
    writeFileSync(join(this.rootPath, "MEMORY.md"), render("MEMORY", approved.filter((entry) => entry.scope !== "user")), "utf8");
    const workspaceGroups = new Map<string, MemoryEntry[]>();
    for (const entry of approved) {
      if (!entry.workspaceId) continue;
      const group = workspaceGroups.get(entry.workspaceId) ?? [];
      group.push(entry);
      workspaceGroups.set(entry.workspaceId, group);
    }
    for (const [workspaceId, entries] of workspaceGroups) {
      const dir = join(this.workspaceRoot, workspaceId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.md"), render("WORKSPACE SUMMARY", entries), "utf8");
      writeFileSync(join(dir, "rules.md"), render("WORKSPACE RULES", entries.filter((entry) => entry.kind === "rule")), "utf8");
    }
    if (pending.length > 0) {
      writeFileSync(join(this.rootPath, "PENDING.md"), render("PENDING MEMORY CANDIDATES", pending), "utf8");
    } else if (existsSync(join(this.rootPath, "PENDING.md"))) {
      unlinkSync(join(this.rootPath, "PENDING.md"));
    }
  }

  private countMarkdownFiles(): number {
    return ["USER.md", "MEMORY.md", "PENDING.md"].reduce((count, name) => count + (existsSync(join(this.rootPath, name)) ? 1 : 0), 0);
  }

  private notify(): void {
    const snapshot = this.summary();
    for (const listener of this.listeners) listener(snapshot);
  }
}
