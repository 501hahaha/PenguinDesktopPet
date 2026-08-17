import type { PetPerceptionEvent, PetPerceptionPhase } from "../../main/pet/perceptionTypes";
import type { PetPerceptionSettings } from "../../settings/types";

export interface PetReactionCoordinatorOptions {
  setState: (state: string) => void;
  resetPet: () => void;
  showBubble: (kind: "online" | "received" | "thinking" | "sent" | "error", title: string, detail?: string, duration?: number) => void;
  resolveState: (phase: PetPerceptionPhase) => string;
}

const PRIORITY: Record<PetPerceptionPhase, number> = {
  error: 6,
  success: 5,
  received: 4,
  working: 3,
  starting: 3,
  waiting: 2,
  online: 1,
  offline: 1,
};

const COOLDOWNS: Partial<Record<PetPerceptionPhase, number>> = {
  offline: 30_000,
  waiting: 3_000,
  success: 3_000,
  error: 8_000,
};

const TITLES: Record<PetPerceptionPhase, string> = {
  offline: "通道暂时离线",
  online: "通道上线啦",
  starting: "正在准备啦",
  working: "正在处理",
  waiting: "正在等待结果",
  received: "收到消息啦",
  success: "处理完成啦",
  error: "这次没有完成",
};

export class PetReactionCoordinator {
  private settings: PetPerceptionSettings = {
    enabled: false,
    agentRuntime: false,
    taskActivity: true,
    taskCompletionNotice: true,
    statusLightMotion: "static",
    longTaskReplyEnabled: true,
    longTaskReplyIntervalSeconds: 30,
    longTaskReplyTemplate: "⏳ {agent} 进度简报 · 已用时 {elapsed} · 阶段 {phase}：{status} · 最新状态：{detail}",
    botActivity: true,
    actionFeedback: true,
    bubbleFeedback: true,
  };
  private lastShownAt = new Map<string, number>();
  private manualOverrideUntil = 0;
  private activePriority = 0;
  private activeUntil = 0;

  constructor(private readonly options: PetReactionCoordinatorOptions) {}

  setSettings(settings: PetPerceptionSettings): void {
    this.settings = settings;
    if (!settings.enabled) {
      this.lastShownAt.clear();
      this.activePriority = 0;
      this.activeUntil = 0;
    }
  }

  markManualOverride(durationMs = 2_200): void {
    this.manualOverrideUntil = Date.now() + durationMs;
  }

  handleEvent(event: PetPerceptionEvent): void {
    if (!this.settings.enabled) return;
    const now = Date.now();
    if (now < this.manualOverrideUntil && PRIORITY[event.phase] < PRIORITY.error) return;
    if (now < this.activeUntil && PRIORITY[event.phase] < this.activePriority) return;

    const cooldownKey = `${event.source}:${event.phase}:${event.platform ?? ""}`;
    const lastShown = this.lastShownAt.get(cooldownKey) ?? 0;
    const cooldown = COOLDOWNS[event.phase] ?? 0;
    if (now - lastShown < cooldown) return;
    this.lastShownAt.set(cooldownKey, now);
    this.activePriority = PRIORITY[event.phase];
    this.activeUntil = now + (event.transient ? 2_600 : 1_600);

    if (this.settings.actionFeedback && event.phase !== "online") {
      this.options.setState(this.options.resolveState(event.phase));
      this.options.resetPet();
    }
    if (!this.settings.bubbleFeedback) return;

    // Availability is a persistent status, not an interruption. Offline is
    // worth one quiet explanation; online simply updates the status surface.
    if (event.phase === "online") return;

    const bubbleKind = event.phase === "success"
      ? "sent"
      : event.phase === "received"
        ? "received"
        : event.phase === "error" || event.phase === "offline"
          ? "error"
          : "thinking";
    const duration = event.phase === "error" || event.phase === "offline" ? 6_500 : event.transient ? 4_200 : 3_800;
    this.options.showBubble(bubbleKind, TITLES[event.phase], event.detail, duration);
  }
}
