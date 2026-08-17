import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "../../agents/types";
import { parseCommandArgs } from "../../agents/command";
import type { PetPerceptionAgentSummary } from "../pet/perceptionTypes";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 3_500;
const COMMAND_RESOLVE_TIMEOUT_MS = 1_500;
const WRAPPER_READ_MAX_BYTES = 32 * 1024;
const PROBE_OUTPUT_GRACE_MS = 120;

interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
}

function isCommandMissing(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException & { stderr?: string };
  if (candidate.code === "ENOENT") return true;
  const detail = `${candidate.message ?? ""} ${candidate.stderr ?? ""}`.toLowerCase();
  return detail.includes("not recognized") || detail.includes("not found") || detail.includes("cannot find");
}

function isWindowsWrapper(file: string): boolean {
  return /\.(?:cmd|bat|ps1)$/i.test(file);
}

function wrapperRelativePath(value: string, wrapperFile: string): string {
  const baseDir = dirname(wrapperFile);
  const normalized = value
    .replace(/^['"]|['"]$/g, "")
    .replace(/%dp0%/gi, "")
    .replace(/\$basedir/gi, "")
    .replace(/[\\/]+/g, "\\")
    .replace(/^\\+/, "");
  return resolve(baseDir, normalized);
}

function readWrapperText(file: string): string | null {
  try {
    return readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, WRAPPER_READ_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * npm-installed Windows CLIs commonly expose a .cmd/.ps1 wrapper plus an
 * extensionless POSIX shim. Calling the wrapper through `shell: true` from
 * Electron can leave the real CLI child alive after a timeout. Resolve the
 * wrapper's real executable instead, so the probe owns the process directly.
 */
function resolveWrapperTarget(wrapperFile: string): ResolvedCommand | null {
  const text = readWrapperText(wrapperFile);
  if (!text) return null;

  const prefix = "(?:%dp0%|\\$basedir)";
  const directMatch = text.match(new RegExp(`['\"]?${prefix}[\\\\/]([^'\"\\r\\n]+\\.exe)['\"]?`, "i"));
  if (directMatch) {
    const file = wrapperRelativePath(directMatch[1], wrapperFile);
    if (existsSync(file)) return { file, prefixArgs: [] };
  }

  const nodeMatch = text.match(new RegExp(`['\"]?${prefix}[\\\\/](node(?:\\.exe)?)['\"]?`, "i"));
  const scriptMatch = text.match(new RegExp(`['\"]?${prefix}[\\\\/](node_modules[\\\\/][^'\"\\r\\n]+\\.(?:js|mjs))['\"]?`, "i"));
  if (nodeMatch && scriptMatch) {
    const file = wrapperRelativePath(nodeMatch[1], wrapperFile);
    const script = wrapperRelativePath(scriptMatch[1], wrapperFile);
    if (existsSync(file) && existsSync(script)) return { file, prefixArgs: [script] };
  }

  return null;
}

function commandCandidates(command: string, output: string): string[] {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length > 0) return candidates;
  return isAbsolute(command) ? [command] : [];
}

async function resolveWindowsCommand(command: string): Promise<ResolvedCommand> {
  const trimmed = command.trim();
  if (!trimmed) return { file: trimmed, prefixArgs: [] };

  const explicitExtension = extname(trimmed).toLowerCase();
  if (explicitExtension === ".exe" || explicitExtension === ".com") {
    return { file: trimmed, prefixArgs: [] };
  }
  if (isWindowsWrapper(trimmed)) {
    const resolved = resolveWrapperTarget(trimmed);
    if (resolved) return resolved;
  }

  try {
    const result = await execFileAsync("where.exe", [trimmed], {
      timeout: COMMAND_RESOLVE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      maxBuffer: 32 * 1024,
    });
    const candidates = commandCandidates(trimmed, result.stdout);

    // Prefer a parsed package wrapper over an unrelated executable with the
    // same name (for example the desktop Codex app and the Codex CLI).
    for (const candidate of candidates) {
      if (!isWindowsWrapper(candidate)) continue;
      const resolved = resolveWrapperTarget(candidate);
      if (resolved) return resolved;
    }
    for (const candidate of candidates) {
      const extension = extname(candidate).toLowerCase();
      if (extension === ".exe" || extension === ".com") return { file: candidate, prefixArgs: [] };
    }
    const extensionless = candidates.find((candidate) => !extname(candidate));
    if (extensionless && existsSync(extensionless)) return { file: extensionless, prefixArgs: [] };
  } catch {
    // The actual probe below will classify the command as missing/unknown.
  }

  return { file: trimmed, prefixArgs: [] };
}

export async function resolveAgentCommand(command: string): Promise<ResolvedCommand> {
  return process.platform === "win32" ? resolveWindowsCommand(command) : { file: command.trim(), prefixArgs: [] };
}

function terminateProbeProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      // Fall through to the direct child kill below.
    }
  }
  try {
    child.kill();
  } catch {
    // The process may have already exited between the timeout and cleanup.
  }
}

/** Run a version probe without waiting forever on a CLI that keeps its runtime alive. */
export function runVersionProbe(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (outputTimer) clearTimeout(outputTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      outputTimer = null;
      timeoutTimer = null;
    };

    const finish = (error?: Error, terminate = false): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (terminate) terminateProbeProcess(child);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > WRAPPER_READ_MAX_BYTES) {
        finish(Object.assign(new Error("Agent version probe output exceeded the limit"), { code: "EOUTPUT" }), true);
        return;
      }
      if (!outputTimer && stdout.trim()) {
        outputTimer = setTimeout(() => finish(undefined, true), PROBE_OUTPUT_GRACE_MS);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > WRAPPER_READ_MAX_BYTES) {
        finish(Object.assign(new Error("Agent version probe output exceeded the limit"), { code: "EOUTPUT" }), true);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const error = Object.assign(new Error(`Agent version probe exited with ${signal ?? `code ${code ?? "unknown"}`}`), {
        code: code === null ? signal ?? "EUNKNOWN" : `EXIT_${code}`,
        stderr,
      });
      finish(error);
    });
    timeoutTimer = setTimeout(() => {
      finish(Object.assign(new Error("Agent version probe timed out"), { code: "ETIMEDOUT", stderr }), true);
    }, options.timeoutMs);
  });
}

/**
 * Performs a bounded, read-only availability check for the supplied visible
 * and enabled Agent configurations. It checks the executable only; it does
 * not start a session, send a prompt, read chat content, or inspect secrets.
 */
export async function probeAgentRuntime(configs: AgentConfig[]): Promise<
  Record<string, PetPerceptionAgentSummary["runtime"]>
> {
  const result: Record<string, PetPerceptionAgentSummary["runtime"]> = {};

  await Promise.all(
    configs.map(async (config) => {
      if (!config.command.trim()) {
        result[config.id] = "unknown";
        return;
      }
      try {
        const resolved = await resolveAgentCommand(config.command);
        await runVersionProbe(
          resolved.file,
          [...resolved.prefixArgs, ...parseCommandArgs(config.args), "--version"],
          { cwd: config.workingDirectory || undefined, timeoutMs: PROBE_TIMEOUT_MS },
        );
        result[config.id] = "online";
      } catch (error) {
        result[config.id] = isCommandMissing(error) ? "offline" : "unknown";
      }
    }),
  );

  return result;
}
