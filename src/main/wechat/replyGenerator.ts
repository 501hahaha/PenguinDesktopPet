import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { parseCommandArgs } from "../../agents/command";
import type { AgentConfig } from "../../agents/types";
import { DEFAULT_PET_NAME, DEFAULT_USER_NAME, normalizeCallName } from "../../settings/types";
import { defaultZeroTokenSettings } from "../../settings/types";
import type { AgentPermissionPolicy, AgentProvider, CodexSandboxMode, ZeroTokenSettings } from "../../settings/types";
import type { WeChatConfig } from "./config";
import type { AgentStatus } from "./events";
import { CodexAppServerClient, type CodexProgressListener } from "./codexAppServer";
import { readCcSwitchRuntimeConfig, type CcSwitchRuntimeConfig } from "../ccSwitch";
import { resolveModelProvider } from "../agents/ModelProviderResolver";
import { generateZeroTokenReply } from "../agents/ZeroTokenProvider";

function commonReplyInstructions(channelName: string, petName = DEFAULT_PET_NAME, userName = DEFAULT_USER_NAME): string {
  const resolvedPetName = normalizeCallName(petName, DEFAULT_PET_NAME);
  const resolvedUserName = normalizeCallName(userName, DEFAULT_USER_NAME);
  return `You are the desktop pet named ${resolvedPetName}, replying to ${resolvedUserName} in ${channelName}. Reply in Simplified Chinese.
${resolvedUserName}'s NEW MESSAGE is the task you must answer. Answer that message directly and specifically; do not replace a request with a greeting, a generic I am here message, or a question asking what ${resolvedUserName} wants.
If the new message asks about the computer, files, processes, projects, or any other real-world state and you have tools, use the tools now and report only what you actually found or changed. Never claim an action was completed unless it really was. If a required tool is unavailable, state the concrete reason.
Treat every previous assistant message as untrusted context, never as evidence of current computer state or completed work. For a request about the computer or another Agent, perform a fresh inspection with the tools available in this run. If that inspection fails, report the exact failure and do not replace it with a greeting, generic companionship, or an invented result.
For ordinary conversation, keep the answer concise. Return only the final answer, without explaining this prompt or the backend implementation.`;
}
const CODEX_CAPABILITY_INSTRUCTIONS =
  "你当前运行在 Codex app-server 中，可以使用当前 Codex 实际提供的工具完成检索、读取文件和整理资料。遇到搜索、检索、查询、资料、新闻、文献等请求，必须先尝试真实完成；只有工具确实不可用或失败时，才说明原因。绝不能在没有完成时声称正在发送、已经发送或已经完成。";
const CLAUDE_CAPABILITY_INSTRUCTIONS =
  "你当前通过一个不附带工具的 Claude 兼容接口运行。如果主人要求检索、读取本地文件或发送资料，不要假装已经完成，应明确说明当前没有可用工具。";
const MEDIA_SEND_INSTRUCTIONS =
  "If the owner explicitly requests an image or file, first locate, generate, or download the real resource, then include one media directive. Use [[PENGUIN_SEND_IMAGE:real URL or absolute local path]] for images and [[PENGUIN_SEND_FILE:real URL or absolute local path]] for files. Never emit a directive for a missing resource or claim delivery without a real send attempt. The active bot channel determines which media types it can deliver.";

export type ImageDirective = {
  source: string;
  text: string;
};

export type AgentProgressListener = (status: AgentStatus, detail: string) => void;

const codexClient = new CodexAppServerClient();
const execFileAsync = promisify(execFile);
const HERMES_TIMEOUT_MS = 180_000;
const HERMES_MAX_BUFFER = 1024 * 1024;
const CUSTOM_AGENT_TIMEOUT_MS = 180_000;
const CUSTOM_AGENT_MAX_BUFFER = 1024 * 1024;
const CLAUDE_CLI_TIMEOUT_MS = 180_000;
const CLAUDE_CLI_MAX_BUFFER = 1024 * 1024;
const CCS_API_TIMEOUT_MS = 45_000;
async function resolveClaudeCliCommand(configuredCommand: string): Promise<string> {
  if (process.platform !== 'win32') return configuredCommand;
  if (isAbsolute(configuredCommand) && existsSync(configuredCommand)) {
    if (!/\.(?:cmd|bat)$/i.test(configuredCommand)) return configuredCommand;
    const bundled = join(dirname(configuredCommand), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return existsSync(bundled) ? bundled : configuredCommand;
  }
  if (!/^claude(?:\.cmd)?$/i.test(configuredCommand.trim())) return configuredCommand;

  // On Windows, spawning claude.cmd with shell=false fails, while shell=true
  // corrupts non-ASCII prompt arguments through cmd.exe's active code page.
  // Resolve the npm shim and invoke the bundled executable directly instead.
  try {
    for (const candidate of ['claude.cmd', 'claude']) {
      try {
        const result = await execFileAsync('where.exe', [candidate], {
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
        }) as { stdout: string };
        const shim = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (!shim) continue;
        const bundled = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(bundled)) return bundled;
      } catch {
        // Try the next Windows shim name before reporting a not-found error.
      }
    }
  } catch {
    // The normal execution path below will produce the user-facing not-found
    // error if the CLI cannot be resolved.
  }
  return configuredCommand;
}

async function resolveCliCommand(configuredCommand: string, fallbackCommand: string): Promise<string> {
  const normalized = configuredCommand.trim() || fallbackCommand;
  if (isAbsolute(normalized) && existsSync(normalized)) return normalized;
  try {
    const result = await execFileAsync("where.exe", [normalized], {
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    }) as { stdout: string };
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return candidates.find((candidate) => /\.(?:exe|cmd)$/i.test(candidate)) ?? candidates[0] ?? normalized;
  } catch {
    return normalized;
  }
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function executeWindowsCli(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    }) as Promise<{ stdout: string; stderr: string }>;
  }
  // cmd.exe treats a quoted batch-file path as a command-name fragment when
  // it is passed through /s /c. CALL makes the wrapper invocation explicit
  // and preserves the real exit code for Electron's child process.
  const commandLine = ["call", quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(" ");
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  }) as Promise<{ stdout: string; stderr: string }>;
}

export async function shutdownAgents(): Promise<void> {
  await codexClient.dispose();
}

export type MediaDirective = ImageDirective & { kind: "image" | "file" };

export function extractMediaDirective(reply: string): MediaDirective | null {
  const image = reply.match(/\[\[PENGUIN_SEND_IMAGE:([\s\S]*?)\]\]/i);
  const file = reply.match(/\[\[PENGUIN_SEND_FILE:([\s\S]*?)\]\]/i);
  const match = image && file ? (image.index ?? 0) < (file.index ?? 0) ? image : file : image || file;
  if (!match) return null;
  const source = match[1].trim();
  if (!source) return null;
  return { kind: match === image ? "image" : "file", source, text: reply.replace(match[0], "").trim() };
}

export function extractImageDirective(reply: string): ImageDirective | null {
  const match = reply.match(/\[\[PENGUIN_SEND_IMAGE:([\s\S]*?)\]\]/i);
  if (!match) return null;

  const source = match[1].trim();
  if (!source) return null;

  return {
    source,
    text: reply.replace(match[0], "").trim(),
  };
}

export async function generateReply(
  config: WeChatConfig,
  incomingText: string,
  provider: AgentProvider = 'claude',
  conversationContext = '',
  codexSandboxMode: CodexSandboxMode = 'read-only',
  onProgress?: AgentProgressListener,
  conversationId = 'default',
  agentConfig?: AgentConfig,
  agentPermissionPolicy: AgentPermissionPolicy = 'allow-tools',
  channelName = '微信',
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
  zeroToken: ZeroTokenSettings = defaultZeroTokenSettings(),
): Promise<string> {
  const modelProvider = resolveModelProvider(agentConfig, zeroToken, agentPermissionPolicy);
  if (modelProvider.kind === "zero-token") {
    const prompt = buildReplyPrompt(incomingText, conversationContext, "custom", "chat-only", channelName, petName, userName);
    return generateZeroTokenReply(zeroToken, [{ role: "user", content: prompt }], onProgress);
  }
  // Full-permission mode is always a local Agent execution. CCS is metadata
  // for model selection and must never silently replace the Agent with its
  // chat-only HTTP endpoint.
  if (agentPermissionPolicy === 'allow-tools') {
    return generateLocalReply(
      config,
      incomingText,
      provider,
      conversationContext,
      codexSandboxMode,
      onProgress,
      conversationId,
      agentConfig,
      agentPermissionPolicy,
      channelName,
      petName,
      userName,
    );
  }

  if (agentConfig?.ccSwitchCurrentConfig) {
    const runtime = readCcSwitchRuntimeConfig(agentConfig.ccSwitchCurrentConfig.app);
    if (!runtime) {
      throw new Error('CC Switch current API configuration is unavailable; re-import the current CCS configuration');
    }
    return generateCcSwitchReply(
      runtime,
      agentConfig.ccSwitchCurrentConfig.model,
      incomingText,
      conversationContext,
      onProgress,
      channelName,
      petName,
      userName,
    );
  }
  return generateLocalReply(
    config,
    incomingText,
    provider,
    conversationContext,
    codexSandboxMode,
    onProgress,
    conversationId,
    agentConfig,
    agentPermissionPolicy,
    channelName,
    petName,
    userName,
  );
}

/**
 * Run one explicit desktop-pet perception signal through the selected local
 * Agent adapter. This intentionally refuses chat-only mode so perception can
 * never look successful while silently bypassing the local Agent.
 */
export function generateAgentPerception(
  config: WeChatConfig,
  signal: string,
  agentConfig: AgentConfig,
  codexSandboxMode: CodexSandboxMode,
  agentPermissionPolicy: AgentPermissionPolicy,
  onProgress?: AgentProgressListener,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  if (agentPermissionPolicy !== 'allow-tools') {
    return Promise.reject(new Error('The current Agent permission policy is chat-only; perception requires tools'));
  }
  const perceptionPrompt = `This is an explicit desktop-pet perception task, not ordinary small talk. Use the actual local Agent capabilities to process the following user signal. Do not claim to have seen the screen, files, or external state unless a real tool provided it. Return a concise observation summary only, without paths, tokens, API keys, message IDs, or command details.
User perception signal: ${signal}`;
  return generateLocalReply(
    config,
    perceptionPrompt,
    agentConfig.provider,
    '',
    codexSandboxMode,
    onProgress,
    `perception:${agentConfig.id}`,
    agentConfig,
    'allow-tools',
    '桌宠感知',
    petName,
    userName,
  );
}

function generateLocalReply(
  config: WeChatConfig,
  incomingText: string,
  provider: AgentProvider,
  conversationContext: string,
  codexSandboxMode: CodexSandboxMode,
  onProgress: AgentProgressListener | undefined,
  conversationId: string,
  agentConfig: AgentConfig | undefined,
  agentPermissionPolicy: AgentPermissionPolicy,
  channelName: string,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  if (provider === "codex") {
    return generateCodexReply(
      config,
      incomingText,
      conversationContext,
      codexSandboxMode,
      onProgress,
      conversationId,
      agentPermissionPolicy,
      channelName,
      petName,
      userName,
      agentConfig,
    );
  }
  if (provider === "hermes") {
    return generateHermesReply(config, incomingText, conversationContext, onProgress, agentPermissionPolicy, channelName, petName, userName, agentConfig);
  }
  if (agentConfig && (agentConfig.sourceApp === "openclaw" || /(?:^|[\\/])openclaw(?:\.cmd|\.exe)?$/i.test(agentConfig.command.trim()))) {
    return generateOpenClawReply(agentConfig, incomingText, conversationContext, onProgress, agentPermissionPolicy, channelName, petName, userName, conversationId);
  }
  if (provider === "custom") {
    if (!agentConfig) throw new Error("未找到自定义 Agent 配置");
    return generateCustomReply(agentConfig, incomingText, conversationContext, onProgress, agentPermissionPolicy, channelName, petName, userName);
  }
  return generateClaudeReply(
    config,
    incomingText,
    conversationContext,
    agentPermissionPolicy,
    channelName,
    onProgress,
    agentConfig,
    petName,
    userName,
  );
}

function ccSwitchApiEndpoint(runtime: CcSwitchRuntimeConfig, path: string): string {
  const base = runtime.baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

function extractApiReply(value: unknown, apiStyle: CcSwitchRuntimeConfig["apiStyle"]): string {
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
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return "";
  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("")
    .trim();
}

async function generateCcSwitchReply(
  runtime: CcSwitchRuntimeConfig,
  fallbackModel: string | null | undefined,
  incomingText: string,
  conversationContext: string,
  onProgress: AgentProgressListener | undefined,
  channelName: string,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  const model = runtime.model || fallbackModel;
  if (!model) throw new Error("CC Switch 当前配置没有可用模型，请重新导入 CCS 当前配置");
  const prompt = buildReplyPrompt(incomingText, conversationContext, "custom", "chat-only", channelName, petName, userName);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body = runtime.apiStyle === "anthropic"
    ? {
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }
    : {
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    };
  if (runtime.apiStyle === "anthropic") {
    headers["x-api-key"] = runtime.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${runtime.apiKey}`;
  }

  onProgress?.("starting", `CC Switch 当前 API 正在请求 ${runtime.configDisplayName}…`);
  const response = await fetch(
    ccSwitchApiEndpoint(runtime, runtime.apiStyle === "anthropic" ? "/messages" : "/chat/completions"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CCS_API_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`CC Switch 当前 API 请求失败（HTTP ${response.status}）：${detail}`);
  }
  const reply = extractApiReply(await response.json(), runtime.apiStyle);
  if (!reply) throw new Error("CC Switch 当前 API 返回了空内容");
  onProgress?.("response-ready", "CC Switch 当前 API 已生成回复，正在准备发送…");
  return reply;
}

async function generateClaudeReply(
  config: WeChatConfig,
  incomingText: string,
  conversationContext: string,
  agentPermissionPolicy: AgentPermissionPolicy,
  channelName: string,
  onProgress?: AgentProgressListener,
  agentConfig?: AgentConfig,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  if (agentPermissionPolicy === "allow-tools") {
    return generateClaudeCliReply(
      config,
      incomingText,
      conversationContext,
      agentPermissionPolicy,
      onProgress,
      agentConfig,
      channelName,
      petName,
      userName,
    );
  }

  const base = config.claudeBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      Authorization: "Bearer PROXY_MANAGED",
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 160,
      messages: [{ role: "user", content: buildReplyPrompt(incomingText, conversationContext, "claude", agentPermissionPolicy, channelName, petName, userName) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Claude 代理 HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("")
    .trim();

  if (!text) throw new Error("Claude 代理返回空回复");
  return text;
}

async function generateClaudeCliReply(
  config: WeChatConfig,
  incomingText: string,
  conversationContext: string,
  agentPermissionPolicy: AgentPermissionPolicy,
  onProgress?: AgentProgressListener,
  agentConfig?: AgentConfig,
  channelName = "微信",
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  const prompt = buildReplyPrompt(incomingText, conversationContext, "claude", agentPermissionPolicy, channelName, petName, userName);
  const command = await resolveClaudeCliCommand(agentConfig?.command || "claude");
  const cwd = agentConfig?.workingDirectory || config.agentWorkspace || process.cwd();
  const args = ["-p", "--output-format", "text", "--dangerously-skip-permissions", prompt];

  onProgress?.("starting", "Claude Code CLI 正在启动……");
  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(command, args, {
      cwd,
      timeout: CLAUDE_CLI_TIMEOUT_MS,
      maxBuffer: CLAUDE_CLI_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    }) as { stdout: string; stderr: string };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message || String(error);
    if (failure.code === "ENOENT" || /not recognized|not found/i.test(detail)) {
      throw new Error("找不到 Claude Code CLI，请确认 claude 已加入 PATH");
    }
    throw new Error(`Claude Code CLI 请求失败：${detail.slice(-800)}`);
  }

  const reply = stripCliOutput(result.stdout);
  if (!reply) throw new Error("Claude Code CLI 返回了空回复");
  onProgress?.("response-ready", "Claude Code 已生成回复，正在准备发送……");
  return reply;
}

async function generateCodexReply(
  config: WeChatConfig,
  incomingText: string,
  conversationContext: string,
  codexSandboxMode: CodexSandboxMode,
  onProgress: AgentProgressListener | undefined,
  conversationId: string,
  agentPermissionPolicy: AgentPermissionPolicy,
  channelName: string,
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
  agentConfig?: AgentConfig,
): Promise<string> {
  const prompt = buildReplyPrompt(incomingText, conversationContext, "codex", agentPermissionPolicy, channelName, petName, userName);
  try {
    return await codexClient.runTurn(
      conversationId,
      prompt,
      agentConfig?.workingDirectory || config.agentWorkspace || process.cwd(),
      codexSandboxMode,
      onProgress,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/Codex app-server|thread|turn|initialize|stdin|request .*timeout/i.test(detail)) throw error;
    onProgress?.("waiting", "Codex app-server 未完成请求，切换 Codex CLI 兜底通道……");
    return generateCodexCliReply(
      config,
      prompt,
      codexSandboxMode,
      onProgress,
      agentConfig,
    );
  }
}

async function generateCodexCliReply(
  config: WeChatConfig,
  prompt: string,
  codexSandboxMode: CodexSandboxMode,
  onProgress?: AgentProgressListener,
  agentConfig?: AgentConfig,
): Promise<string> {
  const command = await resolveCliCommand(agentConfig?.command || "codex", "codex");
  const args = [
    ...parseCommandArgs(agentConfig?.args ?? ""),
    "exec",
    "--ephemeral",
    "--sandbox",
    codexSandboxMode,
    "--skip-git-repo-check",
    "--color",
    "never",
  ];
  if (codexSandboxMode === "danger-full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push(prompt);
  onProgress?.("starting", "Codex CLI 兜底通道正在启动……");
  try {
    const result = await executeWindowsCli(command, args, {
      cwd: agentConfig?.workingDirectory || config.agentWorkspace || process.cwd(),
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    const reply = stripCliOutput(result.stdout || result.stderr);
    if (!reply) throw new Error("Codex CLI 返回了空回复");
    onProgress?.("response-ready", "Codex CLI 已生成回复，正在准备发送……");
    return reply;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message || String(error);
    if (failure.code === "ENOENT" || /not recognized|not found/i.test(detail)) {
      throw new Error("找不到 Codex CLI，请确认 codex 已加入 PATH");
    }
    throw new Error(`Codex CLI 请求失败：${detail.slice(-800)}`);
  }
}

async function generateHermesReply(
  config: WeChatConfig,
  incomingText: string,
  conversationContext: string,
  onProgress?: AgentProgressListener,
  agentPermissionPolicy: AgentPermissionPolicy = "allow-tools",
  channelName = "微信",
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
  agentConfig?: AgentConfig,
): Promise<string> {
  const prompt = buildReplyPrompt(incomingText, conversationContext, "hermes", agentPermissionPolicy, channelName, petName, userName);
  const executable = process.platform === "win32" ? "hermes.exe" : "hermes";

  onProgress?.("starting", "Hermes CLI 正在启动……");
  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(
      executable,
      ["chat", "-q", prompt, "--quiet", "--ignore-rules"],
      {
        cwd: config.agentWorkspace || process.cwd(),
        timeout: HERMES_TIMEOUT_MS,
        maxBuffer: HERMES_MAX_BUFFER,
        windowsHide: true,
        shell: false,
      },
    ) as { stdout: string; stderr: string };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const cliDetail = stripHermesTerminalOutput([failure.stdout, failure.stderr].filter(Boolean).join("\n"));
    const detail = cliDetail || failure.message || String(error);
    const ccSwitchRuntime = readCcSwitchRuntimeConfig("hermes", homedir(), true);
    if (ccSwitchRuntime) {
      onProgress?.("waiting", "Hermes CLI fallback to CCS API");
      try {
        return await generateCcSwitchReply(
          ccSwitchRuntime,
          agentConfig?.model,
          incomingText,
          conversationContext,
          onProgress,
          channelName,
          petName,
          userName,
        );
      } catch (fallbackError) {
        const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`Hermes CLI request failed: ${detail.slice(-360)}; CCS API fallback failed: ${fallbackDetail.slice(-360)}`);
      }
    }
    if (failure.code === "ENOENT" || /not recognized|not found/i.test(detail)) {
      throw new Error("找不到 Hermes CLI，请确认 hermes 已加入 PATH");
    }
    throw new Error(`Hermes CLI 请求失败：${detail.slice(-800)}`);
  }

  const reply = stripHermesTerminalOutput(result.stdout)
    .split(/\r?\n/)
    .filter((line) => !/^\s*session_id:\s*/i.test(line))
    .join("\n")
    .trim();
  if (!reply) {
    throw new Error("Hermes CLI 返回了空回复");
  }

  onProgress?.("response-ready", "Hermes 已生成回复，正在准备发送……");
  return reply;
}

async function generateOpenClawReply(
  agent: AgentConfig,
  incomingText: string,
  conversationContext: string,
  onProgress?: AgentProgressListener,
  agentPermissionPolicy: AgentPermissionPolicy = "allow-tools",
  channelName = "寰俊",
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
  conversationId = "default",
): Promise<string> {
  const prompt = buildReplyPrompt(incomingText, conversationContext, "custom", agentPermissionPolicy, channelName, petName, userName);
  const command = await resolveCliCommand(agent.command || "openclaw", "openclaw");
  const sessionKey = `agent:penguin-desktop-pet:${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`;
  const promptPath = join(
    tmpdir(),
    `penguin-openclaw-${createHash("sha256").update(`${conversationId}:${Date.now()}`).digest("hex").slice(0, 24)}.txt`,
  );
  await writeFile(promptPath, prompt, "utf8");

  onProgress?.("starting", "OpenClaw Agent starting");
  try {
    const result = await executeWindowsCli(
      command,
      [
        ...parseCommandArgs(agent.args),
        "agent",
        "--json",
        "--session-key",
        sessionKey,
        "--message-file",
        promptPath,
        "--timeout",
        String(Math.round(CUSTOM_AGENT_TIMEOUT_MS / 1000)),
      ],
      {
        cwd: agent.workingDirectory || process.cwd(),
        timeout: CUSTOM_AGENT_TIMEOUT_MS,
        maxBuffer: CUSTOM_AGENT_MAX_BUFFER,
      },
    );
    const reply = extractOpenClawReply(result.stdout || result.stderr);
    if (!reply) throw new Error("OpenClaw returned an empty reply");
    onProgress?.("response-ready", "OpenClaw Agent response ready");
    return reply;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message || String(error);
    if (failure.code === "ENOENT" || /not recognized|not found/i.test(detail)) {
      throw new Error("找不到 OpenClaw CLI，请确认 openclaw 已加入 PATH");
    }
    throw new Error(`OpenClaw Agent 请求失败：${detail.slice(-800)}`);
  } finally {
    await rm(promptPath, { force: true }).catch(() => undefined);
  }
}

function extractOpenClawReply(output: string): string {
  for (const line of output.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { payloads?: unknown };
      if (Array.isArray(parsed.payloads)) {
        const text = parsed.payloads
          .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === "object")
          .map((payload) => typeof payload.text === "string" ? payload.text : "")
          .filter(Boolean)
          .join("\n")
          .trim();
        if (text) return text;
      }
    } catch {
      // OpenClaw may print gateway diagnostics beside the JSON result.
    }
  }
  return stripCliOutput(output);
}

async function generateCustomReply(
  agent: AgentConfig,
  incomingText: string,
  conversationContext: string,
  onProgress?: AgentProgressListener,
  agentPermissionPolicy: AgentPermissionPolicy = "allow-tools",
  channelName = "微信",
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): Promise<string> {
  const prompt = buildReplyPrompt(incomingText, conversationContext, "custom", agentPermissionPolicy, channelName, petName, userName);
  const args = [...parseCommandArgs(agent.args), prompt];
  onProgress?.("starting", `${agent.displayName} 正在启动…`);

  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(agent.command, args, {
      cwd: agent.workingDirectory || process.cwd(),
      timeout: CUSTOM_AGENT_TIMEOUT_MS,
      maxBuffer: CUSTOM_AGENT_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    }) as { stdout: string; stderr: string };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message || String(error);
    if (failure.code === "ENOENT" || /not recognized|not found/i.test(detail)) {
      throw new Error(`找不到自定义 Agent 命令：${agent.command}`);
    }
    throw new Error(`${agent.displayName} 请求失败：${detail.slice(-800)}`);
  }

  const reply = stripCliOutput(result.stdout);
  if (!reply) throw new Error(`${agent.displayName} 返回了空回复`);
  onProgress?.("response-ready", `${agent.displayName} 已生成回复，正在准备发送…`);
  return reply;
}

function stripCliOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*session_id:\s*/i.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function stripHermesTerminalOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*session_id:\s*/i.test(line))
    .filter((line) => !/^\s*[┌└]─/.test(line))
    .map((line) => line.replace(/^\s*│\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function buildReplyPrompt(
  incomingText: string,
  conversationContext: string,
  provider: AgentProvider,
  agentPermissionPolicy: AgentPermissionPolicy = "allow-tools",
  channelName = "微信",
  petName = DEFAULT_PET_NAME,
  userName = DEFAULT_USER_NAME,
): string {
  const resolvedPetName = normalizeCallName(petName, DEFAULT_PET_NAME);
  const resolvedUserName = normalizeCallName(userName, DEFAULT_USER_NAME);
  const context = conversationContext
    ? `
Recent ${channelName} conversation context follows. Keep the reply natural and do not repeat the record:
${conversationContext}
`
    : "";
  const capability =
    provider === "codex"
      ? CODEX_CAPABILITY_INSTRUCTIONS
      : provider === "hermes"
        ? "You are running through Hermes Agent CLI and may use the capabilities provided by its current configuration. Be honest when a tool is unavailable."
        : provider === "custom"
          ? "You are running through a user-configured custom command. Only claim capabilities that this command actually provides."
          : agentPermissionPolicy === "allow-tools"
            ? "你当前运行在 Claude Code CLI 中，可以使用其实际提供的工具（读取本地文件、执行命令、检索等）。遇到检索、资料、文件类请求，必须先尝试真实完成；只有工具确实不可用或失败时才说明原因。绝不能在没有完成时声称已完成。"
            : CLAUDE_CAPABILITY_INSTRUCTIONS;
  const permission = agentPermissionPolicy === "chat-only"
    ? "当前权限策略为仅聊天：不要调用、建议或声称完成桌面操作、文件修改、网络检索、图片获取或其他外部工具。只能根据已有对话直接回复。"
    : "当前权限策略允许使用 Agent 实际提供的工具，但只能报告真实完成的操作，不能假装完成。";
  const transportInstructions = MEDIA_SEND_INSTRUCTIONS
    .replaceAll("主人", resolvedUserName);
  const capabilityWithCallName = capability.replaceAll("主人", resolvedUserName).replaceAll("企鹅", resolvedPetName);
  return `${commonReplyInstructions(channelName, resolvedPetName, resolvedUserName)}
${transportInstructions}
${permission}
${capabilityWithCallName}${context}
The ${resolvedUserName}'s new message: ${incomingText}`;
}
