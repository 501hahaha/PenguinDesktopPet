import type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEntryType,
  MemoryReviewState,
} from "../agents/orchestrationTypes";
import type { MemoryDecision } from "./memoryTypes";

const VECTOR_SIZE = 32;

export interface MemoryRankResult {
  score: number;
  reviewState: MemoryReviewState;
  importance: number;
  confidence: number;
  type: MemoryEntryType;
  summary: string;
  embedding: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalized(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function hashToken(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokens(value: string): string[] {
  const segments = normalized(value).toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const result: string[] = [];
  for (const segment of segments) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      const chars = Array.from(segment);
      result.push(...chars);
      for (let index = 0; index < chars.length - 1; index += 1) result.push(chars.slice(index, index + 2).join(""));
    } else {
      result.push(segment);
    }
  }
  return result;
}

/** Deterministic, local-only embedding used when no model embedding service is configured. */
export function localMemoryEmbedding(value: string): string {
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  for (const token of tokens(value)) {
    const bucket = hashToken(token) % VECTOR_SIZE;
    vector[bucket] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return JSON.stringify(norm > 0 ? vector.map((item) => Number((item / norm).toFixed(6))) : vector);
}

export function embeddingSimilarity(left: string | undefined, right: string | undefined): number {
  if (!left || !right) return 0;
  try {
    const a = JSON.parse(left) as unknown;
    const b = JSON.parse(right) as unknown;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    return clamp(a.reduce((sum, item, index) => sum + Number(item || 0) * Number(b[index] || 0), 0), 0, 1);
  } catch {
    return 0;
  }
}

/** Small lexical fallback retained for old rows and for duplicate detection. */
export function memoryTextSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

export function memoryTypeForKind(kind: MemoryEntryKind, scope?: string): MemoryEntryType {
  if (kind === "preference") return "preference";
  if (kind === "decision") return "decision";
  if (kind === "project_fact" || scope?.startsWith("project:")) return "project";
  if (kind === "agent_rule" || kind === "workflow") return "skill";
  if (kind === "rule") return "behavior";
  if (kind === "experience") return "temporary";
  return scope === "user" || !scope ? "user_profile" : "knowledge";
}

export function memorySummaryForContent(content: string): string {
  const summary = normalized(content)
    .replace(/^(?:[^:：]{1,24}[:：]\s*)/, "")
    .replace(/[。.!！?？]+$/u, "")
    .trim();
  return summary.slice(0, 180) || normalized(content).slice(0, 180);
}

function baseScore(type: MemoryEntryType, kind: MemoryEntryKind): number {
  if (type === "preference" || type === "decision") return 76;
  if (type === "project" || kind === "rule") return 70;
  if (type === "skill" || type === "behavior") return 68;
  if (type === "user_profile") return 67;
  if (type === "knowledge") return 58;
  return 42;
}

function signalScore(content: string): number {
  let score = 0;
  if (/(?:长期|以后|默认|始终|必须|偏好|习惯|决定|架构|项目|规则|约定|统一|不要|只能)/i.test(content)) score += 8;
  if (/(?:临时|刚刚|现在正在|这次|报错|失败|稍后|今天)/i.test(content)) score -= 18;
  return score;
}

export function rankMemoryDecision(
  decision: MemoryDecision,
  existing: MemoryEntry[] = [],
): MemoryRankResult {
  const content = normalized(decision.content ?? "");
  const kind = decision.kind ?? "fact";
  const type = decision.type ?? memoryTypeForKind(kind, decision.scope);
  const confidence = clamp(Number(decision.confidence ?? 0.75), 0, 1);
  const explicit = decision.reason?.startsWith("explicit") ?? false;
  const embedding = localMemoryEmbedding(content);
  const duplicateSimilarity = existing.reduce((best, entry) => Math.max(
    best,
    embeddingSimilarity(embedding, entry.embedding) || memoryTextSimilarity(content, entry.content),
  ), 0);
  const repeated = duplicateSimilarity >= 0.72 ? 8 : duplicateSimilarity >= 0.45 ? 4 : 0;
  const futureUsefulness = type === "project" || type === "decision" || type === "preference" || type === "skill" ? 8 : 3;
  const explicitBonus = explicit ? 8 : 0;
  const score = Math.round(clamp(
    baseScore(type, kind) + confidence * 13 + signalScore(content) + repeated + futureUsefulness + explicitBonus,
    0,
    100,
  ));
  const reviewState: MemoryReviewState = score >= 90 ? "none" : score >= 60 ? "review" : "none";
  return {
    score,
    reviewState,
    importance: clamp(score / 100, 0, 1),
    confidence,
    type,
    summary: decision.summary?.trim().slice(0, 180) || memorySummaryForContent(content),
    embedding,
  };
}

export default rankMemoryDecision;
