import QRCode from "qrcode";
import { DEFAULT_BASE_URL } from "./config";
import type { WeChatQrLoginProgress } from "./events";
import type { WeChatSession } from "./iLinkClient";

const BOT_TYPE = "3";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_REFRESHES = 3;
const POLL_INTERVAL_MS = 1_000;

interface JsonRecord {
  [key: string]: unknown;
}

interface BotQrCode {
  qrcode: string;
  qrDataUrl: string;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function getJson(url: string, signal: AbortSignal): Promise<JsonRecord> {
  const response = await fetch(url, { signal });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`微信登录接口返回了无效数据（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(`微信登录接口请求失败（HTTP ${response.status}）`);
  }
  return asRecord(payload);
}

function checkRet(payload: JsonRecord): void {
  if (typeof payload.ret === "number" && payload.ret !== 0) {
    const message = asString(payload.errmsg) || `接口返回错误码 ${payload.ret}`;
    throw new Error(message);
  }
}

async function requestBotQrCode(baseUrl: string, signal: AbortSignal): Promise<BotQrCode> {
  const payload = await getJson(
    `${baseUrl.replace(/\/$/, "")}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    signal,
  );
  checkRet(payload);

  const qrcode = asString(payload.qrcode);
  const qrContent = asString(payload.qrcode_img_content);
  if (!qrcode || !qrContent) {
    throw new Error("微信登录接口没有返回有效二维码");
  }

  const qrDataUrl = await QRCode.toDataURL(qrContent, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 248,
  });
  return { qrcode, qrDataUrl };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("二维码登录已取消"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("二维码登录已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isConfirmed(payload: JsonRecord): boolean {
  return asString(payload.status).toLowerCase() === "confirmed";
}

export async function loginWithQr(
  onProgress: (progress: WeChatQrLoginProgress) => void,
  signal: AbortSignal,
  baseUrl = DEFAULT_BASE_URL,
): Promise<WeChatSession> {
  let qrCode = await requestBotQrCode(baseUrl, signal);
  let refreshCount = 0;
  let scanReported = false;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  onProgress({
    status: "waiting",
    detail: "请使用微信扫描二维码并确认授权",
    qrDataUrl: qrCode.qrDataUrl,
  });

  while (Date.now() < deadline) {
    const payload = await getJson(
      `${baseUrl.replace(/\/$/, "")}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode.qrcode)}`,
      signal,
    );
    checkRet(payload);

    const status = asString(payload.status).toLowerCase();
    if (status === "scaned" || status === "scanned") {
      if (!scanReported) {
        scanReported = true;
        onProgress({ status: "scanned", detail: "已扫码，请在微信中确认授权" });
      }
    } else if (status === "expired") {
      if (refreshCount >= MAX_REFRESHES) {
        throw new Error("二维码多次过期，请稍后重试");
      }
      refreshCount += 1;
      qrCode = await requestBotQrCode(baseUrl, signal);
      scanReported = false;
      onProgress({
        status: "waiting",
        detail: `二维码已刷新（${refreshCount}/${MAX_REFRESHES}），请重新扫码`,
        qrDataUrl: qrCode.qrDataUrl,
      });
    } else if (isConfirmed(payload)) {
      const token = asString(payload.bot_token);
      if (!token) throw new Error("微信确认成功，但没有收到 Bot 会话凭据");
      return {
        token,
        baseUrl: asString(payload.baseurl) || baseUrl,
        accountId: asString(payload.ilink_bot_id),
        userId: asString(payload.ilink_user_id),
      };
    }

    await delay(POLL_INTERVAL_MS, signal);
  }

  throw new Error("二维码登录超时，请重新发起扫码");
}
