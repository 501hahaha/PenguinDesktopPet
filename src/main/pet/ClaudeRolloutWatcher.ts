import { createHash } from "node:crypto";
import { createReadStream, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type {
  AgentExternalEvent,
  AgentExternalLifecycle,
  AgentExternalSurface,
  AgentTaskActivity,
} from "./perceptionTypes";

const DEFAULT_SCAN_INTERVAL_MS = 1_500;
const MAX_TRACKED_EVENTS = 2_048;
const MAX_HISTORY_BYTES = 256 * 1024;
const ACTIVE_TASK_MAX_AGE_MS = 30 * 60 * 1_000;

type ClaudeMeta = {
  sessionId: string;
  taskId: string;
  workspaceLabel?: string;
  workspaceId?: string;
  endpointId?: string;
  hostId?: string;
  displayName: string;
};

type TrackedFile = {
  offset: number;
  pending: string;
  meta: ClaudeMeta | null;
  active: AgentExternalEvent | null;
};

export interface ClaudeRolloutWatcherOptions {
  onEvent: (event: AgentExternalEvent) => void;
  projectsDir?: string;
  scanIntervalMs?: number;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string {
  return values.map(asString).find(Boolean) ?? "";
}

function isClaudeVsCodeRecord(record: Record<string, unknown>): boolean {
  const entrypoint = firstString(record.entrypoint, record.source, record.message && recordObject(record.message)?.entrypoint).toLowerCase();
  return entrypoint === "claude-vscode" || entrypoint === "claude_vscode";
}

function workspaceLabelForCwd(cwd: string): string | undefined {
  const normalized = cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const label = normalized.split("/").at(-1)?.trim();
  return label && label !== "." ? label.slice(0, 80) : undefined;
}

function metaForRecord(record: Record<string, unknown>, previous: ClaudeMeta | null): ClaudeMeta | null {
  if (!isClaudeVsCodeRecord(record)) return previous;
  const message = recordObject(record.message);
  const sessionId = firstString(record.sessionId, record.session_id, message?.sessionId, message?.session_id, previous?.sessionId);
  if (!sessionId) return previous;
  const promptId = firstString(record.promptId, record.prompt_id, message?.promptId, message?.prompt_id);
  const cwd = firstString(record.cwd, message?.cwd, previous?.workspaceLabel);
  const workspaceLabel = workspaceLabelForCwd(cwd) ?? previous?.workspaceLabel;
  const workspaceId = firstString(record.workspaceId, record.workspace_id, message?.workspaceId, message?.workspace_id, previous?.workspaceId) || undefined;
  const endpointId = firstString(record.endpointId, record.endpoint_id, message?.endpointId, message?.endpoint_id, previous?.endpointId)
    || `vscode:claude:${createHash("sha256").update(workspaceId ?? workspaceLabel ?? "default").digest("hex").slice(0, 20)}`;
  const hostId = firstString(record.hostId, record.host_id, message?.hostId, message?.host_id, previous?.hostId) || process.env.COMPUTERNAME || process.env.HOSTNAME || "local";
  // `promptId` is present in current Claude VS Code records. Older records
  // may omit it, but user records still carry a per-turn uuid/timestamp. Do
  // not reuse the previous task id across a new user prompt: doing so merges a
  // stopped turn with the next turn and makes processing reappear after stop.
  const promptBoundary = isClaudeUserPromptRecord(record);
  const taskId = promptId
    || (promptBoundary ? firstString(record.uuid, record.id, record.messageId, message?.id, record.timestamp) : "")
    || previous?.taskId
    || sessionId;
  return {
    sessionId,
    taskId,
    workspaceLabel,
    workspaceId,
    endpointId,
    hostId,
    displayName: "Claude VS Code",
  };
}

function eventTimestamp(record: Record<string, unknown>): string {
  const raw = firstString(record.timestamp, record.createdAt, record.created_at);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function eventId(meta: ClaudeMeta, marker: string, lifecycle: AgentExternalLifecycle): string {
  return createHash("sha256").update(`claude-vscode:${meta.sessionId}:${meta.taskId}:${lifecycle}:${marker}`).digest("hex").slice(0, 48);
}

function isClaudeUserPromptRecord(record: Record<string, unknown>): boolean {
  if (firstString(record.type).toLowerCase() !== "user") return false;
  const message = recordObject(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const blocks = content.map(recordObject).filter((block): block is Record<string, unknown> => Boolean(block));
  // Tool results are also stored as `user` records. They belong to the
  // current turn and must not close it or create another processing task.
  if (blocks.some((block) => firstString(block.type).toLowerCase() === "tool_result")) return false;
  return true;
}

function activityForTool(name: string): AgentTaskActivity {
  const normalized = name.toLowerCase();
  if (/(?:shell|bash|powershell|terminal|command|exec|run)/.test(normalized)) return "command";
  if (/(?:edit|write|patch|replace|notebook)/.test(normalized)) return "editing";
  if (/(?:web|search|browser|fetch|http|network)/.test(normalized)) return "network";
  return "tool";
}

function eventForRecord(record: Record<string, unknown>, meta: ClaudeMeta): AgentExternalEvent | null {
  const type = firstString(record.type).toLowerCase();
  const subtype = firstString(record.subtype, record.event, record.hook_event_name).toLowerCase();
  const message = recordObject(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const blocks = content.map(recordObject).filter((block): block is Record<string, unknown> => Boolean(block));
  const toolBlock = blocks.find((block) => firstString(block.type).toLowerCase() === "tool_use");
  const hasToolResult = blocks.some((block) => firstString(block.type).toLowerCase() === "tool_result");
  const hasThinking = blocks.some((block) => firstString(block.type).toLowerCase() === "thinking");
  const hasText = blocks.some((block) => firstString(block.type).toLowerCase() === "text");
  const stopReason = firstString(record.stop_reason, message?.stop_reason).toLowerCase();
  const toolDenialKind = firstString(record.toolDenialKind, record.tool_denial_kind).toLowerCase();
  const error = recordObject(record.error);
  const errorSignal = [
    firstString(record.errorCode, record.error_code, error?.code),
    firstString(error?.message, error?.formatted),
  ].filter(Boolean).join(" ").toLowerCase();
  const stopSignal = [stopReason, subtype, toolDenialKind]
    .filter(Boolean)
    .join(" ");
  const stoppedByUser = /(?:user-rejected|user_rejected|cancel|cancell|abort|interrupt|stop|terminate|killed)/.test(stopSignal);
  const apiError = type === "system" && subtype === "api_error";
  // VS Code Claude records a user pressing Stop as an API connection reset in
  // some versions. Treat that reset as a stop, while keeping other API errors
  // as real failures.
  const apiErrorWasStopped = /(?:cancel|cancell|abort|interrupt|stop|terminate|killed|econnreset|connection\s+reset|request\s+cancel)/.test(errorSignal);
  const finalText = type === "assistant"
    && hasText
    && !toolBlock
    && !hasToolResult
    && !hasThinking
    && ["end_turn", "stop_sequence", "stop", "complete", "completed"].includes(stopReason);
  let lifecycle: AgentExternalLifecycle | null = null;
  let activity: AgentTaskActivity | undefined;
  if (stoppedByUser) {
    lifecycle = /(?:cancel|cancell)/.test(stopSignal) ? "cancelled" : "stopped";
  } else if (apiError) {
    lifecycle = apiErrorWasStopped ? "stopped" : "failed";
  } else if (type === "result" || type === "completion" || finalText || (type === "system" && /(?:stop|end|complete|done|success|finish)/.test(subtype))) {
    lifecycle = "completed";
  } else if (toolBlock) {
    lifecycle = "running";
    activity = activityForTool(firstString(toolBlock.name));
  } else if (hasToolResult) {
    lifecycle = "running";
    activity = "tool";
  } else if (type === "user") {
    lifecycle = "starting";
    activity = "starting";
  } else if (hasThinking) {
    lifecycle = "planning";
    activity = "thinking";
  } else if (hasText || type === "progress" || type === "tool_result") {
    lifecycle = "running";
    activity = type === "progress" ? "tool" : "response-ready";
  }
  if (!lifecycle) return null;
  const marker = firstString(record.uuid, record.id, record.messageId, message?.id, record.timestamp) || `${type}:${lifecycle}`;
  const detail = lifecycle === "completed"
    ? "Claude · VS Code 任务已完成"
    : lifecycle === "failed"
      ? "Claude · VS Code 任务失败"
    : lifecycle === "cancelled"
      ? "Claude · VS Code 任务已取消"
      : lifecycle === "stopped"
        ? "Claude · VS Code 任务已停止"
    : activity === "editing"
      ? "Claude · VS Code 正在编辑文件"
      : activity === "command"
        ? "Claude · VS Code 正在执行命令"
        : activity === "tool" || activity === "network"
          ? "Claude · VS Code 正在调用工具"
          : lifecycle === "planning"
            ? "Claude · VS Code 正在分析与规划"
            : "Claude · VS Code 正在处理任务";
  return {
    source: "claude-hook",
    surface: "vscode",
    lifecycle,
    eventId: eventId(meta, marker, lifecycle),
    endpointId: meta.endpointId,
    hostId: meta.hostId,
    workspaceId: meta.workspaceId,
    workspaceLabel: meta.workspaceLabel,
    sessionId: meta.sessionId,
    taskId: meta.taskId,
    agentId: "claude-vscode",
    displayName: meta.displayName,
    activity,
    detail,
    occurredAt: eventTimestamp(record),
  };
}

export class ClaudeRolloutWatcher {
  private readonly projectsDir: string;
  private readonly scanIntervalMs: number;
  private readonly files = new Map<string, TrackedFile>();
  private readonly seenEvents = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private running = false;
  private scanInFlight = false;
  private scanAgain = false;
  private initialScan = true;
  private startedAtMs = 0;

  constructor(private readonly options: ClaudeRolloutWatcherOptions) {
    this.projectsDir = resolve(options.projectsDir ?? join(homedir(), ".claude", "projects"));
    this.scanIntervalMs = Math.max(500, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  }

  get directory(): string {
    return this.projectsDir;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.initialScan = true;
    this.startedAtMs = Date.now();
    console.info(`[ClaudeRolloutWatcher] watching ${this.projectsDir}`);
    this.timer = setInterval(() => void this.scan(), this.scanIntervalMs);
    this.attachWatcher();
    void this.scan();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    this.files.clear();
    this.seenEvents.clear();
    this.scanInFlight = false;
    this.scanAgain = false;
    this.initialScan = true;
    this.startedAtMs = 0;
  }

  private attachWatcher(): void {
    try {
      this.watcher = watch(this.projectsDir, { recursive: true }, () => void this.scan());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // The interval scan remains active when the directory is not created yet.
    }
  }

  private async scan(): Promise<void> {
    if (!this.running) return;
    if (this.scanInFlight) {
      this.scanAgain = true;
      return;
    }
    this.scanInFlight = true;
    try {
      const files = await this.findFiles();
      const activeFiles = new Set(files);
      for (const file of this.files.keys()) if (!activeFiles.has(file)) this.files.delete(file);
      for (const file of files) await this.processFile(file);
      if (this.initialScan) {
        this.initialScan = false;
        const now = Date.now();
        for (const state of this.files.values()) {
          const event = state.active;
          const occurredAt = event ? Date.parse(event.occurredAt ?? "") : NaN;
          if (event && Number.isFinite(occurredAt) && now - occurredAt <= ACTIVE_TASK_MAX_AGE_MS) this.options.onEvent(event);
        }
      }
    } finally {
      this.scanInFlight = false;
      if (this.scanAgain) {
        this.scanAgain = false;
        void this.scan();
      }
    }
  }

  private async findFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.projectsDir, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
        .filter((file) => {
          const rel = relative(this.projectsDir, resolve(file));
          return rel && !rel.startsWith("..") && !resolve(file).includes("\0");
        });
    } catch {
      return [];
    }
  }

  private async processFile(file: string): Promise<void> {
    let stat;
    try { stat = await fs.stat(file); } catch { return; }
    if (!stat.isFile()) return;
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, pending: "", meta: null, active: null };
      this.files.set(file, state);
      if (this.initialScan && stat.size > 0) {
        const start = Math.max(0, stat.size - MAX_HISTORY_BYTES);
        await this.readRange(file, state, start, stat.size, false);
        state.offset = stat.size;
      } else if (stat.birthtimeMs >= this.startedAtMs) {
        await this.readRange(file, state, 0, stat.size, true);
      } else {
        state.offset = stat.size;
      }
      return;
    }
    if (stat.size < state.offset) {
      state.offset = 0;
      state.pending = "";
    }
    if (stat.size > state.offset) await this.readRange(file, state, state.offset, stat.size, true);
  }

  private async readRange(file: string, state: TrackedFile, start: number, end: number, emit: boolean): Promise<void> {
    try {
      const stream = createReadStream(file, { start, end: Math.max(start, end - 1), encoding: "utf8" });
      let text = "";
      for await (const chunk of stream) text += String(chunk);
      state.offset = end;
      const lines = `${state.pending}${text}`.split(/\r?\n/);
      state.pending = lines.pop() ?? "";
      for (const line of lines) this.handleLine(state, line, emit);
    } catch {
      // Claude may be appending while the file is read; the next scan retries.
    }
  }

  private handleLine(state: TrackedFile, line: string, emit: boolean): void {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const record = recordObject(raw);
    if (!record) return;
    // Claude's terminal `result` record commonly omits entrypoint. Once this
    // file has been positively identified as a VS Code Claude session, keep
    // consuming lifecycle records from the same transcript.
    if (!isClaudeVsCodeRecord(record) && !state.meta) return;
    const previousMeta = state.meta;
    const previousActive = state.active;
    const nextMeta = metaForRecord(record, previousMeta);
    if (!nextMeta) return;
    const promptBoundary = isClaudeUserPromptRecord(record);

    // Claude's JSONL transcript does not always contain an explicit stop
    // record. A new user prompt is nevertheless an unambiguous turn boundary:
    // close the old turn before exposing the new one, otherwise both remain
    // visible as processing tasks.
    if (emit && previousActive && promptBoundary) {
      const stoppedEvent: AgentExternalEvent = {
        ...previousActive,
        lifecycle: "stopped",
        eventId: eventId({ ...nextMeta, taskId: previousActive.taskId ?? nextMeta.taskId }, `turn_replaced:${nextMeta.taskId}`, "stopped"),
        activity: undefined,
        detail: "Claude · VS Code 任务已停止",
        occurredAt: eventTimestamp(record),
      };
      console.info(`[ClaudeRolloutWatcher] ${stoppedEvent.lifecycle} activity=unknown`);
      this.options.onEvent(stoppedEvent);
    }
    state.active = previousActive && promptBoundary ? null : state.active;
    state.meta = nextMeta;
    const event = eventForRecord(record, state.meta);
    if (!event) return;
    const key = `${event.sessionId}:${event.taskId}:${event.lifecycle}:${event.eventId}`;
    if (this.seenEvents.has(key)) return;
    this.seenEvents.add(key);
    if (this.seenEvents.size > MAX_TRACKED_EVENTS) {
      const oldest = this.seenEvents.values().next().value;
      if (oldest) this.seenEvents.delete(oldest);
    }
    if (event.lifecycle === "completed" || event.lifecycle === "failed" || event.lifecycle === "cancelled" || event.lifecycle === "stopped") {
      state.active = null;
    } else {
      state.active = event;
    }
    if (emit) {
      console.info(`[ClaudeRolloutWatcher] ${event.lifecycle} activity=${event.activity ?? "unknown"}`);
      this.options.onEvent(event);
    }
  }
}
