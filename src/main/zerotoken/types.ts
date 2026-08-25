export type ZeroTokenProviderId = "chatgpt-web" | "claude-web" | "gemini-web";

export type ZeroTokenStatus = "stopped" | "login_required" | "logging_in" | "ready" | "error";

export interface ZeroTokenProviderDefinition {
  id: ZeroTokenProviderId;
  name: string;
  loginUrl: string;
  partition: string;
}

export interface ZeroTokenProviderStatus {
  provider: ZeroTokenProviderId;
  name: string;
  status: ZeroTokenStatus;
  detail: string;
  lastError: string | null;
  updatedAt: number;
}

export const ZERO_TOKEN_PROVIDERS: readonly ZeroTokenProviderDefinition[] = [
  {
    id: "chatgpt-web",
    name: "ChatGPT Web",
    loginUrl: "https://chatgpt.com/",
    partition: "persist:zerotoken-chatgpt",
  },
  {
    id: "claude-web",
    name: "Claude Web",
    loginUrl: "https://claude.ai/",
    partition: "persist:zerotoken-claude",
  },
  {
    id: "gemini-web",
    name: "Gemini Web",
    loginUrl: "https://gemini.google.com/app",
    partition: "persist:zerotoken-gemini",
  },
];

export function getZeroTokenProvider(provider: string): ZeroTokenProviderDefinition {
  const definition = ZERO_TOKEN_PROVIDERS.find((item) => item.id === provider);
  if (!definition) throw new Error(`Unknown Zero Token provider: ${provider}`);
  return definition;
}

