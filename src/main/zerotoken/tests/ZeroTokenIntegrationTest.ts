import { app, session, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { BrowserManager } from "../BrowserManager";
import { ResponseCollector } from "../ResponseCollector";
import { SessionManager } from "../SessionManager";
import { ChatGPTWebAdapter } from "../providers/ChatGPTWebAdapter";
import { createWebAIClient } from "../WebAIClient";
import { formatSessionSource, readElectronSessionSource, readSessionSource } from "../SessionDiagnostics";
import { ZeroTokenQueueError, ZeroTokenRequestQueue } from "../ZeroTokenRequestQueue";
import type { ZeroTokenMetricsSnapshot } from "../ZeroTokenMetrics";
import { createZeroTokenProvider, type ZeroTokenProvider } from "../../agents/ZeroTokenProvider";
import type { ZeroTokenSettings } from "../../../settings/types";

const CHATGPT_PROVIDER = "chatgpt-web" as const;
const CHATGPT_PARTITION = "persist:zerotoken-chatgpt";
const TEST_MESSAGE = "Reply only: OK";
const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
const BROWSER_LOAD_TIMEOUT_MS = 30_000;

export type ZeroTokenIntegrationStage =
  | "ENVIRONMENT"
  | "BROWSER"
  | "SESSION"
  | "LOGIN"
  | "PROVIDER"
  | "HEALTH"
  | "QUEUE"
  | "CONVERSATION"
  | "ABORT"
  | "TIMEOUT_RECOVERY"
  | "RECOVERY"
  | "CHAT"
  | "RESPONSE_PARSE"
  | "UNKNOWN";

export interface ZeroTokenIntegrationLatency {
  browserTime: number;
  sessionTime: number;
  loginTime: number;
  providerTime: number;
  healthTime: number;
  queueTime: number;
  conversationTime: number;
  abortTime: number;
  timeoutRecoveryTime: number;
  recoveryTime: number;
  chatTime: number;
  totalTime: number;
}

export interface ZeroTokenIntegrationResult {
  success: boolean;
  environment: boolean;
  browser: boolean;
  session: boolean;
  login: boolean;
  provider: boolean;
  health: boolean;
  queue: boolean;
  conversation: boolean;
  abort: boolean;
  timeoutRecovery: boolean;
  recovery: boolean;
  chat: boolean;
  metrics: ZeroTokenMetricsSnapshot;
  loginStatus?: "READY" | "LOGIN_REQUIRED";
  response?: string;
  failedStage?: ZeroTokenIntegrationStage;
  error?: string;
  latency: ZeroTokenIntegrationLatency;
}

export interface ZeroTokenIntegrationOptions {
  chatTimeoutMs?: number;
  browserLoadTimeoutMs?: number;
  abortDelayMs?: number;
  log?: (line: string) => void;
}

class IntegrationFailure extends Error {
  constructor(
    readonly stage: ZeroTokenIntegrationStage,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationFailure";
  }
}

function settings(): ZeroTokenSettings {
  return {
    enabled: true,
    provider: CHATGPT_PROVIDER,
    baseUrl: "",
    runtimePath: "",
    model: "",
    timeout: DEFAULT_CHAT_TIMEOUT_MS,
    autoStart: false,
  };
}

function emptyLatency(totalTime = 0): ZeroTokenIntegrationLatency {
  return {
    browserTime: 0,
    sessionTime: 0,
    loginTime: 0,
    providerTime: 0,
    healthTime: 0,
    queueTime: 0,
    conversationTime: 0,
    abortTime: 0,
    timeoutRecoveryTime: 0,
    recoveryTime: 0,
    chatTime: 0,
    totalTime,
  };
}

/**
 * Runs the complete embedded ZeroToken path against the real persistent
 * ChatGPT partition. It intentionally does not clear cookies or create a
 * temporary profile, so the command also verifies restart-safe Session use.
 */
export async function runZeroTokenIntegrationTest(
  options: ZeroTokenIntegrationOptions = {},
): Promise<ZeroTokenIntegrationResult> {
  const startedAt = Date.now();
  const log = options.log ?? ((line: string) => console.log(line));
  const browserManager = new BrowserManager(false);
  const sessionManager = new SessionManager(browserManager);
  const result: ZeroTokenIntegrationResult = {
    success: false,
    environment: false,
    browser: false,
    session: false,
    login: false,
    provider: false,
    health: false,
    queue: false,
    conversation: false,
    abort: false,
    timeoutRecovery: false,
    recovery: false,
    chat: false,
    metrics: emptyMetrics(),
    latency: emptyLatency(),
  };

  let currentStage: ZeroTokenIntegrationStage = "ENVIRONMENT";
  let provider: ZeroTokenProvider | null = null;

  try {
    log("[ZeroToken Integration]");
    log(`userData: ${app.getPath("userData")}`);
    log(`partition: ${browserManager.getPartition(CHATGPT_PROVIDER)}`);

    currentStage = "ENVIRONMENT";
    const environmentStartedAt = Date.now();
    const userDataPath = app.getPath("userData");
    const environmentReady = app.isReady()
      && existsSync(userDataPath)
      && browserManager.getPartition(CHATGPT_PROVIDER) === CHATGPT_PARTITION;
    result.environment = environmentReady;
    log(`Environment ${environmentReady ? "PASS" : "FAIL"}`);
    if (!environmentReady) {
      throw new IntegrationFailure("ENVIRONMENT", `Electron environment or userData is unavailable: ${userDataPath}`);
    }

    currentStage = "BROWSER";
    const browserStartedAt = Date.now();
    const loginWindow = browserManager.createLoginWindow(CHATGPT_PROVIDER);
    await waitForChatGPTPage(loginWindow, options.browserLoadTimeoutMs ?? BROWSER_LOAD_TIMEOUT_MS);
    try {
      const testSession = await readSessionSource("ZeroToken Test Session", loginWindow, CHATGPT_PARTITION);
      log(formatSessionSource(testSession, CHATGPT_PARTITION));
      const defaultSession = await readElectronSessionSource("ZeroToken Test Default Session", session.defaultSession);
      log(formatSessionSource(defaultSession));
    } catch (error) {
      log(`[ZeroToken Test Session] diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    result.browser = true;
    result.latency.browserTime = Date.now() - browserStartedAt;
    log("Browser PASS");

    currentStage = "SESSION";
    const sessionStartedAt = Date.now();
    const partition = browserManager.getPartition(CHATGPT_PROVIDER);
    const chatSession = browserManager.getSession(CHATGPT_PROVIDER);
    const cookies = await chatSession.cookies.get({ url: "https://chatgpt.com/" });
    result.session = partition === CHATGPT_PARTITION;
    result.latency.sessionTime = Date.now() - sessionStartedAt;
    log(`Session ${result.session ? "PASS" : "FAIL"}`);
    log(`Session cookie count: ${cookies.length}`);
    if (!result.session) throw new IntegrationFailure("SESSION", `Unexpected partition: ${partition}`);

    currentStage = "LOGIN";
    const loginStartedAt = Date.now();
    const loggedIn = await sessionManager.checkLogin(CHATGPT_PROVIDER);
    result.latency.loginTime = Date.now() - loginStartedAt;
    result.login = loggedIn;
    result.loginStatus = loggedIn ? "READY" : "LOGIN_REQUIRED";
    log(`login: ${loggedIn}`);
    log(`Login ${loggedIn ? "PASS (READY)" : "FAIL (LOGIN_REQUIRED)"}`);
    if (!loggedIn) throw new IntegrationFailure("LOGIN", "LOGIN_REQUIRED");

    provider = createProvider(browserManager, sessionManager);
    currentStage = "PROVIDER";
    const providerStartedAt = Date.now();
    const availability = await provider.checkAvailability();
    result.latency.providerTime = Date.now() - providerStartedAt;
    result.provider = availability.available;
    log(`Provider ${availability.available ? "PASS" : "FAIL"}`);
    if (!availability.available) {
      const stage = availability.code === "LOGIN_REQUIRED" || availability.code === "SESSION_EXPIRED"
        ? "LOGIN"
        : "PROVIDER";
      throw new IntegrationFailure(stage, availability.detail);
    }

    currentStage = "HEALTH";
    const healthStartedAt = Date.now();
    const health = await provider.healthCheck();
    result.latency.healthTime = Date.now() - healthStartedAt;
    result.health = health.login && health.available;
    log(`Health ${result.health ? "PASS" : "FAIL"} login=${health.login} available=${health.available} latency=${health.latency} ms`);
    if (!result.health) throw new IntegrationFailure("HEALTH", health.detail || health.code || "Provider health check failed");

    currentStage = "QUEUE";
    const queueStartedAt = Date.now();
    result.queue = await runQueueTest();
    result.latency.queueTime = Date.now() - queueStartedAt;
    log(`Queue ${result.queue ? "PASS" : "FAIL"}`);
    if (!result.queue) throw new IntegrationFailure("QUEUE", "ZeroToken request queue ordering/cancel/timeout failed");
    provider.resetMetrics();

    currentStage = "CONVERSATION";
    const conversationStartedAt = Date.now();
    await provider.resetConversation();
    const remembered = await provider.chatCompletion({
      messages: [{ role: "user", content: "记住测试名字叫小明。回复：已记住" }],
      timeoutMs: options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    });
    const recalled = await provider.chatCompletion({
      messages: [{ role: "user", content: "测试名字是什么？只回复名字" }],
      timeoutMs: options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    });
    result.latency.conversationTime = Date.now() - conversationStartedAt;
    result.conversation = remembered.trim().length > 0 && /小明/.test(recalled);
    log(`Conversation ${result.conversation ? "PASS" : "FAIL"}`);
    log(`Conversation Response: ${recalled.trim() || "<empty>"}`);
    if (!result.conversation) throw new IntegrationFailure("CONVERSATION", "ChatGPT Web conversation context was not preserved");

    currentStage = "ABORT";
    const abortStartedAt = Date.now();
    result.abort = await runAbortTest(
      provider,
      options.abortDelayMs ?? 1_200,
      options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      log,
    );
    result.latency.abortTime = Date.now() - abortStartedAt;
    log(`Abort ${result.abort ? "PASS" : "FAIL"}`);
    if (!result.abort) throw new IntegrationFailure("ABORT", "Generation did not stop cleanly or the queue was not released");

    currentStage = "TIMEOUT_RECOVERY";
    const timeoutRecoveryStartedAt = Date.now();
    result.timeoutRecovery = await runTimeoutRecoveryTest(
      provider,
      options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      log,
    );
    result.latency.timeoutRecoveryTime = Date.now() - timeoutRecoveryStartedAt;
    log(`Timeout Recovery ${result.timeoutRecovery ? "PASS" : "FAIL"}`);
    if (!result.timeoutRecovery) throw new IntegrationFailure("TIMEOUT_RECOVERY", "Queue did not recover after a timed-out request");

    currentStage = "RECOVERY";
    const recoveryStartedAt = Date.now();
    let firstRequestFailed = false;
    try {
      // Deterministic preflight failure: it exercises Provider error handling
      // without sending an extra message or mutating the browser Session.
      await provider.chatCompletion({ messages: [], timeoutMs: 1_000 });
    } catch {
      firstRequestFailed = true;
    }
    if (!firstRequestFailed) {
      throw new IntegrationFailure("RECOVERY", "The intentionally invalid first request did not fail");
    }

    result.recovery = true;
    result.latency.recoveryTime = Date.now() - recoveryStartedAt;
    log("Recovery PASS (provider remains usable after a failed request)");

    currentStage = "CHAT";
    const chatStartedAt = Date.now();
    const response = await provider.chatCompletion({
      messages: [{ role: "user", content: TEST_MESSAGE }],
      timeoutMs: options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    });
    result.latency.chatTime = Date.now() - chatStartedAt;
    result.response = response.trim();
    result.chat = result.response.length > 0;
    log(`Chat ${result.chat ? "PASS" : "FAIL"}`);
    log(`Response: ${result.response || "<empty>"}`);
    if (!result.chat) throw new IntegrationFailure("RESPONSE_PARSE", "Assistant response is empty");

    currentStage = "RESPONSE_PARSE";
    if (ResponseCollector.isIntermediateText(result.response) || !/\bOK\b/i.test(result.response)) {
      throw new IntegrationFailure("RESPONSE_PARSE", `Unexpected final response: ${result.response || "<empty>"}`);
    }

    result.success = result.environment
      && result.browser
      && result.session
      && result.login
      && result.provider
      && result.health
      && result.queue
      && result.conversation
      && result.abort
      && result.timeoutRecovery
      && result.recovery
      && result.chat;
    log("Response Parse PASS");
    return result;
  } catch (error) {
    const failure = normalizeFailure(error, currentStage);
    result.failedStage = failure.stage;
    result.error = failure.message;
    if (!(failure.stage === "LOGIN" && result.loginStatus === "LOGIN_REQUIRED")) {
      log(`${stageLabel(failure.stage)} FAIL`);
    }
    log(`FAILED_STAGE: ${failure.stage}`);
    log(`Error: ${failure.message}`);
    return result;
  } finally {
    if (provider) result.metrics = provider.getMetrics();
    result.latency.totalTime = Date.now() - startedAt;
    log(`Latency browserTime=${result.latency.browserTime} ms loginTime=${result.latency.loginTime} ms chatTime=${result.latency.chatTime} ms totalTime=${result.latency.totalTime} ms`);
    log(`Metrics ${JSON.stringify(result.metrics)}`);
    browserManager.dispose();
  }
}

function emptyMetrics(): ZeroTokenMetricsSnapshot {
  return {
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    averageLatency: 0,
    lastError: null,
    lastSuccessTime: null,
  };
}

async function runAbortTest(
  provider: ZeroTokenProvider,
  abortDelayMs: number,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<boolean> {
  await provider.resetConversation();
  const longRequest = provider.chatCompletion({
    messages: [{
      role: "user",
      content: "Write a very long, detailed essay of at least 3000 words about the history of computing. Continue until explicitly stopped.",
    }],
    timeoutMs,
  });
  let terminal: "resolved" | "rejected" | "pending" = "pending";
  const settled = longRequest.then(
    () => { terminal = "resolved"; },
    () => { terminal = "rejected"; },
  );
  await delay(Math.max(250, abortDelayMs));
  const abortRequested = await provider.abortGeneration();
  await Promise.race([settled, delay(5_000)]);
  if (terminal === "pending") {
    await provider.abortGeneration();
    await Promise.race([settled, delay(2_000)]);
  }

  let followUp = "";
  try {
    followUp = await provider.chatCompletion({
      messages: [{ role: "user", content: TEST_MESSAGE }],
      timeoutMs,
    });
  } catch (error) {
    log(`Abort follow-up error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const queueReleased = /\bOK\b/i.test(followUp);
  log(`Abort detail stopped=${abortRequested} terminal=${terminal} queueReleased=${queueReleased}`);
  return abortRequested && terminal !== "pending" && queueReleased;
}

async function runTimeoutRecoveryTest(
  provider: ZeroTokenProvider,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<boolean> {
  await provider.resetConversation();
  let timeoutError = "";
  try {
    await provider.chatCompletion({
      messages: [{ role: "user", content: "This request must time out before it can be sent." }],
      timeoutMs: 10,
    });
  } catch (error) {
    timeoutError = error instanceof Error ? error.message : String(error);
  }
  const timedOut = /REQUEST_TIMEOUT|timed out|timeout/i.test(timeoutError);

  // A provider timeout can race with the page-side send operation: the queue
  // is released as soon as the request is rejected, while the browser may
  // still be finishing the aborted DOM interaction.  Stop any residual
  // generation and restore a clean composer before proving the next request
  // can run.  This keeps the recovery assertion focused on queue reuse rather
  // than on stale page state from the timed-out request.
  let generationStopped = false;
  try {
    generationStopped = await provider.abortGeneration();
  } catch (error) {
    log(`Timeout abort cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await provider.resetConversation();
  } catch (error) {
    log(`Timeout page reset error: ${error instanceof Error ? error.message : String(error)}`);
  }

  let followUp = "";
  try {
    followUp = await provider.chatCompletion({
      messages: [{ role: "user", content: TEST_MESSAGE }],
      timeoutMs,
    });
  } catch (error) {
    log(`Timeout follow-up error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const queueRecovered = /\bOK\b/i.test(followUp);
  log(`Timeout detail timedOut=${timedOut} generationStopped=${generationStopped} queueRecovered=${queueRecovered}`);
  return timedOut && queueRecovered;
}

async function runQueueTest(): Promise<boolean> {
  const queue = new ZeroTokenRequestQueue();
  const order: string[] = [];
  const first = queue.enqueue(async () => {
    order.push("first:start");
    await delay(40);
    order.push("first:end");
    return "first";
  });
  const second = queue.enqueue(async () => {
    order.push("second:start");
    await delay(5);
    order.push("second:end");
    return "second";
  });
  const values = await Promise.all([first.promise, second.promise]);
  if (values.join(",") !== "first,second" || order.join(",") !== "first:start,first:end,second:start,second:end") return false;

  const cancelled = queue.enqueue(async () => {
    await delay(100);
    return "cancelled";
  });
  const cancelledOk = cancelled.cancel();
  let cancelledCode = "";
  try {
    await cancelled.promise;
  } catch (error) {
    cancelledCode = error instanceof ZeroTokenQueueError ? error.code : "";
  }

  const timedOut = queue.enqueue(async (signal) => {
    await waitForAbortOrDelay(signal, 100);
    return "timed-out";
  }, { timeoutMs: 20 });
  let timeoutCode = "";
  try {
    await timedOut.promise;
  } catch (error) {
    timeoutCode = error instanceof ZeroTokenQueueError ? error.code : "";
  }
  return cancelledOk && cancelledCode === "REQUEST_CANCELLED" && timeoutCode === "REQUEST_TIMEOUT";
}

async function waitForAbortOrDelay(signal: AbortSignal, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createProvider(browserManager: BrowserManager, sessionManager: SessionManager): ZeroTokenProvider {
  return createZeroTokenProvider(
    settings(),
    createWebAIClient([new ChatGPTWebAdapter(browserManager, sessionManager)]),
  );
}

function stageLabel(stage: ZeroTokenIntegrationStage): string {
  return stage === "RESPONSE_PARSE" ? "Response Parse" : `${stage[0]}${stage.slice(1).toLocaleLowerCase()}`;
}

async function waitForChatGPTPage(window: BrowserWindow, timeoutMs: number): Promise<void> {
  const isChatGPTUrl = (): boolean => /^https:\/\/(?:chatgpt\.com|auth\.openai\.com)(?:\/|$)/i.test(window.webContents.getURL());
  if (!window.isDestroyed() && isChatGPTUrl() && !window.webContents.isLoading()) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.webContents.removeListener("did-finish-load", onFinish);
      window.webContents.removeListener("did-fail-load", onFail);
      if (error) reject(error);
      else resolve();
    };
    const onFinish = (): void => {
      if (isChatGPTUrl()) finish();
      else finish(new IntegrationFailure("BROWSER", `Unexpected ChatGPT page URL: ${window.webContents.getURL()}`));
    };
    const onFail = (_event: unknown, errorCode: number, errorDescription: string): void => {
      finish(new IntegrationFailure("BROWSER", `ChatGPT page load failed (${errorCode}): ${errorDescription}`));
    };
    const timer = setTimeout(() => {
      finish(new IntegrationFailure("BROWSER", "Timed out waiting for ChatGPT Web page"));
    }, Math.max(1, timeoutMs));

    window.webContents.once("did-finish-load", onFinish);
    window.webContents.once("did-fail-load", onFail);
    if (!window.webContents.isLoading()) {
      if (isChatGPTUrl()) finish();
      else finish(new IntegrationFailure("BROWSER", `Unexpected ChatGPT page URL: ${window.webContents.getURL()}`));
    }
  });
}

function normalizeFailure(error: unknown, fallbackStage: ZeroTokenIntegrationStage): IntegrationFailure {
  if (error instanceof IntegrationFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/LOGIN_REQUIRED|SESSION_EXPIRED|login required|session expired/i.test(message)) {
    return new IntegrationFailure("LOGIN", message);
  }
  if (/TIMEOUT|timed out|timeout|超时/i.test(message)) {
    return new IntegrationFailure(fallbackStage === "RESPONSE_PARSE" ? "RESPONSE_PARSE" : fallbackStage, message);
  }
  if (/MODEL_UNAVAILABLE|composer|send-button/i.test(message)) {
    return new IntegrationFailure("CHAT", message);
  }
  return new IntegrationFailure(fallbackStage || "UNKNOWN", message);
}
