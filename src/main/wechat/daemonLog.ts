import { open, type FileHandle } from "node:fs/promises";
import type { WeChatConfig } from "./config";

/**
 * 跟随 cc-weixin daemon 日志（~/.wechat-daemon.log）的增量读取器。
 *
 * 设计背景：cc-weixin daemon 是 iLink getupdates 的唯一轮询者
 * （本机已在运行，PID 见 ~/.wechat-daemon.pid），企鹅接入若再拉 getupdates
 * 会与 daemon 争抢消息游标。因此这里只做日志观察者，把 daemon 已经
 * 收到的消息和发出的回复转成事件。
 */

export type DaemonLine =
  | { kind: "message"; from: string; text: string }
  | { kind: "reply"; to: string; text: string }
  | { kind: "thinking"; detail: string };

export function parseDaemonLine(line: string): DaemonLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 收到消息（首行只有时间与 sender，文本在下一行）
  const messageHead = trimmed.match(/^📩\s*\[?([0-9:.]+)\]?\s*(\S+@\S+)$/);
  if (messageHead) {
    return { kind: "message", from: messageHead[2], text: "" };
  }

  // 收到消息的文本行（紧跟 📩 行之后）
  const thinkingLine = trimmed.match(/^🤔\s*(.+)$/);
  if (thinkingLine) {
    return { kind: "thinking", detail: thinkingLine[1] };
  }

  const textLine = trimmed.match(/^(\S.*)$/);
  if (textLine && !trimmed.startsWith("✅") && !trimmed.startsWith("🤔") && !trimmed.startsWith("⚠️")) {
    return { kind: "message", from: "", text: textLine[1] };
  }

  // 已发送回复
  const replyLine = trimmed.match(/^✅\s+(.+)$/);
  if (replyLine) {
    return { kind: "reply", to: "", text: replyLine[1] };
  }

  return null;
}

export class DaemonLogTailer {
  private handle: FileHandle | null = null;
  private lastPosition = 0;
  private pendingSender = "";

  /** 打开日志并跳到末尾，只观察新事件（不重放历史） */
  async start(logFile: string): Promise<void> {
    try {
      this.handle = await open(logFile, "r");
      this.lastPosition = (await this.handle.stat()).size;
    } catch {
      this.handle = null;
      this.lastPosition = 0;
    }
  }

  /** 读取自上次以来的新增行，返回解析出的事件（日志不存在时返回空） */
  async poll(): Promise<DaemonLine[]> {
    if (!this.handle) return [];

    let size: number;
    try {
      size = (await this.handle.stat()).size;
    } catch {
      return [];
    }

    if (size < this.lastPosition) {
      // 日志被轮转/清空，重置游标
      this.lastPosition = 0;
    }
    if (size === this.lastPosition) {
      return [];
    }

    const buffer = Buffer.alloc(size - this.lastPosition);
    try {
      await this.handle.read(buffer, 0, buffer.length, this.lastPosition);
    } catch {
      return [];
    }
    this.lastPosition = size;

    const events: DaemonLine[] = [];
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (const line of lines) {
      const event = parseDaemonLine(line);
      if (!event) continue;
      if (event.kind === "message" && event.from) {
        this.pendingSender = event.from;
        continue;
      }
      if (event.kind === "message" && event.text) {
        if (this.pendingSender) {
          events.push({ kind: "message", from: this.pendingSender, text: event.text });
          this.pendingSender = "";
        }
        continue;
      }
      events.push(event);
    }
    return events;
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
    }
  }
}
