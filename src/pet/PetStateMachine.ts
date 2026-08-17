export const PET_STATES = [
  "idle",
  "walk",
  "happy",
  "shy",
  "sleep",
  "eat",
  "angry",
] as const;

export type PetState = (typeof PET_STATES)[number];

export interface PetStateChange {
  from: string;
  to: string;
}

export class PetStateMachine {
  private state: string = "idle";
  private cycleStates: string[] = [...PET_STATES];
  private readonly listeners = new Set<(change: PetStateChange) => void>();

  getState(): string {
    return this.state;
  }

  setCycleStates(states: readonly string[]): void {
    const nextCycleStates = Array.from(new Set(states.filter((state) => state.trim())));
    if (nextCycleStates.length === 0) return;
    this.cycleStates = nextCycleStates;
    if (this.cycleStates.includes(this.state)) return;
    this.setState(this.cycleStates[0]);
  }

  setState(nextState: string): boolean {
    if (nextState === this.state) {
      return false;
    }

    const change = { from: this.state, to: nextState };
    this.state = nextState;
    this.listeners.forEach((listener) => listener(change));
    return true;
  }

  cycle(): string {
    const currentIndex = this.cycleStates.indexOf(this.state);
    const nextState = this.cycleStates[(currentIndex + 1 + this.cycleStates.length) % this.cycleStates.length];
    this.setState(nextState);
    return nextState;
  }

  subscribe(listener: (change: PetStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
