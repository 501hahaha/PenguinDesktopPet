import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WeChatEvent } from "./events";

type LogCategory = "connection" | "task" | "error";
type EventLogEntry = { category: LogCategory; detail: string; status?: string; errorCategory?: string };

export class WeChatEventLog {
  constructor(private readonly filePath: string) {}

  record(event: WeChatEvent): void {
    const entry = this.toEntry(event);
    if (!entry) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch {
      // Logging must never interrupt message polling or Agent replies.
    }
  }

  private toEntry(event: WeChatEvent): EventLogEntry | null {
    if (event.type === "connection") {
      return { category: "connection", detail: event.detail, status: event.connected ? "connected" : "disconnected" };
    }
    if (event.type === "agent-status") {
      return { category: "task", detail: event.detail, status: event.status };
    }
    if (event.type === "error") {
      return { category: "error", detail: event.message, errorCategory: event.category };
    }
    return null;
  }
}
