import { BrowserManager } from "../BrowserManager";
import { SessionManager } from "../SessionManager";
import { ChatGPTWebAdapter } from "../providers/ChatGPTWebAdapter";
import { createWebAIClient } from "../WebAIClient";
import { createZeroTokenProvider } from "../../agents/ZeroTokenProvider";
import type { ZeroTokenSettings } from "../../../settings/types";

const CHATGPT_PROVIDER = "chatgpt-web" as const;
const CHATGPT_PARTITION = "persist:zerotoken-chatgpt";
const TEST_MESSAGE = "Reply only: OK";

export interface ZeroTokenSelfTestResult {
  success: boolean;
  browser: boolean;
  session: boolean;
  login: boolean;
  chat: boolean;
  error?: "LOGIN_REQUIRED" | "SESSION_EXPIRED" | "NETWORK_ERROR" | "PAGE_ERROR" | "TIMEOUT";
  latency?: number;
  loginLatency?: number;
  chatLatency?: number;
  response?: string;
}

export interface ZeroTokenSelfTestOptions {
  timeoutMs?: number;
  log?: (line: string) => void;
}

function testSettings(): ZeroTokenSettings {
  return {
    enabled: true,
    provider: CHATGPT_PROVIDER,
    // Phase 2 never reads these legacy Runtime fields. They are supplied only
    // to satisfy the existing persisted settings contract.
    baseUrl: "",
    runtimePath: "",
    model: "",
    timeout: 120_000,
    autoStart: false,
  };
}

/**
 * Runs the real Phase 2 chain against the user's persistent ChatGPT session.
 * It never clears cookies, creates a temporary partition, or writes results to
 * pet settings.
 */
export async function runZeroTokenSelfTest(options: ZeroTokenSelfTestOptions = {}): Promise<ZeroTokenSelfTestResult> {
  const startedAt = Date.now();
  const log = options.log ?? ((line: string) => console.log(line));
  const browserManager = new BrowserManager();
  const sessionManager = new SessionManager(browserManager);
  const provider = createZeroTokenProvider(
    testSettings(),
    createWebAIClient([new ChatGPTWebAdapter(browserManager, sessionManager)]),
  );
  const result: ZeroTokenSelfTestResult = {
    success: false,
    browser: false,
    session: false,
    login: false,
    chat: false,
  };

  try {
    const partition = browserManager.getPartition(CHATGPT_PROVIDER);
    const chatSession = browserManager.getSession(CHATGPT_PROVIDER);
    // Calling cookies.get verifies that Electron opened the real persistent
    // partition. Cookie values are deliberately never logged or returned.
    await chatSession.cookies.get({ url: "https://chatgpt.com/" });
    result.browser = partition === CHATGPT_PARTITION && Boolean(chatSession);
    log("[ZeroToken Test]");
    log(`Browser Session: ${result.browser ? "PASS" : "FAIL"}`);
    if (!result.browser) {
      result.error = "NETWORK_ERROR";
      return finish(result, startedAt, log);
    }

    const loginStartedAt = Date.now();
    const loggedIn = await sessionManager.checkLogin(CHATGPT_PROVIDER);
    result.loginLatency = Date.now() - loginStartedAt;
    result.session = true;
    result.login = loggedIn;
    log(`Login: ${loggedIn ? "PASS" : "LOGIN_REQUIRED"}`);
    log(`Latency: ${result.loginLatency} ms`);
    if (!loggedIn) {
      result.error = "LOGIN_REQUIRED";
      return finish(result, startedAt, log);
    }

    const chatStartedAt = Date.now();
    const completion = await provider.chatCompletion({
      messages: [{ role: "user", content: TEST_MESSAGE }],
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    result.chatLatency = Date.now() - chatStartedAt;
    result.response = completion;
    result.chat = completion.trim().length > 0 && /\bOK\b/i.test(completion);
    log(`Chat: ${result.chat ? "PASS" : "FAIL"}`);
    log(`Response: ${completion.trim() || "<empty>"}`);
    log(`Latency: ${result.chatLatency} ms`);
    if (!result.chat) result.error = "PAGE_ERROR";
    return finish(result, startedAt, log);
  } catch (error) {
    result.error = classifyError(error);
    log(`Chat: FAIL (${result.error})`);
    return finish(result, startedAt, log);
  } finally {
    // Closing the test window does not clear or mutate the persistent Session.
    browserManager.dispose();
  }
}

function finish(
  result: ZeroTokenSelfTestResult,
  startedAt: number,
  log: (line: string) => void,
): ZeroTokenSelfTestResult {
  result.latency = Date.now() - startedAt;
  result.success = result.browser && result.session && result.login && result.chat;
  log(`Self Test: ${result.success ? "PASS" : "FAIL"}`);
  return result;
}

function classifyError(error: unknown): ZeroTokenSelfTestResult["error"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/LOGIN_REQUIRED/i.test(message)) return "LOGIN_REQUIRED";
  if (/SESSION_EXPIRED/i.test(message)) return "SESSION_EXPIRED";
  if (/TIMEOUT|timed out|超时/i.test(message)) return "TIMEOUT";
  if (/MODEL_UNAVAILABLE|composer|send-button|PAGE_ERROR/i.test(message)) return "PAGE_ERROR";
  return "NETWORK_ERROR";
}
