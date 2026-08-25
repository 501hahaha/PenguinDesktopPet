const path = require("node:path");
const { app } = require("electron");

app.commandLine.appendSwitch("disable-gpu");
app.setName("penguin-desktop-pet");
app.setPath("userData", path.join(app.getPath("appData"), "penguin-desktop-pet"));

async function main() {
  const { runZeroTokenSelfTest } = require("../out/zerotoken-self-test/src/main/zerotoken/tests/ZeroTokenSelfTest.js");
  await app.whenReady();
  const result = await runZeroTokenSelfTest();
  console.log("[ZeroToken Test Result]");
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error("[ZeroToken Test Result]");
  console.error(JSON.stringify({
    success: false,
    browser: false,
    session: false,
    login: false,
    chat: false,
    error: "NETWORK_ERROR",
    detail: error instanceof Error ? error.message : String(error),
  }, null, 2));
  app.exit(1);
});
