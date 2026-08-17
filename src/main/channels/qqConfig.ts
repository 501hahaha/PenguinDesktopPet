export interface QQChannelConfig {
  channelId: string;
  appId: string;
  clientSecret?: string;
  accessToken?: string;
  sandbox: boolean;
  maxRetry: number;
}

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value !== undefined ? value.trim() : fallback;
}

export function loadQQChannelConfig(): QQChannelConfig | null {
  const appId = env("PENGUIN_QQ_APP_ID");
  const clientSecret = env("PENGUIN_QQ_CLIENT_SECRET");
  const accessToken = env("PENGUIN_QQ_ACCESS_TOKEN");
  if (!appId || (!clientSecret && !accessToken)) return null;

  return {
    channelId: env("PENGUIN_QQ_CHANNEL_ID", `qq:${appId}`),
    appId,
    clientSecret: clientSecret || undefined,
    accessToken: accessToken || undefined,
    sandbox: env("PENGUIN_QQ_SANDBOX") === "1",
    maxRetry: Number.parseInt(env("PENGUIN_QQ_MAX_RETRY", "5"), 10) || 5,
  };
}
