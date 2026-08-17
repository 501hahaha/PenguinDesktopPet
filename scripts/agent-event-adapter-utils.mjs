import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_VALUES = new Set(["desktop", "vscode", "cli"]);

export function readJsonInput(argv = process.argv.slice(2)) {
  const inline = argv.find((arg) => !arg.startsWith("-"));
  const text = inline && inline !== "-" ? inline : readFileSync(0, "utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function envValue(name, fallback) {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

export function bridgeToken() {
  const direct = envValue("PENGUIN_AGENT_BRIDGE_TOKEN", "");
  if (direct) return direct;
  const tokenFile = envValue("PENGUIN_AGENT_BRIDGE_TOKEN_FILE", "");
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function surfaceFromEnv(fallback = "cli") {
  const value = envValue("PENGUIN_AGENT_SURFACE", fallback);
  return SOURCE_VALUES.has(value) ? value : "cli";
}

export function agentIdentity(defaultId, defaultName) {
  return {
    agentId: envValue("PENGUIN_AGENT_ID", defaultId),
    displayName: envValue("PENGUIN_AGENT_NAME", defaultName),
  };
}

export function stableEventId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:${digest}`;
}

export function sendToPet(source, payload) {
  const sender = fileURLToPath(new URL("./agent-event-bridge.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [sender, "--source", source, "-"], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
    env: process.env,
    windowsHide: true,
    timeout: 2_500,
    killSignal: "SIGTERM",
  });
  if (result.status === 0) return true;
  const reason = String(result.stderr ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 180);
  if (process.env.PENGUIN_AGENT_BRIDGE_REQUIRED === "1") {
    console.error(`agent-event-adapter: bridge delivery failed${reason ? `: ${reason}` : ""}`);
    process.exitCode = 1;
  }
  return false;
}
