export type PetAIListener = (state: string) => void;

export class PetAI {
  private nextActionTimer: ReturnType<typeof setTimeout> | undefined;
  private returnToIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private actionPool: string[] = ["walk", "happy", "shy", "eat", "angry"];

  constructor(private readonly listener: PetAIListener) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleNextAction();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
  }

  reset(): void {
    if (!this.running) {
      return;
    }

    this.clearTimers();
    this.scheduleNextAction();
  }

  setActionPool(states: readonly string[]): void {
    const nextPool = Array.from(new Set(states.filter((state) => state.trim())));
    if (nextPool.length > 0) this.actionPool = nextPool;
  }

  private scheduleNextAction(): void {
    const delay = this.isNightTime() ? 9000 : 5000 + Math.random() * 7000;
    this.nextActionTimer = setTimeout(() => {
      if (!this.running) {
        return;
      }

      this.listener(this.pickAction());
      this.returnToIdleTimer = setTimeout(() => {
        if (this.running) {
          this.listener(this.restState());
          this.scheduleNextAction();
        }
      }, 2600);
    }, delay);
  }

  private pickAction(): string {
    if (this.isNightTime()) {
      return this.actionPool.includes("sleep") ? "sleep" : this.restState();
    }

    const actions = this.actionPool.filter((state) => state !== this.restState());
    const pool = actions.length > 0 ? actions : this.actionPool;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private restState(): string {
    return this.actionPool.includes("idle") ? "idle" : this.actionPool[0] ?? "idle";
  }

  private isNightTime(): boolean {
    const hour = new Date().getHours();
    return hour >= 23 || hour < 7;
  }

  private clearTimers(): void {
    if (this.nextActionTimer) {
      clearTimeout(this.nextActionTimer);
      this.nextActionTimer = undefined;
    }

    if (this.returnToIdleTimer) {
      clearTimeout(this.returnToIdleTimer);
      this.returnToIdleTimer = undefined;
    }
  }
}
