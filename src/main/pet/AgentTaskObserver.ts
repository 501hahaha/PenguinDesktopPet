import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "../../agents/types";
import type { PetSettings } from "../../settings/types";
import type { BotChannelEvent, ChannelAgentStatus } from "../channels/types";
import type { WeChatEvent } from "../wechat/events";
import { agentTaskIdentityKey } from "../agents/orchestrationTypes";
import type { AgentEndpoint } from "../agents/orchestrationTypes";
import { agentTaskRoleForSource } from "./perceptionTypes";
import { workspaceLabelFromPath } from "./taskNotificationFormatter";
import type {
  AgentExternalEvent,
  AgentExternalLifecycle,
  AgentTaskActivity,
  AgentTaskCompletion,
  AgentTaskConfidence,
  AgentTaskObservation,
  AgentTaskRole,
  AgentTaskMatchState,
  AgentTaskSnapshot,
  AgentTaskSource,
  AgentTaskState,
  AgentTaskSurface,
} from "./perceptionTypes";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 8_000;
const FAILURE_BACKOFF_MS = 20_000;
const TERMINAL_TASK_TTL_MS = 60_000;
const EXTERNAL_TASK_INACTIVITY_TTL_MS = 30 * 60 * 1_000;
const EXTERNAL_STARTING_STALE_MS = 2 * 60 * 1_000;
const COMPLETION_DEDUPE_TTL_MS = 60_000;
const MAX_RECENT_COMPLETIONS = 8;
const MAX_PROCESS_OUTPUT = 256 * 1024;

interface ProcessRecord {
  pid: number;
  name: string;
  commandLine: string;
}

interface ProcessAgentMatch {
  agentId: string;
  displayName: string;
  surface: AgentTaskSurface;
  detail: string;
}

interface InternalTask extends AgentTaskObservation {
  terminalAt: number | null;
}

type CompletionListener = (completion: AgentTaskCompletion) => void;
type SnapshotListener = (snapshot: AgentTaskSnapshot) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function safeDetail(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>")
    .replace(/\b(?:bearer|token|api[- ]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/\r?\n+/g, " ")
    .trim()
    .slice(0, 160);
}

function surfaceForConfig(config: AgentConfig): AgentTaskSurface {
  if (config.sourceApp === "claude-desktop") return "desktop";
  if (config.sourceApp === "claude-code" || config.sourceApp === "hermes" || config.provider) return "cli";
  return "internal";
}

function stateForChannelStatus(status: ChannelAgentStatus): AgentTaskState {
  if (status === "completed") return "ready";
  if (status === "failed") return "blocked";
  if (status === "waiting") return "needs-input";
  return "running";
}

function activityForChannelStatus(status: ChannelAgentStatus): AgentTaskActivity | undefined {
  if (status === "starting" || status === "thinking" || status === "tool" || status === "command" || status === "network" || status === "waiting" || status === "response-ready") return status;
  return undefined;
}

/** 外部生命周期 → 任务状态：completed 视为 ready，failed/stopped 视为 blocked（终态）。 */
function stateForExternalLifecycle(lifecycle: AgentExternalLifecycle): AgentTaskState {
  if (lifecycle === "completed") return "ready";
  if (lifecycle === "failed" || lifecycle === "stopped" || lifecycle === "cancelled") return "blocked";
  if (lifecycle === "waiting" || lifecycle === "needs-input") return "needs-input";
  return "running";
}

function isTerminalLifecycle(lifecycle: AgentExternalLifecycle): boolean {
  return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "stopped" || lifecycle === "cancelled";
}

function confidenceForSource(source: AgentTaskSource): AgentTaskConfidence {
  if (source === "app-event" || source === "codex-app-server" || source === "codex-notify" || source === "claude-hook" || source === "manual-test" || source === "delegation" || source === "event-bridge" || source === "gateway") return "event";
  if (source === "process") return "process";
  return "registry";
}

/** 同一外部任务的多条生命周期更新按 Agent/宿主 + 任务>轮次>会话>事件ID 归并。 */
function externalTaskKey(event: AgentExternalEvent): string {
  return agentTaskIdentityKey({
    agentId: event.agentId,
    surface: event.surface,
    hostId: event.hostId ?? event.endpointId,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    taskId: event.taskId,
    turnId: event.turnId,
    reference: event.eventId,
  });
}

function externalTaskReference(value: Pick<AgentExternalEvent, "taskId" | "turnId"> | Pick<AgentTaskObservation, "taskId">): string {
  return value.taskId?.trim() || ("turnId" in value ? value.turnId?.trim() ?? "" : "");
}

/**
 * Codex notify and the rollout watcher can report the same turn through two
 * adapters. Optional host/workspace fields are not allowed to split that
 * turn into two completion notifications; populated conflicting identities
 * still remain separate so concurrent tasks cannot be merged accidentally.
 */
function isSameExternalTask(candidate: AgentTaskObservation, event: AgentExternalEvent): boolean {
  if (candidate.agentId !== event.agentId) return false;
  // A shared agent id (notably `codex`) is used by multiple host surfaces.
  // Surface is part of the task identity; otherwise a Desktop terminal event
  // can close or overwrite a VS Code task, and vice versa.
  if (candidate.surface !== event.surface) return false;
  const candidateReference = externalTaskReference(candidate);
  const eventReference = externalTaskReference(event);
  if (!candidateReference || !eventReference || candidateReference !== eventReference) return false;
  if (candidate.sessionId && event.sessionId && candidate.sessionId !== event.sessionId) return false;
  if (candidate.hostId && event.hostId && candidate.hostId !== event.hostId) return false;
  if (candidate.workspaceId && event.workspaceId && candidate.workspaceId !== event.workspaceId) return false;
  return true;
}

function taskTitleForExternalEvent(event: AgentExternalEvent): string | null {
  const reference = event.taskId || event.turnId;
  return reference ? `任务 ${reference.slice(0, 8)}` : null;
}

function processNameFromCommand(command: string): string {
  const normalized = command.trim().replace(/\\/g, "/");
  return normalized.split("/").at(-1)?.replace(/\.(?:cmd|bat|exe|ps1)$/i, "").toLowerCase() ?? "";
}

function classifyProcess(record: ProcessRecord, configs: AgentConfig[]): ProcessAgentMatch | null {
  const commandLine = `${record.name} ${record.commandLine}`.toLowerCase();
  const name = record.name.toLowerCase();
  const configMatch = configs.find((config) => {
    const configuredName = processNameFromCommand(config.command);
    if (!configuredName) return false;
    if (name === `${configuredName}.exe`) return true;
    const escapedName = configuredName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tokenPattern = new RegExp(`(?:^|[\\s"'\\\\/])${escapedName}(?:\\.cmd|\\.exe)?(?:$|[\\s"'/\\-])`);
    return tokenPattern.test(commandLine);
  });
  if (configMatch) {
    return {
      agentId: configMatch.id,
      displayName: configMatch.displayName,
      surface: surfaceForConfig(configMatch),
      detail: `${configMatch.displayName} 进程已发现，但当前宿主没有公开任务事件；任务完成不可观测`,
    };
  }

  const vscodeAgent = /openai\.codex|codex[_-]?vscode|github\.copilot|claude[-_]?dev|continue[-_]dev/.test(commandLine);
  if ((name === "code.exe" || name === "code-insiders.exe") && vscodeAgent) {
    if (/openai\.codex|codex[_-]?vscode/.test(commandLine)) {
      return { agentId: "external:vscode-codex", displayName: "Codex · VS Code", surface: "vscode", detail: "已发现 VS Code Codex 宿主，但扩展任务事件未接入；任务完成不可观测" };
    }
    if (/github\.copilot/.test(commandLine)) {
      return { agentId: "external:vscode-copilot", displayName: "Copilot · VS Code", surface: "vscode", detail: "已发现 VS Code Copilot 宿主，但扩展任务事件未接入；任务完成不可观测" };
    }
    return { agentId: "external:vscode-agent", displayName: "Agent · VS Code", surface: "vscode", detail: "已发现 VS Code Agent 宿主，但扩展任务事件未接入；任务完成不可观测" };
  }

  if (name === "chatgpt.exe" || /codex[-_ ]?desktop/.test(commandLine)) {
    return { agentId: "external:codex-desktop", displayName: "Codex Desktop", surface: "desktop", detail: "已发现 Codex Desktop 进程，但桌面端任务事件未公开；任务完成不可观测" };
  }
  if (/\bcodex(?:\.cmd|\.exe)?\b/.test(commandLine) && /\b(?:exec|run)\b/.test(commandLine)) {
    return { agentId: "external:codex-cli", displayName: "Codex CLI", surface: "cli", detail: "已发现 Codex CLI 任务进程，但当前任务流未接入；任务完成不可观测" };
  }
  if (/\bclaude(?:\.cmd|\.exe)?\b/.test(commandLine)) {
    return { agentId: "external:claude-code", displayName: "Claude Code", surface: "cli", detail: "已发现 Claude Code 进程，但当前任务流未接入；任务完成不可观测" };
  }
  if (/\b(?:hermes|opencode|openclaw)(?:\.cmd|\.exe)?\b/.test(commandLine)) {
    const nameMatch = commandLine.match(/\b(hermes|opencode|openclaw)\b/);
    const displayName = nameMatch?.[1] === "hermes" ? "Hermes Agent" : nameMatch?.[1] === "opencode" ? "OpenCode" : "OpenClaw";
    return { agentId: `external:${nameMatch?.[1] ?? "agent"}`, displayName, surface: "cli", detail: `已发现 ${displayName} 进程，但当前任务流未接入；任务完成不可观测` };
  }
  return null;
}

async function readProcessRecords(): Promise<ProcessRecord[]> {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$names=@('codex.exe','chatgpt.exe','Code.exe','code-insiders.exe','claude.exe','hermes.exe','opencode.exe','openclaw.exe')",
      "Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -or $_.CommandLine -match 'openai\\.codex|codex[_-]?vscode|github\\.copilot|claude[-_]?dev' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 3_500,
        maxBuffer: MAX_PROCESS_OUTPUT,
      });
      const parsed = JSON.parse(String(result.stdout || "[]")) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const raw = row as Record<string, unknown>;
        const pid = typeof raw.ProcessId === "number" ? raw.ProcessId : Number(raw.ProcessId);
        const name = typeof raw.Name === "string" ? raw.Name : "";
        if (!Number.isInteger(pid) || pid <= 0 || !name) return [];
        return [{ pid, name, commandLine: typeof raw.CommandLine === "string" ? raw.CommandLine : "" }];
      });
    } catch {
      return [];
    }
  }

  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], { timeout: 3_500, maxBuffer: MAX_PROCESS_OUTPUT });
    return String(result.stdout || "").split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), name: match[2], commandLine: match[3] ?? "" }];
    });
  } catch {
    return [];
  }
}

export interface AgentTaskObserverOptions {
  getSettings: () => PetSettings;
  getEndpoints?: () => AgentEndpoint[];
}

/**
 * Aggregates app-owned Agent events with a deliberately conservative process probe.
 * A process match is surfaced as unknown, never as running/completed, because a
 * desktop or IDE Agent can remain alive while it is idle.
 */
export class AgentTaskObserver {
  private settings: PetSettings;
  private running = false;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly internalTasks = new Map<string, InternalTask>();
  private readonly externalTasks = new Map<string, InternalTask>();
  private readonly recentCompletionKeys = new Map<string, number>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly completionListeners = new Set<CompletionListener>();
  private snapshot: AgentTaskSnapshot;

  constructor(private readonly options: AgentTaskObserverOptions) {
    this.settings = options.getSettings();
    this.snapshot = this.emptySnapshot(this.settings);
  }

  getSnapshot(): AgentTaskSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribeSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeCompletion(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  private matchState(task: Pick<AgentTaskObservation, "source" | "endpointId" | "role">): AgentTaskMatchState {
    if (task.source === "process" || task.source === "registry" || task.role === "discovered") return "discovered";
    if (task.endpointId && (task.endpointId.startsWith("local:") || (this.options.getEndpoints?.() ?? []).some((endpoint) => endpoint.endpointId === task.endpointId))) {
      return "matched";
    }
    return "unmatched";
  }

  setSettings(settings: PetSettings): void {
    this.settings = settings;
    if (!settings.petPerception.enabled) {
      this.internalTasks.clear();
      this.externalTasks.clear();
    }
    this.publishSnapshot(this.buildSnapshot([]));
    if (this.running && settings.petPerception.enabled) this.schedulePoll(0);
  }

  /**
   * 接收本地事件桥推入的已脱敏外部生命周期事件。以 event-confidence 进入
   * 任务观察：事件声称的 running/completed 状态可信，终态可触发完成通知；
   * 但进程探测结果仍保持 unknown，绝不因进程存在而升级为运行态。
   * 终态任务与内部任务共享相同的 60s TTL 清理与 recentCompletions 去重。
   */
  handleExternalEvent(event: AgentExternalEvent): void {
    if (!this.settings.petPerception.enabled) return;
    const key = [...this.externalTasks.entries()].find(([, candidate]) => isSameExternalTask(candidate, event))?.[0]
      ?? externalTaskKey(event);
    const previous = this.externalTasks.get(key);
    const state = stateForExternalLifecycle(event.lifecycle);
    // A terminal lifecycle is a hard boundary for one external task identity.
    // Late/replayed running records must not resurrect the desktop pet or
    // restart the bot's long-task progress after an interruption/completion.
    if (previous && (previous.state === "ready" || previous.state === "blocked")
      && (state === "running" || state === "needs-input")) {
      console.info(`[AgentTaskObserver] ignored late ${event.lifecycle} event after terminal state for ${event.agentId}/${event.surface}`);
      return;
    }
    const eventOccurredAt = event.occurredAt ?? nowIso();
    // The rollout timestamp describes when the external agent wrote the event,
    // not when the desktop pet actually received the terminal state. Completion
    // records and notifications must use the local receipt time so delayed or
    // replayed rollout records cannot show a stale completion time.
    const completedAt = isTerminalLifecycle(event.lifecycle) ? nowIso() : null;
    const observedAt = completedAt ?? eventOccurredAt;
    const startedAt = previous && previous.state !== "ready" && previous.state !== "blocked"
      ? previous.startedAt
      : state === "running" || state === "needs-input"
        ? observedAt
        : null;
    // 外部事件映射为 worker；manual-test 为 diagnostic，只留在快照，不进入生产通知。
    const role: AgentTaskRole = agentTaskRoleForSource(event.source);
    const observation: InternalTask = {
      id: `external:${key}`,
      eventId: event.eventId,
      endpointId: event.endpointId,
      agentId: event.agentId,
      displayName: event.displayName ?? event.agentId,
      role,
      surface: event.surface,
      hostId: event.hostId,
      workspaceId: event.workspaceId,
      workspaceLabel: event.workspaceLabel ?? workspaceLabelFromPath(event.cwd),
      sessionId: event.sessionId,
      requestId: event.requestId,
      taskId: event.taskId,
      state,
      confidence: "event",
      matchState: this.matchState({ source: event.source, endpointId: event.endpointId, role }),
      source: event.source,
      activity: event.activity,
      detail: safeDetail(event.detail ?? "") || "外部 Agent 任务状态已更新",
      taskTitle: taskTitleForExternalEvent(event),
      startedAt,
      pid: null,
      observedAt,
      terminalAt: completedAt ? Date.parse(completedAt) : null,
    };
    this.externalTasks.set(key, observation);
    // User cancellation/stop is a visible terminal boundary, not a failure.
    // Keep it out of the active snapshot, but retain a distinct interrupted
    // completion so the pet and chat bots can show the red interruption state.
    const isRealFailure = state === "blocked" && event.lifecycle === "failed";
    const isInterrupted = state === "blocked" && (event.lifecycle === "stopped" || event.lifecycle === "cancelled");
    if ((state === "ready" || isRealFailure || isInterrupted) && role !== "diagnostic" && previous?.state !== state && this.shouldEmitCompletion(observation.id, state)) {
      const completion: AgentTaskCompletion = {
        id: `${observation.id}:${state}:${observation.observedAt}`,
        taskId: observation.id,
        taskTitle: observation.taskTitle,
        endpointId: observation.endpointId,
        agentId: event.agentId,
        displayName: observation.displayName,
        role,
        surface: event.surface,
        hostId: observation.hostId,
        workspaceId: observation.workspaceId,
        workspaceLabel: observation.workspaceLabel,
        sessionId: observation.sessionId,
        requestId: observation.requestId,
        source: observation.source,
        terminalState: isInterrupted ? "interrupted" : state === "ready" ? "completed" : "failed",
        success: state === "ready",
        detail: observation.detail,
        startedAt: observation.startedAt,
        completedAt: completedAt ?? observation.observedAt,
      };
      this.snapshot.recentCompletions = [completion, ...this.snapshot.recentCompletions.filter((item) => item.taskId !== completion.taskId)].slice(0, MAX_RECENT_COMPLETIONS);
      this.completionListeners.forEach((listener) => listener(completion));
    }
    this.publishSnapshot(this.buildSnapshot([]));
  }

  start(): void {
    this.running = true;
    if (this.settings.petPerception.enabled) this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.snapshotListeners.clear();
    this.completionListeners.clear();
    this.recentCompletionKeys.clear();
  }

  handleChannelEvent(event: BotChannelEvent): void {
    if (!this.settings.petPerception.enabled || event.type !== "agent-status") return;
    this.handleStatus(
      `${event.platform}:${event.channelId}:${event.conversationId}:${event.messageId ?? ""}`,
      this.settings.activeAgentId,
      this.settings.agentConfigs.find((config) => config.id === this.settings.activeAgentId)?.displayName ?? "当前 Agent",
      "internal",
      "app-event",
      event.status,
      event.detail,
      true,
    );
  }

  handleWeChatEvent(event: WeChatEvent): void {
    if (!this.settings.petPerception.enabled || event.type !== "agent-status" && event.type !== "thinking") return;
    if (event.type === "thinking" && ![...this.internalTasks.values()].some((task) => task.state === "running" || task.state === "needs-input")) return;
    const config = this.settings.agentConfigs.find((item) => item.id === this.settings.activeAgentId);
    const key = event.type === "agent-status"
      ? `wechat:active:${event.from?.trim() || "unknown"}:${event.messageId?.trim() || "latest"}`
      : [...this.internalTasks.entries()].find(([, task]) =>
        task.id.startsWith("event:wechat:active:")
        && (task.state === "running" || task.state === "needs-input"),
      )?.[0] ?? "";
    if (!key) return;
    this.handleStatus(
      key,
      config?.id ?? this.settings.activeAgentId,
      config?.displayName ?? "当前 Agent",
      "internal",
      "app-event",
      event.type === "thinking" ? "thinking" : event.status,
      event.detail,
      event.type === "agent-status" && (event.status === "completed" || event.status === "failed"),
    );
  }

  private emptySnapshot(settings: PetSettings): AgentTaskSnapshot {
    return { enabled: settings.petPerception.enabled, observedAt: nowIso(), tasks: [], recentCompletions: [] };
  }

  private handleStatus(
    key: string,
    agentId: string,
    displayName: string,
    surface: AgentTaskSurface,
    source: AgentTaskSource,
    status: ChannelAgentStatus | "thinking",
    detail: string,
    removeWhenTerminal = false,
  ): void {
    const state = stateForChannelStatus(status === "thinking" ? "thinking" : status);
    const previous = this.internalTasks.get(key);
    const observedAt = nowIso();
    const startedAt = previous && previous.state !== "ready" && previous.state !== "blocked"
      ? previous.startedAt
      : state === "running" || state === "needs-input"
        ? observedAt
        : null;
    // 内部 app-event 代表桌宠主 Agent（controller）的活动，不是外部工作 Agent。
    const role: AgentTaskRole = agentTaskRoleForSource(source);
    const observation: InternalTask = {
      id: `event:${key}`,
      agentId,
      displayName,
      role,
      surface,
      state,
      confidence: confidenceForSource(source),
      matchState: source === "process" || source === "registry" ? "discovered" : undefined,
      source,
      activity: activityForChannelStatus(status === "thinking" ? "thinking" : status),
      detail: safeDetail(detail) || "Agent 任务状态已更新",
      taskTitle: null,
      startedAt,
      pid: null,
      observedAt,
      terminalAt: state === "ready" || state === "blocked" ? Date.now() : null,
    };
    this.internalTasks.set(key, observation);
    if ((state === "ready" || state === "blocked") && previous?.state !== state && this.shouldEmitCompletion(observation.id, state)) {
      const completion: AgentTaskCompletion = {
        id: `${observation.id}:${state}:${observation.observedAt}`,
        taskId: observation.id,
        taskTitle: observation.taskTitle,
        agentId,
        displayName,
        role,
        surface,
        source,
        terminalState: state === "ready" ? "completed" : "failed",
        success: state === "ready",
        detail: observation.detail,
        startedAt: observation.startedAt,
        completedAt: observation.observedAt,
      };
      this.snapshot.recentCompletions = [completion, ...this.snapshot.recentCompletions.filter((item) => item.taskId !== completion.taskId)].slice(0, MAX_RECENT_COMPLETIONS);
      this.completionListeners.forEach((listener) => listener(completion));
    }
    if (removeWhenTerminal && (state === "ready" || state === "blocked")) this.internalTasks.delete(key);
    this.publishSnapshot(this.buildSnapshot([]));
  }

  private buildSnapshot(processes: ProcessRecord[]): AgentTaskSnapshot {
    const settings = this.settings;
    if (!settings.petPerception.enabled) return this.emptySnapshot(settings);
    const tasks = new Map<string, AgentTaskObservation>();
    for (const config of settings.agentConfigs.filter((item) => item.enabled)) {
      tasks.set(`registry:${config.id}`, {
        id: `registry:${config.id}`,
        agentId: config.id,
        displayName: config.displayName,
        role: "discovered",
        surface: surfaceForConfig(config),
        state: "idle",
        confidence: "registry",
        source: "registry",
        detail: "暂未观察到活动任务",
        taskTitle: null,
        startedAt: null,
        pid: null,
        observedAt: this.snapshot.tasks.find((task) => task.agentId === config.id)?.observedAt ?? nowIso(),
      });
    }

    for (const record of processes) {
      const match = classifyProcess(record, settings.agentConfigs);
      if (!match) continue;
      const key = `process:${match.agentId}:${match.surface}`;
      const previous = this.snapshot.tasks.find((task) => task.id === `${key}:${record.pid}`);
      tasks.set(match.agentId.startsWith("external:") ? key : `registry:${match.agentId}`, {
        id: `${key}:${record.pid}`,
        agentId: match.agentId,
        displayName: match.displayName,
        role: "discovered",
        surface: match.surface,
        state: "unknown",
        confidence: "process",
        source: "process",
        detail: match.detail,
        taskTitle: null,
        startedAt: null,
        pid: record.pid,
        observedAt: previous?.observedAt ?? nowIso(),
      });
    }

    for (const [key, task] of this.internalTasks) {
      if (task.terminalAt && Date.now() - task.terminalAt > TERMINAL_TASK_TTL_MS) {
        this.internalTasks.delete(key);
        continue;
      }
      if (task.terminalAt) continue;
      // Keep each conversation/message task distinct. The Agent and surface
      // are not sufficient identity when one Agent serves multiple chats.
      tasks.set(task.id, task);
    }
    for (const [key, task] of this.externalTasks) {
      const observedAt = Date.parse(task.observedAt);
      if (!Number.isFinite(observedAt) || Date.now() - observedAt > EXTERNAL_TASK_INACTIVITY_TTL_MS) {
        this.externalTasks.delete(key);
        continue;
      }
      if (task.terminalAt && Date.now() - task.terminalAt > TERMINAL_TASK_TTL_MS) {
        this.externalTasks.delete(key);
        continue;
      }
      // Some VS Code hosts terminate a turn by killing the worker without
      // appending an abort record. A task that is still only `starting` after
      // the grace period is therefore stale, while real thinking/tool events
      // continue to refresh the task and remain visible.
      if (task.activity === "starting" && Date.now() - observedAt > EXTERNAL_STARTING_STALE_MS) {
        this.externalTasks.delete(key);
        continue;
      }
      if (task.terminalAt) continue;
      tasks.set(`external:${key}`, task);
    }

    // 事件级观察（内部 app-event 或外部桥事件）存在时，同一 Agent 的保守
    // 进程/注册表观察让位；外部事件彼此独立保留（同一 Agent 可同时有多个任务）。
    // Internal channel events represent the configured Agent and therefore
    // suppress its registry row. External events are surface-specific: a
    // Codex Desktop task must not hide the configured Codex CLI row merely
    // because both use the stable agent id `codex`.
    const eventAgentIdsWithInternalActivity = new Set(
      [...this.internalTasks.values()]
        .filter((task) => task.source === "app-event")
        .map((task) => task.agentId),
    );
    const eventAgentSurfaces = new Set(
      [...this.internalTasks.values(), ...this.externalTasks.values()]
        .map((task) => `${task.agentId}:${task.surface}`),
    );
    for (const [key, task] of tasks) {
      const hasMatchingInternalActivity = eventAgentIdsWithInternalActivity.has(task.agentId);
      const hasMatchingExternalSurface = eventAgentSurfaces.has(`${task.agentId}:${task.surface}`);
      if ((task.source === "process" || task.source === "registry")
        && (hasMatchingInternalActivity || hasMatchingExternalSurface)) {
        tasks.delete(key);
      }
    }

    const ordered = [...tasks.values()].sort((left, right) => {
      const rank: Record<AgentTaskState, number> = { "needs-input": 0, blocked: 1, running: 2, ready: 3, unknown: 4, idle: 5 };
      return rank[left.state] - rank[right.state] || left.displayName.localeCompare(right.displayName);
    });
    const next = {
      enabled: true,
      observedAt: this.snapshot.observedAt,
      tasks: ordered,
      recentCompletions: this.snapshot.recentCompletions.slice(0, MAX_RECENT_COMPLETIONS),
    };
    if (JSON.stringify(next.tasks) === JSON.stringify(this.snapshot.tasks)
      && JSON.stringify(next.recentCompletions) === JSON.stringify(this.snapshot.recentCompletions)) {
      return this.snapshot;
    }
    return { ...next, observedAt: nowIso() };
  }

  private shouldEmitCompletion(taskId: string, state: "ready" | "blocked"): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.recentCompletionKeys) {
      if (expiresAt <= now) this.recentCompletionKeys.delete(key);
    }
    const key = `${taskId}:${state}`;
    if (this.recentCompletionKeys.has(key)) return false;
    this.recentCompletionKeys.set(key, now + COMPLETION_DEDUPE_TTL_MS);
    return true;
  }

  private publishSnapshot(snapshot: AgentTaskSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = structuredClone(snapshot);
    this.snapshotListeners.forEach((listener) => listener(structuredClone(this.snapshot)));
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.running || !this.settings.petPerception.enabled) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollProcesses();
    }, delayMs);
  }

  private async pollProcesses(): Promise<void> {
    if (this.pollInFlight || !this.running || !this.settings.petPerception.enabled) return;
    this.pollInFlight = true;
    const settings = this.settings;
    try {
      const processes = await readProcessRecords();
      if (this.settings === settings && this.running && this.settings.petPerception.enabled) {
        this.publishSnapshot(this.buildSnapshot(processes));
      }
      this.schedulePoll(POLL_INTERVAL_MS);
    } catch {
      this.schedulePoll(FAILURE_BACKOFF_MS);
    } finally {
      this.pollInFlight = false;
    }
  }
}
