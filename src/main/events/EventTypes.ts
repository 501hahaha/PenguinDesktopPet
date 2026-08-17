export type AgentEventSourceType =
  | "codex"
  | "claude"
  | "opencode"
  | "agent"
  | "planner"
  | "timer"
  | "system";

export type AgentEventType =
  | "agent.status"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.waiting"
  | "task.input_required"
  | "plan.created"
  | "plan.progress"
  | "plan.step_completed"
  | "plan.completed"
  | "timer.triggered"
  | "system.info";

export type AgentEventStatus =
  | "processing"
  | "completed"
  | "failed"
  | "waiting"
  | "input_required"
  | "info";

export type AgentEventPriority = "low" | "normal" | "high" | "critical";

export type NotificationActionType =
  | "open"
  | "reply"
  | "confirm"
  | "cancel"
  | "retry"
  | "continue"
  | "custom";

export interface NotificationAction {
  id: string;
  label: string;
  type: NotificationActionType;
  payload?: Record<string, unknown>;
}

export interface AgentEventSource {
  type: AgentEventSourceType;
  id?: string;
  name: string;
}

export interface AgentEventProgress {
  current?: number;
  total?: number;
  percent?: number;
}

export interface AgentEvent {
  id: string;
  source: AgentEventSource;
  type: AgentEventType;
  status: AgentEventStatus;
  priority: AgentEventPriority;
  title: string;
  message: string;
  taskId?: string;
  sessionId?: string;
  planId?: string;
  stepId?: string;
  progress?: AgentEventProgress;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}
