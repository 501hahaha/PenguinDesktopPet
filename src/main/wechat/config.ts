import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 微信接入配置。
 *
 * 所有配置均可通过环境变量覆盖，默认值指向本机已有的 cc-weixin 桥接器
 * （~/.claude/wechat-daemon/daemon.mjs 管理的 daemon）及其复用文件：
 *   - token:    ~/.cc-weixin/token.json  （iLink 登录会话，密钥不落盘在本工程）
 *   - daemon 日志: ~/.wechat-daemon.log   （桥接器收/发消息的唯一事实来源）
 *   - Claude 代理: 127.0.0.1:15721        （与 daemon 相同的模型网关）
 */
export interface WeChatConfig {
  /** 是否启用微信接入。仅当 PENGUIN_WECHAT_ENABLED=1 时启动（幂等，默认关闭） */
  enabled: boolean;
  /** iLink Bot API base URL，一般无需修改 */
  baseUrl: string;
  /** 微信 CDN 媒体上传地址，一般无需修改 */
  cdnBaseUrl: string;
  /** 腾讯 iLink channel_version，与 cc-weixin 保持一致 */
  channelVersion: string;
  /** iLink 会话文件（含 token），默认复用 cc-weixin 的登录态 */
  tokenFile: string;
  /** cc-weixin daemon 日志路径，事件源头 */
  daemonLog: string;
  /** cc-weixin daemon PID 文件，用于判断机器人是否仍在运行 */
  daemonPidFile: string;
  /** 回复生成所用的 Claude 兼容端点 */
  claudeBaseUrl: string;
  /** 回复生成所用模型 */
  claudeModel: string;
  agentWorkspace: string;
}

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

function defaultAgentWorkspace(): string {
  const candidates = [process.cwd(), resolve(dirname(__dirname), "../..")];
  const projectRoot = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  return projectRoot ?? process.cwd();
}

export function loadConfig(tokenFileOverride = "", enabledOverride?: boolean): WeChatConfig {
  const home = homedir();
  const tokenFile = tokenFileOverride.trim() || env("PENGUIN_WECHAT_TOKEN_FILE", join(home, ".cc-weixin", "token.json"));
  const daemonLog = env("PENGUIN_WECHAT_DAEMON_LOG", join(home, ".wechat-daemon.log"));
  const daemonPidFile = env("PENGUIN_WECHAT_DAEMON_PID_FILE", join(home, ".wechat-daemon.pid"));
  const agentWorkspace = env("PENGUIN_WECHAT_AGENT_WORKSPACE", defaultAgentWorkspace());
  const explicitEnabled = process.env.PENGUIN_WECHAT_ENABLED;
  const environmentDisabled = explicitEnabled === "0";

  return {
    enabled:
      environmentDisabled
        ? false
        : enabledOverride !== undefined
          ? enabledOverride
          : explicitEnabled === "1" || existsSync(tokenFile),
    baseUrl: env("PENGUIN_WECHAT_BASE_URL", DEFAULT_BASE_URL),
    cdnBaseUrl: env("PENGUIN_WECHAT_CDN_URL", "https://novac2c.cdn.weixin.qq.com/c2c"),
    channelVersion: env("PENGUIN_WECHAT_CHANNEL_VERSION", "1.0.2"),
    tokenFile,
    daemonLog,
    daemonPidFile,
    claudeBaseUrl: env("PENGUIN_WECHAT_CLAUDE_URL", "http://127.0.0.1:15721"),
    claudeModel: env("PENGUIN_WECHAT_CLAUDE_MODEL", "claude-sonnet-4-6[1M]"),
    agentWorkspace,
  };
}
