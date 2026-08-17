import type { AgentConfig } from "../../agents/types";
import { normalizeSafeText } from "./orchestrationTypes";

function lastPathSegment(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return "";
  return normalized.split("/").at(-1)?.trim() ?? "";
}

/** Returns a short workspace name without exposing the configured absolute path. */
export function workspaceNameForAgent(agentConfig?: Pick<AgentConfig, "displayName" | "workingDirectory">, fallbackWorkspace = ""): string {
  const configuredName = lastPathSegment(agentConfig?.workingDirectory ?? "");
  const fallbackName = lastPathSegment(fallbackWorkspace);
  const safeName = normalizeSafeText(configuredName || fallbackName || agentConfig?.displayName || "默认工作区", 80);
  return safeName || "默认工作区";
}

export function prefixWorkspaceReply(
  text: string,
  agentConfig?: Pick<AgentConfig, "displayName" | "workingDirectory">,
  fallbackWorkspace = "",
): string {
  const normalized = text.trim();
  if (!normalized) return normalized;
  return `【工作区：${workspaceNameForAgent(agentConfig, fallbackWorkspace)}】\n${normalized}`.slice(0, 1800);
}
