import { createHash } from "node:crypto";
import { createReadStream, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
  AgentExternalEvent,
  AgentExternalLifecycle,
  AgentExternalSurface,
  AgentTaskActivity,
} from "./perceptionTypes";
import { workspaceLabelFromPath } from "./taskNotificationFormatter";

const DEFAULT_SCAN_INTERVAL_MS = 1_500;
const MAX_TRACKED_EVENTS = 2_048;
const HEAD_BYTES = 16 * 1024;
const ACTIVE_TASK_MAX_AGE_MS = 30 * 60 * 1_000;

type RolloutMeta = {
  sessionId: string;
  originator: string;
  source: string;
  surface: AgentExternalSurface;
  displayName: string;
  endpointId?: string;
  hostId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
};

type TrackedFile = {
  offset: number;
  pending: string;
  meta: RolloutMeta | null;
  activeTurnId: string | null;
};

export interface CodexRolloutWatcherOptions {
  onEvent: (event: AgentExternalEvent) => void;
  sessionsDir?: string;
  scanIntervalMs?: number;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function surfaceForMeta(originator: string, source: string): AgentExternalSurface {
  const normalizedOriginator = originator.trim().toLowerCase();
  const normalizedSource = source.trim().toLowerCase();

  // `originator` is the host identity. Current Codex Desktop builds also
  // write `source: vscode`, so source cannot override an explicit Desktop
  // originator. Use source only when the originator is absent/ambiguous.
  if (normalizedOriginator.includes("codex desktop") || normalizedOriginator.includes("codex_desktop") || normalizedOriginator === "desktop") return "desktop";
  if (normalizedOriginator.includes("vscode")
    || normalizedOriginator.includes("vs code")
    || normalizedOriginator.includes("visual studio code")
    || normalizedSource === "vscode") return "vscode";
  return "cli";
}

function displayNameForSurface(surface: AgentExternalSurface): string {
  if (surface === "desktop") return "Codex Desktop";
  if (surface === "vscode") return "Codex · VS Code";
  return "Codex CLI";
}

function metaFromRecord(record: Record<string, unknown>): RolloutMeta | null {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  const sessionId = asString(data.session_id) || asString(data.id);
  if (!sessionId) return null;
  const originator = asString(data.originator);
  const source = asString(data.source);
  const surface = surfaceForMeta(originator, source);
  const hostId = asString(data.host_id) || process.env.COMPUTERNAME || process.env.HOSTNAME || "local";
  const workspaceId = asString(data.workspace_id) || undefined;
  const workspaceLabel = workspaceLabelFromPath(asString(data.workspace_label))
    || workspaceLabelFromPath(asString(data.cwd) || asString(data.working_directory) || asString(data.workspace_path));
  const endpointId = asString(data.endpoint_id)
    || (surface === "vscode" ? `vscode:codex:${createHash("sha256").update(`${originator}:${source}:${workspaceId ?? workspaceLabel ?? "default"}`).digest("hex").slice(0, 20)}` : undefined);
  return {
    sessionId,
    originator,
    source,
    surface,
    displayName: displayNameForSurface(surface),
    endpointId,
    hostId,
    workspaceId,
    workspaceLabel,
  };
}

function eventTimestamp(record: Record<string, unknown>): string | undefined {
  const raw = asString(record.timestamp);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function terminalLifecycleForMetadata(type: string, payload: Record<string, unknown>): AgentExternalLifecycle | null {
  const marker = [
    type,
    asString(payload.status),
    asString(payload.state),
    asString(payload.reason),
    asString(payload.stop_reason),
    asString(payload.stopReason),
    asString(payload.error),
    asString(payload.error_code),
    asString(payload.errorCode),
    asString(payload.failure_reason),
    asString(payload.cancellation_reason),
    asString(payload.cancel_reason),
    payload.cancelled === true ? "cancelled" : "",
    payload.canceled === true ? "canceled" : "",
    payload.aborted === true ? "aborted" : "",
  ].join(" ").toLowerCase();
  if (/(?:cancel|cancell)/.test(marker)) return "cancelled";
  if (/(?:abort|stop|interrupt|killed|kill|terminate)/.test(marker)) return "stopped";
  return null;
}

function lifecycleForEventType(type: string, payload: Record<string, unknown> = {}): AgentExternalLifecycle | null {
  const terminalLifecycle = terminalLifecycleForMetadata(type, payload);
  if (terminalLifecycle) return terminalLifecycle;
  if (["task_started", "agent_reasoning", "agent_message", "mcp_tool_call_end", "web_search_end", "patch_apply_end"].includes(type)) return "running";
  if (type === "task_complete") return "completed";
  if (["task_failed", "task_error", "turn_failed", "turn_error", "turn_aborted", "task_aborted"].includes(type)) return "failed";
  return null;
}

function activityForEventType(type: string, phase = ""): AgentTaskActivity | null {
  if (type === "task_started") return "starting";
  if (type === "agent_reasoning") return "thinking";
  if (type === "agent_message") return phase === "final_answer" ? "response-ready" : "thinking";
  if (type === "web_search_end") return "network";
  if (type === "patch_apply_end") return "editing";
  if (type === "mcp_tool_call_end") return "tool";
  return null;
}

function activityForToolName(name: string): AgentTaskActivity {
  const normalized = name.trim().toLowerCase();
  if (/^(?:exec|shell|command|run)$/.test(normalized)) return "command";
  if (/(?:web|search|browser|fetch|http|network)/.test(normalized)) return "network";
  if (/(?:apply[_-]?patch|edit|write|file[_-]?change)/.test(normalized)) return "editing";
  return "tool";
}

function signalForResponseItem(payload: Record<string, unknown>): { eventType: string; lifecycle: AgentExternalLifecycle; activity: AgentTaskActivity } | null {
  const type = asString(payload.type).toLowerCase();
  const terminalLifecycle = terminalLifecycleForMetadata(type, payload);
  if (terminalLifecycle) {
    return { eventType: `response_item:${type}:${terminalLifecycle}`, lifecycle: terminalLifecycle, activity: "tool" };
  }
  if (type === "reasoning" || type === "plan") return { eventType: `response_item:${type}`, lifecycle: "running", activity: "thinking" };
  if (type === "message") {
    const phase = asString(payload.phase).toLowerCase();
    return { eventType: `response_item:message:${phase || "unknown"}`, lifecycle: "running", activity: phase === "final_answer" ? "response-ready" : "thinking" };
  }
  if (type === "custom_tool_call" || type === "function_call") {
    return { eventType: `response_item:${type}`, lifecycle: "running", activity: activityForToolName(asString(payload.name)) };
  }
  if (type === "custom_tool_call_output" || type === "function_call_output") {
    return { eventType: `response_item:${type}`, lifecycle: "running", activity: "tool" };
  }
  return null;
}

function eventId(sessionId: string, turnId: string, lifecycle: AgentExternalLifecycle, eventType: string, eventMarker: string): string {
  return createHash("sha256").update(`codex-rollout:${sessionId}:${turnId}:${lifecycle}:${eventType}:${eventMarker}`).digest("hex").slice(0, 48);
}

function detailFor(meta: RolloutMeta, lifecycle: AgentExternalLifecycle, eventType: string, activity: AgentTaskActivity | null): string {
  if (eventType === "task_started") return `${meta.displayName} 已接收任务，开始处理`;
  if (eventType === "agent_reasoning") return `${meta.displayName} 正在分析和规划任务`;
  if (eventType === "agent_message") return activity === "response-ready" ? `${meta.displayName} 正在整理最终答复` : `${meta.displayName} 正在整理回复`;
  if (eventType === "web_search_end") return `${meta.displayName} 已完成一次网络检索，继续处理任务`;
  if (eventType === "patch_apply_end") return `${meta.displayName} 已完成一次文件修改，继续处理任务`;
  if (eventType === "mcp_tool_call_end") return `${meta.displayName} 已完成一次工具调用，继续处理任务`;
  if (eventType === "response_item:plan") return `${meta.displayName} 已完成一项规划拆解，继续制定后续步骤`;
  if (eventType === "response_item:reasoning") return `${meta.displayName} 正在分析和规划任务`;
  if (eventType.startsWith("response_item:message:")) return activity === "response-ready" ? `${meta.displayName} 正在整理最终答复` : `${meta.displayName} 正在整理回复`;
  if (eventType === "response_item:custom_tool_call" || eventType === "response_item:function_call") {
    return activity === "command"
      ? `${meta.displayName} 正在执行命令`
      : activity === "network"
        ? `${meta.displayName} 正在访问网络`
        : activity === "editing"
          ? `${meta.displayName} 正在编辑文件`
          : `${meta.displayName} 正在调用工具`;
  }
  if (eventType === "response_item:custom_tool_call_output" || eventType === "response_item:function_call_output") return `${meta.displayName} 已完成工具调用，继续处理任务`;
  if (lifecycle === "running") return `${meta.displayName} 正在处理任务`;
  if (lifecycle === "completed") return `${meta.displayName} 任务已完成`;
  return `${meta.displayName} 任务未正常完成`;
}

/**
 * Watches Codex's local rollout lifecycle records. Codex Desktop does not
 * invoke the CLI `notify` command for its private app-server session, but it
 * does append task lifecycle records to ~/.codex/sessions/*.jsonl.
 *
 * Only session identity, lifecycle fields, bounded phase markers, and the final
 * directory segment derived from cwd are read. Chat text, tool output, prompts,
 * full paths, and last_agent_message are deliberately ignored.
 */
export class CodexRolloutWatcher {
  private readonly sessionsDir: string;
  private readonly scanIntervalMs: number;
  private readonly files = new Map<string, TrackedFile>();
  private readonly seenEvents = new Set<string>();
  private readonly historicalActiveTasks = new Map<string, AgentExternalEvent>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private scanInFlight = false;
  private scanAgain = false;
  private running = false;
  private initialScan = true;
  private startedAtMs = 0;

  constructor(private readonly options: CodexRolloutWatcherOptions) {
    const codexHome = (process.env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
    this.sessionsDir = resolve(options.sessionsDir ?? join(codexHome, "sessions"));
    this.scanIntervalMs = Math.max(500, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  }

  get directory(): string {
    return this.sessionsDir;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = Date.now();
    console.info(`[CodexRolloutWatcher] watching ${this.sessionsDir}`);
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
    this.historicalActiveTasks.clear();
    this.scanInFlight = false;
    this.scanAgain = false;
    this.initialScan = true;
    this.startedAtMs = 0;
  }

  private attachWatcher(): void {
    try {
      this.watcher = watch(this.sessionsDir, { recursive: true }, () => void this.scan());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // The interval scan remains active. The directory can be created later.
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
      const files = await this.findRolloutFiles();
      const baselineSizes = this.initialScan ? await this.captureBaselineSizes(files) : new Map<string, number>();
      const active = new Set(files);
      for (const file of this.files.keys()) {
        if (!active.has(file)) this.files.delete(file);
      }
      for (const file of files) await this.processFile(file, baselineSizes.get(file));
      if (this.initialScan) this.emitHistoricalActiveTasks();
      this.initialScan = false;
    } finally {
      this.scanInFlight = false;
      if (this.scanAgain) {
        this.scanAgain = false;
        void this.scan();
      }
    }
  }

  private async captureBaselineSizes(files: string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    await Promise.all(files.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) sizes.set(file, stat.size);
      } catch {
        // The file may be rotated or removed while the initial baseline is collected.
      }
    }));
    return sizes;
  }

  private async findRolloutFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
        .filter((file) => {
          const rel = relative(this.sessionsDir, resolve(file));
          return rel && !rel.startsWith("..") && !resolve(file).includes("\0");
        });
    } catch {
      return [];
    }
  }

  private async processFile(file: string, baselineSize?: number): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return;
    }
    if (!stat.isFile()) return;

    const existing = this.files.get(file);
    if (!existing) {
      const state: TrackedFile = { offset: 0, pending: "", meta: null, activeTurnId: null };
      this.files.set(file, state);
      state.meta = await this.readMeta(file);
      if (baselineSize === undefined) {
        // A file created after startup contains only live events; replay its
        // current contents so a short task cannot disappear between scans.
        if (this.startedAtMs > 0 && stat.birthtimeMs >= this.startedAtMs) {
          await this.readAppended(file, state, stat.size);
        } else {
          // A pre-existing file first observed after startup may contain
          // historical events; establish a tail position without replaying them.
          state.offset = stat.size;
        }
        return;
      }
      const historicalEnd = Math.min(baselineSize, stat.size);
      if (historicalEnd > 0) await this.readHistorical(file, state, historicalEnd);
      state.offset = Math.min(baselineSize, stat.size);
      if (stat.size > state.offset) await this.readAppended(file, state, stat.size);
      return;
    }

    if (stat.size < existing.offset) {
      existing.offset = 0;
      existing.pending = "";
    }
    if (stat.size > existing.offset) await this.readAppended(file, existing, stat.size);
  }

  private async readMeta(file: string): Promise<RolloutMeta | null> {
    try {
      const stream = createReadStream(file, { start: 0, end: HEAD_BYTES - 1, encoding: "utf8" });
      let text = "";
      for await (const chunk of stream) {
        text += String(chunk);
        if (text.includes("\n")) break;
      }
      const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine) return null;
      const record = JSON.parse(firstLine) as unknown;
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      return (record as Record<string, unknown>).type === "session_meta" ? metaFromRecord(record as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async readAppended(file: string, state: TrackedFile, end: number): Promise<void> {
    try {
      const stream = createReadStream(file, { start: state.offset, end: Math.max(state.offset, end - 1), encoding: "utf8" });
      let text = "";
      for await (const chunk of stream) text += String(chunk);
      state.offset = end;
      state.pending += text;
      const lines = state.pending.split(/\r?\n/);
      state.pending = lines.pop() ?? "";
      for (const line of lines) this.handleLine(file, state, line, true);
    } catch {
      // The file may be rotated or temporarily locked while Codex appends.
    }
  }

  private async readHistorical(file: string, state: TrackedFile, end: number): Promise<void> {
    try {
      const stream = createReadStream(file, { start: 0, end: end - 1, encoding: "utf8" });
      let text = "";
      for await (const chunk of stream) text += String(chunk);
      const lines = text.split(/\r?\n/);
      for (const line of lines) this.handleLine(file, state, line, false);
    } catch {
      // The file may be rotated or temporarily locked while Codex appends.
    }
  }

  private handleLine(file: string, state: TrackedFile, line: string, emit: boolean): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    if (record.type === "session_meta") {
      state.meta = metaFromRecord(record);
      return;
    }
    if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return;
    const payload = record.payload as Record<string, unknown>;
    const isEventMessage = record.type === "event_msg";
    const responseSignal = record.type === "response_item" ? signalForResponseItem(payload) : null;
    if (!isEventMessage && !responseSignal) return;
    const eventType = isEventMessage ? asString(payload.type) : responseSignal!.eventType;
    const lifecycle = isEventMessage ? lifecycleForEventType(eventType, payload) : responseSignal!.lifecycle;
    const activity = isEventMessage ? activityForEventType(eventType, asString(payload.phase)) : responseSignal!.activity;
    const payloadTurnId = isEventMessage ? asString(payload.turn_id) : "";
    const turnId = payloadTurnId || state.activeTurnId || "";
    const meta = state.meta;
    if (!meta || !lifecycle || !turnId) return;

    if (eventType === "task_started" && payloadTurnId && state.activeTurnId && state.activeTurnId !== payloadTurnId) {
      // A VS Code task can be force-stopped without a separate abort record. A
      // later task_started is the reliable session boundary in that case; close
      // the previous turn before exposing the new one.
      const previousTurnId = state.activeTurnId;
      const previousEvent: AgentExternalEvent = {
        source: "codex-app-server",
        surface: meta.surface,
        lifecycle: "stopped",
        eventId: eventId(meta.sessionId, previousTurnId, "stopped", "task_replaced", payloadTurnId),
        endpointId: meta.endpointId,
        hostId: meta.hostId,
        workspaceId: meta.workspaceId,
        workspaceLabel: meta.workspaceLabel,
        sessionId: meta.sessionId,
        turnId: previousTurnId,
        taskId: previousTurnId,
        agentId: "codex",
        displayName: meta.displayName,
        detail: `${meta.displayName} 任务已停止`,
        occurredAt: eventTimestamp(record),
      };
      const previousTaskKey = `${meta.sessionId}:${previousTurnId}`;
      if (!emit) {
        this.historicalActiveTasks.delete(previousTaskKey);
      } else {
        console.info(`[CodexRolloutWatcher] ${previousEvent.surface} stopped activity=unknown`);
        this.options.onEvent(previousEvent);
      }
    }
    if (eventType === "task_started" && payloadTurnId) state.activeTurnId = payloadTurnId;

    const eventMarker = asString(record.id)
      || asString(payload.id)
      || asString(payload.call_id)
      || asString(record.timestamp)
      || `${eventType}:${this.seenEvents.size}`;
    const key = `${meta.sessionId}:${turnId}:${lifecycle}:${eventType}:${eventMarker}`;
    if (this.seenEvents.has(key)) return;
    this.seenEvents.add(key);
    if (this.seenEvents.size > MAX_TRACKED_EVENTS) {
      const oldest = this.seenEvents.values().next().value;
      if (oldest) this.seenEvents.delete(oldest);
    }

    const event: AgentExternalEvent = {
      source: "codex-app-server",
      surface: meta.surface,
      lifecycle,
      eventId: eventId(meta.sessionId, turnId, lifecycle, eventType, eventMarker),
      endpointId: meta.endpointId,
      hostId: meta.hostId,
      workspaceId: meta.workspaceId,
      workspaceLabel: meta.workspaceLabel,
      sessionId: meta.sessionId,
      turnId,
      taskId: turnId,
      agentId: "codex",
      displayName: meta.displayName,
      activity: activity ?? undefined,
      detail: detailFor(meta, lifecycle, eventType, activity),
      occurredAt: eventTimestamp(record),
    };
    if (!emit) {
      const taskKey = `${meta.sessionId}:${turnId}`;
      if (lifecycle === "running") this.historicalActiveTasks.set(taskKey, event);
      else this.historicalActiveTasks.delete(taskKey);
      if (lifecycle !== "running" && state.activeTurnId === turnId) state.activeTurnId = null;
      return;
    }
    console.info(`[CodexRolloutWatcher] ${event.surface} ${event.lifecycle} activity=${event.activity ?? "unknown"}`);
    this.options.onEvent(event);
    if (lifecycle !== "running" && state.activeTurnId === turnId) {
      state.activeTurnId = null;
    }
  }

  private emitHistoricalActiveTasks(): void {
    const now = Date.now();
    for (const event of this.historicalActiveTasks.values()) {
      const occurredAt = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
      if (Number.isFinite(occurredAt) && now - occurredAt > ACTIVE_TASK_MAX_AGE_MS) continue;
      console.info(`[CodexRolloutWatcher] restoring ${event.surface} ${event.lifecycle}`);
      this.options.onEvent(event);
    }
    this.historicalActiveTasks.clear();
  }
}
