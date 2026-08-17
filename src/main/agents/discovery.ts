import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AgentProvider } from "../../settings/types";
import type {
  AgentConfig,
  AgentDiscoveryStatus,
  AgentHealthCheckErrorCode,
  AgentHealthCheckMode,
  AgentHealthCheckResult,
  AgentSourceApp,
  AgentTestResult,
  LocalAgentInfo,
} from "../../agents/types";
import { parseCommandArgs } from "../../agents/command";
import { readCcSwitchRuntimeConfig, type CcSwitchRuntimeConfig } from "../ccSwitch";
import { resolveAgentCommand, runVersionProbe } from "./processProbe";

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 3_500;
const HEALTH_CHECK_TIMEOUT_MS = 45_000;
const HEALTH_CHECK_MAX_BUFFER = 512 * 1024;
const HEALTH_CHECK_PROMPT =
  "这是 Penguin Desktop Pet 的 Agent 健康检查。请只回复 PENGUIN_AGENT_HEALTH_OK，不要调用工具、读取或写入文件、联网、发送消息，也不要输出其他内容。";

interface AgentCandidate {
  id: string;
  name: string;
  command: string | null;
  sourceApp: AgentSourceApp;
  provider: AgentProvider | null;
  kind: "cli" | "desktop";
}

// This is an extensible candidate registry, not a claim that every CLI uses
// the same protocol. Unsupported tools are shown as discovered-only until an
// adapter is implemented.
const AGENT_CANDIDATES: AgentCandidate[] = [
  { id: "claude-code", name: "Claude Code", command: "claude", sourceApp: "claude-code", provider: "claude", kind: "cli" },
  { id: "claude-desktop", name: "Claude Desktop", command: null, sourceApp: "claude-desktop", provider: null, kind: "desktop" },
  { id: "codex", name: "Codex", command: "codex", sourceApp: "codex", provider: "codex", kind: "cli" },
  { id: "gemini-cli", name: "Gemini CLI", command: "gemini", sourceApp: "gemini", provider: null, kind: "cli" },
  { id: "grok-build", name: "Grok Build", command: null, sourceApp: "unknown", provider: null, kind: "desktop" },
  { id: "opencode", name: "OpenCode", command: "opencode", sourceApp: "opencode", provider: null, kind: "cli" },
  { id: "openclaw", name: "OpenClaw", command: "openclaw", sourceApp: "openclaw", provider: "custom", kind: "cli" },
  { id: "hermes", name: "Hermes Agent", command: "hermes", sourceApp: "hermes", provider: "hermes", kind: "cli" },
];

function firstMeaningfulLine(value: string | undefined): string | null {
  return (
    value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 120) ?? null
  );
}

function isCommandMissing(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException & { stderr?: string };
  if (candidate.code === "ENOENT") return true;
  const detail = `${candidate.message ?? ""} ${candidate.stderr ?? ""}`.toLowerCase();
  return detail.includes("not recognized") || detail.includes("not found") || detail.includes("cannot find");
}

async function probeCandidate(candidate: AgentCandidate): Promise<LocalAgentInfo> {
  if (candidate.kind === "desktop") {
    return {
      ...candidate,
      version: null,
      status: "desktop-only",
      detail: "桌面工具，等待桌面应用适配",
      supported: false,
      installSupport: "official-guide",
    };
  }

  try {
    const resolved = await resolveAgentCommand(candidate.command as string);
    const result = await runVersionProbe(resolved.file, [...resolved.prefixArgs, "--version"], { timeoutMs: DISCOVERY_TIMEOUT_MS });
    const version = firstMeaningfulLine(result.stdout) ?? firstMeaningfulLine(result.stderr);
    return {
      ...candidate,
      version,
      status: "available",
      detail: version ? "命令可执行" : "命令可执行，但未返回版本号",
      supported: candidate.provider !== null,
      installSupport: "package-manager",
    };
  } catch (error) {
    const status: AgentDiscoveryStatus = isCommandMissing(error) ? "not-installed" : "error";
    return {
      ...candidate,
      version: null,
      status,
      detail: status === "not-installed" ? "未在本机命令路径中找到" : "命令存在，但检测失败",
      supported: candidate.provider !== null,
      installSupport: "package-manager",
    };
  }
}

export async function discoverLocalAgents(): Promise<LocalAgentInfo[]> {
  return Promise.all(AGENT_CANDIDATES.map((candidate) => probeCandidate(candidate)));
}

export async function testLocalAgent(config: AgentConfig): Promise<AgentTestResult> {
  try {
    const resolved = await resolveAgentCommand(config.command);
    const result = await runVersionProbe(
      resolved.file,
      [...resolved.prefixArgs, ...parseCommandArgs(config.args), "--version"],
      { cwd: config.workingDirectory || undefined, timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    const version = firstMeaningfulLine(result.stdout) ?? firstMeaningfulLine(result.stderr);
    return {
      ok: true,
      version,
      detail: version ? `命令可执行：${version}` : "命令可执行，但未返回版本信息",
    };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = firstMeaningfulLine(candidate.stderr) ?? candidate.message ?? "命令测试失败";
    return { ok: false, version: null, detail: detail.slice(0, 240) };
  }
}

function classifyHealthCheckError(error: unknown): AgentHealthCheckErrorCode {
  const candidate = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  const detail = `${candidate.message ?? ""} ${candidate.stderr ?? ""} ${candidate.stdout ?? ""}`.toLowerCase();
  if (isCommandMissing(error)) return "not-installed";
  if (/429|rate.?limit|quota|credit|budget|限流|额度|配额/.test(detail)) return "rate-limited";
  if (/401|403|unauthori[sz]|authentication failed|login required|invalid api key|invalid token|未登录|认证失败/.test(detail)) {
    return "authentication";
  }
  if (candidate.code === "ETIMEDOUT" || /timeout|timed out|超时/.test(detail)) return "timeout";
  if (/empty|空回复|未返回/.test(detail)) return "empty-response";
  return "failed";
}

function sanitizeHealthPreview(value: string): string {
  return value
    .replace(/\r?\n+/g, " ")
    .replace(/\bsession[_ -]?id\s*:\s*[^\s,;]+/gi, "session_id: <redacted>")
    .replace(/\b(?:bearer|token|api[- ]?key|secret)\s*[:=]?\s*[^\s,;]+/gi, "$1: <redacted>")
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "<local-path>")
    .replace(/\/(?:Users|Users|home|private|var)\/[^\s"'<>]+/gi, "<local-path>")
    .trim()
    .slice(0, 160);
}

interface HealthCheckCommand {
  args: string[];
  mode: AgentHealthCheckMode;
  stdinPrompt?: string;
}

function healthCheckCommand(config: AgentConfig): HealthCheckCommand {
  const configuredArgs = parseCommandArgs(config.args);
  if (config.sourceApp === "openclaw") {
    return {
      args: [
        ...configuredArgs,
        "agent",
        "--json",
        "--session-key",
        "agent:penguin-desktop-pet:health-check",
        "--message",
        HEALTH_CHECK_PROMPT,
        "--timeout",
        String(Math.round(HEALTH_CHECK_TIMEOUT_MS / 1000)),
      ],
      mode: "custom-command",
    };
  }
  if (config.provider === "claude") {
    return {
      args: [
        ...configuredArgs,
        "-p",
        "--output-format",
        "text",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ],
      mode: "no-tools",
      stdinPrompt: HEALTH_CHECK_PROMPT,
    };
  }
  if (config.provider === "codex") {
    return {
      args: [
        ...configuredArgs,
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
      ],
      mode: "read-only",
      stdinPrompt: HEALTH_CHECK_PROMPT,
    };
  }
  if (config.provider === "hermes") {
    return {
      args: [
        ...configuredArgs,
        "chat",
        "-q",
        HEALTH_CHECK_PROMPT,
        "--quiet",
        "--ignore-rules",
        "--toolsets",
        // Hermes treats an empty --toolsets value as “use defaults”. The
        // built-in context_engine toolset is valid but contains no tools.
        "context_engine",
      ],
      mode: "no-tools",
    };
  }
  return {
    args: [...configuredArgs, HEALTH_CHECK_PROMPT],
    mode: "custom-command",
  };
}

async function resolveWindowsCommand(command: string): Promise<string> {
  if (/[\\/]/.test(command) || /\.(?:cmd|bat|exe)$/i.test(command)) return command;
  try {
    const result = await execFileAsync("where.exe", [command], {
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
    const candidates = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    return candidates.find((item) => /\.(?:cmd|bat)$/i.test(item)) ?? candidates[0] ?? command;
  } catch {
    return command;
  }
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function formatWindowsCommandArg(value: string): string {
  return value === "" || /\s/.test(value) ? quoteWindowsCommandArg(value) : value;
}

function spawnHealthCheckProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer: number; windowsHide: boolean },
  stdinPrompt: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Agent 健康检查超时"));
    }, options.timeout);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const annotated = error as Error & { stdout?: string; stderr?: string };
        annotated.stdout = stdout;
        annotated.stderr = stderr;
        reject(annotated);
      } else {
        resolve({ stdout, stderr });
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > options.maxBuffer) {
        child.kill();
        finish(new Error("Agent 健康检查输出过大"));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > options.maxBuffer) {
        child.kill();
        finish(new Error("Agent 健康检查错误输出过大"));
      }
    });
    child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`Agent 健康检查进程失败（code=${code ?? "null"}, signal=${signal ?? "none"}）`));
      }
    });
    child.stdin?.end(stdinPrompt);
  });
}

async function executeHealthCheckCommand(
  config: AgentConfig,
  args: string[],
  stdinPrompt?: string,
): Promise<{ stdout: string; stderr: string }> {
  const commonOptions = {
    cwd: config.workingDirectory || undefined,
    timeout: HEALTH_CHECK_TIMEOUT_MS,
    maxBuffer: HEALTH_CHECK_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8" as const,
  };

  if (process.platform !== "win32") {
    return execFileAsync(config.command, args, { ...commonOptions, shell: false }) as Promise<{ stdout: string; stderr: string }>;
  }

  // Native .exe commands can receive arguments directly. This is the normal
  // path for Hermes and most custom commands.
  const resolvedCommand = await resolveWindowsCommand(config.command);
  if (/\.exe$/i.test(resolvedCommand)) {
    return execFileAsync(resolvedCommand, args, { ...commonOptions, shell: false }) as Promise<{ stdout: string; stderr: string }>;
  }

  // Windows .cmd shims cannot be launched with execFile(shell:false). For
  // built-in Claude/Codex adapters, send the health prompt over stdin so cmd
  // never has to parse spaces or punctuation inside the prompt.
  if (stdinPrompt) {
    const commandToken = /\s/.test(resolvedCommand) ? quoteWindowsCommandArg(resolvedCommand) : resolvedCommand;
    const commandLine = [commandToken, ...args.map(formatWindowsCommandArg)].join(" ");
    return spawnHealthCheckProcess(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", commandLine],
      commonOptions,
      stdinPrompt,
    );
  }

  return execFileAsync(config.command, args, { ...commonOptions, shell: true }) as Promise<{ stdout: string; stderr: string }>;
}

function ccSwitchHealthEndpoint(runtime: CcSwitchRuntimeConfig): string {
  const base = runtime.baseUrl.replace(/\/+$/, "");
  const path = runtime.apiStyle === "anthropic" ? "/messages" : "/chat/completions";
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

function ccSwitchHealthReply(value: unknown, apiStyle: CcSwitchRuntimeConfig["apiStyle"]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (apiStyle === "anthropic" && Array.isArray(record.content)) {
    return record.content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("")
      .trim();
  }
  const choice = Array.isArray(record.choices) ? record.choices[0] : null;
  if (!choice || typeof choice !== "object") return "";
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content.trim() : "";
}

async function testCcSwitchRequest(runtime: CcSwitchRuntimeConfig, fallbackModel: string | null | undefined): Promise<AgentHealthCheckResult> {
  const startedAt = Date.now();
  const model = runtime.model || fallbackModel;
  if (!model) {
    return {
      ok: false,
      errorCode: "failed",
      mode: "no-tools",
      durationMs: 0,
      responsePreview: null,
      detail: "CC Switch 当前配置没有可用模型，请重新导入 CCS 当前配置",
    };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (runtime.apiStyle === "anthropic") {
    headers["x-api-key"] = runtime.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${runtime.apiKey}`;
  }
  try {
    const response = await fetch(ccSwitchHealthEndpoint(runtime), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: HEALTH_CHECK_PROMPT }],
      }),
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`CC Switch 当前 API HTTP ${response.status}`);
    }
    const reply = ccSwitchHealthReply(await response.json(), runtime.apiStyle);
    if (!reply) throw new Error("CC Switch 当前 API 返回为空");
    return {
      ok: true,
      errorCode: "ok",
      mode: "no-tools",
      durationMs: Date.now() - startedAt,
      responsePreview: sanitizeHealthPreview(reply),
      detail: `CC Switch 当前 API 请求成功：${Date.now() - startedAt} ms`,
    };
  } catch (error) {
    const errorCode = classifyHealthCheckError(error);
    return {
      ok: false,
      errorCode,
      mode: "no-tools",
      durationMs: Date.now() - startedAt,
      responsePreview: null,
      detail: "CC Switch 当前 API 请求失败，请检查导入配置、模型和网络状态",
    };
  }
}

export async function testAgentRequest(config: AgentConfig, ccSwitchRuntime?: CcSwitchRuntimeConfig): Promise<AgentHealthCheckResult> {
  const hermesFallback = config.provider === "hermes"
    ? readCcSwitchRuntimeConfig("hermes", undefined, true)
    : null;
  if (ccSwitchRuntime || hermesFallback) {
    return testCcSwitchRequest(ccSwitchRuntime ?? hermesFallback!, config.ccSwitchCurrentConfig?.model);
  }
  const startedAt = Date.now();
  const request = healthCheckCommand(config);
  try {
    const result = await executeHealthCheckCommand(config, request.args, request.stdinPrompt);
    const response = sanitizeHealthPreview(result.stdout || result.stderr || "");
    if (!response) {
      return {
        ok: false,
        errorCode: "empty-response",
        mode: request.mode,
        durationMs: Date.now() - startedAt,
        responsePreview: null,
        detail: "请求已执行，但 Agent 返回为空",
      };
    }
    return {
      ok: true,
      errorCode: "ok",
      mode: request.mode,
      durationMs: Date.now() - startedAt,
      responsePreview: response,
      detail: `真实请求成功（${Date.now() - startedAt} ms）`,
    };
  } catch (error) {
    const errorCode = classifyHealthCheckError(error);
    const detailByCode: Record<AgentHealthCheckErrorCode, string> = {
      ok: "真实请求成功",
      "not-installed": "找不到 Agent 命令，请确认已安装并加入 PATH",
      authentication: "认证失败，请先登录 Agent 或检查凭证配置",
      "rate-limited": "请求被限流或额度不足，请稍后重试或检查账户额度",
      timeout: "真实请求超时，请检查网络、代理和 Agent 服务状态",
      "empty-response": "Agent 返回为空，请检查模型或运行配置",
      failed: "真实请求失败，请先查看命令检查结果并检查 Agent 日志",
    };
    return {
      ok: false,
      errorCode,
      mode: request.mode,
      durationMs: Date.now() - startedAt,
      responsePreview: null,
      detail: detailByCode[errorCode],
    };
  }
}
