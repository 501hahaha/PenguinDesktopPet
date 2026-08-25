export interface ZeroTokenMetricsSnapshot {
  requestCount: number;
  successCount: number;
  failedCount: number;
  averageLatency: number;
  lastError: string | null;
  lastSuccessTime: number | null;
}

/** In-memory, secret-free health metrics for the embedded ZeroToken provider. */
export class ZeroTokenMetrics {
  private requestCount = 0;
  private successCount = 0;
  private failedCount = 0;
  private totalLatency = 0;
  private lastError: string | null = null;
  private lastSuccessTime: number | null = null;

  recordRequest(): void {
    this.requestCount += 1;
  }

  recordSuccess(latencyMs: number): void {
    this.successCount += 1;
    this.addLatency(latencyMs);
    this.lastSuccessTime = Date.now();
  }

  recordFailure(error: unknown, latencyMs: number): void {
    this.failedCount += 1;
    this.addLatency(latencyMs);
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  snapshot(): ZeroTokenMetricsSnapshot {
    return {
      requestCount: this.requestCount,
      successCount: this.successCount,
      failedCount: this.failedCount,
      averageLatency: this.requestCount ? Math.round((this.totalLatency / this.requestCount) * 10) / 10 : 0,
      lastError: this.lastError,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  reset(): void {
    this.requestCount = 0;
    this.successCount = 0;
    this.failedCount = 0;
    this.totalLatency = 0;
    this.lastError = null;
    this.lastSuccessTime = null;
  }

  private addLatency(latencyMs: number): void {
    if (Number.isFinite(latencyMs) && latencyMs >= 0) this.totalLatency += latencyMs;
  }
}
