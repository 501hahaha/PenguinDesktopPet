export type ResponseCollectorState = "thinking" | "streaming" | "completed";

export interface ResponseSnapshot {
  /** Assistant message text nodes in document order. */
  texts: string[];
  /** True while ChatGPT exposes its stop-generating control. */
  hasStopGenerating: boolean;
}

export interface ResponseBaseline {
  assistantCount: number;
  assistantLast: string;
}

export interface ResponseCollectorOptions {
  read: () => Promise<ResponseSnapshot>;
  baseline: ResponseBaseline;
  timeoutMs?: number;
  stableMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  logger?: (line: string) => void;
}

export interface ResponseCollectorResult {
  role: "assistant";
  content: string;
  elapsed: number;
}

export class ResponseCollectorError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "ResponseCollectorError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

const INTERMEDIATE_TEXTS = new Set([
  "正在思考",
  "thinking",
  "generating",
  "停止生成",
]);

/**
 * Collects only the final assistant message from a streaming web page.
 * Provider-specific DOM access stays outside this class; the collector only
 * consumes snapshots and applies the response lifecycle rules.
 */
export class ResponseCollector {
  async collect(options: ResponseCollectorOptions): Promise<ResponseCollectorResult> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stableMs = Math.max(1, options.stableMs ?? DEFAULT_STABLE_MS);
    const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const startedAt = Date.now();
    const logger = options.logger ?? ((line: string) => console.log(line));

    let currentState: ResponseCollectorState = "thinking";
    let lastLoggedState: ResponseCollectorState | null = null;
    let lastLoggedText = "";
    let emittedText = "";
    let stableSince = 0;

    while (Date.now() - startedAt < timeoutMs) {
      this.assertNotAborted(options.signal);
      const snapshot = await options.read();
      const elapsed = Date.now() - startedAt;
      const currentText = this.latestText(snapshot.texts);
      const candidate = this.findNewFinalText(snapshot.texts, options.baseline);

      if (candidate !== emittedText) {
        const previousText = emittedText;
        emittedText = candidate;
        stableSince = candidate ? Date.now() : 0;
        if (candidate) {
          const delta = candidate.startsWith(previousText)
            ? candidate.slice(previousText.length)
            : candidate;
          if (delta) options.onDelta?.(delta);
        }
      }

      if (!candidate || ResponseCollector.isIntermediateText(currentText)) {
        currentState = "thinking";
      } else if (snapshot.hasStopGenerating) {
        currentState = "streaming";
      }

      if (currentState !== lastLoggedState || currentText !== lastLoggedText) {
        logger(this.debugLine(currentState, currentText, elapsed));
        lastLoggedState = currentState;
        lastLoggedText = currentText;
      }

      if (candidate) {
        // Completion rule A: ChatGPT removed its stop-generating control.
        if (!snapshot.hasStopGenerating) {
          currentState = "completed";
          logger(this.debugLine(currentState, candidate, Date.now() - startedAt));
          return { role: "assistant", content: candidate, elapsed: Date.now() - startedAt };
        }

        // Completion rule B: the assistant node has stopped changing for 3s.
        if (stableSince > 0 && Date.now() - stableSince >= stableMs) {
          currentState = "completed";
          logger(this.debugLine(currentState, candidate, Date.now() - startedAt));
          return { role: "assistant", content: candidate, elapsed: Date.now() - startedAt };
        }
      }

      await this.delay(pollIntervalMs, options.signal);
    }

    throw new ResponseCollectorError("TIMEOUT", `ChatGPT Web response collector timed out after ${timeoutMs} ms`);
  }

  static isIntermediateText(text: string): boolean {
    const normalized = this.normalizeTextValue(text).replace(/[.…]+$/g, "").trim().toLocaleLowerCase();
    return INTERMEDIATE_TEXTS.has(normalized);
  }

  private findNewFinalText(texts: string[], baseline: ResponseBaseline): string {
    const normalizedBaseline = this.normalizeText(baseline.assistantLast);
    const normalizedTexts = texts.map((text) => this.normalizeText(text));
    const candidates = normalizedTexts.filter((text, index) => (
      text.length > 0
      && (index >= baseline.assistantCount || text !== normalizedBaseline)
      && !ResponseCollector.isIntermediateText(text)
    ));
    return candidates[candidates.length - 1] || "";
  }

  private latestText(texts: string[]): string {
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      const text = this.normalizeText(texts[index]);
      if (text) return text;
    }
    return "";
  }

  private normalizeText(text: string): string {
    return ResponseCollector.normalizeTextValue(text);
  }

  private static normalizeTextValue(text: string): string {
    return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  private debugLine(state: ResponseCollectorState, currentText: string, elapsed: number): string {
    const preview = currentText.replace(/[\r\n]+/g, " ").slice(0, 200);
    return `[ChatGPT Collector] state: ${state} currentText: ${preview || "<empty>"} elapsed: ${elapsed} ms`;
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ResponseCollectorError("ABORTED", "ChatGPT Web response collection was cancelled");
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    this.assertNotAborted(signal);
  }
}
