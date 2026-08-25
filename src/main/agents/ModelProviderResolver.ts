import { agentSupportsZeroToken } from "../../agents/types";
import type { AgentConfig, AgentModelProvider } from "../../agents/types";
import type { AgentPermissionPolicy, ZeroTokenSettings } from "../../settings/types";

export type ModelProviderKind = "existing" | "cc-switch" | "zero-token";

export interface ModelProviderResolution {
  kind: ModelProviderKind;
  providerId: AgentModelProvider;
  detail: string;
}

/**
 * Chooses only the model transport. Agent identity, permissions, and runtime
 * execution stay owned by the existing Agent adapters.
 */
export function resolveModelProvider(
  agent: AgentConfig | undefined,
  zeroToken: ZeroTokenSettings,
  agentPermissionPolicy: AgentPermissionPolicy,
): ModelProviderResolution {
  const selected = agent?.modelProvider;
  if (agentPermissionPolicy !== "allow-tools" && zeroToken.enabled && selected === "zerotoken") {
    return { kind: "zero-token", providerId: "zerotoken", detail: "当前 Agent 通过 ZeroToken Runtime 访问模型" };
  }
  if (agentPermissionPolicy !== "allow-tools" && zeroToken.enabled && !selected && agent && agentSupportsZeroToken(agent)) {
    return { kind: "zero-token", providerId: "zerotoken", detail: "当前 Agent 通过 ZeroToken Runtime 访问模型" };
  }
  if (agentPermissionPolicy !== "allow-tools" && (selected === "ccs" || (!selected && agent?.ccSwitchCurrentConfig))) {
    return { kind: "cc-switch", providerId: "ccs", detail: "当前 Agent 使用 CC Switch 的已绑定模型通道" };
  }
  return {
    kind: "existing",
    providerId: selected ?? "api",
    detail: selected === "deepseek" ? "当前 Agent 使用 DeepSeek API Provider" : "当前 Agent 使用原有 Runtime/Provider",
  };
}
