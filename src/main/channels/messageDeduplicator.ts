const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2048;

export class MessageDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  shouldProcess(messageKey: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(messageKey)) return false;

    this.seen.set(messageKey, now);
    while (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.seen.delete(oldestKey);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp >= this.ttlMs) this.seen.delete(key);
    }
  }
}
