import { request as httpRequest } from "node:http";
import type { ModelProviderClient, ModelProviderChatRequest } from "../../runtime/types";
import { ZeroTokenApiServer } from "../api/ZeroTokenApiServer";

export interface ZeroTokenApiTestResult {
  success: boolean;
  health: boolean;
  models: boolean;
  chat: boolean;
  stream: boolean;
  auth: boolean;
  cancel: boolean;
  concurrency: boolean;
  modelIds: string[];
  response?: string;
  streamResponse?: string;
  error?: string;
  latency: {
    health: number;
    models: number;
    chat: number;
    stream: number;
    cancel: number;
    concurrency: number;
    total: number;
  };
}

export interface ZeroTokenApiTestOptions {
  baseURL: string;
  log?: (line: string) => void;
  timeoutMs?: number;
}

const TEST_MESSAGE = "Reply only: OK";

/** Exercises the real localhost Gateway through its public HTTP contract. */
export async function runZeroTokenApiTest(options: ZeroTokenApiTestOptions): Promise<ZeroTokenApiTestResult> {
  const startedAt = Date.now();
  const log = options.log ?? ((line: string) => console.log(line));
  const requestTimeout = options.timeoutMs ?? 120_000;
  const result: ZeroTokenApiTestResult = {
    success: false,
    health: false,
    models: false,
    chat: false,
    stream: false,
    auth: false,
    cancel: false,
    concurrency: false,
    modelIds: [],
    latency: { health: 0, models: 0, chat: 0, stream: 0, cancel: 0, concurrency: 0, total: 0 },
  };

  try {
    const healthStartedAt = Date.now();
    const healthResponse = await fetch(`${options.baseURL}/health`, {
      signal: AbortSignal.timeout(requestTimeout),
    });
    const healthPayload = await healthResponse.json() as {
      status?: string;
      provider?: string;
      login?: boolean;
      model?: string;
    };
    result.latency.health = Date.now() - healthStartedAt;
    result.health = healthResponse.ok
      && healthPayload.status === "ready"
      && healthPayload.provider === "chatgpt-web"
      && healthPayload.login === true
      && healthPayload.model === "chatgpt-web";
    log(`API GET /health ${result.health ? "PASS" : "FAIL"}`);
    if (!result.health) throw new Error("/health did not report a ready ChatGPT Web provider");

    const modelsStartedAt = Date.now();
    const modelsResponse = await fetch(`${options.baseURL}/v1/models`, {
      signal: AbortSignal.timeout(requestTimeout),
    });
    const modelsPayload = await modelsResponse.json() as {
      object?: string;
      data?: Array<{ id?: string; object?: string }>;
    };
    result.latency.models = Date.now() - modelsStartedAt;
    result.modelIds = Array.isArray(modelsPayload.data)
      ? modelsPayload.data.map((item) => item.id ?? "").filter(Boolean)
      : [];
    result.models = modelsResponse.ok
      && modelsPayload.object === "list"
      && result.modelIds.includes("chatgpt-web");
    log(`API GET /v1/models ${result.models ? "PASS" : "FAIL"}`);
    if (!result.models) throw new Error("/v1/models returned an invalid OpenAI model list");

    const chatStartedAt = Date.now();
    const chatResponse = await fetch(`${options.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(requestTimeout),
      body: JSON.stringify({
        model: "chatgpt-web",
        messages: [{ role: "user", content: TEST_MESSAGE }],
        stream: false,
      }),
    });
    const chatPayload = await chatResponse.json() as {
      choices?: Array<{ message?: { role?: string; content?: string } }>;
      error?: { message?: string };
    };
    result.latency.chat = Date.now() - chatStartedAt;
    result.response = chatPayload.choices?.[0]?.message?.content?.trim() ?? "";
    result.chat = chatResponse.ok
      && chatPayload.choices?.[0]?.message?.role === "assistant"
      && /\bOK\b/i.test(result.response);
    log(`API POST /v1/chat/completions stream=false ${result.chat ? "PASS" : "FAIL"}`);
    if (!result.chat) throw new Error(chatPayload.error?.message || "non-stream chat response did not contain OK");

    const streamStartedAt = Date.now();
    const streamResponse = await fetch(`${options.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      signal: AbortSignal.timeout(requestTimeout),
      body: JSON.stringify({
        model: "chatgpt-web",
        messages: [{ role: "user", content: TEST_MESSAGE }],
        stream: true,
      }),
    });
    const streamText = await streamResponse.text();
    result.latency.stream = Date.now() - streamStartedAt;
    result.streamResponse = extractSseText(streamText);
    result.stream = streamResponse.ok
      && streamResponse.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
      && streamText.includes("data: [DONE]")
      && /\bOK\b/i.test(result.streamResponse);
    log(`API POST /v1/chat/completions stream=true ${result.stream ? "PASS" : "FAIL"}`);
    if (!result.stream) throw new Error("stream response did not contain a completed OK delta");

    const behavior = await runGatewayBehaviorTests(log, requestTimeout);
    result.auth = behavior.auth;
    result.cancel = behavior.cancel;
    result.concurrency = behavior.concurrency;
    result.latency.cancel = behavior.latency.cancel;
    result.latency.concurrency = behavior.latency.concurrency;
    result.success = result.health && result.models && result.chat && result.stream
      && result.auth && result.cancel && result.concurrency;
    if (!result.success) throw new Error(behavior.error || "Gateway behavior tests failed");
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`API Test FAIL: ${result.error}`);
    return result;
  } finally {
    result.latency.total = Date.now() - startedAt;
    log(`API Latency health=${result.latency.health} ms models=${result.latency.models} ms chat=${result.latency.chat} ms stream=${result.latency.stream} ms cancel=${result.latency.cancel} ms concurrency=${result.latency.concurrency} ms total=${result.latency.total} ms`);
  }
}

interface BehaviorResult {
  auth: boolean;
  cancel: boolean;
  concurrency: boolean;
  error?: string;
  latency: { cancel: number; concurrency: number };
}

/** Uses a deterministic in-process provider to test Gateway-only guarantees. */
async function runGatewayBehaviorTests(log: (line: string) => void, timeoutMs: number): Promise<BehaviorResult> {
  const provider = new GatewayTestProvider();
  const server = new ZeroTokenApiServer({
    host: "127.0.0.1",
    port: 0,
    provider,
    auth: { enabled: true, token: "zerotoken-test-token" },
  });
  const result: BehaviorResult = { auth: false, cancel: false, concurrency: false, latency: { cancel: 0, concurrency: 0 } };
  try {
    const address = await server.start();
    const unauthenticated = await fetch(`${address.baseURL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const authenticated = await fetch(`${address.baseURL}/health`, {
      headers: { Authorization: "Bearer zerotoken-test-token" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.auth = unauthenticated.status === 401 && authenticated.ok;
    log(`API auth disabled/enabled contract ${result.auth ? "PASS" : "FAIL"}`);

    const cancelStartedAt = Date.now();
    await abortHttpRequest(`${address.baseURL}/v1/chat/completions`, {
      model: "chatgpt-web",
      messages: [{ role: "user", content: "hold" }],
      stream: false,
    }, "zerotoken-test-token");
    await waitFor(() => provider.abortCalls > 0 && provider.active === 0, timeoutMs);
    const afterCancel = await postJson(address.baseURL, {
      model: "chatgpt-web",
      messages: [{ role: "user", content: "after cancel" }],
      stream: false,
    }, "zerotoken-test-token");
    result.latency.cancel = Date.now() - cancelStartedAt;
    result.cancel = afterCancel.ok && provider.abortCalls > 0 && provider.active === 0;
    log(`API client disconnect -> abort + queue release ${result.cancel ? "PASS" : "FAIL"}`);

    const concurrencyStartedAt = Date.now();
    const requests = [1, 2].map((index) => postJson(address.baseURL, {
      model: "chatgpt-web",
      messages: [{ role: "user", content: `concurrent ${index}` }],
      stream: false,
    }, "zerotoken-test-token"));
    const concurrentResponses = await Promise.all(requests);
    result.latency.concurrency = Date.now() - concurrencyStartedAt;
    result.concurrency = concurrentResponses.every((response) => response.ok)
      && provider.maxActive === 1;
    log(`API concurrent requests serialized ${result.concurrency ? "PASS" : "FAIL"}`);
    if (!result.auth || !result.cancel || !result.concurrency) {
      result.error = "Gateway auth, cancellation, or concurrency contract failed";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`API behavior tests FAIL: ${result.error}`);
  } finally {
    await server.stop();
  }
  return result;
}

class GatewayTestProvider implements ModelProviderClient {
  readonly id = "zerotoken" as const;
  readonly name = "Gateway test provider";
  active = 0;
  maxActive = 0;
  abortCalls = 0;
  private abortPending: (() => void) | null = null;

  async chatCompletion(request: ModelProviderChatRequest): Promise<string> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (request.messages.some((message) => message.content === "hold")) {
        await new Promise<void>((resolve) => {
          this.abortPending = resolve;
          setTimeout(resolve, 10_000);
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      request.onProgress?.("thinking", "OK");
      return "OK";
    } finally {
      this.abortPending = null;
      this.active -= 1;
    }
  }

  async healthCheck(): Promise<{ login: boolean; available: boolean; latency: number }> {
    return { login: true, available: true, latency: 1 };
  }

  async abortGeneration(): Promise<boolean> {
    this.abortCalls += 1;
    this.abortPending?.();
    return true;
  }
}

async function postJson(baseURL: string, payload: unknown, token: string): Promise<Response> {
  return fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(payload),
  });
}

async function abortHttpRequest(baseURL: string, payload: unknown, token: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const url = new URL("/v1/chat/completions", baseURL);
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    request.once("error", finish);
    request.once("response", (response) => {
      response.resume();
      response.once("end", finish);
    });
    request.end(JSON.stringify(payload));
    setTimeout(() => request.destroy(), 75);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Gateway request cleanup");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function extractSseText(body: string): string {
  const chunks: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const payload = JSON.parse(line.slice("data: ".length)) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.delta?.content;
      if (typeof content === "string") chunks.push(content);
    } catch {
      // Ignore malformed diagnostic lines; the final assertion will fail.
    }
  }
  return chunks.join("").trim();
}
