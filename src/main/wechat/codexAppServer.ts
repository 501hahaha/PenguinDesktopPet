import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { CodexSandboxMode } from "../../settings/types";
import type { AgentStatus } from "./events";
import { terminateOwnedChildProcess } from "../processCleanup";

const REQUEST_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 600_000;
const WAITING_NOTICE_MS = 15_000;

export type CodexProgressListener = (status: AgentStatus, detail: string) => void;

interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadRecord {
  id: string;
  workspace: string;
  sandbox: CodexSandboxMode;
}

interface ActiveTurn {
  conversationId: string;
  threadId: string;
  turnId: string;
  text: string;
  onProgress?: CodexProgressListener;
  settled: boolean;
  inactivityTimer: NodeJS.Timeout;
  waitingTimer: NodeJS.Timeout;
  lastActivityAt: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface TurnEvent {
  id?: string;
  status?: string;
  error?: { message?: string };
  items?: Array<{ type?: string; text?: string }>;
}

interface EventParams {
  threadId?: string;
  turnId?: string;
  delta?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    query?: string;
    server?: string;
    tool?: string;
  };
  turn?: TurnEvent;
  error?: { message?: string };
}

/**
 * Owns one long-lived Codex app-server process and reuses threads per user.
 * The desktop app's internal app-server is not exposed as a public endpoint,
 * so this client uses the same installed Codex app-server protocol and login.
 */
export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private stdout: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private stderrTail = "";
  private stopping = false;

  async runTurn(
    conversationId: string,
    prompt: string,
    workspace: string,
    sandbox: CodexSandboxMode,
    onProgress?: CodexProgressListener,
  ): Promise<string> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.runTurnNow(conversationId, prompt, workspace, sandbox, onProgress));
    const tracked = task.then(() => undefined, () => undefined);
    this.queues.set(conversationId, tracked);

    try {
      return await task;
    } finally {
      if (this.queues.get(conversationId) === tracked) {
        this.queues.delete(conversationId);
      }
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    this.initialized = false;
    const startPromise = this.startPromise;
    this.startPromise = null;
    this.stdout?.close();
    this.stdout = null;
    this.threads.clear();
    this.rejectPending(new Error("Codex app-server 已停止"));
    this.rejectActiveTurns(new Error("Codex app-server 已停止"));
    if (child) await terminateOwnedChildProcess(child, "Codex app-server");
    await startPromise?.catch(() => undefined);
  }

  private async runTurnNow(
    conversationId: string,
    prompt: string,
    workspace: string,
    sandbox: CodexSandboxMode,
    onProgress?: CodexProgressListener,
  ): Promise<string> {
    await this.ensureStarted(onProgress);
    const thread = await this.getOrCreateThread(conversationId, workspace, sandbox, onProgress);

    try {
      const result = await this.request<TurnStartResult>("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: prompt }],
      });
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("Codex app-server 未返回 turn id");
      return await this.waitForTurn(conversationId, thread.id, turnId, onProgress);
    } catch (error) {
      if (this.threads.get(conversationId)?.id === thread.id) {
        this.threads.delete(conversationId);
      }
      throw error;
    }
  }

  private async ensureStarted(onProgress?: CodexProgressListener): Promise<void> {
    this.stopping = false;
    if (this.process && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startProcess(onProgress);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startProcess(onProgress?: CodexProgressListener): Promise<void> {
    const child = this.spawnProcess();
    this.process = child;
    this.stderrTail = "";
    this.stdout = createInterface({ input: child.stdout! });
    this.stdout.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.failConnection(new Error(`无法启动 Codex app-server：${error.message}`), child);
    });
    child.once("close", (code, signal) => {
      if (this.process !== child) return;
      const detail = this.stderrTail.trim();
      const suffix = detail ? `：${detail.slice(-500)}` : "";
      this.failConnection(
        new Error(`Codex app-server 已退出（code=${code ?? "null"}, signal=${signal ?? "none"}）${suffix}`),
        child,
      );
    });

    onProgress?.("starting", "Codex app-server 正在连接……");
    await this.request("initialize", {
      clientInfo: {
        name: "penguin_desktop_pet",
        title: "Penguin Desktop Pet",
        version: "2.0.0",
      },
    });
    this.send({ method: "initialized", params: {} });
    this.initialized = true;
    onProgress?.("starting", "Codex app-server 已连接，正在准备会话……");
  }

  private spawnProcess(): ChildProcess {
    if (process.platform === "win32") {
      const commandShell = process.env.ComSpec || "cmd.exe";
      return spawn(commandShell, ["/d", "/s", "/c", "codex.cmd app-server --stdio"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    return spawn("codex", ["app-server", "--stdio"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private async getOrCreateThread(
    conversationId: string,
    workspace: string,
    sandbox: CodexSandboxMode,
    onProgress?: CodexProgressListener,
  ): Promise<ThreadRecord> {
    const existing = this.threads.get(conversationId);
    if (existing && existing.workspace === workspace && existing.sandbox === sandbox) {
      return existing;
    }

    const result = await this.request<ThreadStartResult>("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox,
      serviceName: "penguin_desktop_pet",
    });
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("Codex app-server 未返回 thread id");

    const thread = { id: threadId, workspace, sandbox };
    this.threads.set(conversationId, thread);
    onProgress?.("starting", "Codex 会话已准备好，正在处理消息……");
    return thread;
  }

  private waitForTurn(
    conversationId: string,
    threadId: string,
    turnId: string,
    onProgress?: CodexProgressListener,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const active: ActiveTurn = {
        conversationId,
        threadId,
        turnId,
        text: "",
        onProgress,
        settled: false,
        inactivityTimer: setTimeout(() => this.handleInactivity(active), AGENT_TIMEOUT_MS),
        waitingTimer: setInterval(() => this.checkWaiting(active), 5_000),
        lastActivityAt: Date.now(),
        resolve: () => {},
        reject: () => {},
      };
      active.resolve = resolve;
      active.reject = reject;
      this.activeTurns.set(turnId, active);
      onProgress?.("thinking", "Codex 正在分析消息……");
    });
  }

  private checkWaiting(active: ActiveTurn): void {
    if (active.settled || Date.now() - active.lastActivityAt < WAITING_NOTICE_MS) return;
    active.onProgress?.("waiting", "Codex 暂时没有新事件，可能正在等待模型或网络响应……");
  }

  private handleInactivity(active: ActiveTurn): void {
    if (active.settled) return;
    this.finishActiveTurn(
      active,
      new Error(`Codex app-server 连续 ${Math.round(AGENT_TIMEOUT_MS / 1000)} 秒没有新事件，已中断本次任务`),
    );
    void this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).catch(() => {});
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex app-server 请求失败（${message.error.code ?? "unknown"}）`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.handleNotification(message.method, (message.params ?? {}) as EventParams);
  }

  private handleNotification(method: string, params: EventParams): void {
    const active = this.findActiveTurn(params);
    if (!active) return;
    this.markActivity(active);

    if (method === "turn/started") {
      active.onProgress?.("thinking", "Codex 正在分析消息……");
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (params.delta) active.text += params.delta;
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage" && item.text) {
        active.text = item.text;
      }
      this.reportItemStatus(active, item?.type, item);
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn;
      if (!turn || turn.status === "completed") {
        const text = active.text || this.extractTurnText(turn);
        if (!text.trim()) {
          this.finishActiveTurn(active, new Error("Codex app-server 返回了空回复"));
        } else {
          active.onProgress?.("response-ready", "Codex 已生成回复，正在准备发送……");
          this.finishActiveTurn(active, undefined, text.trim());
        }
      } else {
        this.finishActiveTurn(active, new Error(turn.error?.message || `Codex turn 结束状态：${turn.status}`));
      }
    }
  }

  private reportItemStatus(
    active: ActiveTurn,
    itemType: string | undefined,
    item: EventParams["item"],
  ): void {
    const type = (itemType ?? "").toLowerCase();
    if (type === "reasoning" || type === "plan") {
      active.onProgress?.("thinking", "Codex 正在思考和规划……");
    } else if (type === "commandexecution") {
      active.onProgress?.("command", item?.command ? `Codex 正在执行命令：${compact(item.command, 60)}` : "Codex 正在执行命令……");
    } else if (type === "websearch") {
      active.onProgress?.("network", item?.query ? `Codex 正在检索：${compact(item.query, 60)}` : "Codex 正在进行网络检索……");
    } else if (type === "mcptoolcall" || type === "dynamictoolcall" || type === "imageview") {
      active.onProgress?.("tool", item?.tool ? `Codex 正在调用工具：${compact(item.tool, 50)}` : "Codex 正在调用工具……");
    } else if (type === "agentmessage") {
      active.onProgress?.("thinking", "Codex 正在整理回复……");
    }
  }

  private findActiveTurn(params: EventParams): ActiveTurn | undefined {
    if (params.turnId) return this.activeTurns.get(params.turnId);
    if (params.turn?.id) return this.activeTurns.get(params.turn.id);
    if (params.threadId) {
      return [...this.activeTurns.values()].find((turn) => turn.threadId === params.threadId);
    }
    return this.activeTurns.size === 1 ? [...this.activeTurns.values()][0] : undefined;
  }

  private extractTurnText(turn: TurnEvent | undefined): string {
    return (turn?.items ?? [])
      .filter((item) => item.type === "agentMessage" && item.text)
      .map((item) => item.text)
      .join("");
  }

  private finishActiveTurn(active: ActiveTurn, error?: Error, text?: string): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.inactivityTimer);
    clearInterval(active.waitingTimer);
    this.activeTurns.delete(active.turnId);
    if (error) {
      active.onProgress?.("failed", error.message);
      active.reject(error);
    } else {
      active.resolve(text ?? active.text);
    }
  }

  private markActivity(active: ActiveTurn): void {
    active.lastActivityAt = Date.now();
    clearTimeout(active.inactivityTimer);
    active.inactivityTimer = setTimeout(() => this.handleInactivity(active), AGENT_TIMEOUT_MS);
  }

  private send(message: unknown): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("Codex app-server stdin 不可用");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求 ${method} 超时`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failConnection(error: Error, child: ChildProcess): void {
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.stdout?.close();
    this.stdout = null;
    this.threads.clear();
    this.rejectPending(error);
    this.rejectActiveTurns(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectActiveTurns(error: Error): void {
    for (const active of [...this.activeTurns.values()]) {
      this.finishActiveTurn(active, error);
    }
  }
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
