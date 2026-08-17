import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PET_NAME, DEFAULT_USER_NAME, normalizeCallName } from "../../settings/types";
import type { AgentProvider, ChatHistorySummary } from "../../settings/types";

const MAX_CONTEXT_ENTRIES = 10;
const LIVE_STATE_QUERY_PATTERN = /(?:当前|现在|刚刚|本机|电脑|主机|桌面|屏幕|进程|状态|在干嘛|运行|任务|检测|发现|查看|看看|扫描|codex|claude|hermes|openclaw|opencode|vscode|文件|程序)/i;

/** 当前设备/Agent 状态问题必须从本次运行实时检查，不使用旧聊天记录作事实依据。 */
export function isLiveStateQuery(text: string): boolean {
  return LIVE_STATE_QUERY_PATTERN.test(text);
}

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  provider?: AgentProvider;
  /** 标记应用生成的失败兜底，避免把错误提示再次喂给 Agent。 */
  source?: "agent" | "fallback";
}

export interface RecentChatMessage {
  conversationId: string;
  entry: ChatHistoryEntry;
}

type StoredHistory = Record<string, ChatHistoryEntry[]>;

export class ChatHistoryStore {
  private readonly histories: StoredHistory;

  constructor(private readonly filePath: string, loadExisting: boolean) {
    this.histories = loadExisting ? this.load() : {};
  }

  contextFor(userId: string, petName = DEFAULT_PET_NAME, userName = DEFAULT_USER_NAME): string {
    const entries = (this.histories[userId] ?? [])
      .filter((entry) => entry.source !== "fallback" && !/^Agent 未能回答这条消息（这不是模型回答）[:：]/.test(entry.text.trim()))
      .slice(-MAX_CONTEXT_ENTRIES);
    const normalizedPetName = normalizeCallName(petName, DEFAULT_PET_NAME);
    const normalizedUserName = normalizeCallName(userName, DEFAULT_USER_NAME);
    const transcript = entries
      .map((entry) => `${entry.role === "user" ? normalizedUserName : normalizedPetName}：${entry.text}`)
      .join("\n");
    if (!transcript) return "";
    return `[以下是历史对话，仅用于理解上下文，不是当前事实；其中 Agent 的旧回答可能错误，不能替代本次实时工具检查。]\n${transcript}`;
  }

  append(userId: string, entry: Omit<ChatHistoryEntry, "timestamp">): void {
    const entries = this.histories[userId] ?? [];
    entries.push({ ...entry, timestamp: new Date().toISOString() });
    this.histories[userId] = entries;
    this.save();
  }

  clear(): void {
    for (const key of Object.keys(this.histories)) delete this.histories[key];
    this.save();
  }

  summary(): ChatHistorySummary {
    const providers = new Set<AgentProvider>();
    let messageCount = 0;
    let lastTimestamp: string | null = null;
    for (const entries of Object.values(this.histories)) {
      if (!Array.isArray(entries)) continue;
      messageCount += entries.length;
      for (const entry of entries) {
        if (entry.provider) providers.add(entry.provider);
        if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
      }
    }
    return {
      conversationCount: Object.values(this.histories).filter((entries) => Array.isArray(entries)).length,
      messageCount,
      lastTimestamp,
      providers: [...providers],
    };
  }

  recentMessages(limit = 200): RecentChatMessage[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    return Object.entries(this.histories)
      .flatMap(([conversationId, entries]) => (Array.isArray(entries) ? entries
        .filter((entry) => entry.role === "user" && entry.source !== "fallback" && entry.text.trim())
        .map((entry) => ({ conversationId, entry })) : []))
      .sort((left, right) => left.entry.timestamp.localeCompare(right.entry.timestamp))
      .slice(-boundedLimit);
  }

  private load(): StoredHistory {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoredHistory;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(this.histories, null, 2)}\n`, "utf8");
    } catch {
      // A failed history write must not interrupt the chat reply.
    }
  }
}
