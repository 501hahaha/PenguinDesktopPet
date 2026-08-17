import type { AgentTaskActivity, AgentTaskObservation, AgentTaskSnapshot, AgentTaskState } from "./perceptionTypes";

const MAX_STATUS_MESSAGE_LENGTH = 900;

/** 只接受 Codex Desktop rollout 事件，不把进程探针或注册表状态冒充成任务。 */
export function isCodexDesktopTask(task: AgentTaskObservation): boolean {
  return task.agentId === "codex"
    && task.surface === "desktop"
    && task.source === "codex-app-server"
    && task.confidence === "event";
}

export function isCodexDesktopTaskActive(task: AgentTaskObservation): boolean {
  return isCodexDesktopTask(task) && (task.state === "running" || task.state === "needs-input");
}

export function codexTaskStatusLabel(state: AgentTaskState): string {
  if (state === "running") return "执行中";
  if (state === "needs-input") return "等待输入";
  if (state === "ready") return "已完成";
  if (state === "blocked") return "异常结束";
  if (state === "unknown") return "未知";
  return "空闲";
}

export function formatElapsedSeconds(elapsedSeconds: number): string {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function taskElapsedSeconds(task: AgentTaskObservation, now = Date.now()): number {
  const startedAt = Date.parse(task.startedAt ?? task.observedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function clock(iso: string, fallback: number): string {
  const timestamp = Date.parse(iso);
  const date = new Date(Number.isFinite(timestamp) ? timestamp : fallback);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function taskName(task: Pick<AgentTaskObservation, "taskTitle">): string {
  return task.taskTitle || "未命名任务";
}

function taskActivityLabel(activity?: AgentTaskActivity): string {
  if (activity === "starting") return "启动中";
  if (activity === "thinking") return "思考/规划中";
  if (activity === "command") return "执行命令中";
  if (activity === "network") return "访问网络中";
  if (activity === "editing") return "编辑文件中";
  if (activity === "tool") return "调用工具中";
  if (activity === "waiting") return "等待中";
  if (activity === "response-ready") return "整理答复中";
  return "处理中";
}

/** QQ 主动查询和自动简报共用的脱敏状态摘要。 */
export function formatCodexDesktopTaskStatus(snapshot: AgentTaskSnapshot, now = Date.now()): string {
  const tasks = snapshot.tasks.filter(isCodexDesktopTask);
  const activeTasks = tasks
    .filter(isCodexDesktopTaskActive)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const recentCompletions = snapshot.recentCompletions
    .filter((completion) => completion.agentId === "codex" && completion.surface === "desktop")
    .slice(0, 3);
  const lines = [
    "📡 Codex Desktop 实时任务状态",
    `更新时间：${clock(snapshot.observedAt, now)}`,
  ];

  if (!snapshot.enabled) {
    lines.push("桌宠感知当前未开启，暂时没有可用的 Codex Desktop 任务事件。");
  } else if (activeTasks.length === 0) {
    lines.push("当前没有可确认的运行中任务。", "说明：这里只依据已接收的 Codex Desktop 任务事件，不会把进程存在当成任务运行。");
  } else {
    lines.push(`当前运行中：${activeTasks.length} 个任务`);
    for (const task of activeTasks.slice(0, 5)) {
      const elapsed = formatElapsedSeconds(taskElapsedSeconds(task, now));
      lines.push(`• ${taskActivityLabel(task.activity)} · ${codexTaskStatusLabel(task.state)} · ${taskName(task)} · 已用时 ${elapsed} · ${task.detail}`);
    }
    if (activeTasks.length > 5) lines.push(`另有 ${activeTasks.length - 5} 个任务未展开`);
  }

  if (recentCompletions.length > 0) {
    lines.push("最近结束：");
    for (const completion of recentCompletions) {
      const resultLabel = completion.terminalState === "interrupted"
        ? "中断"
        : completion.success ? "完成" : "异常";
      lines.push(`• ${resultLabel} · ${completion.taskTitle || "未命名任务"} · ${clock(completion.completedAt, now)}`);
    }
  }

  return lines.join("\n").slice(0, MAX_STATUS_MESSAGE_LENGTH);
}

/** 仅在明确询问任务/进度/状态时走本地事实快照，普通聊天仍交给 Agent。 */
export function isCodexDesktopTaskQuery(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const mentionsCodex = /codex|桌面端|桌面版/i.test(normalized);
  const hasTaskIntent = /实时|当前|现在|任务|进度|状态|在干嘛|做什么|工作|运行|执行|完成|有没有/i.test(normalized);
  const compactTaskQuery = /(?:查|查询|看看|汇报|告诉我).{0,12}(?:任务|进度|状态)/i.test(normalized);
  return (mentionsCodex && hasTaskIntent) || compactTaskQuery;
}
