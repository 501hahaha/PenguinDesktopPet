import { agentSupportsZeroToken } from "../../agents/types";
import type { AgentConfig } from "../../agents/types";
import type { AgentPermissionPolicy, ZeroTokenSettings } from "../../settings/types";

export type ModelProviderKind = "existing" | "cc-switch" | "zero-token";

export interface ModelProviderResolution {
  kind: ModelProviderKind;
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
  if (agentPermissionPolicy !== "allow-tools" && zeroToken.enabled && agent && agentSupportsZeroToken(agent)) {
    return { kind: "zero-token", detail: "当前 Agent 通过 WebModel OpenAI 兼容通道访问模型" };
  }
  if (agentPermissionPolicy !== "allow-tools" && agent?.ccSwitchCurrentConfig) {
    return { kind: "cc-switch", detail: "当前 Agent 使用 CC Switch 的已绑定模型通道" };
  }
  return { kind: "existing", detail: "当前 Agent 使用原有 Runtime/Provider" };
}
