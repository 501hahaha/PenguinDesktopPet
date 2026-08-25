import type { AgentConfig } from "../../agents/types";
import type { AgentPermissionPolicy, ZeroTokenSettings } from "../../settings/types";
import { createZeroTokenProvider } from "./ZeroTokenProvider";
import { resolveModelProvider } from "./ModelProviderResolver";
import type { ModelProviderClient } from "../runtime/types";

/**
 * Small provider boundary for the existing Agent system. It deliberately does
 * not own Agent identity, tools, memory, or channel routing.
 */
export class AgentManager {
  resolveModelProvider(
    agent: AgentConfig | undefined,
    zeroToken: ZeroTokenSettings,
    permission: AgentPermissionPolicy,
  ): ModelProviderClient | null {
    const resolution = resolveModelProvider(agent, zeroToken, permission);
    if (resolution.kind === "zero-token") return createZeroTokenProvider(zeroToken);
    return null;
  }
}

export const agentManager = new AgentManager();
