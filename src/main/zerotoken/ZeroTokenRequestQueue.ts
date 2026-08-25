export type ZeroTokenQueueErrorCode = "REQUEST_CANCELLED" | "REQUEST_TIMEOUT";

export class ZeroTokenQueueError extends Error {
  constructor(
    readonly code: ZeroTokenQueueErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ZeroTokenQueueError";
  }
}

export interface ZeroTokenRequestQueueOptions {
  id?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ZeroTokenRequestHandle<T> {
  readonly id: string;
  readonly promise: Promise<T>;
  cancel(): boolean;
}

interface QueueEntry<T> {
  id: string;
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number | undefined;
  controller: AbortController;
  externalSignal?: AbortSignal;
  removeExternalAbort?: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  settled: boolean;
  active: boolean;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Serializes all operations that touch the ChatGPT Web page. */
export class ZeroTokenRequestQueue {
  private readonly pending: QueueEntry<unknown>[] = [];
  private active: QueueEntry<unknown> | null = null;
  private nextId = 1;
  private pumping = false;

  enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: ZeroTokenRequestQueueOptions = {},
  ): ZeroTokenRequestHandle<T> {
    const controller = new AbortController();
    const id = options.id?.trim() || `zerotoken-request-${this.nextId++}`;
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: QueueEntry<T> = {
      id,
      operation,
      timeoutMs: options.timeoutMs,
      controller,
      externalSignal: options.signal,
      settled: false,
      active: false,
      resolve: resolvePromise,
      reject: rejectPromise,
    };

    const abortFromExternal = (): void => {
      this.cancel(id);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        entry.settled = true;
        rejectPromise(new ZeroTokenQueueError("REQUEST_CANCELLED", "Request was cancelled before it entered the queue"));
        return { id, promise, cancel: () => false };
      }
      options.signal.addEventListener("abort", abortFromExternal, { once: true });
      entry.removeExternalAbort = () => options.signal?.removeEventListener("abort", abortFromExternal);
    }

    this.pending.push(entry as QueueEntry<unknown>);
    void this.pump();
    return { id, promise, cancel: () => this.cancel(id) };
  }

  cancel(id: string): boolean {
    const pendingIndex = this.pending.findIndex((entry) => entry.id === id);
    if (pendingIndex >= 0) {
      const [entry] = this.pending.splice(pendingIndex, 1);
      this.finishCancelled(entry);
      return true;
    }
    if (this.active?.id === id) {
      this.active.controller.abort();
      this.finishCancelled(this.active);
      return true;
    }
    return false;
  }

  cancelActive(): boolean {
    return this.active ? this.cancel(this.active.id) : false;
  }

  cancelAll(): number {
    const ids = [this.active?.id, ...this.pending.map((entry) => entry.id)].filter(
      (id): id is string => Boolean(id),
    );
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  get size(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active && this.pending.length) {
        const entry = this.pending.shift();
        if (!entry || entry.settled) continue;
        this.active = entry;
        entry.active = true;
        this.startTimeout(entry);
        try {
          const value = await entry.operation(entry.controller.signal);
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve(value);
          }
        } catch (error) {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(error);
          }
        } finally {
          this.clearEntry(entry);
          this.active = null;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.active && this.pending.length) void this.pump();
    }
  }

  private startTimeout(entry: QueueEntry<unknown>): void {
    if (!entry.timeoutMs || entry.timeoutMs <= 0) return;
    entry.timeoutHandle = setTimeout(() => {
      if (entry.settled) return;
      entry.controller.abort();
      entry.settled = true;
      entry.reject(new ZeroTokenQueueError("REQUEST_TIMEOUT", `Request timed out after ${entry.timeoutMs} ms`));
    }, entry.timeoutMs);
  }

  private finishCancelled(entry: QueueEntry<unknown>): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.controller.abort();
    entry.reject(new ZeroTokenQueueError("REQUEST_CANCELLED", "Request was cancelled"));
    if (!entry.active) this.clearEntry(entry);
  }

  private clearEntry(entry: QueueEntry<unknown>): void {
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.removeExternalAbort?.();
    entry.timeoutHandle = undefined;
    entry.removeExternalAbort = undefined;
    entry.active = false;
  }
}
