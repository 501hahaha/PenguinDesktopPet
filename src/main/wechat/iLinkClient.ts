import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { WeChatConfig } from "./config";

const IMAGE_UPLOAD_TYPE = 1;
const IMAGE_MESSAGE_TYPE = 2;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * iLink Bot API 客户端。
 *
 * 协议细节与 cc-weixin（~/.claude/wechat-daemon 管理的桥接器）保持一致：
 *   - 域名 https://ilinkai.weixin.qq.com（腾讯官方）
 *   - 请求头 AuthorizationType=ilink_bot_token、X-WECHAT-UIN（随机 uint32 → base64）
 *   - 载荷携带 base_info.channel_version
 * 会话 token 优先从 Electron safeStorage 加密凭据读取，首次兼容读取外部会话文件。
 */

export interface WeChatSession {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

export interface WeChatMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
  image_item?: {
    aeskey?: string;
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      encrypt_type?: number;
    };
    mid_size?: number;
  };
}

export interface WeChatMessage {
  message_type?: number;
  from_user_id?: string;
  context_token?: string;
  /** iLink 入站消息的稳定 wire id；用于去重与乱序恢复（不同版本字段名不同）。 */
  msg_id?: string;
  message_id?: string;
  client_id?: string;
  item_list?: WeChatMessageItem[];
}

export interface WeChatUpdatesResponse {
  ret?: number;
  msgs?: WeChatMessage[];
  get_updates_buf?: string;
}

interface UploadUrlResponse {
  ret?: number;
  upload_param?: string;
  upload_full_url?: string;
}

export function loadSession(tokenFile: string): WeChatSession | null {
  try {
    const raw = readFileSync(tokenFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<WeChatSession>;
    if (parsed.token && parsed.baseUrl) {
      return {
        token: parsed.token,
        baseUrl: parsed.baseUrl,
        accountId: parsed.accountId ?? "",
        userId: parsed.userId ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string, body: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "Content-Length": String(Buffer.byteLength(JSON.stringify(body), "utf-8")),
    Authorization: `Bearer ${token}`,
  };
  return headers;
}

export function extractText(message: WeChatMessage): string {
  return (message.item_list ?? [])
    .map((item) => {
      if (item.type === 1) return item.text_item?.text ?? "";
      if (item.type === 3) return item.voice_item?.text ?? "";
      if (item.type === 2) return "[图片]";
      if (item.type === 4) return `[文件: ${item.file_item?.file_name ?? "未命名"}]`;
      if (item.type === 5) return "[视频]";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 把外部取消信号与内部超时合并为单一 fetch signal：
 *   - 外部信号中止 → 对外抛出 AbortError（调用方据此结束轮询）；
 *   - 内部超时 → 以 TimeoutError 中止（视为一次空轮询，保持原有语义）。
 */
function withPollTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    timeoutMs,
  );
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function getUpdates(
  config: WeChatConfig,
  session: WeChatSession,
  getUpdatesBuf: string,
  signal?: AbortSignal,
): Promise<WeChatUpdatesResponse> {
  const body = {
    get_updates_buf: getUpdatesBuf,
    base_info: { channel_version: config.channelVersion },
  };
  const base = (session.baseUrl || config.baseUrl).replace(/\/$/, "");

  const { signal: combinedSignal, cleanup } = withPollTimeout(signal, 40_000);
  try {
    const res = await fetch(`${base}/ilink/bot/getupdates`, {
      method: "POST",
      headers: buildHeaders(session.token, body),
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    if (!res.ok) {
      throw new Error(`getupdates HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as WeChatUpdatesResponse;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isTimeoutError(error)) {
      return { msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  } finally {
    cleanup();
  }
}

/**
 * 校验 sendmessage 的业务响应。iLink 以 HTTP 200 + JSON body 表示业务结果，
 * 仅检查 HTTP 状态会误判“已送达”。规则：
 *   - 空 body：视为成功（兼容历史响应）；
 *   - 可解析 JSON：ret/errcode/retcode 任一非 0，或显式 ok=false / error / errmsg 失败标记 → 拒绝；
 *   - 非空但无法解析的 body：视为失败（无法确认已受理）。
 * 错误信息只含错误码与截断的服务端描述，不含 token、消息正文或凭据。
 */
async function rejectOnBusinessError(label: string, res: Response): Promise<void> {
  const bodyText = await res.text();
  const trimmed = bodyText.trim();
  if (!trimmed) return;

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error(`微信${label}发送响应无法解析，发送未确认`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`微信${label}发送响应格式异常，发送未确认`);
  }

  const failure = businessFailureCode(data as Record<string, unknown>);
  if (failure) {
    throw new Error(`微信${label}发送被拒绝（${failure}）`);
  }
}

function businessFailureCode(data: Record<string, unknown>): string | null {
  const codeKeys = ["ret", "errcode", "retcode"];
  let sawSuccessCode = false;
  let failureCode: string | null = null;
  for (const key of codeKeys) {
    const value = data[key];
    if (typeof value === "number") {
      if (value !== 0) {
        failureCode = `${key}=${value}`;
        break;
      }
      sawSuccessCode = true;
    } else if (typeof value === "string" && value.trim() !== "") {
      if (value.trim() !== "0") {
        failureCode = `${key}=${value.trim().slice(0, 40)}`;
        break;
      }
      sawSuccessCode = true;
    }
  }
  if (failureCode) {
    const errmsg = typeof data.errmsg === "string" ? data.errmsg.trim().slice(0, 120) : "";
    return errmsg ? `${failureCode}, errmsg=${errmsg}` : failureCode;
  }
  if (sawSuccessCode) return null;
  if (data.ok === false) return "ok=false";
  const error = data.error;
  if (typeof error === "string" && error.trim()) return `error=${error.trim().slice(0, 120)}`;
  if (error !== undefined && error !== null) return "error";
  const errmsg = data.errmsg;
  if (typeof errmsg === "string" && errmsg.trim()) return `errmsg=${errmsg.trim().slice(0, 120)}`;
  return null;
}

export async function sendTextMessage(
  config: WeChatConfig,
  session: WeChatSession,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `penguin-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      ...(contextToken?.trim() ? { context_token: contextToken.trim() } : {}),
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: config.channelVersion },
  };

  const base = (session.baseUrl || config.baseUrl).replace(/\/$/, "");
  const res = await fetch(`${base}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: buildHeaders(session.token, body),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`sendmessage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  await rejectOnBusinessError("文本", res);
}

/**
 * 上传并发送一张图片。
 *
 * iLink 的媒体流程是：本地读取/下载图片 -> AES-128-ECB 加密 ->
 * getuploadurl 获取 CDN 参数 -> POST 到 CDN -> sendmessage 发送 image_item。
 * caption 会作为同一上下文下的独立文字消息先发出。
 */
export async function sendImageMessage(
  config: WeChatConfig,
  session: WeChatSession,
  toUserId: string,
  source: string,
  contextToken?: string,
  caption?: string,
): Promise<void> {
  const image = await loadImageSource(source);
  const uploaded = await uploadImage(config, session, toUserId, image.buffer);

  if (caption?.trim()) {
    await sendTextMessage(config, session, toUserId, caption.trim(), contextToken);
  }

  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `penguin-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      ...(contextToken?.trim() ? { context_token: contextToken.trim() } : {}),
      item_list: [
        {
          type: IMAGE_MESSAGE_TYPE,
          image_item: {
            // Some WeChat clients use the legacy image-level AES key when
            // decoding image_item.media.aes_key.
            aeskey: uploaded.aesKeyHex,
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              // iLink expects the base64 form of the hexadecimal AES key.
              aes_key: Buffer.from(uploaded.aesKeyHex, "utf8").toString("base64"),
              encrypt_type: 1,
            },
            mid_size: uploaded.encryptedSize,
          },
        },
      ],
    },
    base_info: { channel_version: config.channelVersion },
  };

  const base = (session.baseUrl || config.baseUrl).replace(/\/$/, "");
  const res = await fetch(`${base}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: buildHeaders(session.token, body),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`sendmessage(image) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  await rejectOnBusinessError("图片", res);
}

async function loadImageSource(source: string): Promise<{ buffer: Buffer; fileName: string }> {
  const trimmed = normalizeImageSource(source);
  if (!trimmed) throw new Error("图片路径或 URL 为空");

  if (/^https?:\/\//i.test(trimmed)) {
    const response = await fetch(trimmed, {
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`下载图片 HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new Error("图片超过 20 MB，无法发送");
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`URL 返回的不是图片（${contentType}）`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    ensureImageSize(buffer);
    const urlPath = new URL(trimmed).pathname;
    const extension = extname(urlPath).toLowerCase() || ".jpg";
    return { buffer, fileName: `penguin-image${extension}` };
  }

  const extension = extname(trimmed).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("只支持 PNG、JPG、GIF、WEBP 或 BMP 图片");
  }
  const buffer = await readFile(trimmed);
  ensureImageSize(buffer);
  return { buffer, fileName: `penguin-image${extension}` };
}

function normalizeImageSource(source: string): string {
  let value = source.trim().replace(/^["'`]|["'`]$/g, "");
  const markdownMatch = value.match(/^!\[[^\]]*\]\(\s*(.*?)\s*\)$/s);
  if (markdownMatch?.[1]) {
    value = markdownMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
  }

  const urlMatch = value.match(/https?:\/\/[^\s<>()\]}"']+/i);
  if (urlMatch?.[0]) {
    return urlMatch[0].replace(/[),.;!?，。；！？]+$/g, "");
  }
  return value;
}

async function uploadImage(
  config: WeChatConfig,
  session: WeChatSession,
  toUserId: string,
  buffer: Buffer,
): Promise<{ downloadEncryptedQueryParam: string; aesKeyHex: string; encryptedSize: number }> {
  const rawSize = buffer.length;
  const rawFileMd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const fileKey = crypto.randomBytes(16).toString("hex");
  const encryptedSize = Math.ceil((rawSize + 1) / 16) * 16;
  const uploadBody = {
    filekey: fileKey,
    media_type: IMAGE_UPLOAD_TYPE,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize: encryptedSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: config.channelVersion },
  };

  const base = (session.baseUrl || config.baseUrl).replace(/\/$/, "");
  const uploadUrlResponse = await fetch(`${base}/ilink/bot/getuploadurl`, {
    method: "POST",
    headers: buildHeaders(session.token, uploadBody),
    body: JSON.stringify(uploadBody),
    signal: AbortSignal.timeout(15_000),
  });
  if (!uploadUrlResponse.ok) {
    throw new Error(`getuploadurl HTTP ${uploadUrlResponse.status}: ${await uploadUrlResponse.text()}`);
  }

  const uploadUrlData = (await uploadUrlResponse.json()) as UploadUrlResponse;
  const uploadParam = uploadUrlData.upload_param;
  if (!uploadParam && !uploadUrlData.upload_full_url) {
    throw new Error("微信没有返回图片上传参数");
  }

  const encrypted = encryptAesEcb(buffer, aesKey);
  const cdnUrl = uploadUrlData.upload_full_url ?? buildCdnUploadUrl(config, uploadParam!, fileKey);
  let downloadEncryptedQueryParam = "";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploadResponse = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(30_000),
      });
      if (!uploadResponse.ok) {
        throw new Error(`CDN 上传 HTTP ${uploadResponse.status}: ${await uploadResponse.text()}`);
      }
      downloadEncryptedQueryParam = uploadResponse.headers.get("x-encrypted-param") ?? "";
      if (!downloadEncryptedQueryParam) {
        throw new Error("CDN 没有返回图片下载参数");
      }
      break;
    } catch (error) {
      lastError = error as Error;
      if (attempt < 3) await delay(500 * attempt);
    }
  }

  if (!downloadEncryptedQueryParam) {
    throw lastError ?? new Error("图片上传失败");
  }
  return { downloadEncryptedQueryParam, aesKeyHex, encryptedSize: encrypted.length };
}

function encryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function buildCdnUploadUrl(config: WeChatConfig, uploadParam: string, fileKey: string): string {
  const cdnBase = config.cdnBaseUrl.replace(/\/$/, "");
  return `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
}

function ensureImageSize(buffer: Buffer): void {
  if (buffer.length === 0) throw new Error("图片为空");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("图片超过 20 MB，无法发送");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
