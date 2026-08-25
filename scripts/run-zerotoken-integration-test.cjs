const { app } = require("electron");

app.commandLine.appendSwitch("disable-gpu");
// Match the desktop package identity so Electron derives the same default
// userData directory. We intentionally do not call app.setPath("userData").
app.setName("penguin-desktop-pet");

async function main() {
  const { runZeroTokenIntegrationTest } = require("../out/zerotoken-self-test/src/main/zerotoken/tests/ZeroTokenIntegrationTest.js");
  await app.whenReady();
  const result = await runZeroTokenIntegrationTest();
  let apiResult = {
    success: false,
    health: false,
    models: false,
    chat: false,
    stream: false,
    auth: false,
    cancel: false,
    concurrency: false,
    modelIds: [],
    error: "API test was not started",
    latency: { health: 0, models: 0, chat: 0, stream: 0, cancel: 0, concurrency: 0, total: 0 },
  };

  {
    const { BrowserManager } = require("../out/zerotoken-self-test/src/main/zerotoken/BrowserManager.js");
    const { SessionManager } = require("../out/zerotoken-self-test/src/main/zerotoken/SessionManager.js");
    const { ChatGPTWebAdapter } = require("../out/zerotoken-self-test/src/main/zerotoken/providers/ChatGPTWebAdapter.js");
    const { createWebAIClient } = require("../out/zerotoken-self-test/src/main/zerotoken/WebAIClient.js");
    const { createZeroTokenProvider } = require("../out/zerotoken-self-test/src/main/agents/ZeroTokenProvider.js");
    const { ZeroTokenApiServer } = require("../out/zerotoken-self-test/src/main/zerotoken/api/ZeroTokenApiServer.js");
    const { runZeroTokenApiTest } = require("../out/zerotoken-self-test/src/main/zerotoken/tests/ZeroTokenApiTest.js");
    const browserManager = new BrowserManager(false);
    const sessionManager = new SessionManager(browserManager);
    const provider = createZeroTokenProvider({
      enabled: true,
      provider: "chatgpt-web",
      baseUrl: "",
      runtimePath: "",
      model: "",
      timeout: 60_000,
      autoStart: false,
    }, createWebAIClient([new ChatGPTWebAdapter(browserManager, sessionManager)]));
    const apiServer = new ZeroTokenApiServer({
      host: "127.0.0.1",
      port: 3456,
      provider,
    });
    try {
      const address = await apiServer.start();
      console.log(`[ZeroToken API] started ${address.baseURL}`);
      if (!result.success) console.log("[ZeroToken API] running independently after integration failure");
      apiResult = await runZeroTokenApiTest({ baseURL: address.baseURL });
    } catch (error) {
      apiResult = {
        ...apiResult,
        error: error instanceof Error ? error.message : String(error),
      };
      console.error(`[ZeroToken API] test setup failed: ${apiResult.error}`);
    } finally {
      await apiServer.stop();
      browserManager.dispose();
    }
  }

  const combined = {
    ...result,
    api: apiResult,
    success: result.success && apiResult.success,
  };
  console.log("[ZeroToken Integration Test Result]");
  console.log(JSON.stringify(combined, null, 2));
  app.exit(combined.success ? 0 : 1);
}

main().catch((error) => {
  console.error("[ZeroToken Integration Test Result]");
  console.error(JSON.stringify({
    success: false,
    environment: false,
    browser: false,
    session: false,
    login: false,
    provider: false,
    recovery: false,
    chat: false,
    api: {
      success: false,
      models: false,
      chat: false,
      stream: false,
      health: false,
      auth: false,
      cancel: false,
      concurrency: false,
      modelIds: [],
      error: error instanceof Error ? error.message : String(error),
      latency: { health: 0, models: 0, chat: 0, stream: 0, cancel: 0, concurrency: 0, total: 0 },
    },
    failedStage: "UNKNOWN",
    error: error instanceof Error ? error.message : String(error),
    latency: {
      browserTime: 0,
      sessionTime: 0,
      loginTime: 0,
      providerTime: 0,
      recoveryTime: 0,
      chatTime: 0,
      totalTime: 0,
    },
  }, null, 2));
  app.exit(1);
});
