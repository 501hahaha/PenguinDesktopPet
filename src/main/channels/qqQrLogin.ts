import type { QrConnectCredentials } from "@tencent-connect/qqbot-connector";
import QRCode from "qrcode";

export type QQQrLoginStatus =
  | "requesting"
  | "waiting"
  | "scanned"
  | "connecting"
  | "confirmed"
  | "expired"
  | "cancelled"
  | "error";

export interface QQQrLoginEvent {
  type: "qr-login";
  status: QQQrLoginStatus;
  detail: string;
  qrDataUrl?: string;
  appId?: string;
}

export type QQQrLoginFinalize = (
  credentials: QrConnectCredentials[],
  displayName: string,
) => Promise<{ ok: boolean; detail: string; appId?: string }>;

interface ActiveQrLogin {
  id: number;
  displayName: string;
  controller: AbortController;
  stop: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
  phase: "scanning" | "finalizing";
}

const QR_SESSION_TIMEOUT_MS = 5 * 60_000;

export class QQQrLoginManager {
  private active: ActiveQrLogin | null = null;
  private sequence = 0;
  private snapshot: QQQrLoginEvent | null = null;
  private readonly listeners = new Set<(event: QQQrLoginEvent) => void>();

  constructor(private readonly finalize: QQQrLoginFinalize) {}

  getStatus(): QQQrLoginEvent | null {
    return this.active && this.snapshot ? { ...this.snapshot } : null;
  }

  subscribe(listener: (event: QQQrLoginEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(displayName = ""): Promise<{ ok: boolean; detail: string }> {
    if (this.active) return { ok: false, detail: "QQ 扫码正在进行，请稍候" };

    const active: ActiveQrLogin = {
      id: ++this.sequence,
      displayName: displayName.trim(),
      controller: new AbortController(),
      stop: null,
      timeout: null,
      phase: "scanning",
    };
    this.active = active;
    active.timeout = setTimeout(() => this.expire(active), QR_SESSION_TIMEOUT_MS);
    this.publish({
      type: "qr-login",
      status: "requesting",
      detail: "正在生成二维码…",
    });

    try {
      // The SDK's CommonJS entrypoint is incorrectly marked as ESM in v1.2.0.
      // Keep this as a native dynamic import so Electron loads its valid ESM build.
      const { startQrConnect } = await import("@tencent-connect/qqbot-connector");
      if (!this.isCurrent(active)) return { ok: false, detail: "QQ 扫码登录已取消" };
      active.stop = startQrConnect(
        {
          onQrDisplayed: (url) => {
            void this.handleQrDisplayed(active, url);
          },
          onQrExpired: () => {
            if (!this.isCurrent(active)) return;
            this.publish({
              type: "qr-login",
              status: "requesting",
              detail: "二维码已过期，正在刷新…",
            });
          },
          onSuccess: (credentials) => {
            void this.handleSuccess(active, credentials);
          },
          onFailure: (error) => {
            this.handleFailure(active, error);
          },
        },
        {
          displayQrCodeToConsole: false,
          signal: active.controller.signal,
          source: "penguin-desktop-pet",
        },
      );
    } catch (error) {
      this.handleFailure(active, error);
      return { ok: false, detail: this.snapshot?.detail ?? "QQ 二维码生成失败" };
    }

    return { ok: true, detail: "正在生成二维码…" };
  }

  cancel(): { ok: boolean; detail: string } {
    const active = this.active;
    if (!active) return { ok: false, detail: "当前没有进行中的 QQ 扫码" };
    if (active.phase === "finalizing") {
      return { ok: false, detail: "扫码已确认，正在完成连接，请稍候" };
    }

    this.clearActive(active, true);
    this.publish({
      type: "qr-login",
      status: "cancelled",
      detail: "已取消扫码",
    });
    return { ok: true, detail: "已取消扫码" };
  }

  private async handleQrDisplayed(active: ActiveQrLogin, url: string): Promise<void> {
    try {
      const qrDataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 248,
      });
      if (!this.isCurrent(active)) return;
      this.publish({
        type: "qr-login",
        status: "waiting",
        detail: "使用手机 QQ 扫码确认",
        qrDataUrl,
      });
    } catch (error) {
      this.handleFailure(active, error);
    }
  }

  private async handleSuccess(active: ActiveQrLogin, credentials: QrConnectCredentials[]): Promise<void> {
    if (!this.isCurrent(active)) return;
    active.phase = "finalizing";
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
    active.stop?.();
    active.stop = null;
    const appId = credentials[0]?.appId;
    this.publish({
      type: "qr-login",
      status: "connecting",
      detail: "扫码成功，正在连接…",
      appId,
    });

    try {
      const result = await this.finalize(credentials, active.displayName);
      if (!this.isCurrent(active)) return;
      this.clearActive(active, false);
      this.publish({
        type: "qr-login",
        status: result.ok ? "confirmed" : "error",
        detail: result.detail,
        appId: result.appId ?? appId,
      });
    } catch (error) {
      if (!this.isCurrent(active)) return;
      this.clearActive(active, false);
      this.publish({
        type: "qr-login",
        status: "error",
        detail: `扫码已确认，但连接失败：${this.failureDetail(error).replace(/^扫码失败：/, "")}`,
        appId,
      });
    }
  }

  private handleFailure(active: ActiveQrLogin, error: unknown): void {
    if (!this.isCurrent(active) || active.phase === "finalizing") return;
    this.clearActive(active, false);
    this.publish({
      type: "qr-login",
      status: "error",
      detail: this.failureDetail(error),
    });
  }

  private expire(active: ActiveQrLogin): void {
    if (!this.isCurrent(active) || active.phase !== "scanning") return;
    this.clearActive(active, true);
    this.publish({
      type: "qr-login",
      status: "expired",
      detail: "扫码已超时，请重新生成二维码",
    });
  }

  private clearActive(active: ActiveQrLogin, abort: boolean): void {
    if (!this.isCurrent(active)) return;
    this.active = null;
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
    if (abort) active.controller.abort();
    active.stop?.();
    active.stop = null;
  }

  private failureDetail(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const lowered = detail.toLowerCase();
    if (lowered.includes("fetch") || lowered.includes("network") || lowered.includes("timeout")) {
      return "二维码获取失败，请检查网络后重试";
    }
    if (lowered.includes("cancel") || detail.includes("取消")) return "已取消扫码";
    return detail ? `扫码失败：${detail}` : "扫码失败，请重试";
  }

  private isCurrent(active: ActiveQrLogin): boolean {
    return this.active?.id === active.id;
  }

  private publish(event: QQQrLoginEvent): void {
    this.snapshot = { ...event };
    for (const listener of this.listeners) listener({ ...event });
  }
}

export type { QrConnectCredentials };
