import QRCode from "qrcode";

export type FeishuQrLoginStatus =
  | "requesting"
  | "waiting"
  | "scanned"
  | "connecting"
  | "confirmed"
  | "expired"
  | "cancelled"
  | "error";

export interface FeishuQrLoginEvent {
  type: "qr-login";
  status: FeishuQrLoginStatus;
  detail: string;
  qrDataUrl?: string;
  appId?: string;
}

export interface FeishuQrCredentials {
  appId: string;
  appSecret: string;
}

export type FeishuQrLoginFinalize = (
  credentials: FeishuQrCredentials,
  displayName: string,
) => Promise<{ ok: boolean; detail: string; appId?: string }>;

interface ActiveQrLogin {
  id: number;
  displayName: string;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | null;
  phase: "scanning" | "finalizing";
}

const QR_SESSION_TIMEOUT_MS = 5 * 60_000;

export class FeishuQrLoginManager {
  private active: ActiveQrLogin | null = null;
  private sequence = 0;
  private snapshot: FeishuQrLoginEvent | null = null;
  private readonly listeners = new Set<(event: FeishuQrLoginEvent) => void>();

  constructor(private readonly finalize: FeishuQrLoginFinalize) {}

  getStatus(): FeishuQrLoginEvent | null {
    return this.active && this.snapshot ? { ...this.snapshot } : null;
  }

  subscribe(listener: (event: FeishuQrLoginEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(displayName = ""): Promise<{ ok: boolean; detail: string }> {
    if (this.active) return { ok: false, detail: "飞书扫码正在进行，请稍候" };

    const active: ActiveQrLogin = {
      id: ++this.sequence,
      displayName: displayName.trim(),
      controller: new AbortController(),
      timeout: null,
      phase: "scanning",
    };
    this.active = active;
    active.timeout = setTimeout(() => this.expire(active), QR_SESSION_TIMEOUT_MS);
    this.publish({ type: "qr-login", status: "requesting", detail: "正在生成飞书二维码…" });

    try {
      const { registerApp } = await import("@larksuiteoapi/node-sdk");
      if (!this.isCurrent(active)) return { ok: false, detail: "飞书扫码已取消" };

      const result = await registerApp({
        signal: active.controller.signal,
        source: "penguin-desktop-pet",
        createOnly: true,
        appPreset: {
          name: active.displayName || "小企鹅飞书助手",
          desc: "连接小企鹅桌宠 Agent 的飞书机器人",
        },
        addons: {
          preset: false,
          scopes: {
            tenant: [
              "im:message.p2p_msg:readonly",
              "im:message.group_at_msg:readonly",
              "im:message:send_as_bot",
            ],
          },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        onQRCodeReady: (info) => {
          void this.handleQrReady(active, info.url, info.expireIn);
        },
        onStatusChange: (info) => {
          if (!this.isCurrent(active) || active.phase !== "scanning") return;
          if (info.status === "polling" || info.status === "slow_down") {
            this.publish({ ...this.snapshotBase(), status: "waiting", detail: "请使用飞书扫码并确认创建机器人" });
          }
        },
      });

      if (!this.isCurrent(active)) return { ok: false, detail: "飞书扫码已取消" };
      await this.handleSuccess(active, { appId: result.client_id, appSecret: result.client_secret });
      return { ok: true, detail: this.snapshot?.detail ?? "飞书 Bot 已连接" };
    } catch (error) {
      if (!this.isCurrent(active)) return { ok: false, detail: "飞书扫码已取消" };
      this.handleFailure(active, error);
      return { ok: false, detail: this.snapshot?.detail ?? "飞书二维码生成失败" };
    }
  }

  cancel(): { ok: boolean; detail: string } {
    const active = this.active;
    if (!active) return { ok: false, detail: "当前没有进行中的飞书扫码" };
    if (active.phase === "finalizing") {
      return { ok: false, detail: "扫码已确认，正在完成连接，请稍候" };
    }
    this.clearActive(active, true);
    this.publish({ type: "qr-login", status: "cancelled", detail: "已取消飞书扫码" });
    return { ok: true, detail: "已取消飞书扫码" };
  }

  private async handleQrReady(active: ActiveQrLogin, url: string, expireIn: number): Promise<void> {
    try {
      const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 248 });
      if (!this.isCurrent(active) || active.phase !== "scanning") return;
      if (active.timeout) clearTimeout(active.timeout);
      active.timeout = setTimeout(() => this.expire(active), Math.max(10_000, expireIn * 1000));
      this.publish({
        type: "qr-login",
        status: "waiting",
        detail: "请使用飞书扫码并确认创建机器人",
        qrDataUrl,
      });
    } catch (error) {
      this.handleFailure(active, error);
    }
  }

  private async handleSuccess(active: ActiveQrLogin, credentials: FeishuQrCredentials): Promise<void> {
    if (!this.isCurrent(active)) return;
    active.phase = "finalizing";
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
    this.publish({
      type: "qr-login",
      status: "connecting",
      detail: "应用已创建，正在连接飞书…",
      appId: credentials.appId,
    });

    try {
      const result = await this.finalize(credentials, active.displayName);
      if (!this.isCurrent(active)) return;
      this.clearActive(active, false);
      this.publish({
        type: "qr-login",
        status: result.ok ? "confirmed" : "error",
        detail: result.detail,
        appId: result.appId ?? credentials.appId,
      });
    } catch (error) {
      if (!this.isCurrent(active)) return;
      this.clearActive(active, false);
      this.publish({
        type: "qr-login",
        status: "error",
        detail: `应用已创建，但连接失败：${this.failureDetail(error)}`,
        appId: credentials.appId,
      });
    }
  }

  private handleFailure(active: ActiveQrLogin, error: unknown): void {
    if (!this.isCurrent(active) || active.phase === "finalizing") return;
    const detail = this.failureDetail(error);
    const status = this.failureCode(error) === "expired_token" ? "expired" : this.failureCode(error) === "abort" ? "cancelled" : "error";
    this.clearActive(active, false);
    this.publish({ type: "qr-login", status, detail });
  }

  private expire(active: ActiveQrLogin): void {
    if (!this.isCurrent(active) || active.phase !== "scanning") return;
    this.clearActive(active, true);
    this.publish({ type: "qr-login", status: "expired", detail: "二维码已过期，请重新生成" });
  }

  private clearActive(active: ActiveQrLogin, abort: boolean): void {
    if (!this.isCurrent(active)) return;
    this.active = null;
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
    if (abort) active.controller.abort();
  }

  private failureCode(error: unknown): string {
    return error && typeof error === "object" && "code" in error ? String(error.code) : "";
  }

  private failureDetail(error: unknown): string {
    const code = this.failureCode(error);
    const description = error && typeof error === "object" && "description" in error
      ? String(error.description)
      : error instanceof Error ? error.message : String(error);
    if (code === "access_denied") return "已拒绝飞书授权";
    if (code === "expired_token") return "二维码已过期，请重新生成";
    if (code === "abort") return "已取消飞书扫码";
    const lowered = description.toLowerCase();
    if (lowered.includes("fetch") || lowered.includes("network") || lowered.includes("timeout")) {
      return "二维码获取失败，请检查网络后重试";
    }
    return description ? `飞书扫码失败：${description}` : "飞书扫码失败，请重试";
  }

  private snapshotBase(): Pick<FeishuQrLoginEvent, "type" | "qrDataUrl" | "appId"> {
    return {
      type: "qr-login",
      qrDataUrl: this.snapshot?.qrDataUrl,
      appId: this.snapshot?.appId,
    };
  }

  private isCurrent(active: ActiveQrLogin): boolean {
    return this.active?.id === active.id;
  }

  private publish(event: FeishuQrLoginEvent): void {
    this.snapshot = { ...event };
    for (const listener of this.listeners) listener({ ...event });
  }
}
